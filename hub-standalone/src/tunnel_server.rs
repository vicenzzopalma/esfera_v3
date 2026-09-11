// ============================================================
// Esfera v3 — Hub Standalone — Servidor do Túnel Reverso (tunnel_server.rs)
// FONTE DE VERDADE do canal de CONTROLE ADB dos celulares.
//
// Responsável EXCLUSIVO: agente RUST (device-agent, /data/adb/earlypoint).
// O agente Kotlin NÃO abre túnel (evita disputa de sessão/porta/identidade).
//
// Protocolo (herdado do device-agent Rust, device-agent/src/main.rs:229):
//   handshake: {"type":"handshake","hardwareUuid","macAddress","serialNumber",
//               "agentVersion","currentLocalIp","companyId"}
//   heartbeat: {"type":"ping"}  -> {"type":"pong"}
//   proxy:     {"type":"proxy","port":P} -> hub responde {"type":"proxy-ack"}
//             (o RELAY bruto adbd<->hub é feito PELO device-agent após o ack;
//              o hub apenas sinaliza — não abre ponte local, evitando sistema duplo)
//
// Identidade: company_id + hardware_uuid(DEVICE_ID). NUNCA IP/socket.
// Isolamento: proxy só é processado porque a sessão de túnel existe para
//             (company_id, device_id). Mesmo device não pode ter 2 sessões
//             de túnel: open_tunnel substitui a anterior (device-agent reconecta
//             e manda handshake novo — socket velho é descartado no break).
// ============================================================

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use base64::Engine;

use crate::session_manager::{close_tunnel, heartbeat_tunnel, open_tunnel};

/// Struct do Handshake enviado na 1ª linha pelo agente Kotlin/C++
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelHandshake {
    hardware_uuid: String,
    #[serde(default)]
    company_id: i32,
    #[serde(default)]
    current_local_ip: String,
    #[serde(default = "default_adb_port")]
    local_port: u16,
}

fn default_adb_port() -> u16 { 5555 }

/// Timeout de inatividade L7 sem heartbeat (45 segundos)
const HEARTBEAT_GRACE_SECS: u64 = 45;

/// Registry de CONTROLE: (company_id, device_id) -> (session_id, canal de escrita)
static CONTROL: LazyLock<Mutex<HashMap<(i32, String), (String, mpsc::UnboundedSender<String>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pede ao device-agent que abra o proxy do adbd local na porta indicada.
pub fn request_proxy(company_id: i32, esfera_device_id: &str, adb_port: u16) -> Result<(), String> {
    let map = CONTROL.lock().unwrap();
    let (_, tx) = map
        .get(&(company_id, esfera_device_id.to_string()))
        .ok_or_else(|| "device sem túnel ativo para esta empresa".to_string())?;
    tx.send(format!("{{\"type\":\"proxy\",\"port\":{}}}", adb_port))
        .map_err(|_| "sessão de túnel encerrada".to_string())
}

/// Envia dados de proxy (do programa central, via router) para o agente pelo
/// canal de controle. Usado pelo router de porta lógica para fazer proxy
/// reverso: cliente -> VPS:porta_lógica -> túnel -> agente -> adbd local.
pub fn send_proxy_data(company_id: i32, esfera_device_id: &str, line: &str) -> Result<(), String> {
    send_control(company_id, esfera_device_id, line)
}

/// Envia uma linha JSON arbitrária pelo túnel de controle do device.
pub fn send_control(company_id: i32, esfera_device_id: &str, json_line: &str) -> Result<(), String> {
    let map = CONTROL.lock().unwrap();
    let (_, tx) = map
        .get(&(company_id, esfera_device_id.to_string()))
        .ok_or_else(|| "device sem túnel ativo para esta empresa".to_string())?;
    tx.send(json_line.to_string())
        .map_err(|_| "sessão de túnel encerrada".to_string())
}

/// Registry de RESULTADOS de comandos remotos: (company_id, device_id, cmd_id) -> sender.
static RESULTS: LazyLock<
    Mutex<HashMap<(i32, String, String), tokio::sync::oneshot::Sender<String>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Solicita execução de um comando no device (canal de controle remoto, sem root).
pub fn request_adb_command(
    company_id: i32,
    esfera_device_id: &str,
    cmd_id: &str,
    command: &str,
) -> Result<tokio::sync::oneshot::Receiver<String>, String> {
    let line = format!(
        "{{\"type\":\"adb_cmd\",\"id\":\"{}\",\"command\":{}}}",
        cmd_id,
        serde_json::to_string(command).unwrap_or_else(|_| format!("\"{}\"", command))
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    RESULTS
        .lock()
        .unwrap()
        .insert((company_id, esfera_device_id.to_string(), cmd_id.to_string()), tx);

    if let Err(e) = send_control(company_id, esfera_device_id, &line) {
        RESULTS
            .lock()
            .unwrap()
            .remove(&(company_id, esfera_device_id.to_string(), cmd_id.to_string()));
        return Err(e);
    }
    Ok(rx)
}

pub async fn start(port: u16) -> Result<(), String> {
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = crate::bind_reuse(addr).await
        .map_err(|e| format!("Tunnel server na porta {} ja em uso: {}", port, e))?;
    println!("🔌 Tunnel server (canal RUST) ativo na porta {}", port);

    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            crate::session_manager::sweep_stale(HEARTBEAT_GRACE_SECS, 30);
        }
    });

    loop {
        let (stream, remote_addr) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Aviso: erro ao aceitar túnel: {}", e);
                continue;
            }
        };
        tokio::spawn(async move {
            println!("[tunnel] accepted remote={}", remote_addr);
            if let Err(e) = handle_agent(stream).await {
                eprintln!("[tunnel] sessão encerrada: {}", e);
            }
        });
    }
}

/// Verifica se o dispositivo possui túnel TCP ativo no backend.
pub fn is_tunnel_active(company_id: i32, esfera_device_id: &str) -> bool {
    CONTROL
        .lock()
        .unwrap()
        .contains_key(&(company_id, esfera_device_id.to_string()))
}

async fn read_line(reader: &mut BufReader<tokio::net::tcp::ReadHalf<'_>>) -> Option<String> {
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line),
    }
}

async fn write_line(
    writer: &mut tokio::net::tcp::WriteHalf<'_>,
    msg: &str,
) -> Result<(), std::io::Error> {
    writer.write_all(msg.as_bytes()).await?;
    if !msg.ends_with('\n') {
        writer.write_all(b"\n").await?;
    }
    writer.flush().await
}

/// Processa uma conexão de agente no Server VPS (porta 8888)
pub async fn handle_agent(mut stream: TcpStream) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (reader, mut writer) = stream.split();
    let mut reader = BufReader::new(reader);

    // 1. Handshake na primeira linha
    let first_line = match read_line(&mut reader).await {
        Some(l) => l,
        None => return Ok(()),
    };

    let hs: TunnelHandshake = match serde_json::from_str(first_line.trim()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[tunnel] handshake invalido: {} — payload: {}", e, first_line.trim());
            return Ok(());
        }
    };

    let uuid = hs.hardware_uuid.trim().to_string();
    if uuid.is_empty() {
        eprintln!("[tunnel] handshake rejeitado: hardware_uuid vazio");
        return Ok(());
    }

    if hs.company_id <= 0 {
        write_line(&mut writer, "{\"error\":\"companyId obrigatorio\"}").await?;
        return Ok(());
    }
    let company_id = hs.company_id;

    // 2. Responde welcome ao agente
    write_line(&mut writer, "{\"type\":\"welcome\"}").await?;

    // 3. Abre a sessão de TÚNEL. Gera novo SESSION_ID.
    let session_id = open_tunnel(company_id, &uuid, &hs.current_local_ip, hs.local_port);

    // 4. Registra no mapa de CONTROLE (deduplica substituindo a sessão anterior se houver)
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut ctrl = CONTROL.lock().unwrap();
        if let Some((old_sess, _)) = ctrl.get(&(company_id, uuid.clone())) {
            println!(
                "[tunnel] previous_session={} replaced by new_session={} device={}",
                old_sess, session_id, uuid
            );
        }
        ctrl.insert((company_id, uuid.clone()), (session_id.clone(), tx));
    }
    println!("[tunnel] device {} (empresa {}) conectado (session {})", uuid, company_id, session_id);

    // 5. Loop: heartbeat L7 + comandos de controle
    let mut last_heartbeat = Instant::now();
    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(cmd) => { write_line(&mut writer, &cmd).await?; }
                    None => break,
                }
            }
            line = read_line(&mut reader) => {
                let line = match line {
                    Some(l) => l,
                    None => break,
                };
                last_heartbeat = Instant::now();
                heartbeat_tunnel(company_id, &uuid);
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("ping") => {
                        let _ = write_line(&mut writer, "{\"type\":\"pong\"}").await;
                    }
                    Some("proxy") => {
                        let _ = write_line(&mut writer, "{\"type\":\"proxy-ack\"}").await;
                    }
                    Some("proxy-data") => {
                        // Bytes do adbd local do agente, vindos pelo túnel,
                        // destinados ao programa central conectado na porta lógica.
                        let b64 = v.get("b64").and_then(|s| s.as_str()).unwrap_or("");
                        if let Ok(data) = base64::engine::general_purpose::STANDARD.decode(b64) {
                            crate::router::deliver_proxy_data(&uuid, data);
                        }
                    }
                    Some("adb_result") => {
                        let cmd_id = v.get("id").and_then(|s| s.as_str()).unwrap_or("");
                        let output = v.get("output").and_then(|s| s.as_str()).unwrap_or("");
                        if let Some(tx) = RESULTS.lock().unwrap().remove(&(company_id, uuid.clone(), cmd_id.to_string())) {
                            let _ = tx.send(output.to_string());
                        }
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(HEARTBEAT_GRACE_SECS)) => {
                if last_heartbeat.elapsed() >= Duration::from_secs(HEARTBEAT_GRACE_SECS) {
                    break;
                }
            }
        }
    }

    // 6. Cleanup SEGURO por geração: só remove de CONTROL se a sessão gravada for ESTA.
    {
        let mut ctrl = CONTROL.lock().unwrap();
        if let Some((stored_sess, _)) = ctrl.get(&(company_id, uuid.clone())) {
            if stored_sess == &session_id {
                ctrl.remove(&(company_id, uuid.clone()));
                close_tunnel(company_id, &uuid, &session_id);
                println!(
                    "[tunnel] connection_closed session={} device={}",
                    session_id, uuid
                );
            } else {
                println!(
                    "[tunnel] cleanup session={} device={} IGNORADO — sessão mais nova existe (não apaga CONTROL)",
                    session_id, uuid
                );
            }
        } else {
            close_tunnel(company_id, &uuid, &session_id);
            println!(
                "[tunnel] connection_closed session={} device={}",
                session_id, uuid
            );
        }
    }
    Ok(())
}


