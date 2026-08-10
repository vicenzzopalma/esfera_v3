// ============================================================
// Esfera v3 — Hub Standalone — Servidor de Presença WebSocket (presence_server.rs)
// Canal de telemetria/bateria/tela em tempo real (porta 7779).
//
// Responsável EXCLUSIVO: agente KOTLIN (EsferaAgentService).
// O agente Rust NÃO faz presença (evita disputa de sessão/porta/identidade).
//
// Protocolo (herdado do EsferaAgentService, PresenceClient.kt):
//   WS /ws/presence
//   payload: {"uuid":DEVICE_ID,"batteryLevel":N,"isCharging":bool,"isScreenOn":bool,
//             "companyId":N}
//   servidor responde {"status":"ack"} a cada heartbeat.
//
// Identidade: company_id + uuid(DEVICE_ID). NUNCA IP.
// Isolamento: o estado é indexado por (company_id, device_id) e filtrado
//             por company_id nas consultas do master.
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
use std::sync::Arc;

use crate::session_manager::{self, open_presence, heartbeat_presence, close_presence};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub uuid: String,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
    #[serde(default)]
    pub company_id: i32,
}

pub async fn start(port: u16) {
    let app = Router::new()
        .route("/ws/presence", get(ws_handler))
        .with_state(());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match crate::bind_reuse(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Servidor de Presença (WS) na porta {} ja em uso: {}", port, e);
            return;
        }
    };

    println!("🌐 Servidor de Presença WebSocket (canal KOTLIN) ativo na porta {}", port);

    axum::serve(listener, app).await.unwrap_or_else(|e| {
        eprintln!("AVISO: Servidor de Presença WS encerrado: {}", e);
    });
}

pub async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket))
}

pub async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let mut current: Option<(i32, String)> = None;

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(hb) = serde_json::from_str::<HeartbeatPayload>(&text) {
                    let company_id = if hb.company_id <= 0 { 1 } else { hb.company_id };
                    if current.is_none() {
                        // Primeira mensagem abre a sessão de PRESENÇA (canal kotlin).
                        let sid = open_presence(
                            company_id,
                            &hb.uuid,
                            hb.battery_level,
                            hb.is_charging,
                            hb.is_screen_on,
                        );
                        println!(
                            "[presence] device {} (empresa {}) conectado — session {}",
                            hb.uuid, company_id, sid
                        );
                        current = Some((company_id, hb.uuid.clone()));
                    } else {
                        // Heartbeats seguintes apenas renovam.
                        heartbeat_presence(
                            company_id,
                            &hb.uuid,
                            hb.battery_level,
                            hb.is_charging,
                            hb.is_screen_on,
                        );
                    }

                    let _ = sender.send(Message::Text(r#"{"status":"ack"}"#.to_string())).await;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Ao desconectar, fecha APENAS a presença (túnel intocado).
    if let Some((company_id, uuid)) = current {
        close_presence(company_id, &uuid);
        println!(
            "[presence] device {} (empresa {}) desconectado — presença fechada",
            uuid, company_id
        );
    }
}
