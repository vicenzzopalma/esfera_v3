use axum::{Router, routing::post, Json, extract::State};
use chrono::Utc;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use crate::db::Database;

// Coalescencia por alvo e limite compartilhado entre check-in e presenca.
static ADB_PENDENTES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
static ADB_LIMITE: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(3)));

pub fn agendar_conexao_adb(alvo: String, desconectar: bool) {
    let Ok(mut pendentes) = ADB_PENDENTES.lock() else { return; };
    let agora = std::time::Instant::now();
    if pendentes.contains_key(&alvo) { return; }
    pendentes.insert(alvo.clone(), agora);
    drop(pendentes);
    tokio::spawn(async move {
        let permissao = match tokio::time::timeout(std::time::Duration::from_secs(30), ADB_LIMITE.clone().acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            _ => { if let Ok(mut pending) = ADB_PENDENTES.lock() { pending.remove(&alvo); } return; }
        };
        tokio::task::spawn_blocking(move || {
        let _permissao = permissao;
        let executar = |acao: &str| {
            let mut cmd = crate::adb_manager::create_cmd("adb");
            cmd.arg(acao).arg(&alvo).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            if let Ok(mut child) = cmd.spawn() {
                let limite = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) if std::time::Instant::now() >= limite => { let _ = child.kill(); let _ = child.wait(); break; }
                        Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                    }
                }
            }
        };
        if desconectar { executar("disconnect"); }
        executar("connect");
        if let Ok(mut pending) = ADB_PENDENTES.lock() { pending.remove(&alvo); }
        });
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInPayload {
    pub esfera_device_id: String,
    pub current_adb_address: String,
    #[serde(default)]
    pub adb_serial: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpHandshakePayload {
    pub hardware_uuid: String,
    pub ip: String,
    pub port: Option<u16>,
    pub company_id: Option<i32>,
    #[serde(default)]
    pub adb_serial: String,
}

pub async fn start(db: Arc<Database>, port: u16, app_handle: Option<AppHandle>) {
    // Inicia o listener UDP Broadcast na porta 7778 (Handshake nativo por Hardware ID)
    start_udp_broadcast_listener(db.clone(), app_handle.clone());

    let optout_router = crate::optout_api::router(db.clone());
    let state = (db, app_handle);
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .with_state(state)
        // Descadastro central (VEXOR -> Esfera): POST /api/optout/events, GET /api/optout/status
        .merge(optout_router);

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

                    let db_copy = db.clone();
                    let (uuid, address, ip, stamp, serial) = (payload.hardware_uuid.clone(), target_addr.clone(), payload.ip.clone(), now.clone(), payload.adb_serial.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Ok(0) = db_copy.process_checkin(&uuid, &address, &ip, port, &stamp, &serial) {
                            let _ = db_copy.insert_unknown_device(&uuid, &address, &ip, port, &stamp, &serial);
                        }
                    }).await;

                    agendar_conexao_adb(target_addr.clone(), true);

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

    let db_copy = db.clone();
    let (uuid, address, db_ip, stamp, serial) = (payload.esfera_device_id.clone(), adb_address.clone(), ip.clone(), now.clone(), payload.adb_serial.clone());
    let updated = tokio::task::spawn_blocking(move || {
        match db_copy.process_checkin(&uuid, &address, &db_ip, port, &stamp, &serial) {
            Ok(0) => db_copy.insert_unknown_device(&uuid, &address, &db_ip, port, &stamp, &serial).map(|_| ()),
            Ok(_) => Ok(()),
            Err(e) => Err(e),
        }
    }).await;
    if !matches!(updated, Ok(Ok(()))) { return "erro"; }

    let connect_target = format!("{}:{}", ip, port);
    agendar_conexao_adb(connect_target, true);

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
