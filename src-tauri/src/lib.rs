// ============================================================
// Esfera v3 — Entrada Principal da Biblioteca Rust (lib.rs)
// Configuração do aplicativo Tauri v2, estado do banco e IPC handlers
// Fase 1: Registrados todos os novos comandos
// ============================================================

mod adb_manager;
mod ai_engine;
mod commands;
pub mod config;
mod db;
mod dispatcher;
pub mod empresa_server;
pub mod hub;
pub mod hub_client;
pub mod master_client;
pub mod protocol;
mod session;

use commands::*;
use db::Database;
use master_client::MasterClient;
use session::SessionManager;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;

fn get_db_path() -> String {
    if let Some(mut dir) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dir.push("esfera_v3");
        let _ = std::fs::create_dir_all(&dir);
        dir.push("esfera_v3.db");
        return dir.to_string_lossy().to_string();
    }
    "esfera_v3.db".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = get_db_path();
    let db = Database::init(&db_path).expect("Falha ao inicializar banco SQLite esfera_v3.db");
    let db_arc = Arc::new(Mutex::new(db));

    let db_arc_clone = Arc::clone(&db_arc);
    let sessions = Arc::new(Mutex::new(SessionManager::new()));
    let master_client: Arc<TokioMutex<Option<MasterClient>>> = Arc::new(TokioMutex::new(None));

    let app_config = config::load_config();

    if app_config.empresa_server_enabled {
        let db_for_server = db_arc.clone();
        let port = app_config.empresa_server_port;
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            if let Err(e) = rt.block_on(empresa_server::EmpresaServer::start(db_for_server, port)) {
                eprintln!("Empresa Server error: {}", e);
            }
        });
        println!("Empresa Server iniciado na porta {}", port);
    }

    // Empresa mode: connect to Hub with auto-reconnect
    if app_config.mode == "empresa" && app_config.hub_enabled && !app_config.hub_address.is_empty() {
        let db_for_hub = db_arc.clone();
        let hub_addr = app_config.hub_address.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let company_id = {
                    let db = db_for_hub.lock().unwrap();
                    db.get_companies().first().map(|c| c.id).unwrap_or(1)
                };
                let company_name = format!("Empresa_{}", company_id);
                let mut backoff = 1;
                loop {
                    match hub_client::HubClient::connect(&hub_addr, company_id, &company_name).await {
                        Ok(client) => {
                            println!("Conectado ao Hub {} como empresa '{}'", hub_addr, company_name);
                            backoff = 1;
                            let _ = client.listen(|cmd, args, id| {
                                let db = db_for_hub.lock().map_err(|e| e.to_string())?;
                                match cmd.as_str() {
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
                                }
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
        });
    }

    // Master mode: connect MasterClient (stored for hub_invoke commands)
    if app_config.mode == "master" && app_config.hub_enabled && !app_config.hub_address.is_empty() {
        let hub_addr = app_config.hub_address.clone();
        let mc = master_client.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let mut backoff = 1;
                loop {
                    match MasterClient::connect(&hub_addr).await {
                        Ok(client) => {
                            println!("Conectado ao Hub {} como Master", hub_addr);
                            *mc.lock().await = Some(client);
                            backoff = 1;
                            loop {
                                tokio::time::sleep(Duration::from_secs(10)).await;
                                if mc.lock().await.is_none() { break; }
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
        });
        println!("Master Client conectando a {}...", app_config.hub_address);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let caps = adb_manager::AdbManager::get_hardware_capabilities();
            let hwid = adb_manager::AdbManager::get_hardware_uuid();
            println!("[Esfera v3 HPC Engine] HWID: {}", hwid);
            println!("[Esfera v3 HPC Engine] CPU Hardware Dispatch -> AVX2: {}, AVX-512: {}, SSE4.2: {}", caps.supports_avx2, caps.supports_avx512, caps.supports_sse42);

            dispatcher::Dispatcher::start_worker(db_arc_clone.clone(), Some(app.handle().clone()));
            dispatcher::Dispatcher::start_persistent_adb_keepalive_loop(db_arc_clone.clone());
            adb_manager::AdbManager::start_auto_reconnect_daemon(db_arc_clone);
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
            pair_and_connect_adb_device,
            run_adb_diagnostic,
            restart_adb_server,
            scan_adb_subnet,
            deploy_adb_keepalive,
            get_hardware_uuid,
            launch_scrcpy_stream,
            launch_virtual_display_stream,
            send_intent_to_display,
            launch_camera_stream,
            inject_virtual_camera,
            optimize_device_hpc,
            install_agent_apk,
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
            resume_campaign,
            start_campaign,
            rewrite_message_ai,
            // Hub / Master
            hub_invoke,
            // Config
            get_app_config,
            save_app_config,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar aplicação Esfera v3");
}
