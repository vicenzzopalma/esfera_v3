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
                // Não descarta: guarda numa fila de revisão local para o operador descadastrar manualmente.
                let dir = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join("esfera_v3");
                let _ = std::fs::create_dir_all(&dir);
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("descadastro_revisar.jsonl")) {
                    use std::io::Write;
                    let _ = writeln!(f, "{}", line.trim());
                }
                eprintln!("[DESCADASTRO] Pedido sem número identificável (título '{}'); guardado em descadastro_revisar.jsonl para revisão.", title);
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
        if all_saved {
            let _ = AdbManager::execute_shell(serial, "rm -f /sdcard/esfera_optout.reading", 4);
        }
    }
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

/// Tempo que o WhatsApp leva para achar na busca um contato recém-salvo.
const TEMP_CONTACT_INDEX_MS: u64 = 2500;

fn temp_key(serial: &str, phone: &str) -> String {
    format!("{}|{}", serial, AdbManager::extract_phone_digits(phone))
}

/// Salva o contato no aparelho se ainda não estiver salvo. Retorna true se acabou de criar.
/// Se outra thread (a semeadura) está salvando o mesmo contato, espera ela em vez de duplicar.
pub fn ensure_temp_contact(serial: &str, phone: &str) -> bool {
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
    let created = match AdbManager::insert_temporary_contact(serial, &temp_contact_name(phone), phone) {
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

                // Cadeia: provedor da campanha/global primeiro, depois os outros com chave salva.
                let mut chain = vec![config.clone()];
                for alt in ["groq", "openrouter", "cerebras"] {
                    if alt == config.provider.to_lowercase() {
                        continue;
                    }
                    if let Some((key, ep, model)) = db_arc.get_ai_provider_key(campaign.company_id, alt) {
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
                let ai_result = timeout(Duration::from_secs(45), AiEngine::generate_parts_chain(&chain, &campaign_text, &next_contact.contact_name))
                    .await
                    .unwrap_or_else(|_| Err("Tempo limite total de 45s na geração de IA".to_string()));
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
