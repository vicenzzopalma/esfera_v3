use axum::{Router, routing::{post, get}, Json, extract::{ConnectInfo, State}, body::Bytes};
use axum::response::IntoResponse;
use chrono::Utc;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use crate::db::Database;

fn master_token_matches(provided: &str, expected: Option<&str>) -> bool {
    expected.map(str::trim).filter(|value| !value.is_empty())
        .map(|value| !provided.trim().is_empty() && provided == value)
        .unwrap_or(false)
}

/// Self-update remoto: o app desktop (ou script) envia o binário novo do
/// hub-standalone via POST /admin/update (header X-Hub-Token = master). O hub
/// salva como .new, faz swap atômico e reinicia a si mesmo — sem SSH manual.
/// O SO_REUSEADDR nos listeners garante re-bind limpo no gap do restart.
pub async fn handle_update(
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> (axum::http::StatusCode, String) {
    let master_token = std::env::var("HUB_MASTER_TOKEN").ok();
    let provided = headers
        .get("X-Hub-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !master_token_matches(provided, master_token.as_deref()) {
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
    pub adb_serial: String,
    #[serde(default)]
    pub company_id: i32,
    #[serde(default)]
    pub local_port: u16,
}

#[derive(Deserialize)]
pub struct RenameDevicePayload {
    pub esfera_device_id: String,
    pub name: String,
    #[serde(default)]
    pub company_id: i32,
}

pub async fn start(db: Arc<Database>, port: u16) {
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .route("/api/devices/rename", post(handle_rename_device))
        .route("/admin/update", post(handle_update))
        // Canal de atualização remota: o agente (self_update) baixa o APK daqui,
        // sem SSH. Serve o arquivo em AGENT_APK_PATH (default ~/esfera_v3/agent_release/esfera_agent.apk).
        .route("/download/agent.apk", get(handle_download_agent))
        // Diagnóstico: devolve o IP de origem que o hub vê nesta conexão. Não é a
        // fonte da auditoria — atrás da VPN o hub veria o endereço interno do túnel.
        .route("/api/egress", get(handle_egress))
        // Registro central da auditoria: o desktop envia aqui o resultado de cada
        // verificação de rota (aparelho, IP de saída, modo, fase, veredito).
        .route("/api/egress/report", post(handle_egress_report))
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
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
        .expect("Falha ao iniciar check-in server");
}

/// Devolve, em texto puro, o IP de origem da conexão — visto pelo hub.
pub async fn handle_egress(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> String {
    addr.ip().to_string()
}

/// Resultado de uma verificação de rota, enviado pelo desktop. Só veredito de
/// rede: nenhum telefone, contato ou credencial trafega neste endpoint.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressReportPayload {
    pub device_id: i32,
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub observed_ip: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub detail: String,
}

pub async fn handle_egress_report(
    State((db, _port)): State<(Arc<Database>, u16)>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<EgressReportPayload>,
) -> (axum::http::StatusCode, String) {
    use axum::http::StatusCode;
    let master_token = std::env::var("HUB_MASTER_TOKEN").ok();
    let provided = headers.get("X-Hub-Token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !master_token_matches(provided, master_token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "token invalido".into());
    }
    if payload.device_id <= 0 {
        return (StatusCode::BAD_REQUEST, "deviceId ausente ou invalido".into());
    }
    match db.record_egress_check(payload.device_id, &payload.checked_at, &payload.observed_ip,
        &payload.mode, &payload.phase, &payload.result, &payload.detail) {
        Ok(()) => (StatusCode::OK, "ok".into()),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn handle_checkin(
    State((db, _port)): State<(Arc<Database>, u16)>,
    Json(payload): Json<CheckInPayload>,
) -> (axum::http::StatusCode, String) {
    use axum::http::StatusCode;

    let company_id = payload.company_id;
    if company_id <= 0 {
        return (StatusCode::BAD_REQUEST, "companyId ausente ou invalido".into());
    }

    let now = Utc::now().to_rfc3339();
    let adb_address = &payload.current_adb_address;
    // Porta local ADB: o agente reporta a porta REAL (local_port), não a do
    // endereço fixo. Se o agente não mandou, cai no parse do endereço.
    let ip = adb_address.rsplit_once(':').map(|(ip_str, _)| ip_str.to_string()).unwrap_or_default();
    let port = if payload.local_port > 0 {
        payload.local_port
    } else {
        match adb_address.rsplit_once(':') {
            Some((_, p)) => p.parse::<u16>().unwrap_or(5555),
            None => 5555,
        }
    };

    // Grava com company_id para isolar a presença no VPS.
    let updated = db.process_checkin(
        &payload.esfera_device_id,
        adb_address,
        &ip,
        port,
        &now,
        company_id,
        &payload.adb_serial,
    );

    match updated {
        Ok(0) => {
            if let Err(e) = db.insert_unknown_device(
                &payload.esfera_device_id,
                adb_address,
                &ip,
                port,
                &now,
                company_id,
                &payload.adb_serial,
            ) {
                eprintln!("Check-in insert error: {}", e);
                return (StatusCode::FORBIDDEN, "empresa invalida".into());
            }
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("Check-in DB error: {}", e);
            return (StatusCode::FORBIDDEN, "empresa invalida".into());
        }
    }

    // REGISTRA a presença (kotlin) no session_manager para que o device SURJA
    // no get_live_devices (o app só marca verde os devices com sessão ativa).
    crate::session_manager::touch_presence(company_id, &payload.esfera_device_id, adb_address);

    // Devolve a porta lógica VPS atribuída (router escuta nela).
    let vps_port = db.get_assigned_vps_port(&payload.esfera_device_id).unwrap_or(0);
    if vps_port > 0 {
        crate::router::register_route(vps_port, company_id, &payload.esfera_device_id);
        crate::session_manager::set_assigned_vps_port(company_id, &payload.esfera_device_id, vps_port);
    }
    (
        StatusCode::OK,
        format!("{{\"ok\":true,\"assignedVpsPort\":{}}}", vps_port),
    )
}

pub async fn handle_rename_device(
    State((db, _port)): State<(Arc<Database>, u16)>,
    Json(payload): Json<RenameDevicePayload>,
) -> (axum::http::StatusCode, &'static str) {
    use axum::http::StatusCode;
    if payload.esfera_device_id.trim().is_empty() || payload.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "esfera_device_id ou name ausente");
    }
    match db.rename_device(payload.esfera_device_id.trim(), payload.name.trim()) {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(e) => {
            eprintln!("Erro ao renomear device no DB da VPS: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "erro no banco da vps")
        }
    }
}

/// Serve o APK do agente para atualização remota (self_update), sem SSH.
/// Caminho configurável via env AGENT_APK_PATH; default:
///   ~/esfera_v3/agent_release/esfera_agent.apk
/// O agente no celular baixa de http://<VPS>:8080/download/agent.apk e instala.
pub async fn handle_download_agent() -> axum::response::Response {
    use axum::http::{header, StatusCode};
    let default_path = dirs_home().join("esfera_v3/agent_release/esfera_agent.apk");
    let path = std::env::var("AGENT_APK_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or(default_path);
    match std::fs::read(&path) {
        Ok(bytes) => (
            [(
                header::CONTENT_TYPE,
                "application/vnd.android.package-archive",
            )],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Retorna o home do usuário (fallback para std::env::var HOME/USERPROFILE).
fn dirs_home() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        return std::path::PathBuf::from(h);
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        return std::path::PathBuf::from(h);
    }
    std::path::PathBuf::from(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_token_exige_configuracao_e_header_nao_vazios() {
        assert!(!master_token_matches("", None));
        assert!(!master_token_matches("", Some("")));
        assert!(!master_token_matches(" ", Some(" ")));
        assert!(!master_token_matches("", Some("token-de-teste")));
        assert!(!master_token_matches("errado", Some("token-de-teste")));
        assert!(master_token_matches("token-de-teste", Some("token-de-teste")));
    }

    #[tokio::test]
    async fn egress_devolve_o_ip_da_conexao() {
        let addr: SocketAddr = "203.0.113.9:45678".parse().unwrap();
        assert_eq!(handle_egress(ConnectInfo(addr)).await, "203.0.113.9");
        let v6: SocketAddr = "[2001:db8::1]:1".parse().unwrap();
        assert_eq!(handle_egress(ConnectInfo(v6)).await, "2001:db8::1");
    }

    fn db_de_teste(tag: &str) -> (Arc<Database>, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("hub_egress_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::init(path.to_string_lossy().as_ref()).expect("banco de teste");
        (Arc::new(db), path)
    }

    fn payload(device_id: i32, result: &str) -> EgressReportPayload {
        EgressReportPayload {
            device_id,
            checked_at: "2026-11-03 12:00:00".into(),
            observed_ip: "203.0.113.7".into(),
            mode: "wireguard".into(),
            phase: "fim_lote".into(),
            result: result.into(),
            detail: String::new(),
        }
    }

    /// O registro central só aceita com token e só grava veredito de rede.
    #[tokio::test]
    async fn report_exige_token_e_grava_o_veredito() {
        std::env::set_var("HUB_MASTER_TOKEN", "segredo-de-teste");
        let (db, path) = db_de_teste("report");

        let mut sem_token = axum::http::HeaderMap::new();
        sem_token.insert("X-Hub-Token", "errado".parse().unwrap());
        let (code, _) = handle_egress_report(State((db.clone(), 0u16)), sem_token, Json(payload(7, "ok"))).await;
        assert_eq!(code, axum::http::StatusCode::UNAUTHORIZED, "token errado não registra nada");

        let mut com_token = axum::http::HeaderMap::new();
        com_token.insert("X-Hub-Token", "segredo-de-teste".parse().unwrap());
        let (code, _) = handle_egress_report(State((db.clone(), 0u16)), com_token.clone(), Json(payload(7, "vazamento"))).await;
        assert_eq!(code, axum::http::StatusCode::OK);

        let (code, _) = handle_egress_report(State((db.clone(), 0u16)), com_token, Json(payload(0, "ok"))).await;
        assert_eq!(code, axum::http::StatusCode::BAD_REQUEST, "aparelho inválido é recusado");

        assert_eq!(db.egress_check_count(7, "vazamento"), 1, "só o envio autenticado e válido entrou");
        assert_eq!(db.egress_check_count(7, "ok"), 0, "o envio sem token não deixou rastro");
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
