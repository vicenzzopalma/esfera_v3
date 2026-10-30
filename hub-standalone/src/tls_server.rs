// ============================================================
// Esfera v3 — Hub Standalone — Servidor TLS 443/8443 (MDM Edge)
// Canal PRIMÁRIO criptografado para o agente Kotlin.
// Combina check-in (HTTPS) + presença (WSS) numa única porta TLS,
// reusando os handlers de checkin_server e presence_server.
// O 8080/7779 (HTTP/WS) permanece como FALLBACK (canal atual).
// ============================================================

use axum::{
    extract::{Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    Json,
    response::{IntoResponse, Response},
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

fn vps_ia_allowed(auth_company: i32, role: &str, requested: i32, configured: i32) -> bool {
    requested > 0 && requested == configured &&
        (role == "master" || (role == "empresa" && auth_company == requested))
}

#[cfg(test)]
mod vps_ia_tests {
    use super::vps_ia_allowed;
    #[test]
    fn isolamento_por_empresa() {
        assert!(vps_ia_allowed(1, "empresa", 1, 1));
        assert!(!vps_ia_allowed(2, "empresa", 1, 1));
        assert!(!vps_ia_allowed(1, "empresa", 2, 1));
        assert!(!vps_ia_allowed(1, "desconhecido", 1, 1));
        assert!(vps_ia_allowed(0, "master", 1, 1));
        assert!(!vps_ia_allowed(0, "master", 2, 1));
        assert!(!vps_ia_allowed(0, "master", 0, 0));
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VpsIaQuery { company_id: i32 }

// Disponivel apenas no listener TLS; a empresa autorizada e configurada no servico.
async fn vps_ia_config(
    State((db, _)): State<AppState>,
    Query(query): Query<VpsIaQuery>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let (company_id, role) = db.validate_token(token).ok_or(StatusCode::UNAUTHORIZED)?;
    let allowed_company = std::env::var("ESFERA_VPS_IA_COMPANY_ID").ok()
        .and_then(|s| s.parse::<i32>().ok()).filter(|id| *id > 0)
        .ok_or(StatusCode::NOT_FOUND)?;
    if !vps_ia_allowed(company_id, &role, query.company_id, allowed_company) {
        return Err(StatusCode::FORBIDDEN);
    }
    let read = |name| std::env::var(name).ok().filter(|s| !s.trim().is_empty()).ok_or(StatusCode::NOT_FOUND);
    if std::env::var("ESFERA_VPS_IA_ENABLED").ok().as_deref() == Some("false") {
        return Ok(([(axum::http::header::CACHE_CONTROL, "no-store")], Json(serde_json::json!({"enabled": false}))).into_response());
    }
    let token = read("ESFERA_VPS_IA_TOKEN")?;
    let endpoint = read("ESFERA_VPS_IA_ENDPOINT")?;
    let model = read("ESFERA_VPS_IA_MODEL")?;
    Ok(([(axum::http::header::CACHE_CONTROL, "no-store")], Json(serde_json::json!({"enabled": true, "token": token, "endpoint": endpoint, "model": model}))).into_response())
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
        .route("/api/desktop/vps-ia", get(vps_ia_config))
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
