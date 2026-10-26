// ============================================================
// Esfera v3 — Servidor de Presença WebSocket (presence_server.rs)
// Canal de Telemetria e Heartbeat em Tempo Real (Porta 7779)
// Suporte a TCP Keep-Alive Nativo (socket2) + Ping/Pong 5s
// ============================================================

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::net::SocketAddr;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub uuid: String,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
    // SERIAL ADB físico: chave de fusão independente de IP. Quando o agente
    // envia, registramos presença TAMBÉM sob o serial, para que o get_devices
    // (que cruza por AdbDeviceId) funda USB (sem IP) e WiFi no mesmo cartão.
    #[serde(default)]
    pub adb_serial: String,
    #[serde(default)]
    pub accessibility_enabled: bool,
}

fn create_socket2_listener(addr: SocketAddr) -> Result<tokio::net::TcpListener, String> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    ).map_err(|e| e.to_string())?;
    
    let _ = socket.set_reuse_address(true);
    
    let mut keepalive = socket2::TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(3))
        .with_interval(std::time::Duration::from_secs(2));
    #[cfg(not(any(target_os = "openbsd", target_os = "netbsd")))]
    {
        keepalive = keepalive.with_retries(3);
    }
    let _ = socket.set_tcp_keepalive(&keepalive);
    socket.bind(&addr.into()).map_err(|e| e.to_string())?;
    socket.listen(1024).map_err(|e| e.to_string())?;
    let std_listener: std::net::TcpListener = socket.into();
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    tokio::net::TcpListener::from_std(std_listener).map_err(|e| e.to_string())
}

pub async fn start(port: u16, app_handle: Option<AppHandle>) {
    let app = Router::new()
        .route("/ws/presence", get(ws_handler))
        .with_state(app_handle);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Configura o socket TCP nativo com SO_KEEPALIVE extremo (3s idle, 2s interval)
    let listener = match create_socket2_listener(addr) {
        Ok(l) => l,
        Err(err_str) => {
            eprintln!("AVISO: Servidor de Presenca (WS) na porta {}: tentando bind padrao ({})", port, err_str);
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(err) => {
                    eprintln!("AVISO: Servidor de Presenca (WS) na porta {} em uso: {}", port, err);
                    return;
                }
            }
        }
    };

    println!("🌐 Servidor de Presenca WebSocket ativo na porta {} (Socket Keep-Alive Extremo 3s)", port);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap_or_else(|e| {
        eprintln!("AVISO: Servidor de Presenca WS encerrado: {}", e);
    });
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(app_handle): State<Option<AppHandle>>,
    addr: axum::extract::ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let client_ip = addr.0.ip().to_string();
    ws.on_upgrade(move |socket| handle_socket(socket, client_ip, app_handle))
}

async fn handle_socket(socket: WebSocket, client_ip: String, app_handle: Option<AppHandle>) {
    let (mut sender, mut receiver) = socket.split();
    let mut current_uuid: Option<String> = None;
    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(5));

    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if sender.send(Message::Ping(vec![1, 2, 3, 4])).await.is_err() {
                    break;
                }
            }
            msg_opt = receiver.next() => {
                let msg = match msg_opt {
                    Some(Ok(m)) => m,
                    _ => break,
                };
                match msg {
                    Message::Text(text) => {
                        if let Ok(hb) = serde_json::from_str::<HeartbeatPayload>(&text) {
                            current_uuid = Some(hb.uuid.clone());
                            
                            // Atualiza estado no SessionManager (pelo Hardware ID / ESF-)
                            crate::session_manager::update_presence(
                                &hb.uuid,
                                &client_ip,
                                hb.battery_level,
                                hb.is_charging,
                                hb.is_screen_on,
                            );

                            // FUSÃO POR SERIAL ADB: registra presença TAMBÉM sob o
                            // serial físico, para que USB (sem IP) e WiFi colapsem no
                            // mesmo cartão no get_devices. Conecta ADB pelo serial.
                            if !hb.adb_serial.is_empty() {
                                crate::session_manager::update_presence(
                                    &hb.adb_serial,
                                    &client_ip,
                                    hb.battery_level,
                                    hb.is_charging,
                                    hb.is_screen_on,
                                );
                                let serial_clone = hb.adb_serial.clone();
                                std::thread::spawn(move || {
                                    let _ = crate::adb_manager::AdbManager::connect_device(&serial_clone, 5555);
                                });
                                if let Some(ref app) = app_handle {
                                    if let Some(session) = crate::session_manager::get_session(&hb.adb_serial) {
                                        let _ = app.emit("presence-updated", &session);
                                    }
                                }
                            }

                            // O Hardware ID (uuid) é a ÚNICA FONTE DA VERDADE. O IP é volátil.
                            // Conecta o ADB no IP novo e atualiza o banco de dados em background imediatamente:
                            let uuid_clone = hb.uuid.clone();
                            let ip_clone = client_ip.clone();
                            let app_clone = app_handle.clone();
                            std::thread::spawn(move || {
                                let _ = crate::adb_manager::AdbManager::connect_device(&ip_clone, 5555);
                                if let Some(ref app) = app_clone {
                                    if let Some(state) = tauri::Manager::try_state::<crate::AppState>(app) {
                                        let _ = state.db.update_device_network_by_id(&uuid_clone, &ip_clone, 5555);
                                    }
                                }
                            });

                            // Notifica o frontend via Tauri Event
                            if let Some(ref app) = app_handle {
                                if let Some(session) = crate::session_manager::get_session(&hb.uuid) {
                                    let _ = app.emit("presence-updated", &session);
                                }
                            }

                            // Responde com ACK de heartbeat
                            let _ = sender.send(Message::Text(r#"{"status":"ack"}"#.to_string())).await;
                        }
                    }
                    Message::Pong(_) => {
                        // Pong recebido do celular — conexão viva e saudável
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    // Ao desconectar o socket, marca a presença como Offline
    if let Some(uuid) = current_uuid {
        crate::session_manager::disconnect_presence(&uuid);
        if let Some(ref app) = app_handle {
            if let Some(session) = crate::session_manager::get_session(&uuid) {
                let _ = app.emit("presence-updated", &session);
            }
        }
    }
}
