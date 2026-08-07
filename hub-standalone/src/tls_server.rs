// ============================================================
// Esfera v3 — Hub Standalone — Servidor TLS 443/8443 (MDM Edge)
// Canal PRIMÁRIO criptografado para o agente Kotlin.
// Combina check-in (HTTPS) + presença (WSS) numa única porta TLS,
// reusando os handlers de checkin_server e presence_server.
// O 8080/7779 (HTTP/WS) permanece como FALLBACK (canal atual).
// ============================================================

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;

use crate::checkin_server::handle_checkin;
use crate::checkin_server::handle_update;
use crate::db::Database;
use crate::presence_server::{handle_socket, ws_handler};

type AppState = (Arc<Database>, u16);

/// Wrapper de presença que aceita o State do TLS server (ignora) e faz
/// upgrade do WebSocket, delegando ao handle_socket do presence_server.
async fn ws_handler_tls(_state: State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket))
}

/// Inicia o listener TLS na porta `tls_port` (default 8443), servindo
/// HTTPS (check-in + self-update) e WSS (presença) na mesma porta.
///
/// Certificado: paths via env TLS_CERT / TLS_KEY (default ./tls/cert.pem e
/// ./tls/key.pem). Para teste, use cert self-signed (openssl x509).
/// Em produção, cert de CA real (failover regional).
pub async fn start(db: Arc<Database>, tls_port: u16) {
    let cert_path = std::env::var("TLS_CERT").unwrap_or_else(|_| "tls/cert.pem".to_string());
    let key_path = std::env::var("TLS_KEY").unwrap_or_else(|_| "tls/key.pem".to_string());

    let cert = match std::fs::read(&cert_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "TLS: certificado nao encontrado em '{}' ({}). TLS desativado — use 8080/7779. Gere com: openssl req -x509 -newkey rsa:2048 -nodes -keyout {} -out {} -days 365 -subj \"/CN=localhost\"",
                cert_path, e, key_path, cert_path
            );
            return;
        }
    };
    let key = match std::fs::read(&key_path) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("TLS: chave privada nao encontrada em '{}' ({}). TLS desativado.", key_path, e);
            return;
        }
    };

    let rustls_config = match axum_server::tls_rustls::RustlsConfig::from_pem(cert, key).await {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("TLS: falha ao carregar cert/key: {}. TLS desativado.", e);
            return;
        }
    };

    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .route("/admin/update", post(handle_update))
        .route("/ws/presence", get(ws_handler_tls))
        .with_state((db, tls_port));

    let addr = SocketAddr::from(([0, 0, 0, 0], tls_port));
    println!(
        "🔐 Servidor TLS (canal KOTLIN primario) rodando em https://0.0.0.0:{} (WSS /ws/presence)",
        tls_port
    );
    let _ = std::io::stdout().flush();

    if let Err(e) = axum_server::bind_rustls(addr, rustls_config)
        .serve(app.into_make_service())
        .await
    {
        eprintln!("TLS: servidor encerrado: {}", e);
    }
}
