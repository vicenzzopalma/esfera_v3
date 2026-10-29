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

static CAMPAIGN_DEVICE_INDEX: std::sync::LazyLock<Mutex<HashMap<i32, usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static KEEPALIVE_LAST_ATTEMPT: std::sync::LazyLock<Mutex<HashMap<String, (i64, bool)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
#[allow(dead_code)]
static SEND_DEVICE_PREPARED: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static DEVICE_SEND_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
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
static OPT_OUT_IMPORT_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

/// Importa os pedidos de descadastro gravados pelo agente em cada aparelho online.
pub fn import_opt_out_requests(db: &Database) {
    for dev in db.get_all_devices().into_iter().filter(|d| d.status == "online") {
        let serial = dev.current_adb_address.clone().filter(|a| !a.trim().is_empty()).unwrap_or(dev.serial.clone());
        import_opt_out_from_device(db, &serial, dev.company_id);
    }
}

/// Importa os "SAIR" de um aparelho. O arquivo é movido para `.reading` antes de ler (linhas novas
/// caem num arquivo novo) e só é apagado depois que todas as linhas foram gravadas no banco. Se a
/// conexão cair no meio, o `.reading` fica e é lido de novo na próxima vez (o registro não duplica).
pub fn import_opt_out_from_device(db: &Database, serial: &str, company_id: i32) {
    let _guard = OPT_OUT_IMPORT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    {
        let out = match AdbManager::execute_shell(
            serial,
            "if [ ! -s /sdcard/esfera_optout.reading ] && [ -s /sdcard/esfera_optout.jsonl ]; then mv /sdcard/esfera_optout.jsonl /sdcard/esfera_optout.reading; fi; cat /sdcard/esfera_optout.reading 2>/dev/null",
            6,
        ) {
            Ok(o) => o,
            Err(_) => return,
        };
        if out.trim().is_empty() {
            return;
        }
        let all_saved = process_opt_out_jsonl(db, serial, company_id, &out, None);
        if all_saved {
            let _ = AdbManager::execute_shell(serial, "rm -f /sdcard/esfera_optout.reading", 4);
        }
    }
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
            Err(_) => continue,
        };
        let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
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

/// Janela de envio no horário local do PC: seg-sex 08:00-20:00, sábado 08:00-14:00, domingo fechado.
pub fn within_send_window() -> bool {
    use chrono::{Datelike, Timelike, Weekday};
    let now = chrono::Local::now();
    let h = now.hour();
    match now.weekday() {
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
static TEMP_CONTACTS_LOAD_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

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
    let _guard = TEMP_CONTACTS_LOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

async fn pooled_ai_message(campaign: &crate::db::Campaign, chain: &[crate::db::AiConfig], contact_name: &str) -> Result<String, String> {
    let key = (campaign.id, campaign_fingerprint(campaign));
    let need_more = AI_VARIANT_POOLS
        .lock()
        .map(|pools| {
            pools
                .get(&key)
                .map_or(true, |p| p.parts.is_empty() || p.parts.iter().any(|v| v.len() < AI_VARIANTS_PER_PART))
        })
        .unwrap_or(true);
    let mut fresh = None;
    let mut error = None;
    if need_more {
        let base = base_with_name_placeholder(campaign);
        let has_gemini_web = chain.iter().any(|c| c.provider.eq_ignore_ascii_case("gemini_web"));
        let total_timeout_secs = if has_gemini_web { 180 } else { 45 };
        match timeout(Duration::from_secs(total_timeout_secs), AiEngine::rewrite_parts(chain, &base)).await {
            Ok(Ok(parts)) => fresh = Some(parts),
            Ok(Err(e)) => error = Some(e),
            Err(_) => error = Some(format!("Tempo limite total de {}s na geração de IA", total_timeout_secs)),
        }
    }
    let chosen = {
        let mut pools = AI_VARIANT_POOLS.lock().map_err(|_| "banco de variações indisponível".to_string())?;
        pool_take(pools.entry(key).or_default(), fresh)
    };
    match chosen {
        Some(parts) => Ok(AiEngine::replace_contact_name(&parts.join("\n\n"), contact_name)),
        None => Err(error.unwrap_or_else(|| "sem variações de IA disponíveis".to_string())),
    }
}

/// Monta a cadeia de reserva de IA:
/// Groq 120b -> Groq 20b -> gemini_web (quando conectado) -> Cerebras -> OpenRouter -> openrouter/free.
pub fn build_ai_fallback_chain(
    db: &Database,
    company_id: i32,
    config: &crate::db::AiConfig,
) -> Vec<crate::db::AiConfig> {
    let mut chain = vec![config.clone()];
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
    app_handle: Option<AppHandle>,
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
        let db2 = db_arc.clone();
        match spawn_blocking(move || db2.get_ai_config(campaign.company_id)).await {
            Ok(global_config) => {
                let mut config = if let Some(config) = global_config {
                    config
                } else {
                    crate::db::AiConfig {
                        company_id: campaign.company_id,
                        provider: if !campaign.ai_provider.is_empty() { campaign.ai_provider.clone() } else { "groq".to_string() },
                        model: if !campaign.ai_model.is_empty() { campaign.ai_model.clone() } else { "openai/gpt-oss-120b".to_string() },
                        temperature: 0.7,
                        system_prompt: String::new(),
                        api_key: String::new(),
                        endpoint: String::new(),
                    }
                };

                // Se a campanha tiver provedor específico, prioriza o da campanha
                if !campaign.ai_provider.is_empty() {
                    if campaign.ai_provider != config.provider {
                        config.provider = campaign.ai_provider.clone();
                        config.endpoint = String::new();
                        if let Some((saved_key, saved_ep, saved_model)) = db_arc.get_ai_provider_key(campaign.company_id, &campaign.ai_provider) {
                            config.api_key = saved_key;
                            if !saved_ep.is_empty() { config.endpoint = saved_ep; }
                            if !saved_model.is_empty() && campaign.ai_model.trim().is_empty() { config.model = saved_model; }
                        } else {
                            config.api_key = String::new();
                        }
                    }
                }
                if !campaign.ai_model.trim().is_empty() {
                    config.model = campaign.ai_model.clone();
                }
                if !campaign.ai_prompt.trim().is_empty() {
                    config.system_prompt = campaign.ai_prompt.clone();
                }

                // Cadeia: provedor da campanha/global primeiro, depois os outros com chave salva
                // (Groq 120b -> Groq 20b -> gemini_web -> Cerebras -> OpenRouter).
                let chain = build_ai_fallback_chain(&db_arc, campaign.company_id, &config);
                // Variações da IA reaproveitadas na campanha (poucas chamadas; nome não vai para a IA).
                let ai_result = pooled_ai_message(&campaign, &chain, &next_contact.contact_name).await;
                match ai_result {
                    Ok(custom_msg) => custom_msg,
                    Err(error) => {
                        // Fallback resiliente: não quebra a campanha de 100 celulares. Usa a mensagem base com substituição de nome.
                        eprintln!("[DISPATCHER IA] Falha na IA: {}. Aplicando fallback de mensagem original.", error);
                        if let Some(ref handle) = app_handle {
                            let _ = handle.emit("campaign-progress", CampaignProgressEvent {
                                campaign_id: campaign.id,
                                campaign_name: campaign.name.clone(),
                                sent_count: campaign.sent_count,
                                total_contacts: campaign.contacts_count,
                                last_contact_phone: next_contact.phone.clone(),
                                delay_used_ms: 0,
                                status: format!("IA aviso (fallback ativo): {}", error),
                            });
                        }
                        AiEngine::replace_contact_name(&campaign_text, &next_contact.contact_name)
                    }
                }
            }
            _ => AiEngine::replace_contact_name(&campaign_text, &next_contact.contact_name),
        }
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
                        Some((fingerprint, handle)) if fingerprint == campaign_fingerprint(&campaign) => match handle.await {
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

                    let db2 = db_arc.clone();
                    let active_devices = match spawn_blocking(move || db2.get_devices(campaign.company_id)).await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let online_devices: Vec<_> = active_devices.into_iter().filter(|d| {
                        d.status == "online" && campaign.device_ids.iter().any(|id| {
                            d.esfera_device_id.as_deref() == Some(id.as_str()) || d.serial == *id
                        })
                    }).collect();

                    let preparation_ms = preparation_started.elapsed().as_millis();
                    let send_started = Instant::now();
                    // Regra da empresa: nenhuma mensagem pode citar valores (nem quando a IA falha e volta o original).
                    let outcome = if AiEngine::has_money(&message_to_send) {
                        eprintln!("[DISPATCHER] Envio bloqueado para {}: a mensagem cita valores.", phone);
                        SendOutcome::SendFailed("Mensagem cita valores (proibido)".to_string())
                    } else if online_devices.is_empty() {
                        SendOutcome::NoOnlineDevice
                    } else {
                        let serial = {
                            let mut idx_map = CAMPAIGN_DEVICE_INDEX.lock().unwrap();
                            let idx = idx_map.entry(campaign.id).or_insert(0);
                            let target_dev = &online_devices[*idx % online_devices.len()];
                            *idx = (*idx + 1) % online_devices.len();
                            target_dev.current_adb_address.as_ref()
                                .filter(|a| !a.trim().is_empty())
                                .cloned()
                                .unwrap_or_else(|| target_dev.serial.clone())
                        };

                        let msg = message_to_send.clone();
                        let phone2 = phone.clone();
                        let contact_name = next_contact.contact_name.clone();
                        let device_lock = {
                            let mut locks = DEVICE_SEND_LOCKS.lock().unwrap();
                            locks.entry(serial.clone())
                                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                                .clone()
                        };
                        let _device_guard = device_lock.lock().await;
                        let db_last = db_arc.clone();
                        let company_last = campaign.company_id;
                        let campaign_last = campaign.id;
                        let send_res = spawn_blocking(move || {
                            // Traz os "SAIR" capturados pelo agente agora, e revalida o descadastro no último instante.
                            import_opt_out_from_device(&db_last, &serial, company_last);
                            if db_last.is_opted_out(company_last, &phone2) {
                                return Err("Contato descadastrado durante o preparo; envio cancelado".to_string());
                            }
                            let name_ref = if contact_name.trim().is_empty() { None } else { Some(contact_name.as_str()) };
                            println!("[DISPATCHER] Disparando contato '{}' ({}) via navegacao nativa WhatsApp no aparelho {}", contact_name, phone2, serial);
                            // Garante o contato na agenda; espera só o que falta para o WhatsApp indexar.
                            prepare_temp_contact_for_send(&serial, &phone2);
                            let _ = name_ref;
                            let parts = AdbManager::split_human_parts(&msg);
                            // Antes de cada parte: dentro do horário, ainda não descadastrado e campanha ainda rodando.
                            let check = || {
                                import_opt_out_from_device(&db_last, &serial, company_last);
                                within_send_window()
                                    && !db_last.is_opted_out(company_last, &phone2)
                                    && db_last
                                        .get_running_campaigns()
                                        .map(|l| l.iter().any(|c| c.id == campaign_last))
                                        .unwrap_or(false)
                            };
                            AdbManager::send_whatsapp_parts(&serial, &phone2, &parts, Some("com.whatsapp"), &check)
                        }).await;

                        match send_res {
                            Ok(Ok(_)) => {
                                println!("[DISPATCHER] Mensagem enviada com sucesso para {} via navegacao nativa!", phone);
                                SendOutcome::Sent
                            }
                            Ok(Err(e)) => {
                                eprintln!("[DISPATCHER] Erro no envio para {}: {}", phone, e);
                                SendOutcome::SendFailed(e)
                            }
                            Err(e) => {
                                eprintln!("[DISPATCHER] Falha de execucao no worker para {}: {}", phone, e);
                                SendOutcome::SendFailed(e.to_string())
                            }
                        }
                    };
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

                    let delay_min_ms = campaign.delay_min * 1000;
                    let delay_max_ms = campaign.delay_max * 1000;
                    let gaussian_delay_ms = AdbManager::calculate_gaussian_delay(delay_min_ms, delay_max_ms);

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

    /// A cada 30s, lê dos celulares conectados os pedidos de descadastro ("SAIR") capturados pelo
    /// agente (/sdcard/esfera_optout.jsonl), grava em ESF_OptOut e tira o número das filas pendentes.
    pub fn start_opt_out_import_loop(db_arc: Arc<Database>) {
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(30)).await;
                let db = db_arc.clone();
                let _ = spawn_blocking(move || import_opt_out_requests(&db)).await;
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
