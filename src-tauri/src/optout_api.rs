// ============================================================
// Esfera v3 — API de Descadastro Central (optout_api.rs)
// Recebe pedidos "SAIR" de sistemas externos (VEXOR) por HTTP, autenticados pelo token de
// empresa (ESF_CompanyToken), grava de forma durável em ESF_OptOutEvent + ESF_OptOut e
// suprime o número em todas as campanhas da empresa. O ACK só sai depois do COMMIT.
//
// Montado no servidor de check-in (porta configurável, padrão 8080):
//   POST /api/optout/events  -> grava 1 evento (idempotente pelo eventId)
//   GET  /api/optout/status  -> confere token/empresa sem gravar nada
// ============================================================

use crate::db::Database;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptOutEventPayload {
    /// Identificador estável do evento no remetente (ex.: "whatsapp:<conexão>:<id do provedor>").
    pub event_id: String,
    /// Empresa do Esfera alvo. Precisa bater com o token (salvo token master).
    pub company_id: i32,
    /// Número real em E.164 ("+5575988052539") ou só dígitos.
    pub phone: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub classification: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub received_at: String,
}

type ApiError = (StatusCode, Json<Value>);

fn error(status: StatusCode, code: &str, detail: Option<String>) -> ApiError {
    let mut body = json!({ "error": code });
    if let Some(d) = detail {
        body["detail"] = Value::String(d);
    }
    (status, Json(body))
}

/// Extrai o bearer token sem nunca registrá-lo em log.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?.trim();
    let token = raw.strip_prefix("Bearer ").or_else(|| raw.strip_prefix("bearer "))?.trim();
    if token.is_empty() || token.len() > 512 {
        return None;
    }
    Some(token.to_string())
}

/// Resolve e valida a empresa autorizada pelo token: token de empresa só fala pela própria
/// empresa; token master (CompanyId 0) pode falar por qualquer empresa existente.
async fn authorize(db: &Arc<Database>, headers: &HeaderMap, requested_company: i32) -> Result<i32, ApiError> {
    let token = bearer_token(headers).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized", None))?;
    let db2 = db.clone();
    let validated = tokio::task::spawn_blocking(move || db2.validate_token(&token))
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failure", None))?;
    let (token_company, role) = validated.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized", None))?;
    if requested_company <= 0 {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_payload", Some("companyId deve ser > 0".into())));
    }
    let is_master = token_company == 0 && role == "master";
    if !is_master && token_company != requested_company {
        return Err(error(StatusCode::FORBIDDEN, "company_mismatch", None));
    }
    let db3 = db.clone();
    let exists = tokio::task::spawn_blocking(move || db3.company_exists(requested_company))
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failure", None))?;
    if !exists {
        return Err(error(StatusCode::FORBIDDEN, "company_mismatch", None));
    }
    Ok(requested_company)
}

fn valid_event_id(id: &str) -> bool {
    (8..=200).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '-'))
}

fn valid_phone(phone: &str) -> bool {
    let p = phone.trim();
    let digits = p.strip_prefix('+').unwrap_or(p);
    (8..=15).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_digit()) && !digits.starts_with('0')
}

/// Mascara o número para log: só os 4 últimos dígitos.
fn masked(phone_key: &str) -> String {
    let n = phone_key.len();
    if n <= 4 { "****".to_string() } else { format!("{}{}", "*".repeat(n - 4), &phone_key[n - 4..]) }
}

async fn handle_event(
    State(db): State<Arc<Database>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.len() > 16 * 1024 {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_payload", Some("corpo acima de 16 KB".into())));
    }
    let payload: OptOutEventPayload = serde_json::from_slice(&body)
        .map_err(|e| error(StatusCode::BAD_REQUEST, "invalid_payload", Some(e.to_string())))?;
    let company_id = authorize(&db, &headers, payload.company_id).await?;
    if !valid_event_id(&payload.event_id) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_payload", Some("eventId inválido".into())));
    }
    if !valid_phone(&payload.phone) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_payload", Some("phone deve ser E.164".into())));
    }
    let source = if payload.source.trim().is_empty() { "api".to_string() } else { payload.source.chars().take(40).collect() };
    let reason: String = if payload.reason.trim().is_empty() {
        format!("Descadastro recebido via {}", source)
    } else {
        payload.reason.chars().take(160).collect()
    };
    let received_at: String = payload.received_at.chars().take(40).collect();
    let event_id = payload.event_id.clone();
    let phone = payload.phone.trim().to_string();
    let db2 = db.clone();
    let (eid, src) = (event_id.clone(), source.clone());
    let outcome = tokio::task::spawn_blocking(move || db2.record_opt_out_event(&eid, company_id, &phone, &src, &reason, &received_at))
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failure", None))?
        .map_err(|e| {
            if e.contains("inválido") {
                error(StatusCode::BAD_REQUEST, "invalid_payload", Some(e))
            } else {
                eprintln!("[DESCADASTRO API] Falha ao gravar evento: {}", e);
                error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failure", None)
            }
        })?;
    if outcome.status == "duplicate" && !outcome.same_company {
        // Mesmo EventId reaproveitado por outra empresa: nunca confirma como gravado.
        return Err(error(StatusCode::CONFLICT, "event_id_conflict", None));
    }
    if outcome.status == "recorded" {
        println!(
            "[DESCADASTRO API] Empresa {} · número {} descadastrado via {} ({} envio(s) pendente(s) cancelado(s)).",
            company_id, masked(&outcome.phone_key), source, outcome.suppressed
        );
    }
    Ok((
        StatusCode::OK,
        Json(json!({
            "ack": true,
            "eventId": event_id,
            "status": outcome.status,
            "companyId": company_id,
            "phoneKey": outcome.phone_key,
            "suppressedContacts": outcome.suppressed,
        })),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    #[serde(default)]
    company_id: Option<i32>,
}

async fn handle_status(
    State(db): State<Arc<Database>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    let token = bearer_token(&headers).ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized", None))?;
    let db2 = db.clone();
    let validated = tokio::task::spawn_blocking(move || db2.validate_token(&token))
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "storage_failure", None))?;
    let (token_company, role) = validated.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "unauthorized", None))?;
    let requested = q.company_id.unwrap_or(token_company);
    let company_id = if requested > 0 { authorize(&db, &headers, requested).await? } else { token_company };
    Ok(Json(json!({ "ok": true, "companyId": company_id, "role": role, "endpoint": "/api/optout/events" })))
}

pub fn router(db: Arc<Database>) -> Router {
    Router::new()
        .route("/api/optout/events", post(handle_event))
        .route("/api/optout/status", get(handle_status))
        .with_state(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Campaign;
    use std::net::SocketAddr;

    fn temp_db(tag: &str) -> Arc<Database> {
        let path = std::env::temp_dir().join(format!("esfera_optout_api_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        Arc::new(Database::init(path.to_string_lossy().as_ref()).expect("db"))
    }

    fn campaign(company_id: i32, name: &str) -> Campaign {
        Campaign {
            id: 0,
            name: name.to_string(),
            greeting: "Olá {nome}".into(),
            message: "Mensagem".into(),
            closing: "Para deixar de receber mensagens por este canal, responda SAIR.".into(),
            delay_min: 10,
            delay_max: 20,
            use_spintax: false,
            use_ai: false,
            ai_model: String::new(),
            ai_provider: String::new(),
            ai_prompt: String::new(),
            device_ids: vec![],
            status: "draft".into(),
            contacts_count: 0,
            sent_count: 0,
            failed_count: 0,
            company_id,
            updated_at: String::new(),
        }
    }

    async fn serve(db: Arc<Database>) -> String {
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router(db)).await.unwrap();
        });
        format!("http://{}", addr)
    }

    fn payload(event_id: &str, company_id: i32, phone: &str) -> Value {
        json!({
            "eventId": event_id,
            "companyId": company_id,
            "phone": phone,
            "source": "vexor",
            "channel": "whatsapp",
            "classification": "OPT_OUT",
            "reason": "Respondeu \"SAIR\" no WhatsApp (VEXOR)",
            "connectionId": "conn-1",
            "receivedAt": "2026-10-27T12:00:00.000Z"
        })
    }

    #[tokio::test]
    async fn grava_descadastro_deduplica_e_isola_empresas() {
        let db = temp_db("flow");
        let other = db.create_company("Outra Empresa", 10).unwrap();
        let token1 = db.issue_hub_token(1, "empresa").unwrap();
        let token2 = db.issue_hub_token(other.id, "empresa").unwrap();
        // Duas campanhas da empresa 1 e uma da empresa 2 com o mesmo número.
        let c1 = db.create_campaign(&campaign(1, "A")).unwrap();
        let c2 = db.create_campaign(&campaign(1, "B")).unwrap();
        let c3 = db.create_campaign(&campaign(other.id, "C")).unwrap();
        for c in [c1, c2, c3] {
            db.import_contacts(c, vec![("Fulano".into(), "5575988052539".into()), ("Beltrano".into(), "5575911112222".into())]).unwrap();
        }
        let base = serve(db.clone()).await;
        let client = reqwest::Client::new();

        // Sem token -> 401; token da empresa 2 falando pela empresa 1 -> 403.
        let r = client.post(format!("{}/api/optout/events", base)).json(&payload("whatsapp:conn-1:evt-1", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token2).json(&payload("whatsapp:conn-1:evt-1", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 403);
        assert!(!db.is_opted_out(1, "5575988052539"));

        // Gravação durável + supressão em todas as campanhas da empresa 1.
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token1).json(&payload("whatsapp:conn-1:evt-1", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["ack"], true);
        assert_eq!(body["status"], "recorded");
        assert_eq!(body["eventId"], "whatsapp:conn-1:evt-1");
        assert_eq!(body["suppressedContacts"], 2);
        assert!(db.is_opted_out(1, "+55 75 98805-2539"));
        assert!(!db.is_opted_out(other.id, "5575988052539"), "empresa 2 não pode ser afetada");
        for c in [c1, c2] {
            let st: Vec<(String, String)> = db.get_contacts(c).into_iter().map(|x| (x.phone, x.status)).collect();
            assert!(st.contains(&("5575988052539".into(), "opt_out".into())), "campanha {} deve suprimir", c);
            assert!(st.contains(&("5575911112222".into(), "pending".into())));
        }
        assert!(db.get_contacts(c3).iter().all(|x| x.status == "pending"));

        // Retry do mesmo evento -> duplicate, sem alterar nada.
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token1).json(&payload("whatsapp:conn-1:evt-1", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["status"], "duplicate");
        assert_eq!(db.list_opt_out_events(1, 50).len(), 1);

        // Mesmo eventId reaproveitado pela outra empresa -> conflito, sem gravar.
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token2).json(&payload("whatsapp:conn-1:evt-1", other.id, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 409);
        assert!(!db.is_opted_out(other.id, "5575988052539"));

        // Reimportação da campanha 1 traz o número de volta -> continua suprimido.
        db.import_contacts(c1, vec![("Fulano".into(), "(75) 98805-2539".into()), ("Novo".into(), "5575933334444".into())]).unwrap();
        let st: Vec<(String, String)> = db.get_contacts(c1).into_iter().map(|x| (x.phone, x.status)).collect();
        assert!(st.contains(&("(75) 98805-2539".into(), "opt_out".into())));
        assert!(st.contains(&("5575933334444".into(), "pending".into())));
        // Reiniciar a fila também não desfaz o descadastro.
        db.reset_campaign_contacts(c1).unwrap();
        assert!(db.get_contacts(c1).iter().any(|x| x.phone == "(75) 98805-2539" && x.status == "opt_out"));

        // Payload inválido -> 400 (permanente no remetente); número sem DDI também entra.
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token1).json(&payload("x", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token1).json(&payload("whatsapp:conn-1:evt-2", 1, "abc")).send().await.unwrap();
        assert_eq!(r.status(), 400);
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&token1).json(&payload("manual:org:evt-3", 1, "75911112222")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(db.is_opted_out(1, "5575911112222"));

        // Status confere token sem gravar.
        let r = client.get(format!("{}/api/optout/status", base)).bearer_auth(&token1).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["companyId"], 1);
        let r = client.get(format!("{}/api/optout/status?companyId=1", base)).bearer_auth(&token2).send().await.unwrap();
        assert_eq!(r.status(), 403);
    }

    #[tokio::test]
    async fn token_master_fala_por_qualquer_empresa_existente() {
        let db = temp_db("master");
        let master = db.issue_hub_token(0, "master").unwrap();
        let base = serve(db.clone()).await;
        let client = reqwest::Client::new();
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&master).json(&payload("whatsapp:c:evt-master-1", 1, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(db.is_opted_out(1, "5575988052539"));
        let r = client.post(format!("{}/api/optout/events", base)).bearer_auth(&master).json(&payload("whatsapp:c:evt-master-2", 999, "+5575988052539")).send().await.unwrap();
        assert_eq!(r.status(), 403, "empresa inexistente nunca é criada implicitamente");
    }
}
