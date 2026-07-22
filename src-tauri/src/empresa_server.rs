use crate::db::Database;
use crate::protocol::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpListener;

pub struct EmpresaServer;

impl EmpresaServer {
    pub async fn start(db: Arc<Mutex<Database>>, port: u16) -> Result<(), String> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port))
            .await
            .map_err(|e| format!("Falha ao iniciar Empresa Server na porta {}: {}", port, e))?;
        println!("Empresa Server ouvindo na porta {} (LAN)", port);

        loop {
            let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
            let db = db.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_lan_client(db, stream, addr).await {
                    eprintln!("Erro no cliente LAN {}: {}", addr, e);
                }
            });
        }
    }
}

async fn handle_lan_client(
    db: Arc<Mutex<Database>>,
    stream: tokio::net::TcpStream,
    addr: std::net::SocketAddr,
) -> Result<(), String> {
    let (reader, writer) = stream.into_split();
    let mut writer = BufWriter::new(writer);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                if let Ok(msg) = deserialize_msg(trimmed.as_bytes()) {
                    match msg {
                        HubMessage::Command { cmd, args, id, .. } => {
                            let result = execute_command_locally(&db, &cmd, &args).await;
                            let response = match result {
                                Ok(val) => HubMessage::CommandResponse { id, result: Some(val), error: None },
                                Err(e) => HubMessage::CommandResponse { id, result: None, error: Some(e) },
                            };
                            let data = serialize_msg(&response)?;
                            writer.write_all(&data).await.map_err(|e| e.to_string())?;
                            writer.flush().await.map_err(|e| e.to_string())?;
                        }
                        HubMessage::Ping => {
                            let data = serialize_msg(&HubMessage::Pong)?;
                            writer.write_all(&data).await.map_err(|e| e.to_string())?;
                            writer.flush().await.map_err(|e| e.to_string())?;
                        }
                        _ => {}
                    }
                }
            }
            Err(_) => break,
        }
    }

    println!("Cliente LAN desconectado: {}", addr);
    Ok(())
}

async fn execute_command_locally(
    db: &Arc<Mutex<Database>>,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    match cmd {
        "get_companies" => {
            let companies = db.get_companies();
            serde_json::to_value(companies).map_err(|e| e.to_string())
        }
        "get_devices" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let devices = db.get_devices(company_id);
            serde_json::to_value(devices).map_err(|e| e.to_string())
        }
        "get_campaigns" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let campaigns = db.get_campaigns(company_id);
            serde_json::to_value(campaigns).map_err(|e| e.to_string())
        }
        "get_dashboard_kpis" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let kpis = db.get_dashboard_kpis(company_id);
            serde_json::to_value(kpis).map_err(|e| e.to_string())
        }
        _ => Err(format!("Comando '{}' não disponível via Empresa Server", cmd)),
    }
}
