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
    pub device_id: String,
    pub ip_address: String,
    pub adb_port: u16,
}

pub async fn start(db: Arc<Database>, port: u16, app_handle: AppHandle) {
    let state = (db, app_handle);
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await
        .expect("Falha ao bindar check-in server");
    axum::serve(listener, app).await
        .expect("Falha ao iniciar check-in server");
}

async fn handle_checkin(
    State((db, app_handle)): State<(Arc<Database>, AppHandle)>,
    Json(payload): Json<CheckInPayload>,
) -> &'static str {
    let now = Utc::now().to_rfc3339();
    let adb_address = format!("{}:{}", payload.ip_address, payload.adb_port);

    let updated = db.process_checkin(&payload.device_id, &adb_address, &payload.ip_address, payload.adb_port, &now);

    match updated {
        Ok(0) => {
            let _ = db.insert_unknown_device(&payload.device_id, &adb_address, &payload.ip_address, payload.adb_port, &now);
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("Check-in DB error: {}", e);
            return "erro";
        }
    }

    let _ = app_handle.emit("device-updated", serde_json::json!({
        "esferaDeviceId": payload.device_id,
        "currentAdbAddress": adb_address,
        "status": "online",
        "lastSeenUtc": now,
    }));

    "ok"
}
