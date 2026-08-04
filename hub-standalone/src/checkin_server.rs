use axum::{Router, routing::post, Json, extract::State};
use chrono::Utc;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use crate::db::Database;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInPayload {
    pub esfera_device_id: String,
    pub current_adb_address: String,
    #[serde(default)]
    pub company_id: i32,
}

pub async fn start(db: Arc<Database>, port: u16) {
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .with_state((db, port));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Check-in server na porta {} ja em uso: {}", port, e);
            return;
        }
    };
    println!("Servidor HTTP Check-in (canal KOTLIN) rodando em http://0.0.0.0:{}", port);
    axum::serve(listener, app).await
        .expect("Falha ao iniciar check-in server");
}

async fn handle_checkin(
    State((db, _port)): State<(Arc<Database>, u16)>,
    Json(payload): Json<CheckInPayload>,
) -> &'static str {
    let now = Utc::now().to_rfc3339();
    let adb_address = &payload.current_adb_address;

    let (ip, port) = match adb_address.rsplit_once(':') {
        Some((ip_str, port_str)) => (ip_str.to_string(), port_str.parse::<u16>().unwrap_or(5555)),
        None => (adb_address.clone(), 5555),
    };

    // Grava com company_id para isolar a presença no VPS.
    let updated = db.process_checkin(
        &payload.esfera_device_id,
        adb_address,
        &ip,
        port,
        &now,
        payload.company_id,
    );

    match updated {
        Ok(0) => {
            let _ = db.insert_unknown_device(
                &payload.esfera_device_id,
                adb_address,
                &ip,
                port,
                &now,
                payload.company_id,
            );
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("Check-in DB error: {}", e);
            return "erro";
        }
    }

    "ok"
}
