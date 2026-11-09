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
/// Ausência ou formato inválido não significa que a lista de destinos esteja vazia.
pub fn repasse_of(v: &Value) -> Option<Value> {
    v.get("grupos").and_then(Value::as_array)
        .and_then(|g| g.iter().find(|x| x.get("id").and_then(Value::as_str) == Some("disparo")))
        .and_then(|g| g.get("repasse")).filter(|r| r.get("destinos").and_then(Value::as_array).is_some()).cloned()
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

fn authorize_manage(db: &Database, headers: &HeaderMap) -> Result<(i32, String), Response> {
    let token = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Token do hub ausente."))?;
    let (company_id, role) = db.validate_token(token).ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "Token do hub inválido."))?;
    let company_env = std::env::var("ESFERA_EVOLUTION_COMPANY_ID").ok().and_then(|s| s.parse::<i32>().ok());
    if !manage_allowed(&role, company_id, company_env) {
        return Err(fail(StatusCode::FORBIDDEN, "Sem permissão para os números de disparo."));
    }
    Ok((company_id, role))
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
    painel_request(method, path, body, 45, "do repasse", &[]).await.map_err(|e| e.response())
}

/// Erro de uma chamada ao painel: código para o desktop, texto em português e se o painel nem respondeu.
#[derive(Debug, Clone, PartialEq)]
pub struct PainelErro {
    pub code: StatusCode,
    pub msg: String,
    pub sem_resposta: bool,
}

impl PainelErro {
    fn response(self) -> Response { fail(self.code, self.msg) }
}

/// Chama a API do painel com o cookie do token. Erro do painel volta com o código e o "erro" dele.
async fn painel_request(method: reqwest::Method, path: &str, body: Option<Value>, secs: u64, nome: &str, extra: &[(&str, String)]) -> Result<Value, PainelErro> {
    let erro = |code: StatusCode, msg: String, sem_resposta: bool| PainelErro { code, msg, sem_resposta };
    let (Some(base), Some(token)) = (env_value("ESFERA_PAINEL_URL"), env_value("ESFERA_PAINEL_TOKEN")) else {
        return Err(erro(StatusCode::NOT_FOUND, format!("Painel {} não configurado no hub.", nome), false));
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(secs))
        .build().map_err(|_| erro(StatusCode::INTERNAL_SERVER_ERROR, "Falha ao preparar o cliente HTTP do hub.".into(), false))?;
    let mut req = client.request(method, format!("{}{}", base.trim_end_matches('/'), path))
        .header(reqwest::header::COOKIE, format!("painel_token={}", token));
    for (k, v) in extra { req = req.header(*k, v.as_str()); }
    if let Some(b) = body { req = req.json(&b); }
    let resp = req.send().await.map_err(|_| erro(StatusCode::BAD_GATEWAY, format!("O painel {} não respondeu.", nome), true))?;
    let status = resp.status();
    let data = resp.json::<Value>().await.unwrap_or(Value::Null);
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        // 401 do painel é configuração do hub, não sessão do usuário.
        return Err(erro(StatusCode::BAD_GATEWAY, format!("O painel {} recusou o acesso do hub (confira ESFERA_PAINEL_TOKEN).", nome), false));
    }
    if !status.is_success() {
        let msg = data.get("erro").and_then(Value::as_str).map(str::to_string)
            .unwrap_or_else(|| format!("O painel {} recusou a operação.", nome));
        return Err(erro(status, msg, false));
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
    let repasse = repasse_of(&data)
        .ok_or_else(|| fail(StatusCode::BAD_GATEWAY, "O painel não informou os destinos do repasse"))?;
    Ok(reply(StatusCode::OK, repasse))
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
// O lock cobre leitura, merge e rename; só bloquear o rename perderia snapshots concorrentes.
static DEVEDORES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DevedorVinculo {
    pub empresa_id: i32,
    pub campanha_id: i32,
    pub numero_disparo: String,
    pub telefone: String,
    pub enviado_em: i64,
}

#[derive(Debug, Deserialize)]
pub struct DevedoresBody {
    pub schema: u8,
    pub empresas: Vec<i32>,
    pub vinculos: Vec<DevedorVinculo>,
    // Lida e normalizada separadamente; ausência preserva a lista já gravada.
    #[serde(skip)]
    pub telefones: Option<Vec<String>>,
    #[serde(skip)]
    ignorados: usize,
    // atualizado_em é definido pelo servidor.
}

#[derive(Debug)]
struct DevedoresError(StatusCode, &'static str);

impl DevedoresError {
    fn response(self) -> Response { fail(self.0, self.1) }
}

fn invalid_devedores() -> DevedoresError {
    DevedoresError(StatusCode::BAD_REQUEST, "Snapshot de devedores inválido: confira empresas, vínculos, números completos com DDI e horários de envio.")
}

fn valid_devedor_phone(number: &str) -> bool {
    (number.len() == 12 || number.len() == 13) && number.starts_with("55")
        && number.bytes().all(|b| b.is_ascii_digit()) && number.as_bytes()[2] != b'0'
}

/// Só dígitos, 10 a 13; ordenados e sem repetição, como no formato legado.
/// Devolve (telefones, ignorados); repetições válidas não contam como ignorados.
pub fn normalize_devedores(list: &[Value]) -> (Vec<String>, usize) {
    let mut out = Vec::with_capacity(list.len());
    let mut ignorados = 0;
    for v in list {
        let s = match v {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) if n.is_u64() => n.to_string(),
            _ => String::new(),
        };
        if (10..=13).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) { out.push(s) }
        else { ignorados += 1; }
    }
    out.sort_unstable();
    out.dedup();
    (out, ignorados)
}

fn decode_devedores(value: Value) -> Result<DevedoresBody, DevedoresError> {
    let (telefones, ignorados) = match value.get("telefones") {
        Some(Value::Array(list)) => {
            let (phones, ignored) = normalize_devedores(list);
            (Some(phones), ignored)
        }
        None => (None, 0),
        _ => return Err(invalid_devedores()),
    };
    if value.get("schema").is_none() {
        if telefones.is_none() { return Err(invalid_devedores()); }
        // O cliente legado só substitui a lista global, sem declarar escopo de vínculos.
        return Ok(DevedoresBody { schema: 2, empresas: vec![], vinculos: vec![], telefones, ignorados });
    }
    if value.get("schema").and_then(Value::as_u64) != Some(2) {
        return Err(invalid_devedores());
    }
    let mut body: DevedoresBody = serde_json::from_value(value).map_err(|_| invalid_devedores())?;
    body.telefones = telefones;
    body.ignorados = ignorados;
    Ok(body)
}

fn normalize_vinculos(vinculos: Vec<DevedorVinculo>) -> Vec<DevedorVinculo> {
    let mut by_key = std::collections::BTreeMap::new();
    for v in vinculos {
        let key = (v.empresa_id, v.campanha_id, v.numero_disparo.clone(), v.telefone.clone());
        by_key.entry(key).and_modify(|old: &mut DevedorVinculo| {
            old.enviado_em = old.enviado_em.min(v.enviado_em);
        }).or_insert(v);
    }
    by_key.into_values().collect()
}

fn validate_devedores(mut body: DevedoresBody, now: i64) -> Result<DevedoresBody, DevedoresError> {
    if body.schema != 2 || body.empresas.iter().any(|id| *id <= 0) {
        return Err(invalid_devedores());
    }
    body.empresas.sort_unstable();
    body.empresas.dedup();
    for v in &mut body.vinculos {
        if v.empresa_id <= 0 || v.campanha_id <= 0 || body.empresas.binary_search(&v.empresa_id).is_err()
            || !valid_devedor_phone(&v.numero_disparo) || !valid_devedor_phone(&v.telefone)
            || v.enviado_em <= 0
        {
            return Err(invalid_devedores());
        }
        if v.enviado_em > now.saturating_add(120) { v.enviado_em = now; }
    }
    body.vinculos = normalize_vinculos(body.vinculos);
    Ok(body)
}

fn parse_devedores(value: Value, now: i64, company_id: i32, role: &str) -> Result<DevedoresBody, DevedoresError> {
    let body = decode_devedores(value)?;
    if body.vinculos.len() > MAX_DEVEDORES {
        return Err(DevedoresError(StatusCode::BAD_REQUEST, "No máximo 50000 vínculos por envio."));
    }
    authorize_devedores_scope(&body, company_id, role)?;
    validate_devedores(body, now)
}

fn authorize_devedores_scope(body: &DevedoresBody, company_id: i32, role: &str) -> Result<(), DevedoresError> {
    if role != "master" && (company_id <= 0 || body.empresas.iter().any(|id| *id > 0 && *id != company_id)
        || body.vinculos.iter().any(|v| v.empresa_id > 0 && v.empresa_id != company_id))
    {
        return Err(DevedoresError(StatusCode::FORBIDDEN, "O snapshot só pode conter a empresa do token autenticado."));
    }
    Ok(())
}

fn stored_devedores(value: Value, now: i64) -> Result<DevedoresBody, DevedoresError> {
    validate_devedores(decode_devedores(value)?, now)
}

fn merge_devedores(current: DevedoresBody, incoming: DevedoresBody, now: i64) -> Result<Value, DevedoresError> {
    let current = validate_devedores(current, now)?;
    let mut incoming = validate_devedores(incoming, now)?;
    // Se o contato permanece no snapshot, mantém o primeiro envio.
    let oldest: std::collections::BTreeMap<_, _> = current.vinculos.iter().map(|v|
        ((v.empresa_id, v.campanha_id, v.numero_disparo.as_str(), v.telefone.as_str()), v.enviado_em)).collect();
    for v in &mut incoming.vinculos {
        if let Some(ts) = oldest.get(&(v.empresa_id, v.campanha_id, v.numero_disparo.as_str(), v.telefone.as_str())) {
            v.enviado_em = v.enviado_em.min(*ts);
        }
    }
    let mut empresas = current.empresas;
    empresas.extend(&incoming.empresas);
    empresas.sort_unstable();
    empresas.dedup();
    let mut vinculos: Vec<_> = current.vinculos.into_iter()
        .filter(|v| incoming.empresas.binary_search(&v.empresa_id).is_err()).collect();
    vinculos.extend(incoming.vinculos);
    let vinculos = normalize_vinculos(vinculos);
    let mut origins = std::collections::BTreeMap::new();
    for v in &vinculos {
        if origins.insert(&v.numero_disparo, v.empresa_id).is_some_and(|id| id != v.empresa_id) {
            return Err(DevedoresError(StatusCode::CONFLICT, "Número de disparo vinculado a mais de uma empresa."));
        }
    }
    let telefones = incoming.telefones.or(current.telefones).unwrap_or_default();
    Ok(serde_json::json!({ "schema": 2, "atualizado_em": now, "empresas": empresas,
        "telefones": telefones, "vinculos": vinculos }))
}

fn persist_devedores(path: &std::path::Path, incoming: DevedoresBody, now: i64) -> Result<Value, DevedoresError> {
    let disk_error = || DevedoresError(StatusCode::INTERNAL_SERVER_ERROR, "Falha ao atualizar o snapshot de devedores.");
    let _guard = DEVEDORES_LOCK.lock().map_err(|_| disk_error())?;
    let current = match std::fs::read(path) {
        Ok(data) => stored_devedores(serde_json::from_slice(&data).map_err(|_| disk_error())?, now)
            .map_err(|_| disk_error())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DevedoresBody {
            schema: 2, empresas: vec![], vinculos: vec![], telefones: None, ignorados: 0,
        },
        Err(_) => return Err(disk_error()),
    };
    let merged = merge_devedores(current, incoming, now)?;
    let data = serde_json::to_vec(&merged).map_err(|_| disk_error())?;
    write_atomic(path, &data).map_err(|_| disk_error())?;
    Ok(merged)
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

/// POST /api/desktop/evolution/devedores — lista legada ou snapshot v2 autenticado por empresa.
pub async fn evolution_devedores(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    payload: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, Response> {
    let (company_id, role) = authorize_manage(&db, &headers)?;
    let Json(value) = payload.map_err(|_| invalid_devedores().response())?;
    let now = chrono::Utc::now().timestamp();
    let b = parse_devedores(value, now, company_id, &role).map_err(DevedoresError::response)?;
    let ignorados = b.ignorados;
    let path = env_value("ESFERA_DEVEDORES_ARQUIVO")
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "Arquivo de devedores não configurado no hub."))?;
    let merged = tokio::task::spawn_blocking(move || persist_devedores(std::path::Path::new(&path), b, now)).await
        .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Falha ao gravar a lista de devedores."))?
        .map_err(DevedoresError::response)?;
    Ok(reply(StatusCode::OK, serde_json::json!({ "ok": true, "schema": 2,
        "total": merged["telefones"].as_array().map_or(0, Vec::len),
        "vinculos": merged["vinculos"].as_array().map_or(0, Vec::len), "ignorados": ignorados })))
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

// ------------------------------------------------------------------
// Central das automações (aba "Central" do Esfera)
//
// O painel da PA FIXA monta o estado de Maiara, Marcela, Konfiansa no PC e repasse
// (/api/central); o hub acrescenta a ponte ADB da Maiara, que roda no host (systemd
// pafixa-ponte, log/estado em /var/lib/pafixa-ponte). Painel fora do ar não derruba a rota.
// Ambiente opcional: ESFERA_PONTE_SERVICO (padrão pafixa-ponte), ESFERA_PONTE_PASTA.
// ------------------------------------------------------------------

/// Ponte sem atividade (log/estado parados) por mais que isto = caída.
pub const PONTE_PARADA_SECS: i64 = 600;
const PONTE_SERVICO_PADRAO: &str = "pafixa-ponte";
const PONTE_PASTA_PADRAO: &str = "/var/lib/pafixa-ponte";
/// Arquivos que a ponte (bot/ponte_adb.py) escreve enquanto trabalha.
const PONTE_ARQUIVOS: [&str; 2] = ["pafixa_ponte_adb.log", "pafixa_ponte_adb.json"];

/// Ações que o desktop pode pedir ao painel (a mesma lista do painel).
pub const CENTRAL_ACOES: [&str; 6] = ["pausar_marcela", "retomar_marcela", "liberar_pedido", "pausar_fila_maiara", "retomar_fila_maiara", "dispensar_pendencia"];

/// Hora de Brasília (sem horário de verão desde 2019) em ISO-8601.
pub fn iso_brasilia(t: chrono::DateTime<chrono::Utc>) -> String {
    let br = chrono::FixedOffset::west_opt(3 * 3600).expect("fuso fixo");
    t.with_timezone(&br).format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

fn minutos_texto(secs: i64) -> String {
    let m = secs.max(0) / 60;
    if m < 1 { "menos de 1 min".into() } else if m < 120 { format!("{} min", m) } else { format!("{} h", m / 60) }
}

/// Cartão da ponte e, quando ela precisa de alguém, a pendência.
/// `servico`: saída de `systemctl is-active` (Ok) ou por que não deu para ler (Err).
/// `ultima`: instante da última escrita no log/estado (Ok(None) = nenhum arquivo) ou falha de leitura.
pub fn ponte_automacao(
    servico: &Result<String, String>,
    ultima: &Result<Option<chrono::DateTime<chrono::Utc>>, String>,
    agora: chrono::DateTime<chrono::Utc>,
) -> (Value, Option<Value>, Vec<String>) {
    let mut falhas = Vec::new();
    let idade = match ultima {
        Ok(Some(t)) => Some((agora - *t).num_seconds().max(0)),
        Ok(None) => None,
        Err(e) => { falhas.push(format!("Ponte ADB: {}", e)); None }
    };
    if let Err(e) = servico { falhas.push(format!("Ponte ADB: {}", e)); }
    let quando_ultima = match ultima { Ok(Some(t)) => iso_brasilia(*t), _ => iso_brasilia(agora) };
    let atividade = idade.map(|s| format!("Última atividade há {}.", minutos_texto(s)))
        .unwrap_or_else(|| "Sem registro de atividade no log da ponte.".into());
    let (estado, detalhe, pendencia) = match (servico.as_ref().map(|s| s.trim()), idade) {
        (Ok("active"), Some(s)) if s <= PONTE_PARADA_SECS => ("ok", format!("Ligada no celular da Maiara. {}", atividade), None),
        (Ok("active"), Some(s)) => ("caido", format!("Serviço ligado, mas parado: {}", atividade), Some((
            "ponte:parada",
            format!("Ponte ADB da Maiara parada há {}", minutos_texto(s)),
            "O serviço está ligado, mas não registra atividade. Confira o celular da Maiara e o túnel ADB.".to_string(),
        ))),
        (Ok("active"), None) => ("desconhecido", format!("Serviço ligado. {}", atividade), None),
        (Ok(outro), _) => ("caido", format!("Serviço {} na VPS. {}", if outro.is_empty() { "sem estado" } else { outro }, atividade), Some((
            "ponte:desligada",
            "Ponte ADB da Maiara desligada".to_string(),
            format!("O serviço {} não está rodando na VPS (estado: {}). As respostas da Maiara pelo celular param.",
                PONTE_SERVICO_PADRAO, if outro.is_empty() { "vazio" } else { outro }),
        ))),
        (Err(_), _) => ("desconhecido", format!("Não deu para ler o serviço na VPS. {}", atividade), None),
    };
    let mut numeros = Vec::new();
    if let Some(s) = idade { numeros.push(serde_json::json!({ "rotulo": "Minutos sem atividade", "valor": s / 60 })); }
    let automacao = serde_json::json!({
        "id": "ponte", "nome": "Ponte ADB da Maiara", "estado": estado, "detalhe": detalhe,
        "numeros": numeros, "acoes": [],
    });
    let pendencia = pendencia.map(|(id, titulo, detalhe)| serde_json::json!({
        "id": id, "origem": "ponte", "gravidade": "alta", "titulo": titulo, "detalhe": detalhe,
        "quando": quando_ultima, "devedor": null, "acoes": [],
    }));
    (automacao, pendencia, falhas)
}

/// Texto da falha quando o painel não entregou a Central.
pub fn painel_falha(e: &PainelErro) -> String {
    if e.sem_resposta { "Painel da PA FIXA não respondeu".into() }
    else if e.code == StatusCode::NOT_FOUND && e.msg.contains("não configurado") { "Painel da PA FIXA não configurado no hub.".into() }
    else if e.code == StatusCode::NOT_FOUND { "O painel da PA FIXA ainda não tem a Central (precisa ser atualizado).".into() }
    else { format!("Painel da PA FIXA: {}", e.msg) }
}

fn lista(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Junta a resposta do painel (ou a falha dele) com a ponte. Sempre devolve a Central completa.
pub fn mesclar_central(painel: Result<Value, String>, ponte: (Value, Option<Value>, Vec<String>), gerado_em: String) -> Value {
    let (automacao, pendencia, falhas_ponte) = ponte;
    let (base, mut falhas) = match painel {
        Ok(v) if v.is_object() => (v, Vec::new()),
        Ok(_) => (Value::Null, vec![Value::from("Resposta inválida do painel da PA FIXA.")]),
        Err(e) => (Value::Null, vec![Value::from(e)]),
    };
    falhas.extend(lista(base.get("falhas")));
    falhas.extend(falhas_ponte.into_iter().map(Value::from));
    // A ponte é do host: um cartão "ponte" vindo do painel daria duas versões da mesma coisa.
    let mut automacoes: Vec<Value> = lista(base.get("automacoes")).into_iter()
        .filter(|a| a.get("id").and_then(Value::as_str) != Some("ponte")).collect();
    automacoes.push(automacao);
    let mut pendencias: Vec<Value> = lista(base.get("pendencias")).into_iter()
        .filter(|p| p.get("origem").and_then(Value::as_str) != Some("ponte")).collect();
    if let Some(p) = pendencia { pendencias.insert(0, p); }
    let gerado = base.get("geradoEm").and_then(Value::as_str).map(str::to_string).unwrap_or(gerado_em);
    serde_json::json!({ "geradoEm": gerado, "automacoes": automacoes, "pendencias": pendencias, "falhas": falhas })
}

/// Com o arquivo MODO_ADB na VPS o WhatsApp da Maiara está restrito e ela atende pela ponte ADB:
/// o "desconectado" que o painel vê (ele não enxerga esse arquivo) não é falha. O estado passa a ser o da ponte.
pub fn ajustar_modo_adb(central: &mut Value) {
    let ponte_ok = lista(central.get("automacoes")).iter()
        .any(|a| a.get("id").and_then(Value::as_str) == Some("ponte") && a.get("estado").and_then(Value::as_str) == Some("ok"));
    if let Some(autos) = central.get_mut("automacoes").and_then(Value::as_array_mut) {
        for a in autos.iter_mut() {
            let maiara_sem_wa = a.get("id").and_then(Value::as_str) == Some("maiara")
                && a.get("estado").and_then(Value::as_str) == Some("caido")
                && a.get("detalhe").and_then(Value::as_str).map_or(false, |d| d.contains("WhatsApp"));
            if maiara_sem_wa {
                a["estado"] = Value::from(if ponte_ok { "ok" } else { "caido" });
                a["detalhe"] = Value::from(if ponte_ok {
                    "WhatsApp restrito: atendendo pela ponte ADB."
                } else {
                    "WhatsApp restrito e a ponte ADB não está bem: veja o cartão da ponte."
                });
            }
        }
    }
    if let Some(pend) = central.get_mut("pendencias").and_then(Value::as_array_mut) {
        pend.retain(|p| p.get("id").and_then(Value::as_str) != Some("maiara:whatsapp"));
    }
}

fn modo_adb_ligado() -> bool {
    let caminho = env_value("ESFERA_PAFIXA_MODO_ADB").unwrap_or_else(|| "/opt/pafixa/MODO_ADB".to_string());
    std::path::Path::new(&caminho).exists()
}

/// Valida a ação da Central e devolve só os parâmetros que ela usa.
pub fn central_acao_valida(acao: &str, params: &Value) -> Result<Value, String> {
    if !CENTRAL_ACOES.contains(&acao) {
        return Err("Ação desconhecida na Central.".into());
    }
    match acao {
        "liberar_pedido" => {
            let id = params.get("pedido_id").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok())))
                .filter(|n| *n > 0)
                .ok_or_else(|| "Pedido inválido: falta o número do pedido.".to_string())?;
            Ok(serde_json::json!({ "pedido_id": id }))
        }
        "dispensar_pendencia" => {
            let id = params.get("id").and_then(Value::as_str).map(str::trim).unwrap_or("");
            let ok = (1..=200).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || ":_-./@".contains(c));
            if !ok { return Err("Pendência inválida: falta o identificador.".into()); }
            Ok(serde_json::json!({ "id": id }))
        }
        _ => Ok(serde_json::json!({})),
    }
}

/// Quem pediu a ação (login mandado pelo desktop), só para log: seguro para header e sem quebra de linha.
/// Não vale para permissão: quem autoriza é o token do hub.
pub fn usuario_log(u: Option<&str>) -> String {
    let s: String = u.unwrap_or("").trim().chars().take(64)
        .map(|c| if c.is_ascii_alphanumeric() || "._-@".contains(c) { c } else { '_' }).collect();
    if s.is_empty() { "desconhecido".into() } else { s }
}

/// Busca do devedor: só dígitos; telefone com DDD (10 a 13), CPF (11) ou CNPJ (14).
pub fn central_q_valida(q: &str) -> Result<String, String> {
    let d: String = q.chars().filter(|c| c.is_ascii_digit()).collect();
    if (10..=14).contains(&d.len()) { Ok(d) } else { Err("Informe CPF, CNPJ ou telefone com DDD.".into()) }
}

fn ponte_servico() -> String {
    env_value("ESFERA_PONTE_SERVICO")
        .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@')))
        .unwrap_or_else(|| PONTE_SERVICO_PADRAO.into())
}

/// `systemctl is-active <serviço>` com prazo curto. Saída diferente de "active" sai com código ≠ 0: vale a saída.
async fn ponte_systemctl() -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("systemctl");
    cmd.arg("is-active").arg(ponte_servico()).kill_on_drop(true)
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match tokio::time::timeout(Duration::from_secs(3), cmd.output()).await {
        Err(_) => Err("o systemctl demorou demais para responder.".into()),
        Ok(Err(_)) => Err("não deu para rodar o systemctl no host.".into()),
        Ok(Ok(out)) => {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() { Err("o systemctl não informou o estado do serviço.".into()) } else { Ok(s) }
        }
    }
}

/// Última escrita no log/estado da ponte.
fn ponte_ultima_atividade() -> Result<Option<chrono::DateTime<chrono::Utc>>, String> {
    let pasta = env_value("ESFERA_PONTE_PASTA").unwrap_or_else(|| PONTE_PASTA_PADRAO.into());
    let pasta = std::path::Path::new(&pasta);
    if !pasta.is_dir() {
        return Err("não deu para ler a pasta do log da ponte no host.".into());
    }
    let mut ultima: Option<std::time::SystemTime> = None;
    for nome in PONTE_ARQUIVOS {
        match std::fs::metadata(pasta.join(nome)).and_then(|m| m.modified()) {
            Ok(t) => ultima = Some(ultima.map_or(t, |u| u.max(t))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("não deu para ler o log da ponte no host.".into()),
        }
    }
    Ok(ultima.map(chrono::DateTime::<chrono::Utc>::from))
}

#[derive(Debug, Deserialize)]
pub struct CentralAcaoBody {
    #[serde(default)]
    pub acao: String,
    #[serde(default)]
    pub params: Value,
    /// Login de quem pediu no Esfera (só para log).
    #[serde(default)]
    pub usuario: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CentralDevedorQuery {
    #[serde(default)]
    pub q: String,
}

/// GET /api/desktop/central — Central do painel + ponte do host. 200 mesmo com o painel fora.
pub async fn central(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let (painel, servico) = tokio::join!(
        painel_request(reqwest::Method::GET, "/api/central", None, 20, "da PA FIXA", &[]),
        ponte_systemctl(),
    );
    let ultima = tokio::task::spawn_blocking(ponte_ultima_atividade).await
        .unwrap_or_else(|_| Err("falha ao ler o log da ponte no host.".into()));
    let agora = chrono::Utc::now();
    let ponte = ponte_automacao(&servico, &ultima, agora);
    let painel = painel.map_err(|e| painel_falha(&e));
    let mut c = mesclar_central(painel, ponte, iso_brasilia(agora));
    if modo_adb_ligado() {
        ajustar_modo_adb(&mut c);
    }
    Ok(reply(StatusCode::OK, c))
}

/// POST /api/desktop/central/acao {"acao","params"} — só as ações da lista; repassa ao painel.
pub async fn central_acao(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Json(b): Json<CentralAcaoBody>,
) -> Result<Response, Response> {
    let (company_id, role) = authorize_manage(&db, &headers)?;
    let acao = b.acao.trim().to_string();
    let params = central_acao_valida(&acao, &b.params).map_err(|e| fail(StatusCode::BAD_REQUEST, e))?;
    let usuario = usuario_log(b.usuario.as_deref());
    println!("[CENTRAL] ação {} pedida por {} (empresa {}, {})", acao, usuario, company_id, role);
    let data = painel_request(reqwest::Method::POST, "/api/central/acao",
        Some(serde_json::json!({ "acao": acao, "params": params })), 30, "da PA FIXA",
        &[("X-Esfera-Usuario", usuario)]).await.map_err(|e| e.response())?;
    Ok(reply(StatusCode::OK, data))
}

/// GET /api/desktop/central/devedor?q= — linha do tempo do devedor no painel.
pub async fn central_devedor(
    State((db, _)): State<(Arc<Database>, u16)>,
    headers: HeaderMap,
    Query(q): Query<CentralDevedorQuery>,
) -> Result<Response, Response> {
    authorize_manage(&db, &headers)?;
    let q = central_q_valida(&q.q).map_err(|e| fail(StatusCode::BAD_REQUEST, e))?;
    let data = painel_request(reqwest::Method::GET, &format!("/api/central/devedor?q={}", q), None, 20, "da PA FIXA", &[]).await
        .map_err(|e| e.response())?;
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

    const NOW: i64 = 1_793_820_852;

    fn vinculo(empresa: i32, campanha: i32, origem: &str, telefone: &str, enviado: i64) -> Value {
        serde_json::json!({"empresa_id": empresa, "campanha_id": campanha,
            "numero_disparo": origem, "telefone": telefone, "enviado_em": enviado})
    }

    fn snapshot(empresas: &[i32], vinculos: Vec<Value>) -> Value {
        serde_json::json!({"schema": 2, "empresas": empresas, "vinculos": vinculos})
    }

    fn parsed(value: Value) -> DevedoresBody {
        parse_devedores(value, NOW, 0, "master").unwrap()
    }

    #[test]
    fn devedores_v2_guarda_lista_do_corpo_e_normaliza_vinculos() {
        let mut value = snapshot(&[2, 1, 2], vec![
            vinculo(2, 3, "5547996271722", "5511991703561", NOW - 10),
            vinculo(2, 3, "5547996271722", "5511991703561", NOW - 30),
            vinculo(1, 4, "554796834632", "554733054406", NOW),
        ]);
        value["telefones"] = serde_json::json!(["5511999999999", " 4733054406 ", 4733054406u64,
            "11991703561", "5511999999999", "47 99999-8888", "123", "55479999988881", null, "abcdefghij"]);
        value["atualizado_em"] = serde_json::json!(i64::MAX);
        let merged = merge_devedores(parsed(snapshot(&[], vec![])), parsed(value), NOW).unwrap();
        assert_eq!(merged["schema"], 2);
        assert_eq!(merged["atualizado_em"], NOW);
        assert_eq!(merged["empresas"], serde_json::json!([1, 2]));
        assert_eq!(merged["telefones"], serde_json::json!(["11991703561", "4733054406", "5511999999999"]));
        assert_eq!(merged["vinculos"].as_array().unwrap().len(), 2);
        assert_eq!(merged["vinculos"][0]["empresa_id"], 1);
        assert_eq!(merged["vinculos"][1]["enviado_em"], NOW - 30);
    }

    #[test]
    fn devedores_rejeita_campos_ausentes_e_malformados() {
        let valid = snapshot(&[1], vec![vinculo(1, 1, "5547996271722", "5511991703561", NOW)]);
        for value in [serde_json::json!({}),
            serde_json::json!({"telefones": null}),
            serde_json::json!({"telefones": "5511991703561"}),
            serde_json::json!({"schema": null, "telefones": []}),
            serde_json::json!({"schema": 1, "telefones": []}),
            serde_json::json!({"schema": 2, "empresas": [1]}),
            serde_json::json!({"schema": 2, "vinculos": []}),
            serde_json::json!({"schema": "2", "empresas": [1], "vinculos": []}),
            serde_json::json!({"schema": 2, "empresas": [-1], "vinculos": []}),
            serde_json::json!({"schema": 2, "empresas": [1], "vinculos": null}),
            serde_json::json!({"schema": 2, "empresas": [1], "vinculos": [], "telefones": null}),
            serde_json::json!({"schema": 2, "empresas": [1], "vinculos": [], "telefones": {}}),
        ] {
            assert_eq!(parse_devedores(value, NOW, 0, "master").unwrap_err().0, StatusCode::BAD_REQUEST);
        }
        for (field, bad) in [
            ("empresa_id", serde_json::json!(0)), ("empresa_id", serde_json::json!(2)),
            ("campanha_id", serde_json::json!(-1)), ("campanha_id", serde_json::json!(1.5)),
            ("telefone", serde_json::json!(5511991703561u64)), ("telefone", serde_json::json!("11991703561")),
            ("telefone", serde_json::json!("+5511991703561")), ("telefone", serde_json::json!("5511991703561 ")),
            ("numero_disparo", serde_json::json!("47 99627-1722")), ("numero_disparo", serde_json::json!("4407996271722")),
            ("enviado_em", serde_json::json!(0)), ("enviado_em", serde_json::json!(-1)),
            ("enviado_em", serde_json::json!(NOW.to_string())),
        ] {
            let mut value = valid.clone();
            value["vinculos"][0][field] = bad;
            assert_eq!(parse_devedores(value, NOW, 0, "master").unwrap_err().0, StatusCode::BAD_REQUEST, "campo {field}");
        }
    }

    #[test]
    fn devedores_escopo_isola_empresa_inclusive_gestor_e_snapshot_vazio() {
        for role in ["gestor", "empresa", "colaborador"] {
            assert!(parse_devedores(snapshot(&[1], vec![]), NOW, 1, role).is_ok());
            for value in [snapshot(&[2], vec![]), snapshot(&[1, 2], vec![]),
                snapshot(&[1], vec![vinculo(2, 1, "5547996271722", "5511991703561", NOW)])] {
                assert_eq!(parse_devedores(value, NOW, 1, role).unwrap_err().0, StatusCode::FORBIDDEN);
            }
            assert_eq!(parse_devedores(snapshot(&[], vec![]), NOW, 0, role).unwrap_err().0, StatusCode::FORBIDDEN);
        }
        assert!(parse_devedores(snapshot(&[1, 2], vec![]), NOW, 0, "master").is_ok());
    }

    #[test]
    fn devedores_preserva_envios_de_60_dias_e_primeiro_envio() {
        let body = parsed(snapshot(&[1], vec![
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 60 * 86_400),
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 172_800),
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 1),
            vinculo(1, 2, "5547996271722", "554733054406", NOW + 120),
        ]));
        assert_eq!(body.vinculos.len(), 2);
        assert_eq!(body.vinculos[0].enviado_em, NOW - 60 * 86_400);
        assert_eq!(body.vinculos[1].enviado_em, NOW + 120);
        let mut expired_bad = snapshot(&[1], vec![vinculo(1, 1, "5547996271722", "bad", NOW - 172_801)]);
        assert!(parse_devedores(expired_bad.clone(), NOW, 0, "master").is_err());
        expired_bad["vinculos"][0]["telefone"] = serde_json::json!("5511991703561");
        assert_eq!(parsed(expired_bad).vinculos.len(), 1);
    }

    #[test]
    fn devedores_horario_futuro_acima_da_tolerancia_vira_agora() {
        for (timestamp, expected) in [(NOW + 120, NOW + 120), (NOW + 121, NOW), (i64::MAX, NOW)] {
            let value = snapshot(&[1], vec![vinculo(1, 1, "5547996271722", "5511991703561", timestamp)]);
            let merged = merge_devedores(parsed(snapshot(&[], vec![])), parsed(value), NOW).unwrap();
            assert_eq!(merged["vinculos"][0]["enviado_em"], expected);
        }
    }

    #[test]
    fn devedores_limita_tamanho_bruto_antes_de_deduplicar() {
        let item = vinculo(1, 1, "5547996271722", "5511991703561", NOW);
        assert_eq!(parse_devedores(snapshot(&[1], vec![item; 50_001]), NOW, 0, "master").unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn devedores_snapshot_de_50000_vinculos_cabe_no_limite_da_rota() {
        let value = snapshot(&[i32::MAX], (1..=50_000).map(|i| {
            vinculo(i32::MAX, i, "5547996271722", "5511991703561", NOW)
        }).collect());
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(bytes.len() > 4 * 1024 * 1024);
        assert!(bytes.len() < 16 * 1024 * 1024);
        assert_eq!(parsed(value).vinculos.len(), 50_000);
    }

    #[test]
    fn devedores_merge_substitui_so_empresas_declaradas_e_preserva_primeiro_envio() {
        let current = parsed(snapshot(&[1, 2], vec![
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 200),
            vinculo(1, 2, "5547996271722", "554733054406", NOW - 150),
            vinculo(2, 1, "554796834632", "5547999998888", NOW - 100),
        ]));
        let merged = merge_devedores(current, parsed(snapshot(&[1], vec![
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 10),
        ])), NOW).unwrap();
        assert_eq!(merged["vinculos"], serde_json::json!([
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 200),
            vinculo(2, 1, "554796834632", "5547999998888", NOW - 100),
        ]));
        let cleared = merge_devedores(stored_devedores(merged, NOW).unwrap(), parsed(snapshot(&[1], vec![])), NOW).unwrap();
        assert_eq!(cleared["vinculos"].as_array().unwrap().len(), 1);
        assert_eq!(cleared["vinculos"][0]["empresa_id"], 2);
        assert_eq!(cleared["telefones"], serde_json::json!([]));
    }

    #[test]
    fn devedores_origem_compartilhada_entre_empresas_e_conflito() {
        let current = parsed(snapshot(&[1], vec![vinculo(1, 1, "5547996271722", "5511991703561", NOW)]));
        let collision = parsed(snapshot(&[2], vec![vinculo(2, 2, "5547996271722", "554733054406", NOW)]));
        assert_eq!(merge_devedores(current, collision, NOW).unwrap_err().0, StatusCode::CONFLICT);
        let two_campaigns = parsed(snapshot(&[1], vec![
            vinculo(1, 1, "5547996271722", "5511991703561", NOW),
            vinculo(1, 2, "5547996271722", "5511991703561", NOW),
        ]));
        assert_eq!(merge_devedores(parsed(snapshot(&[], vec![])), two_campaigns, NOW).unwrap()["vinculos"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn devedores_arquivo_legado_preserva_telefones_sem_criar_vinculos() {
        let old = stored_devedores(serde_json::json!({"atualizado_em": NOW, "telefones": ["5511999999999"]}), NOW).unwrap();
        let merged = merge_devedores(old, parsed(snapshot(&[1], vec![])), NOW).unwrap();
        assert_eq!(merged["schema"], 2);
        assert_eq!(merged["telefones"], serde_json::json!(["5511999999999"]));
        assert_eq!(merged["vinculos"], serde_json::json!([]));
        assert!(stored_devedores(serde_json::json!({"schema": 2, "telefones": ["5511999999999"]}), NOW).is_err());
    }

    #[test]
    fn devedores_merge_preserva_empresa_sem_vinculos_e_envio_antigo() {
        let current = parsed(snapshot(&[1, 2], vec![
            vinculo(2, 1, "5547996271722", "5511991703561", NOW - 60 * 86_400),
        ]));
        let merged = merge_devedores(current, parsed(snapshot(&[3], vec![])), NOW).unwrap();
        assert_eq!(merged["empresas"], serde_json::json!([1, 2, 3]));
        assert_eq!(merged["telefones"], serde_json::json!([]));
        assert_eq!(merged["vinculos"], serde_json::json!([
            vinculo(2, 1, "5547996271722", "5511991703561", NOW - 60 * 86_400),
        ]));
    }

    #[test]
    fn devedores_v2_sem_telefones_preserva_lista_e_lista_vazia_limpa() {
        let mut value = snapshot(&[1], vec![vinculo(1, 1, "5547996271722", "5511991703561", NOW)]);
        value["telefones"] = serde_json::json!(["4733054406", "5511999999999"]);
        let merged = merge_devedores(parsed(value), parsed(snapshot(&[1], vec![])), NOW).unwrap();
        assert_eq!(merged["telefones"], serde_json::json!(["4733054406", "5511999999999"]));
        assert_eq!(merged["vinculos"], serde_json::json!([]));
        let mut clear = snapshot(&[1], vec![]);
        clear["telefones"] = serde_json::json!([]);
        let cleared = merge_devedores(stored_devedores(merged, NOW).unwrap(), parsed(clear), NOW).unwrap();
        assert_eq!(cleared["telefones"], serde_json::json!([]));
    }

    #[test]
    fn devedores_legado_aceito_preserva_empresas_e_vinculos_no_disco() {
        let dir = std::env::temp_dir().join(format!("esfera-devedores-legado-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("devedores.json");
        let current = persist_devedores(&target, parsed(snapshot(&[1, 2], vec![
            vinculo(1, 1, "5547996271722", "5511991703561", NOW - 60 * 86_400),
            vinculo(2, 2, "554796834632", "5547999998888", NOW),
        ])), NOW).unwrap();
        let incoming = parse_devedores(serde_json::json!({"telefones": [" 4733054406 ", "5511999999999",
            4733054406u64, "123", null]}), NOW, 1, "gestor").unwrap();
        let merged = persist_devedores(&target, incoming, NOW).unwrap();
        assert_eq!(merged["telefones"], serde_json::json!(["4733054406", "5511999999999"]));
        assert_eq!(merged["empresas"], current["empresas"]);
        assert_eq!(merged["vinculos"], current["vinculos"]);
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&target).unwrap()).unwrap(), merged);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn devedores_handler_exige_token_e_rejeita_escopo_antes_de_gravar() {
        let dir = std::env::temp_dir().join(format!("esfera-devedores-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let db = Arc::new(Database::init(path.to_str().unwrap()).unwrap());
        db.ensure_company(77, "Teste local").unwrap();
        db.upsert_company_token(77, "token-apenas-para-teste-local", "gestor").unwrap();
        let body = snapshot(&[77], vec![]);
        assert_eq!(evolution_devedores(State((db.clone(), 0)), HeaderMap::new(), Ok(Json(body.clone()))).await.unwrap_err().status(), StatusCode::UNAUTHORIZED);
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::AUTHORIZATION, "Bearer token-invalido-de-teste".parse().unwrap());
        assert_eq!(evolution_devedores(State((db.clone(), 0)), headers.clone(), Ok(Json(body))).await.unwrap_err().status(), StatusCode::UNAUTHORIZED);
        headers.insert(axum::http::header::AUTHORIZATION, "Bearer token-apenas-para-teste-local".parse().unwrap());
        for (value, code) in [
            (snapshot(&[78], vec![]), StatusCode::FORBIDDEN),
            (snapshot(&[77], vec![vinculo(78, 1, "5547996271722", "5511991703561", NOW)]), StatusCode::FORBIDDEN),
            (serde_json::json!({"telefones": null}), StatusCode::BAD_REQUEST),
            (serde_json::json!({"schema": 2, "empresas": [77]}), StatusCode::BAD_REQUEST),
            (snapshot(&[0], vec![]), StatusCode::BAD_REQUEST),
        ] {
            let response = evolution_devedores(State((db.clone(), 0)), headers.clone(), Ok(Json(value))).await.unwrap_err();
            assert_eq!(response.status(), code);
            let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024).await.unwrap();
            let message = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(!message.contains("token-apenas-para-teste-local"));
            assert!(!message.contains(path.to_str().unwrap()));
        }
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn devedores_persistencia_concorrente_preserva_tenants_e_rejeita_sem_sobrescrever() {
        let dir = std::env::temp_dir().join(format!("esfera-devedores-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("devedores.json");
        let threads: Vec<_> = [(1, "5547996271722"), (2, "554796834632")].into_iter().map(|(id, origin)| {
            let path = target.clone();
            std::thread::spawn(move || persist_devedores(&path, parsed(snapshot(&[id], vec![
                vinculo(id, 1, origin, "5511991703561", NOW),
            ])), NOW).unwrap())
        }).collect();
        for thread in threads { thread.join().unwrap(); }
        let before = std::fs::read(&target).unwrap();
        let json: Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(json["empresas"], serde_json::json!([1, 2]));
        assert_eq!(json["vinculos"].as_array().unwrap().len(), 2);
        let error = persist_devedores(&target, parsed(snapshot(&[3], vec![
            vinculo(3, 1, "5547996271722", "554733054406", NOW),
        ])), NOW).unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(std::fs::read(&target).unwrap(), before);
        write_atomic(&target, b"{\"schema\":2,\"vinculos\":null}").unwrap();
        assert_eq!(persist_devedores(&target, parsed(snapshot(&[1], vec![])), NOW).unwrap_err().0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"schema\":2,\"vinculos\":null}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn devedores_handler_aceita_legado_e_v2_com_contagem_de_ignorados() {
        struct RestoreEnv(Option<std::ffi::OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                if let Some(value) = &self.0 { std::env::set_var("ESFERA_DEVEDORES_ARQUIVO", value); }
                else { std::env::remove_var("ESFERA_DEVEDORES_ARQUIVO"); }
            }
        }
        let dir = std::env::temp_dir().join(format!("esfera-devedores-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(Database::init(dir.join("test.db").to_str().unwrap()).unwrap());
        db.ensure_company(77, "Teste local").unwrap();
        db.upsert_company_token(77, "token-apenas-para-teste-local", "gestor").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::AUTHORIZATION, "Bearer token-apenas-para-teste-local".parse().unwrap());
        let target = dir.join("devedores.json");
        let links = vec![vinculo(77, 1, "5547996271722", "5511991703561", NOW - 60 * 86_400)];
        let mut initial = snapshot(&[77], links.clone());
        initial["telefones"] = serde_json::json!(["5511991703561"]);
        write_atomic(&target, &serde_json::to_vec(&initial).unwrap()).unwrap();
        let _restore = RestoreEnv(std::env::var_os("ESFERA_DEVEDORES_ARQUIVO"));
        std::env::set_var("ESFERA_DEVEDORES_ARQUIVO", &target);
        let mut v2 = snapshot(&[77], links.clone());
        v2["telefones"] = serde_json::json!(["5511999999999", "5511999999999", -4733054406i64]);
        for (value, expected_phones, ignored) in [
            (serde_json::json!({"telefones": ["5547999998888", " 5511991703561 ", "5547999998888",
                "47 99999-8888", "123", "55479999988881", 4733054406u64, null, "abcdefghij"]}),
                serde_json::json!(["4733054406", "5511991703561", "5547999998888"]), 5),
            (v2, serde_json::json!(["5511999999999"]), 1),
            (snapshot(&[77], links.clone()), serde_json::json!(["5511999999999"]), 0),
            (serde_json::json!({"telefones": []}), serde_json::json!([]), 0),
        ] {
            let response = evolution_devedores(State((db.clone(), 0)), headers.clone(), Ok(Json(value))).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024).await.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), serde_json::json!({
                "ok": true, "schema": 2, "total": expected_phones.as_array().unwrap().len(), "vinculos": 1, "ignorados": ignored,
            }));
            let stored: Value = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
            assert_eq!(stored["schema"], 2);
            assert!(stored["atualizado_em"].as_i64().unwrap() > NOW);
            assert_eq!(stored["empresas"], serde_json::json!([77]));
            assert_eq!(stored["vinculos"], serde_json::json!(links));
            assert_eq!(stored["telefones"], expected_phones);
        }
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
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
        assert_eq!(repasse_of(&op).unwrap()["destinos"][0]["numero"], "554733054406");
    }

    #[test]
    fn repasse_ausente_ou_invalido_nao_e_lista_vazia() {
        for op in [
            serde_json::json!({}),
            serde_json::json!({"erro": "Não autorizado"}),
            serde_json::json!({"grupos": [{"id": "pafixa"}]}),
            serde_json::json!({"grupos": [{"id": "disparo"}]}),
            serde_json::json!({"grupos": [{"id": "disparo", "repasse": {}}]}),
            serde_json::json!({"grupos": [{"id": "disparo", "repasse": {"destinos": null, "padrao": null}}]}),
        ] {
            assert!(repasse_of(&op).is_none());
        }
    }

    #[test]
    fn repasse_vazio_explicito_preserva_o_padrao() {
        let repasse = serde_json::json!({"destinos": [], "padrao": {"numero": "554733054406"}});
        let op = serde_json::json!({"grupos": [{"id": "disparo", "repasse": repasse.clone()}]});
        assert_eq!(repasse_of(&op), Some(repasse));
        let vazio = serde_json::json!({"destinos": [], "padrao": null});
        let op = serde_json::json!({"grupos": [{"id": "disparo", "repasse": vazio.clone()}]});
        assert_eq!(repasse_of(&op), Some(vazio));
    }

    fn t(s: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc)
    }

    #[test]
    fn ponte_ativa_e_recente_fica_ok() {
        let agora = t("2026-11-09T19:00:00Z");
        let (a, p, f) = ponte_automacao(&Ok("active".into()), &Ok(Some(t("2026-11-09T18:57:00Z"))), agora);
        assert_eq!((a["id"].as_str(), a["estado"].as_str()), (Some("ponte"), Some("ok")));
        assert_eq!(a["numeros"][0]["valor"], 3);
        assert!(p.is_none() && f.is_empty());
    }

    #[test]
    fn ponte_parada_mais_de_10_min_cai_com_pendencia_alta() {
        let agora = t("2026-11-09T19:00:00Z");
        let (a, p, _) = ponte_automacao(&Ok("active".into()), &Ok(Some(t("2026-11-09T18:45:00Z"))), agora);
        assert_eq!(a["estado"], "caido");
        let p = p.unwrap();
        assert_eq!((p["id"].as_str(), p["gravidade"].as_str(), p["origem"].as_str()), (Some("ponte:parada"), Some("alta"), Some("ponte")));
        assert_eq!(p["quando"], "2026-11-09T15:45:00-03:00");
        // Exatamente 10 min ainda é ok.
        let (a, p, _) = ponte_automacao(&Ok("active".into()), &Ok(Some(t("2026-11-09T18:50:00Z"))), agora);
        assert_eq!(a["estado"], "ok");
        assert!(p.is_none());
    }

    #[test]
    fn ponte_desligada_ou_ilegivel() {
        let agora = t("2026-11-09T19:00:00Z");
        let (a, p, f) = ponte_automacao(&Ok("failed".into()), &Ok(None), agora);
        assert_eq!(a["estado"], "caido");
        assert_eq!(p.unwrap()["id"], "ponte:desligada");
        assert!(f.is_empty());
        let (a, p, f) = ponte_automacao(&Err("o systemctl demorou demais para responder.".into()), &Err("não deu para ler o log da ponte no host.".into()), agora);
        assert_eq!(a["estado"], "desconhecido");
        assert!(p.is_none());
        assert_eq!(f.len(), 2);
        assert!(f.iter().all(|x| x.starts_with("Ponte ADB:")));
        let (a, _, _) = ponte_automacao(&Ok("active".into()), &Ok(None), agora);
        assert_eq!(a["estado"], "desconhecido");
    }

    #[test]
    fn painel_fora_devolve_so_a_ponte_e_a_falha() {
        let erro = PainelErro { code: StatusCode::BAD_GATEWAY, msg: "x".into(), sem_resposta: true };
        let ponte = ponte_automacao(&Ok("active".into()), &Ok(Some(t("2026-11-09T18:59:00Z"))), t("2026-11-09T19:00:00Z"));
        let c = mesclar_central(Err(painel_falha(&erro)), ponte, "2026-11-09T16:00:00-03:00".into());
        assert_eq!(c["automacoes"].as_array().unwrap().len(), 1);
        assert_eq!(c["automacoes"][0]["id"], "ponte");
        assert_eq!(c["falhas"], serde_json::json!(["Painel da PA FIXA não respondeu"]));
        assert_eq!(c["pendencias"], serde_json::json!([]));
        assert_eq!(c["geradoEm"], "2026-11-09T16:00:00-03:00");
        let velho = PainelErro { code: StatusCode::NOT_FOUND, msg: "Not Found".into(), sem_resposta: false };
        assert!(painel_falha(&velho).contains("atualizado"));
        let sem_cfg = PainelErro { code: StatusCode::NOT_FOUND, msg: "Painel da PA FIXA não configurado no hub.".into(), sem_resposta: false };
        assert!(painel_falha(&sem_cfg).contains("não configurado"));
    }

    #[test]
    fn modo_adb_troca_o_desconectado_da_maiara_pelo_estado_da_ponte() {
        let base = |ponte: &str| serde_json::json!({
            "automacoes": [
                {"id": "maiara", "estado": "caido", "detalhe": "WhatsApp da Maiara desconectado."},
                {"id": "ponte", "estado": ponte},
            ],
            "pendencias": [{"id": "maiara:whatsapp"}, {"id": "maiara:sem_responsavel:1"}],
        });
        let mut c = base("ok");
        ajustar_modo_adb(&mut c);
        assert_eq!(c["automacoes"][0]["estado"], "ok");
        assert_eq!(c["pendencias"].as_array().unwrap().len(), 1);
        assert_eq!(c["pendencias"][0]["id"], "maiara:sem_responsavel:1");
        let mut c = base("caido");
        ajustar_modo_adb(&mut c);
        assert_eq!(c["automacoes"][0]["estado"], "caido");
        assert!(c["automacoes"][0]["detalhe"].as_str().unwrap().contains("ponte"));
        // Robô fora do ar continua caído.
        let mut c = serde_json::json!({"automacoes": [{"id": "maiara", "estado": "caido", "detalhe": "O robô da Maiara não responde."}], "pendencias": []});
        ajustar_modo_adb(&mut c);
        assert_eq!(c["automacoes"][0]["estado"], "caido");
    }

    #[test]
    fn mescla_painel_com_a_ponte() {
        let painel = serde_json::json!({
            "geradoEm": "2026-11-09T16:00:00-03:00",
            "automacoes": [{"id": "marcela", "estado": "ok"}, {"id": "ponte", "estado": "ok"}],
            "pendencias": [{"id": "marcela:pedido:1", "origem": "marcela"}],
            "falhas": ["Robô da Marcela não respondeu"],
        });
        let ponte = ponte_automacao(&Ok("inactive".into()), &Err("não deu para ler o log da ponte no host.".into()), t("2026-11-09T19:00:00Z"));
        let c = mesclar_central(Ok(painel), ponte, "outro".into());
        let ids: Vec<&str> = c["automacoes"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["marcela", "ponte"]);
        assert_eq!(c["automacoes"][1]["estado"], "caido");
        assert_eq!(c["pendencias"][0]["id"], "ponte:desligada");
        assert_eq!(c["pendencias"][1]["id"], "marcela:pedido:1");
        assert_eq!(c["falhas"].as_array().unwrap().len(), 2);
        assert_eq!(c["geradoEm"], "2026-11-09T16:00:00-03:00");
        // Resposta que não é objeto vira falha, sem derrubar.
        let ponte = ponte_automacao(&Ok("active".into()), &Ok(None), t("2026-11-09T19:00:00Z"));
        let c = mesclar_central(Ok(serde_json::json!(["x"])), ponte, "g".into());
        assert_eq!(c["automacoes"].as_array().unwrap().len(), 1);
        assert!(c["falhas"][0].as_str().unwrap().contains("inválida"));
    }

    #[test]
    fn whitelist_das_acoes_da_central() {
        assert_eq!(central_acao_valida("pausar_marcela", &serde_json::json!({"x": 1})).unwrap(), serde_json::json!({}));
        assert!(central_acao_valida("retomar_fila_maiara", &Value::Null).is_ok());
        assert_eq!(central_acao_valida("liberar_pedido", &serde_json::json!({"pedido_id": 123})).unwrap(), serde_json::json!({"pedido_id": 123}));
        assert_eq!(central_acao_valida("liberar_pedido", &serde_json::json!({"pedido_id": " 7 "})).unwrap(), serde_json::json!({"pedido_id": 7}));
        assert!(central_acao_valida("liberar_pedido", &serde_json::json!({})).is_err());
        assert!(central_acao_valida("liberar_pedido", &serde_json::json!({"pedido_id": -1})).is_err());
        assert!(central_acao_valida("local:abrir", &Value::Null).is_err());
        assert!(central_acao_valida("apagar_tudo", &Value::Null).is_err());
        assert_eq!(central_acao_valida("dispensar_pendencia", &serde_json::json!({"id": " marcela:pedido:1 ", "y": 2})).unwrap(), serde_json::json!({"id": "marcela:pedido:1"}));
        assert!(central_acao_valida("dispensar_pendencia", &serde_json::json!({})).is_err());
        assert!(central_acao_valida("dispensar_pendencia", &serde_json::json!({"id": "a\r\nb"})).is_err());
        assert!(central_acao_valida("dispensar_pendencia", &serde_json::json!({"id": "x".repeat(201)})).is_err());
        assert!(central_acao_valida("", &Value::Null).is_err());
    }

    #[test]
    fn busca_do_devedor_so_com_digitos() {
        assert_eq!(central_q_valida("(75) 98805-2539").unwrap(), "75988052539");
        assert_eq!(central_q_valida("12.345.678/0001-99").unwrap(), "12345678000199");
        assert_eq!(central_q_valida("+55 75 98805-2539").unwrap(), "5575988052539");
        assert!(central_q_valida("98805-2539").is_err());
        assert!(central_q_valida("x&y=1").is_err());
        assert!(central_q_valida("123456789012345").is_err());
    }

    #[test]
    fn usuario_do_log_seguro_para_header() {
        assert_eq!(usuario_log(Some(" vicenzzo.palma ")), "vicenzzo.palma");
        assert_eq!(usuario_log(Some("a\r\nX-Outro: 1")), "a__X-Outro__1");
        assert_eq!(usuario_log(None), "desconhecido");
        assert!(reqwest::header::HeaderValue::from_str(&usuario_log(Some("João Ç"))).is_ok());
    }

    #[test]
    fn hora_de_brasilia() {
        assert_eq!(iso_brasilia(t("2026-11-09T19:00:00Z")), "2026-11-09T16:00:00-03:00");
    }
}
