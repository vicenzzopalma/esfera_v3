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
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task::spawn_blocking;
use tokio::time::{sleep, Duration};

static CAMPAIGN_DEVICE_INDEX: std::sync::LazyLock<Mutex<HashMap<i32, usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static KEEPALIVE_LAST_ATTEMPT: std::sync::LazyLock<Mutex<HashMap<String, (i64, bool)>>> =
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
            loop {
                sleep(Duration::from_secs(2)).await;

                let db = db_arc.clone();
                let active_campaigns = match spawn_blocking(move || db.get_running_campaigns()).await {
                    Ok(Ok(v)) => v,
                    _ => continue,
                };

                if active_campaigns.is_empty() {
                    continue;
                }

                // Processa no máximo 1 contato por tick por campanha para reduzir spawns.
                for campaign in active_campaigns {
                    let db1 = db_arc.clone();
                    let next_contact = match spawn_blocking(move || db1.get_next_pending_contact(campaign.id)).await {
                        Ok(Some(c)) => c,
                        _ => continue,
                    };

                    let phone = next_contact.phone.clone();
                    let phone_check = phone.clone();
                    let db_check = db_arc.clone();
                    let already_sent = match spawn_blocking(move || db_check.was_already_sent(&phone_check, campaign.id)).await {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    if already_sent {
                        let db2 = db_arc.clone();
                        let cid = next_contact.id;
                        let _ = spawn_blocking(move || db2.update_contact_status(cid, "already_sent")).await;
                        continue;
                    }

                    let message_to_send = if campaign.use_ai {
                        let db2 = db_arc.clone();
                        match spawn_blocking(move || db2.get_ai_config(campaign.company_id)).await {
                            Ok(Some(config)) => {
                                match AiEngine::generate_message(&config, &campaign.message, &next_contact.contact_name).await {
                                    Ok(custom_msg) => custom_msg,
                                    Err(_) => campaign.message.replace("{nome}", &next_contact.contact_name),
                                }
                            }
                            _ => campaign.message.replace("{nome}", &next_contact.contact_name),
                        }
                    } else {
                        campaign.message.replace("{nome}", &next_contact.contact_name)
                    };

                    let db2 = db_arc.clone();
                    let active_devices = match spawn_blocking(move || db2.get_devices(campaign.company_id)).await {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let online_devices: Vec<_> = active_devices.into_iter().filter(|d| d.status == "online").collect();

                    let outcome = if online_devices.is_empty() {
                        SendOutcome::NoOnlineDevice
                    } else {
                        let serial = {
                            let mut idx_map = CAMPAIGN_DEVICE_INDEX.lock().unwrap();
                            let idx = idx_map.entry(campaign.id).or_insert(0);
                            let target_dev = &online_devices[*idx % online_devices.len()];
                            *idx = (*idx + 1) % online_devices.len();
                            target_dev.serial.clone()
                        };

                        let msg = message_to_send.clone();
                        let phone2 = phone.clone();
                        let send_res = spawn_blocking(move || {
                            let _ = AdbManager::configure_device_socks_proxy_and_revoke_bssid(&serial, None);
                            AdbManager::send_whatsapp_intent_and_bezier_tap(&serial, &phone2, &msg)
                        }).await;

                        match send_res {
                            Ok(Ok(_)) => SendOutcome::Sent,
                            _ => SendOutcome::SendFailed("send_failed".to_string()),
                        }
                    };

                    let delay_min_ms = campaign.delay_min * 1000;
                    let delay_max_ms = campaign.delay_max * 1000;
                    let gaussian_delay_ms = AdbManager::calculate_gaussian_delay(delay_min_ms, delay_max_ms);

                    sleep(Duration::from_millis(gaussian_delay_ms as u64)).await;

                    match outcome {
                        SendOutcome::Sent => {
                            let db3 = db_arc.clone();
                            let cid = campaign.id;
                            let cid2 = campaign.id;
                            let phone3 = phone.clone();
                            let _ = spawn_blocking(move || {
                                let _ = db3.mark_as_sent(&phone3, cid);
                                let _ = db3.update_contact_status(next_contact.id, "sent");
                                let _ = db3.increment_campaign_sent_count(cid2);
                            }).await;
                        }
                        SendOutcome::SkippedDuplicate | SendOutcome::NoOnlineDevice | SendOutcome::SendFailed(_) => {
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
                }
            }
        });
    }

    pub fn start_persistent_adb_keepalive_loop(db_arc: Arc<Database>) {
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(60)).await;

                let db = db_arc.clone();
                let saved_devices = match spawn_blocking(move || db.get_all_devices()).await {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let mut keepalive_candidates = Vec::new();

                for dev in saved_devices {
                    let key = if !dev.serial.is_empty() { dev.serial.clone() } else if !dev.ip.is_empty() { dev.ip.clone() } else { continue; };

                    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                    let last = KEEPALIVE_LAST_ATTEMPT.lock().unwrap().get(&key).copied();

                    if let Some((ts, ok)) = last {
                        if !ok && now_ms - ts < KEEPALIVE_COOLDOWN_SECS * 1000 {
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
                        spawn_blocking(move || AdbManager::connect_device(&ip, port)).await.map(|r| r.is_ok()).unwrap_or(false)
                    } else {
                        false
                    };

                    if attempted {
                        let full_serial = format!("{}:{}", ip_target, if dev.port > 0 { dev.port } else { 5555 });
                        let key2 = key.clone();
                        let deploy = spawn_blocking(move || AdbManager::deploy_keepalive(&full_serial)).await;
                        let ok = deploy.map(|r| r.is_ok()).unwrap_or(false);
                        KEEPALIVE_LAST_ATTEMPT.lock().unwrap().insert(key2, (now_ms, ok));
                    } else if !dev.serial.is_empty() && !dev.serial.contains(':') {
                        let s = dev.serial.clone();
                        let key2 = key.clone();
                        let deploy = spawn_blocking(move || AdbManager::deploy_keepalive(&s)).await;
                        let ok = deploy.map(|r| r.is_ok()).unwrap_or(false);
                        KEEPALIVE_LAST_ATTEMPT.lock().unwrap().insert(key2, (now_ms, ok));
                    }
                }
            }
        });
    }
}