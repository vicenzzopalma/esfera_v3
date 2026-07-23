// ============================================================
// Esfera v3 — Motor de Disparos em Background (dispatcher.rs)
// DispatchCoordinator & MobileWorker com Delay Gaussiano C++ HPC
// ============================================================

use crate::adb_manager::AdbManager;
use crate::ai_engine::AiEngine;
use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
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
    pub fn start_worker(db_arc: Arc<Mutex<Database>>, app_handle: Option<AppHandle>) {
        tauri::async_runtime::spawn(async move {
            loop {
                // Intervalo da fila de sincronização principal (a cada 3 segundos)
                sleep(Duration::from_secs(3)).await;

                let active_campaigns = {
                    if let Ok(db) = db_arc.lock() {
                        db.get_running_campaigns().unwrap_or_default()
                    } else {
                        Vec::new()
                    }
                };

                for campaign in active_campaigns {
                    let next_contact = {
                        if let Ok(db) = db_arc.lock() {
                            db.get_next_pending_contact(campaign.id)
                        } else {
                            None
                        }
                    };

                    if let Some(contact) = next_contact {
                        // 1. Verificação de Deduplicação
                        let already_sent = {
                            if let Ok(db) = db_arc.lock() {
                                db.was_already_sent(&contact.phone, campaign.id)
                            } else {
                                false
                            }
                        };

                        if already_sent {
                            if let Ok(db) = db_arc.lock() {
                                let _ = db.update_contact_status(contact.id, "already_sent");
                            }
                            continue;
                        }

                        // 2. Personalização via IA (se ativado na campanha)
                        let message_to_send = if campaign.use_ai {
                            let ai_config = {
                                if let Ok(db) = db_arc.lock() {
                                    db.get_ai_config(campaign.company_id)
                                } else {
                                    None
                                }
                            };

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

                        // 3. Execução Humana Tecla-por-Tecla via C++ HPC
                        // 3. Execução Humana Tecla-por-Tecla via C++ HPC em dispositivos ONLINE
                        let active_devices = {
                            if let Ok(db) = db_arc.lock() {
                                db.get_devices(campaign.company_id)
                            } else {
                                Vec::new()
                            }
                        };

                        let online_devices: Vec<_> = active_devices.into_iter().filter(|d| d.status == "online").collect();

                        if let Some(target_dev) = online_devices.first() {
                            let _ = AdbManager::type_text_human_hpc(&target_dev.serial, &message_to_send);
                            let _ = AdbManager::send_keyevent(&target_dev.serial, 66);
                        }

                        // 4. Cálculo de Delay Gaussiano Nativo entre disparos via Engine C++ HPC
                        let delay_min_ms = campaign.delay_min * 1000;
                        let delay_max_ms = campaign.delay_max * 1000;
                        let gaussian_delay_ms = AdbManager::calculate_gaussian_delay(delay_min_ms, delay_max_ms);

                        // Aguarda o intervalo Gaussiano C++ HPC antes do próximo envio
                        sleep(Duration::from_millis(gaussian_delay_ms as u64)).await;

                        // 4. Atualização no banco
                        if let Ok(db) = db_arc.lock() {
                            let _ = db.mark_as_sent(&contact.phone, campaign.id);
                            let _ = db.update_contact_status(contact.id, "sent");
                            let _ = db.increment_campaign_sent_count(campaign.id);
                        }

                        // 5. Emissão de evento Realtime via Tauri
                        if let Some(ref handle) = app_handle {
                            let progress = CampaignProgressEvent {
                                campaign_id: campaign.id,
                                campaign_name: campaign.name.clone(),
                                sent_count: campaign.sent_count + 1,
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

    /// Loop persistente de manter conexões ADB vivas e reinjetar Keep-Alive continuamente
    pub fn start_persistent_adb_keepalive_loop(db_arc: Arc<Mutex<Database>>) {
        tauri::async_runtime::spawn(async move {
            loop {
                // Roda a cada 30 segundos em segundo plano (otimizado)
                sleep(Duration::from_secs(30)).await;

                let saved_devices = {
                    if let Ok(db) = db_arc.lock() {
                        db.get_all_devices()
                    } else {
                        Vec::new()
                    }
                };

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
                        // Executa adb connect permanente em segundo plano
                        if let Ok(_) = AdbManager::connect_device(&ip_target, port) {
                            let full_serial = format!("{}:{}", ip_target, port);
                            // Reinjeta as regras de Keep-Alive nativo do Android
                            let _ = AdbManager::deploy_keepalive(&full_serial);
                        }
                    } else if !dev.serial.is_empty() && !dev.serial.contains(':') {
                        let _ = AdbManager::deploy_keepalive(&dev.serial);
                    }
                }
            }
        });
    }
}
