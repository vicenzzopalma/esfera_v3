// ============================================================
// Esfera v3 — Cliente ADB Nativo em Rust (adb_tcp.rs)
// Protocolo ADB wire (CNXN/AUTH/OPEN) diretamente no socket TCP
// do daemon do aparelho (IP:5555), sem depender de adb.exe.
// Autenticação RSA (PKCS#1 v1.5) com a chave ~/.android/adbkey.
// Shell v2 com framing binário (stdin/stdout/stderr/exit).
// Pool por serial com idle timeout. Fallback para CLI no caller.
// Seriais de túnel inverso roteiam por ponte local do tunnel_server.
// ============================================================

use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Pkcs1v15Sign, RsaPrivateKey};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
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
const ID_CLOSE_STDIN: u8 = 4;
const ID_STDOUT: u8 = 1;
const ID_STDERR: u8 = 2;
const ID_EXIT: u8 = 3;

#[derive(Debug, Default)]
struct AdbMessage {
    cmd: u32,
    arg0: u32,
    arg1: u32,
    payload: Vec<u8>,
}

// ------------------------- CRC32 (tabela, ADB ignora mas mantém integridade) -------------------------

fn adb_checksum(data: &[u8]) -> u32 {
    data.iter().fold(0u32, |sum, byte| sum.wrapping_add(*byte as u32))
}

// ------------------------- Mensagens -------------------------

fn write_msg(stream: &mut TcpStream, cmd: u32, arg0: u32, arg1: u32, payload: &[u8]) -> io::Result<()> {
    let mut hdr = [0u8; 24];
    hdr[0..4].copy_from_slice(&cmd.to_le_bytes());
    hdr[4..8].copy_from_slice(&arg0.to_le_bytes());
    hdr[8..12].copy_from_slice(&arg1.to_le_bytes());
    hdr[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    hdr[16..20].copy_from_slice(&adb_checksum(payload).to_le_bytes());
    hdr[20..24].copy_from_slice(&(cmd ^ 0xFFFF_FFFF).to_le_bytes());
    stream.write_all(&hdr)?;
    if !payload.is_empty() {
        stream.write_all(payload)?;
    }
    Ok(())
}

fn read_exact_until(stream: &mut TcpStream, mut buffer: &mut [u8], deadline: Instant) -> io::Result<()> {
    while !buffer.is_empty() {
        apply_deadline(stream, deadline)?;
        match stream.read(buffer) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "A conexão com o aparelho foi encerrada")),
            Ok(n) => buffer = &mut buffer[n..],
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn read_msg_until(stream: &mut TcpStream, deadline: Instant) -> io::Result<AdbMessage> {
    let mut hdr = [0u8; 24];
    read_exact_until(stream, &mut hdr, deadline)?;
    let field = |at| u32::from_le_bytes(hdr[at..at+4].try_into().unwrap());
    let cmd = field(0);
    let len = field(12) as usize;
    if field(20) != cmd ^ u32::MAX || len > MAX_PAYLOAD {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Resposta inválida do aparelho"));
    }
    let mut payload = vec![0u8; len];
    read_exact_until(stream, &mut payload, deadline)?;
    if field(16) != 0 && adb_checksum(&payload) != field(16) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Resposta incompleta do aparelho"));
    }
    Ok(AdbMessage { cmd, arg0: field(4), arg1: field(8), payload })
}

#[cfg(test)]
fn read_msg(stream: &mut TcpStream) -> io::Result<AdbMessage> {
    read_msg_until(stream, Instant::now() + Duration::from_secs(2))
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

// ------------------------- Handshake -------------------------

fn handshake(stream: &mut TcpStream, key: Option<&RsaPrivateKey>, deadline: Instant) -> io::Result<()> {
    let ident = b"host::features=shell_v2\0";
    write_msg(stream, A_CNXN, A_VERSION, MAX_PAYLOAD as u32, ident)?;

    let mut signed = false;
    loop {
        apply_deadline(stream, deadline)?;
        let msg = read_msg_until(stream, deadline)?;
        match msg.cmd {
            A_CNXN => return Ok(()),
            A_AUTH if msg.arg0 == A_AUTH_TOKEN => {
                if signed { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Autorize este computador pela conexão USB antes de usar Wi-Fi")); }
                signed = true;
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
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Autorize este computador pela conexão USB antes de usar Wi-Fi"));
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

fn apply_deadline(stream: &TcpStream, deadline: Instant) -> io::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err(io::Error::new(io::ErrorKind::TimedOut, "tempo esgotado no ADB")); }
    stream.set_read_timeout(Some(remaining))?;
    stream.set_write_timeout(Some(remaining))
}

fn open_shell(mut stream: TcpStream, command: &str, deadline: Instant) -> io::Result<AdbConn> {
    let local_id = rand::random::<u32>().max(1);
    if command.as_bytes().contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Comando inválido")); }
    apply_deadline(&stream, deadline)?;
    let service = format!("shell,v2,raw:{}\0", command);
    write_msg(&mut stream, A_OPEN, local_id, 0, service.as_bytes())?;
    let msg = read_msg_until(&mut stream, deadline)?;
    if msg.cmd != A_OKAY || msg.arg1 != local_id || msg.arg0 == 0 {
        return Err(io::Error::new(io::ErrorKind::ConnectionRefused, "O aparelho não aceitou a operação"));
    }
    Ok(AdbConn { stream, local_id, remote_id: msg.arg0 })
}

/// Frame binário do shell v2: [id:1][len:4 LE][dados].
fn frame(id: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + data.len());
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

impl AdbConn {
    // Operações pontuais: comandos que precisam receber stdin não são suportados.
    fn exec(&mut self, deadline: Instant) -> io::Result<(Vec<u8>, Vec<u8>, bool)> {
        apply_deadline(&self.stream, deadline)?;
        // Um único WRTE pendente: nenhuma nova escrita de dados antes do ACK.
        write_msg(&mut self.stream, A_WRTE, self.local_id, self.remote_id, &frame(ID_CLOSE_STDIN, &[]))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut pending = Vec::new();
        loop {
            let msg = read_msg_until(&mut self.stream, deadline)?;
            if msg.arg1 != self.local_id || msg.arg0 != self.remote_id {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "A resposta veio de outra conexão do aparelho"));
            }
            match msg.cmd {
                A_OKAY => {},
                A_CLSE => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "O aparelho encerrou a operação sem confirmar o resultado")),
                A_WRTE => {
                    apply_deadline(&self.stream, deadline)?;
                    write_msg(&mut self.stream, A_OKAY, self.local_id, self.remote_id, &[])?;
                    pending.extend(msg.payload);
                    while pending.len() >= 5 {
                        let id = pending[0];
                        let len = u32::from_le_bytes(pending[1..5].try_into().unwrap()) as usize;
                        if len > 32 * 1024 * 1024 || stdout.len() + stderr.len() + pending.len() > 32 * 1024 * 1024 {
                            return Err(io::Error::new(io::ErrorKind::InvalidData, "A resposta do aparelho excedeu o limite de leitura"));
                        }
                        if pending.len() < 5 + len { break; }
                        let data = &pending[5..5+len];
                        match id {
                            ID_STDOUT => stdout.extend_from_slice(data),
                            ID_STDERR => stderr.extend_from_slice(data),
                            ID_EXIT => {
                                if data.len() != 1 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Resultado inválido do aparelho")); }
                                let code = data[0];
                                apply_deadline(&self.stream, deadline)?;
                                let _ = write_msg(&mut self.stream, A_CLSE, self.local_id, self.remote_id, &[]);
                                if code != 0 {
                                    return Err(io::Error::other(format!("O aparelho não concluiu a operação (código {})", code)));
                                }
                                return Ok((stdout, stderr, true));
                            },
                            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "Resposta desconhecida do aparelho")),
                        }
                        pending.drain(..5+len);
                    }
                },
                _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "Resposta inesperada do aparelho")),
            }
        }
    }
}

// ------------------------- Transporte por serial -------------------------

fn is_tcp_serial(serial: &str) -> bool {
    serial.contains(':') && serial.contains('.')
}

/// Captura o handle do runtime Tokio no setup (necessário para abrir a ponte de
/// túnel inverso a partir de threads de spawn_blocking).
#[allow(dead_code)]
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

/// Abre o transporte do protocolo ADB para o serial:
/// Wi-Fi → TCP direto no IP:porta; túnel → ponte local criada pelo tunnel_server.
fn connect_transport(serial: &str, budget: Duration) -> Result<TcpStream, String> {
    if is_tcp_serial(serial) {
        let addr = serial
            .parse::<std::net::SocketAddr>()
            .map_err(|e| format!("serial inválida para ADB nativo: {}", e))?;
        return TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT.min(budget))
            .map_err(|e| format!("falha TCP em {}: {}", serial, e));
    }
    if is_tunnel_serial(serial) {
        let handle = RUNTIME_HANDLE
            .lock()
            .map_err(|_| "Não foi possível abrir a conexão com o aparelho".to_string())?
            .clone()
            .ok_or_else(|| "runtime tokio não inicializado (adb_tcp::init)".to_string())?;
        return handle
            .block_on(async { tokio::time::timeout(budget, crate::tunnel_server::open_proxy(serial, 5555)).await })
            .map_err(|_| format!("Tempo esgotado ao abrir túnel para {}", serial))?
            .map_err(|e| format!("falha ao abrir proxy de túnel para {}: {}", serial, e));
    }
    Err("serial USB não suporta protocolo nativo (use Wi-Fi ou túnel inverso)".to_string())
}

/// Executa um comando shell via protocolo ADB nativo.
/// Retorna Err quando o aparelho não suporta (USB, sem rede) ou o comando falhou.
pub fn exec_shell(serial: &str, cmd: &str) -> Result<String, String> {
    exec_shell_with_timeout(serial, cmd, Duration::from_secs(12))
}

pub fn exec_shell_with_timeout(serial: &str, cmd: &str, timeout: Duration) -> Result<String, String> {
    let (stdout, stderr, exited) = exec_shell_bytes_with_timeout(serial, cmd, timeout)?;
    if !exited { return Err(format!("Comando ADB não terminou: {}", String::from_utf8_lossy(&stderr))); }
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

pub fn exec_shell_bytes(serial: &str, cmd: &str) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    exec_shell_bytes_with_timeout(serial, cmd, Duration::from_secs(12))
}

fn exec_shell_bytes_with_timeout(serial: &str, cmd: &str, timeout: Duration) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    let deadline = Instant::now() + timeout;
    if !is_tcp_serial(serial) && !is_tunnel_serial(serial) {
        return Err("serial não suporta protocolo nativo".to_string());
    }

    // shell,v2 encerra depois de cada comando. Não reutilize uma sessão fechada nem
    // reexecute comandos de entrada após uma falha com resultado incerto.

    // Conexão nova (Wi-Fi direto ou ponte do túnel inverso)
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err("Tempo esgotado antes da conexão ADB".into()); }
    let stream = connect_transport(serial, remaining)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err("Tempo esgotado ao conectar ADB".into()); }
    stream.set_read_timeout(Some(remaining)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(remaining)).map_err(|e| e.to_string())?;
    let key = load_adb_key();
    let mut handshake_stream = stream.try_clone().map_err(|e| e.to_string())?;
    handshake(&mut handshake_stream, key.as_ref(), deadline)
        .map_err(|e| format!("handshake ADB falhou: {}", e))?;
    apply_deadline(&stream, deadline).map_err(|e| e.to_string())?;
    let mut conn = open_shell(stream, cmd, deadline).map_err(|e| format!("open shell falhou: {}", e))?;

    let result = run_with_conn(&mut conn, deadline);
    result
}

fn run_with_conn(conn: &mut AdbConn, deadline: Instant) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    conn.exec(deadline)
        .map_err(|e| format!("exec nativo falhou: {}", e))
}

#[cfg(test)]
mod wifi_timeout_tests {
    use super::*;
    #[test]
    fn aparelho_que_nao_responde_encerra_no_prazo() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || { let (_socket,_) = listener.accept().unwrap(); std::thread::sleep(Duration::from_millis(900)); });
        let start = Instant::now();
        let result = exec_shell_with_timeout(&address.to_string(), "true", Duration::from_millis(250));
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }
}

#[cfg(test)]
mod native_protocol_tests {
    use super::*;

    #[test]
    fn aceita_data_check_zero_do_daemon_moderno() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            // Cabeçalho independente do escritor sob teste: CNXN, payload abc, checksum zero.
            let mut bytes = Vec::new();
            for field in [0x4e584e43u32, 0x01000001, 4096, 3, 0, 0xb1a7b1bc] { bytes.extend(field.to_le_bytes()); }
            bytes.extend(b"abc");
            socket.write_all(&bytes).unwrap();
        });
        let mut stream = TcpStream::connect(address).unwrap();
        let reply = read_msg_until(&mut stream, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(reply.payload, b"abc");
        server.join().unwrap();
        assert_eq!(adb_checksum(b"abc"), 294);
    }

    fn simulated_command(exit: u8) -> Result<String, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            socket.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
            let hello = read_msg(&mut socket).unwrap();
            assert_eq!(hello.cmd, A_CNXN);
            write_msg(&mut socket, A_CNXN, A_VERSION, 4096, b"device::features=shell_v2\0").unwrap();
            let open = read_msg(&mut socket).unwrap();
            if open.payload != b"shell,v2,raw:printf teste\0" {
                let _ = write_msg(&mut socket, A_CLSE, 0, open.arg0, &[]);
                return;
            }
            let remote = if open.arg0 == 7 { 8 } else { 7 };
            write_msg(&mut socket, A_OKAY, remote, open.arg0, &[]).unwrap();
            let close_stdin = read_msg(&mut socket).unwrap();
            assert_eq!((close_stdin.arg0, close_stdin.arg1), (open.arg0, remote));
            assert_eq!(close_stdin.payload, frame(4, &[]));
            write_msg(&mut socket, A_OKAY, remote, open.arg0, &[]).unwrap();
            let mut output = frame(ID_STDOUT, b"teste");
            output.extend(frame(ID_STDERR, b"aviso"));
            output.extend(frame(ID_EXIT, &[exit]));
            // Um cabeçalho dividido entre WRTE; o último WRTE contém vários frames.
            for data in [&output[..2], &output[2..7], &output[7..]] {
                write_msg(&mut socket, A_WRTE, remote, open.arg0, data).unwrap();
                let ack = read_msg(&mut socket).unwrap();
                assert_eq!((ack.cmd, ack.arg0, ack.arg1), (A_OKAY, open.arg0, remote));
            }
            let _ = read_msg(&mut socket);
        });
        let result = exec_shell_with_timeout(&address.to_string(), "printf teste", Duration::from_secs(3));
        server.join().unwrap();
        result
    }

    #[test]
    fn ids_distintos_e_frames_fragmentados_e_agrupados() {
        assert_eq!(simulated_command(0).unwrap(), "teste");
    }

    #[test]
    fn codigo_de_saida_nao_zero_e_falha() {
        assert!(simulated_command(7).unwrap_err().contains('7'));
    }
}
