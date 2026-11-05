// Repasse de mensagens da Evolution (instância do disparo) para o Esfera desktop.
//
// A Evolution só escuta em 127.0.0.1 da VPS; o hub (no mesmo host) consulta a API dela
// e devolve as mensagens já simplificadas pelo canal HTTPS autenticado. Só leitura: nada é
// alterado na Evolution (nem o webhook, que outra automação usa).
//
// Ambiente: ESFERA_EVOLUTION_URL (ex.: http://127.0.0.1:18081), ESFERA_EVOLUTION_INSTANCE
// (uma ou mais, separadas por vírgula: disparo,disparo-9627; "*" = todas as instâncias da
// Evolution), ESFERA_EVOLUTION_APIKEY e, opcional, ESFERA_EVOLUTION_COMPANY_ID (empresa
// autorizada além do master). Sem URL/instância/chave a rota responde 404.
//
// Aba "Números de disparo" do Esfera (master, gestor ou a empresa configurada): lista as
// instâncias, gera o QR, cria número novo e edita quem recebe as respostas (destinos do
// repasse, guardados no painel da PA FIXA: ESFERA_PAINEL_URL + ESFERA_PAINEL_TOKEN).
// O Esfera também envia os telefones disparados (ESFERA_DEVEDORES_ARQUIVO): o robô da VPS
// só repassa respostas de quem foi disparado.
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
    /// Número do WhatsApp da instância que trocou a mensagem (quem fez o disparo).
    #[serde(default)]
    pub owner: String,
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
        owner: String::new(),
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
    let instances = read("ESFERA_EVOLUTION_INSTANCE")?;
    let apikey = read("ESFERA_EVOLUTION_APIKEY")?;
    let until = q.until.unwrap_or_else(|| chrono::Utc::now().timestamp());
    if q.since <= 0 || until < q.since || until - q.since > 7 * 86_400 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let page = q.page.unwrap_or(1).max(1);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let base = base.trim_end_matches('/').to_string();
    let list = instance_list(&client, &base, &apikey).await;
    // Com "*" sem a lista não dá para saber de onde ler: erro (o Esfera não avança o cursor).
    if instances.trim() == "*" && list.is_none() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let list = list.unwrap_or_default();
    let owners: std::collections::HashMap<String, String> = list.iter().filter_map(owner_of).collect();
    let body = serde_json::json!({
        "where": { "messageTimestamp": { "gte": iso(q.since), "lte": iso(until) } },
        "page": page,
        "offset": 200,
    });
    let mut pages = 1u64;
    let mut messages: Vec<WaMessage> = Vec::new();
    let mut first_owner = String::new();
    for instance in instance_names(&instances, &list) {
        let instance = instance.as_str();
        // Número lido da própria instância a cada consulta: se o WhatsApp for religado em outro
        // número, o histórico já sai com o número certo.
        let owner = owners.get(instance).cloned().unwrap_or_default();
        if first_owner.is_empty() { first_owner = owner.clone(); }
        let resp = client.post(format!("{}/chat/findMessages/{}", base, instance))
            .header("apikey", &apikey)
            .json(&body)
            .send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if !resp.status().is_success() {
            // Instância desconectada ou apagada não derruba as outras.
            continue;
        }
        let data: Value = resp.json().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        let m = data.get("messages").unwrap_or(&Value::Null);
        pages = pages.max(m.get("pages").and_then(Value::as_u64).unwrap_or(1));
        let records = m.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
        messages.extend(records.iter().filter_map(simplify).map(|mut w| { w.owner = owner.clone(); w }));
    }
    Ok(([(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "page": page, "pages": pages, "owner": first_owner, "messages": messages }))).into_response())
}

/// Instâncias cruas do `fetchInstances` (None se a Evolution não respondeu).
async fn instance_list(client: &reqwest::Client, base: &str, apikey: &str) -> Option<Vec<Value>> {
    let resp = client.get(format!("{}/instance/fetchInstances", base)).header("apikey", apikey).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let v = resp.json::<Value>().await.ok()?;
    v.as_array().or_else(|| v.get("instances").and_then(Value::as_array)).cloned()
}

/// Instâncias lidas: "*" = todas as da Evolution; senão a lista separada por vírgula.
pub fn instance_names(setting: &str, list: &[Value]) -> Vec<String> {
    if setting.trim() == "*" {
        return list.iter().filter_map(parse_instance).map(|i| i.name).collect();
    }
    setting.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

pub fn owner_of(i: &Value) -> Option<(String, String)> {
    let name = i.get("name").and_then(Value::as_str)?.to_string();
    let jid = i.get("ownerJid").and_then(Value::as_str).unwrap_or("");
    let num: String = jid.split('@').next().unwrap_or("").chars().filter(|c| c.is_ascii_digit()).collect();
    (!num.is_empty()).then_some((name, num))
}

// ------------------------------------------------------------------
// Números de disparo: instâncias, QR, número novo e destinos do repasse
// ------------------------------------------------------------------

const WEBHOOK_DISPARO: &str = "http://n8n:5678/webhook/disparo";

/// Instância da Evolution, só o que a tela precisa (nada de token/chave).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub name: String,
    /// Dígitos do `ownerJid` (vazio se nunca conectou).
    pub number: String,
    pub profile_name: String,
    /// open | close | connecting
    pub state: String,
    pub disconnection_code: Option<i64>,
    pub disconnection_at: Option<String>,
    pub updated_at: Option<String>,
}

fn digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Um item do `fetchInstances` (v2 direto; versões antigas dentro de "instance").
pub fn parse_instance(v: &Value) -> Option<InstanceInfo> {
    let i = v.get("instance").filter(|x| x.is_object()).unwrap_or(v);
    let text = |k: &str| i.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let name = text("name").or_else(|| text("instanceName"))?;
    let jid = text("ownerJid").or_else(|| text("owner")).unwrap_or_default();
    let state = text("connectionStatus").or_else(|| text("status")).or_else(|| text("state")).unwrap_or_default().to_lowercase();
    let state = match state.as_str() { "open" | "connecting" => state, _ => "close".to_string() };
    let code = i.get("disconnectionReasonCode")
        .and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.trim().parse().ok())));
    Some(InstanceInfo {
        name,
        number: digits(jid.split('@').next().unwrap_or("")),
        profile_name: text("profileName").unwrap_or_default(),
        state,
        disconnection_code: code,
        disconnection_at: text("disconnectionAt"),
        updated_at: text("updatedAt"),
    })
}

pub fn parse_instances(list: &[Value]) -> Vec<InstanceInfo> {
    list.iter().filter_map(parse_instance).collect()
}

/// Nome aceito pela Evolution e seguro na URL.
pub fn valid_instance_name(s: &str) -> bool {
    (1..=60).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// "47 99627-1722" -> "5547996271722". 10 ou 11 dígitos ganham o 55.
pub fn normalize_number(raw: &str) -> Option<String> {
    let d = digits(raw);
    let d = if d.len() == 10 || d.len() == 11 { format!("55{}", d) } else { d };
    ((d.len() == 12 || d.len() == 13) && d.starts_with("55") && d.as_bytes()[2] != b'0').then_some(d)
}

/// Mesmo celular com ou sem o nono dígito (o WhatsApp guarda número antigo sem o 9).
fn same_phone(a: &str, b: &str) -> bool {
    let key = |s: &str| {
        let d = digits(s);
        let d = if (d.len() == 12 || d.len() == 13) && d.starts_with("55") { d[2..].to_string() } else { d };
        if d.len() == 11 && d.as_bytes()[2] == b'9' { format!("{}{}", &d[..2], &d[3..]) } else { d }
    };
    let (ka, kb) = (key(a), key(b));
    !ka.is_empty() && ka == kb
}

/// Apelido em minúsculas sem acento: "Cobrança Ana" -> "cobranca-ana".
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() { out.push(c) } else if !out.ends_with('-') { out.push('-') }
    }
    out.trim_matches('-').chars().take(40).collect::<String>().trim_end_matches('-').to_string()
}

/// Nome da instância nova: "disparo-<apelido>" ou "disparo-<4 últimos dígitos>"; se já
/// existir, ganha "-2", "-3"...
pub fn new_instance_name(number: &str, apelido: Option<&str>, existing: &[String]) -> String {
    let apelido = apelido.map(slug).filter(|s| !s.is_empty());
    let base = format!("disparo-{}", apelido.unwrap_or_else(|| number[number.len().saturating_sub(4)..].to_string()));
    let taken = |n: &str| existing.iter().any(|e| e.eq_ignore_ascii_case(n));
    if !taken(&base) { return base; }
    (2..).map(|i| format!("{}-{}", base, i)).find(|n| !taken(n)).unwrap_or(base)
}

/// Corpo do /instance/create: Baileys, sem QR na criação e webhook do disparo no n8n.
pub fn create_body(name: &str, number: &str) -> Value {
    serde_json::json!({
        "instanceName": name,
        "integration": "WHATSAPP-BAILEYS",
        "qrcode": false,
        "number": number,
        "webhook": {
            "enabled": true,
            "url": WEBHOOK_DISPARO,
            "byEvents": false,
            "base64": false,
            "events": ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
        },
    })
}

/// Resposta do /instance/connect: já conectado, ou o QR (data URL) e o código de pareamento.
pub fn parse_connect(v: &Value) -> Value {
    let state = v.pointer("/instance/state").or_else(|| v.get("state")).and_then(Value::as_str).unwrap_or("");
    if state.eq_ignore_ascii_case("open") {
        return serde_json::json!({ "conectado": true });
    }
    let s = |a: &str, b: &str| v.get(a).or_else(|| v.pointer(b)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let qr = s("base64", "/qrcode/base64")
        .map(|b| if b.starts_with("data:image") { b.to_string() } else { format!("data:image/png;base64,{}", b) });
    serde_json::json!({ "conectado": false, "qr": qr, "pairingCode": s("pairingCode", "/qrcode/pairingCode") })
}

/// Texto de erro da Evolution ({"response":{"message":[...]}} ou {"message": ...}).
pub fn evolution_error_text(v: &Value) -> String {
    fn flat(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| flat(x, out)),
            Value::Null => {}
            other => out.push(other.to_string()),
        }
    }
    let mut out = Vec::new();
    if let Some(m) = v.pointer("/response/message").or_else(|| v.get("message")).or_else(|| v.get("error")) {
        flat(m, &mut out);
    }
    out.join("; ")
}

/// Destinos do repasse dentro do /api/operacao do painel (grupo "disparo").
pub fn repasse_of(v: &Value) -> Value {
    v.get("grupos").and_then(Value::as_array)
        .and_then(|g| g.iter().find(|x| x.get("id").and_then(Value::as_str) == Some("disparo")))
        .and_then(|g| g.get("repasse")).filter(|r| r.is_object()).cloned()
        .unwrap_or_else(|| serde_json::json!({ "destinos": [], "padrao": null }))
}

/// Gestão dos números: master, gestor ou a empresa configurada.
pub fn manage_allowed(role: &str, company_id: i32, allowed_company: Option<i32>) -> bool {
    role == "gestor" || allowed(role, company_id, allowed_company)
}

fn reply(code: StatusCode, v: Value) -> Response {
    (code, [(axum::http::header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}

fn fail(code: StatusCode, msg: impl Into<String>) -> Response {
    reply(code, serde_json::json!({ "erro": msg.into() }))
}

fn authorize_manage(db: &Database, headers: &HeaderMap) -> Result<(), Response> {
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Token do hub ausente."))?;
    let (company_id, role) = db.validate_token(token).ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Token do hub inválido."))?;
    let company_env = std::env::var("ESFERA_EVOLUTION_COMPANY_ID").ok().and_then(|s| s.parse::<i32>().ok());
    if !manage_allowed(&role, company_id, company_env) {
        return Err(fail(StatusCode::FORBIDDEN, "Sem permissão para os números de disparo."));
    }
    Ok(())
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// URL e chave da Evolution do disparo (sem elas: 404).
fn evolution_env() -> Result<(String, String), Response> {
    match (env_value("ESFERA_EVOLUTION_URL"), env_value("ESFERA_EVOLUTION_APIKEY")) {
        (Some(u), Some(k)) => Ok((u.trim_end_matches('/').to_string(), k)),
        _ => Err(fail(StatusCode::NOT_FOUND, "Evolution do disparo não configurada no hub.")),
    }
}

fn http_client(secs: u64) -> Result<reqwest::Client, Response> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(secs))
        .build().map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Falha ao preparar o cliente HTTP do hub."))
}

/// Chama a Evolution e devolve (código, JSON). Sem resposta: 502.
async fn evolution_call(client: &reqwest::Client, method: reqwest::Method, url: String, apikey: &str, body: Option<Value>) -> Result<(StatusCode, Value), Response> {
    let mut req = client.request(method, url).header("apikey", apikey);
    if let Some(b) = body { req = req.json(&b); }
    let resp = req.send().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "A Evolution do disparo não respondeu."))?;
    let status = resp.status();
    Ok((status, resp.json::<Value>().await.unwrap_or(Value::Null)))
}

async fn fetch_instances(client: &reqwest::Client, base: &str, apikey: &str) -> Result<Vec<Value>, Response> {
    let (status, v) = evolution_call(client, reqwest::Method::GET, format!("{}/instance/fetchInstances", base), apikey, None).await?;
    if !status.is_success() {
        return Err(fail(StatusCode::BAD_GATEWAY, format!("A Evolution recusou listar as instâncias (HTTP {}).", status.as_u16())));
    }
    Ok(v.as_array().or_else(|| v.get("instances").and_then(Value::as_array)).cloned().unwrap_or_default())
}

/// GET /api/desktop/evolution/instances — todas as instâncias do servidor de disparo.
pub async fn evolution_instances(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let (base, apikey) = evolution_env()?;
    let client = http_client(20)?;
    let list = fetch_instances(&client, &base, &apikey).await?;
    Ok(reply(StatusCode::OK, serde_json::json!({ "instances": parse_instances(&list) })))
}

#[derive(Debug, Deserialize)]
pub struct QrBody {
    #[serde(default)]
    pub instancia: String,
}

/// POST /api/desktop/evolution/qr {"instancia"} — QR para conectar (ou {"conectado":true}).
pub async fn evolution_qr(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<QrBody>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let name = b.instancia.trim();
    if !valid_instance_name(name) {
        return Err(fail(StatusCode::BAD_REQUEST, "Nome de instância inválido."));
    }
    let (base, apikey) = evolution_env()?;
    let client = http_client(25)?;
    let (status, data) = evolution_call(&client, reqwest::Method::GET, format!("{}/instance/connect/{}", base, name), &apikey, None).await?;
    if !status.is_success() {
        let msg = evolution_error_text(&data);
        let low = msg.to_lowercase();
        if low.contains("already") || low.contains("open") {
            return Ok(reply(StatusCode::OK, serde_json::json!({ "conectado": true })));
        }
        if status == StatusCode::NOT_FOUND || low.contains("does not exist") {
            return Err(fail(StatusCode::NOT_FOUND, format!("A instância {} não existe na Evolution.", name)));
        }
        return Err(fail(StatusCode::BAD_GATEWAY, format!("A Evolution recusou gerar o QR (HTTP {}){}", status.as_u16(),
            if msg.is_empty() { ".".to_string() } else { format!(": {}", msg) })));
    }
    Ok(reply(StatusCode::OK, parse_connect(&data)))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    #[serde(default)]
    pub numero: String,
    #[serde(default)]
    pub nome: Option<String>,
}

/// POST /api/desktop/evolution/instances {"numero","nome"?} — instância nova do disparo.
pub async fn evolution_create(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<CreateBody>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let numero = normalize_number(&b.numero)
        .ok_or_else(|| fail(StatusCode::BAD_REQUEST, "Número inválido: informe DDD + número (ex.: 47 99999-8888)."))?;
    let (base, apikey) = evolution_env()?;
    let client = http_client(30)?;
    let infos = parse_instances(&fetch_instances(&client, &base, &apikey).await?);
    // Número que já tem instância: reconecta pelo QR dela, sem criar outra.
    if let Some(i) = infos.iter().find(|i| same_phone(&i.number, &numero)) {
        return Err(fail(StatusCode::CONFLICT, format!("Esse número já está na instância {}: use \"Conectar (QR)\" nela.", i.name)));
    }
    let names: Vec<String> = infos.iter().map(|i| i.name.clone()).collect();
    let nome = new_instance_name(&numero, b.nome.as_deref(), &names);
    let (status, data) = evolution_call(&client, reqwest::Method::POST, format!("{}/instance/create", base), &apikey, Some(create_body(&nome, &numero))).await?;
    if !status.is_success() {
        let msg = evolution_error_text(&data);
        let code = if status.is_client_error() { StatusCode::BAD_REQUEST } else { StatusCode::BAD_GATEWAY };
        return Err(fail(code, format!("A Evolution não criou a instância (HTTP {}){}", status.as_u16(),
            if msg.is_empty() { ".".to_string() } else { format!(": {}", msg) })));
    }
    // A resposta da Evolution traz a chave da instância ("hash"): não sai do hub.
    Ok(reply(StatusCode::OK, serde_json::json!({ "ok": true, "instancia": nome, "numero": numero })))
}

/// Chama a API do painel com o cookie do token. Erro do painel volta com o código e o "erro" dele.
async fn painel_call(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, Response> {
    let (Some(base), Some(token)) = (env_value("ESFERA_PAINEL_URL"), env_value("ESFERA_PAINEL_TOKEN")) else {
        return Err(fail(StatusCode::NOT_FOUND, "Painel do repasse não configurado no hub."));
    };
    let client = http_client(45)?;
    let mut req = client.request(method, format!("{}{}", base.trim_end_matches('/'), path))
        .header(reqwest::header::COOKIE, format!("painel_token={}", token));
    if let Some(b) = body { req = req.json(&b); }
    let resp = req.send().await.map_err(|_| fail(StatusCode::BAD_GATEWAY, "O painel do repasse não respondeu."))?;
    let status = resp.status();
    let data = resp.json::<Value>().await.unwrap_or(Value::Null);
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        // 401 do painel é configuração do hub, não sessão do usuário.
        return Err(fail(StatusCode::BAD_GATEWAY, "O painel do repasse recusou o acesso do hub (confira ESFERA_PAINEL_TOKEN)."));
    }
    if !status.is_success() {
        let msg = data.get("erro").and_then(Value::as_str).unwrap_or("O painel do repasse recusou a operação.").to_string();
        return Err(fail(status, msg));
    }
    Ok(data)
}

/// GET /api/desktop/repasse/destinos — {"destinos":[...], "padrao": {...}|null}.
pub async fn repasse_destinos(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let data = painel_call(reqwest::Method::GET, "/api/operacao", None).await?;
    Ok(reply(StatusCode::OK, repasse_of(&data)))
}

#[derive(Debug, Deserialize)]
pub struct DestinoBody {
    #[serde(default)]
    pub numero: String,
    #[serde(default)]
    pub nome: Option<String>,
}

/// POST /api/desktop/repasse/destinos {"numero","nome"} — inclui um destino.
pub async fn repasse_add(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<DestinoBody>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let body = serde_json::json!({ "numero": b.numero.trim(), "nome": b.nome.unwrap_or_default().trim() });
    let data = painel_call(reqwest::Method::POST, "/api/operacao/destinos", Some(body)).await?;
    Ok(reply(StatusCode::OK, data))
}

// ------------------------------------------------------------------
// Devedores disparados: o robô da VPS só repassa respostas destes telefones
// ------------------------------------------------------------------

pub const MAX_DEVEDORES: usize = 50_000;

/// Só dígitos, 10 a 13; ordenados e sem repetição. Item fora do padrão fica de fora.
/// Devolve (telefones, ignorados).
pub fn normalize_devedores(list: &[Value]) -> (Vec<String>, usize) {
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    let mut ignorados = 0;
    for v in list {
        let s = match v {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) if n.is_u64() => n.to_string(),
            _ => String::new(),
        };
        if (10..=13).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) { out.push(s) } else { ignorados += 1 }
    }
    out.sort_unstable();
    out.dedup();
    (out, ignorados)
}

/// Conteúdo do arquivo lido pelo robô.
pub fn devedores_json(atualizado_em: i64, telefones: &[String]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "atualizado_em": atualizado_em, "telefones": telefones })).unwrap_or_default()
}

/// Grava sem deixar o arquivo pela metade: temporário na mesma pasta + rename.
pub fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("devedores.json");
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".{}.{}-{}.tmp", file_name, std::process::id(), nanos));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result
}

#[derive(Debug, Deserialize)]
pub struct DevedoresBody {
    #[serde(default)]
    pub telefones: Vec<Value>,
}

/// POST /api/desktop/evolution/devedores {"telefones":[...]} — grava a lista em ESFERA_DEVEDORES_ARQUIVO.
pub async fn evolution_devedores(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<DevedoresBody>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let path = env_value("ESFERA_DEVEDORES_ARQUIVO")
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Arquivo de devedores não configurado no hub."))?;
    if b.telefones.len() > MAX_DEVEDORES {
        return Err(fail(StatusCode::BAD_REQUEST, format!("No máximo {} telefones por envio.", MAX_DEVEDORES)));
    }
    let (telefones, ignorados) = normalize_devedores(&b.telefones);
    let total = telefones.len();
    let data = devedores_json(chrono::Utc::now().timestamp(), &telefones);
    tokio::task::spawn_blocking(move || write_atomic(std::path::Path::new(&path), &data)).await
        .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Falha ao gravar a lista de devedores."))?
        .map_err(|e| fail(StatusCode::INTERNAL_SERVER_ERROR, format!("Falha ao gravar a lista de devedores: {}", e)))?;
    Ok(reply(StatusCode::OK, serde_json::json!({ "ok": true, "total": total, "ignorados": ignorados })))
}

/// POST /api/desktop/repasse/destinos/remover {"numero"} — tira um destino (o painel mantém ao menos 1).
pub async fn repasse_remove(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<DestinoBody>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let data = painel_call(reqwest::Method::POST, "/api/operacao/destinos/remover", Some(serde_json::json!({ "numero": b.numero.trim() }))).await?;
    Ok(reply(StatusCode::OK, data))
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
    fn numero_da_instancia_vem_do_owner_jid() {
        let i = serde_json::json!({"name": "disparo", "ownerJid": "554796834632@s.whatsapp.net"});
        assert_eq!(owner_of(&i), Some(("disparo".into(), "554796834632".into())));
        assert_eq!(owner_of(&serde_json::json!({"name": "nova", "ownerJid": null})), None);
    }

    #[test]
    fn so_master_ou_empresa_configurada() {
        assert!(allowed("master", 0, None));
        assert!(allowed("empresa", 1, Some(1)));
        assert!(!allowed("empresa", 2, Some(1)));
        assert!(!allowed("empresa", 1, None));
    }

    #[test]
    fn gestao_aceita_gestor_alem_de_master_e_empresa() {
        assert!(manage_allowed("gestor", 5, None));
        assert!(manage_allowed("master", 0, None));
        assert!(manage_allowed("empresa", 1, Some(1)));
        assert!(!manage_allowed("empresa", 2, Some(1)));
        assert!(!manage_allowed("colaborador", 1, None));
    }

    #[test]
    fn normaliza_numero_com_ddi() {
        assert_eq!(normalize_number("47 99627-1722").as_deref(), Some("5547996271722"));
        assert_eq!(normalize_number("(47) 9683-4632").as_deref(), Some("554796834632"));
        assert_eq!(normalize_number("+55 47 99627-1722").as_deref(), Some("5547996271722"));
        assert_eq!(normalize_number("99627-1722"), None);
        assert_eq!(normalize_number("07 99627-1722"), None);
        assert_eq!(normalize_number("1234"), None);
        assert_eq!(normalize_number("44 47 99627-1722"), None);
    }

    #[test]
    fn nome_da_instancia_nova() {
        assert_eq!(new_instance_name("5547996271722", None, &[]), "disparo-1722");
        let ja = vec!["disparo-1722".to_string(), "DISPARO-1722-2".to_string()];
        assert_eq!(new_instance_name("5547996271722", None, &ja), "disparo-1722-3");
        assert_eq!(new_instance_name("5547996271722", Some("  "), &[]), "disparo-1722");
        assert_eq!(new_instance_name("5547996271722", Some("Cobrança Ana!"), &[]), "disparo-cobranca-ana");
        assert!(valid_instance_name(&new_instance_name("5547996271722", Some(&"x".repeat(80)), &[])));
    }

    #[test]
    fn valida_nome_da_instancia() {
        assert!(valid_instance_name("disparo-9627"));
        assert!(valid_instance_name("a.b_C-1"));
        assert!(!valid_instance_name(""));
        assert!(!valid_instance_name("../x"));
        assert!(!valid_instance_name("disparo 1"));
        assert!(!valid_instance_name("disparo?x=1"));
        assert!(!valid_instance_name(&"a".repeat(61)));
    }

    #[test]
    fn le_o_fetch_instances() {
        let list = serde_json::json!([
            {"name": "disparo", "connectionStatus": "close", "ownerJid": "554796834632@s.whatsapp.net", "profileName": "Realess",
             "token": "segredo", "disconnectionReasonCode": 403, "disconnectionAt": "2026-11-04T12:00:00.000Z", "updatedAt": "2026-11-04T12:00:01.000Z"},
            {"name": "disparo-9627", "connectionStatus": "open", "ownerJid": "554796271722@s.whatsapp.net", "profileName": null,
             "disconnectionReasonCode": "401"},
            {"instance": {"instanceName": "antiga", "status": "connecting"}},
            {"connectionStatus": "open"}
        ]);
        let v = parse_instances(list.as_array().unwrap());
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], InstanceInfo {
            name: "disparo".into(), number: "554796834632".into(), profile_name: "Realess".into(), state: "close".into(),
            disconnection_code: Some(403), disconnection_at: Some("2026-11-04T12:00:00.000Z".into()), updated_at: Some("2026-11-04T12:00:01.000Z".into()),
        });
        assert_eq!((v[1].state.as_str(), v[1].profile_name.as_str(), v[1].disconnection_code), ("open", "", Some(401)));
        assert_eq!((v[2].name.as_str(), v[2].state.as_str(), v[2].number.as_str()), ("antiga", "connecting", ""));
        // A chave da instância nunca sai.
        assert!(!serde_json::to_string(&v).unwrap().contains("segredo"));
    }

    #[test]
    fn todas_as_instancias_com_asterisco() {
        let list = vec![serde_json::json!({"name": "disparo"}), serde_json::json!({"name": "disparo-9627"})];
        assert_eq!(instance_names("*", &list), vec!["disparo", "disparo-9627"]);
        assert_eq!(instance_names(" disparo , disparo-9627,", &list), vec!["disparo", "disparo-9627"]);
        assert_eq!(instance_names("disparo", &[]), vec!["disparo"]);
        assert!(instance_names("*", &[]).is_empty());
    }

    #[test]
    fn resposta_do_connect() {
        assert_eq!(parse_connect(&serde_json::json!({"instance": {"instanceName": "x", "state": "open"}})), serde_json::json!({"conectado": true}));
        let qr = parse_connect(&serde_json::json!({"pairingCode": "ABCD1234", "code": "2@x", "base64": "data:image/png;base64,AAA", "count": 1}));
        assert_eq!(qr, serde_json::json!({"conectado": false, "qr": "data:image/png;base64,AAA", "pairingCode": "ABCD1234"}));
        let cru = parse_connect(&serde_json::json!({"qrcode": {"base64": "BBB"}}));
        assert_eq!(cru["qr"], "data:image/png;base64,BBB");
        assert_eq!(parse_connect(&serde_json::json!({"count": 0})), serde_json::json!({"conectado": false, "qr": null, "pairingCode": null}));
    }

    #[test]
    fn corpo_da_criacao_com_webhook_do_disparo() {
        let b = create_body("disparo-1722", "5547996271722");
        assert_eq!(b["integration"], "WHATSAPP-BAILEYS");
        assert_eq!(b["qrcode"], false);
        assert_eq!(b["number"], "5547996271722");
        assert_eq!(b["webhook"]["url"], "http://n8n:5678/webhook/disparo");
        assert_eq!(b["webhook"]["events"], serde_json::json!(["MESSAGES_UPSERT", "CONNECTION_UPDATE"]));
    }

    #[test]
    fn mesmo_celular_com_e_sem_nono_digito() {
        assert!(same_phone("554796834632", "5547996834632"));
        assert!(!same_phone("554796834632", "5547996271722"));
        assert!(!same_phone("", "5547996271722"));
    }

    #[test]
    fn devedores_so_digitos_ordenados_sem_repeticao() {
        let entrada = serde_json::json!(["5547999998888", " 5511991703561 ", "5547999998888", "47 99999-8888", "123", "55479999988881", 4733054406u64, null, "abcdefghij"]);
        let (tel, ign) = normalize_devedores(entrada.as_array().unwrap());
        assert_eq!(tel, vec!["4733054406", "5511991703561", "5547999998888"]);
        assert_eq!(ign, 5);
        let json: Value = serde_json::from_slice(&devedores_json(1793820852, &tel)).unwrap();
        assert_eq!(json, serde_json::json!({"atualizado_em": 1793820852, "telefones": ["4733054406", "5511991703561", "5547999998888"]}));
    }

    #[test]
    fn grava_devedores_trocando_o_arquivo_inteiro() {
        let dir = std::env::temp_dir().join(format!("esfera-devedores-teste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let alvo = dir.join("devedores.json");
        write_atomic(&alvo, b"{\"v\":1}").unwrap();
        write_atomic(&alvo, b"{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&alvo).unwrap(), "{\"v\":2}");
        // Nenhum temporário sobra na pasta.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn erro_e_repasse_do_painel() {
        let e = serde_json::json!({"status": 403, "error": "Forbidden", "response": {"message": ["This name \"disparo\" is already in use."]}});
        assert_eq!(evolution_error_text(&e), "This name \"disparo\" is already in use.");
        assert_eq!(evolution_error_text(&serde_json::json!({})), "");
        let op = serde_json::json!({"grupos": [{"id": "pafixa"}, {"id": "disparo", "repasse": {"destinos": [{"numero": "554733054406"}], "padrao": null}}]});
        assert_eq!(repasse_of(&op)["destinos"][0]["numero"], "554733054406");
        assert_eq!(repasse_of(&serde_json::json!({})), serde_json::json!({"destinos": [], "padrao": null}));
    }
}
