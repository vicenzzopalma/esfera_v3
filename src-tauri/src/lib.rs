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
pub mod optout_api;
pub mod hub;
pub mod hub_client;
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
use hub_client::HubClient;
use session::SessionManager;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tokio::sync::Mutex as TokioMutex;

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
fn diag(s: &str) {
    use std::io::Write;
    let path = "D:/Novo/Esfera v3/esfera_runtime_debug.log";
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let _ = writeln!(f, "[{}] {}", ts, s);
    }
}

pub fn run() {
    commands::init_connect_log();
    std::panic::set_hook(Box::new(|info| {
        diag(&format!("PANIC DETECTADO: {:?}", info));
        commands::log_connect(&format!("[CONNECT] PANIC DETECTADO NO PROCESSO: {:?}", info));
    }));
    diag("ETAPA [1] main/run iniciado");
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
    diag("ETAPA [2] db iniciado");

    // Fila Única de Escrita Assíncrona (MPSC single-writer com transações em lote)
    let write_queue = write_queue::WriteQueue::spawn(db_arc.clone(), write_queue::QUEUE_CAPACITY);
    db_arc.attach_write_queue(write_queue);

    let db_arc_clone = Arc::clone(&db_arc);
    let sessions = Arc::new(Mutex::new(SessionManager::new()));
    let hub_client: Arc<TokioMutex<Option<HubClient>>> = Arc::new(TokioMutex::new(None));

    let app_config = config::load_config();

    // Runtime de fundo único para servidores e clients (LAN, Hub, Master)
    let bg_runtime = tokio::runtime::Runtime::new().expect("Falha ao criar background runtime");
    diag("ETAPA [3] bg_runtime criado");

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

    // Conexão ao Hub VPS: REMOVIDA do startup. Agora é 100% pós-login:
    // o frontend chama `connect_hub(token)` após o usuário autenticar, usando
    // o company_id e o token da empresa do próprio usuário (arquitetura
    // multi-tenant VPS central — Opção A do HERMES_CONTEXT). Sem login = sem hub.

    let _result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            diag("ETAPA [4] setup iniciado");
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
            dispatcher::Dispatcher::start_opt_out_import_loop(db_arc_clone.clone());
            adb_manager::AdbManager::start_status_monitor(db_arc_clone);
            diag("ETAPA [5] backend/servers iniciados no setup; setup retorna Ok");
            Ok(())
        })
        .manage(AppState { db: db_arc, sessions, hub_client })
        .invoke_handler(tauri::generate_handler![
            // Auth
            login,
            logout,
            get_hub_credentials,
            connect_hub,
            update_vps_hub,
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
            remote_update_agent,
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
            send_adb_input_text,
            apply_device_settings,
            reboot_adb_device,
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
            scan_orphan_processes,
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
            debloat_device_profile,
            apply_hardware_profile,
            debloat_all_devices,
            get_device_by_esfera_id,
            // AI Config
            get_ai_config,
            save_ai_config,
            get_ai_provider_keys,
            gemini_web_login,
            gemini_web_status,
            gemini_web_test,
            gemini_web_logout,
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
            stop_campaign,
            retry_failed_campaign_contacts,
            reset_campaign_contacts,
            list_opt_outs,
            get_confirmation_counts,
            add_opt_outs,
            remove_opt_out,
            list_opt_out_reviews,
            resolve_opt_out_review,
            discard_opt_out_review,
            list_opt_out_audit,
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
            get_all_device_assignments,
            request_device_access,
            get_device_permission_requests,
            generate_company_token,
            rotate_master_token,
            approve_device_access,
            reject_device_access,
            end_device_access,
            get_devices_with_active_user_map,
            configure_device_proxy_and_antiban,
            trigger_manual_intent_bezier_dispatch,
            clear_device_temporary_contacts,
            check_git_auto_update,
            apply_git_auto_update,
            // Config
            get_app_config,
            save_app_config,
        ])
        .build(tauri::generate_context!())
        .expect("Erro ao construir aplicação Tauri")
        .run(|_app, event| {
            match &event {
                tauri::RunEvent::ExitRequested { code, .. } => {
                    diag(&format!("EVENTO TAURI: ExitRequested com código {:?}", code));
                    // Só encerra túneis na saída REAL do app (não ao fechar/minimizar janelas).
                    crate::tunnel_server::shutdown();
                }
                tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } => {
                    diag("EVENTO TAURI: WindowEvent Destroyed (túneis mantidos até ExitRequested)");
                }
                tauri::RunEvent::Ready => {
                    diag("EVENTO TAURI: App Ready!");
                }
                _ => {}
            }
        });
}
