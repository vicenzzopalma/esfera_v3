use axum::{Router, routing::post, Json, extract::State};
use chrono::Utc;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use crate::db::Database;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInPayload {
    pub esfera_device_id: String,
    pub current_adb_address: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpHandshakePayload {
    pub hardware_uuid: String,
    pub ip: String,
    pub port: Option<u16>,
    pub company_id: Option<i32>,
}

pub async fn start(db: Arc<Database>, port: u16, app_handle: Option<AppHandle>) {
    // Inicia o listener UDP Broadcast na porta 7778 (Handshake nativo por Hardware ID)
    start_udp_broadcast_listener(db.clone(), app_handle.clone());

    let state = (db, app_handle);
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Check-in server na porta {} ja em uso: {}", port, e);
            return;
        }
    };

    axum::serve(listener, app).await.unwrap_or_else(|e| {
        eprintln!("AVISO: Check-in server encerrado: {}", e);
    });
}

pub fn start_udp_broadcast_listener(db: Arc<Database>, app_handle: Option<AppHandle>) {
    tokio::spawn(async move {
        let socket = match tokio::net::UdpSocket::bind("0.0.0.0:7778").await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("AVISO: Nao foi possivel abrir UDP Listener 7778: {}", e);
                return;
            }
        };

        println!("⚡ UDP Handshake Listener ativo na porta 7778 (Zero-CPU Event Driven)");
        let mut buf = [0u8; 2048];

        loop {
            if let Ok((len, _addr)) = socket.recv_from(&mut buf).await {
                if let Ok(payload) = serde_json::from_slice::<UdpHandshakePayload>(&buf[..len]) {
                    let port = payload.port.unwrap_or(5555);
                    let target_addr = format!("{}:{}", payload.ip, port);
                    let now = Utc::now().to_rfc3339();

                    println!("[UDP HANDSHAKE] Aparelho '{}' anunciado em {}:{}", payload.hardware_uuid, payload.ip, port);

                    let updated = db.process_checkin(&payload.hardware_uuid, &target_addr, &payload.ip, port, &now);
                    if let Ok(0) = updated {
                        let _ = db.insert_unknown_device(&payload.hardware_uuid, &target_addr, &payload.ip, port, &now);
                    }

                    // Flush preventivo de socket zumbi antes de reconectar (evita "already connected")
                    let flush_target = target_addr.clone();
                    let _ = crate::adb_manager::create_cmd("adb")
                        .arg("disconnect")
                        .arg(&flush_target)
                        .output();

                    // Conecta via ADB sob demanda
                    let conn_target = target_addr.clone();
                    tokio::task::spawn_blocking(move || {
                        let _ = crate::adb_manager::create_cmd("adb")
                            .arg("connect")
                            .arg(&conn_target)
                            .output();
                    });

                    if let Some(ref app) = app_handle {
                        let _ = app.emit("device-updated", serde_json::json!({
                            "esferaDeviceId": payload.hardware_uuid,
                            "currentAdbAddress": target_addr,
                            "status": "online",
                            "lastSeenUtc": now,
                        }));
                    }
                }
            }
        }
    });
}

async fn handle_checkin(
    State((db, app_handle)): State<(Arc<Database>, Option<AppHandle>)>,
    Json(payload): Json<CheckInPayload>,
) -> &'static str {
    let now = Utc::now().to_rfc3339();
    let adb_address = &payload.current_adb_address;

    let (ip, port) = match adb_address.rsplit_once(':') {
        Some((ip_str, port_str)) => (ip_str.to_string(), port_str.parse::<u16>().unwrap_or(5555)),
        None => (adb_address.clone(), 5555),
    };

    let updated = db.process_checkin(&payload.esfera_device_id, adb_address, &ip, port, &now);

    match updated {
        Ok(0) => {
            let _ = db.insert_unknown_device(&payload.esfera_device_id, adb_address, &ip, port, &now);
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("Check-in DB error: {}", e);
            return "erro";
        }
    }

    // Event-Driven PUSH: Conecta instantaneamente via ADB ao endereço notificado pelo APK do aparelho
    let connect_target = format!("{}:{}", ip, port);
    // Flush preventivo de socket zumbi antes de reconectar (evita "already connected")
    let flush_target = connect_target.clone();
    let _ = crate::adb_manager::create_cmd("adb")
        .arg("disconnect")
        .arg(&flush_target)
        .output();
    tokio::task::spawn_blocking(move || {
        let _ = crate::adb_manager::create_cmd("adb")
            .arg("connect")
            .arg(&connect_target)
            .output();
    });

    if let Some(app) = app_handle {
        let _ = app.emit("device-updated", serde_json::json!({
            "esferaDeviceId": payload.esfera_device_id,
            "currentAdbAddress": adb_address,
            "status": "online",
            "lastSeenUtc": now,
        }));
    }

    "ok"
}
