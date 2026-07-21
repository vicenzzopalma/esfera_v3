// ============================================================
// Esfera v3 — Entrada Principal da Biblioteca Rust (lib.rs)
// Configuração do aplicativo Tauri v2, estado do banco e IPC handlers
// Fase 1: Registrados todos os novos comandos
// ============================================================

mod adb_manager;
mod ai_engine;
mod commands;
mod db;
mod dispatcher;

use commands::*;
use db::Database;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;

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
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            dispatcher::Dispatcher::start_worker(db_arc_clone, Some(app.handle().clone()));
            Ok(())
        })
        .manage(AppState { db: db_arc })
        .invoke_handler(tauri::generate_handler![
            // Auth
            login,
            // Empresas
            get_companies,
            create_company,
            update_company,
            // Dispositivos
            get_devices,
            connect_adb_device,
            disconnect_adb_device,
            delete_device,
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
            mark_as_sent,
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
            run_adb_diagnostic,
            restart_adb_server,
            scan_adb_subnet,
            deploy_adb_keepalive,
            get_hardware_uuid,
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
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar aplicação Esfera v3");
}
