// ============================================================
// Esfera v3 — Cliente ADB Nativo em Rust (adb_tcp.rs)
// Protocolo ADB wire (CNXN/AUTH/OPEN) diretamente no socket TCP
// do daemon do aparelho (IP:5555), sem depender de adb.exe.
// Autenticação RSA (PKCS#1 v1.5) com a chave ~/.android/adbkey.
// Shell v2 com framing binário (stdin/stdout/stderr/exit).
// Pool por serial com idle timeout. Fallback para CLI no caller.
// Seriais de túnel inverso roteiam por ponte local do tunnel_server.
// ============================================================

use base64::Engine;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Pkcs1v15Sign, RsaPrivateKey};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

// Comandos do protocolo ADB (little-endian)
const A_VERSION: u32 = 0x0100_0000;
const A_CNXN: u32 = 0x4e58_4e43;
const A_AUTH: u32 = 0x4854_5541;
const A_OPEN: u32 = 0x4e45_504f;
const A_OKAY: u32 = 0x5941_4b4f;
const A_CLSE: u32 = 0x4553_4c43;
const A_WRTE: u32 = 0x4554_5257;
const A_AUTH_TOKEN: u32 = 1;
const A_AUTH_SIGNATURE: u32 = 2;
const A_AUTH_RSAPUBLICKEY: u32 = 3;

const MAX_PAYLOAD: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const ID_STDIN: u8 = 0;
const ID_STDOUT: u8 = 1;
const ID_STDERR: u8 = 2;
const ID_EXIT: u8 = 3;
const POOL_IDLE_SECS: u64 = 60;
const POOL_MAX_ENTRIES: usize = 32;

#[derive(Debug, Default)]
struct AdbMessage {
    cmd: u32,
    arg0: u32,
    arg1: u32,
    payload: Vec<u8>,
}

// ------------------------- CRC32 (tabela, ADB ignora mas mantém integridade) -------------------------

static CRC_TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
    let mut table = [0u32; 256];
    let mut i = 0u32;
    while i < 256 {
        let mut c = i;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i as usize] = c;
        i += 1;
    }
    table
});

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = CRC_TABLE[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

// ------------------------- Mensagens -------------------------

fn write_msg(stream: &mut TcpStream, cmd: u32, arg0: u32, arg1: u32, payload: &[u8]) -> io::Result<()> {
    let mut hdr = [0u8; 24];
    hdr[0..4].copy_from_slice(&cmd.to_le_bytes());
    hdr[4..8].copy_from_slice(&arg0.to_le_bytes());
    hdr[8..12].copy_from_slice(&arg1.to_le_bytes());
    hdr[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    hdr[16..20].copy_from_slice(&crc32(payload).to_le_bytes());
    hdr[20..24].copy_from_slice(&(cmd ^ 0xFFFF_FFFF).to_le_bytes());
    stream.write_all(&hdr)?;
    if !payload.is_empty() {
        stream.write_all(payload)?;
    }
    Ok(())
}

fn read_msg(stream: &mut TcpStream) -> io::Result<AdbMessage> {
    let mut hdr = [0u8; 24];
    stream.read_exact(&mut hdr)?;
    let cmd = u32::from_le_bytes(hdr[0..4].try_into().unwrap());
    let arg0 = u32::from_le_bytes(hdr[4..8].try_into().unwrap());
    let arg1 = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
    let len = u32::from_le_bytes(hdr[12..16].try_into().unwrap()) as usize;
    if len > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload ADB gigante: {}", len),
        ));
    }
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload)?;
    Ok(AdbMessage { cmd, arg0, arg1, payload })
}

// ------------------------- Chave RSA -------------------------

fn adb_key_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))?;
    let mut p = PathBuf::from(home);
    p.push(".android");
    p.push("adbkey");
    if p.exists() { Some(p) } else { None }
}

fn load_adb_key() -> Option<RsaPrivateKey> {
    let path = adb_key_path()?;
    let pem = std::fs::read_to_string(path).ok()?;
    RsaPrivateKey::from_pkcs8_pem(&pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&pem))
        .ok()
}

fn mpint(v: &BigUint) -> Vec<u8> {
    let mut bytes = v.to_bytes_be();
    if bytes.first() == Some(&0) {
        bytes.remove(0);
    }
    let mut out = Vec::new();
    let mut prefix = Vec::new();
    if bytes.first().map(|b| b & 0x80 != 0).unwrap_or(false) {
        prefix.push(0u8);
    }
    let len = (prefix.len() + bytes.len()) as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&prefix);
    out.extend_from_slice(&bytes);
    out
}

/// Chave pública no formato ssh-rsa (usada no AUTH RSAPUBLICKEY).
fn ssh_rsa_pubkey(key: &RsaPrivateKey) -> String {
    let mut blob = Vec::new();
    blob.extend_from_slice(b"ssh-rsa\0");
    blob.extend_from_slice(&mpint(key.e()));
    blob.extend_from_slice(&mpint(key.n()));
    let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
    format!("ssh-rsa {} esfera_v3", b64)
}

// ------------------------- Handshake -------------------------

fn handshake(stream: &mut TcpStream, key: Option<&RsaPrivateKey>) -> io::Result<()> {
    let ident = b"device::esfera_v3\0";
    write_msg(stream, A_CNXN, A_VERSION, MAX_PAYLOAD as u32, ident)?;

    loop {
        let msg = read_msg(stream)?;
        match msg.cmd {
            A_CNXN => return Ok(()),
            A_AUTH if msg.arg0 == A_AUTH_TOKEN => {
                let Some(k) = key else {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "aparelho exige autenticação e não há chave em ~/.android/adbkey",
                    ));
                };
                // Assinatura ADB = RSA private_encrypt PKCS#1 v1.5 cru (sem DigestInfo)
                let sig = k
                    .sign(Pkcs1v15Sign::new_unprefixed(), &msg.payload)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
                write_msg(stream, A_AUTH, A_AUTH_SIGNATURE, 0, &sig)?;
            }
            A_AUTH if msg.arg0 == A_AUTH_RSAPUBLICKEY => {
                if let Some(k) = key {
                    let pubkey = ssh_rsa_pubkey(k);
                    write_msg(stream, A_AUTH, A_AUTH_RSAPUBLICKEY, 0, pubkey.as_bytes())?;
                } else {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "aparelho pediu registro de chave pública sem chave local",
                    ));
                }
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("handshake inesperado: cmd=0x{:08x}", other),
                ));
            }
        }
    }
}

// ------------------------- Sessão shell,v2 -------------------------

struct AdbConn {
    stream: TcpStream,
    local_id: u32,
    remote_id: u32,
}

fn open_shell(mut stream: TcpStream) -> io::Result<AdbConn> {
    let local_id = rand::random::<u32>().max(1);
    write_msg(&mut stream, A_OPEN, local_id, 0, b"shell,v2\0")?;
    let mut remote_id = 0u32;
    loop {
        let msg = read_msg(&mut stream)?;
        match msg.cmd {
            A_OKAY => {
                remote_id = msg.arg1;
                break;
            }
            A_CLSE => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    "shell,v2 recusado pelo aparelho",
                ));
            }
            _ => {}
        }
    }
    Ok(AdbConn { stream, local_id, remote_id })
}

/// Frame binário do shell v2: [id:1][len:4 LE][dados]
fn frame(id: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + data.len());
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

impl AdbConn {
    fn write_frame(&mut self, id: u8, data: &[u8]) -> io::Result<()> {
        write_msg(&mut self.stream, A_WRTE, self.local_id, self.remote_id, &frame(id, data))
    }

    fn exec(&mut self, cmd: &str) -> io::Result<(Vec<u8>, Vec<u8>, bool)> {
        self.write_frame(ID_STDIN, format!("{}\n", cmd).as_bytes())?;
        // Fecha o stdin para sinalizar fim do comando
        self.write_frame(ID_STDIN, &[])?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exited = false;

        loop {
            let msg = read_msg(&mut self.stream)?;
            match msg.cmd {
                A_WRTE => {
                    let _ = write_msg(&mut self.stream, A_OKAY, self.local_id, self.remote_id, &[]);
                    if msg.payload.is_empty() {
                        continue;
                    }
                    let id = msg.payload[0];
                    let len = if msg.payload.len() >= 5 {
                        u32::from_le_bytes(msg.payload[1..5].try_into().unwrap()) as usize
                    } else {
                        0
                    };
                    let data = if msg.payload.len() >= 5 + len {
                        &msg.payload[5..5 + len]
                    } else {
                        &msg.payload[1..]
                    };
                    match id {
                        ID_STDOUT => stdout.extend_from_slice(data),
                        ID_STDERR => stderr.extend_from_slice(data),
                        ID_EXIT => {
                            exited = true;
                        }
                        _ => {}
                    }
                }
                A_OKAY => {}
                A_CLSE => break,
                A_CNXN => {}
                _ => break,
            }
        }

        Ok((stdout, stderr, exited))
    }
}

// ------------------------- Pool por serial -------------------------

struct Pooled {
    conn: AdbConn,
    last_used: Instant,
}

static POOL: LazyLock<Mutex<HashMap<String, Arc<Mutex<Pooled>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_tcp_serial(serial: &str) -> bool {
    serial.contains(':') && serial.contains('.')
}

/// Captura o handle do runtime Tokio no setup (necessário para abrir a ponte de
/// túnel inverso a partir de threads de spawn_blocking).
pub fn init() {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        if let Ok(mut slot) = RUNTIME_HANDLE.lock() {
            *slot = Some(handle);
        }
    }
}

static RUNTIME_HANDLE: LazyLock<Mutex<Option<tokio::runtime::Handle>>> =
    LazyLock::new(|| Mutex::new(None));

/// Seriais registradas pelo tunnel_server (devices atrás de NAT roteiam por proxy).
static TUNNEL_SERIALS: LazyLock<Mutex<HashMap<String, ()>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn register_tunnel_serial(serial: &str) {
    if let Ok(mut m) = TUNNEL_SERIALS.lock() {
        m.insert(serial.to_string(), ());
    }
}

pub fn unregister_tunnel_serial(serial: &str) {
    if let Ok(mut m) = TUNNEL_SERIALS.lock() {
        m.remove(serial);
    }
}

/// Limpa todo o estado de seriais virtuais do túnel (usado no shutdown do
/// servidor de túnel / encerramento do app, evitando "túneis fantasmas").
pub fn unregister_all_tunnel_serials() {
    if let Ok(mut m) = TUNNEL_SERIALS.lock() {
        m.clear();
    }
}

pub fn is_tunnel_serial(serial: &str) -> bool {
    TUNNEL_SERIALS
        .lock()
        .map(|m| m.contains_key(serial))
        .unwrap_or(false)
}

/// Descarta a conexão nativa de um serial específico (ex.: ao desconectar o aparelho).
pub fn evict(serial: &str) {
    POOL.lock().unwrap().remove(serial);
}

/// Abre o transporte do protocolo ADB para o serial:
/// Wi-Fi → TCP direto no IP:porta; túnel → ponte local criada pelo tunnel_server.
fn connect_transport(serial: &str) -> Result<TcpStream, String> {
    if is_tcp_serial(serial) {
        let addr = serial
            .parse::<std::net::SocketAddr>()
            .map_err(|e| format!("serial inválida para ADB nativo: {}", e))?;
        return TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|e| format!("falha TCP em {}: {}", serial, e));
    }
    if is_tunnel_serial(serial) {
        let handle = RUNTIME_HANDLE
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "runtime tokio não inicializado (adb_tcp::init)".to_string())?;
        return handle
            .block_on(crate::tunnel_server::open_proxy(serial, 5555))
            .map_err(|e| format!("falha ao abrir proxy de túnel para {}: {}", serial, e));
    }
    Err("serial USB não suporta protocolo nativo (use Wi-Fi ou túnel inverso)".to_string())
}

/// Executa um comando shell via protocolo ADB nativo.
/// Retorna Err quando o aparelho não suporta (USB, sem rede) ou o comando falhou.
pub fn exec_shell(serial: &str, cmd: &str) -> Result<String, String> {
    let (stdout, _stderr, _exited) = exec_shell_bytes(serial, cmd)?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

pub fn exec_shell_bytes(serial: &str, cmd: &str) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    if !is_tcp_serial(serial) {
        return Err("serial USB não suporta protocolo nativo (use Wi-Fi)".to_string());
    }

    sweep();

    let now = Instant::now();
    {
        let mut pool = POOL.lock().unwrap();
        if let Some(existing) = pool.get(serial).cloned() {
            drop(pool);
            let mut guard = existing.lock().unwrap();
            let result = run_with_conn(&mut guard.conn, cmd);
            if result.is_ok() {
                guard.last_used = now;
                return result;
            }
            // Conexão morta: remove e reconecta do zero
            let _ = POOL.lock().unwrap().remove(serial);
            drop(guard);
            drop(existing);
        } else {
            drop(pool);
        }
    }

    // Conexão nova (Wi-Fi direto ou ponte do túnel inverso)
    let stream = connect_transport(serial)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| e.to_string())?;
    let key = load_adb_key();
    handshake(&mut stream.try_clone().unwrap(), key.as_ref())
        .map_err(|e| format!("handshake ADB falhou: {}", e))?;
    let mut conn = open_shell(stream).map_err(|e| format!("open shell falhou: {}", e))?;

    let result = run_with_conn(&mut conn, cmd);
    if result.is_ok() {
        let mut pool = POOL.lock().unwrap();
        if pool.len() >= POOL_MAX_ENTRIES {
            if let Some(oldest) = pool
                .iter()
                .min_by_key(|(_, v)| v.lock().unwrap().last_used)
                .map(|(k, _)| k.clone())
            {
                pool.remove(&oldest);
            }
        }
        pool.insert(
            serial.to_string(),
            Arc::new(Mutex::new(Pooled { conn, last_used: now })),
        );
    }
    result
}

fn run_with_conn(conn: &mut AdbConn, cmd: &str) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    conn.exec(cmd)
        .map_err(|e| format!("exec nativo falhou: {}", e))
}

fn sweep() {
    let mut pool = POOL.lock().unwrap();
    let cutoff = Instant::now() - Duration::from_secs(POOL_IDLE_SECS);
    let stale: Vec<String> = pool
        .iter()
        .filter(|(_, v)| v.lock().unwrap().last_used < cutoff)
        .map(|(k, _)| k.clone())
        .collect();
    for k in stale {
        pool.remove(&k);
    }
}

/// Descarta todas as conexões nativas (ex.: ao reiniciar o servidor ADB).
pub fn reset_pool() {
    POOL.lock().unwrap().clear();
}
