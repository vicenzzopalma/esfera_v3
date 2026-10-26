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

pub struct Dispatcher;

impl Dispatcher {
    /// Inicia o worker assíncrono do motor de disparos em background com suporte a AppHandle.
    /// Mantém fluidez por: polling menor, lote limitado e backpressure artificial.
    pub fn start_worker(db_arc: Arc<Database>, app_handle: Option<AppHandle>) {
        tauri::async_runtime::spawn(async move {
            let mut poll_delay = Duration::ZERO;
            loop {
                sleep(poll_delay).await;

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
                let mut tasks = Vec::new();
                for campaign in active_campaigns {
                    let db_arc = db_arc.clone();
                    let app_handle = app_handle.clone();
                    tasks.push(tauri::async_runtime::spawn(async move {
                    let lookup_started = Instant::now();
                    let db1 = db_arc.clone();
                    let next_contact = match spawn_blocking(move || db1.try_get_next_pending_contact(campaign.id)).await {
                        Ok(Ok(Some(c))) => c,
                        Ok(Ok(None)) => {
                            let db_done = db_arc.clone();
                            let campaign_id = campaign.id;
                            let _ = spawn_blocking(move || db_done.set_campaign_status(campaign_id, "completed")).await;
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
                    let lookup_ms = lookup_started.elapsed().as_millis();
                    let preparation_started = Instant::now();

                    // Monta o texto base: saudação + corpo + despedida, com Spintax resolvido
                    let campaign_text = {
                        let mut full = String::new();
                        if !campaign.greeting.trim().is_empty() {
                            full.push_str(&campaign.greeting);
                            full.push(' ');
                        }
                        full.push_str(&campaign.message);
                        if !campaign.closing.trim().is_empty() {
                            full.push(' ');
                            full.push_str(&campaign.closing);
                        }
                        if campaign.use_spintax {
                            // Troca {nome} antes do spintax: sem isso o motor trata "{nome}" como bloco de 1 variante e envia "nome".
                            let full = AiEngine::replace_contact_name(&full, &next_contact.contact_name);
                            crate::spintax::resolve_spintax(&full)
                        } else {
                            full
                        }
                    };

                    let message_to_send = if campaign.use_ai {
                        let db2 = db_arc.clone();
                        match spawn_blocking(move || db2.get_ai_config(campaign.company_id)).await {
                            Ok(global_config) => {
                                let mut config = if let Some(config) = global_config {
                                    config
                                } else {
                                    crate::db::AiConfig {
                                        company_id: campaign.company_id,
                                        provider: if !campaign.ai_provider.is_empty() { campaign.ai_provider.clone() } else { "groq".to_string() },
                                        model: if !campaign.ai_model.is_empty() { campaign.ai_model.clone() } else { "llama-3.3-70b-versatile".to_string() },
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

                                let ai_result = timeout(Duration::from_secs(15), AiEngine::generate_message(&config, &campaign_text, &next_contact.contact_name))
                                    .await
                                    .unwrap_or_else(|_| Err("Tempo limite total de 15s na geração de IA".to_string()));
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
                    let outcome = if online_devices.is_empty() {
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
                        let send_res = spawn_blocking(move || {
                            let name_ref = if contact_name.trim().is_empty() { None } else { Some(contact_name.as_str()) };
                            println!("[DISPATCHER] Disparando contato '{}' ({}) via navegacao nativa WhatsApp no aparelho {}", contact_name, phone2, serial);
                            AdbManager::send_whatsapp_with_contact(&serial, &phone2, &msg, name_ref, Some("com.whatsapp"))
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
                    }));
                }
                for task in tasks {
                    if let Err(error) = task.await {
                        eprintln!("[DISPATCHER] Falha na tarefa de campanha: {}", error);
                    }
                }
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
