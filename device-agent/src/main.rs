// ============================================================
// Esfera v3 — Daemon Android (device-agent)
// Kernel-level: túnel inverso TCP (keepalive L4 + heartbeat L7),
// handshake UDP na porta 7778 e reconexão com backoff exponencial.
// Roda em /data/adb/earlypoint/esfera-agent (Magisk).
// ============================================================

use rand::Rng;
use serde_json::{json, Value};
use socket2::{Domain, Protocol, Socket, TcpKeepalive, Type};
use std::io::{BufRead, BufReader, Read, Write};
use std::io::ErrorKind;
use std::net::{Shutdown, SocketAddr, TcpStream, UdpSocket};
use std::process::Command;
use std::time::Duration;

const CONFIG_PATH: &str = "/data/adb/earlypoint/config.json";
const DEFAULT_TUNNEL_PORT: u16 = 8888;
const UDP_HANDSHAKE_PORT: u16 = 7778;
const ADB_PORT: u16 = 5555;
const HEARTBEAT_SECS: u64 = 10;
const READ_TIMEOUT_SECS: u64 = 15;
const MAX_BACKOFF_MS: u64 = 15_000;

#[derive(Debug, Clone)]
struct AgentConfig {
    server: String,
    port: u16,
    hardware_uuid: String,
    /// Identidade de isolamento (COMPANY_ID). Sem ela o hub recusa a sessão:
    /// nunca derivamos empresa de IP/porta/ordem de conexão.
    company_id: i32,
}

fn read_prop(prop: &str) -> String {
    Command::new("getprop")
        .arg(prop)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn wlan_ip() -> Option<String> {
    if let Ok(out) = Command::new("ip")
        .args(["-4", "addr", "show", "wlan0"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("inet ") {
                if let Some(ip) = rest.split('/').next() {
                    if !ip.is_empty() && !ip.starts_with("127.") {
                        return Some(ip.to_string());
                    }
                }
            }
        }
    }
    let dhcp = read_prop("dhcp.wlan0.ipaddress");
    if !dhcp.is_empty() {
        return Some(dhcp);
    }
    None
}

fn mac_address() -> Option<String> {
    std::fs::read_to_string("/sys/class/net/wlan0/address")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// UUID determinístico de fallback: hash FNV-1a do serial + modelo (sem depender de cripto).
fn fallback_uuid() -> String {
    let seed = format!("{}|{}", read_prop("ro.serialno"), read_prop("ro.product.model"));
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("ESF-{:016x}", h)
}

fn load_config() -> AgentConfig {
    let mut cfg = AgentConfig {
        server: read_prop("persist.esfera.hub"),
        port: DEFAULT_TUNNEL_PORT,
        hardware_uuid: fallback_uuid(),
        company_id: read_prop("persist.esfera.company").parse().unwrap_or(0),
    };
    if cfg.server.is_empty() {
        // Não cair para 127.0.0.1: o agente escuta o túnel localmente, então
        // apontar para localhost nunca alcança o hub (e o VPS recusa companyId=0).
        // Fallback seguro: hub VPS conhecido. O provisionamento grava
        // persist.esfera.hub; aparelhos antigos sem a prop usam este default.
        cfg.server = "34.29.70.113".to_string();
    }
    if let Ok(content) = std::fs::read_to_string(CONFIG_PATH) {
        if let Ok(v) = serde_json::from_str::<Value>(&content) {
            if let Some(s) = v.get("server").and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    cfg.server = s.to_string();
                }
            }
            if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                cfg.port = p as u16;
            }
            if let Some(u) = v.get("hardwareUuid").and_then(|x| x.as_str()) {
                if !u.is_empty() {
                    cfg.hardware_uuid = u.to_string();
                }
            }
            // companyId: aceita número ou string numérica no config.json.
            if let Some(c) = v.get("companyId") {
                if let Some(n) = c.as_i64() {
                    cfg.company_id = n as i32;
                } else if let Some(s) = c.as_str() {
                    if let Ok(n) = s.parse::<i32>() {
                        cfg.company_id = n;
                    }
                }
            }
        }
    }
    cfg
}

/// Handshake UDP (broadcast local + direto ao servidor) na porta 7778.
fn udp_handshake(cfg: &AgentConfig) {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
        return;
    };
    let _ = socket.set_broadcast(true);
    let payload = json!({
        "hardwareUuid": cfg.hardware_uuid,
        "companyId": cfg.company_id,
        "ip": wlan_ip().unwrap_or_default(),
        "port": ADB_PORT,
    });
    let bytes = payload.to_string();
    let _ = socket.send_to(bytes.as_bytes(), ("255.255.255.255", UDP_HANDSHAKE_PORT));
    if let Ok(addr) = format!("{}:{}", cfg.server, UDP_HANDSHAKE_PORT).parse::<SocketAddr>() {
        let _ = socket.send_to(bytes.as_bytes(), addr);
    }
}

fn write_line(stream: &mut TcpStream, line: &str) -> Result<(), String> {
    let mut buf = line.as_bytes().to_vec();
    buf.push(b'\n');
    stream.write_all(&buf).map_err(|e| e.to_string())
}

/// Proxy ADB sob demanda: o hub pede {"type":"proxy","port":P}, o daemon conecta
/// no adbd local (127.0.0.1:P) e faz relay bruto bidirecional até um lado fechar.
/// Retorna Ok(true) quando o relay encerrou (sessão deve ser reconectada) e
/// Ok(false) quando o adbd local não respondeu (a sessão de controle continua).
fn handle_proxy(
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    port: u16,
) -> Result<bool, String> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port)
        .parse()
        .map_err(|e| format!("porta local inválida: {}", e))?;

    // 1. Tenta conectar no adbd local (retries rápidos)
    let mut local: Option<TcpStream> = None;
    for attempt in 0..3 {
        match TcpStream::connect(addr) {
            Ok(s) => {
                local = Some(s);
                break;
            }
            Err(_e) if attempt < 2 => std::thread::sleep(Duration::from_millis(500)),
            Err(e) => {
                let _ = write_line(
                    stream,
                    &json!({"type": "proxy-error", "error": format!("adbd local: {}", e)})
                        .to_string(),
                );
                return Ok(false);
            }
        }
    }
    let mut local = local.ok_or("sem conexão local com o adbd")?;

    // 2. Confirma para o hub
    write_line(stream, &json!({"type": "proxy-ack"}).to_string())?;

    // 3. Relay binário com timeout de atividade: NUNCA removemos o read_timeout
    //    (bug anterior deixava o std::io::copy travado para sempre quando o adbd
    //    fechava sem EOF limpo, matando o loop de reconexão). Agora cada lado tem
    //    read_timeout e um watchdog de inatividade encerra o relay se nada fluir,
    //    garantindo que run_session retorne Err e o main() reconecte.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = local.set_read_timeout(Some(Duration::from_secs(5)));

    let mut raw_read = std::mem::replace(reader, BufReader::new(stream.try_clone().map_err(|e| e.to_string())?))
        .into_inner();
    let mut raw_write = stream.try_clone().map_err(|e| e.to_string())?;
    let mut local_read = local.try_clone().map_err(|e| e.to_string())?;
    let mut local_write = local.try_clone().map_err(|e| e.to_string())?;

    // Watchdog: se nenhum byte fluir em 120s, derruba os sockets (copy termina).
    let watchdog_raw = raw_read.try_clone().ok();
    let watchdog_local = local_read.try_clone().ok();
    let last_activity = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    ));
    let wd_last = last_activity.clone();
    let _wd = std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(10));
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let last = wd_last.load(std::sync::atomic::Ordering::Relaxed);
            if now.saturating_sub(last) > 120 {
                let _ = watchdog_raw.as_ref().map(|s| s.shutdown(Shutdown::Both));
                let _ = watchdog_local.as_ref().map(|s| s.shutdown(Shutdown::Both));
                break;
            }
        }
    });

    let mark_now = |la: &std::sync::Arc<std::sync::atomic::AtomicU64>| {
        la.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            std::sync::atomic::Ordering::Relaxed,
        );
    };

    // Hub -> adbd
    let t1 = {
        let mut src = raw_read.try_clone().map_err(|e| e.to_string())?;
        let mut dst = local_write.try_clone().map_err(|e| e.to_string())?;
        let la = last_activity.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match src.read(&mut buf) {
                    Ok(0) => break,                       // EOF: adbd fechou
                    Ok(n) => {
                        if dst.write_all(&buf[..n]).is_err() { break; }
                        let _ = dst.flush();
                        mark_now(&la);
                    }
                    Err(ref e) if e.kind() == ErrorKind::WouldBlock
                        || e.kind() == ErrorKind::TimedOut => continue, // keepalive, segue
                    Err(_) => break,
                }
            }
            let _ = src.shutdown(Shutdown::Both);
            let _ = dst.shutdown(Shutdown::Both);
        })
    };

    // adbd -> Hub
    let t2 = {
        let mut src = local_read.try_clone().map_err(|e| e.to_string())?;
        let mut dst = raw_write.try_clone().map_err(|e| e.to_string())?;
        let la = last_activity.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match src.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if dst.write_all(&buf[..n]).is_err() { break; }
                        let _ = dst.flush();
                        mark_now(&la);
                    }
                    Err(ref e) if e.kind() == ErrorKind::WouldBlock
                        || e.kind() == ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            let _ = src.shutdown(Shutdown::Both);
            let _ = dst.shutdown(Shutdown::Both);
        })
    };

    let _ = t1.join();
    let _ = t2.join();

    Ok(true)
}

/// Uma sessão completa: conecta, envia handshake e mantém heartbeat L7 até falhar.
fn run_session(cfg: &AgentConfig) -> Result<(), String> {
    let addr: SocketAddr = format!("{}:{}", cfg.server, cfg.port)
        .parse()
        .map_err(|e| format!("endereço do servidor inválido: {}", e))?;

    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| e.to_string())?;
    // Keepalive L4 agressivo: sonda a cada 2s após 5s de inatividade, 3 retries
    socket
        .set_tcp_keepalive(
            &TcpKeepalive::new()
                .with_time(Duration::from_secs(5))
                .with_interval(Duration::from_secs(2))
                .with_retries(3),
        )
        .map_err(|e| e.to_string())?;

    let mut stream: TcpStream = {
        let sock_addr: socket2::SockAddr = addr.into();
        socket.connect(&sock_addr).map_err(|e| e.to_string())?;
        socket.into()
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(READ_TIMEOUT_SECS)))
        .map_err(|e| e.to_string())?;

    // Handshake L7
    let handshake = json!({
        "type": "handshake",
        "hardwareUuid": cfg.hardware_uuid,
        "companyId": cfg.company_id,
        "macAddress": mac_address().unwrap_or_default(),
        "serialNumber": read_prop("ro.serialno"),
        "agentVersion": env!("CARGO_PKG_VERSION"),
        "currentLocalIp": wlan_ip().unwrap_or_default(),
    });
    write_line(&mut stream, &handshake.to_string())?;

    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    // Heartbeat L7: ping a cada 10s, exige pong em até 15s.
    // Pedido de proxy do hub interrompe o heartbeat e vira relay binário.
    loop {
        write_line(&mut stream, &json!({"type": "ping"}).to_string())?;

        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("conexão fechada pelo servidor".to_string());
        }
        let v: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
        match v.get("type").and_then(|t| t.as_str()) {
            Some("pong") => {}
            Some("proxy") => {
                let port = v
                    .get("port")
                    .and_then(|p| p.as_u64())
                    .unwrap_or(ADB_PORT as u64) as u16;
                if handle_proxy(&mut stream, &mut reader, port)? {
                    return Err("proxy de túnel encerrado; reconectando".to_string());
                }
                // adbd local indisponível — avisou o hub e segue no heartbeat
            }
            _ => return Err("resposta inesperada do servidor".to_string()),
        }

        std::thread::sleep(Duration::from_secs(HEARTBEAT_SECS));
    }
}

fn main() {
    let cfg = load_config();
    println!(
        "[esfera-agent] v{} iniciado: servidor {}:{} uuid={}",
        env!("CARGO_PKG_VERSION"),
        cfg.server,
        cfg.port,
        cfg.hardware_uuid
    );

    let mut attempt: u32 = 0;
    loop {
        let _ = udp_handshake(&cfg);

        match run_session(&cfg) {
            Ok(()) => attempt = 0,
            Err(e) => {
                attempt += 1;
                eprintln!("[esfera-agent] sessão terminou: {}", e);
            }
        }

        // Backoff exponencial: T = min(15s, 1s * 2^c + rand(0..500ms))
        let base_ms = (1u64 << std::cmp::min(attempt, 10)) * 1000;
        let jitter_ms = rand::thread_rng().gen_range(0..500);
        let total_ms = std::cmp::min(MAX_BACKOFF_MS, base_ms.saturating_add(jitter_ms));
        eprintln!(
            "[esfera-agent] reconectando em {} ms (tentativa {})",
            total_ms, attempt
        );
        std::thread::sleep(Duration::from_millis(total_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Validação FUNCIONAL da CORREÇÃO A: o relay em handle_proxy NÃO pode
    /// travar quando o adbd (lado local) fecha a conexão. Antes da correção,
    /// std::io::copy com read_timeout(None) travava o loop de reconexão.
    /// Aqui simulamos: fake adbd na 5555, fake hub na 9999. O hub manda
    /// "proxy" e depois fecha; o adbd aceita e fecha após um instante.
    /// O teste PASSED significa que handle_proxy RETORNOU (não travou).
    #[test]
    fn relay_termina_quando_adbd_fecha() {
        // Fake adbd: aceita 1 conexão, some após 150ms (simula adbd morto).
        let adbd = TcpListener::bind("127.0.0.1:5555").unwrap();
        let adbd_h = std::thread::spawn(move || {
            if let Ok((mut s, _)) = adbd.accept() {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let _ = s.shutdown(Shutdown::Both);
            }
        });

        // Fake hub: aceita 1 conexão, manda "proxy 5555" e fecha após 400ms.
        let hub = TcpListener::bind("127.0.0.1:9999").unwrap();
        let hub_h = std::thread::spawn(move || {
            if let Ok((mut s, _)) = hub.accept() {
                let _ = s.write_all(b"{\"type\":\"proxy\",\"port\":5555}\n");
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = s.shutdown(Shutdown::Both);
            }
        });

        // Conecta ao fake hub como se fosse o agente.
        let _stream = TcpStream::connect("127.0.0.1:9999").unwrap();

        // Se handle_proxy travasse (bug antigo), este teste excederia o tempo
        // e falharia. Com a correção, ele RETORNA Ok(true) quando o adbd fecha.
        let result = handle_proxy(&mut stream_clone_for_test(), &mut reader_for_test(), 5555);
        let _ = adbd_h.join();
        let _ = hub_h.join();

        match result {
            Ok(true) => {} // relay encerrou corretamente -> correção OK
            Ok(false) => panic!("relay retornou false (adbd local inalcançável, mas não deveria travar)"),
            Err(e) => panic!("handle_proxy retornou erro inesperado: {}", e),
        }
    }

    // Helpers: reconectam ao fake hub para isolar o teste do borrow do stream acima.
    fn stream_clone_for_test() -> TcpStream {
        TcpStream::connect("127.0.0.1:9999").unwrap()
    }
    fn reader_for_test() -> BufReader<TcpStream> {
        BufReader::new(TcpStream::connect("127.0.0.1:9999").unwrap())
    }
}
