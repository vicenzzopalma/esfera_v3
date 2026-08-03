// ============================================================
// Esfera v3 — Daemon Android (device-agent)
// Kernel-level: túnel inverso TCP (keepalive L4 + heartbeat L7),
// handshake UDP na porta 7778 e reconexão com backoff exponencial.
// Roda em /data/adb/earlypoint/esfera-agent (Magisk).
// ============================================================

use rand::Rng;
use serde_json::{json, Value};
use socket2::{Domain, Protocol, Socket, TcpKeepalive, Type};
use std::io::{BufRead, BufReader, Write};
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
    };
    if cfg.server.is_empty() {
        cfg.server = "127.0.0.1".to_string();
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

    // 3. Relay bruto: limpa timeouts (a sessão vira binária) e faz copy 2 vias.
    //    Usa clones do socket — o shutdown de qualquer lado derruba o par.
    let _ = stream.set_read_timeout(None);
    let _ = local.set_read_timeout(None);
    let mut raw_read = std::mem::replace(reader, BufReader::new(stream.try_clone().map_err(|e| e.to_string())?))
        .into_inner();
    let mut raw_write = stream.try_clone().map_err(|e| e.to_string())?;
    let mut local_read = local.try_clone().map_err(|e| e.to_string())?;
    let local_shutdown = local.try_clone().map_err(|e| e.to_string())?;
    let hub_shutdown = stream.try_clone().map_err(|e| e.to_string())?;

    let t1 = std::thread::spawn(move || {
        // Hub -> adbd
        let _ = std::io::copy(&mut raw_read, &mut local);
        let _ = local_shutdown.shutdown(Shutdown::Both);
        let _ = hub_shutdown.shutdown(Shutdown::Both);
    });
    let t2 = std::thread::spawn(move || {
        // adbd -> Hub
        let _ = std::io::copy(&mut local_read, &mut raw_write);
        let _ = raw_write.shutdown(Shutdown::Both);
        let _ = local_read.shutdown(Shutdown::Both);
    });
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
