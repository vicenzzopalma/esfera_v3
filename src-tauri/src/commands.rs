// ============================================================
// Esfera v3 — Comandos Tauri IPC (commands.rs)
// Pontes de comunicação entre o Front-end React e o Back-end Rust
// Fase 1: Novos comandos para DB, Chips, Campanhas, IA, Permissões
// ============================================================

use crate::adb_manager::{AdbManager, AdbDeviceInfo};
use crate::db::{
    AuditLog, AutomationRule, Campaign, Company, Database, Device, User,
    Chip, Contact, DevicePackage, AiConfig, Permission, SectorPermission,
};
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
}

// ============================================================
// AUTENTICAÇÃO
// ============================================================

#[tauri::command]
pub fn login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<User, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.authenticate(&username, &password)
        .ok_or_else(|| "Usuário ou senha incorretos.".to_string())
}

// ============================================================
// EMPRESAS
// ============================================================

#[tauri::command]
pub fn get_companies(state: State<'_, AppState>) -> Result<Vec<Company>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_companies())
}

#[tauri::command]
pub fn create_company(
    state: State<'_, AppState>,
    name: String,
    device_limit: i32,
) -> Result<Company, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_company(&name, device_limit)
}

#[tauri::command]
pub fn update_company(
    state: State<'_, AppState>,
    id: i32,
    name: String,
    device_limit: i32,
    user_limit: i32,
    is_active: bool,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_company(id, &name, device_limit, user_limit, is_active)
}

// ============================================================
// DISPOSITIVOS
// ============================================================

#[tauri::command]
pub fn get_devices(state: State<'_, AppState>, company_id: i32) -> Result<Vec<Device>, String> {
    let target_company_id = if company_id <= 0 { 1 } else { company_id };
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut db_devices = db.get_devices(target_company_id);
    let active_adb_list = AdbManager::list_devices().unwrap_or_default();

    for adb_dev in &active_adb_list {
        if adb_dev.serial == "*" || adb_dev.serial.starts_with('*') {
            continue;
        }

        let existing_idx = db_devices.iter().position(|d| {
            d.serial == adb_dev.serial
                || (adb_dev.serial.contains(':') && d.serial == adb_dev.serial.split(':').next().unwrap_or(""))
                || (d.serial.contains(':') && d.serial.split(':').next().unwrap_or("") == adb_dev.serial)
        });

        let status = if adb_dev.state == "device" {
            "online".to_string()
        } else if adb_dev.state == "unauthorized" {
            "connecting".to_string()
        } else {
            "offline".to_string()
        };
        let battery = if adb_dev.state == "device" {
            AdbManager::get_battery_level(&adb_dev.serial).unwrap_or(85)
        } else {
            0
        };

        if let Some(idx) = existing_idx {
            db_devices[idx].status = status;
            db_devices[idx].battery = battery;
            db.upsert_device(&db_devices[idx])?;
        } else {
            let (brand, model) = AdbManager::get_device_info(&adb_dev.serial);
            let name = if adb_dev.serial.contains('.') {
                format!("{} (Sem Fio)", model)
            } else {
                format!("{} (USB)", model)
            };
            let new_dev = Device {
                id: 0,
                serial: adb_dev.serial.clone(),
                name,
                brand,
                model,
                ip: if adb_dev.serial.contains('.') {
                    adb_dev.serial.split(':').next().unwrap_or("").to_string()
                } else {
                    "".to_string()
                },
                port: 5555,
                status,
                battery,
                company_id: target_company_id,
                device_number: (db_devices.len() + 1) as i32,
                sector: "junior".to_string(),
            };
            db.upsert_device(&new_dev)?;
        }
    }

    for dev in &mut db_devices {
        let is_active = active_adb_list.iter().any(|adb_d| {
            adb_d.serial == dev.serial
                || (adb_d.serial.contains(':') && dev.serial == adb_d.serial.split(':').next().unwrap_or(""))
                || (dev.serial.contains(':') && dev.serial.split(':').next().unwrap_or("") == adb_d.serial)
        });

        if !is_active {
            // Tenta auto-reconexão inteligente se o dispositivo wireless tiver IP cadastrado
            let ip_to_try = if !dev.ip.is_empty() {
                dev.ip.clone()
            } else if dev.serial.contains(':') {
                dev.serial.split(':').next().unwrap_or("").to_string()
            } else {
                "".to_string()
            };

            if !ip_to_try.is_empty() && ip_to_try.contains('.') {
                let port = if dev.port > 0 { dev.port } else { 5555 };
                if let Ok(_) = AdbManager::connect_device(&ip_to_try, port) {
                    let full_serial = format!("{}:{}", ip_to_try, port);
                    let battery = AdbManager::get_battery_level(&full_serial).unwrap_or(85);
                    dev.status = "online".to_string();
                    dev.battery = battery;
                    db.upsert_device(dev)?;
                    continue;
                }
            }

            if dev.status != "offline" {
                dev.status = "offline".to_string();
                db.upsert_device(dev)?;
            }
        }
    }

    Ok(db.get_devices(target_company_id))
}

#[tauri::command]
pub fn get_hpc_capabilities() -> crate::adb_manager::EsferaHardwareCaps {
    AdbManager::get_hardware_capabilities()
}

#[tauri::command]
pub fn run_adb_diagnostic() -> crate::adb_manager::EsferaAdbDiagnosticResult {
    AdbManager::run_diagnostic()
}

#[tauri::command]
pub fn restart_adb_server() -> Result<String, String> {
    AdbManager::restart_server()
}

#[tauri::command]
pub fn scan_adb_subnet(subnet_prefix: String) -> Vec<String> {
    AdbManager::scan_subnet(&subnet_prefix)
}

#[tauri::command]
pub fn deploy_adb_keepalive(serial: String) -> Result<String, String> {
    AdbManager::deploy_keepalive(&serial)
}

#[tauri::command]
pub fn get_hardware_uuid() -> String {
    AdbManager::get_hardware_uuid()
}

#[tauri::command]
pub fn connect_adb_device(
    state: State<'_, AppState>,
    ip: String,
    port: i32,
    company_id: i32,
    device_number: i32,
    sector: String,
) -> Result<String, String> {
    let result = AdbManager::connect_device(&ip, port)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let serial = format!("{}:{}", ip, port);
    let dev = Device {
        id: 0,
        serial: serial.clone(),
        name: format!("Celular Wireless ({})", ip),
        brand: "Android".to_string(),
        model: "Dispositivo ADB".to_string(),
        ip,
        port,
        status: "online".to_string(),
        battery: 90,
        company_id,
        device_number,
        sector,
    };
    db.upsert_device(&dev)?;
    let _ = db.add_log(company_id, "info", "ADB Engine", &format!("Dispositivo {} conectado via wireless.", serial));
    Ok(result)
}

#[tauri::command]
pub fn disconnect_adb_device(state: State<'_, AppState>, serial: String) -> Result<String, String> {
    let result = AdbManager::disconnect_device(&serial)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let _ = db.add_log(0, "info", "ADB Engine", &format!("Dispositivo {} desconectado.", serial));
    Ok(result)
}

#[tauri::command]
pub fn delete_device(state: State<'_, AppState>, serial: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_device(&serial)
}

#[tauri::command]
pub fn optimize_device(serial: String) -> Result<String, String> {
    let commands = vec![
        "dumpsys deviceidle disable",
        "settings put global wifi_sleep_policy 2",
        "settings put global low_power 0",
        "settings put global low_power_trigger_level 0",
        "settings put global wifi_scan_always_enabled 1",
        "settings put global stay_on_while_plugged_in 7",
        "settings put global adb_allowed_connection_time 0",
        "setprop persist.adb.tcp.port 5555",
        "dumpsys deviceidle whitelist +com.google.android.gms",
        "dumpsys deviceidle whitelist +com.android.shell",
    ];
    let mut results = Vec::new();
    for cmd in commands {
        let output = std::process::Command::new("adb")
            .args(["-s", &serial, "shell", cmd])
            .output();
        match output {
            Ok(_) => results.push(format!("✓ {}", cmd)),
            Err(e) => results.push(format!("✗ {}: {}", cmd, e)),
        }
    }
    Ok(results.join("\n"))
}

#[tauri::command]
pub fn get_device_ip(serial: String) -> Result<String, String> {
    AdbManager::get_device_wifi_ip(&serial)
}

// ============================================================
// CAMPANHAS
// ============================================================

#[tauri::command]
pub fn get_campaigns(state: State<'_, AppState>, company_id: i32) -> Result<Vec<Campaign>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_campaigns(company_id))
}

#[tauri::command]
pub fn create_campaign(
    state: State<'_, AppState>,
    campaign: Campaign,
) -> Result<i32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = db.create_campaign(&campaign)?;
    let _ = db.add_log(campaign.company_id, "info", "Central Campanhas", &format!("Nova campanha criada: {}", campaign.name));
    Ok(id)
}

#[tauri::command]
pub fn update_campaign(
    state: State<'_, AppState>,
    campaign: Campaign,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_campaign(&campaign)
}

#[tauri::command]
pub fn soft_delete_campaign(state: State<'_, AppState>, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.soft_delete_campaign(campaign_id)
}

#[tauri::command]
pub fn set_campaign_status(state: State<'_, AppState>, campaign_id: i32, status: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_campaign_status(campaign_id, &status)
}

// ============================================================
// AUTOMAÇÕES
// ============================================================

#[tauri::command]
pub fn get_automations(state: State<'_, AppState>, company_id: i32) -> Result<Vec<AutomationRule>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_automations(company_id))
}

#[tauri::command]
pub fn create_automation(state: State<'_, AppState>, automation: AutomationRule) -> Result<i32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = db.create_automation(&automation)?;
    let _ = db.add_log(automation.company_id, "info", "Motor Automações", &format!("Nova regra criada: {}", automation.name));
    Ok(id)
}

#[tauri::command]
pub fn update_automation(state: State<'_, AppState>, automation: AutomationRule) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_automation(&automation)
}

#[tauri::command]
pub fn soft_delete_automation(state: State<'_, AppState>, automation_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.soft_delete_automation(automation_id)
}

// ============================================================
// LOGS
// ============================================================

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>, company_id: i32) -> Result<Vec<AuditLog>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_logs(company_id))
}

#[tauri::command]
pub fn add_log(state: State<'_, AppState>, company_id: i32, log_type: String, source: String, message: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_log(company_id, &log_type, &source, &message)
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>, company_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.clear_logs(company_id)
}

// ============================================================
// ADB REMOTO
// ============================================================

#[tauri::command]
pub fn capture_device_screen(serial: String) -> Result<String, String> {
    AdbManager::capture_screen(&serial)
}

#[tauri::command]
pub fn send_adb_tap(serial: String, x: u32, y: u32) -> Result<(), String> {
    AdbManager::tap_screen(&serial, x, y)
}

#[tauri::command]
pub fn send_adb_keyevent(serial: String, keycode: u32) -> Result<(), String> {
    AdbManager::send_keyevent(&serial, keycode)
}

// ============================================================
// CHIPS
// ============================================================

#[tauri::command]
pub fn get_device_chips(state: State<'_, AppState>, device_id: i32) -> Result<Vec<Chip>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_chips(device_id))
}

#[tauri::command]
pub fn add_device_chip(state: State<'_, AppState>, device_id: i32, phone: String, name: String) -> Result<i32, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_chip(device_id, &phone, &name)
}

#[tauri::command]
pub fn update_chip_status(state: State<'_, AppState>, chip_id: i32, status: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_chip_status(chip_id, &status)
}

#[tauri::command]
pub fn set_chip_restriction(state: State<'_, AppState>, chip_id: i32, restriction_type: String, days: Option<i32>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let restricted_until = if restriction_type == "restrito_custom" {
        let d = days.unwrap_or(1).max(1);
        format!("{} days", d)
    } else if restriction_type == "restrito_7d" {
        "7 days".to_string()
    } else {
        "1 day".to_string()
    };
    db.set_chip_restriction(chip_id, &restriction_type, &restricted_until)
}

#[tauri::command]
pub fn confirm_chip_release(state: State<'_, AppState>, chip_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.confirm_chip_release(chip_id)
}

#[tauri::command]
pub fn move_chip(state: State<'_, AppState>, chip_id: i32, target_device_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.move_chip(chip_id, target_device_id)
}

#[tauri::command]
pub fn set_chip_holder(state: State<'_, AppState>, chip_id: i32, holder: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_chip_holder(chip_id, &holder)
}

#[tauri::command]
pub fn mark_chip_reserve(state: State<'_, AppState>, chip_id: i32, is_reserve: bool) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.mark_chip_reserve(chip_id, is_reserve)
}

#[tauri::command]
pub fn get_restricted_chips(state: State<'_, AppState>, company_id: i32) -> Result<Vec<Chip>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_restricted_chips_without_reserve(company_id))
}

// ============================================================
// CONTATOS
// ============================================================

#[tauri::command]
pub fn get_campaign_contacts(state: State<'_, AppState>, campaign_id: i32) -> Result<Vec<Contact>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_contacts(campaign_id))
}

#[tauri::command]
pub fn import_campaign_contacts(state: State<'_, AppState>, campaign_id: i32, contacts: Vec<(String, String)>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.import_contacts(campaign_id, contacts)
}

#[tauri::command]
pub fn get_pending_contacts(state: State<'_, AppState>, campaign_id: i32, limit: i32) -> Result<Vec<Contact>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_pending_contacts(campaign_id, limit))
}

#[tauri::command]
pub fn update_contact_status(state: State<'_, AppState>, contact_id: i32, status: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_contact_status(contact_id, &status)
}

#[tauri::command]
pub fn set_contact_custom_message(state: State<'_, AppState>, contact_id: i32, message: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_contact_custom_message(contact_id, &message)
}

#[tauri::command]
pub fn get_next_pending_contact(state: State<'_, AppState>, campaign_id: i32) -> Result<Option<Contact>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_next_pending_contact(campaign_id))
}

// ============================================================
// SENT HISTORY (dedup)
// ============================================================

#[tauri::command]
pub fn was_already_sent(state: State<'_, AppState>, phone: String, campaign_id: i32) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.was_already_sent(&phone, campaign_id))
}

#[tauri::command]
pub fn mark_as_sent(state: State<'_, AppState>, phone: String, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.mark_as_sent(&phone, campaign_id)
}

// ============================================================
// DEVICE STATUS & PREFS
// ============================================================

#[tauri::command]
pub fn is_device_banned(state: State<'_, AppState>, device_id: String, package_name: String, campaign_id: i32) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.is_device_banned(&device_id, &package_name, campaign_id))
}

#[tauri::command]
pub fn set_device_banned(state: State<'_, AppState>, device_id: String, package_name: String, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_device_banned(&device_id, &package_name, campaign_id)
}

#[tauri::command]
pub fn get_device_prefs(state: State<'_, AppState>, device_id: String, campaign_id: i32) -> Result<Option<crate::db::DevicePrefs>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_device_prefs(&device_id, campaign_id))
}

#[tauri::command]
pub fn set_device_prefs(state: State<'_, AppState>, device_id: String, campaign_id: i32, preferred_package: String, unlock_pin: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_device_prefs(&device_id, campaign_id, &preferred_package, &unlock_pin)
}

// ============================================================
// DEVICE PACKAGES
// ============================================================

#[tauri::command]
pub fn get_device_package_statuses(state: State<'_, AppState>, device_id: i32) -> Result<Vec<DevicePackage>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_package_statuses(device_id))
}

#[tauri::command]
pub fn update_device_package_status(state: State<'_, AppState>, device_id: i32, pkg_name: String, status: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_package_status(device_id, &pkg_name, &status)
}

// ============================================================
// USB / PAIRING
// ============================================================

#[tauri::command]
pub fn list_usb_devices() -> Result<Vec<AdbDeviceInfo>, String> {
    AdbManager::list_devices()
}

#[tauri::command]
pub fn link_usb_to_wireless(
    state: State<'_, AppState>,
    serial: String,
    company_id: i32,
    device_number: i32,
    sector: String,
) -> Result<String, String> {
    let ip = AdbManager::get_device_wifi_ip(&serial)?;
    AdbManager::enable_tcpip(&serial, 5555)?;
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let link_msg = AdbManager::connect_device(&ip, 5555)?;
    let (brand, model) = AdbManager::get_device_info(&serial);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let wireless_serial = format!("{}:5555", ip);
    let device = Device {
        id: 0,
        serial: wireless_serial,
        name: format!("{} (Sem Fio)", model),
        brand,
        model,
        ip,
        port: 5555,
        status: "online".to_string(),
        battery: 100,
        company_id,
        device_number,
        sector,
    };
    db.upsert_device(&device)?;
    Ok(format!("Sucesso! Dispositivo pareado sem fio: {}", link_msg))
}

// ============================================================
// AI CONFIG
// ============================================================

#[tauri::command]
pub fn get_ai_config(state: State<'_, AppState>, company_id: i32) -> Result<Option<AiConfig>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_ai_config(company_id))
}

#[tauri::command]
pub fn save_ai_config(state: State<'_, AppState>, config: AiConfig) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_ai_config(&config)
}

// ============================================================
// PERMISSIONS
// ============================================================

#[tauri::command]
pub fn get_user_permissions(state: State<'_, AppState>, user_id: i32) -> Result<Vec<Permission>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_user_permissions(user_id))
}

#[tauri::command]
pub fn update_user_permission(state: State<'_, AppState>, user_id: i32, key: String, enabled: bool) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_user_permission(user_id, &key, enabled)
}

#[tauri::command]
pub fn get_sector_permissions(state: State<'_, AppState>, user_id: i32) -> Result<Vec<SectorPermission>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db.get_sector_permissions(user_id))
}

#[tauri::command]
pub fn update_sector_permission(state: State<'_, AppState>, user_id: i32, sector: String, can_view: bool, can_configure: bool) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_sector_permission(user_id, &sector, can_view, can_configure)
}

// ============================================================
// DASHBOARD
// ============================================================

#[tauri::command]
pub fn get_dashboard_kpis(state: State<'_, AppState>, company_id: i32) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_dashboard_kpis(company_id)
}

// ============================================================
// CAMPAIGN DISPATCH
// ============================================================

#[tauri::command]
pub fn send_campaign(state: State<'_, AppState>, campaign_id: i32) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.send_campaign_next_batch(campaign_id)
}

#[tauri::command]
pub fn pause_campaign(state: State<'_, AppState>, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_campaign_status(campaign_id, "paused")
}

#[tauri::command]
pub fn resume_campaign(state: State<'_, AppState>, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_campaign_status(campaign_id, "running")
}

#[tauri::command]
pub fn start_campaign(state: State<'_, AppState>, campaign_id: i32) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_campaign_status(campaign_id, "running")
}

#[tauri::command]
pub fn rewrite_message_ai(message: String, contact_name: String) -> Result<String, String> {
    // Mock AI rewrite - adds temporal greeting and name personalization
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as usize;

    let hour = {
        // Rough UTC-3 hour for Brazil
        let h = (seed / 3600000) % 24;
        if h < 12 { "Bom dia" } else if h < 18 { "Boa tarde" } else { "Boa noite" }
    };

    let greetings = ["Olá", "Oi", "Fala", "E aí"];
    let closings = ["Abraços", "Att", "Equipe REALESS", "Setor Financeiro"];
    let g = greetings[seed % greetings.len()];
    let c = closings[(seed / 7) % closings.len()];

    let personalized = message.replace("{nome}", &contact_name);
    Ok(format!("{}, {}! {}\n\n{}", hour, contact_name, g, c))
}

#[tauri::command]
pub fn launch_scrcpy_stream(serial: String) -> Result<String, String> {
    AdbManager::launch_scrcpy(&serial)
}
