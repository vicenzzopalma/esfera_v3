// ============================================================
// Esfera v3 — Motor de Disparos em Background (dispatcher.rs)
// DispatchCoordinator & MobileWorker com Delay Gaussiano C++ HPC
// ============================================================

use crate::adb_manager::AdbManager;
use crate::ai_engine::AiEngine;
use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::task::spawn_blocking;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, timeout, Duration};

// Sem identificação confiável da sub-rede, todos os aparelhos desta instalação
// (USB e Wi-Fi) compartilham a mesma fila conservadora.
static NETWORK_SEND_GATE: std::sync::LazyLock<AsyncMutex<Option<(i32, Instant)>>> =
    std::sync::LazyLock::new(|| AsyncMutex::new(None));
static NETWORK_LIMITED_CAMPAIGNS: std::sync::LazyLock<Mutex<std::collections::HashSet<i32>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

struct NetworkSendGuard(tokio::sync::MutexGuard<'static, Option<(i32, Instant)>>, i32);
impl Drop for NetworkSendGuard {
    fn drop(&mut self) { *self.0 = Some((self.1, Instant::now())); }
}

fn network_gap(last: Option<(i32, u64)>, device_id: i32, interval: u64) -> u64 {
    match last {
        Some((previous, elapsed)) if previous != device_id => interval.saturating_sub(elapsed),
        _ => 0,
    }
}

static CAMPAIGN_DEVICE_INDEX: std::sync::LazyLock<Mutex<HashMap<i32, usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static KEEPALIVE_LAST_ATTEMPT: std::sync::LazyLock<Mutex<HashMap<String, (i64, bool)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
#[allow(dead_code)]
static SEND_DEVICE_PREPARED: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static DEVICE_SEND_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Mesmo bloqueio para disparo, confirmação e instalação do agente.
fn device_lock_for_key(key: &str) -> Arc<AsyncMutex<()>> {
    let mut locks = DEVICE_SEND_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(key.to_string()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone()
}

pub fn device_operation_lock_for_id(id: i32) -> Arc<AsyncMutex<()>> {
    device_lock_for_key(&format!("device:{}", id))
}

/// O botão manual e o provisionamento podem receber serial USB ou endereço Wi-Fi.
pub fn device_operation_lock(serial: &str) -> Result<Arc<AsyncMutex<()>>, String> {
    use rusqlite::OptionalExtension;
    let conn = rusqlite::Connection::open_with_flags(crate::get_db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("Não foi possível verificar o aparelho: {}",e))?;
    conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let id: Option<i32> = conn.query_row("SELECT rowid FROM ESF_Device WHERE AdbDeviceId=?1 OR CurrentAdbAddress=?1 OR EsferaDeviceId=?1 LIMIT 1", [serial], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    Ok(match id { Some(id) => device_operation_lock_for_id(id), None => device_lock_for_key(&format!("serial:{}",serial)) })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateStatus {
    pub device_id: String,
    pub company_id: i32,
    pub version_code: Option<u32>,
    pub version_name: String,
    pub expected_code: u32,
    pub status: String,
    pub detail: String,
}
#[derive(Default)]
struct AgentMonitorState {
    statuses: HashMap<String, AgentUpdateStatus>,
    last_check: HashMap<String, Instant>,
    inflight: std::collections::HashSet<String>,
    online: std::collections::HashSet<String>,
    last_logged: HashMap<String, String>,
}
static AGENT_MONITOR: std::sync::LazyLock<Mutex<AgentMonitorState>> = std::sync::LazyLock::new(|| Mutex::new(AgentMonitorState::default()));

pub fn agent_update_statuses(company: i32) -> Vec<AgentUpdateStatus> {
    AGENT_MONITOR.lock().map(|m| m.statuses.values().filter(|s| s.company_id == company).cloned().collect()).unwrap_or_default()
}

fn update_agent_status(db: &Database, key: &str, status: AgentUpdateStatus, audit: bool) {
    let mut log = None;
    if let Ok(mut state) = AGENT_MONITOR.lock() {
        if audit {
            let fingerprint = format!("{}:{}:{}", status.status, status.version_code.unwrap_or(0), status.detail);
            if state.last_logged.get(key) != Some(&fingerprint) {
                state.last_logged.insert(key.to_string(), fingerprint);
                log = Some(format!("Aparelho {}: {}",status.device_id,status.detail));
            }
        }
        state.statuses.insert(key.to_string(), status.clone());
    }
    if let Some(message)=log { db.queue_add_log(status.company_id, if status.status=="error" {"error"} else {"info"}, "Agente Android", &message); }
}

/// Contatos temporários já salvos na agenda de cada aparelho ("serial|digitos").
static TEMP_CONTACTS: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

// ============================================================
// Contatos temporários da campanha
// Cada disparo salva os contatos na agenda do aparelho (conta isolada "esfera_temp",
// que não mistura com os contatos do operador) para o WhatsApp achar a conversa pela
// busca interna. Ao concluir ou parar a campanha, eles são apagados.
// ============================================================

/// Uma importação de "SAIR" por vez (o laço de 30 s e as checagens antes do envio não se atropelam).
static OPT_OUT_IMPORT_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static DEVICE_UNAVAILABLE_UNTIL: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn opt_out_device_lock(serial: &str) -> Arc<Mutex<()>> {
    let mut locks = OPT_OUT_IMPORT_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(serial.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Importa os pedidos de descadastro gravados pelo agente em cada aparelho online.
pub fn import_opt_out_requests(db: &Database) {
    for dev in db.get_all_devices().into_iter().filter(|d| d.status == "online") {
        let serial = dev.current_adb_address.clone().filter(|a| !a.trim().is_empty()).unwrap_or(dev.serial.clone());
        sync_opt_out_from_device(db, &serial, dev.company_id);
    }
}

/// Importa os "SAIR" de um aparelho. O arquivo é movido para `.reading` antes de ler (linhas novas
/// caem num arquivo novo) e só é apagado depois que todas as linhas foram gravadas no banco. Se a
/// conexão cair no meio, o `.reading` fica e é lido de novo na próxima vez (o registro não duplica).
pub fn import_opt_out_from_device(db: &Database, serial: &str, company_id: i32) -> bool {
    let lock = opt_out_device_lock(serial);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    read_device_opt_out(db, serial, company_id).is_ok()
}

/// A sincronização HTTP ocorre fora do bloqueio usado pela verificação anterior a cada envio.
fn sync_opt_out_from_device(db: &Database, serial: &str, company_id: i32) {
    let lock = opt_out_device_lock(serial);
    let batch = {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        match read_device_opt_out(db, serial, company_id) { Ok(batch) => batch, Err(_) => return }
    };
    if batch.trim().is_empty() || !forward_device_messages(db, serial, company_id, &batch) { return; }
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    // O arquivo só é removido se ainda for o mesmo lote que recebeu ACK do VEXOR.
    let current = AdbManager::execute_shell(serial, "if [ -f /sdcard/esfera_optout.reading ]; then cat /sdcard/esfera_optout.reading; fi", 6);
    if current.as_deref() == Ok(batch.as_str()) {
        let _ = AdbManager::execute_shell(serial, "rm -f /sdcard/esfera_optout.reading", 4);
    }
}

fn read_device_opt_out(db: &Database, serial: &str, company_id: i32) -> Result<String, String> {
    let listener = AdbManager::execute_shell(serial, "settings get secure enabled_notification_listeners", 6)
        .map(|s| s.contains("com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener"))
        .unwrap_or(false);
    db.set_reply_capture(company_id, serial, listener)?;
    let out = AdbManager::execute_shell(serial,
        "if [ ! -s /sdcard/esfera_optout.reading ] && [ -s /sdcard/esfera_optout.jsonl ]; then mv /sdcard/esfera_optout.jsonl /sdcard/esfera_optout.reading; fi; if [ -f /sdcard/esfera_optout.reading ]; then cat /sdcard/esfera_optout.reading; fi", 6)?;
    let newer = AdbManager::execute_shell(serial, "if [ -f /sdcard/esfera_optout.jsonl ]; then cat /sdcard/esfera_optout.jsonl; fi", 6)?;
    if !process_opt_out_jsonl(db, serial, company_id, &out, None) || !process_opt_out_jsonl(db, serial, company_id, &newer, None) {
        return Err("Não foi possível registrar os pedidos de descadastro".into());
    }
    Ok(out)
}

/// Texto aprovado, mantido íntegro para revisões que chegam depois pelo endpoint do Esfera.
pub const OPT_OUT_CONFIRMATION_TEXT: &str = "Pronto, seu número foi retirado das nossas mensagens automáticas. Você não receberá mais avisos por este canal, conforme o seu direito de oposição previsto na LGPD (Lei 13.709/2018, art. 18) e as regras de cobrança do Código de Defesa do Consumidor.\nEste pedido não altera e não reconhece nenhum débito.";

fn forward_device_messages(db: &Database, serial: &str, company: i32, lines: &str) -> bool {
    let token = crate::config::vexor_token();
    if token.trim().is_empty() { eprintln!("[SAIR] Token da integração não configurado; mensagens mantidas no aparelho."); return false; }
    forward_device_messages_at(db, serial, company, lines, token.trim(), "http://127.0.0.1:4000/esfera/device-messages")
}

fn forward_device_messages_at(db: &Database, serial: &str, company: i32, lines: &str, token: &str, endpoint: &str) -> bool {
    use sha2::{Digest, Sha256};
    let client = match reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(10)).build() { Ok(c) => c, Err(_) => return false };
    let stable_serial = db.get_all_devices().into_iter().find(|d| d.company_id == company && (d.serial == serial || d.current_adb_address.as_deref() == Some(serial))).map(|d| d.esfera_device_id.filter(|s| !s.trim().is_empty()).unwrap_or(d.serial)).unwrap_or_else(|| serial.to_string());
    let device: String = stable_serial.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-')).take(64).collect();
    let device = if device.is_empty() { "celular" } else { &device };
    for line in lines.lines().filter(|l| l.trim().starts_with('{')) {
        let v: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => return false };
        let title = v.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let phone = AdbManager::extract_phone_digits(title);
        if phone.len() < 10 {
            if local_opt_out(text) && db.add_opt_out_review(company,title,text,serial).is_err() { return false; }
            continue;
        }
        let id = hex::encode(Sha256::digest(format!("{}|{}",device,line).as_bytes()));
        let event = format!("device:{}:{}",device,id);
        if db.remember_device_inbound(&event,company,&phone,&stable_serial,OPT_OUT_CONFIRMATION_TEXT).is_err() { return false; }
        use chrono::TimeZone;
        let received_at = v.get("ts").and_then(|x| x.as_i64()).and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()).map(|t| t.to_rfc3339());
        let mut message = serde_json::json!({"id":id,"from":phone,"text":text,"device":device});
        if let Some(t) = received_at { message["receivedAt"] = t.into(); }
        let body = serde_json::json!({"messages":[message]});
        let response = match client.post(endpoint)
            .bearer_auth(token.trim()).header("X-Esfera-Company",company.to_string()).json(&body).send() {
            Ok(r) if r.status().is_success() => r, _ => return false,
        };
        let result: serde_json::Value = match response.json() { Ok(v) => v, Err(_) => return false };
        let item = match result.get("results").and_then(|v| v.as_array()).and_then(|a| a.iter().find(|r| r.get("id").and_then(|x|x.as_str()) == Some(id.as_str()))) { Some(v) => v, None => return false };
        match item.get("decision").and_then(|v| v.as_str()) {
            Some("OPT_OUT") => {
                if item.get("confirmationText").and_then(|v|v.as_str()) != Some(OPT_OUT_CONFIRMATION_TEXT) { return false; }
                match db.record_opt_out_event(&event,company,&phone,"celular","Pedido pelo WhatsApp","") {
                    Ok(outcome) if outcome.same_company && outcome.phone_key == Database::opt_out_key(&phone) => (),
                    _ => return false,
                }
            }
            Some("REVIEW") | Some("NONE") => (),
            _ => return false,
        }
    }
    true
}

/// Classificação local conservadora para proteger o descadastro sem depender da rede.
fn local_opt_out(text: &str) -> bool {
    let mut normalized = String::new();
    for c in text.to_lowercase().chars() {
        let c = match c {
            'á'|'à'|'â'|'ã'|'ä' => 'a', 'é'|'è'|'ê'|'ë' => 'e',
            'í'|'ì'|'î'|'ï' => 'i', 'ó'|'ò'|'ô'|'õ'|'ö' => 'o',
            'ú'|'ù'|'û'|'ü' => 'u', 'ç' => 'c', _ => c,
        };
        if c.is_alphanumeric() { normalized.push(c); } else { normalized.push(' '); }
    }
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.is_empty() { return false; }
    // Um pedido explícito de SAIR permanece válido mesmo em mensagem mais longa.
    if words.contains(&"sair") { return true; }
    if words.len() > 8 { return false; }
    let phrase = words.join(" ");
    let phrases = ["sair", "parar", "pare", "stop", "cancelar", "descadastrar", "nao quero mais receber", "remover meu numero",
        "quero sair", "quero parar", "pode parar", "pare de enviar", "pare de mandar", "parar de enviar", "parar de mandar",
        "nao envie mais", "nao mande mais", "nao me envie mais mensagens", "nao quero receber", "nao quero receber mensagens",
        "nao quero mais receber mensagens", "nao quero mais mensagens", "cancelar mensagens", "cancelar envio", "quero cancelar",
        "quero me descadastrar", "me descadastrar", "me descadastre", "descadastre meu numero", "remova meu numero",
        "excluir meu numero", "exclua meu numero", "retirar meu numero", "retire meu numero", "remover numero", "remova meu contato",
        "cancela", "descadastra", "remover", "remove", "me tira dessa lista", "me tire dessa lista", "me tira da lista", "me tire da lista",
        "tira meu numero", "tire meu numero", "nao quero mais", "nao quero", "nao tenho interesse", "sem interesse", "sair por favor",
        "por favor sair", "quero sair da lista", "sair da lista", "me remove", "me remova", "me exclua",
        "nao quero mais receber essas mensagens", "pare de me mandar mensagem", "parem de mandar", "parem de enviar",
        "pode tirar meu numero", "quero sair dessa lista", "sair dessa lista"];
    if phrases.contains(&phrase.as_str()) || phrase.starts_with("sair ") { return true; }
    if words.len() != 1 { return false; }
    let mut collapsed = String::new();
    for c in phrase.chars() { if !collapsed.ends_with(c) { collapsed.push(c); } }
    if collapsed == "sair" { return true; }
    if !collapsed.starts_with('s') || collapsed.len() < 3 || collapsed.len() > 8 { return false; }
    let a: Vec<char> = collapsed.chars().collect(); let b: Vec<char> = "sair".chars().collect();
    let mut d = vec![vec![0usize; b.len()+1]; a.len()+1];
    for i in 0..=a.len() { d[i][0]=i; }
    for j in 0..=b.len() { d[0][j]=j; }
    for i in 1..=a.len() { for j in 1..=b.len() {
        d[i][j] = (d[i-1][j]+1).min(d[i][j-1]+1).min(d[i-1][j-1]+usize::from(a[i-1]!=b[j-1]));
        if i>1 && j>1 && a[i-1]==b[j-2] && a[i-2]==b[j-1] { d[i][j]=d[i][j].min(d[i-2][j-2]+1); }
    }}
    d[a.len()][b.len()] <= 1
}

/// Processa linhas JSONL de descadastro vindas do agente Android.
/// Quando o remetente não tem número identificável, grava na tabela `ESF_OptOutReview` do banco;
/// mantém a gravação no arquivo `descadastro_revisar.jsonl` apenas como reserva se o banco falhar.
pub fn process_opt_out_jsonl(
    db: &Database,
    serial: &str,
    company_id: i32,
    out: &str,
    fallback_file: Option<&std::path::Path>,
) -> bool {
    let mut all_saved = true;
    for line in out.lines().filter(|l| l.trim().starts_with('{')) {
        let v: serde_json::Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => { all_saved = false; continue; },
        };
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
        // Guarda localmente cada resposta identificável, independente do VEXOR.
        let phone = AdbManager::extract_phone_digits(title);
        if phone.len() >= 10 {
            use sha2::{Digest, Sha256};
            use chrono::TimeZone;
            if let Some(when) = v.get("ts").and_then(|t| t.as_i64()).and_then(|ms| chrono::Utc.timestamp_millis_opt(ms).single()) {
                let stable = db.get_all_devices().into_iter().find(|d| d.company_id == company_id && (d.serial == serial || d.current_adb_address.as_deref() == Some(serial) || d.esfera_device_id.as_deref() == Some(serial))).map(|d| d.esfera_device_id.filter(|s| !s.is_empty()).unwrap_or(d.serial)).unwrap_or_else(|| serial.to_string());
                let id = hex::encode(Sha256::digest(format!("{}|{}|{}", company_id, stable, line.trim()).as_bytes()));
                if db.remember_reply(&id, company_id, serial, &phone, &when.format("%Y-%m-%d %H:%M:%S").to_string()).is_err() { all_saved = false; }
            }
        }
        if !local_opt_out(text) { continue; }
        // O remetente vem no título: número sem contato salvo ou o contato temporário "Esfera <número>".
        let digits = AdbManager::extract_phone_digits(title);
        if digits.len() < 10 {
            // Grava no banco para revisão na interface; usa o arquivo JSONL só como reserva se o banco falhar.
            match db.add_opt_out_review(company_id, title, text, serial) {
                Ok(_) => {
                    eprintln!(
                        "[DESCADASTRO] Pedido sem número identificável (título '{}', aparelho '{}'); gravado no banco para revisão.",
                        title, serial
                    );
                }
                Err(e) => {
                    let target_path = match fallback_file {
                        Some(p) => p.to_path_buf(),
                        None => {
                            let dir = std::env::var_os("LOCALAPPDATA")
                                .map(std::path::PathBuf::from)
                                .unwrap_or_else(std::env::temp_dir)
                                .join("esfera_v3");
                            let _ = std::fs::create_dir_all(&dir);
                            dir.join("descadastro_revisar.jsonl")
                        }
                    };
                    if let Some(parent) = target_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&target_path) {
                        use std::io::Write;
                        let _ = writeln!(f, "{}", line.trim());
                    } else {
                        all_saved = false;
                    }
                    eprintln!(
                        "[DESCADASTRO] Falha ao gravar revisão no banco ({}); salvo em {:?} como reserva.",
                        e, target_path
                    );
                }
            }
            continue;
        }
        let reason = format!("Respondeu \"{}\" no WhatsApp", text.chars().take(40).collect::<String>());
        match db.add_opt_out(company_id, &digits, &reason) {
            Ok(()) => {
                let n = db.suppress_pending_for_opt_out(company_id, &digits);
                println!("[DESCADASTRO] {} descadastrado automaticamente ({} envio(s) pendente(s) cancelado(s)).", digits, n);
            }
            Err(e) => {
                all_saved = false;
                eprintln!("[DESCADASTRO] Falha ao registrar {}: {}", digits, e);
            }
        }
    }
    all_saved
}

fn confirmation_allowed(within_window: bool, device_busy: bool) -> bool {
    within_window && !device_busy
}

/// Janela de envio no horário local do PC: seg-sex 08:00-20:00, sábado 08:00-14:00, domingo fechado.
pub fn within_send_window() -> bool {
    use chrono::{Datelike, Timelike};
    let now = chrono::Local::now();
    send_window_at(now.weekday(), now.hour())
}

fn send_window_at(day: chrono::Weekday, h: u32) -> bool {
    use chrono::Weekday;
    match day {
        Weekday::Sun => false,
        Weekday::Sat => (8..14).contains(&h),
        _ => (8..20).contains(&h),
    }
}

/// Nome do contato temporário: contém o número, para a busca conferir que é a pessoa certa.
pub fn temp_contact_name(phone: &str) -> String {
    format!("Esfera {}", AdbManager::extract_phone_digits(phone))
}

/// Quando cada contato temporário foi salvo ("serial|digitos"), para dar ao WhatsApp o tempo
/// de indexar só o que falta, e quem está salvando agora (a semeadura e o envio não duplicam).
static TEMP_CONTACT_SAVED_AT: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static TEMP_CONTACTS_INFLIGHT: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
/// Aparelhos cuja conta `esfera_temp` já foi consultada nesta execução do app.
static TEMP_CONTACTS_LOADED_DEVICES: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
static TEMP_CONTACTS_LOAD_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Tempo que o WhatsApp leva para achar na busca um contato recém-salvo.
const TEMP_CONTACT_INDEX_MS: u64 = 2500;

fn temp_key(serial: &str, phone: &str) -> String {
    format!("{}|{}", serial, AdbManager::extract_phone_digits(phone))
}

/// Na primeira chamada por aparelho após iniciar o app, carrega uma única vez os contatos
/// já existentes na conta `esfera_temp` do aparelho para não duplicar contatos "Esfera <número>".
fn ensure_device_temp_contacts_loaded_with<L>(serial: &str, loader: L)
where
    L: FnOnce(&str) -> Result<Vec<String>, String>,
{
    if TEMP_CONTACTS_LOADED_DEVICES.lock().map(|s| s.contains(serial)).unwrap_or(false) {
        return;
    }
    let lock = {
        let mut locks = TEMP_CONTACTS_LOAD_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(serial.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    };
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if TEMP_CONTACTS_LOADED_DEVICES.lock().map(|s| s.contains(serial)).unwrap_or(false) {
        return;
    }
    if let Ok(existing_names) = loader(serial) {
        if let Ok(mut s) = TEMP_CONTACTS.lock() {
            for name in existing_names {
                let digits = AdbManager::extract_phone_digits(&name);
                if !digits.is_empty() {
                    s.insert(format!("{}|{}", serial, digits));
                }
            }
        }
        if let Ok(mut loaded) = TEMP_CONTACTS_LOADED_DEVICES.lock() {
            loaded.insert(serial.to_string());
        }
    }
}

/// Salva o contato no aparelho se ainda não estiver salvo. Retorna true se acabou de criar.
/// Se outra thread (a semeadura) está salvando o mesmo contato, espera ela em vez de duplicar.
pub fn ensure_temp_contact(serial: &str, phone: &str) -> bool {
    ensure_temp_contact_with(
        serial,
        phone,
        AdbManager::list_temporary_contact_names,
        AdbManager::insert_temporary_contact,
    )
}

pub fn ensure_temp_contact_with<L, I>(serial: &str, phone: &str, loader: L, inserter: I) -> bool
where
    L: FnOnce(&str) -> Result<Vec<String>, String>,
    I: FnOnce(&str, &str, &str) -> Result<Option<i64>, String>,
{
    ensure_device_temp_contacts_loaded_with(serial, loader);
    let key = temp_key(serial, phone);
    let waited_since = Instant::now();
    loop {
        if TEMP_CONTACTS.lock().map(|s| s.contains(&key)).unwrap_or(false) {
            return false;
        }
        let claimed = TEMP_CONTACTS_INFLIGHT.lock().map(|mut s| s.insert(key.clone())).unwrap_or(true);
        if claimed {
            break;
        }
        if waited_since.elapsed() > std::time::Duration::from_secs(20) {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let created = match inserter(serial, &temp_contact_name(phone), phone) {
        Ok(Some(_)) => {
            if let Ok(mut s) = TEMP_CONTACTS.lock() {
                s.insert(key.clone());
            }
            if let Ok(mut m) = TEMP_CONTACT_SAVED_AT.lock() {
                m.insert(key.clone(), Instant::now());
            }
            true
        }
        Ok(None) => {
            eprintln!("[CONTATOS TEMP] Não foi possível salvar {} em {}", phone, serial);
            false
        }
        Err(e) => {
            eprintln!("[CONTATOS TEMP] Erro ao salvar {} em {}: {}", phone, serial, e);
            false
        }
    };
    if let Ok(mut s) = TEMP_CONTACTS_INFLIGHT.lock() {
        s.remove(&key);
    }
    created
}

/// Antes do envio: garante o contato salvo e espera só o que falta para o WhatsApp indexá-lo.
/// Contato salvo há mais de 2,5 s (pela semeadura) não espera nada.
pub fn prepare_temp_contact_for_send(serial: &str, phone: &str) {
    ensure_temp_contact(serial, phone);
    let key = temp_key(serial, phone);
    let saved_at = TEMP_CONTACT_SAVED_AT.lock().ok().and_then(|m| m.get(&key).copied());
    if let Some(at) = saved_at {
        let need = std::time::Duration::from_millis(TEMP_CONTACT_INDEX_MS);
        let elapsed = at.elapsed();
        if elapsed < need {
            std::thread::sleep(need - elapsed);
        }
    }
}

/// Endereços ADB atuais dos aparelhos online selecionados na campanha.
fn campaign_device_serials(db: &Database, company_id: i32, device_ids: &[String]) -> Vec<String> {
    db.get_devices(company_id)
        .into_iter()
        .filter(|d| {
            d.status == "online"
                && device_ids.iter().any(|id| d.esfera_device_id.as_deref() == Some(id.as_str()) || d.serial == *id)
        })
        .map(|d| d.current_adb_address.filter(|a| !a.trim().is_empty()).unwrap_or(d.serial))
        .collect()
}

/// Ao iniciar: salva em segundo plano todos os contatos pendentes nos aparelhos da campanha.
pub fn seed_campaign_contacts(db: Arc<Database>, campaign_id: i32, company_id: i32, device_ids: Vec<String>) {
    std::thread::spawn(move || {
        let serials = campaign_device_serials(&db, company_id, &device_ids);
        let contacts = db.get_pending_contacts(campaign_id, 100_000);
        let mut created = 0;
        for serial in &serials {
            for c in &contacts {
                if ensure_temp_contact(serial, &c.phone) {
                    created += 1;
                }
            }
        }
        println!("[CONTATOS TEMP] Campanha {}: {} contatos salvos em {} aparelho(s).", campaign_id, created, serials.len());
    });
}

/// Ao concluir/parar: apaga todos os contatos temporários dos aparelhos da campanha.
pub fn cleanup_campaign_contacts(db: Arc<Database>, company_id: i32, device_ids: Vec<String>) {
    std::thread::spawn(move || {
        for serial in campaign_device_serials(&db, company_id, &device_ids) {
            let _ = AdbManager::cleanup_all_temporary_contacts(&serial);
            if let Ok(mut s) = TEMP_CONTACTS.lock() {
                s.retain(|k| !k.starts_with(&format!("{}|", serial)));
            }
            if let Ok(mut m) = TEMP_CONTACT_SAVED_AT.lock() {
                m.retain(|k, _| !k.starts_with(&format!("{}|", serial)));
            }
            println!("[CONTATOS TEMP] Contatos temporários apagados de {}.", serial);
        }
    });
}

/// Mensagens geradas antecipadamente (campanha, contato) enquanto o disparo anterior pausa.
static PREFETCHED_MESSAGES: std::sync::LazyLock<Mutex<HashMap<(i32, i32), (u64, tokio::task::JoinHandle<String>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Impressão digital do que muda o texto (mensagem, spintax, IA): a pré-carga feita com a versão
/// antiga da campanha (editada entre a pausa e o envio) é descartada.
fn campaign_fingerprint(c: &crate::db::Campaign) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&c.greeting, &c.message, &c.closing, c.use_spintax, c.use_ai, &c.ai_provider, &c.ai_model, &c.ai_prompt).hash(&mut h);
    h.finish()
}

/// Variações de IA por parte guardadas por campanha. Cada contato recebe uma combinação ainda não
/// usada (12 versões de cada parte = 1.728 combinações). Só chama a IA enquanto faltar versão,
/// então os planos gratuitos não esgotam, e a IA reescreve com {nome}, sem o nome do devedor.
const AI_VARIANTS_PER_PART: usize = 12;

#[derive(Default)]
struct VariantPool {
    parts: Vec<Vec<String>>,
    used: std::collections::HashSet<Vec<usize>>,
}

static AI_VARIANT_POOLS: std::sync::LazyLock<Mutex<HashMap<(i32, u64), VariantPool>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Texto da campanha com o spintax resolvido, mantendo {nome} para a IA (o spintax trataria
/// "{nome}" como bloco de uma variante só).
fn base_with_name_placeholder(campaign: &crate::db::Campaign) -> String {
    let mut full = String::new();
    if !campaign.greeting.trim().is_empty() {
        full.push_str(&campaign.greeting);
        full.push_str("\n\n");
    }
    full.push_str(&campaign.message);
    if !campaign.closing.trim().is_empty() {
        full.push_str("\n\n");
        full.push_str(&campaign.closing);
    }
    let full = AiEngine::normalize_name_variables(&full);
    if !campaign.use_spintax {
        return full;
    }
    const MARK: &str = "\u{1}NOME\u{1}";
    crate::spintax::resolve_spintax(&full.replace("{nome}", MARK)).replace(MARK, "{nome}")
}

/// Guarda a versão nova (se veio) e escolhe uma combinação ainda não usada nesta campanha.
fn pool_store(pool: &mut VariantPool, parts: Vec<String>) {
    if pool.parts.is_empty() { pool.parts = vec![Vec::new(); parts.len()]; }
    if pool.parts.len() == parts.len() {
        for (versions, text) in pool.parts.iter_mut().zip(parts) {
            if versions.len() < AI_VARIANTS_PER_PART && !versions.contains(&text) { versions.push(text); }
        }
    }
}

/// Escolhe uma combinacao ainda nao usada nesta campanha.
fn pool_take(pool: &mut VariantPool, fresh: Option<Vec<String>>) -> Option<Vec<String>> {
    if let Some(parts) = fresh {
        if pool.parts.is_empty() {
            pool.parts = vec![Vec::new(); parts.len()];
        }
        if pool.parts.len() == parts.len() {
            let mut combo = Vec::with_capacity(parts.len());
            for (i, text) in parts.into_iter().enumerate() {
                let idx = match pool.parts[i].iter().position(|t| *t == text) {
                    Some(j) => j,
                    None => {
                        pool.parts[i].push(text);
                        pool.parts[i].len() - 1
                    }
                };
                combo.push(idx);
            }
            if pool.used.insert(combo.clone()) {
                return Some(combo.iter().enumerate().map(|(i, &j)| pool.parts[i][j].clone()).collect());
            }
        }
    }
    if pool.parts.is_empty() || pool.parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let total: usize = pool.parts.iter().map(|p| p.len()).product();
    if pool.used.len() >= total {
        // Todas as combinações já saíram (só com campanha maior que o banco): recomeça.
        pool.used.clear();
    }
    let pick = |combo: &[usize]| -> Vec<String> { combo.iter().enumerate().map(|(i, &j)| pool.parts[i][j].clone()).collect() };
    for _ in 0..200 {
        let combo: Vec<usize> = pool.parts.iter().map(|p| rand::random::<usize>() % p.len()).collect();
        if !pool.used.contains(&combo) {
            let out = pick(&combo);
            pool.used.insert(combo);
            return Some(out);
        }
    }
    // Varredura completa (banco quase todo usado).
    let sizes: Vec<usize> = pool.parts.iter().map(|p| p.len()).collect();
    for n in 0..total {
        let mut rest = n;
        let combo: Vec<usize> = sizes
            .iter()
            .map(|&len| {
                let i = rest % len;
                rest /= len;
                i
            })
            .collect();
        if !pool.used.contains(&combo) {
            let out = pick(&combo);
            pool.used.insert(combo);
            return Some(out);
        }
    }
    None
}

// Uma tarefa por versao de campanha. O intervalo impede novas tentativas em rajada
// quando os provedores falham ou retornam sempre a mesma resposta.
#[derive(Default)]
struct PoolWorkers {
    entries: HashMap<(i32, u64), (bool, std::time::Instant)>,
    current: HashMap<i32, u64>,
}

impl PoolWorkers {
    fn start(&mut self, key: (i32, u64)) -> bool {
        self.current.insert(key.0, key.1);
        self.entries.retain(|&(id, fingerprint), (running, _)|
            id != key.0 || fingerprint == key.1 || *running);
        if let Some((running, last)) = self.entries.get(&key) {
            if *running || last.elapsed() < Duration::from_secs(30) { return false; }
        }
        self.entries.insert(key, (true, std::time::Instant::now()));
        true
    }

    fn is_current(&self, key: (i32, u64)) -> bool {
        self.current.get(&key.0) == Some(&key.1)
    }

    fn finish(&mut self, key: (i32, u64)) {
        if self.is_current(key) {
            if let Some(state) = self.entries.get_mut(&key) {
                *state = (false, std::time::Instant::now());
            }
        } else {
            self.entries.remove(&key);
        }
    }
}

static AI_POOL_WORKERS: std::sync::LazyLock<Mutex<PoolWorkers>> =
    std::sync::LazyLock::new(|| Mutex::new(PoolWorkers::default()));

struct PoolWorkerGuard((i32, u64));
impl Drop for PoolWorkerGuard {
    fn drop(&mut self) {
        if let Ok(mut workers) = AI_POOL_WORKERS.lock() { workers.finish(self.0); }
    }
}

fn schedule_ai_pool(db: Arc<Database>, campaign: crate::db::Campaign) {
    let key = (campaign.id, campaign_fingerprint(&campaign));
    let needs_more = AI_VARIANT_POOLS.lock().map(|pools| pools.get(&key).map_or(true, |p|
        p.parts.is_empty() || p.parts.iter().any(|v| v.len() < AI_VARIANTS_PER_PART)
    )).unwrap_or(false);
    if !needs_more { return; }
    let Ok(mut workers) = AI_POOL_WORKERS.lock() else { return; };
    if !workers.start(key) { return; }
    // Sob a mesma trava, invalida gravacoes de trabalhadores de versoes antigas.
    if let Ok(mut pools) = AI_VARIANT_POOLS.lock() {
        pools.retain(|&(id, fingerprint), _| id != key.0 || fingerprint == key.1);
    }
    drop(workers);
    tauri::async_runtime::spawn(async move {
        let _guard = PoolWorkerGuard(key);
        let db2 = db.clone();
        let campaign2 = campaign.clone();
        let chain = match spawn_blocking(move || {
            let mut config = db2.get_ai_config(campaign2.company_id).unwrap_or_else(|| crate::db::AiConfig {
                company_id: campaign2.company_id,
                provider: if campaign2.ai_provider.is_empty() { "groq".to_string() } else { campaign2.ai_provider.clone() },
                model: if campaign2.ai_model.is_empty() { "openai/gpt-oss-120b".to_string() } else { campaign2.ai_model.clone() },
                temperature: 0.7, system_prompt: String::new(), api_key: String::new(), endpoint: String::new(),
            });
            if !campaign2.ai_provider.is_empty() && campaign2.ai_provider != config.provider {
                config.provider = campaign2.ai_provider.clone();
                config.endpoint = String::new();
                if let Some((saved_key, saved_ep, saved_model)) = db2.get_ai_provider_key(campaign2.company_id, &campaign2.ai_provider) {
                    config.api_key = saved_key;
                    if !saved_ep.is_empty() { config.endpoint = saved_ep; }
                    if !saved_model.is_empty() && campaign2.ai_model.trim().is_empty() { config.model = saved_model; }
                } else { config.api_key = String::new(); }
            }
            if !campaign2.ai_model.trim().is_empty() { config.model = campaign2.ai_model.clone(); }
            if !campaign2.ai_prompt.trim().is_empty() { config.system_prompt = campaign2.ai_prompt.clone(); }
            build_ai_fallback_chain(&db2, campaign2.company_id, &config)
        }).await {
            Ok(chain) => chain,
            Err(_) => return,
        };
        let total_timeout_secs = if chain.iter().any(|c| c.provider.eq_ignore_ascii_case("gemini_web") || c.provider.eq_ignore_ascii_case("vps_ia")) { 180 } else { 45 };
        // Numero finito de tentativas mesmo se a IA sempre devolver texto repetido.
        for _ in 0..AI_VARIANTS_PER_PART {
            let needs_more = AI_POOL_WORKERS.lock().map(|workers| {
                workers.is_current(key) && AI_VARIANT_POOLS.lock().map(|pools| pools.get(&key).map_or(true, |p|
                    p.parts.is_empty() || p.parts.iter().any(|v| v.len() < AI_VARIANTS_PER_PART)
                )).unwrap_or(false)
            }).unwrap_or(false);
            if !needs_more { break; }
            let base = base_with_name_placeholder(&campaign);
            match timeout(Duration::from_secs(total_timeout_secs), AiEngine::rewrite_parts(&chain, &base)).await {
                Ok(Ok(parts)) => {
                    let Ok(workers) = AI_POOL_WORKERS.lock() else { break; };
                    if !workers.is_current(key) { break; }
                    if let Ok(mut pools) = AI_VARIANT_POOLS.lock() {
                        pool_store(pools.entry(key).or_default(), parts);
                    } else { break; }
                }
                Ok(Err(error)) => { eprintln!("[DISPATCHER IA] Falha ao preencher banco: {}", error); break; }
                Err(_) => { eprintln!("[DISPATCHER IA] Tempo limite ao preencher banco"); break; }
            }
        }
    });
}

fn pooled_ai_message(campaign: &crate::db::Campaign, contact_name: &str) -> Option<String> {
    let key = (campaign.id, campaign_fingerprint(campaign));
    let mut pools = AI_VARIANT_POOLS.lock().ok()?;
    let parts = pool_take(pools.get_mut(&key)?, None)?;
    Some(AiEngine::replace_contact_name(&parts.join("\n\n"), contact_name))
}

/// Monta a cadeia de reserva de IA:
/// Groq 120b -> Groq 20b -> IA própria da VPS -> gemini_web (quando conectado) -> Cerebras -> OpenRouter -> openrouter/free.
pub fn build_ai_fallback_chain(
    db: &Database,
    company_id: i32,
    config: &crate::db::AiConfig,
) -> Vec<crate::db::AiConfig> {
    let mut chain = vec![config.clone()];
    // IA da VPS escolhida como principal: token/endereço vêm da configuração salva (Integrações/hub).
    if config.provider.eq_ignore_ascii_case("vps_ia") {
        if let Some((key, ep, model)) = db.get_ai_provider_key(company_id, "vps_ia") {
            if chain[0].api_key.trim().is_empty() {
                chain[0].api_key = key;
            }
            if chain[0].endpoint.trim().is_empty() && !ep.trim().is_empty() {
                chain[0].endpoint = ep;
            }
            if chain[0].model.trim().is_empty() && !model.trim().is_empty() {
                chain[0].model = model;
            }
        }
    }
    for alt in ["groq", "cerebras", "openrouter"] {
        if alt == config.provider.to_lowercase() {
            continue;
        }
        if let Some((key, ep, model)) = db.get_ai_provider_key(company_id, alt) {
            if key.trim().is_empty() {
                continue;
            }
            let mut alt_cfg = config.clone();
            alt_cfg.provider = alt.to_string();
            alt_cfg.api_key = key;
            alt_cfg.endpoint = ep;
            alt_cfg.model = model;
            chain.push(alt_cfg);
        }
    }
    // O Groq conta o limite diário por modelo: se o principal esgotar, tenta o gpt-oss-20b
    // com a mesma chave antes de passar para outro provedor.
    if let Some(pos) = chain
        .iter()
        .position(|c| c.provider.eq_ignore_ascii_case("groq") && !c.model.contains("gpt-oss-20b"))
    {
        let mut small = chain[pos].clone();
        small.model = "openai/gpt-oss-20b".to_string();
        chain.insert(pos + 1, small);
    }
    // Gemini Web (login Google sem chave de API): entra logo depois do Groq (120b -> 20b -> gemini_web)
    // quando o usuário tiver conectado na aba Integrações.
    if !chain.iter().any(|c| c.provider.eq_ignore_ascii_case("gemini_web")) {
        if let Some((key, ep, model)) = db.get_ai_provider_key(company_id, "gemini_web") {
            if !key.trim().is_empty() {
                let mut gw_cfg = config.clone();
                gw_cfg.provider = "gemini_web".to_string();
                gw_cfg.api_key = key;
                gw_cfg.endpoint = if ep.is_empty() {
                    "http://127.0.0.1:9223".to_string()
                } else {
                    ep
                };
                gw_cfg.model = if model.is_empty() {
                    "gemini-web".to_string()
                } else {
                    model
                };
                if let Some(last_groq_pos) = chain
                    .iter()
                    .rposition(|c| c.provider.eq_ignore_ascii_case("groq"))
                {
                    chain.insert(last_groq_pos + 1, gw_cfg);
                } else {
                    chain.push(gw_cfg);
                }
            }
        }
    }
    // IA própria na VPS (Ollama atrás de token, compatível com OpenAI): logo depois do Groq,
    // antes do Gemini Web. Sem limite diário e sem depender de navegador.
    if !chain.iter().any(|c| c.provider.eq_ignore_ascii_case("vps_ia")) {
        if let Some((key, ep, model)) = db.get_ai_provider_key(company_id, "vps_ia") {
            if !key.trim().is_empty() && !ep.trim().is_empty() {
                let mut vps_cfg = config.clone();
                vps_cfg.provider = "vps_ia".to_string();
                vps_cfg.api_key = key;
                vps_cfg.endpoint = ep;
                vps_cfg.model = if model.is_empty() { "qwen3:4b-instruct".to_string() } else { model };
                let pos = chain
                    .iter()
                    .rposition(|c| c.provider.eq_ignore_ascii_case("groq"))
                    .map(|p| p + 1)
                    .unwrap_or(chain.len());
                chain.insert(pos, vps_cfg);
            }
        }
    }
    // OpenRouter: se o modelo grátis escolhido falhar ou demorar, o roteador automático de
    // modelos grátis ("openrouter/free") tenta outro com a mesma chave.
    if let Some(pos) = chain
        .iter()
        .position(|c| c.provider.eq_ignore_ascii_case("openrouter") && c.model != "openrouter/free")
    {
        let mut auto = chain[pos].clone();
        auto.model = "openrouter/free".to_string();
        chain.insert(pos + 1, auto);
    }
    chain
}

/// Monta o texto do contato: saudação + corpo + despedida, Spintax e reescrita por IA (com fallback).
async fn build_message(
    db_arc: Arc<Database>,
    campaign: crate::db::Campaign,
    next_contact: crate::db::Contact,
    _app_handle: Option<AppHandle>,
) -> String {
    // Monta o texto base: saudação + corpo + despedida, com Spintax resolvido
    let campaign_text = {
        let mut full = String::new();
        if !campaign.greeting.trim().is_empty() {
            full.push_str(&campaign.greeting);
            // Linha em branco = mensagem separada no WhatsApp (envio em partes, fiel ao IHC)
            full.push_str("\n\n");
        }
        full.push_str(&campaign.message);
        if !campaign.closing.trim().is_empty() {
            full.push_str("\n\n");
            full.push_str(&campaign.closing);
        }
        // Apelidos do nome ({NOME DEVEDOR}, {Razão Social}...) viram {nome} antes do spintax e da IA.
        let full = AiEngine::normalize_name_variables(&full);
        if campaign.use_spintax {
            // Troca {nome} antes do spintax: sem isso o motor trata "{nome}" como bloco de 1 variante e envia "nome".
            let full = AiEngine::replace_contact_name(&full, &next_contact.contact_name);
            crate::spintax::resolve_spintax(&full)
        } else {
            full
        }
    };

    if campaign.use_ai {
        schedule_ai_pool(db_arc, campaign.clone());
        pooled_ai_message(&campaign, &next_contact.contact_name)
            .unwrap_or_else(|| AiEngine::replace_contact_name(&campaign_text, &next_contact.contact_name))
    } else {
        AiEngine::replace_contact_name(&campaign_text, &next_contact.contact_name)
    }
}

/// Inicia em segundo plano a mensagem do próximo contato pendente depois de `after_id`.
fn prefetch_next_message(db_arc: Arc<Database>, campaign: crate::db::Campaign, after_id: i32, app_handle: Option<AppHandle>) {
    tauri::async_runtime::spawn(async move {
        let db = db_arc.clone();
        let cid = campaign.id;
        let next = match spawn_blocking(move || db.try_get_pending_contact_after(cid, after_id)).await {
            Ok(Ok(Some(c))) => c,
            _ => return,
        };
        let key = (campaign.id, next.id);
        let fingerprint = campaign_fingerprint(&campaign);
        let handle = tokio::spawn(build_message(db_arc, campaign, next, app_handle));
        if let Ok(mut m) = PREFETCHED_MESSAGES.lock() {
            // Uma pré-carga por campanha: descarta as antigas (contato já tratado ou pulado).
            m.retain(|k, (_, h)| {
                let keep = k.0 != key.0;
                if !keep {
                    h.abort();
                }
                keep
            });
            m.insert(key, (fingerprint, handle));
        }
    });
}

/// Bloqueia URLs na mensagem preparada, inclusive quando inseridas pela IA ou spintax.
fn contains_link(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
        return true;
    }
    lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .any(|word| {
            let mut pieces = word.trim_matches('.').rsplit('.');
            match (pieces.next(), pieces.next()) {
                (Some(tld), Some(host)) => tld.len() >= 2 && tld.len() <= 24
                    && tld.chars().all(|c| c.is_ascii_alphabetic())
                    && !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                _ => false,
            }
        })
}

const KEEPALIVE_COOLDOWN_SECS: i64 = 90;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CampaignProgressEvent {
    pub campaign_id: i32,
    pub campaign_name: String,
    pub sent_count: i32,
    pub total_contacts: i32,
    pub last_contact_phone: String,
    pub delay_used_ms: i32,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SendOutcome {
    Sent,
    SkippedDuplicate,
    NoOnlineDevice,
    SendFailed(String),
}

/// Acorda o worker sem esperar o ciclo de polling (clique em iniciar/retomar campanha).
static WORKER_WAKE: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

pub struct Dispatcher;

impl Dispatcher {
    pub fn wake() {
        WORKER_WAKE.notify_one();
    }

    /// Inicia o worker assíncrono do motor de disparos em background com suporte a AppHandle.
    /// Mantém fluidez por: polling menor, lote limitado e backpressure artificial.
    pub fn start_worker(db_arc: Arc<Database>, app_handle: Option<AppHandle>) {
        tauri::async_runtime::spawn(async move {
            let mut poll_delay = Duration::ZERO;
            // Uma tarefa por campanha: uma campanha em pausa não segura o início de outra.
            let mut running: HashMap<i32, tokio::task::JoinHandle<()>> = HashMap::new();
            loop {
                // Ocioso: acorda no clique em iniciar (wake) ou no próximo ciclo de 2 s.
                let _ = timeout(poll_delay, WORKER_WAKE.notified()).await;

                let db = db_arc.clone();
                let active_campaigns = match spawn_blocking(move || db.get_running_campaigns()).await {
                    Ok(Ok(v)) => v,
                    _ => continue,
                };

                if active_campaigns.is_empty() {
                    poll_delay = Duration::from_secs(2);
                    continue;
                }
                poll_delay = Duration::from_millis(250);

                // Cada campanha mantém sua própria cadência. Campanhas diferentes
                // podem avançar juntas sem somar os intervalos HCP umas às outras.
                running.retain(|_, h| !h.is_finished());
                for campaign in active_campaigns {
                    if running.contains_key(&campaign.id) {
                        continue;
                    }
                    let campaign_id = campaign.id;
                    let db_arc = db_arc.clone();
                    let app_handle = app_handle.clone();
                    let task = tokio::spawn(async move {
                    let lookup_started = Instant::now();
                    let db1 = db_arc.clone();
                    let next_contact = match spawn_blocking(move || db1.try_get_next_pending_contact(campaign.id)).await {
                        Ok(Ok(Some(c))) => c,
                        Ok(Ok(None)) => {
                            let db_done = db_arc.clone();
                            let campaign_id = campaign.id;
                            let _ = spawn_blocking(move || db_done.set_campaign_status(campaign_id, "completed")).await;
                            cleanup_campaign_contacts(db_arc.clone(), campaign.company_id, campaign.device_ids.clone());
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id,
                                    campaign_name: campaign.name.clone(),
                                    sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count,
                                    last_contact_phone: String::new(),
                                    delay_used_ms: 0,
                                    status: "completed".to_string(),
                                });
                            }
                            return;
                        }
                        Ok(Err(error)) => {
                            eprintln!("[DISPATCHER DB] Falha ao buscar contato da campanha {}: {}", campaign.id, error);
                            return;
                        }
                        Err(error) => {
                            eprintln!("[DISPATCHER DB] Falha na tarefa de busca da campanha {}: {}", campaign.id, error);
                            return;
                        }
                    };

                    let phone = next_contact.phone.clone();
                    let phone_check = phone.clone();
                    let db_check = db_arc.clone();
                    let already_sent = match spawn_blocking(move || db_check.try_was_already_sent(&phone_check, campaign.id)).await {
                        Ok(Ok(v)) => v,
                        Ok(Err(error)) => {
                            eprintln!("[DISPATCHER DB] Falha na deduplicação da campanha {}: {}", campaign.id, error);
                            return;
                        }
                        Err(error) => {
                            eprintln!("[DISPATCHER DB] Falha na tarefa de deduplicação da campanha {}: {}", campaign.id, error);
                            return;
                        }
                    };

                    if already_sent {
                        let db2 = db_arc.clone();
                        let cid = next_contact.id;
                        let _ = spawn_blocking(move || db2.update_contact_status(cid, "already_sent")).await;
                        return;
                    }

                    // Descadastro: quem pediu para não receber nunca recebe (política do WhatsApp + LGPD).
                    if db_arc.is_opted_out(campaign.company_id, &phone) {
                        let db2 = db_arc.clone();
                        let cid = next_contact.id;
                        let _ = spawn_blocking(move || db2.update_contact_status(cid, "opt_out")).await;
                        println!("[DISPATCHER] {} está descadastrado; contato pulado.", phone);
                        return;
                    }

                    // Lista "não disparar": número já identificado sem WhatsApp não é tentado de novo.
                    if db_arc.is_no_whatsapp(campaign.company_id, &phone) {
                        let db2 = db_arc.clone();
                        let cid = next_contact.id;
                        let _ = spawn_blocking(move || db2.update_contact_status(cid, "no_whatsapp")).await;
                        println!("[DISPATCHER] {} não tem WhatsApp (lista não disparar); contato pulado.", phone);
                        return;
                    }

                    // Horário de envio: seg-sex 8h-20h, sáb 8h-14h, domingo não (CDC art. 71: descanso e lazer).
                    if !within_send_window() {
                        if let Some(ref handle) = app_handle {
                            let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                campaign_id: campaign.id,
                                campaign_name: campaign.name.clone(),
                                sent_count: campaign.sent_count,
                                total_contacts: campaign.contacts_count,
                                last_contact_phone: String::new(),
                                delay_used_ms: 0,
                                status: "waiting_window".to_string(),
                            });
                        }
                        sleep(Duration::from_secs(60)).await;
                        return;
                    }
                    let lookup_ms = lookup_started.elapsed().as_millis();
                    let preparation_started = Instant::now();

                    // Mensagem: usa a pré-carregada durante a pausa do contato anterior, se houver.
                    let prefetched = PREFETCHED_MESSAGES.lock().ok().and_then(|mut m| m.remove(&(campaign.id, next_contact.id)));
                    let message_to_send = match prefetched {
                        // Só vale se a campanha não mudou desde a pré-carga (texto, spintax, IA).
                        Some((fingerprint, handle)) if fingerprint == campaign_fingerprint(&campaign) && handle.is_finished() => match handle.await {
                            Ok(m) => {
                                println!("[DISPATCHER] Mensagem de {} já estava pronta (pré-carregada).", next_contact.phone);
                                m
                            }
                            Err(_) => build_message(db_arc.clone(), campaign.clone(), next_contact.clone(), app_handle.clone()).await,
                        },
                        Some((_, handle)) => {
                            handle.abort();
                            println!("[DISPATCHER] Campanha editada depois da pré-carga: refazendo a mensagem de {}.", next_contact.phone);
                            build_message(db_arc.clone(), campaign.clone(), next_contact.clone(), app_handle.clone()).await
                        }
                        None => build_message(db_arc.clone(), campaign.clone(), next_contact.clone(), app_handle.clone()).await,
                    };

                    // Sem prova confiável de conversa anterior, tratar o contato como novo.
                    if contains_link(&message_to_send) {
                        let _ = db_arc.set_campaign_status(campaign.id, "paused");
                        if let Some(ref handle) = app_handle {
                            let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                campaign_id: campaign.id, campaign_name: campaign.name.clone(),
                                sent_count: campaign.sent_count, total_contacts: campaign.contacts_count,
                                last_contact_phone: String::new(), delay_used_ms: 0,
                                status: "Campanha pausada: remova links da primeira mensagem para contatos novos.".to_string(),
                            });
                        }
                        return;
                    }

                    let db2 = db_arc.clone();
                    let active_devices = match spawn_blocking(move || db2.get_devices(campaign.company_id)).await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let online_devices: Vec<_> = active_devices.into_iter().filter(|d| {
                        let serial = d.current_adb_address.as_deref().filter(|a| !a.trim().is_empty()).unwrap_or(&d.serial);
                        let cooling_down = DEVICE_UNAVAILABLE_UNTIL.lock().map(|m| m.get(serial).map(|t| *t > Instant::now()).unwrap_or(false)).unwrap_or(true);
                        !cooling_down && d.status == "online" && campaign.device_ids.iter().any(|id| {
                            d.esfera_device_id.as_deref() == Some(id.as_str()) || d.serial == *id
                        })
                    }).collect();

                    let preparation_ms = preparation_started.elapsed().as_millis();
                    let send_started = Instant::now();
                    // Regra da empresa: nenhuma mensagem pode citar valores (nem quando a IA falha e volta o original).
                    use rand::Rng;
                    let low = (campaign.delay_min * 1000).max(1000);
                    let high = (campaign.delay_max * 1000).max(low.saturating_mul(2));
                    let base_delay_ms = rand::thread_rng().gen_range(low..=high);
                    let mut ritmo_reduzido = false;
                    let mut reply_warning = false;
                    let outcome = if AiEngine::has_money(&message_to_send) {
                        eprintln!("[DISPATCHER] Envio bloqueado para {}: a mensagem cita valores.", phone);
                        SendOutcome::SendFailed("Mensagem cita valores (proibido)".to_string())
                    } else if online_devices.is_empty() {
                        SendOutcome::NoOnlineDevice
                    } else {
                        let (serial, device_id, target_device) = {
                            let mut idx_map = CAMPAIGN_DEVICE_INDEX.lock().unwrap();
                            let idx = idx_map.entry(campaign.id).or_insert(0);
                            let target_dev = &online_devices[*idx % online_devices.len()];
                            *idx = (*idx + 1) % online_devices.len();
                            (target_dev.current_adb_address.as_ref()
                                .filter(|a| !a.trim().is_empty())
                                .cloned()
                                .unwrap_or_else(|| target_dev.serial.clone()), target_dev.id, target_dev.clone())
                        };
                        // Atualiza a capacidade de captura antes de avaliar uma amostra antiga.
                        let db_capture = db_arc.clone();
                        let serial_capture = serial.clone();
                        let company_capture = campaign.company_id;
                        if !spawn_blocking(move || import_opt_out_from_device(&db_capture, &serial_capture, company_capture)).await.unwrap_or(false) {
                            eprintln!("[DISPATCHER REDE] Falha ao verificar respostas do aparelho.");
                            sleep(Duration::from_secs(10)).await;
                            return;
                        }
                        let chips = db_arc.get_chips(device_id);
                        if chips.len() == 1 {
                            match db_arc.apply_reply_brake(&chips[0], &target_device) {
                                Ok(status) => {
                                    ritmo_reduzido = status.state == "reduzido";
                                    if status.state != "normal" {
                                        reply_warning = true;
                                        if let Some(ref handle) = app_handle {
                                            let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                                campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                                total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                                status: status.reason.clone(),
                                            });
                                        }
                                    }
                                    if status.state == "pausado" {
                                        if let Ok(mut unavailable) = DEVICE_UNAVAILABLE_UNTIL.lock() { unavailable.insert(serial.clone(), Instant::now() + std::time::Duration::from_secs(30)); }
                                        sleep(Duration::from_secs(2)).await;
                                        return;
                                    }
                                }
                                Err(e) => { eprintln!("[DISPATCHER REDE] {}", e); sleep(Duration::from_secs(10)).await; return; }
                            }
                        }

                        let network_guard = match NETWORK_SEND_GATE.try_lock() {
                            Ok(guard) => guard,
                            Err(_) => {
                        let was_limited = NETWORK_LIMITED_CAMPAIGNS.lock().map(|s| s.contains(&campaign.id)).unwrap_or(true);
                        if !reply_warning && !was_limited {
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                    status: "Aguardando vez na rede".into(),
                                });
                            }
                        }
                        NETWORK_SEND_GATE.lock().await
                            }
                        };
                        let limit_result = db_arc.network_limit_wait();
                        let wait = limit_result.as_ref().copied().unwrap_or(30);
                        if wait > 0 {
                            if let Ok(mut limited) = NETWORK_LIMITED_CAMPAIGNS.lock() { limited.insert(campaign.id); }
                            drop(network_guard);
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                    status: if limit_result.is_ok() { "Teto da rede atingido; aguardando a próxima janela." } else { "Não foi possível verificar o teto da rede; tentando novamente." }.into(),
                                });
                            }
                            sleep(Duration::from_secs(wait.min(30))).await;
                            return;
                        }
                        if let Ok(mut limited) = NETWORK_LIMITED_CAMPAIGNS.lock() { limited.remove(&campaign.id); }
                        if let Some(chip) = db_arc.get_chips(device_id).first() {
                            let cooldown = db_arc.chip_cooldown_seconds(chip.id).unwrap_or(30);
                            if cooldown > 0 {
                                drop(network_guard);
                                if let Ok(mut unavailable) = DEVICE_UNAVAILABLE_UNTIL.lock() { unavailable.insert(serial.clone(), Instant::now() + std::time::Duration::from_secs(cooldown.min(30))); }
                                sleep(Duration::from_secs(1)).await;
                                return;
                            }
                        }
                        let interval = rand::thread_rng().gen_range(30..=90);
                        let elapsed = network_guard.as_ref().map(|(id,t)| (*id, t.elapsed().as_secs()));
                        let gap = network_gap(elapsed, device_id, interval);
                        if gap > 0 { sleep(Duration::from_secs(gap)).await; }
                        let failed_serial = serial.clone();
                        let msg = message_to_send.clone();
                        let phone2 = phone.clone();
                        let contact_name = next_contact.contact_name.clone();
                        let device_lock = device_operation_lock_for_id(device_id);
                        let _device_guard = device_lock.lock().await;
                        let db_last = db_arc.clone();
                        let company_last = campaign.company_id;
                        let campaign_last = campaign.id;
                        let contact_id_for_safety = next_contact.id;
                        let network_guard = NetworkSendGuard(network_guard, device_id);
                        let send_res = spawn_blocking(move || {
                            let _network_guard = network_guard;
                            AdbManager::ensure_dispatch_target(&serial).map_err(|e| format!("APARELHO: {}", e))?;
                            // Traz os "SAIR" capturados pelo agente agora, e revalida o descadastro no último instante.
                            if !import_opt_out_from_device(&db_last, &serial, company_last) {
                                return Err("TRAVA: Não foi possível ler ou registrar as respostas do aparelho; verifique a conexão e o banco.".into());
                            }
                            if db_last.is_opted_out(company_last, &phone2) {
                                return Err("Contato descadastrado durante o preparo; envio cancelado".to_string());
                            }
                            let chips = db_last.get_chips(device_id);
                            if chips.len() != 1 {
                                return Err("TRAVA: Cadastre exatamente um chip no aparelho para aplicar os limites de envio.".into());
                            }
                            let chip = &chips[0];
                            let cooldown = db_last.chip_cooldown_seconds(chip.id).map_err(|e| format!("TRAVA: {}", e))?;
                            for _ in 0..cooldown {
                                std::thread::sleep(std::time::Duration::from_secs(1));
                                if !within_send_window() || !db_last.get_running_campaigns().map(|l| l.iter().any(|c| c.id == campaign_last)).unwrap_or(false) {
                                    return Err("CANCELADO: campanha parada durante a pausa longa".into());
                                }
                            }
                            let fresh = db_last.get_chips(device_id);
                            if fresh.len() != 1 || fresh[0].id != chip.id {
                                return Err("TRAVA: O chip do aparelho mudou durante a pausa.".into());
                            }
                            let chip = &fresh[0];
                            let parts = AdbManager::split_human_parts(&msg);
                            let (hourly, daily) = db_last.network_limits().map_err(|e| format!("REDE: falha ao verificar limites: {}", e))?;
                            if parts.len() as i64 > hourly.min(daily) { return Err("REDE: a mensagem tem mais partes que o teto configurado; aumente o limite ou reduza o texto".into()); }
                            let wait = db_last.network_limit_wait_for(parts.len().max(1) as i64).map_err(|e| format!("REDE: falha ao verificar teto: {}", e))?;
                            if wait > 0 { return Err(format!("REDE: teto da rede atingido para {} partes; aguardando a próxima janela", parts.len())); }
                            let attempt = db_last.reserve_chip_attempt(chip, company_last, campaign_last, &phone2, false)
                                .map_err(|e| format!("TRAVA: {}", e))?;
                            if let Err(e) = db_last.reserve_network_extra(attempt, parts.len()) {
                                let _ = db_last.finish_chip_attempt(attempt, false);
                                return Err(format!("REDE: falha ao registrar reserva: {}",e));
                            }
                            let name_ref = if contact_name.trim().is_empty() { None } else { Some(contact_name.as_str()) };
                            println!("[DISPATCHER] Disparando contato '{}' ({}) via navegacao nativa WhatsApp no aparelho {}", contact_name, phone2, serial);
                            // Garante o contato na agenda; espera só o que falta para o WhatsApp indexar.
                            prepare_temp_contact_for_send(&serial, &phone2);
                            let _ = name_ref;
                            // Antes de cada parte: dentro do horário, ainda não descadastrado e campanha ainda rodando.
                            let check = || {
                                import_opt_out_from_device(&db_last, &serial, company_last)
                                    && within_send_window()
                                    && !db_last.is_opted_out(company_last, &phone2)
                                    && db_last
                                        .get_running_campaigns()
                                        .map(|l| l.iter().any(|c| c.id == campaign_last))
                                        .unwrap_or(false)
                            };
                            let result = AdbManager::send_whatsapp_parts(&serial, &phone2, &parts, Some("com.whatsapp"), &check);
                            if let Err(ref e) = result {
                                if e.starts_with("CONTA_RESTRITA:") {
                                    let _ = db_last.set_chip_restriction(chip.id, "banido", "9999-12-31 23:59:59");
                                }
                            }
                            if ritmo_reduzido {
                                let seconds = (base_delay_ms as u64 * 2 + 999) / 1000;
                                if let Err(e) = db_last.extend_chip_cooldown(chip.id, seconds) {
                                    let _ = db_last.update_contact_status(contact_id_for_safety, "partial");
                                    return Err(format!("TRAVA: Falha ao registrar ritmo reduzido: {}", e));
                                }
                            }
                            if let Err(e) = db_last.finish_chip_attempt(attempt, result.is_ok()) {
                                // A mensagem pode ter saído: não deixe este contato elegível para reenvio.
                                let _ = db_last.update_contact_status(contact_id_for_safety, "partial");
                                return Err(format!("TRAVA: Falha ao registrar tentativa; contato enviado para revisão: {}", e));
                            }
                            result
                        }).await;

                        match send_res {
                            Ok(Ok(_)) => {
                                println!("[DISPATCHER] Mensagem enviada com sucesso para {} via navegacao nativa!", phone);
                                SendOutcome::Sent
                            }
                            Ok(Err(e)) => {
                                if e.starts_with("APARELHO:") {
                                    if let Ok(mut unavailable) = DEVICE_UNAVAILABLE_UNTIL.lock() { unavailable.insert(failed_serial, Instant::now() + std::time::Duration::from_secs(60)); }
                                }
                                eprintln!("[DISPATCHER] Erro no envio para {}: {}", phone, e);
                                SendOutcome::SendFailed(e)
                            }
                            Err(e) => {
                                eprintln!("[DISPATCHER] Falha de execucao no worker para {}: {}", phone, e);
                                SendOutcome::SendFailed(e.to_string())
                            }
                        }
                    };
                    if let SendOutcome::SendFailed(ref error) = outcome {
                        if error.starts_with("REDE:") {
                            if let Ok(mut limited) = NETWORK_LIMITED_CAMPAIGNS.lock() { limited.insert(campaign.id); }
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                    status: error.trim_start_matches("REDE: ").to_string(),
                                });
                            }
                            sleep(Duration::from_secs(30)).await;
                            return;
                        }
                        if error.starts_with("APARELHO:") {
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                    status: format!("Aparelho temporariamente indisponível: {}. Tentando outro aparelho; o contato continua pendente.", error.trim_start_matches("APARELHO: ")),
                                });
                            }
                            return;
                        }
                        if error.starts_with("TRAVA:") || error.starts_with("CONTA_RESTRITA:") {
                            let _ = db_arc.set_campaign_status(campaign.id, "paused");
                            if let Some(ref handle) = app_handle {
                                let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                    campaign_id: campaign.id, campaign_name: campaign.name.clone(), sent_count: campaign.sent_count,
                                    total_contacts: campaign.contacts_count, last_contact_phone: String::new(), delay_used_ms: 0,
                                    status: format!("Campanha pausada: {}", error),
                                });
                            }
                            return;
                        }
                    }
                    // Envio parcial/incerto: grava "partial" AGORA (antes da pausa), para nunca reenviar.
                    if let SendOutcome::SendFailed(ref e) = outcome {
                        if e.starts_with("PARCIAL:") || e.starts_with("INCERTO:") {
                            let db_partial = db_arc.clone();
                            let contact_id = next_contact.id;
                            let _ = spawn_blocking(move || db_partial.update_contact_status(contact_id, "partial")).await;
                        }
                    }
                    let send_ms = send_started.elapsed().as_millis();
                    if lookup_ms > 500 || preparation_ms > 3000 || send_ms > 8000 {
                        eprintln!(
                            "[DISPATCHER PERF] campanha={} busca={}ms preparo={}ms envio={}ms",
                            campaign.id, lookup_ms, preparation_ms, send_ms
                        );
                    }

                    let gaussian_delay_ms = if ritmo_reduzido { base_delay_ms.saturating_mul(2) } else { base_delay_ms };

                    // A IA do próximo contato trabalha durante a pausa, não depois dela.
                    prefetch_next_message(db_arc.clone(), campaign.clone(), next_contact.id, app_handle.clone());
                    sleep(Duration::from_millis(gaussian_delay_ms as u64)).await;

                    match outcome {
                        SendOutcome::Sent => {
                            let db3 = db_arc.clone();
                            let phone3 = phone.clone();
                            let contact_id = next_contact.id;
                            // Escrita atômica na Fila Única (MPSC): SentHistory + contato + contador
                            spawn_blocking(move || db3.queue_send_completed(&phone3, campaign.id, contact_id))
                                .await
                                .unwrap_or_default();
                        }
                        SendOutcome::SendFailed(ref e) if e.starts_with("PARCIAL:") || e.starts_with("INCERTO:") => {
                            // Parte já pode ter chegado: NÃO reenviar (duplicaria). Fica para revisão do operador.
                            let db_partial = db_arc.clone();
                            let contact_id = next_contact.id;
                            let _ = spawn_blocking(move || db_partial.update_contact_status(contact_id, "partial")).await;
                        }
                        SendOutcome::SendFailed(ref e) if e.starts_with("CANCELADO:") => {
                            // Descadastro ou campanha parada antes da 1ª parte: nada foi enviado.
                            if db_arc.is_opted_out(campaign.company_id, &phone) {
                                let db2 = db_arc.clone();
                                let contact_id = next_contact.id;
                                let _ = spawn_blocking(move || db2.update_contact_status(contact_id, "opt_out")).await;
                            }
                        }
                        SendOutcome::SendFailed(ref e) if e.starts_with("SEM_WHATSAPP:") => {
                            // Sem WhatsApp: vai para a lista "não disparar" já na 1ª vez, sem novas tentativas.
                            let db_nowa = db_arc.clone();
                            let company_id = campaign.company_id;
                            let phone_nowa = phone.clone();
                            let reason = format!("aviso do WhatsApp na campanha {}", campaign.id);
                            let _ = spawn_blocking(move || db_nowa.add_no_whatsapp(company_id, &phone_nowa, &reason)).await;
                        }
                        SendOutcome::SendFailed(_) => {
                            let db_failure = db_arc.clone();
                            let campaign_id = campaign.id;
                            let contact_id = next_contact.id;
                            let _ = spawn_blocking(move || db_failure.record_contact_send_failure(campaign_id, contact_id)).await;
                        }
                        SendOutcome::SkippedDuplicate | SendOutcome::NoOnlineDevice => {
                            // não contabiliza como enviado; mantém contato pendente para próxima rodada
                        }
                    }

                    if let Some(ref handle) = app_handle {
                        let sent_count = campaign.sent_count
                            + if matches!(outcome, SendOutcome::Sent) { 1 } else { 0 };
                        let progress = CampaignProgressEvent {
                            campaign_id: campaign.id,
                            campaign_name: campaign.name.clone(),
                            sent_count,
                            total_contacts: campaign.contacts_count,
                            last_contact_phone: next_contact.phone.clone(),
                            delay_used_ms: gaussian_delay_ms,
                            status: if matches!(outcome, SendOutcome::NoOnlineDevice) {
                                "waiting_device".to_string()
                            } else if matches!(outcome, SendOutcome::SendFailed(_)) {
                                "send_error".to_string()
                            } else {
                                "running".to_string()
                            },
                        };
                        let _ = handle.emit("campaign-progress", progress);
                    }
                    });
                    running.insert(campaign_id, task);
                }
            }
        });
    }

    /// Envia confirmações apenas dentro do horário e com o aparelho sem campanha em execução.
    async fn flush_confirmations(db: Arc<Database>) {
        for (company, key, phone, original_serial, text) in db.pending_confirmations() {
            let text = if text.is_empty() { OPT_OUT_CONFIRMATION_TEXT.to_string() } else { text };
            if text != OPT_OUT_CONFIRMATION_TEXT { continue; }
            let device = match db.get_all_devices().into_iter().find(|d| d.company_id == company && d.status == "online" && (d.serial == original_serial || d.esfera_device_id.as_deref() == Some(original_serial.as_str()) || d.current_adb_address.as_deref() == Some(original_serial.as_str()))) {
                Some(d) => d, None => continue,
            };
            let chips = db.get_chips(device.id);
            if chips.len() != 1 || chips[0].status != "livre" || chips[0].restricted_until.is_some() { continue; }
            let serial = device.current_adb_address.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| device.serial.clone());
            let network_guard = NETWORK_SEND_GATE.lock().await;
            if db.network_limit_wait().unwrap_or(30) > 0 { continue; }
            use rand::Rng;
            let interval = rand::thread_rng().gen_range(30..=90);
            let elapsed = network_guard.as_ref().map(|(id,t)| (*id, t.elapsed().as_secs()));
            let gap = network_gap(elapsed, device.id, interval);
            if gap > 0 { sleep(Duration::from_secs(gap)).await; }
            let lock = device_operation_lock_for_id(device.id);
            let _guard = lock.lock().await;
            let current_chips = db.get_chips(device.id);
            if current_chips.len() != 1 || current_chips[0].id != chips[0].id || current_chips[0].status != "livre" || current_chips[0].restricted_until.is_some() { continue; }
            let chip_id = current_chips[0].id;
            let busy = || db.get_running_campaigns().map(|cs| cs.iter().any(|c| c.company_id == company && c.device_ids.iter().any(|id| id == &device.serial || device.esfera_device_id.as_deref() == Some(id.as_str())))).unwrap_or(true);
            if !confirmation_allowed(within_send_window(), busy()) || db.chip_cooldown_seconds(chip_id).unwrap_or(u64::MAX) > 0 { continue; }
            if !db.claim_confirmation(company, &key).unwrap_or(false) { continue; }
            let attempt = match db.reserve_chip_attempt(&current_chips[0],company,0,&phone,true) {
                Ok(id) => id,
                Err(e) => { let _ = db.finish_confirmation(company,&key,false,&format!("CANCELADO: {}",e)); continue; }
            };
            let db2 = db.clone();
            let device2 = device.clone();
            let network_guard = NetworkSendGuard(network_guard, device.id);
            let result = spawn_blocking(move || {
                let _network_guard = network_guard;
                prepare_temp_contact_for_send(&serial, &phone);
                let check = || confirmation_allowed(within_send_window(), db2.get_running_campaigns().map(|cs| cs.iter().any(|c| c.company_id == company && c.device_ids.iter().any(|id| id == &device2.serial || device2.esfera_device_id.as_deref() == Some(id.as_str())))).unwrap_or(true));
                AdbManager::send_whatsapp_parts(&serial, &phone, &[text], Some("com.whatsapp"), &check)
            }).await;
            let (sent, error) = match result { Ok(Ok(())) => (true,String::new()), Ok(Err(e)) => (false,e), Err(e) => (false,e.to_string()) };
            let _ = db.finish_chip_attempt(attempt,sent);
            if error.starts_with("CONTA_RESTRITA:") {
                let _ = db.set_chip_restriction(chip_id, "banido", "9999-12-31 23:59:59");
            }
            let _ = db.finish_confirmation(company,&key,sent,&error);
            drop(_guard);
            // Intervalo humano entre confirmações, sem bloquear outras campanhas.
            let pause = rand::thread_rng().gen_range(30..=90);
            sleep(Duration::from_secs(pause)).await;
        }
    }

    /// A cada 30s, lê dos celulares conectados os pedidos de descadastro ("SAIR") capturados pelo
    /// agente (/sdcard/esfera_optout.jsonl), grava em ESF_OptOut e tira o número das filas pendentes.
    pub fn start_opt_out_import_loop(db_arc: Arc<Database>) {
        let import_db = db_arc.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                let db = import_db.clone();
                let _ = spawn_blocking(move || import_opt_out_requests(&db)).await;
            }
        });
        tauri::async_runtime::spawn(async move {
            loop {
                Self::flush_confirmations(db_arc.clone()).await;
                sleep(Duration::from_secs(30)).await;
            }
        });
    }

    /// Verifica aparelhos conectados em segundo plano, com limite de concorrência.
    pub fn start_agent_update_loop(db: Arc<Database>) {
        tauri::async_runtime::spawn(async move {
            let slots = Arc::new(tokio::sync::Semaphore::new(4));
            loop {
                let devices = db.get_all_devices();
                let online: std::collections::HashSet<String> = devices.iter().filter(|d| d.status == "online").map(|d| {
                    let id = d.esfera_device_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&d.serial);
                    format!("{}|{}", d.company_id, id)
                }).collect();
                if let Ok(mut state) = AGENT_MONITOR.lock() {
                    for key in online.difference(&state.online).cloned().collect::<Vec<_>>() { state.last_check.remove(&key); }
                    state.online = online;
                }
                for device in devices.into_iter().filter(|d| d.status == "online") {
                    let id = device.esfera_device_id.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| device.serial.clone());
                    let key = format!("{}|{}",device.company_id,id);
                    let permit = match slots.clone().try_acquire_owned() { Ok(p) => p, Err(_) => break };
                    let eligible = if let Ok(mut state) = AGENT_MONITOR.lock() {
                        let due = state.last_check.get(&key).map(|t| t.elapsed() >= std::time::Duration::from_secs(60)).unwrap_or(true);
                        if due && !state.inflight.contains(&key) { state.inflight.insert(key.clone()); state.last_check.insert(key.clone(),Instant::now()); true } else { false }
                    } else { false };
                    if !eligible { continue; }
                    let db = db.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let expected = crate::adb_manager::expected_agent_version().unwrap_or(0);
                        let mut status = AgentUpdateStatus { device_id:id, company_id:device.company_id, version_code:None, version_name:String::new(), expected_code:expected, status:"checking".into(), detail:"Verificando agente".into() };
                        update_agent_status(&db,&key,status.clone(),false);
                        let serial = device.current_adb_address.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| device.serial.clone());
                        let lock = device_operation_lock_for_id(device.id);
                        if let Ok(_guard) = lock.try_lock() {
                            let serial2=serial.clone();
                            let checked = spawn_blocking(move || {
                                if expected == 0 { return Err("Versão esperada do agente inválida.".to_string()); }
                                AdbManager::ensure_dispatch_target(&serial2)?;
                                AdbManager::installed_agent_version(&serial2)
                            }).await;
                            match checked {
                                Ok(Ok(installed)) => {
                                    if let Some((code,name)) = installed { status.version_code=Some(code); status.version_name=name; }
                                    else { status.version_name="não instalado".into(); }
                                    if status.version_code.unwrap_or(0) >= expected {
                                        match db.agent_restore_pending(device.id) {
                                            Ok(false) => { status.status="current".into(); status.detail="Agente atualizado".into(); update_agent_status(&db,&key,status.clone(),false); }
                                            Ok(true) => {
                                                let serial_check=serial.clone();
                                                let restored = spawn_blocking(move || AdbManager::ensure_agent_services(&serial_check)).await;
                                                let outcome = match restored { Ok(Ok(())) => db.set_agent_restore_pending(device.id,false), Ok(Err(e)) => Err(e), Err(e) => Err(e.to_string()) };
                                                match outcome {
                                                    Ok(()) => { status.status="current".into(); status.detail="Agente atualizado e serviços ativados".into(); update_agent_status(&db,&key,status.clone(),true); }
                                                    Err(e) => { status.status="error".into(); status.detail=format!("Falha ao ativar serviços do agente: {}",e); update_agent_status(&db,&key,status.clone(),true); }
                                                }
                                            }
                                            Err(e) => { status.status="error".into(); status.detail=format!("Falha ao consultar serviços do agente: {}",e); update_agent_status(&db,&key,status.clone(),true); }
                                        }
                                    } else {
                                        status.status="updating".into(); status.detail="Atualizando agente…".into();
                                        update_agent_status(&db,&key,status.clone(),false);
                                        let prepared = db.set_agent_restore_pending(device.id,true);
                                        let result = match prepared {
                                            Ok(()) => match spawn_blocking(move || AdbManager::auto_update_agent_unlocked(&serial,expected)).await { Ok(r) => r, Err(e) => Err(e.to_string()) },
                                            Err(e) => Err(format!("Não foi possível registrar a atualização: {}",e)),
                                        };
                                        match result {
                                            Ok((code,name)) => {
                                                status.version_code=Some(code); status.version_name=name;
                                                match db.set_agent_restore_pending(device.id,false) {
                                                    Ok(()) => { status.status="current".into(); status.detail=format!("Agente atualizado para versão {}",code); }
                                                    Err(e) => { status.status="error".into(); status.detail=format!("Agente instalado; falha ao registrar ativação: {}",e); }
                                                }
                                            }
                                            Err(e) => { status.status="error".into(); status.detail=e; }
                                        }
                                        update_agent_status(&db,&key,status.clone(),true);
                                    }
                                }
                                Ok(Err(e)) => { status.status="error".into(); status.detail=format!("Não foi possível verificar o agente: {}",e); update_agent_status(&db,&key,status.clone(),true); }
                                Err(e) => { status.status="error".into(); status.detail=format!("Falha ao verificar agente: {}",e); update_agent_status(&db,&key,status.clone(),true); }
                            }
                        } else {
                            status.status="waiting".into(); status.detail="Aguardando o aparelho terminar o envio".into();
                            update_agent_status(&db,&key,status,false);
                            if let Ok(mut state)=AGENT_MONITOR.lock() { state.last_check.remove(&key); }
                        }
                        if let Ok(mut state)=AGENT_MONITOR.lock() { state.inflight.remove(&key); }
                    });
                }
                sleep(Duration::from_secs(10)).await;
            }
        });
    }

    pub fn start_persistent_adb_keepalive_loop(db_arc: Arc<Database>) {
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(45)).await;

                let db = db_arc.clone();
                // 1. Varredura assíncrona da subnet local para rastrear mudanças de IP (DHCP)
                let db_discover = db.clone();
                spawn_blocking(move || {
                    AdbManager::auto_discover_lan_devices(&db_discover);
                });

                let saved_devices = match spawn_blocking(move || db.get_all_devices()).await {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let mut keepalive_candidates = Vec::new();

                for dev in saved_devices {
                    let key = if !dev.serial.is_empty() { dev.serial.clone() } else if !dev.ip.is_empty() { dev.ip.clone() } else { continue; };

                    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                    let last = KEEPALIVE_LAST_ATTEMPT.lock().unwrap().get(&key).copied();

                    if let Some((ts, _)) = last {
                        if now_ms - ts < KEEPALIVE_COOLDOWN_SECS * 1000 {
                            continue;
                        }
                    }

                    keepalive_candidates.push((dev, key, now_ms));
                }

                for (dev, key, now_ms) in keepalive_candidates {
                    let ip_target = if !dev.ip.is_empty() { dev.ip.clone() } else if dev.serial.contains(':') { dev.serial.split(':').next().unwrap_or("").to_string() } else { "".to_string() };
                    let attempted = if !ip_target.is_empty() && ip_target.contains('.') {
                        let port = if dev.port > 0 { dev.port } else { 5555 };
                        let ip = ip_target.clone();
                        spawn_blocking(move || AdbManager::connect_device_flushed(&ip, port)).await.map(|r| r.is_ok()).unwrap_or(false)
                    } else {
                        false
                    };

                    if attempted {
                        let full_serial = format!("{}:{}", ip_target, if dev.port > 0 { dev.port } else { 5555 });
                        let key2 = key.clone();
                        let deploy = spawn_blocking(move || {
                            let _ = AdbManager::start_agent_service(&full_serial);
                            AdbManager::deploy_keepalive(&full_serial)
                        }).await;
                        let ok = deploy.map(|r| r.is_ok()).unwrap_or(false);
                        KEEPALIVE_LAST_ATTEMPT.lock().unwrap().insert(key2, (now_ms, ok));
                    } else if !dev.serial.is_empty() && !dev.serial.contains(':') {
                        let s = dev.serial.clone();
                        let key2 = key.clone();
                        let deploy = spawn_blocking(move || {
                            let _ = AdbManager::start_agent_service(&s);
                            AdbManager::deploy_keepalive(&s)
                        }).await;
                        let ok = deploy.map(|r| r.is_ok()).unwrap_or(false);
                        KEEPALIVE_LAST_ATTEMPT.lock().unwrap().insert(key2, (now_ms, ok));
                    }
                }
            }
        });
    }
}


#[cfg(test)]
mod dispatcher_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn import_opt_out_salva_revisao_no_banco_e_usa_arquivo_so_como_reserva() {
        let db_path = std::env::temp_dir().join(format!("esfera_disp_rev_{}.db", std::process::id()));
        let fallback_path = std::env::temp_dir().join(format!("esfera_disp_fallback_{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(&fallback_path);

        let db = Database::init(db_path.to_string_lossy().as_ref()).expect("db init");
        let payload = concat!(
            "{\"title\":\"Cliente Sem Numero\",\"text\":\"SAIR agora\"}\n",
            "{\"title\":\"Esfera 5575988052539\",\"text\":\"SAIR\"}\n"
        );

        let all_saved = process_opt_out_jsonl(&db, "192.168.1.90:5555", 1, payload, Some(&fallback_path));
        assert!(all_saved);

        // O pedido com número foi descadastrado direto:
        assert!(db.is_opted_out(1, "5575988052539"));

        // O pedido sem número foi para ESF_OptOutReview no banco e NÃO criou o arquivo de reserva:
        let reviews = db.list_opt_out_reviews(1, Some("pending"));
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].title, "Cliente Sem Numero");
        assert_eq!(reviews[0].text, "SAIR agora");
        assert_eq!(reviews[0].device, "192.168.1.90:5555");
        assert!(!fallback_path.exists(), "arquivo de reserva não deve ser escrito quando o banco funciona");

        // Simula falha no banco (tabela removida) -> deve gravar no arquivo de reserva
        db.pooled_conn().unwrap().execute("DROP TABLE ESF_OptOutReview;", []).unwrap();
        let line_sem_num = "{\"title\":\"Contato Oculto\",\"text\":\"pare de mandar\"}\n";
        let ok_fallback = process_opt_out_jsonl(&db, "192.168.1.90:5555", 1, line_sem_num, Some(&fallback_path));
        assert!(ok_fallback);
        assert!(fallback_path.exists(), "arquivo de reserva deve ser criado quando o banco falha");
        let saved_jsonl = std::fs::read_to_string(&fallback_path).unwrap();
        assert!(saved_jsonl.contains("Contato Oculto"));

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(&fallback_path);
    }

    #[test]
    fn ensure_temp_contact_carrega_existentes_uma_vez_por_aparelho_e_nao_duplica_apos_reinicio() {
        let serial = "test-serial-restart-01";
        if let Ok(mut s) = TEMP_CONTACTS.lock() {
            s.retain(|k| !k.starts_with(&format!("{}|", serial)));
        }
        if let Ok(mut d) = TEMP_CONTACTS_LOADED_DEVICES.lock() {
            d.remove(serial);
        }

        // Também valida o parser da saída do `content query` na conta esfera_temp:
        let sample_query = "Row: 0 data1=Esfera 5575988052539\nRow: 1 data1=Esfera 5511977776666\n";
        let parsed = AdbManager::parse_temporary_contact_names_from_query(sample_query);
        assert_eq!(parsed, vec!["Esfera 5575988052539".to_string(), "Esfera 5511977776666".to_string()]);

        let loader_calls = AtomicUsize::new(0);
        let inserter_calls = AtomicUsize::new(0);

        // 1ª chamada após reiniciar: número 5575988052539 já existe no aparelho -> carrega 1 vez e NÃO insere de novo
        let created_existing = ensure_temp_contact_with(
            serial,
            "+55 (75) 98805-2539",
            |_| {
                loader_calls.fetch_add(1, Ordering::SeqCst);
                Ok(parsed.clone())
            },
            |_, _, _| {
                inserter_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(101))
            },
        );
        assert!(!created_existing, "não deve duplicar contato que já existia na conta esfera_temp");
        assert_eq!(loader_calls.load(Ordering::SeqCst), 1, "deve consultar o aparelho na 1ª chamada");
        assert_eq!(inserter_calls.load(Ordering::SeqCst), 0, "não deve inserir contato já existente");

        // 2ª chamada no mesmo aparelho para número novo -> NÃO consulta o aparelho de novo, insere 1 vez
        let created_new = ensure_temp_contact_with(
            serial,
            "5575999991111",
            |_| {
                loader_calls.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            },
            |_, name, _| {
                assert_eq!(name, "Esfera 5575999991111");
                inserter_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(102))
            },
        );
        assert!(created_new, "deve criar contato inédito");
        assert_eq!(loader_calls.load(Ordering::SeqCst), 1, "não deve consultar content query novamente para o mesmo aparelho");
        assert_eq!(inserter_calls.load(Ordering::SeqCst), 1);

        // 3ª chamada para o mesmo número novo -> já consta em memória, não insere nem consulta
        let created_again = ensure_temp_contact_with(
            serial,
            "5575999991111",
            |_| {
                loader_calls.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            },
            |_, _, _| {
                inserter_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some(103))
            },
        );
        assert!(!created_again);
        assert_eq!(loader_calls.load(Ordering::SeqCst), 1);
        assert_eq!(inserter_calls.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod variant_pool_tests {
    use super::{pool_take, VariantPool};

    #[test]
    fn combinacoes_nao_repetem_e_guardam_versoes_novas() {
        let mut pool = VariantPool::default();
        let a = pool_take(&mut pool, Some(vec!["Oi {nome}".into(), "Corpo A".into(), "Fim A".into()])).unwrap();
        assert_eq!(a, vec!["Oi {nome}", "Corpo A", "Fim A"]);
        let b = pool_take(&mut pool, Some(vec!["Olá {nome}".into(), "Corpo B".into(), "Fim A".into()])).unwrap();
        assert_eq!(b, vec!["Olá {nome}", "Corpo B", "Fim A"]);
        assert_eq!(pool.parts[2].len(), 1, "versão repetida não duplica");
        // Sem versão nova: as 2x2x1 = 4 combinações saem sem repetir.
        let mut seen = std::collections::HashSet::new();
        seen.insert(a.join("|"));
        seen.insert(b.join("|"));
        for _ in 0..2 {
            assert!(seen.insert(pool_take(&mut pool, None).unwrap().join("|")));
        }
        assert_eq!(seen.len(), 4);
        // Banco esgotado: recomeça em vez de travar a campanha.
        assert!(pool_take(&mut pool, None).is_some());
    }

    #[test]
    fn worker_e_unico_por_campanha_e_versao() {
        let mut workers = super::PoolWorkers::default();
        let a = (91, 1);
        assert!(workers.start(a));
        assert!(!workers.start(a));
        assert!(workers.start((92, 1)));
        assert!(workers.start((91, 2)));
        assert!(!workers.is_current(a));
        workers.finish(a);
        assert!(!workers.entries.contains_key(&a));
        workers.finish((91, 2));
        assert!(!workers.start((91, 2)), "cooldown evita rajadas");
    }

    #[test]
    fn banco_vazio_retorna_imediatamente_mesmo_com_worker_ativo() {
        let mut pool = VariantPool::default();
        let mut workers = super::PoolWorkers::default();
        assert!(workers.start((93, 1)));
        assert!(pool_take(&mut pool, None).is_none());
        assert!(!workers.start((93, 1)));
    }

    #[test]
    fn preenchimento_nao_marca_combinacao_como_usada() {
        let mut pool = VariantPool::default();
        super::pool_store(&mut pool, vec!["Oi {nome}".into(), "Corpo".into()]);
        assert!(pool.used.is_empty());
        assert_eq!(pool_take(&mut pool, None).unwrap(), vec!["Oi {nome}", "Corpo"]);
    }

    #[test]
    fn banco_vazio_sem_versao_nova_cai_no_texto_original() {
        let mut pool = VariantPool::default();
        assert!(pool_take(&mut pool, None).is_none());
    }

    #[test]
    fn cadeia_reserva_inclui_gemini_web_logo_apos_groq() {
        let tmp = std::env::temp_dir().join(format!(
            "esfera_chain_gemini_web_test_{}_{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let db = crate::db::Database::init(tmp.to_str().unwrap()).expect("db temp");
        db.save_ai_provider_key(1, "groq", "gsk_test", "", "openai/gpt-oss-120b").unwrap();
        db.save_ai_provider_key(1, "gemini_web", "connected", "http://127.0.0.1:9223", "gemini-web").unwrap();
        db.save_ai_provider_key(1, "cerebras", "csk_test", "", "llama3.1-8b").unwrap();
        db.save_ai_provider_key(1, "openrouter", "sk-or-test", "", "meta-llama/llama-3.3-70b-instruct:free").unwrap();

        let primary = crate::db::AiConfig {
            company_id: 1,
            provider: "groq".to_string(),
            model: "openai/gpt-oss-120b".to_string(),
            temperature: 0.7,
            system_prompt: String::new(),
            api_key: "gsk_test".to_string(),
            endpoint: String::new(),
        };

        let chain = super::build_ai_fallback_chain(&db, 1, &primary);
        let providers_and_models: Vec<(String, String)> = chain
            .iter()
            .map(|c| (c.provider.clone(), c.model.clone()))
            .collect();

        assert_eq!(
            providers_and_models,
            vec![
                ("groq".to_string(), "openai/gpt-oss-120b".to_string()),
                ("groq".to_string(), "openai/gpt-oss-20b".to_string()),
                ("gemini_web".to_string(), "gemini-web".to_string()),
                ("cerebras".to_string(), "llama3.1-8b".to_string()),
                ("openrouter".to_string(), "meta-llama/llama-3.3-70b-instruct:free".to_string()),
                ("openrouter".to_string(), "openrouter/free".to_string()),
            ]
        );

        // Se desconectar o gemini_web (chave vazia), ele sai da cadeia:
        db.save_ai_provider_key(1, "gemini_web", "", "", "").unwrap();
        let chain_disconnected = super::build_ai_fallback_chain(&db, 1, &primary);
        assert!(!chain_disconnected.iter().any(|c| c.provider == "gemini_web"));

        let _ = std::fs::remove_file(tmp);
    }
}

#[cfg(test)]
mod antiban_link_tests {
    #[test]
    fn bloqueia_links_no_texto_final() {
        assert!(super::contains_link("acesse https://exemplo.com"));
        assert!(super::contains_link("fale em wa.me/5511999999999"));
        assert!(super::contains_link("acesse exemplo.com.br"));
        assert!(!super::contains_link("Olá, estamos disponíveis para conversar."));
    }
}

#[cfg(test)]
mod vexor_device_bridge_tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn optout_do_vexor_grava_e_enfileira_sem_duplicar() {
        let path = std::env::temp_dir().join(format!("esfera_vexor_bridge_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::init(path.to_string_lossy().as_ref()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream,_) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new(); let mut buf = [0u8;4096];
                let (start, length) = loop {
                    let n = stream.read(&mut buf).unwrap(); assert!(n > 0); request.extend_from_slice(&buf[..n]);
                    if let Some(i) = request.windows(4).position(|w| w==b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..i]).to_lowercase();
                        assert!(headers.contains("authorization: bearer teste"));
                        assert!(headers.contains("x-esfera-company: 1"));
                        let len: usize = headers.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v|v.trim().parse().ok())).unwrap();
                        break (i+4,len);
                    }
                };
                while request.len() < start+length { let n=stream.read(&mut buf).unwrap(); assert!(n>0); request.extend_from_slice(&buf[..n]); }
                let payload: serde_json::Value = serde_json::from_slice(&request[start..start+length]).unwrap();
                let id=payload["messages"][0]["id"].as_str().unwrap();
                let response=serde_json::json!({"results":[{"id":id,"decision":"OPT_OUT","confirmationText":OPT_OUT_CONFIRMATION_TEXT}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        let line = r#"{"title":"Esfera 5575988052539","text":"SAIR","ts":1793180000000}"#;
        let endpoint=format!("http://{}/esfera/device-messages",addr);
        assert!(forward_device_messages_at(&db,"device1",1,line,"teste",&endpoint));
        assert!(forward_device_messages_at(&db,"device1",1,line,"teste",&endpoint));
        server.join().unwrap();
        assert!(db.is_opted_out(1,"75988052539"));
        assert_eq!(db.pending_confirmations().len(),1);
    }
}

#[cfg(test)]
mod local_fallback_tests {
    use super::*;
    use crate::db::Campaign;
    use chrono::Weekday;

    #[test]
    fn janela_de_confirmacao_exige_horario_e_aparelho_livre() {
        assert!(send_window_at(Weekday::Mon,8));
        assert!(!send_window_at(Weekday::Mon,7));
        assert!(!send_window_at(Weekday::Fri,20));
        assert!(send_window_at(Weekday::Sat,13));
        assert!(!send_window_at(Weekday::Sat,14));
        assert!(!send_window_at(Weekday::Sun,10));
        assert!(confirmation_allowed(true,false));
        assert!(!confirmation_allowed(true,true));
        assert!(!confirmation_allowed(false,false));
        assert!(!confirmation_allowed(false,true));
    }

    #[test]
    fn descadastro_local_protege_fila_sem_vexor_e_preserva_outros_numeros() {
        let path=std::env::temp_dir().join(format!("esfera_local_sair_{}.db",std::process::id()));
        let _=std::fs::remove_file(&path);
        let db=Database::init(path.to_string_lossy().as_ref()).unwrap();
        let campaign=Campaign { id:0, name:"Teste".into(), greeting:"Olá".into(), message:"Teste".into(), closing:"SAIR".into(), delay_min:30, delay_max:60, use_spintax:false, use_ai:false, ai_model:String::new(), ai_provider:String::new(), ai_prompt:String::new(), device_ids:vec![], status:"draft".into(), contacts_count:0, sent_count:0, failed_count:0, company_id:1, updated_at:String::new() };
        let id=db.create_campaign(&campaign).unwrap();
        db.import_contacts(id,vec![("Pessoa".into(),"5575988052539".into()),("Outra".into(),"5575911112222".into())]).unwrap();
        let old=r#"{"title":"Esfera 5575988052539","text":"SAIIR"}"#;
        let new=r#"{"title":"Esfera 5575911112222","text":"Bom dia"}"#;
        assert!(process_opt_out_jsonl(&db,"celular",1,old,None));
        assert!(process_opt_out_jsonl(&db,"celular",1,new,None));
        assert!(db.is_opted_out(1,"5575988052539"));
        assert!(!db.is_opted_out(1,"5575911112222"));
        assert!(db.get_contacts(id).iter().any(|c| c.phone=="5575988052539" && c.status=="opt_out"));
        assert!(db.get_contacts(id).iter().any(|c| c.phone=="5575911112222" && c.status=="pending"));
        // A sincronização pode falhar sem desfazer o registro local.
        assert!(!forward_device_messages_at(&db,"celular",1,old,"teste","http://127.0.0.1:0/esfera/device-messages"));
        assert!(db.is_opted_out(1,"5575988052539"));
        assert!(local_opt_out("Por favor quero SAIR das mensagens agora mesmo, obrigada."));
        assert!(!local_opt_out("Bom dia, vou verificar"));
    }
}

#[cfg(test)]
mod agent_install_lock_tests {
    use super::*;
    #[tokio::test]
    async fn atualizacao_aguarda_disparo_no_mesmo_aparelho() {
        let sending=device_operation_lock_for_id(999999);
        let _guard=sending.lock().await;
        assert!(device_operation_lock_for_id(999999).try_lock().is_err());
        assert!(device_operation_lock_for_id(999998).try_lock().is_ok());
    }
}

#[cfg(test)]
mod rede_tests {
    use super::*;
    #[tokio::test]
    async fn trava_de_rede_sobrevive_ao_cancelamento_do_chamador() {
        let guard = NetworkSendGuard(NETWORK_SEND_GATE.lock().await, 7);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let task = tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || { let _guard = guard; started_tx.send(()).unwrap(); release_rx.recv().unwrap(); }).await;
        });
        tokio::task::yield_now().await;
        started_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        task.abort();
        assert!(NETWORK_SEND_GATE.try_lock().is_err());
        release_tx.send(()).unwrap();
        let _guard = tokio::time::timeout(Duration::from_secs(2), NETWORK_SEND_GATE.lock()).await.unwrap();
    }
    #[test]
    fn importa_resposta_local_sem_token_e_sem_duplicar() {
        let path = std::env::temp_dir().join(format!("esfera_resposta_local_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::init(path.to_string_lossy().as_ref()).unwrap();
        db.pooled_conn().unwrap().execute("INSERT INTO ESF_Device(AdbDeviceId,DeviceName,CompanyId) VALUES('usb-local','Teste',1)", []).unwrap();
        let line = r#"{"title":"Esfera 11999999999","text":"Tudo bem","ts":1700000000000}"#;
        assert!(process_opt_out_jsonl(&db,"usb-local",1,line,None));
        assert!(process_opt_out_jsonl(&db,"usb-local",1,line,None));
        let count: i64 = db.pooled_conn().unwrap().query_row("SELECT count(*) FROM ESF_ReplyInbound", [], |r|r.get(0)).unwrap();
        assert_eq!(count,1);
    }
    #[test]
    fn intervalo_se_aplica_na_troca_de_aparelho() {
        assert_eq!(network_gap(Some((1, 8)), 2, 30), 22);
        assert_eq!(network_gap(Some((1, 31)), 2, 30), 0);
        assert_eq!(network_gap(Some((1, 8)), 1, 30), 0);
        assert_eq!(network_gap(None, 1, 30), 0);
    }
}
