use crate::db::Database;
use crate::protocol::*;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpListener;
use tokio::task::spawn_blocking;
use tokio::time::{timeout, Duration};

pub struct EmpresaServer;

impl EmpresaServer {
    pub async fn start(db: Arc<Database>, port: u16) -> Result<(), String> {
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
    db: Arc<Database>,
    stream: tokio::net::TcpStream,
    addr: std::net::SocketAddr,
) -> Result<(), String> {
    let (reader, writer) = stream.into_split();
    let mut writer = BufWriter::new(writer);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match timeout(Duration::from_secs(300), reader.read_line(&mut line)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(_)) => {
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
        }
    }

    println!("Cliente LAN desconectado: {}", addr);
    Ok(())
}

async fn execute_command_locally(
    db: &Arc<Database>,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        "get_companies" => {
            let db = db.clone();
            let companies = spawn_blocking(move || db.get_companies()).await.map_err(|e| e.to_string())?;
            serde_json::to_value(companies).map_err(|e| e.to_string())
        }
        "get_devices" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let db = db.clone();
            let devices = spawn_blocking(move || db.get_devices(company_id)).await.map_err(|e| e.to_string())?;
            serde_json::to_value(devices).map_err(|e| e.to_string())
        }
        "get_campaigns" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let db = db.clone();
            let campaigns = spawn_blocking(move || db.get_campaigns(company_id)).await.map_err(|e| e.to_string())?;
            serde_json::to_value(campaigns).map_err(|e| e.to_string())
        }
        "get_dashboard_kpis" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let db = db.clone();
            let kpis = spawn_blocking(move || db.get_dashboard_kpis(company_id)).await.map_err(|e| e.to_string())?;
            serde_json::to_value(kpis).map_err(|e| e.to_string())
        }
        // ----------------------------------------------------------------
        // COMANDOS DE CONTROLE (antes o Empresa Server era somente leitura).
        // Regra de isolamento: o alvo é resolvido por (companyId, esferaDeviceId)
        // e o serial ADB é lido do DB — o cliente NUNCA envia serial/IP direto,
        // para não conseguir alcançar aparelho de outra empresa.
        // ----------------------------------------------------------------
        "device_tap" | "device_keyevent" | "device_type_text" | "device_capture_screen" => {
            let company_id = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let esfera_device_id = args
                .get("esferaDeviceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if company_id <= 0 || esfera_device_id.is_empty() {
                return Err("companyId e esferaDeviceId são obrigatórios".to_string());
            }

            let db_lookup = db.clone();
            let id_lookup = esfera_device_id.clone();
            let device = spawn_blocking(move || db_lookup.get_device_by_esfera_id(&id_lookup))
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "dispositivo não encontrado".to_string())?;

            if device.company_id != company_id {
                return Err("dispositivo pertence a outra empresa".to_string());
            }

            // Rota preferencial: endereço do túnel/check-in; fallback: serial ADB.
            let serial = device
                .current_adb_address
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| device.serial.clone());
            if serial.is_empty() {
                return Err("dispositivo sem endereço ADB conhecido".to_string());
            }

            let cmd_owned = cmd.to_string();
            let args_owned = args.clone();
            spawn_blocking(move || -> Result<serde_json::Value, String> {
                match cmd_owned.as_str() {
                    "device_tap" => {
                        let x = args_owned.get("x").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let y = args_owned.get("y").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        crate::adb_manager::AdbManager::tap_screen(&serial, x, y)?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "device_keyevent" => {
                        let keycode =
                            args_owned.get("keycode").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        crate::adb_manager::AdbManager::send_keyevent(&serial, keycode)?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "device_type_text" => {
                        let text = args_owned
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        crate::adb_manager::AdbManager::type_text_human_hpc(&serial, text)?;
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    "device_capture_screen" => {
                        let b64 = crate::adb_manager::AdbManager::capture_screen(&serial)?;
                        Ok(serde_json::json!({ "image": b64 }))
                    }
                    _ => Err("comando de controle desconhecido".to_string()),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err(format!("Comando '{}' não disponível via Empresa Server", cmd)),
    }
}
