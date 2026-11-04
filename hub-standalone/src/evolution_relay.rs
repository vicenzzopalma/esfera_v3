// Repasse de mensagens da Evolution (instância do disparo) para o Esfera desktop.
//
// A Evolution só escuta em 127.0.0.1 da VPS; o hub (no mesmo host) consulta a API dela
// e devolve as mensagens já simplificadas pelo canal HTTPS autenticado. Só leitura: nada é
// alterado na Evolution (nem o webhook, que outra automação usa).
//
// Ambiente: ESFERA_EVOLUTION_URL (ex.: http://127.0.0.1:18081), ESFERA_EVOLUTION_INSTANCE
// (ex.: disparo), ESFERA_EVOLUTION_APIKEY, ESFERA_EVOLUTION_NUMBER (número da instância) e,
// opcional, ESFERA_EVOLUTION_COMPANY_ID (empresa autorizada além do master). Sem
// URL/instância/chave a rota responde 404.
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

use crate::db::Database;

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    /// Unix (s): mensagens a partir deste instante.
    pub since: i64,
    /// Unix (s): até este instante (padrão: agora).
    pub until: Option<i64>,
    pub page: Option<u32>,
}

/// Mensagem simplificada: só o que o histórico precisa.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaMessage {
    pub id: String,
    pub ts: i64,
    pub jid: String,
    /// Número real quando a conversa está por LID (`remoteJidAlt`).
    pub alt: String,
    pub from_me: bool,
    pub push_name: String,
    pub kind: String,
    pub text: String,
}

/// Converte um registro da Evolution. Reação, edição e mensagens de protocolo ficam de fora.
pub fn simplify(r: &Value) -> Option<WaMessage> {
    let key = r.get("key")?;
    let id = key.get("id")?.as_str()?.to_string();
    let jid = key.get("remoteJid")?.as_str()?.to_string();
    if jid.ends_with("@g.us") || jid.ends_with("@broadcast") || jid.ends_with("@newsletter") {
        return None;
    }
    let kind = r.get("messageType").and_then(Value::as_str).unwrap_or("").to_string();
    if matches!(kind.as_str(), "reactionMessage" | "protocolMessage" | "editedMessage" | "senderKeyDistributionMessage" | "messageContextInfo") {
        return None;
    }
    let msg = r.get("message").cloned().unwrap_or(Value::Null);
    let s = |path: &[&str]| -> Option<String> {
        let mut v = &msg;
        for p in path { v = v.get(*p)?; }
        v.as_str().map(|t| t.to_string()).filter(|t| !t.trim().is_empty())
    };
    let text = s(&["conversation"])
        .or_else(|| s(&["extendedTextMessage", "text"]))
        .or_else(|| s(&["imageMessage", "caption"]).map(|c| format!("[imagem] {}", c)))
        .or_else(|| s(&["videoMessage", "caption"]).map(|c| format!("[vídeo] {}", c)))
        .or_else(|| s(&["documentMessage", "fileName"]).map(|c| format!("[documento] {}", c)))
        .or_else(|| s(&["documentWithCaptionMessage", "message", "documentMessage", "fileName"]).map(|c| format!("[documento] {}", c)))
        .unwrap_or_else(|| match kind.as_str() {
            "audioMessage" => "[áudio]".into(),
            "imageMessage" => "[imagem]".into(),
            "videoMessage" => "[vídeo]".into(),
            "stickerMessage" => "[figurinha]".into(),
            "documentMessage" => "[documento]".into(),
            "contactMessage" | "contactsArrayMessage" => "[contato]".into(),
            "locationMessage" => "[localização]".into(),
            other => format!("[{}]", other),
        });
    let ts = r.get("messageTimestamp").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))?;
    Some(WaMessage {
        id,
        ts,
        jid,
        alt: key.get("remoteJidAlt").and_then(Value::as_str).unwrap_or("").to_string(),
        from_me: key.get("fromMe").and_then(Value::as_bool).unwrap_or(false),
        push_name: r.get("pushName").and_then(Value::as_str).unwrap_or("").to_string(),
        kind,
        text,
    })
}

fn iso(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Só o master ou a empresa configurada leem as conversas.
pub fn allowed(role: &str, company_id: i32, allowed_company: Option<i32>) -> bool {
    role == "master" || allowed_company.map_or(false, |c| c > 0 && c == company_id)
}

pub async fn evolution_messages(
    State((db, _)): State<(Arc<Database>, u16)>,
    Query(q): Query<MessagesQuery>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let (company_id, role) = db.validate_token(token).ok_or(StatusCode::UNAUTHORIZED)?;
    let company_env = std::env::var("ESFERA_EVOLUTION_COMPANY_ID").ok().and_then(|s| s.parse::<i32>().ok());
    if !allowed(&role, company_id, company_env) {
        return Err(StatusCode::FORBIDDEN);
    }
    let read = |name| std::env::var(name).ok().filter(|s: &String| !s.trim().is_empty()).ok_or(StatusCode::NOT_FOUND);
    let base = read("ESFERA_EVOLUTION_URL")?;
    let instance = read("ESFERA_EVOLUTION_INSTANCE")?;
    let apikey = read("ESFERA_EVOLUTION_APIKEY")?;
    let until = q.until.unwrap_or_else(|| chrono::Utc::now().timestamp());
    if q.since <= 0 || until < q.since || until - q.since > 7 * 86_400 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let page = q.page.unwrap_or(1).max(1);
    let body = serde_json::json!({
        "where": { "messageTimestamp": { "gte": iso(q.since), "lte": iso(until) } },
        "page": page,
        "offset": 200,
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let resp = client.post(format!("{}/chat/findMessages/{}", base.trim_end_matches('/'), instance))
        .header("apikey", apikey)
        .json(&body)
        .send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !resp.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let data: Value = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let m = data.get("messages").unwrap_or(&Value::Null);
    let pages = m.get("pages").and_then(Value::as_u64).unwrap_or(1);
    let records = m.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
    let messages: Vec<WaMessage> = records.iter().filter_map(simplify).collect();
    // Número do WhatsApp da instância (vai no título do histórico: "de <número>").
    let owner = std::env::var("ESFERA_EVOLUTION_NUMBER").unwrap_or_default();
    Ok(([(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "page": page, "pages": pages, "owner": owner, "messages": messages }))).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplifica_texto_lid_e_midia() {
        let r = serde_json::json!({
            "key": {"id": "A1", "remoteJid": "171979701268517@lid", "remoteJidAlt": "5511991703561@s.whatsapp.net", "fromMe": false},
            "pushName": "Mel Silva", "messageType": "conversation", "message": {"conversation": "Ok"}, "messageTimestamp": 1793820852
        });
        let m = simplify(&r).unwrap();
        assert_eq!((m.alt.as_str(), m.from_me, m.text.as_str(), m.ts), ("5511991703561@s.whatsapp.net", false, "Ok", 1793820852));
        let audio = serde_json::json!({"key": {"id": "A2", "remoteJid": "5511@s.whatsapp.net", "fromMe": true}, "messageType": "audioMessage", "message": {"audioMessage": {}}, "messageTimestamp": "10"});
        assert_eq!(simplify(&audio).unwrap().text, "[áudio]");
        let foto = serde_json::json!({"key": {"id": "A3", "remoteJid": "5511@s.whatsapp.net"}, "messageType": "imageMessage", "message": {"imageMessage": {"caption": "comprovante"}}, "messageTimestamp": 10});
        assert_eq!(simplify(&foto).unwrap().text, "[imagem] comprovante");
    }

    #[test]
    fn ignora_grupo_reacao_e_registro_incompleto() {
        let grupo = serde_json::json!({"key": {"id": "G", "remoteJid": "123@g.us"}, "messageType": "conversation", "message": {"conversation": "oi"}, "messageTimestamp": 1});
        let reacao = serde_json::json!({"key": {"id": "R", "remoteJid": "5511@s.whatsapp.net"}, "messageType": "reactionMessage", "message": {}, "messageTimestamp": 1});
        assert!(simplify(&grupo).is_none());
        assert!(simplify(&reacao).is_none());
        assert!(simplify(&serde_json::json!({"messageType": "conversation"})).is_none());
    }

    #[test]
    fn so_master_ou_empresa_configurada() {
        assert!(allowed("master", 0, None));
        assert!(allowed("empresa", 1, Some(1)));
        assert!(!allowed("empresa", 2, Some(1)));
        assert!(!allowed("empresa", 1, None));
    }
}
