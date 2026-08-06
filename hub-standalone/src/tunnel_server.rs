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

use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpListener;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tokio::sync::mpsc;

use crate::session_manager::{self, open_tunnel, close_tunnel, heartbeat_tunnel};

const HEARTBEAT_GRACE_SECS: u64 = 45;

/// Registry de CONTROLE: (company_id, device_id) -> canal de escrita da sessão
/// de túnel. É o que permite ao Master EMITIR comandos ao aparelho
/// (antes o hub só respondia `proxy-ack`, nunca pedia proxy — não existia
/// caminho Master -> VPS -> adbd).
/// Identidade é sempre (company_id, uuid); nunca IP/socket.
static CONTROL: LazyLock<Mutex<HashMap<(i32, String), mpsc::UnboundedSender<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pede ao device-agent que abra o proxy do adbd local na porta indicada.
/// Retorna erro se a empresa/dispositivo não tiver sessão de túnel ativa
/// (isolamento: empresa A nunca alcança device da empresa B).
pub fn request_proxy(company_id: i32, esfera_device_id: &str, adb_port: u16) -> Result<(), String> {
    let map = CONTROL.lock().unwrap();
    let tx = map
        .get(&(company_id, esfera_device_id.to_string()))
        .ok_or_else(|| "device sem túnel ativo para esta empresa".to_string())?;
    tx.send(format!("{{\"type\":\"proxy\",\"port\":{}}}", adb_port))
        .map_err(|_| "sessão de túnel encerrada".to_string())
}

/// Envia uma linha JSON arbitrária pelo túnel de controle do device.
pub fn send_control(company_id: i32, esfera_device_id: &str, json_line: &str) -> Result<(), String> {
    let map = CONTROL.lock().unwrap();
    let tx = map
        .get(&(company_id, esfera_device_id.to_string()))
        .ok_or_else(|| "device sem túnel ativo para esta empresa".to_string())?;
    tx.send(json_line.to_string())
        .map_err(|_| "sessão de túnel encerrada".to_string())
}

/// Registry de RESULTADOS de comandos remotos: (company_id, device_id, cmd_id) -> sender.
/// O hub.rs (send_device_command) aguarda neste canal até o device responder `adb_result`.
static RESULTS: LazyLock<
    Mutex<HashMap<(i32, String, String), tokio::sync::oneshot::Sender<String>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Solicita execução de um comando no device (canal de controle remoto, sem root).
/// O device (agente Kotlin) executa localmente e devolve `adb_result` com o mesmo id.
/// Retorna o Receiver que o hub.rs deve aguardar (com timeout).
pub fn request_adb_command(
    company_id: i32,
    esfera_device_id: &str,
    cmd_id: &str,
    command: &str,
) -> Result<tokio::sync::oneshot::Receiver<String>, String> {
    let line = format!(
        "{{\"type\":\"adb_cmd\",\"id\":\"{}\",\"command\":{}}}",
        cmd_id,
        serde_json::to_string(command).map_err(|e| e.to_string())?
    );
    {
        let map = CONTROL.lock().unwrap();
        let tx = map
            .get(&(company_id, esfera_device_id.to_string()))
            .ok_or_else(|| "device sem túnel ativo para esta empresa".to_string())?;
        tx.send(line).map_err(|_| "sessão de túnel encerrada".to_string())?;
    }
    let (os_tx, os_rx) = tokio::sync::oneshot::channel::<String>();
    RESULTS
        .lock()
        .unwrap()
        .insert((company_id, esfera_device_id.to_string(), cmd_id.to_string()), os_tx);
    Ok(os_rx)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentHandshake {
    #[serde(rename = "type")]
    _msg_type: Option<String>,
    hardware_uuid: Option<String>,
    #[serde(default)]
    _mac_address: String,
    #[serde(default)]
    _serial_number: String,
    #[serde(default)]
    _agent_version: String,
    #[serde(default)]
    _current_local_ip: String,
    // NOVO: identidade de isolamento (vindo do device-agent Rust).
    #[serde(default)]
    company_id: i32,
}

pub async fn start(port: u16) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Tunnel server na porta {} ja em uso: {}", port, e);
            return;
        }
    };
    println!("🔌 Tunnel server (canal RUST) ativo na porta {}", port);

    // Heartbeat sweeper: mantém o estado de túnel fiel à realidade da conexão.
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            session_manager::sweep_stale(HEARTBEAT_GRACE_SECS, 30);
        }
    });

    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Aviso: erro ao aceitar túnel: {}", e);
                continue;
            }
        };
        tokio::spawn(async move {
            if let Err(e) = handle_agent(stream).await {
                eprintln!("[tunnel] sessão encerrada: {}", e);
            }
        });
    }
}

async fn handle_agent(stream: tokio::net::TcpStream) -> Result<(), String> {
    let (read_half, write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);
    let mut writer = BufWriter::new(write_half);

    // 1. Handshake na primeira linha (timeout 10s)
    let first = tokio::time::timeout(Duration::from_secs(10), read_line(&mut reader))
        .await
        .map_err(|_| "timeout no handshake".to_string())?
        .ok_or("sem handshake".to_string())?;

    let hs: AgentHandshake = serde_json::from_str(&first)
        .map_err(|e| format!("handshake inválido: {}", e))?;

    let uuid = hs
        .hardware_uuid
        .filter(|u| !u.is_empty())
        .ok_or("hardware_uuid ausente".to_string())?;
    let company_id = hs.company_id;

    // ISOLAMENTO: sem COMPANY_ID válido não existe sessão. Antes, o
    // #[serde(default)] fazia todo device cair na empresa 0 — todos os
    // aparelhos de todas as empresas colidiam na mesma chave.
    if company_id <= 0 {
        let _ = write_line(
            &mut writer,
            "{\"type\":\"error\",\"reason\":\"companyId ausente ou invalido\"}",
        )
        .await;
        return Err(format!(
            "handshake recusado: device {} sem companyId valido",
            uuid
        ));
    }

    // 2. Confirma handshake
    write_line(&mut writer, "{\"type\":\"welcome\"}").await?;

    // 3. Abre a sessão de TÚNEL (canal EXCLUSIVO do rust). Gera novo SESSION_ID.
    let session_id = open_tunnel(company_id, &uuid);
    println!(
        "[tunnel] device {} (empresa {}) conectado — session {}",
        uuid, company_id, session_id
    );

    // 4. Registra o canal de CONTROLE desta sessão (Master -> device).
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    CONTROL
        .lock()
        .unwrap()
        .insert((company_id, uuid.clone()), tx);

    // 5. Loop: heartbeat L7 (ping/pong) + comandos de controle + proxy
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
                    None => break, // EOF ou erro -> encerra (device reconecta)
                };
                last_heartbeat = Instant::now();
                heartbeat_tunnel(company_id, &uuid);
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("ping") => {
                        write_line(&mut writer, "{\"type\":\"pong\"}").await?;
                    }
                    Some("proxy") => {
                        // Sinaliza ao device-agent que o hub aceita o proxy.
                        // O relay bruto é feito PELO device-agent (handle_proxy).
                        write_line(&mut writer, "{\"type\":\"proxy-ack\"}").await?;
                    }
                    // Respostas ao proxy PEDIDO pelo hub (Master -> VPS -> adbd).
                    Some("proxy-ack") => {
                        println!("[tunnel] proxy aceito pelo device {} (empresa {})", uuid, company_id);
                    }
                    Some("proxy-error") => {
                        let reason = v.get("error").and_then(|e| e.as_str()).unwrap_or("desconhecido");
                        eprintln!(
                            "[tunnel] proxy recusado pelo device {} (empresa {}): {}",
                            uuid, company_id, reason
                        );
                    }
                    // Resultado de comando remoto (agente Kotlin executou localmente).
                    Some("adb_result") => {
                        let cmd_id = v
                            .get("id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let output = v
                            .get("output")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        if let Some(tx) = RESULTS
                            .lock()
                            .unwrap()
                            .remove(&(company_id, uuid.clone(), cmd_id.clone()))
                        {
                            let _ = tx.send(output);
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

    // 6. Cleanup: remove canal de controle e marca túnel offline (presença intocada).
    CONTROL.lock().unwrap().remove(&(company_id, uuid.clone()));
    close_tunnel(company_id, &uuid);
    println!(
        "[tunnel] device {} (empresa {}) desconectado — túnel fechado",
        uuid, company_id
    );
    Ok(())
}

async fn read_line(reader: &mut BufReader<tokio::io::ReadHalf<tokio::net::TcpStream>>) -> Option<String> {
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line),
    }
}

async fn write_line(writer: &mut BufWriter<tokio::io::WriteHalf<tokio::net::TcpStream>>, s: &str) -> Result<(), String> {
    let mut buf = s.as_bytes().to_vec();
    buf.push(b'\n');
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}
