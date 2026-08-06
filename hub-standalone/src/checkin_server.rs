use axum::{Router, routing::post, Json, extract::State, body::Bytes};
use chrono::Utc;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use crate::db::Database;

/// Self-update remoto: o app desktop (ou script) envia o binário novo do
/// hub-standalone via POST /admin/update (header X-Hub-Token = master). O hub
/// salva como .new, faz swap atômico e reinicia a si mesmo — sem SSH manual.
/// O SO_REUSEADDR nos listeners garante re-bind limpo no gap do restart.
async fn handle_update(
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> (axum::http::StatusCode, String) {
    let master_token = std::env::var("HUB_MASTER_TOKEN")
        .unwrap_or_else(|_| "EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b".to_string());
    let provided = headers
        .get("X-Hub-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != master_token {
        return (axum::http::StatusCode::UNAUTHORIZED, "token invalido".into());
    }
    if body.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, "binario vazio".into());
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("current_exe: {}", e)),
    };
    let new_path = format!("{}.new", exe.display());
    let old_path = format!("{}.old", exe.display());
    if let Err(e) = std::fs::write(&new_path, &body) {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("write .new: {}", e));
    }
    // Swap atômico: atual -> .old, .new -> atual
    let _ = std::fs::remove_file(&old_path);
    if let Err(e) = std::fs::rename(&exe, &old_path) {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("rename old: {}", e));
    }
    if let Err(e) = std::fs::rename(&new_path, &exe) {
        // rollback
        let _ = std::fs::rename(&old_path, &exe);
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("rename new: {}", e));
    }
    // Self-restart: sobe o novo binário e encerra este.
    match std::process::Command::new(&exe).spawn() {
        Ok(_) => {
            eprintln!("SELF-UPDATE: novo binario aplicado, reiniciando...");
            std::process::exit(0);
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("spawn: {}", e)),
    }
}

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
        .route("/admin/update", post(handle_update))
        .with_state((db, port));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match crate::bind_reuse(addr).await {
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
) -> (axum::http::StatusCode, &'static str) {
    use axum::http::StatusCode;

    // ISOLAMENTO: check-in sem COMPANY_ID válido é recusado explicitamente.
    if payload.company_id <= 0 {
        return (StatusCode::BAD_REQUEST, "companyId ausente ou invalido");
    }

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
            if let Err(e) = db.insert_unknown_device(
                &payload.esfera_device_id,
                adb_address,
                &ip,
                port,
                &now,
                payload.company_id,
            ) {
                eprintln!("Check-in insert error: {}", e);
                return (StatusCode::FORBIDDEN, "empresa invalida");
            }
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("Check-in DB error: {}", e);
            return (StatusCode::FORBIDDEN, "empresa invalida");
        }
    }

    (StatusCode::OK, "ok")
}
