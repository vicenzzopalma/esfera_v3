// ============================================================
// Esfera v3 — Entrada Principal da Biblioteca Rust (lib.rs)
// Configuração do aplicativo Tauri v2, estado do banco e IPC handlers
// Fase 1: Registrados todos os novos comandos
// ============================================================

mod adb_manager;
mod adb_tcp;
mod ai_engine;
pub mod checkin_server;
mod commands;
pub mod config;
pub mod db;
mod dispatcher;
pub mod empresa_server;
pub mod hub;
pub mod hub_client;
pub mod master_client;
pub mod presence_server;
pub mod protocol;
pub mod scrcpy_manager;
mod session;
pub mod session_manager;
mod spintax;
mod tunnel_server;
mod write_queue;

use commands::*;
use db::Database;
use crate::protocol::HubMessage;
use master_client::MasterClient;
use session::SessionManager;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;
use tauri::Manager;

fn get_db_path() -> String {
    let base_dir = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let mut dir = base_dir.join("esfera_v3");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("Aviso: nao foi possivel criar diretorio do banco: {}", e);
        dir = std::env::temp_dir().join("esfera_v3");
        let _ = std::fs::create_dir_all(&dir);
    }
    dir.push("esfera_v3.db");
    dir.to_string_lossy().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = get_db_path();
    let db = match Database::init(&db_path) {
        Ok(d) => d,
        Err(e) => {
            let err_msg = format!("FATAL: Nao foi possivel abrir o banco SQLite em '{}': {}", db_path, e);
            eprintln!("{}", err_msg);
            let crash_log = std::env::temp_dir().join("esfera_v3_crash.log");
            let _ = std::fs::write(crash_log, &err_msg);
            std::process::exit(1);
        }
    };
    let db_arc = Arc::new(db);

    // Fila Única de Escrita Assíncrona (MPSC single-writer com transações em lote)
    let write_queue = write_queue::WriteQueue::spawn(db_arc.clone(), write_queue::QUEUE_CAPACITY);
    db_arc.attach_write_queue(write_queue);

    let db_arc_clone = Arc::clone(&db_arc);
    let sessions = Arc::new(Mutex::new(SessionManager::new()));
    let master_client: Arc<TokioMutex<Option<MasterClient>>> = Arc::new(TokioMutex::new(None));

    let app_config = config::load_config();

    // Runtime de fundo único para servidores e clients (LAN, Hub, Master)
    let bg_runtime = tokio::runtime::Runtime::new().expect("Falha ao criar background runtime");

    if app_config.empresa_server_enabled {
        let db_for_server = db_arc.clone();
        let port = app_config.empresa_server_port;
        bg_runtime.spawn(async move {
            if let Err(e) = empresa_server::EmpresaServer::start(db_for_server, port).await {
                eprintln!("Empresa Server error: {}", e);
            }
        });
        println!("Empresa Server iniciado na porta {}", port);
    }

    // Empresa mode: connect to Hub with auto-reconnect
    if app_config.mode == "empresa" && app_config.hub_enabled && !app_config.hub_address.is_empty() {
        let db_for_hub = db_arc.clone();
        let hub_addr = app_config.hub_address.clone();
        bg_runtime.spawn(async move {
            let company_id = db_for_hub.get_companies().first().map(|c| c.id).unwrap_or(1);
            let company_name = format!("Empresa_{}", company_id);
            let mut backoff = 1;
            loop {
                match hub_client::HubClient::connect(&hub_addr, company_id, &company_name).await {
                    Ok(client) => {
                        println!("Conectado ao Hub {} como empresa '{}'", hub_addr, company_name);
                        backoff = 1;
                        let _ = client.listen(|cmd, args, _id| {
                            let db = db_for_hub.clone();
                            let res = match cmd.as_str() {
                                "get_companies" => serde_json::to_value(db.get_companies()).map_err(|e| e.to_string()),
                                "get_devices" => {
                                    let cid = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                    serde_json::to_value(db.get_devices(cid)).map_err(|e| e.to_string())
                                }
                                "get_campaigns" => {
                                    let cid = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                    serde_json::to_value(db.get_campaigns(cid)).map_err(|e| e.to_string())
                                }
                                "get_dashboard_kpis" => {
                                    let cid = args.get("companyId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                                    serde_json::to_value(db.get_dashboard_kpis(cid)).map_err(|e| e.to_string())
                                }
                                _ => Err(format!("Comando remoto '{}' não implementado", cmd)),
                            };
                            // Offload sync DB calls via std thread para não bloquear runtime async
                            std::thread::spawn(move || res).join().unwrap_or(Err("thread panicked".to_string()))
                        }).await;
                        eprintln!("Conexão com Hub perdida. Reconectando em {}s...", backoff);
                    }
                    Err(e) => {
                        eprintln!("Falha ao conectar ao Hub (tentativa em {}s): {}", backoff, e);
                    }
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        });
    }

    // Master mode: connect MasterClient (stored for hub_invoke commands)
    if app_config.mode == "master" && app_config.hub_enabled && !app_config.hub_address.is_empty() {
        let hub_addr = app_config.hub_address.clone();
        let mc = master_client.clone();
        bg_runtime.spawn(async move {
            let mut backoff = 1;
            loop {
                match MasterClient::connect(&hub_addr).await {
                    Ok(client) => {
                        println!("Conectado ao Hub {} como Master", hub_addr);
                        *mc.lock().await = Some(client);
                        backoff = 1;
                        loop {
                            tokio::time::sleep(Duration::from_secs(10)).await;
                            let mut guard = mc.lock().await;
                            if guard.is_none() { break; }
                            if let Some(ref c) = *guard {
                                if c.send_raw(&HubMessage::Ping).await.is_err() {
                                    *guard = None;
                                    break;
                                }
                                // Consume Pong
                                let _ = tokio::time::timeout(
                                    Duration::from_secs(3),
                                    c.read_one(),
                                ).await;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Falha Master ao conectar ao Hub (tentativa em {}s): {}", backoff, e);
                    }
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        });
        println!("Master Client conectando a {}...", app_config.hub_address);
    }

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let caps = adb_manager::AdbManager::get_hardware_capabilities();
            let hwid = adb_manager::AdbManager::get_hardware_uuid();
            println!("[Esfera v3 HPC Engine] HWID: {}", hwid);
            println!("[Esfera v3 HPC Engine] CPU Hardware Dispatch -> AVX2: {}, AVX-512: {}, SSE4.2: {}", caps.supports_avx2, caps.supports_avx512, caps.supports_sse42);

            let handle = app.handle().clone();
            if app_config.checkin_server_enabled {
                let db = db_arc_clone.clone();
                let port = app_config.checkin_server_port;
                tauri::async_runtime::spawn(async move {
                    checkin_server::start(db, port, Some(handle)).await;
                });
            }

            if app_config.tunnel_server_enabled {
                let db = db_arc_clone.clone();
                let port = app_config.tunnel_server_port;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tunnel_server::start(db, port, Some(handle)).await;
                });
            }

            // Servidor de Presença WebSocket (MDM Architecture) na porta 7779
            let ws_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                presence_server::start(7779, Some(ws_handle)).await;
            });

            dispatcher::Dispatcher::start_worker(db_arc_clone.clone(), Some(app.handle().clone()));
            dispatcher::Dispatcher::start_persistent_adb_keepalive_loop(db_arc_clone.clone());
            adb_manager::AdbManager::start_status_monitor(db_arc_clone);
            Ok(())
        })
        .manage(AppState { db: db_arc, sessions, master_client })
        .invoke_handler(tauri::generate_handler![
            // Auth
            login,
            logout,
            // Empresas
            get_companies,
            create_company,
            update_company,
            // Dispositivos
            get_devices,
            connect_adb_device,
            disconnect_adb_device,
            delete_device,
            update_device,
            optimize_device,
            get_device_ip,
            // Campanhas
            get_campaigns,
            create_campaign,
            update_campaign,
            soft_delete_campaign,
            set_campaign_status,
            // Automações
            get_automations,
            create_automation,
            update_automation,
            soft_delete_automation,
            // Logs
            get_logs,
            add_log,
            clear_logs,
            // ADB Remoto
            capture_device_screen,
            send_adb_tap,
            send_adb_keyevent,
            get_hpc_capabilities,
            // Chips
            get_device_chips,
            add_device_chip,
            update_chip_status,
            set_chip_restriction,
            confirm_chip_release,
            move_chip,
            set_chip_holder,
            mark_chip_reserve,
            get_restricted_chips,
            // Contatos
            get_campaign_contacts,
            import_campaign_contacts,
            get_pending_contacts,
            update_contact_status,
            set_contact_custom_message,
            get_next_pending_contact,
            // Sent History (dedup)
            was_already_sent,
            // Device Status & Prefs
            is_device_banned,
            set_device_banned,
            get_device_prefs,
            set_device_prefs,
            // Device Packages
            get_device_package_statuses,
            update_device_package_status,
            // USB / Pairing
            list_usb_devices,
            link_usb_to_wireless,
            force_enable_wireless_adb,
            force_reconnect_all_adb,
            inject_all_devices_immunity,
            inject_single_device_immunity,
            pair_and_connect_adb_device,
            run_adb_diagnostic,
            restart_adb_server,
            scan_adb_subnet,
            deploy_adb_keepalive,
            install_kernel_agent,
            // Spintax
            resolve_spintax,
            spintax_combinations,
            get_hardware_uuid,
            launch_scrcpy_stream,
            launch_virtual_display_stream,
            send_intent_to_display,
            launch_camera_stream,
            inject_virtual_camera,
            inject_virtual_camera_region,
            inject_base64_frame,
            optimize_device_hpc,
            install_agent_apk,
            provision_device,
            provision_all_devices,
            debloat_device,
            debloat_all_devices,
            get_device_by_esfera_id,
            // AI Config
            get_ai_config,
            save_ai_config,
            // Permissions
            get_user_permissions,
            update_user_permission,
            get_sector_permissions,
            update_sector_permission,
            // Dashboard
            get_dashboard_kpis,
            // Campaign Dispatch
            send_campaign,
            pause_campaign,
            start_campaign,
            rewrite_message_ai,
            // Hub / Master
            hub_invoke,
            // Users & Roles
            get_users,
            create_user,
            // Device Assignments & Permissions
            assign_device_to_user,
            unassign_device_from_user,
            set_device_responsible_collaborator,
            remove_device_responsible_collaborator,
            get_assigned_devices_for_user,
            request_device_access,
            get_device_permission_requests,
            approve_device_access,
            reject_device_access,
            end_device_access,
            get_devices_with_active_user_map,
            configure_device_proxy_and_antiban,
            trigger_manual_intent_bezier_dispatch,
            check_git_auto_update,
            apply_git_auto_update,
            // Config
            get_app_config,
            save_app_config,
        ])
        .build(tauri::generate_context!())
        .expect("Erro ao construir aplicação Tauri")
        .run(|_app, event| {
            // No encerramento do app, limpa o estado do túnel reverso (evita túneis fantasmas).
            if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } = event {
                crate::tunnel_server::shutdown();
            }
        });
}
