// ============================================================
// Esfera v3 — Motor de Disparos em Background (dispatcher.rs)
// DispatchCoordinator & MobileWorker com Delay Gaussiano C++ HPC
// ============================================================

use crate::adb_manager::AdbManager;
use crate::ai_engine::AiEngine;
use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::task::spawn_blocking;
use tokio::time::{sleep, Duration};

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

pub struct Dispatcher;

impl Dispatcher {
    /// Inicia o worker assíncrono do motor de disparos em background com suporte a AppHandle
    pub fn start_worker(db_arc: Arc<Database>, app_handle: Option<AppHandle>) {
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(3)).await;

                let db = db_arc.clone();
                let active_campaigns = spawn_blocking(move || db.get_running_campaigns().unwrap_or_default())
                    .await
                    .unwrap_or_default();

                for campaign in active_campaigns {
                    let db = db_arc.clone();
                    let next_contact = spawn_blocking(move || db.get_next_pending_contact(campaign.id))
                        .await
                        .unwrap_or(None);

                    if let Some(contact) = next_contact {
                        let db = db_arc.clone();
                        let phone_check = contact.phone.clone();
                        let already_sent = spawn_blocking(move || db.was_already_sent(&phone_check, campaign.id))
                            .await
                            .unwrap_or(false);

                        if already_sent {
                            let db = db_arc.clone();
                            let cid = contact.id;
                            let _ = spawn_blocking(move || { let _ = db.update_contact_status(cid, "already_sent"); }).await;
                            continue;
                        }

                        let message_to_send = if campaign.use_ai {
                            let db = db_arc.clone();
                            let ai_config = spawn_blocking(move || db.get_ai_config(campaign.company_id))
                                .await
                                .unwrap_or(None);

                            if let Some(config) = ai_config {
                                match AiEngine::generate_message(&config, &campaign.message, &contact.contact_name).await {
                                    Ok(custom_msg) => custom_msg,
                                    Err(_) => campaign.message.replace("{nome}", &contact.contact_name),
                                }
                            } else {
                                campaign.message.replace("{nome}", &contact.contact_name)
                            }
                        } else {
                            campaign.message.replace("{nome}", &contact.contact_name)
                        };

                        let db = db_arc.clone();
                        let active_devices = spawn_blocking(move || db.get_devices(campaign.company_id))
                            .await
                            .unwrap_or_default();
                        let online_devices: Vec<_> = active_devices.into_iter().filter(|d| d.status == "online").collect();

                        if let Some(target_dev) = online_devices.first() {
                            let serial = target_dev.serial.clone();
                            let msg = message_to_send.clone();
                            let phone = contact.phone.clone();
                            let _ = spawn_blocking(move || {
                                let _ = AdbManager::configure_device_socks_proxy_and_revoke_bssid(&serial, None);
                                let _ = AdbManager::send_whatsapp_intent_and_bezier_tap(&serial, &phone, &msg);
                            }).await;
                        }

                        let delay_min_ms = campaign.delay_min * 1000;
                        let delay_max_ms = campaign.delay_max * 1000;
                        let gaussian_delay_ms = AdbManager::calculate_gaussian_delay(delay_min_ms, delay_max_ms);

                        sleep(Duration::from_millis(gaussian_delay_ms as u64)).await;

                        let db = db_arc.clone();
                        let phone = contact.phone.clone();
                        let cid = campaign.id;
                        let cid2 = campaign.id;
                        let sent_before = campaign.sent_count;
                        let _ = spawn_blocking(move || {
                            let _ = db.mark_as_sent(&phone, cid);
                            let _ = db.update_contact_status(contact.id, "sent");
                            let _ = db.increment_campaign_sent_count(cid2);
                        }).await;

                        if let Some(ref handle) = app_handle {
                            let progress = CampaignProgressEvent {
                                campaign_id: campaign.id,
                                campaign_name: campaign.name.clone(),
                                sent_count: sent_before + 1,
                                total_contacts: campaign.contacts_count,
                                last_contact_phone: contact.phone.clone(),
                                delay_used_ms: gaussian_delay_ms,
                                status: "running".to_string(),
                            };
                            let _ = handle.emit("campaign-progress", progress);
                        }
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
                let saved_devices = spawn_blocking(move || db.get_all_devices())
                    .await
                    .unwrap_or_default();

                for dev in saved_devices {
                    let ip_target = if !dev.ip.is_empty() {
                        dev.ip.clone()
                    } else if dev.serial.contains(':') {
                        dev.serial.split(':').next().unwrap_or("").to_string()
                    } else {
                        "".to_string()
                    };

                    if !ip_target.is_empty() && ip_target.contains('.') {
                        let port = if dev.port > 0 { dev.port } else { 5555 };
                        let ip = ip_target.clone();
                        if let Ok(_) = spawn_blocking(move || AdbManager::connect_device(&ip, port)).await.unwrap_or(Err("failed".to_string())) {
                            let full_serial = format!("{}:{}", ip_target, port);
                            let _ = spawn_blocking(move || AdbManager::deploy_keepalive(&full_serial)).await;
                        }
                    } else if !dev.serial.is_empty() && !dev.serial.contains(':') {
                        let s = dev.serial.clone();
                        let _ = spawn_blocking(move || AdbManager::deploy_keepalive(&s)).await;
                    }
                }
            }
        });
    }
}