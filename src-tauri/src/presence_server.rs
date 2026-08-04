// ============================================================
// Esfera v3 — Servidor de Presença WebSocket (presence_server.rs)
// Canal de Telemetria e Heartbeat em Tempo Real (Porta 7779)
// ============================================================

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub uuid: String,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
}

pub async fn start(port: u16, app_handle: Option<AppHandle>) {
    let app = Router::new()
        .route("/ws/presence", get(ws_handler))
        .with_state(app_handle);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Servidor de Presença (WS) na porta {} ja em uso: {}", port, e);
            return;
        }
    };

    println!("🌐 Servidor de Presenca WebSocket ativo na porta {}", port);

    axum::serve(listener, app).await.unwrap_or_else(|e| {
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

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(hb) = serde_json::from_str::<HeartbeatPayload>(&text) {
                    current_uuid = Some(hb.uuid.clone());
                    
                    // Atualiza estado no SessionManager
                    crate::session_manager::update_presence(
                        &hb.uuid,
                        &client_ip,
                        hb.battery_level,
                        hb.is_charging,
                        hb.is_screen_on,
                    );

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
            Message::Close(_) => break,
            _ => {}
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
