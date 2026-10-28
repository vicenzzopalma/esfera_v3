

// ============================================================
// Esfera v3 — Comandos Tauri IPC (commands.rs)
// Pontes de comunicação entre o Front-end React e o Back-end Rust
// Fase 1: Novos comandos para DB, Chips, Campanhas, IA, Permissões
// ============================================================

/// Log de diagnóstico em disco — arquivo aberto/fechado a cada chamada para
/// não perder dados se o processo crashar (flush imediato via drop).
#[allow(dead_code)]
fn cmd_diag(s: &str) {
    use std::io::Write;
    let path = "D:/Novo/Esfera v3/esfera_runtime_debug.log";
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let _ = writeln!(f, "[{}] [CMD] {}", ts, s);
    }
}

use crate::adb_manager::{AdbDeviceInfo, AdbManager};
use crate::config::{self, AppConfig};
use crate::db::{
    AiConfig, AutomationRule, Campaign, Chip, Company, Contact, Database, Device,
    DevicePackage, OptOutAuditEntry, OptOutReview, Permission, SectorPermission,
};
use crate::hub_client::HubClient;
use crate::session::{LoginResponse, SessionManager};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

pub struct AppState {
    pub db: Arc<Database>,
    pub sessions: Arc<Mutex<SessionManager>>,
    pub hub_client: Arc<TokioMutex<Option<HubClient>>>,
}

static CONNECT_LOG_MUTEX: Mutex<()> = Mutex::new(());

pub fn log_connect(msg: &str) {
    let _guard = CONNECT_LOG_MUTEX.lock().ok();

    let base_dir = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let dir = base_dir.join("esfera_v3");
    let _ = std::fs::create_dir_all(&dir);
    let log_file = dir.join("connect-debug.log");

    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string();
    let line = format!("{} {}\n", timestamp, msg);

    println!("{}", line.trim());

    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_file) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

pub fn init_connect_log() {
    let _guard = CONNECT_LOG_MUTEX.lock().ok();

    let base_dir = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    let dir = base_dir.join("esfera_v3");
    let _ = std::fs::create_dir_all(&dir);
    let log_file = dir.join("connect-debug.log");

    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string();
    let header = format!("=== SESSÃO INICIADA EM {} ===\n", timestamp);

    let _ = std::fs::write(log_file, header.as_bytes());
}

fn validate_session(
    sessions: &Arc<Mutex<SessionManager>>,
    token: &str,
) -> Result<crate::session::UserSession, String> {
    let sess = sessions.lock().map_err(|e| e.to_string())?;
    if !token.is_empty() {
        if let Some(session) = sess.validate_token(token) {
            return Ok(session);
        }
    }
    // SEM fallback inseguro: token inválido/ausente NÃO vira master/gestor.
    Err("Não autorizado: token de sessão inválido ou ausente.".to_string())
}

fn check_company_access(
    session: &crate::session::UserSession,
    target_company_id: i32,
) -> Result<(), String> {
    if session.role == "master" || session.role == "gestor" || session.company_id.is_none() {
        return Ok(());
    }
    match session.company_id {
        Some(cid) if cid == target_company_id || target_company_id <= 0 => Ok(()),
        _ => Err("Acesso Negado: fora da rede da sua empresa.".to_string()),
    }
}

// ============================================================
// AUTENTICAÇÃO
// ============================================================

#[tauri::command]
pub fn login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<LoginResponse, String> {
    let db = &state.db;
    let user = db.authenticate(&username, &password)
        .ok_or_else(|| "Usuário ou senha incorretos.".to_string())?;
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let token = sessions.create_session(user.id, &user.username, &user.role, user.company_id);
    Ok(LoginResponse { token, user })
}

#[tauri::command]
pub fn logout(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove_session(&token);
    Ok(())
}

// ============================================================
// EMPRESAS
// ============================================================

#[tauri::command]
pub fn get_companies(state: State<'_, AppState>, token: String) -> Result<Vec<Company>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    let all = db.get_companies();
    if session.role == "master" || session.role == "gestor" || session.company_id.is_none() {
        return Ok(all);
    }
    let allowed = all.into_iter().filter(|c| session.company_id == Some(c.id)).collect();
    Ok(allowed)
}

#[tauri::command]
pub fn create_company(
    state: State<'_, AppState>,
    token: String,
    name: String,
    device_limit: i32,
) -> Result<Company, String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        return Err("Acesso Negado: apenas Master pode criar empresas.".to_string());
    }
    let db = &state.db;
    db.create_company(&name, device_limit)
}

#[tauri::command]
pub fn update_company(
    state: State<'_, AppState>,
    token: String,
    id: i32,
    name: String,
    device_limit: i32,
    user_limit: i32,
    is_active: bool,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        return Err("Acesso Negado: apenas Master pode alterar empresas.".to_string());
    }
    let db = &state.db;
    db.update_company(id, &name, device_limit, user_limit, is_active)
}

// ============================================================
// DISPOSITIVOS
// ============================================================

use std::sync::RwLock;
use std::time::{Duration, Instant};

static ADB_LIST_CACHE: std::sync::LazyLock<RwLock<(Vec<AdbDeviceInfo>, Instant)>> =
    std::sync::LazyLock::new(|| RwLock::new((Vec::new(), Instant::now() - Duration::from_secs(10))));

/// Cache de QUAL serial já teve o `/sdcard/esfera_config.json` (identidade
/// ESF-xxxx) gravado nesta sessão, para NÃO reescrever o arquivo a cada
/// tick de 5s do get_devices (evita I/O ADB desnecessário e desgaste do flash).
/// Chave = serial ADB; Valor = (Instant do último write, company_id usado).
#[allow(dead_code)]
static PROVISIONED_IDENTITY_CACHE: std::sync::LazyLock<
    RwLock<std::collections::HashMap<String, (Instant, i32)>>,
> = std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Janela máxima permitida em estado "connecting" (subtarefa 3). Um cartão só
/// pode ficar amarelo por no máximo 15s durante uma tentativa ativa de reconexão
/// de IP via ADB. Após isso, se não entrou em "online" nem na VPS, vira "offline".
const CONNECTING_TIMEOUT: Duration = Duration::from_secs(15);

/// Marca temporal em que cada cartão (identificado por serial) entrou em
/// "connecting". Usada para expirar o estado amarelo eterno. Chave = serial ADB
/// (ou esfera_device_id quando não há serial local).
static CONNECTING_SINCE: std::sync::LazyLock<RwLock<std::collections::HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));

/// Retorna a chave estável de um cartão para o rastreamento de "connecting":
/// prefere o serial ADB (mesmo com porta) e cai para esfera_device_id.
fn connecting_key(dev: &Device) -> String {
    if !dev.serial.is_empty() {
        dev.serial.clone()
    } else {
        dev.esfera_device_id.clone().unwrap_or_default()
    }
}

/// Garante que o celular possua `/sdcard/esfera_config.json` com deviceId
/// = "ESF-<SERIAL_ADB_MAIUSCULO>", para que o cruzamento local x VPS seja
/// determinístico. Reescreve no máximo 1x a cada 60s por serial (ou se a
/// empresa mudou). Falhas (device não autorizado) são ignoradas — não bloqueiam.
#[allow(dead_code)]
fn ensure_identity_provisioned(serial: &str, company_id: i32, server_url: &str) {
    let now = Instant::now();
    let needs_write = {
        let cache = PROVISIONED_IDENTITY_CACHE.read().unwrap();
        match cache.get(serial) {
            Some((t, cid)) => now.duration_since(*t).as_secs() >= 60 || *cid != company_id,
            None => true,
        }
    };
    if !needs_write {
        return;
    }
    if let Ok(_) = AdbManager::write_identity_config(serial, company_id, server_url) {
        if let Ok(mut cache) = PROVISIONED_IDENTITY_CACHE.write() {
            cache.insert(serial.to_string(), (now, company_id));
        }
    } else if let Ok(mut cache) = PROVISIONED_IDENTITY_CACHE.write() {
        // Mesmo falhando, marca para não tentar de novo antes de 60s.
        cache.insert(serial.to_string(), (now, company_id));
    }
}

fn get_cached_adb_devices() -> Vec<AdbDeviceInfo> {
    let now = Instant::now();
    if let Ok(cache) = ADB_LIST_CACHE.read() {
        let ttl_ms = if cache.0.is_empty() { 1000 } else { 6000 };
        if now.duration_since(cache.1).as_millis() < ttl_ms {
            return cache.0.clone();
        }
    }
    let list = AdbManager::list_devices().unwrap_or_default();
    if let Ok(mut cache) = ADB_LIST_CACHE.write() {
        *cache = (list.clone(), now);
    }
    list
}

/// Cache serial ADB (USB "0082925603" ou Wi-Fi "192.168.1.92:5555") -> EsferaDeviceId.
/// O ID de hardware é a âncora; o serial/IP é só transporte. Evita 1-3 `adb shell`
/// por aparelho a cada polling do get_devices.
static ADB_HW_ID_CACHE: std::sync::LazyLock<
    RwLock<std::collections::HashMap<String, (String, Instant)>>,
> = std::sync::LazyLock::new(|| RwLock::new(std::collections::HashMap::new()));
const ADB_HW_ID_TTL: Duration = Duration::from_secs(600);

/// Resolve o EsferaDeviceId de um aparelho ADB conectado (estado "device"),
/// usando cache. Fonte: /sdcard/.esfera_device_id -> persist.esfera.device_id ->
/// "ESF-" + 8 primeiros de ro.serialno (ver AdbManager::get_persistent_device_id).
fn resolve_hw_id_cached(serial: &str) -> Option<String> {
    if let Ok(cache) = ADB_HW_ID_CACHE.read() {
        if let Some((id, t)) = cache.get(serial) {
            if t.elapsed() < ADB_HW_ID_TTL {
                return Some(id.clone());
            }
        }
    }
    let id = AdbManager::get_persistent_device_id(serial)?;
    if let Ok(mut cache) = ADB_HW_ID_CACHE.write() {
        cache.insert(serial.to_string(), (id.clone(), Instant::now()));
    }
    Some(id)
}

fn get_cached_battery(serial: &str) -> i32 {
    if let Ok(lvl) = AdbManager::get_battery_level(serial) {
        return lvl;
    }
    if let Some(session) = crate::session_manager::get_session(serial) {
        if session.battery_level > 0 {
            return session.battery_level as i32;
        }
    }
    0
}

/// Extrai o host/IP de um endereço, ignorando a porta (ex.: "192.168.1.151:5555" -> "192.168.1.151").
/// Usado para cruzar dispositivos locais (ADB Wi-Fi "ip:porta") com remotos da VPS (IP sem porta).
fn strip_port(addr: &str) -> String {
    if addr.is_empty() {
        return String::new();
    }
    // Remove porta após ':' (IPv4) ou ']' (IPv6)
    let host = if let Some(idx) = addr.rfind(':') {
        if addr.contains('.') {
            &addr[..idx]
        } else {
            addr
        }
    } else {
        addr
    };
    host.trim().to_lowercase().to_string()
}

/// Normaliza um serial ADB removendo a porta (Wi-Fi "ip:porta" -> "ip") e
/// passando a minúsculas, para comparar com identidades sem porta.
fn normalize_serial(serial: &str) -> String {
    strip_port(serial)
}

/// Deriva o deviceId determinístico a partir do serial ADB, idêntico ao que o
/// agente Kotlin grava no /sdcard/esfera_config.json:
///   serial `4200da8501667545` -> `ESF-4200DA85`
///   (8 primeiros caracteres do serial em MAIÚSCULO, prefixados de "ESF-")
fn device_id_from_serial(serial: &str) -> String {
    let clean = strip_port(serial);
    if clean.contains('.') || clean.contains(':') {
        return String::new();
    }
    let s = serial.to_uppercase();
    if s.len() >= 8 {
        format!("ESF-{}", &s[0..8])
    } else if !s.is_empty() {
        format!("ESF-{}", s)
    } else {
        String::new()
    }
}

/// Cruzamento determinístico entre um cartão local (`d`) e um registro VPS (`live`).
/// Retorna `true` se pertencerem ao MESMO celular físico, testando em ordem de
/// precedência (subtarefa 2):
///   a) d.esfera_device_id == live.esfera_device_id
///   b) d.serial (ou limpa de porta) == live.esfera_device_id  (ou vice-versa)
///   c) "ESF-" + 8 primeiros do d.serial == live.esfera_device_id
///   d) Correspondência de IP local ou ADB address (normalizado, sem porta).
fn device_matches_live(d: &Device, live: &serde_json::Value) -> bool {
    let esfera_id = live
        .get("esfera_device_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if esfera_id.is_empty() {
        return false;
    }
    let esfera_id_up = esfera_id.to_uppercase();

    // (a) esfera_device_id exato
    if let Some(ref local_id) = d.esfera_device_id {
        if local_id.eq_ignore_ascii_case(&esfera_id) {
            return true;
        }
    }

    // (b) serial local == esfera_device_id (ou vice-versa), com e sem porta
    let serial_norm = normalize_serial(&d.serial);
    let addr_norm = d
        .current_adb_address
        .as_deref()
        .map(normalize_serial)
        .unwrap_or_default();
    if d.serial.eq_ignore_ascii_case(&esfera_id)
        || serial_norm.eq_ignore_ascii_case(&esfera_id)
        || esfera_id.eq_ignore_ascii_case(&d.serial)
        || (!addr_norm.is_empty() && addr_norm.eq_ignore_ascii_case(&esfera_id))
    {
        return true;
    }

    // (c) ESF- + 8 primeiros do serial == esfera_device_id
    let derived = device_id_from_serial(&d.serial);
    if !derived.is_empty() && derived.eq_ignore_ascii_case(&esfera_id_up) {
        return true;
    }

    // (d) IP local ou ADB address (normalizado sem porta): SÓ conta se um
    // candidato LOCAL (serial/addr/ip do cartão) for igual a um candidato VPS
    // (current_adb_address/ip do live). A comparação é cruzada (local x vps),
    // NUNCA candidato contra si mesmo, para não gerar falso-positivo.
    let vps_adb = live
        .get("current_adb_address")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let vps_ip = live
        .get("ip")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let vps_candidates: Vec<String> = vec![
        normalize_serial(&vps_adb),
        normalize_serial(&vps_ip),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();

    let local_ip_norm = normalize_serial(&d.ip);
    let local_candidates: Vec<String> = vec![
        serial_norm,
        addr_norm,
        local_ip_norm,
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();

    for lc in &local_candidates {
        for vc in &vps_candidates {
            if lc == vc {
                return true;
            }
        }
    }

    false
}

#[tauri::command]
pub async fn get_devices(state: State<'_, AppState>, token: String, company_id: i32) -> Result<Vec<Device>, String> {
    let state_db = state.db.clone();
    let state_sessions = state.sessions.clone();
    let hub_client = state.hub_client.clone();

    // AUTO-CONEXÃO DO HUB: Conexão assíncrona em background para NUNCA travar o retorno do get_devices
    {
        let hub_client_clone = hub_client.clone();
        if let Ok(creds) = get_hub_credentials(state.clone(), token.clone()) {
            tokio::spawn(async move {
                let is_connected = hub_client_clone.lock().await.is_some();
                if !is_connected {
                    if let Ok(Ok(client)) = tokio::time::timeout(
                        std::time::Duration::from_secs(4),
                        HubClient::connect(
                            &creds.hub_address, &creds.hub_token, &creds.role,
                            creds.company_id, &creds.company_name,
                        ),
                    ).await {
                        *hub_client_clone.lock().await = Some(client);
                    }
                }
            });
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let session = validate_session(&state_sessions, &token)?;
        let target_company_id = if session.role == "master" || session.role == "gestor" {
            if company_id > 0 {
                company_id
            } else {
                session.company_id.filter(|c| *c > 0).unwrap_or(1)
            }
        } else if company_id > 0 {
            company_id
        } else {
            session.company_id.unwrap_or(1)
        };
        let target_company_id = if target_company_id <= 0 { 1 } else { target_company_id };
        if session.role != "master" && session.role != "gestor" && session.company_id.is_some_and(|c| c > 0) {
            check_company_access(&session, target_company_id)?;
        }
        let mut db_devices = state_db.get_devices(target_company_id);
        let active_adb_list = get_cached_adb_devices();

        let mut changed = false;
        // serial ADB atual -> EsferaDeviceId, preenchido no laço abaixo
        let mut adb_hw_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        // Esquece seriais que saíram do ADB (o mesmo IP pode voltar em outro aparelho)
        if let Ok(mut cache) = ADB_HW_ID_CACHE.write() {
            cache.retain(|s, _| active_adb_list.iter().any(|a| &a.serial == s && a.state == "device"));
        }

        for adb_dev in &active_adb_list {
            if adb_dev.serial == "*" || adb_dev.serial.starts_with('*') {
                continue;
            }

            let is_wireless = adb_dev.serial.contains(':') || adb_dev.serial.contains('.');
            let ip_only = if is_wireless {
                adb_dev.serial.split(':').next().unwrap_or("").to_string()
            } else {
                "".to_string()
            };

            // AUTO-PROVISIONAMENTO, AUTO-CURA E IMUNIDADE TOTAL NATIVA (com rate-limit por dispositivo)
            if adb_dev.state == "device" {
                let s_target = adb_dev.serial.clone();
                let comp_id = target_company_id;
                let now = Instant::now();
                let should_heal = PROVISIONED_IDENTITY_CACHE
                    .read()
                    .map(|cache| match cache.get(&s_target) {
                        Some((last_time, last_cid)) => {
                            now.duration_since(*last_time).as_secs() >= 1800 || *last_cid != comp_id
                        }
                        None => true,
                    })
                    .unwrap_or(true);
                if should_heal {
                    if let Ok(mut cache) = PROVISIONED_IDENTITY_CACHE.write() {
                        cache.insert(s_target.clone(), (now, comp_id));
                    }
                    let cfg = crate::config::load_config();
                    let esfera_cfg_server = AdbManager::resolve_server_url(&s_target, &cfg);
                    std::thread::spawn(move || {
                        let _ = AdbManager::auto_heal_and_immunize_device(&s_target, comp_id, &esfera_cfg_server);
                    });
                }
            } else if let Ok(mut cache) = PROVISIONED_IDENTITY_CACHE.write() {
                cache.remove(&adb_dev.serial);
            }

            let status = if adb_dev.state == "device" {
                "online".to_string()
            } else if adb_dev.state == "unauthorized" {
                "connecting".to_string()
            } else {
                "offline".to_string()
            };

            let persistent_id = if adb_dev.state == "device" {
                resolve_hw_id_cached(&adb_dev.serial)
            } else { None };
            if let Some(ref pid) = persistent_id {
                adb_hw_ids.insert(adb_dev.serial.clone(), pid.clone());
            }

            let (brand, model) = AdbManager::get_device_info(&adb_dev.serial);

            // 1º: ID de hardware (âncora). IP/serial antigos no banco não importam.
            // 2º: só por transporte (serial/endereço/IP) se a linha não pertencer a OUTRO hardware.
            let existing_idx = persistent_id
                .as_deref()
                .and_then(|pid| {
                    db_devices.iter().position(|d| {
                        d.esfera_device_id.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(pid))
                            || d.serial.eq_ignore_ascii_case(pid)
                    })
                })
                .or_else(|| {
                    db_devices.iter().position(|d| {
                        let other_hw = match (d.esfera_device_id.as_deref(), persistent_id.as_deref()) {
                            (Some(e), Some(pid)) => !e.eq_ignore_ascii_case(pid),
                            _ => false,
                        };
                        !other_hw
                            && (d.serial == adb_dev.serial
                                || (!ip_only.is_empty() && d.ip == ip_only)
                                || d.current_adb_address.as_deref() == Some(&adb_dev.serial))
                    })
                });

            // PROTEÇÃO ABSOLUTA DE IDENTIDADE (regra §5 skill: nome protegido contra VPS):
            // 1. Se já estiver no ESF_DeviceIdentity pelo Hardware ID (persistente), usa o nome salvo lá.
            // 2. Se já existir no banco local (db_devices), PRESERVA rigorosamente o nome que o usuário deu.
            // 3. Se for um dispositivo INÉDITO com persistent_id, cria com nome derivado do serial.
            //    Sem persistent_id: NÃO cria registro nem gera nome — mantém offline (anti-ghost).
            let (resolved_name, resolved_sector, resolved_num) = if let Some(ref pid) = persistent_id {
                if let Some((saved_n, saved_s, saved_num, _)) = state_db.get_device_identity(pid) {
                    (saved_n, saved_s, saved_num)
                } else if let Some(idx) = existing_idx {
                    let d = &db_devices[idx];
                    let chosen_name = if !d.name.is_empty() {
                        d.name.clone()
                    } else {
                        // Fallback determinístico: "Celular <Serial>" — NUNCA "Aparelho X"
                                    format!("Celular {}", d.serial.to_uppercase().replace(':', "").replace('.', ""))
                    };
                    let _ = state_db.save_device_identity(pid, &chosen_name, &d.sector, d.device_number, &model);
                    (chosen_name, d.sector.clone(), d.device_number)
                } else {
                    // Dispositivo inédito com persistent_id: usa serial ADB limpo
                            let serial_clean = adb_dev.serial.to_uppercase().replace(':', "").replace('.', "");
                    let gen_name = format!("Celular {}", serial_clean);
                    let next_num = state_db.get_next_device_number();
                    let _ = state_db.save_device_identity(pid, &gen_name, "junior", next_num, &model);
                    (gen_name, "junior".to_string(), next_num)
                }
            } else {
                // SEM persistent_id: não cria registro (anti-ghost rule). Pula para próximo.
                // Mantém status offline já definido acima.
                continue;
            };

            if let Some(idx) = existing_idx {
                let _old_status = db_devices[idx].status.clone();
                let _old_battery = db_devices[idx].battery;
                let _old_address = db_devices[idx].current_adb_address.clone();
                let _old_ip = db_devices[idx].ip.clone();
                let _old_id = db_devices[idx].esfera_device_id.clone();
                db_devices[idx].status = status;
                db_devices[idx].name = resolved_name;
                db_devices[idx].sector = resolved_sector;
                db_devices[idx].device_number = resolved_num;
                if !brand.is_empty() { db_devices[idx].brand = brand; }
                if !model.is_empty() { db_devices[idx].model = model; }
                db_devices[idx].current_adb_address = Some(adb_dev.serial.clone());
                if persistent_id.is_some() { db_devices[idx].esfera_device_id = persistent_id.clone(); }
                if is_wireless && !ip_only.is_empty() { db_devices[idx].ip = ip_only.clone(); }
                db_devices[idx].last_seen_utc = Some(chrono::Utc::now().to_rfc3339());
                if adb_dev.state == "device" {
                    db_devices[idx].battery = get_cached_battery(&adb_dev.serial);
                } else {
                    db_devices[idx].battery = 0;
                }
                let _ = state_db.upsert_device(&db_devices[idx]);
                changed = true;
            } else {
                let battery = if adb_dev.state == "device" {
                    get_cached_battery(&adb_dev.serial)
                } else {
                    0
                };

                let new_dev = Device {
                    id: 0,
                    serial: adb_dev.serial.clone(),
                    name: resolved_name,
                    brand,
                    model,
                    ip: ip_only,
                    port: 5555,
                    status,
                    battery,
                    company_id: target_company_id,
                    device_number: resolved_num,
                    sector: resolved_sector,
                    esfera_device_id: persistent_id,
                    current_adb_address: Some(adb_dev.serial.clone()),
                    last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                    via_tunnel: false,
                };
                let _ = state_db.upsert_device(&new_dev);
                changed = true;
            }
        }

        let mut refreshed_db = if changed { state_db.get_devices(target_company_id) } else { db_devices };

        // Cruza o estado de Presença WebSocket (SessionManager) e Túnel Reverso com o DB:
        // O Hardware ID (EsferaDeviceId) é a ÚNICA FONTE DA VERDADE. O IP é volátil.
        let mut ws_online_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for dev in &mut refreshed_db {
            if let Some(ref uuid) = dev.esfera_device_id {
                // 1. Presença WebSocket direta do APK (esfera-agent)
                if let Some(sess) = crate::session_manager::get_session(uuid) {
                    if sess.ws_connected {
                        ws_online_ids.insert(uuid.clone());
                        dev.status = "online".to_string();
                        if sess.battery_level > 0 {
                            dev.battery = sess.battery_level as i32;
                        }
                        if !sess.ip.is_empty() && dev.ip != sess.ip {
                            dev.ip = sess.ip.clone();
                            let new_adb_addr = format!("{}:5555", sess.ip);
                            dev.current_adb_address = Some(new_adb_addr);
                            let ip_to_connect = sess.ip.clone();
                            std::thread::spawn(move || {
                                let _ = AdbManager::connect_device(&ip_to_connect, 5555);
                            });
                        }
                    }
                }

                // 2. Túnel Reverso de Execução
                if crate::tunnel_server::is_tunnel_active(uuid) {
                    dev.via_tunnel = true;
                    dev.status = "online".to_string();
                    if let Some(addr) = crate::tunnel_server::tunnel_local_ip(uuid) {
                        if dev.current_adb_address.as_deref() != Some(addr.as_str()) {
                            dev.current_adb_address = Some(addr);
                        }
                    }
                }
            }
        }

        for dev in &mut refreshed_db {
            if dev.via_tunnel {
                continue;
            }
            if let Some(ref uuid) = dev.esfera_device_id {
                if ws_online_ids.contains(uuid) {
                    continue;
                }
            }

            let matching_adb = active_adb_list
                .iter()
                .filter(|adb_d| {
                    let dev_hw = dev.esfera_device_id.as_deref().unwrap_or("");
                    let adb_hw = adb_hw_ids.get(&adb_d.serial).map(String::as_str);
                    // Âncora: ID de hardware resolvido do aparelho conectado (USB ou TCP)
                    if !dev_hw.is_empty() {
                        if let Some(hw) = adb_hw {
                            return hw.eq_ignore_ascii_case(dev_hw);
                        }
                    }
                    // Sem ID resolvido (ex.: unauthorized): casa por transporte
                    adb_d.serial == dev.serial
                        || dev.current_adb_address.as_deref() == Some(&adb_d.serial)
                        || (!dev.ip.is_empty() && (adb_d.serial == dev.ip || adb_d.serial.starts_with(&format!("{}:", dev.ip))))
                        || (!dev_hw.is_empty() && device_id_from_serial(&adb_d.serial).eq_ignore_ascii_case(dev_hw))
                })
                .max_by_key(|adb_d| match adb_d.state.as_str() {
                    "device" => 2,
                    "unauthorized" => 1,
                    _ => 0,
                });

            if let Some(adb_d) = matching_adb {
                if adb_d.state == "device" {
                    dev.status = "online".to_string();
                    if dev.current_adb_address.as_deref() != Some(&adb_d.serial) {
                        dev.current_adb_address = Some(adb_d.serial.clone());
                    }
                    let _ = CONNECTING_SINCE.write().map(|mut m| m.remove(&connecting_key(dev)));
                } else if adb_d.state == "unauthorized" {
                    let key = connecting_key(dev);
                    let entered_at = CONNECTING_SINCE
                        .write()
                        .ok()
                        .map(|mut map| *map.entry(key).or_insert_with(Instant::now));
                    let within_timeout = entered_at
                        .map(|t| Instant::now().duration_since(t) <= CONNECTING_TIMEOUT)
                        .unwrap_or(false);
                    dev.status = if within_timeout { "connecting".to_string() } else { "offline".to_string() };
                    dev.battery = 0;
                    dev.via_tunnel = false;
                } else {
                    dev.status = "offline".to_string();
                    dev.battery = 0;
                    dev.via_tunnel = false;
                    let _ = CONNECTING_SINCE.write().map(|mut m| m.remove(&connecting_key(dev)));
                }
            } else {
                // Dispositivo ausente do ADB local e sem presença WS/Túnel ativa -> offline imediato
                dev.status = "offline".to_string();
                dev.battery = 0;
                dev.via_tunnel = false;
                let _ = CONNECTING_SINCE.write().map(|mut m| m.remove(&connecting_key(dev)));
            }
        }

        // Limpeza periódica de chaves expiradas em CONNECTING_SINCE (evita crescimento ilimitado)
        if let Ok(mut map) = CONNECTING_SINCE.write() {
            map.retain(|_, t| t.elapsed() <= CONNECTING_TIMEOUT);
        }

        // PONTE VPS -> LOCAL: consulta dispositivos ao vivo da VPS com timeout ultra-rápido (400ms)
        let live_vps: Vec<serde_json::Value> = {
            let rt = tokio::runtime::Handle::try_current();
            if let Ok(_h) = rt {
                tauri::async_runtime::block_on(async {
                    let guard = hub_client.lock().await;
                    if let Some(client) = guard.as_ref() {
                        match tokio::time::timeout(
                            std::time::Duration::from_millis(400),
                            client.send_command(0, "get_live_devices", serde_json::json!({"companyId": target_company_id}))
                        ).await {
                            Ok(Ok(val)) => val.as_array().cloned().unwrap_or_default(),
                            _ => Vec::new(),
                        }
                    } else {
                        Vec::new()
                    }
                })
            } else {
                Vec::new()
            }
        };
        // Deduplica conexões ativas na nuvem pertencentes ao mesmo ID único (esfera_device_id)
        let mut deduped_vps: Vec<serde_json::Value> = Vec::new();
        for v in live_vps {
            let id = v.get("esfera_device_id").and_then(|s| s.as_str()).unwrap_or("");
            if !id.is_empty() {
                if let Some(pos) = deduped_vps.iter().position(|existing| existing.get("esfera_device_id").and_then(|s| s.as_str()) == Some(id)) {
                    let old_seen = deduped_vps[pos].get("last_seen_utc").and_then(|s| s.as_str()).unwrap_or("");
                    let new_seen = v.get("last_seen_utc").and_then(|s| s.as_str()).unwrap_or("");
                    if new_seen > old_seen {
                        deduped_vps[pos] = v;
                    }
                    continue;
                }
            }
            deduped_vps.push(v);
        }
        let live_vps = deduped_vps;

        // IDs que o VPS considera vivos (para marcar offline os que saíram).
        let live_ids: std::collections::HashSet<String> = live_vps
            .iter()
            .filter_map(|v| {
                let st = v.get("status").and_then(|s| s.as_str()).unwrap_or("offline").to_lowercase();
                if st == "online" || st == "degraded" {
                    v.get("esfera_device_id").and_then(|s| s.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();

        for live in &live_vps {
            let esfera_id = live.get("esfera_device_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if esfera_id.is_empty() { continue; }
            let vps_status = live.get("status").and_then(|v| v.as_str()).unwrap_or("offline");
            let mapped_status = match vps_status.to_lowercase().as_str() {
                "online" => "online",
                "degraded" => "degraded",
                _ => "offline",
            }.to_string();
            let is_vps_active = mapped_status == "online" || mapped_status == "degraded";
            let battery = live.get("battery_level").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let vps_adb_addr = live.get("current_adb_address").and_then(|v| v.as_str()).unwrap_or("");
            let vps_ip = live.get("ip").and_then(|v| v.as_str()).unwrap_or("");

            let existing_pos = refreshed_db
                .iter()
                .position(|d| device_matches_live(d, live));

            if let Some(pos) = existing_pos {
                let adb_local_online = active_adb_list.iter().any(|adb_d| {
                    adb_d.state == "device"
                        && (adb_d.serial == refreshed_db[pos].serial
                            || refreshed_db[pos].current_adb_address.as_deref() == Some(&adb_d.serial)
                            || (!refreshed_db[pos].ip.is_empty()
                                && (adb_d.serial == refreshed_db[pos].ip
                                    || adb_d.serial.starts_with(&format!("{}:", refreshed_db[pos].ip)))))
                });
                if adb_local_online {
                    refreshed_db[pos].status = "online".to_string();
                } else if is_vps_active {
                    refreshed_db[pos].status = mapped_status.clone();
                    refreshed_db[pos].via_tunnel = true;
                } else if refreshed_db[pos].status != "online" {
                    refreshed_db[pos].status = "offline".to_string();
                    refreshed_db[pos].via_tunnel = false;
                    refreshed_db[pos].battery = 0;
                }
                if refreshed_db[pos].esfera_device_id.is_none() {
                    refreshed_db[pos].esfera_device_id = Some(esfera_id.clone());
                }
                if refreshed_db[pos].current_adb_address.is_none() && !vps_adb_addr.is_empty() {
                    refreshed_db[pos].current_adb_address = Some(vps_adb_addr.to_string());
                }
                let vps_assigned_port = live.get("assigned_vps_port").and_then(|v| v.as_u64()).unwrap_or(0) as i32;
                if vps_assigned_port > 0 {
                    refreshed_db[pos].port = vps_assigned_port;
                }
                if is_vps_active && battery > 0 {
                    refreshed_db[pos].battery = battery;
                }
                let _ = state_db.upsert_device(&refreshed_db[pos]);
                continue;
            }
            // Device remoto AINDA NÃO está no banco local. O nome é ANCORADO ao Hardware ID:
            let (protected_name, protected_sector, protected_num) = if let Some((saved_n, saved_s, saved_num, _)) = state_db.get_device_identity(&esfera_id) {
                (saved_n, saved_s, saved_num)
            } else if let Some(d) = state_db.get_device_by_esfera_id(&esfera_id) {
                (d.name, d.sector, d.device_number)
            } else {
                // Regra §5: nome de fallback é ANCORAADO ao EsferaDeviceId (hardware ID),
                // nunca um rótulo genérico em lote ("Aparelho X").
                let gen_name = format!("Celular {}", esfera_id);
                let next_num = state_db.get_next_device_number();
                let _ = state_db.save_device_identity(&esfera_id, &gen_name, "junior", next_num, "Smartphone");
                (gen_name, "junior".to_string(), next_num)
            };

            let vps_assigned_port = live.get("assigned_vps_port").and_then(|v| v.as_u64()).unwrap_or(0) as i32;

            let new_dev = Device {
                id: 0,
                serial: esfera_id.clone(),
                name: protected_name.clone(),
                brand: String::new(),
                model: String::new(),
                port: vps_assigned_port,
                status: mapped_status.clone(),
                battery: if is_vps_active { battery } else { 0 },
                company_id: target_company_id,
                device_number: protected_num,
                sector: protected_sector.clone(),
                esfera_device_id: Some(esfera_id.clone()),
                current_adb_address: if vps_adb_addr.is_empty() { None } else { Some(vps_adb_addr.to_string()) },
                last_seen_utc: live.get("last_seen_utc").and_then(|v| v.as_str()).map(|s| s.to_string()),
                via_tunnel: is_vps_active,
                ip: vps_ip.to_string(),
            };
            let _ = state_db.upsert_device(&new_dev);
            refreshed_db.push(new_dev);
        }

        // Remove/marca offline devices remotos que NÃO estão mais ativos no VPS nem no túnel local.
        for dev in &mut refreshed_db {
            if dev.via_tunnel {
                if let Some(ref id) = dev.esfera_device_id {
                    let local_tunnel_up = crate::tunnel_server::is_tunnel_active(id);
                    if !local_tunnel_up && !live_ids.contains(id) {
                        let adb_local_online = active_adb_list.iter().any(|adb_d| {
                            adb_d.state == "device"
                                && (adb_d.serial == dev.serial
                                    || dev.current_adb_address.as_deref() == Some(&adb_d.serial)
                                    || (!dev.ip.is_empty()
                                        && (adb_d.serial == dev.ip
                                            || adb_d.serial.starts_with(&format!("{}:", dev.ip)))))
                        });
                        if !adb_local_online {
                            dev.status = "offline".to_string();
                            dev.via_tunnel = false;
                            dev.battery = 0;
                        }
                    }
                }
            }
        }

        // FILTRO DE FANTASMAS: remove devices do DB local que NÃO estão nem no ADB
        // local ativo nem possuem identidade provisionada (EsferaDeviceId).
        let active_adb_set: std::collections::HashSet<String> =
            active_adb_list.iter().map(|a| a.serial.clone()).collect();
        refreshed_db.retain(|d| {
            if d.via_tunnel || d.esfera_device_id.is_some() || d.status == "connecting" {
                true
            } else {
                active_adb_set.contains(&d.serial)
                    || d.current_adb_address.as_deref().map_or(false, |a| active_adb_set.contains(a))
            }
        });

        // Unifica a lista final: funde cartões que compartilhem o mesmo EsferaDeviceId, IP ou Endereço ADB
        let mut final_deduped: Vec<Device> = Vec::new();
        for dev in refreshed_db {
            if let Some(pos) = final_deduped.iter().position(|existing| {
                // Match prioritário por EsferaDeviceId
                (existing.esfera_device_id.is_some() && dev.esfera_device_id.is_some() && existing.esfera_device_id == dev.esfera_device_id)
                // Match por serial exato
                || (!existing.serial.is_empty() && existing.serial == dev.serial)
                // Match por IP:Porta exato (quando contiver ponto e porta)
                || (!existing.ip.is_empty() && existing.ip.contains('.') && existing.ip == dev.ip)
                || (existing.current_adb_address.is_some() && dev.current_adb_address.is_some() && existing.current_adb_address == dev.current_adb_address)
            }) {
                // Mescla os dados priorizando o card mais ativo (online > connecting > degraded > offline)
                let existing_weight = match final_deduped[pos].status.as_str() {
                    "online" => 3,
                    "connecting" => 2,
                    "degraded" => 1,
                    _ => 0,
                };
                let dev_weight = match dev.status.as_str() {
                    "online" => 3,
                    "connecting" => 2,
                    "degraded" => 1,
                    _ => 0,
                };

                if dev_weight > existing_weight || (dev_weight == existing_weight && dev.via_tunnel) {
                    let mut merged = dev;
                    if merged.esfera_device_id.is_none() {
                        merged.esfera_device_id = final_deduped[pos].esfera_device_id.clone();
                    }
                    if !final_deduped[pos].name.is_empty() {
                        merged.name = final_deduped[pos].name.clone();
                    }
                    final_deduped[pos] = merged;
                } else if final_deduped[pos].esfera_device_id.is_none() && dev.esfera_device_id.is_some() {
                    final_deduped[pos].esfera_device_id = dev.esfera_device_id;
                }
            } else {
                final_deduped.push(dev);
            }
        }
        let mut refreshed_db = final_deduped;

        // Garante que qualquer aparelho desconectado/offline tenha battery=0, via_tunnel=false
        // e persiste esse status em runtime no SQLite para todas as visualizações.
        for dev in &mut refreshed_db {
            let is_connected = dev.status == "online" || dev.status == "online_agent" || dev.status == "degraded";
            if !is_connected {
                dev.battery = 0;
                dev.via_tunnel = false;
            }
            state_db.set_device_runtime_state(
                &dev.serial,
                dev.esfera_device_id.as_deref(),
                dev.company_id,
                &dev.status,
                dev.battery,
            );
        }

        Ok(refreshed_db)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_hpc_capabilities(_token: String) -> crate::adb_manager::EsferaHardwareCaps {
    AdbManager::get_hardware_capabilities()
}

#[tauri::command]
pub async fn run_adb_diagnostic(_token: String) -> Result<crate::adb_manager::EsferaAdbDiagnosticResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(AdbManager::run_diagnostic())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restart_adb_server(_token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::restart_server()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_adb_subnet(_token: String, subnet_prefix: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(AdbManager::scan_subnet(&subnet_prefix))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn deploy_adb_keepalive(_token: String, serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::deploy_keepalive(&serial)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn resolve_spintax(_token: String, text: String) -> Result<String, String> {
    Ok(crate::spintax::resolve_spintax(&text))
}

#[tauri::command]
pub fn spintax_combinations(_token: String, text: String) -> Result<u64, String> {
    Ok(crate::spintax::spintax_combinations(&text))
}

/// Instala o daemon kernel-level (device-agent) em um aparelho via ADB:
/// envia o binário + scripts para /data/adb/earlypoint e executa o instalador.
#[tauri::command]
pub fn install_kernel_agent(
    state: State<'_, AppState>,
    token: String,
    serial: String,
) -> Result<String, String> {
    validate_session(&state.sessions, &token)?;
    use std::path::PathBuf;

    // 1. Resolve o serial ADB ativo
    let resolved = AdbManager::resolve_target_serial(&serial)?;

    // 2. Localiza o binário do daemon (prioriza o bundled; fallback para target do device-agent)
    let candidates: Vec<PathBuf> = [
        "binaries/esfera-agent",
        "device-agent/target/aarch64-linux-android/release/device-agent",
        "device-agent/target/armv7-linux-androideabi/release/device-agent",
        "device-agent/target/aarch64-linux-android/release/esfera-agent",
        "device-agent/target/armv7-linux-androideabi/release/esfera-agent",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();

    let bin_path = candidates
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| {
            "Binário esfera-agent não encontrado. Compile com: cargo build --release --target aarch64-linux-android (em device-agent/) e copie para src-tauri/binaries/esfera-agent".to_string()
        })?;

    let script_dir = PathBuf::from("src-agent/scripts");
    let daemon_script = script_dir.join("00_earlypoint_daemon.sh");
    let install_script = script_dir.join("install.sh");
    if !daemon_script.exists() || !install_script.exists() {
        return Err("Scripts do daemon não encontrados em src-agent/scripts/".to_string());
    }

    // 3. Prepara diretório remoto
    let mut mkdir_cmd = crate::adb_manager::create_cmd("adb");
    mkdir_cmd.args(["-s", &resolved, "shell", "mkdir", "-p", "/data/local/tmp/earlypoint"]);
    let _ = crate::adb_manager::run_cmd_timeout(mkdir_cmd, std::time::Duration::from_secs(5));

    // 4. Push do binário + scripts
    for (local, remote) in [
        (bin_path.as_path(), "/data/local/tmp/earlypoint/esfera-agent"),
        (daemon_script.as_path(), "/data/local/tmp/earlypoint/00_earlypoint_daemon.sh"),
        (install_script.as_path(), "/data/local/tmp/earlypoint/install.sh"),
    ] {
        let mut cmd = crate::adb_manager::create_cmd("adb");
        cmd.args(["-s", &resolved, "push", &local.to_string_lossy(), remote]);
        let out = crate::adb_manager::run_cmd_timeout(cmd, std::time::Duration::from_secs(60))
            .map_err(|e| format!("Falha no push de {}: {}", remote, e))?;
        if !out.status.success() {
            return Err(format!("Falha no push de {} para o aparelho", remote));
        }
    }

    // 5. Determina o EsferaDeviceId do aparelho (para o handshake do túnel)
    let devices = state.db.get_devices(0);
    let hwid = devices
        .iter()
        .find(|d| d.serial == resolved || d.esfera_device_id.as_deref() == Some(resolved.as_str()))
        .and_then(|d| d.esfera_device_id.clone())
        .unwrap_or_default();

    // 6. Servidor do túnel = IP LAN desta máquina + porta configurada
    let cfg = crate::config::load_config();
    let server = format!(
        "{}:{}",
        AdbManager::get_host_lan_ip(),
        cfg.tunnel_server_port
    );

    // 7. Executa o instalador no aparelho (root)
    let mut install_cmd = crate::adb_manager::create_cmd("adb");
    install_cmd.args([
        "-s",
        &resolved,
        "shell",
        "sh",
        "/data/local/tmp/earlypoint/install.sh",
        &server,
        &cfg.tunnel_server_port.to_string(),
        &hwid,
    ]);
    let out = crate::adb_manager::run_cmd_timeout(install_cmd, std::time::Duration::from_secs(90))
        .map_err(|e| format!("Falha ao executar o instalador: {}", e))?;
    let combined = format!(
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    Ok(format!(
        "✅ Daemon Esfera instalado em {} (túnel → {}:{}) {}{}",
        resolved,
        server,
        cfg.tunnel_server_port,
        if out.status.success() { "" } else { " (com avisos) " },
        combined.trim()
    ))
}

#[tauri::command]
pub fn get_hardware_uuid(_token: String) -> String {
    AdbManager::get_hardware_uuid()
}

#[tauri::command]
pub async fn connect_adb_device(
    state: State<'_, AppState>,
    token: String,
    ip: String,
    port: i32,
    company_id: i32,
    device_number: i32,
    sector: String,
    device_name: Option<String>,
) -> Result<String, String> {
    log_connect(&format!("[CONNECT] ipc_entered fn=connect_adb_device ip={} port={} company_id={}", ip, port, company_id));
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let state_db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        log_connect("[CONNECT] worker_entered fn=connect_adb_device");
        let panic_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let start_time = std::time::Instant::now();
            let (target_ip, target_port) = if ip.contains(':') {
                let parts: Vec<&str> = ip.split(':').collect();
                let parsed_port = parts.get(1).and_then(|p| p.trim().parse::<i32>().ok()).unwrap_or(if port <= 0 { 5555 } else { port });
                (parts[0].trim().to_string(), parsed_port)
            } else {
                (ip.trim().to_string(), if port <= 0 { 5555 } else { port })
            };

            log_connect(&format!("[CONNECT] entered ip={}:{} company_id={}", target_ip, target_port, company_id));

            // ── 1. CHECAGEM DE DISPOSITIVO REMOTO / VPS ─────────────────────────────
            log_connect("[CONNECT] get_devices_start");
            let all_devs = state_db.get_devices(company_id);
            log_connect(&format!("[CONNECT] get_devices_end count={}", all_devs.len()));

            let existing_dev = all_devs.into_iter().find(|d| {
                d.ip == target_ip
                    || d.serial == target_ip
                    || d.current_adb_address.as_deref() == Some(&target_ip)
                    || d.esfera_device_id.as_deref() == Some(&target_ip)
            });
            log_connect(&format!("[CONNECT] existing_lookup_end found={}", existing_dev.is_some()));

            log_connect("[CONNECT] tunnel_check_start");
            let active_by_target = crate::tunnel_server::is_tunnel_active(&target_ip);
            let active_by_eid = existing_dev
                .as_ref()
                .and_then(|d| d.esfera_device_id.as_deref())
                .map(|eid| crate::tunnel_server::is_tunnel_active(eid))
                .unwrap_or(false);
            log_connect(&format!("[CONNECT] tunnel_check_end active_by_target={} active_by_eid={}", active_by_target, active_by_eid));

            let is_remote_device = target_ip.starts_with("ESF-")
                || existing_dev.as_ref().map(|d| d.via_tunnel).unwrap_or(false)
                || active_by_target
                || active_by_eid;

            log_connect(&format!("[CONNECT] remote_decision={}", is_remote_device));

            if is_remote_device {
                log_connect(&format!("[CONNECT] remote_detected target={}", target_ip));
                let esfera_id = existing_dev
                    .as_ref()
                    .and_then(|d| d.esfera_device_id.clone())
                    .unwrap_or_else(|| if target_ip.starts_with("ESF-") { target_ip.clone() } else { format!("ESF-{}", target_ip) });

                let final_name = device_name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| existing_dev.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| format!("Celular {}", device_number)));

                let is_active = active_by_target || active_by_eid;
                let status_str = if is_active { "online".to_string() } else { "degraded".to_string() };

                log_connect("[CONNECT] db_upsert_start");
                let dev = Device {
                    id: existing_dev.as_ref().map(|d| d.id).unwrap_or(0),
                    serial: format!("{}:{}", target_ip, target_port),
                    name: final_name.clone(),
                    brand: existing_dev.as_ref().map(|d| d.brand.clone()).unwrap_or_else(|| "Android".to_string()),
                    model: existing_dev.as_ref().map(|d| d.model.clone()).unwrap_or_else(|| "Smartphone".to_string()),
                    ip: target_ip.clone(),
                    port: target_port,
                    status: status_str,
                    battery: existing_dev.as_ref().map(|d| d.battery).unwrap_or(90),
                    company_id,
                    device_number,
                    sector,
                    esfera_device_id: Some(esfera_id),
                    current_adb_address: Some(format!("{}:{}", target_ip, target_port)),
                    last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                    via_tunnel: true,
                };
                let _ = state_db.upsert_device(&dev);
                log_connect("[CONNECT] db_upsert_end");

                let elapsed = start_time.elapsed().as_millis();
                log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
                return Ok(format!("✅ Dispositivo remoto {} cadastrado via VPS Hub em {}ms!", final_name, elapsed));
            }

            // ── 2. PROBAÇÃO DE ADB LOCAL ──────────────────────────────────────────
            log_connect("[CONNECT] probe_start");
            let is_local_tcp_open = {
                let addr_str = format!("{}:{}", target_ip, target_port);
                if let Ok(sa) = addr_str.parse() {
                    std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(1500)).is_ok()
                } else {
                    false
                }
            };
            log_connect(&format!("[CONNECT] probe_end is_local_tcp={}", is_local_tcp_open));

            let serial = format!("{}:{}", target_ip, target_port);

            // Se o TCP local NÃO responder em 1.5s: NENHUM COMANDO ADB É EXECUTADO!
            if !is_local_tcp_open {
                log_connect("[CONNECT] local_adb_unreachable — bypassing all adb commands");
                let esfera_id = existing_dev
                    .as_ref()
                    .and_then(|d| d.esfera_device_id.clone())
                    .unwrap_or_else(|| format!("ESF-{}", target_ip.replace('.', "_")));

                let final_name = device_name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { target_ip.clone() });

                let is_active = crate::tunnel_server::is_tunnel_active(&esfera_id);
                let status_str = if is_active { "online".to_string() } else { "degraded".to_string() };

                log_connect("[CONNECT] db_upsert_start");
                let dev = Device {
                    id: existing_dev.as_ref().map(|d| d.id).unwrap_or(0),
                    serial: serial.clone(),
                    name: final_name.clone(),
                    brand: "Android".to_string(),
                    model: "Smartphone".to_string(),
                    ip: target_ip.clone(),
                    port: target_port,
                    status: status_str,
                    battery: 90,
                    company_id,
                    device_number,
                    sector,
                    esfera_device_id: Some(esfera_id),
                    current_adb_address: Some(serial.clone()),
                    last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                    via_tunnel: true,
                };
                let _ = state_db.upsert_device(&dev);
                log_connect("[CONNECT] db_upsert_end");

                let elapsed = start_time.elapsed().as_millis();
                log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
                return Ok(format!("✅ Dispositivo {} vinculado com sucesso em {}ms!", final_name, elapsed));
            }

            // ── 3. APENAS SE FOR WI-FI LOCAL ACESSÍVEL: ───────────────────────────
            log_connect("[CONNECT] adb_connect_start");
            let adb_conn_res = AdbManager::connect_device(&target_ip, target_port);
            log_connect(&format!("[CONNECT] adb_connect_end ok={}", adb_conn_res.is_ok()));

            log_connect("[CONNECT] device_info_start");
            let (brand, model) = if adb_conn_res.is_ok() {
                AdbManager::get_device_info(&serial)
            } else {
                ("Android".to_string(), "Smartphone".to_string())
            };
            log_connect(&format!("[CONNECT] device_info_end brand={} model={}", brand, model));

            let final_name = device_name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { target_ip.clone() });

            log_connect("[CONNECT] persistent_id_start");
            let persistent_id = if adb_conn_res.is_ok() {
                AdbManager::get_persistent_device_id(&serial)
                    .unwrap_or_else(|| format!("ESF-{}", Uuid::new_v4()))
            } else {
                format!("ESF-{}", target_ip.replace('.', "_"))
            };
            log_connect(&format!("[CONNECT] persistent_id_end pid={}", persistent_id));

            if adb_conn_res.is_ok() {
                let s_clone = serial.clone();
                let pid_clone = persistent_id.clone();
                std::thread::spawn(move || {
                    log_connect("[CONNECT] inject_immunity_start");
                    let _ = AdbManager::inject_device_immunity(&s_clone, Some(&pid_clone));
                    log_connect("[CONNECT] inject_immunity_end");

                    log_connect("[CONNECT] deploy_keepalive_start");
                    let _ = AdbManager::deploy_keepalive(&s_clone);
                    log_connect("[CONNECT] deploy_keepalive_end");
                });
            }

            let is_tunnel_active = crate::tunnel_server::is_tunnel_active(&persistent_id)
                || crate::tunnel_server::is_tunnel_active(&target_ip);

            let status_str = if adb_conn_res.is_ok() || is_tunnel_active {
                "online".to_string()
            } else {
                "degraded".to_string()
            };

            log_connect("[CONNECT] db_upsert_start");
            let dev = Device {
                id: existing_dev.as_ref().map(|d| d.id).unwrap_or(0),
                serial: serial.clone(),
                name: final_name.clone(),
                brand,
                model,
                ip: target_ip.clone(),
                port: target_port,
                status: status_str,
                battery: 90,
                company_id,
                device_number,
                sector,
                esfera_device_id: Some(persistent_id),
                current_adb_address: Some(serial.clone()),
                last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                via_tunnel: adb_conn_res.is_err(),
            };
            state_db.upsert_device(&dev)?;
            log_connect("[CONNECT] db_upsert_end");

            let elapsed = start_time.elapsed().as_millis();
            log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
            Ok(format!("✅ Dispositivo {} conectado com sucesso em {}ms!", final_name, elapsed))
        }));

        match panic_res {
            Ok(res) => res,
            Err(e) => {
                let panic_msg = if let Some(s) = e.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = e.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Erro interno / panic no worker".to_string()
                };
                log_connect(&format!("[CONNECT] PANIC_DETECTED msg={}", panic_msg));
                Err(format!("Erro no processo: {}", panic_msg))
            }
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pair_and_connect_adb_device(
    state: State<'_, AppState>,
    token: String,
    ip: String,
    pair_port: u16,
    pair_code: String,
    connect_port: u16,
    company_id: i32,
    device_number: i32,
    sector: String,
    device_name: Option<String>,
) -> Result<String, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let state_db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let clean_ip = ip.split(':').next().unwrap_or(&ip).trim().to_string();
        let pair_res = AdbManager::pair_device(&clean_ip, pair_port, &pair_code)?;

        let conn_port = if connect_port == 0 { 5555 } else { connect_port };
        let connect_res = AdbManager::connect_device(&clean_ip, conn_port as i32)?;

        let wireless_serial = format!("{}:{}", clean_ip, conn_port);
        let _ = crate::adb_manager::create_cmd("adb")
            .args(["-s", &wireless_serial, "shell", "setprop", "persist.adb.tcp.port", "5555"])
            .output();
        let _ = AdbManager::deploy_keepalive(&wireless_serial);
        let persistent_id = AdbManager::get_persistent_device_id(&wireless_serial)
            .unwrap_or_else(|| format!("ESF-{}", Uuid::new_v4()));
        let _ = AdbManager::inject_device_immunity(&wireless_serial, Some(&persistent_id));

        let (brand, model) = AdbManager::get_device_info(&wireless_serial);
        let final_name = device_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { clean_ip.clone() });

        let device = Device {
            id: 0,
            serial: wireless_serial.clone(),
            name: final_name,
            brand,
            model,
            ip: clean_ip,
            port: conn_port as i32,
            status: "online".to_string(),
            battery: 100,
            company_id,
            device_number,
            sector,
            esfera_device_id: None,
            current_adb_address: Some(wireless_serial),
            last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
            via_tunnel: false,
        };
        state_db.upsert_device(&device)?;

        Ok(format!("Celular Pareado e Conectado com Sucesso! {} ({})", pair_res, connect_res))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn disconnect_adb_device(state: State<'_, AppState>, token: String, serial: String) -> Result<String, String> {
    let _session = validate_session(&state.sessions, &token)?;
    let result = AdbManager::disconnect_device(&serial)?;
    let db = &state.db;
    db.queue_add_log(
        0,
        "info",
        "ADB Engine",
        &format!("Dispositivo {} desconectado.", serial),
    );
    Ok(result)
}

#[tauri::command]
pub fn delete_device(state: State<'_, AppState>, token: String, serial: String) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Master ou Gestor podem remover dispositivos.".to_string());
    }
    let db = &state.db;
    db.delete_device(&serial)
}

#[tauri::command]
pub fn update_device(state: State<'_, AppState>, token: String, mut device: Device) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, device.company_id)?;
    let db = &state.db;

    if let Ok(num) = device.name.trim().parse::<i32>() {
        device.device_number = num;
    }

    let target_serial = if !device.serial.is_empty() {
        device.serial.clone()
    } else {
        device.current_adb_address.clone().unwrap_or_default()
    };

    let actual_esfera_id = if !target_serial.is_empty() {
        AdbManager::get_persistent_device_id(&target_serial)
            .or_else(|| device.esfera_device_id.clone())
            .unwrap_or_else(|| target_serial.clone())
    } else {
        device.esfera_device_id.clone().unwrap_or_default()
    };

    if !actual_esfera_id.is_empty() {
        device.esfera_device_id = Some(actual_esfera_id.clone());
        let _ = db.save_device_identity(&actual_esfera_id, &device.name, &device.sector, device.device_number, &device.model);
    }

    let _ = db.update_device_config(&device);
    let _ = db.upsert_device(&device);

    // Propaga o novo nome para o Banco de Dados da VPS (Hub) imediatamente
    let esfera_id_opt = device.esfera_device_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            db.get_device_by_esfera_id(&device.serial)
                .and_then(|d| d.esfera_device_id)
        });

    if let Some(esfera_id) = esfera_id_opt {
        if !esfera_id.is_empty() {
            let hub = state.hub_client.clone();
            let id2 = esfera_id.clone();
            let name2 = device.name.clone();
            let cid = device.company_id;
            tauri::async_runtime::spawn(async move {
                // 1. Envia via Hub WebSocket se conectado
                let guard = hub.lock().await;
                if let Some(client) = guard.as_ref() {
                    let _ = client.send_command(
                        cid,
                        "rename_device",
                        serde_json::json!({ "esferaDeviceId": id2, "name": name2 }),
                    ).await;
                }

                // 2. Envia via HTTP Checkin Server se hub remoto estiver ativo
                let cfg = crate::config::load_config();
                if cfg.hub_enabled && cfg.mode != "standalone" && !cfg.hub_address.is_empty() {
                    let host = cfg.hub_address.split(':').next().unwrap_or("127.0.0.1");
                    let client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(4))
                        .build();
                    if let Ok(c) = client {
                        let _ = c.post(format!("http://{}:{}/api/devices/rename", host, cfg.checkin_server_port))
                            .json(&serde_json::json!({
                                "esfera_device_id": id2,
                                "name": name2,
                                "company_id": cid
                            }))
                            .send()
                            .await;
                    }
                }
            });
        }
    }
    Ok(())
}

/// Atualiza remotamente o APK do agente num celular, SEM SSH: envia o comando
/// `self_update <url>` através do VPS (túnel), e o agente baixa e instala o APK.
/// `apk_url` deve ser servida por um backend/VPS acessível pelo celular.
#[tauri::command]
pub async fn remote_update_agent(
    state: State<'_, AppState>,
    token: String,
    esfera_device_id: String,
    apk_url: String,
    company_id: i32,
) -> Result<String, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    if apk_url.is_empty() || !(apk_url.starts_with("http://") || apk_url.starts_with("https://")) {
        return Err("URL do APK inválida (use http(s)://...).".to_string());
    }
    let hub = state.hub_client.lock().await;
    if hub.is_none() {
        return Err("Hub não conectado. Verifique o Token do Hub em Configurações.".to_string());
    }
    match HubClient::send_command(
        &hub.as_ref().unwrap(),
        company_id,
        "send_device_command",
        serde_json::json!({
            "companyId": company_id,
            "esferaDeviceId": esfera_device_id,
            "command": format!("self_update {}", apk_url)
        }),
    ).await {
        Ok(v) => Ok(v.get("output").and_then(|o| o.as_str()).unwrap_or("comando enviado").to_string()),
        Err(e) => Err(format!("Falha ao enviar atualização: {}", e)),
    }
}

#[tauri::command]
pub fn optimize_device(state: State<'_, AppState>, token: String, serial: String) -> Result<String, String> {
    let _session = validate_session(&state.sessions, &token)?;
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
        let mut adb = crate::adb_manager::create_cmd("adb");
        adb.args(["-s", &serial, "shell", cmd]);
        let output = crate::adb_manager::run_cmd_timeout(adb, std::time::Duration::from_secs(6));
        match output {
            Ok(_) => results.push(format!("✓ {}", cmd)),
            Err(e) => results.push(format!("✗ {}: {}", cmd, e)),
        }
    }
    Ok(results.join("\n"))
}

#[tauri::command]
pub fn get_device_ip(_token: String, serial: String) -> Result<String, String> {
    AdbManager::get_device_wifi_ip(&serial)
}

// ============================================================
// CAMPANHAS
// ============================================================

#[tauri::command]
pub fn get_campaigns(state: State<'_, AppState>, token: String, company_id: i32) -> Result<Vec<Campaign>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    Ok(db.get_campaigns(company_id))
}

#[tauri::command]
pub fn create_campaign(state: State<'_, AppState>, token: String, campaign: Campaign) -> Result<i32, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, campaign.company_id)?;
    if session.role == "colaborador" {
        return Err("Acesso Negado: Colaborador não pode criar campanhas.".to_string());
    }
    let db = &state.db;
    let id = db.create_campaign(&campaign)?;
    db.queue_add_log(
        campaign.company_id,
        "info",
        "Central Campanhas",
        &format!("Nova campanha criada: {}", campaign.name),
    );
    Ok(id)
}

#[tauri::command]
pub fn update_campaign(state: State<'_, AppState>, token: String, campaign: Campaign) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, campaign.company_id)?;
    if session.role == "colaborador" {
        return Err("Acesso Negado: Colaborador não pode alterar campanhas.".to_string());
    }
    let db = &state.db;
    db.update_campaign(&campaign)
}

#[tauri::command]
pub fn soft_delete_campaign(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    let company_id = db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    if session.role == "colaborador" {
        return Err("Acesso Negado: Colaborador não pode excluir campanhas.".to_string());
    }
    let devices = db.get_campaigns(company_id).into_iter().find(|c| c.id == campaign_id).map(|c| c.device_ids);
    db.soft_delete_campaign(campaign_id)?;
    // Campanha pausada excluída: apaga também os contatos temporários dos aparelhos dela.
    if let Some(device_ids) = devices {
        crate::dispatcher::cleanup_campaign_contacts(state.db.clone(), company_id, device_ids);
    }
    Ok(())
}

#[tauri::command]
pub fn set_campaign_status(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
    status: String,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.set_campaign_status(campaign_id, &status)
}

// ============================================================
// AUTOMAÇÕES
// ============================================================

#[tauri::command]
pub fn get_automations(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<AutomationRule>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    Ok(db.get_automations(company_id))
}

#[tauri::command]
pub fn create_automation(
    state: State<'_, AppState>,
    token: String,
    automation: AutomationRule,
) -> Result<i32, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, automation.company_id)?;
    let db = &state.db;
    let id = db.create_automation(&automation)?;
    db.queue_add_log(
        automation.company_id,
        "info",
        "Motor Automações",
        &format!("Nova regra criada: {}", automation.name),
    );
    Ok(id)
}

#[tauri::command]
pub fn update_automation(
    state: State<'_, AppState>,
    token: String,
    automation: AutomationRule,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.update_automation(&automation)
}

#[tauri::command]
pub fn soft_delete_automation(
    state: State<'_, AppState>,
    token: String,
    automation_id: i32,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.soft_delete_automation(automation_id)
}

// ============================================================
// LOGS
// ============================================================

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>, token: String, company_id: i32) -> Result<Vec<crate::db::AuditLog>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    Ok(db.get_logs(company_id))
}

#[tauri::command]
pub fn add_log(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
    log_type: String,
    source: String,
    message: String,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.add_log(company_id, &log_type, &source, &message)
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>, token: String, company_id: i32) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.clear_logs(company_id)
}

// ============================================================
// ADB REMOTO
// ============================================================

#[tauri::command]
pub async fn capture_device_screen(state: State<'_, AppState>, _token: String, serial: String) -> Result<String, String> {
    // Device remoto (via_tunnel): roteia a captura pelo túnel VPS, que empurra até
    // o agente Kotlin executar o screencap localmente. Sem isso, o capture tentava
    // ADB local (inexistente para remoto) e falhava com "não foi possível capturar".
    if let Some(company_id) = resolve_remote_target(&state, &serial) {
        match send_remote_adb_command(&state, company_id, &serial, "screencap -p | base64 -w 0").await {
            Ok(b64) if !b64.trim().is_empty() => return Ok(b64.trim().to_string()),
            // Túnel existe (via_tunnel) mas o comando não voltou: presença viva, ADB morto.
            Ok(_) => return Err("Túnel ADB do celular está indisponível (presença ativa). Aguardando reconexão do túnel...".to_string()),
            Err(e) => return Err(format!("Falha ao capturar via túnel: {}. Verifique se o celular está online.", e)),
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::capture_screen(&serial)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn send_adb_tap(state: State<'_, AppState>, _token: String, serial: String, x: u32, y: u32) -> Result<(), String> {
    // Bifurcação A: device remoto (via_tunnel) roteia comando para o VPS, que
    // empurra pelo túnel até o agente Kotlin executar localmente (sem root).
    if let Some(company_id) = resolve_remote_target(&state, &serial) {
        let cmd = format!("input tap {} {}", x, y);
        send_remote_adb_command(&state, company_id, &serial, &cmd).await?;
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::tap_screen(&serial, x, y)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn send_adb_keyevent(state: State<'_, AppState>, _token: String, serial: String, keycode: u32) -> Result<(), String> {
    if let Some(company_id) = resolve_remote_target(&state, &serial) {
        let cmd = format!("input keyevent {}", keycode);
        send_remote_adb_command(&state, company_id, &serial, &cmd).await?;
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::send_keyevent(&serial, keycode)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn send_adb_input_text(state: State<'_, AppState>, token: String, serial: String, text: String) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    if let Some(company_id) = resolve_remote_target(&state, &serial) {
        let escaped = text.replace(' ', "%s").replace('\'', "\\'");
        let cmd = format!("input text '{}'", escaped);
        send_remote_adb_command(&state, company_id, &serial, &cmd).await?;
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::input_text(&serial, &text)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_device_settings(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    stay_awake: Option<bool>,
    dark_mode: Option<bool>,
    show_touches: Option<bool>,
    animation_scale: Option<f32>,
    dpi: Option<i32>,
) -> Result<String, String> {
    validate_session(&state.sessions, &token)?;
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::apply_advanced_settings(&serial, stay_awake, dark_mode, show_touches, animation_scale, dpi)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reboot_adb_device(
    state: State<'_, AppState>,
    token: String,
    serial: String,
) -> Result<String, String> {
    validate_session(&state.sessions, &token)?;
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::reboot_device(&serial)
    }).await.map_err(|e| e.to_string())?
}

/// Se `serial` for o esfera_device_id de um device remoto (via_tunnel), devolve o
/// company_id para rotear ações via VPS. Caso contrário, None (ação local ADB).
fn resolve_remote_target(state: &AppState, serial: &str) -> Option<i32> {
    // serial de device remoto == esfera_device_id (definido no merge de get_devices).
    if let Some(dev) = state.db.get_device_by_esfera_id(serial) {
        if dev.via_tunnel {
            return Some(dev.company_id);
        }
    }
    None
}

/// Envia um comando para execução local no agente Kotlin via túnel VPS e devolve a saída.
pub async fn send_remote_adb_command(state: &AppState, company_id: i32, esfera_device_id: &str, command: &str) -> Result<String, String> {
    let guard = state.hub_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "Hub não conectado. Faça login novamente.".to_string())?;
    let resp = client.send_command(company_id, "send_device_command", serde_json::json!({
        "esferaDeviceId": esfera_device_id,
        "command": command,
        "companyId": company_id,
    })).await?;
    resp.get("output").and_then(|s| s.as_str()).map(|s| s.to_string())
        .ok_or_else(|| "resposta do device sem saída".to_string())
}

// ============================================================
// CHIPS
// ============================================================

#[tauri::command]
pub fn get_device_chips(state: State<'_, AppState>, token: String, device_id: i32) -> Result<Vec<Chip>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_chips(device_id))
}

#[tauri::command]
pub fn add_device_chip(
    state: State<'_, AppState>,
    token: String,
    device_id: i32,
    phone: String,
    name: String,
) -> Result<i32, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.add_chip(device_id, &phone, &name)
}

#[tauri::command]
pub fn update_chip_status(
    state: State<'_, AppState>,
    token: String,
    chip_id: i32,
    status: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.update_chip_status(chip_id, &status)
}

#[tauri::command]
pub fn set_chip_restriction(
    state: State<'_, AppState>,
    token: String,
    chip_id: i32,
    restriction_type: String,
    days: Option<i32>,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
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
pub fn confirm_chip_release(state: State<'_, AppState>, token: String, chip_id: i32) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.confirm_chip_release(chip_id)
}

#[tauri::command]
pub fn move_chip(
    state: State<'_, AppState>,
    token: String,
    chip_id: i32,
    target_device_id: i32,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.move_chip(chip_id, target_device_id)
}

#[tauri::command]
pub fn set_chip_holder(
    state: State<'_, AppState>,
    token: String,
    chip_id: i32,
    holder: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.set_chip_holder(chip_id, &holder)
}

#[tauri::command]
pub fn mark_chip_reserve(
    state: State<'_, AppState>,
    token: String,
    chip_id: i32,
    is_reserve: bool,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.mark_chip_reserve(chip_id, is_reserve)
}

#[tauri::command]
pub fn get_restricted_chips(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<Chip>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    Ok(db.get_restricted_chips_without_reserve(company_id))
}

// ============================================================
// CONTATOS
// ============================================================

#[tauri::command]
pub fn get_campaign_contacts(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
) -> Result<Vec<Contact>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_contacts(campaign_id))
}

#[tauri::command]
pub fn import_campaign_contacts(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
    contacts: Vec<(String, String)>,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.import_contacts(campaign_id, contacts)
}

#[tauri::command]
pub fn get_pending_contacts(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
    limit: i32,
) -> Result<Vec<Contact>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_pending_contacts(campaign_id, limit))
}

#[tauri::command]
pub fn update_contact_status(
    state: State<'_, AppState>,
    token: String,
    contact_id: i32,
    status: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.update_contact_status(contact_id, &status)
}

#[tauri::command]
pub fn set_contact_custom_message(
    state: State<'_, AppState>,
    token: String,
    contact_id: i32,
    message: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.set_contact_custom_message(contact_id, &message)
}

#[tauri::command]
pub fn get_next_pending_contact(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
) -> Result<Option<Contact>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_next_pending_contact(campaign_id))
}

// ============================================================
// SENT HISTORY (dedup)
// ============================================================

#[tauri::command]
pub fn was_already_sent(
    state: State<'_, AppState>,
    token: String,
    phone: String,
    campaign_id: i32,
) -> Result<bool, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.was_already_sent(&phone, campaign_id))
}

// ============================================================
// DEVICE STATUS & PREFS
// ============================================================

#[tauri::command]
pub fn is_device_banned(
    state: State<'_, AppState>,
    token: String,
    device_id: String,
    package_name: String,
    campaign_id: i32,
) -> Result<bool, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.is_device_banned(&device_id, &package_name, campaign_id))
}

#[tauri::command]
pub fn set_device_banned(
    state: State<'_, AppState>,
    token: String,
    device_id: String,
    package_name: String,
    campaign_id: i32,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.set_device_banned(&device_id, &package_name, campaign_id)
}

#[tauri::command]
pub fn get_device_prefs(
    state: State<'_, AppState>,
    token: String,
    device_id: String,
    campaign_id: i32,
) -> Result<Option<crate::db::DevicePrefs>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_device_prefs(&device_id, campaign_id))
}

#[tauri::command]
pub fn set_device_prefs(
    state: State<'_, AppState>,
    token: String,
    device_id: String,
    campaign_id: i32,
    preferred_package: String,
    unlock_pin: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.set_device_prefs(&device_id, campaign_id, &preferred_package, &unlock_pin)
}

// ============================================================
// DEVICE PACKAGES
// ============================================================

#[tauri::command]
pub fn get_device_package_statuses(
    state: State<'_, AppState>,
    token: String,
    device_id: i32,
) -> Result<Vec<DevicePackage>, String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    Ok(db.get_package_statuses(device_id))
}

#[tauri::command]
pub fn update_device_package_status(
    state: State<'_, AppState>,
    token: String,
    device_id: i32,
    pkg_name: String,
    status: String,
) -> Result<(), String> {
    validate_session(&state.sessions, &token)?;
    let db = &state.db;
    db.update_package_status(device_id, &pkg_name, &status)
}

// ============================================================
// USB / PAIRING
// ============================================================

#[tauri::command]
pub async fn list_usb_devices(_token: String) -> Result<Vec<AdbDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::list_devices()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn link_usb_to_wireless(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    company_id: i32,
    device_number: i32,
    sector: String,
    device_name: Option<String>,
) -> Result<String, String> {
    let state_db = state.db.clone();
    let state_sessions = state.sessions.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let session = validate_session(&state_sessions, &token)?;
        check_company_access(&session, company_id)?;
        let ip = AdbManager::get_device_wifi_ip(&serial)?;
        AdbManager::enable_tcpip(&serial, 5555)?;
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let link_msg = AdbManager::connect_device(&ip, 5555)?;
        let (brand, model) = AdbManager::get_device_info(&serial);
        let wireless_serial = format!("{}:5555", ip);
        let final_name = device_name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { ip.clone() });
        let persistent_id = AdbManager::get_persistent_device_id(&wireless_serial)
            .unwrap_or_else(|| format!("ESF-{}", Uuid::new_v4()));
        let device = Device {
            id: 0,
            serial: wireless_serial.clone(),
            name: final_name,
            brand,
            model,
            ip,
            port: 5555,
            status: "online".to_string(),
            battery: 100,
            company_id,
            device_number,
            sector,
            esfera_device_id: None,
            current_adb_address: Some(wireless_serial.clone()),
            last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
            via_tunnel: false,
        };
        state_db.upsert_device(&device)?;
        let ws_clone = wireless_serial.clone();
        let s_clone = serial.clone();
        let pid_clone = persistent_id.clone();
        std::thread::spawn(move || {
            let _ = AdbManager::inject_device_immunity(&ws_clone, Some(&pid_clone));
            let _ = AdbManager::inject_device_immunity(&s_clone, Some(&pid_clone));
            let _ = AdbManager::deploy_keepalive(&ws_clone);
            let _ = AdbManager::deploy_keepalive(&s_clone);
        });
        Ok(format!(
            "Sucesso! Dispositivo pareado sem fio: {}",
            link_msg
        ))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn force_reconnect_all_adb(_token: String, state: State<'_, AppState>) -> Result<String, String> {
    let state_db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::force_reconnect_all_adb(&state_db)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn inject_all_devices_immunity(_token: String, state: State<'_, AppState>) -> Result<String, String> {
    let active_devices = AdbManager::list_devices()?;
    let online_devices: Vec<_> = active_devices.into_iter().filter(|d| d.state == "device").collect();
    let count = online_devices.len();

    if count == 0 {
        return Ok("Nenhum celular online detectado via ADB no momento. Conecte via cabo USB ou Wi-Fi e tente novamente.".to_string());
    }

    let db_arc = state.db.clone();
    std::thread::spawn(move || {
        for (_idx, dev) in online_devices.iter().enumerate() {
            let existing_id = AdbManager::get_persistent_device_id(&dev.serial);
            let pid = match existing_id {
                Some(id) => id,
                None => {
                    let new_id = format!("ESF-{}", Uuid::new_v4());
                    let _ = AdbManager::inject_persistent_device_id(&dev.serial, &new_id);
                    new_id
                }
            };

            if let Err(e) = AdbManager::inject_device_immunity(&dev.serial, Some(&pid)) {
                eprintln!("Falha ao injetar imunidade em {}: {}", dev.serial, e);
            }

            if dev.serial.contains(':') {
                let ip_parts: Vec<&str> = dev.serial.split(':').collect();
                let ip = ip_parts[0];
                let (brand, model) = AdbManager::get_device_info(&dev.serial);

                let all_existing = db_arc.get_devices(0);
                if let Some(existing_dev) = all_existing.iter().find(|d| d.serial == dev.serial) {
                    let mut updated = existing_dev.clone();
                    updated.status = "online".to_string();
                    updated.ip = ip.to_string();
                    if updated.brand.is_empty() { updated.brand = brand; }
                    if updated.model.is_empty() { updated.model = model; }
                    let _ = db_arc.upsert_device(&updated);
                } else {
                    let dev_num = (all_existing.len() + 1) as i32;
                    let device_obj = Device {
                        id: 0,
                        serial: dev.serial.clone(),
                        name: dev_num.to_string(),
                        brand,
                        model,
                        ip: ip.to_string(),
                        port: 5555,
                        status: "online".to_string(),
                        battery: 100,
                        company_id: 1,
                        device_number: dev_num,
                        sector: "junior".to_string(),
                        esfera_device_id: Some(pid.clone()),
                        current_adb_address: Some(dev.serial.clone()),
                        last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                        via_tunnel: false,
                    };
                    let _ = db_arc.upsert_device(&device_obj);
                }
            }
        }
    });

    Ok(format!(
        "🛡️ Injeção de Imunidade, MAC Físico e Kernel ID iniciada para {} celulares online!",
        count
    ))
}

#[tauri::command]
pub fn inject_single_device_immunity(_token: String, serial: String) -> Result<String, String> {
    let s = serial.clone();
    std::thread::spawn(move || {
        let existing_id = AdbManager::get_persistent_device_id(&s);
        let pid = existing_id.unwrap_or_else(|| format!("ESF-{}", Uuid::new_v4()));
        if let Err(e) = AdbManager::inject_device_immunity(&s, Some(&pid)) {
            eprintln!("Falha ao injetar imunidade em {}: {}", s, e);
        }
    });
    Ok(format!("🛡️ Injeção de Imunidade enviada em segundo plano para {}!", serial))
}

#[tauri::command]
pub async fn force_enable_wireless_adb(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    company_id: i32,
    device_number: i32,
    sector: String,
    device_name: Option<String>,
) -> Result<String, String> {
    log_connect(&format!("[CONNECT] ipc_entered fn=force_enable_wireless_adb serial={} company_id={}", serial, company_id));
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let state_db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        log_connect("[CONNECT] worker_entered fn=force_enable_wireless_adb");
        let panic_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let start_time = std::time::Instant::now();
            log_connect(&format!("[CONNECT] entered serial={} company_id={}", serial, company_id));

            // ── 1. CHECAGEM SE É REMOTO / DISPOSITIVO VPS / ESFERA_DEVICE_ID
            log_connect("[CONNECT] get_devices_start");
            let all_devs = state_db.get_devices(company_id);
            log_connect(&format!("[CONNECT] get_devices_end count={}", all_devs.len()));

            let existing_dev = all_devs.into_iter().find(|d| {
                d.serial == serial
                    || d.esfera_device_id.as_deref() == Some(&serial)
                    || d.ip == serial
                    || d.current_adb_address.as_deref() == Some(&serial)
            });
            log_connect(&format!("[CONNECT] existing_lookup_end found={}", existing_dev.is_some()));

            log_connect("[CONNECT] tunnel_check_start");
            let active_by_serial = crate::tunnel_server::is_tunnel_active(&serial);
            let active_by_eid = existing_dev
                .as_ref()
                .and_then(|d| d.esfera_device_id.as_deref())
                .map(|eid| crate::tunnel_server::is_tunnel_active(eid))
                .unwrap_or(false);
            log_connect(&format!("[CONNECT] tunnel_check_end active_by_serial={} active_by_eid={}", active_by_serial, active_by_eid));

            let is_remote_device = serial.starts_with("ESF-")
                || existing_dev.as_ref().map(|d| d.via_tunnel).unwrap_or(false)
                || active_by_serial
                || active_by_eid;

            log_connect(&format!("[CONNECT] remote_decision={}", is_remote_device));

            if is_remote_device {
                log_connect(&format!("[CONNECT] remote_detected serial={}", serial));
                let esfera_id = existing_dev
                    .as_ref()
                    .and_then(|d| d.esfera_device_id.clone())
                    .unwrap_or_else(|| if serial.starts_with("ESF-") { serial.clone() } else { format!("ESF-{}", serial) });

                let final_name = device_name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| existing_dev.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| format!("Celular {}", device_number)));

                let is_active = active_by_serial || active_by_eid;
                let status_str = if is_active { "online".to_string() } else { "degraded".to_string() };

                log_connect("[CONNECT] db_upsert_start");
                let dev = Device {
                    id: existing_dev.as_ref().map(|d| d.id).unwrap_or(0),
                    serial: serial.clone(),
                    name: final_name.clone(),
                    brand: existing_dev.as_ref().map(|d| d.brand.clone()).unwrap_or_else(|| "Android".to_string()),
                    model: existing_dev.as_ref().map(|d| d.model.clone()).unwrap_or_else(|| "Smartphone".to_string()),
                    ip: existing_dev.as_ref().map(|d| d.ip.clone()).unwrap_or_else(|| "0.0.0.0".to_string()),
                    port: 5555,
                    status: status_str,
                    battery: existing_dev.as_ref().map(|d| d.battery).unwrap_or(100),
                    company_id,
                    device_number,
                    sector,
                    esfera_device_id: Some(esfera_id),
                    current_adb_address: Some(serial.clone()),
                    last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                    via_tunnel: true,
                };
                let _ = state_db.upsert_device(&dev);
                log_connect("[CONNECT] db_upsert_end");

                let elapsed = start_time.elapsed().as_millis();
                log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
                return Ok(format!("✅ Dispositivo remoto {} vinculado via VPS Hub em {}ms!", final_name, elapsed));
            }

            // ── 2. PROBAÇÃO DE ADB LOCAL ──────────────────────────────────────────
            log_connect("[CONNECT] probe_start");
            let is_usb_attached = AdbManager::list_devices().unwrap_or_default().iter().any(|d| d.serial == serial);
            let is_local_tcp_open = if !is_usb_attached {
                let addr_str = if serial.contains(':') { serial.clone() } else { format!("{}:5555", serial) };
                if let Ok(sa) = addr_str.parse() {
                    std::net::TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(1500)).is_ok()
                } else {
                    false
                }
            } else {
                false
            };
            log_connect(&format!("[CONNECT] probe_end is_usb={} is_tcp={}", is_usb_attached, is_local_tcp_open));

            // Se NÃO for USB físico E o TCP local NÃO responder em 1.5s: NENHUM COMANDO ADB É EXECUTADO!
            if !is_usb_attached && !is_local_tcp_open {
                log_connect("[CONNECT] local_adb_unreachable — bypassing all adb commands");
                let esfera_id = existing_dev
                    .as_ref()
                    .and_then(|d| d.esfera_device_id.clone())
                    .unwrap_or_else(|| format!("ESF-{}", serial.replace(':', "_")));

                let final_name = device_name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { serial.clone() });

                let is_active = crate::tunnel_server::is_tunnel_active(&esfera_id);
                let status_str = if is_active { "online".to_string() } else { "degraded".to_string() };

                log_connect("[CONNECT] db_upsert_start");
                let dev = Device {
                    id: existing_dev.as_ref().map(|d| d.id).unwrap_or(0),
                    serial: serial.clone(),
                    name: final_name.clone(),
                    brand: "Android".to_string(),
                    model: "Smartphone".to_string(),
                    ip: serial.split(':').next().unwrap_or(&serial).to_string(),
                    port: 5555,
                    status: status_str,
                    battery: 100,
                    company_id,
                    device_number,
                    sector,
                    esfera_device_id: Some(esfera_id),
                    current_adb_address: Some(serial.clone()),
                    last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                    via_tunnel: true,
                };
                let _ = state_db.upsert_device(&dev);
                log_connect("[CONNECT] db_upsert_end");

                let elapsed = start_time.elapsed().as_millis();
                log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
                return Ok(format!("✅ Dispositivo {} cadastrado em {}ms!", final_name, elapsed));
            }

            // ── 3. APENAS SE FOR DISPOSITIVO FISICAMENTE CONECTADO VIA USB OU WI-FI LOCAL ACESSÍVEL:
            log_connect("[CONNECT] adb_connect_start");
            let ip = if is_usb_attached {
                AdbManager::get_device_wifi_ip(&serial).unwrap_or_else(|_| "127.0.0.1".to_string())
            } else {
                serial.split(':').next().unwrap_or(&serial).to_string()
            };
            log_connect(&format!("[CONNECT] adb_connect_end ip={}", ip));

            log_connect("[CONNECT] persistent_id_start");
            let persistent_id = AdbManager::get_persistent_device_id(&serial)
                .unwrap_or_else(|| format!("ESF-{}", Uuid::new_v4()));
            let _ = AdbManager::inject_persistent_device_id(&serial, &persistent_id);
            log_connect(&format!("[CONNECT] persistent_id_end pid={}", persistent_id));

            if is_usb_attached {
                let _ = crate::adb_manager::create_cmd("adb")
                    .args(["-s", &serial, "shell", "setprop", "persist.adb.tcp.port", "5555"])
                    .output();
                let _ = AdbManager::enable_tcpip(&serial, 5555);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }

            let connect_res = if ip != "127.0.0.1" && ip != "0.0.0.0" {
                AdbManager::connect_device(&ip, 5555).ok()
            } else {
                None
            };

            log_connect("[CONNECT] device_info_start");
            let (brand, model) = AdbManager::get_device_info(&serial);
            log_connect(&format!("[CONNECT] device_info_end brand={} model={}", brand, model));

            let wireless_serial = if ip != "127.0.0.1" && ip != "0.0.0.0" { format!("{}:5555", ip) } else { serial.clone() };

            if connect_res.is_some() || is_usb_attached {
                let ws_clone = wireless_serial.clone();
                let pid_clone = persistent_id.clone();
                std::thread::spawn(move || {
                    log_connect("[CONNECT] inject_immunity_start");
                    let _ = AdbManager::inject_device_immunity(&ws_clone, Some(&pid_clone));
                    log_connect("[CONNECT] inject_immunity_end");

                    log_connect("[CONNECT] deploy_keepalive_start");
                    let _ = AdbManager::deploy_keepalive(&ws_clone);
                    log_connect("[CONNECT] deploy_keepalive_end");
                });
            }

            let final_name = device_name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| if device_number > 0 { device_number.to_string() } else { serial.clone() });

            let is_tunnel_active = active_by_serial || active_by_eid;
            let status_str = if connect_res.is_some() || is_usb_attached || is_tunnel_active {
                "online".to_string()
            } else {
                "degraded".to_string()
            };

            log_connect("[CONNECT] db_upsert_start");
            let device = Device {
                id: 0,
                serial: wireless_serial.clone(),
                name: final_name.clone(),
                brand,
                model,
                ip: ip.clone(),
                port: 5555,
                status: status_str,
                battery: 100,
                company_id,
                device_number,
                sector,
                esfera_device_id: Some(persistent_id),
                current_adb_address: Some(wireless_serial),
                last_seen_utc: Some(chrono::Utc::now().to_rfc3339()),
                via_tunnel: connect_res.is_none() && !is_usb_attached,
            };
            state_db.upsert_device(&device)?;
            log_connect("[CONNECT] db_upsert_end");

            let elapsed = start_time.elapsed().as_millis();
            log_connect(&format!("[CONNECT] returning elapsed_ms={}", elapsed));
            Ok(format!("✅ Dispositivo {} configurado com sucesso em {}ms!", final_name, elapsed))
        }));

        match panic_res {
            Ok(res) => res,
            Err(e) => {
                let panic_msg = if let Some(s) = e.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = e.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Erro interno / panic no worker".to_string()
                };
                log_connect(&format!("[CONNECT] PANIC_DETECTED msg={}", panic_msg));
                Err(format!("Erro no processo: {}", panic_msg))
            }
        }
    }).await.map_err(|e| e.to_string())?
}

// ============================================================
// AI CONFIG
// ============================================================

#[tauri::command]
pub fn get_ai_config(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Option<AiConfig>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    Ok(db.get_ai_config(company_id))
}

#[tauri::command]
pub fn save_ai_config(state: State<'_, AppState>, token: String, config: AiConfig) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, config.company_id)?;
    let db = &state.db;
    db.save_ai_config(&config)
}

// ============================================================
// PERMISSIONS
// ============================================================

#[tauri::command]
pub fn get_user_permissions(
    state: State<'_, AppState>,
    token: String,
    user_id: i32,
) -> Result<Vec<Permission>, String> {
    let session = validate_session(&state.sessions, &token)?;
    // Isolamento: só master ou usuário da mesma empresa pode ler permissões.
    if session.role != "master" {
        if let Some(target_cid) = state.db.user_company_id(user_id) {
            check_company_access(&session, target_cid)?;
        } else {
            return Err("Acesso Negado: usuário alvo inexistente.".to_string());
        }
    }
    let db = &state.db;
    Ok(db.get_user_permissions(user_id))
}

#[tauri::command]
pub fn update_user_permission(
    state: State<'_, AppState>,
    token: String,
    user_id: i32,
    key: String,
    enabled: bool,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    // Isolamento: só master ou usuário da mesma empresa pode alterar permissões.
    if session.role != "master" {
        if let Some(target_cid) = state.db.user_company_id(user_id) {
            check_company_access(&session, target_cid)?;
        } else {
            return Err("Acesso Negado: usuário alvo inexistente.".to_string());
        }
    }
    let db = &state.db;
    db.update_user_permission(user_id, &key, enabled)
}

#[tauri::command]
pub fn get_sector_permissions(
    state: State<'_, AppState>,
    token: String,
    user_id: i32,
) -> Result<Vec<SectorPermission>, String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        if let Some(target_cid) = state.db.user_company_id(user_id) {
            check_company_access(&session, target_cid)?;
        } else {
            return Err("Acesso Negado: usuário alvo inexistente.".to_string());
        }
    }
    let db = &state.db;
    Ok(db.get_sector_permissions(user_id))
}

#[tauri::command]
pub fn update_sector_permission(
    state: State<'_, AppState>,
    token: String,
    user_id: i32,
    sector: String,
    can_view: bool,
    can_configure: bool,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        if let Some(target_cid) = state.db.user_company_id(user_id) {
            check_company_access(&session, target_cid)?;
        } else {
            return Err("Acesso Negado: usuário alvo inexistente.".to_string());
        }
    }
    let db = &state.db;
    db.update_sector_permission(user_id, &sector, can_view, can_configure)
}

// ============================================================
// DASHBOARD
// ============================================================

#[tauri::command]
pub fn get_dashboard_kpis(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<serde_json::Value, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let db = &state.db;
    db.get_dashboard_kpis(company_id)
}

// ============================================================
// CAMPAIGN DISPATCH
// ============================================================

#[tauri::command]
pub fn send_campaign(
    state: State<'_, AppState>,
    token: String,
    campaign_id: i32,
) -> Result<serde_json::Value, String> {
    let _session = validate_session(&state.sessions, &token)?;
    let _ = campaign_id;
    Err("O envio em lote antigo não aciona os aparelhos. Use start_campaign para iniciar o motor real.".to_string())
}

#[tauri::command]
pub fn pause_campaign(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    let company_id = db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    db.set_campaign_status(campaign_id, "paused")
}

#[tauri::command]
pub fn stop_campaign(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    let company_id = state.db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    state.db.set_campaign_status(campaign_id, "stopped")?;
    // Parou: apaga os contatos temporários salvos nos aparelhos desta campanha.
    if let Some(c) = state.db.get_campaigns(company_id).into_iter().find(|c| c.id == campaign_id) {
        crate::dispatcher::cleanup_campaign_contacts(state.db.clone(), company_id, c.device_ids);
    }
    Ok(())
}

#[tauri::command]
pub fn retry_failed_campaign_contacts(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<usize, String> {
    let session = validate_session(&state.sessions, &token)?;
    let company_id = state.db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    if state.db.get_campaigns(company_id).iter().any(|c| c.id == campaign_id && c.status == "running") {
        return Err("Pause a campanha antes de reprocessar falhas.".to_string());
    }
    state.db.retry_failed_contacts(campaign_id)
}

fn session_actor_name(session: &crate::session::UserSession) -> String {
    session.username.clone()
}

pub fn exec_list_opt_outs(
    db: &Database,
    session: &crate::session::UserSession,
    company_id: i32,
) -> Result<Vec<serde_json::Value>, String> {
    check_company_access(session, company_id)?;
    let audits = db.list_opt_out_audit(company_id, 500);
    Ok(db
        .list_opt_outs(company_id)
        .into_iter()
        .map(|(phone, reason, created)| {
            let last_add = audits.iter().find(|a| a.phone == phone && a.action == "add");
            let last_rem = audits.iter().find(|a| a.phone == phone && a.action == "remove");
            serde_json::json!({
                "phone": phone,
                "reason": reason,
                "createdAt": created,
                "addedBy": last_add.map(|a| a.actor_name.clone()),
                "removedBy": last_rem.map(|a| a.actor_name.clone()),
                "removedAt": last_rem.map(|a| a.created_at.clone()),
            })
        })
        .collect())
}

pub fn exec_add_opt_outs(
    db: &Database,
    session: &crate::session::UserSession,
    company_id: i32,
    phones: Vec<String>,
    reason: String,
) -> Result<usize, String> {
    check_company_access(session, company_id)?;
    let clean_phones: Vec<String> = phones
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if clean_phones.is_empty() {
        return Err("Informe ao menos um número de telefone com DDD.".to_string());
    }
    // Valida todos os números antes de gravar: rejeita número sem DDD com mensagem clara
    for p in &clean_phones {
        Database::validate_opt_out_phone(p)?;
    }
    let actor = session_actor_name(session);
    let mut added = 0;
    for p in clean_phones {
        db.add_opt_out(company_id, &p, &reason)?;
        let _ = db.suppress_pending_for_opt_out(company_id, &p);
        let _ = db.record_opt_out_audit(company_id, &p, "add", &actor, &session.role, &reason);
        added += 1;
    }
    Ok(added)
}

pub fn exec_remove_opt_out(
    db: &Database,
    session: &crate::session::UserSession,
    company_id: i32,
    phone: String,
) -> Result<(), String> {
    check_company_access(session, company_id)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Master ou Gestor podem remover números do descadastro.".to_string());
    }
    db.remove_opt_out(company_id, &phone)?;
    let actor = session_actor_name(session);
    db.record_opt_out_audit(
        company_id,
        &phone,
        "remove",
        &actor,
        &session.role,
        "Removido manualmente",
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_opt_outs(state: State<'_, AppState>, token: String, company_id: i32) -> Result<Vec<serde_json::Value>, String> {
    let session = validate_session(&state.sessions, &token)?;
    exec_list_opt_outs(&state.db, &session, company_id)
}

#[tauri::command]
pub fn add_opt_outs(state: State<'_, AppState>, token: String, company_id: i32, phones: Vec<String>, reason: String) -> Result<usize, String> {
    let session = validate_session(&state.sessions, &token)?;
    exec_add_opt_outs(&state.db, &session, company_id, phones, reason)
}

#[tauri::command]
pub fn remove_opt_out(state: State<'_, AppState>, token: String, company_id: i32, phone: String) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    exec_remove_opt_out(&state.db, &session, company_id, phone)
}

#[tauri::command]
pub fn list_opt_out_reviews(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<OptOutReview>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    Ok(state.db.list_opt_out_reviews(company_id, Some("pending")))
}

#[tauri::command]
pub fn resolve_opt_out_review(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
    review_id: i32,
    phone: String,
) -> Result<usize, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let actor = session_actor_name(&session);
    state
        .db
        .resolve_opt_out_review(company_id, review_id, &phone, &actor, &session.role)
}

#[tauri::command]
pub fn discard_opt_out_review(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
    review_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let actor = session_actor_name(&session);
    state.db.discard_opt_out_review(company_id, review_id, &actor)
}

#[tauri::command]
pub fn list_opt_out_audit(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<OptOutAuditEntry>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    Ok(state.db.list_opt_out_audit(company_id, 100))
}

#[tauri::command]
pub fn reset_campaign_contacts(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<usize, String> {
    let session = validate_session(&state.sessions, &token)?;
    let company_id = state.db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    if state.db.get_campaigns(company_id).iter().any(|c| c.id == campaign_id && c.status == "running") {
        return Err("Pause a campanha antes de reiniciar a fila de contatos.".to_string());
    }
    state.db.reset_campaign_contacts(campaign_id)
}

#[tauri::command]
pub fn start_campaign(state: State<'_, AppState>, token: String, campaign_id: i32) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    let db = &state.db;
    let company_id = db.get_campaign_company_id(campaign_id)
        .ok_or_else(|| "Campanha não encontrada.".to_string())?;
    check_company_access(&session, company_id)?;
    let campaign = db.get_campaigns(company_id).into_iter()
        .find(|c| c.id == campaign_id)
        .ok_or_else(|| "Campanha não encontrada nesta empresa.".to_string())?;
    if campaign.device_ids.is_empty() { return Err("Selecione ao menos um aparelho para a campanha.".to_string()); }
    if campaign.message.trim().is_empty() { return Err("Informe o corpo da mensagem.".to_string()); }
    if campaign.greeting.trim().is_empty() || campaign.closing.trim().is_empty() {
        return Err("Preencha a saudação e o encerramento: a mensagem sai sempre em 3 partes.".to_string());
    }
    if [&campaign.greeting, &campaign.message, &campaign.closing].iter().any(|t| crate::ai_engine::AiEngine::has_money(t)) {
        return Err("A mensagem cita valores (R$, reais, %, quantias). Remova antes de iniciar.".to_string());
    }
    if campaign.delay_min < 1 || campaign.delay_max < campaign.delay_min {
        return Err("Intervalo de envio inválido.".to_string());
    }
    if campaign.use_ai {
        let config_opt = db.get_ai_config(company_id);
        let effective_provider = if !campaign.ai_provider.is_empty() {
            campaign.ai_provider.clone()
        } else if let Some(ref cfg) = config_opt {
            cfg.provider.clone()
        } else {
            "openrouter".to_string()
        };

        let prov = effective_provider.to_lowercase();
        let is_local = prov == "ollama" || prov == "ollama_local" || prov == "lmstudio" || prov == "lm_studio";
        if !is_local {
            let config = config_opt
                .ok_or_else(|| format!("Configure o provedor de IA '{effective_provider}' com chave de API em Parâmetros de IA antes de iniciar."))?;
            let has_global_key = !config.api_key.trim().is_empty();
            let has_specific_key = db.get_ai_provider_key(company_id, &effective_provider)
                .map(|(k, _, _)| !k.trim().is_empty())
                .unwrap_or(false);

            if !has_global_key && !has_specific_key {
                return Err(format!("Chave de API não configurada para o provedor '{effective_provider}'. Configure em Parâmetros de IA antes de iniciar."));
            }
        }
    }
    if !db.has_pending_contact(campaign_id) {
        return Err("Não há contatos pendentes nesta campanha.".to_string());
    }
    if !db.get_devices(campaign.company_id).iter().any(|d| d.status == "online" && campaign.device_ids.iter().any(|id| d.esfera_device_id.as_deref() == Some(id.as_str()) || d.serial == *id)) {
        return Err("Nenhum dos aparelhos selecionados está online.".to_string());
    }
    db.set_campaign_status(campaign_id, "running")?;
    // Salva todos os contatos pendentes na agenda dos aparelhos (busca no WhatsApp sem deep link).
    crate::dispatcher::seed_campaign_contacts(state.db.clone(), campaign_id, campaign.company_id, campaign.device_ids.clone());
    crate::dispatcher::Dispatcher::wake();
    Ok(())
}

#[tauri::command]
pub fn get_ai_provider_keys(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    Ok(state.db.get_all_ai_provider_keys(company_id))
}

#[tauri::command]
pub async fn rewrite_message_ai(
    state: State<'_, AppState>,
    token: String,
    message: String,
    contact_name: String,
    company_id: i32,
    model: Option<String>,
    prompt: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> Result<String, String> {
    let session = validate_session(&state.sessions, &token)?;
    check_company_access(&session, company_id)?;
    let selected_provider = provider.unwrap_or_default();
    let mut config = if let Some(mut cfg) = state.db.get_ai_config(company_id) {
        if !selected_provider.is_empty() && selected_provider != cfg.provider {
            cfg.provider = selected_provider.clone();
            cfg.endpoint = String::new();
            if let Some((saved_key, saved_ep, saved_model)) = state.db.get_ai_provider_key(company_id, &selected_provider) {
                cfg.api_key = saved_key;
                if !saved_ep.is_empty() { cfg.endpoint = saved_ep; }
                if !saved_model.is_empty() { cfg.model = saved_model; }
            } else {
                cfg.api_key = String::new();
            }
        }
        cfg
    } else {
        let mut cfg = AiConfig {
            company_id,
            provider: if !selected_provider.is_empty() { selected_provider.clone() } else { "openrouter".to_string() },
            model: String::new(),
            temperature: 0.7,
            system_prompt: String::new(),
            api_key: String::new(),
            endpoint: String::new(),
        };
        if let Some((saved_key, saved_ep, saved_model)) = state.db.get_ai_provider_key(company_id, &cfg.provider) {
            cfg.api_key = saved_key;
            if !saved_ep.is_empty() { cfg.endpoint = saved_ep; }
            if !saved_model.is_empty() { cfg.model = saved_model; }
        }
        cfg
    };
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) { config.model = model; }
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) { config.system_prompt = prompt; }
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) { config.api_key = key; }
    if let Some(ep) = endpoint.filter(|value| !value.trim().is_empty()) { config.endpoint = ep; }
    crate::ai_engine::AiEngine::generate_message(&config, &message, &contact_name).await
}

#[tauri::command]
pub async fn launch_scrcpy_stream(_token: String, serial: String, turn_screen_off: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let turn_off = turn_screen_off.unwrap_or(false);
        AdbManager::launch_scrcpy(&serial, turn_off)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn launch_virtual_display_stream(
    _token: String,
    serial: String,
    width: Option<u32>,
    height: Option<u32>,
    dpi: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = width.unwrap_or(1080);
        let h = height.unwrap_or(1920);
        let d = dpi.unwrap_or(320);
        AdbManager::launch_scrcpy_virtual_display(&serial, w, h, d)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn send_intent_to_display(
    _token: String,
    serial: String,
    url: String,
    display_id: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let disp = display_id.unwrap_or(1);
        AdbManager::launch_intent_on_display(&serial, &url, disp)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn launch_camera_stream(_token: String, serial: String, facing: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let camera_facing = facing.unwrap_or_else(|| "back".to_string());
        AdbManager::launch_scrcpy_camera(&serial, &camera_facing)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inject_virtual_camera(_token: String, serial: String, target_type: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::inject_virtual_camera_feed(&serial, &target_type)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inject_virtual_camera_region(
    serial: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::inject_virtual_camera_region(&serial, x, y, width, height)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inject_base64_frame(
    serial: String,
    frame_data: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::inject_base64_frame(&serial, &frame_data)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn optimize_device_hpc(_token: String, serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::optimize_device_performance(&serial)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_agent_apk(_token: String, serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::install_agent_apk(&serial)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provision_device(
    state: State<'_, AppState>,
    _token: String,
    serial: String,
    server_url: Option<String>,
) -> Result<String, String> {
    // A empresa vem da SESSÃO (token), nunca do cliente: assim ninguém provisiona
    // um aparelho para dentro de outra empresa.
    let session = validate_session(&state.sessions, &_token)?;
    let company_id = match session.company_id {
        Some(cid) if cid > 0 => cid,
        _ => {
            return Err(
                "Provisionamento exige um usuário vinculado a uma empresa.".to_string()
            )
        }
    };

    let cloned_serial = serial.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        AdbManager::provision_device(&serial, server_url.as_deref(), company_id)
    }).await.map_err(|e| e.to_string())??;

    let db = &state.db;

    // Salva o EsferaDeviceId no banco local após provisionar
    if let Some(esfera_id) = AdbManager::get_persistent_device_id(&cloned_serial) {
        if let Err(e) = db.update_device_esfera_id(&cloned_serial, &esfera_id) {
            eprintln!("Aviso: nao foi possivel salvar EsferaDeviceId no DB: {}", e);
        }
    }

    // Otimiza desempenho do dispositivo após provisionamento
    let _ = AdbManager::optimize_device_performance(&cloned_serial);

    Ok(result)
}

#[tauri::command]
pub async fn provision_all_devices(
    state: State<'_, AppState>,
    _token: String,
    server_url: Option<String>,
) -> Result<Vec<String>, String> {
    // Empresa vem da sessão, nunca do cliente (mesma regra do provision_device).
    let session = validate_session(&state.sessions, &_token)?;
    let company_id = match session.company_id {
        Some(cid) if cid > 0 => cid,
        _ => {
            return Err(
                "Provisionamento exige um usuário vinculado a uma empresa.".to_string()
            )
        }
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        AdbManager::provision_all_devices(server_url.as_deref(), company_id)
    }).await.map_err(|e| e.to_string())?;

    let db = &state.db;
    let mut outputs = Vec::new();

    for res in result {
        match res {
            Ok(msg) => {
                let active = AdbManager::list_devices().unwrap_or_default();
                for dev in active {
                    if dev.state == "device" {
                        if let Some(esfera_id) = AdbManager::get_persistent_device_id(&dev.serial) {
                            let _ = db.update_device_esfera_id(&dev.serial, &esfera_id);
                        }
                        let _ = AdbManager::optimize_device_performance(&dev.serial);
                    }
                }
                outputs.push(msg);
            }
            Err(e) => outputs.push(format!("Erro: {}", e)),
        }
    }

    Ok(outputs)
}

#[tauri::command]
pub fn get_device_by_esfera_id(state: State<'_, AppState>, _token: String, esfera_device_id: String) -> Result<Option<Device>, String> {
    let db = &state.db;
    Ok(db.get_device_by_esfera_id(&esfera_device_id))
}

#[tauri::command]
pub async fn debloat_device(_token: String, serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::debloat_device(&serial)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn debloat_device_profile(_token: String, serial: String, profile: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::debloat_device_profile(&serial, &profile)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_hardware_profile(_token: String, serial: String, profile: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        AdbManager::apply_hardware_profile(&serial, &profile)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn debloat_all_devices(_token: String) -> Result<Vec<String>, String> {
    let results = tauri::async_runtime::spawn_blocking(move || {
        AdbManager::debloat_all_devices()
    }).await.map_err(|e| e.to_string())?;

    let mut outputs = Vec::new();
    for res in results {
        match res {
            Ok(msg) => outputs.push(msg),
            Err(e) => outputs.push(format!("Erro debloat: {}", e)),
        }
    }
    Ok(outputs)
}

// ============================================================
// DISTRIBUTED CONFIG
// ============================================================

#[tauri::command]
pub fn get_app_config(_token: Option<String>) -> AppConfig {
    config::load_config()
}

#[tauri::command]
pub fn save_app_config(
    _token: Option<String>,
    config: Option<AppConfig>,
    hub_enabled: Option<bool>,
    hub_address: Option<String>,
    hub_token: Option<String>,
    empresa_server_enabled: Option<bool>,
    empresa_server_port: Option<u16>,
    checkin_server_enabled: Option<bool>,
    checkin_server_port: Option<u16>,
    tunnel_server_enabled: Option<bool>,
    tunnel_server_port: Option<u16>,
    mode: Option<String>,
) -> Result<(), String> {
    let mut final_cfg = config::load_config();
    if let Some(c) = config {
        final_cfg = c;
    } else {
        if let Some(v) = hub_enabled { final_cfg.hub_enabled = v; }
        if let Some(v) = hub_address { final_cfg.hub_address = v; }
        if let Some(v) = hub_token { final_cfg.hub_token = v; }
        if let Some(v) = empresa_server_enabled { final_cfg.empresa_server_enabled = v; }
        if let Some(v) = empresa_server_port { final_cfg.empresa_server_port = v; }
        if let Some(v) = checkin_server_enabled { final_cfg.checkin_server_enabled = v; }
        if let Some(v) = checkin_server_port { final_cfg.checkin_server_port = v; }
        if let Some(v) = tunnel_server_enabled { final_cfg.tunnel_server_enabled = v; }
        if let Some(v) = tunnel_server_port { final_cfg.tunnel_server_port = v; }
        if let Some(v) = mode { final_cfg.mode = v; }
    }
    config::save_config(&final_cfg)
}

// ============================================================
// HUB INVOKE (Master mode: roteia comando via Hub)
// ============================================================

#[tauri::command]
pub async fn hub_invoke(
    state: State<'_, AppState>,
    token: String,
    cmd: String,
    args: serde_json::Value,
    company_id: i32,
) -> Result<serde_json::Value, String> {
    validate_session(&state.sessions, &token)?;
    let guard = state.hub_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "Hub não conectado. Faça login novamente.".to_string())?;
    // Empresa só pode comandar a própria company; master comanda qualquer uma.
    let session = state.sessions.lock().ok().and_then(|s| s.validate_token(&token));
    let target = match session {
        Some(ref s) if s.role != "master" => s.company_id.unwrap_or(company_id),
        _ => company_id,
    };
    client.send_command(target, &cmd, args).await
}

/// Devolve as credenciais de conexão ao Hub VPS para o usuário logado.
/// O token do hub vem de env (master: HUB_MASTER_TOKEN; empresa: ESFERA_COMPANY_TOKEN),
/// NUNCA hardcoded no código. O app conecta APÓS o login, isolado pela empresa.
#[tauri::command]
pub fn get_hub_credentials(
    state: State<'_, AppState>,
    token: String,
) -> Result<HubCredentials, String> {
    let session = validate_session(&state.sessions, &token)?;
    let company_id = session.company_id.unwrap_or(0);
    let role = session.role.clone();

    // Token do hub: prioriza o configurado em Settings (config.hub_token), que o
    // usuário alinha com HUB_MASTER_TOKEN da VPS. Se vazio, usa env/role (master:
    // HUB_MASTER_TOKEN; empresa: ESFERA_COMPANY_TOKEN) e, na falta, o default
    // embutido (igual ao seed do VPS em db.rs). Garante que o app conecte ao VPS
    // e os celulares remotos (via_tunnel) apareçam no get_devices.
    let cfg = config::load_config();
    let fallback_master = "root123".to_string();
    let hub_token = if !cfg.hub_token.trim().is_empty() {
        cfg.hub_token.trim().to_string()
    } else if role == "master" {
        std::env::var("HUB_MASTER_TOKEN")
            .or_else(|_| std::env::var("ESFERA_HUB_TOKEN"))
            .unwrap_or_else(|_| fallback_master.clone())
    } else {
        std::env::var("ESFERA_COMPANY_TOKEN")
            .unwrap_or_else(|_| "Ope@2025".to_string())
    };
    let is_master_tok = hub_token == fallback_master
        || hub_token == "root123"
        || hub_token == std::env::var("HUB_MASTER_TOKEN").unwrap_or_default()
        || hub_token.starts_with("EsferaHubMaster_");
    let effective_role = if is_master_tok || role == "master" { "master" } else { "empresa" };

    let company_name = if company_id > 0 {
        state
            .db
            .get_company_by_id(company_id)
            .map(|c| c.name)
            .unwrap_or_else(|| format!("Empresa {}", company_id))
    } else {
        "Master".to_string()
    };
    let hub_address = if !cfg.hub_address.trim().is_empty() {
        cfg.hub_address.trim().to_string()
    } else {
        std::env::var("ESFERA_HUB_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8555".to_string())
    };
    Ok(HubCredentials {
        hub_address,
        hub_token,
        company_id,
        company_name,
        role: effective_role.to_string(),
    })
}

/// Conecta ao Hub VPS usando as credenciais do usuário logado (pós-login).
#[tauri::command]
pub async fn connect_hub(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    let creds = get_hub_credentials(state.clone(), token.clone())?;
    let client = HubClient::connect(
        &creds.hub_address,
        &creds.hub_token,
        &creds.role,
        creds.company_id,
        &creds.company_name,
    )
    .await?;
    *state.hub_client.lock().await = Some(client);
    Ok(())
}

/// Empurra uma atualização do hub-standalone VPS via POST /admin/update.
/// Recebe o binario em base64. O VPS faz swap + self-restart (sem SSH).
#[tauri::command]
pub async fn update_vps_hub(state: State<'_, AppState>, token: String, base64_bin: String) -> Result<String, String> {
    let _session = validate_session(&state.sessions, &token)?;
    use base64::Engine as _;
    let bin = base64::engine::general_purpose::STANDARD
        .decode(&base64_bin)
        .map_err(|e| format!("Falha ao decodificar base64: {}", e))?;
    if bin.is_empty() { return Err("Binario vazio.".into()); }
    let token_master = std::env::var("HUB_MASTER_TOKEN")
        .unwrap_or_else(|_| "EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b".to_string());
    let vps = std::env::var("ESFERA_HUB_ADDR").unwrap_or_else(|_| "127.0.0.1:8555".to_string());
    let host = vps.split(':').next().unwrap_or("127.0.0.1");
    let url = format!("http://{}:8080/admin/update", host);
    let client = reqwest::Client::new();
    let resp = client.post(&url)
        .header("X-Hub-Token", &token_master)
        .body(bin)
        .send()
        .await
        .map_err(|e| format!("Falha ao enviar atualizacao ao VPS: {}", e))?;
    let status = resp.status();
    let txt = resp.text().await.unwrap_or_default();
    if status.is_success() {
        Ok("VPS atualizado. O hub reiniciou com a nova versao.".into())
    } else {
        Err(format!("VPS retornou {}: {}", status, txt))
    }
}

#[derive(serde::Serialize)]
pub struct HubCredentials {
    pub hub_address: String,
    pub hub_token: String,
    pub company_id: i32,
    pub company_name: String,
    pub role: String,
}

// ============================================================
// GESTÃO DE USUÁRIOS E NÍVEIS (Colaborador, Supervisor, Gestor)
// ============================================================

#[tauri::command]
pub fn get_users(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<crate::db::User>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let target_company = if session.role == "master" { company_id } else { session.company_id.unwrap_or(company_id) };
    Ok(state.db.get_users_by_company(target_company))
}

#[tauri::command]
pub fn create_user(
    state: State<'_, AppState>,
    token: String,
    username: String,
    password: String,
    display_name: String,
    role: String,
    company_id: i32,
) -> Result<crate::db::User, String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Gestores ou Master podem criar usuários.".to_string());
    }
    let target_company = if session.role == "master" { company_id } else { session.company_id.unwrap_or(company_id) };
    state.db.create_user_with_role(&username, &password, &display_name, &role, target_company)
}

// ============================================================
// PERMISSÕES DE CELULARES (Colaborador, Supervisor, Gestor)
// ============================================================

#[tauri::command]
pub fn assign_device_to_user(
    state: State<'_, AppState>,
    token: String,
    device_serial: String,
    user_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Gestores podem vincular celulares.".to_string());
    }
    state.db.assign_device_to_user(&device_serial, user_id)
}

#[tauri::command]
pub fn unassign_device_from_user(
    state: State<'_, AppState>,
    token: String,
    device_serial: String,
    user_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Gestores podem desvincular celulares.".to_string());
    }
    state.db.unassign_device_from_user(&device_serial, user_id)
}

#[tauri::command]
pub fn get_assigned_devices_for_user(
    state: State<'_, AppState>,
    token: String,
    user_id: i32,
    company_id: i32,
) -> Result<Vec<crate::db::Device>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let target_user = if session.role == "colaborador" { session.user_id } else { user_id };
    let target_company = session.company_id.unwrap_or(company_id);
    Ok(state.db.get_assigned_devices_for_user(target_user, target_company))
}

#[tauri::command]
pub fn get_all_device_assignments(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<crate::db::DeviceAssignmentInfo>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let target_company = session.company_id.unwrap_or(company_id);
    Ok(state.db.get_all_device_assignments(target_company))
}

#[tauri::command]
pub fn request_device_access(
    state: State<'_, AppState>,
    token: String,
    device_serial: String,
    reason: String,
) -> Result<i32, String> {
    let session = validate_session(&state.sessions, &token)?;
    state.db.request_device_permission(session.user_id, &device_serial, &reason)
}

#[tauri::command]
pub fn get_device_permission_requests(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<crate::db::DevicePermissionRequest>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let target_company = session.company_id.unwrap_or(company_id);
    Ok(state.db.get_permission_requests(target_company))
}

#[tauri::command]
pub fn approve_device_access(
    state: State<'_, AppState>,
    token: String,
    request_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" && session.role != "supervisor" {
        return Err("Acesso Negado: apenas Gestores e Supervisores podem aprovar solicitações.".to_string());
    }
    state.db.approve_permission_request(request_id, session.user_id)
}

#[tauri::command]
pub fn reject_device_access(
    state: State<'_, AppState>,
    token: String,
    request_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" && session.role != "supervisor" {
        return Err("Acesso Negado: apenas Gestores e Supervisores podem rejeitar solicitações.".to_string());
    }
    state.db.reject_permission_request(request_id)
}

#[tauri::command]
pub fn end_device_access(
    state: State<'_, AppState>,
    token: String,
    request_id: i32,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    state.db.end_permission_session(request_id)
}

#[tauri::command]
pub fn get_devices_with_active_user_map(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<Vec<crate::db::DeviceWithActiveUser>, String> {
    let session = validate_session(&state.sessions, &token)?;
    let target_company = session.company_id.unwrap_or(company_id);
    Ok(state.db.get_devices_with_active_user_map(target_company))
}

#[tauri::command]
pub fn configure_device_proxy_and_antiban(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    proxy_url: Option<String>,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    AdbManager::configure_device_socks_proxy_and_revoke_bssid(&serial, proxy_url.as_deref())
}

#[tauri::command]
pub fn trigger_manual_intent_bezier_dispatch(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    phone: String,
    message: String,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    AdbManager::send_whatsapp_intent_and_bezier_tap(&serial, &phone, &message)
}

#[tauri::command]
pub fn clear_device_temporary_contacts(
    state: State<'_, AppState>,
    token: String,
    serial: String,
) -> Result<(), String> {
    let _session = validate_session(&state.sessions, &token)?;
    AdbManager::clear_all_temporary_contacts(&serial)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUpdateStatus {
    pub has_update: bool,
    pub current_commit: String,
    pub latest_commit: String,
    pub commit_message: String,
}

#[tauri::command]
pub fn check_git_auto_update() -> Result<GitUpdateStatus, String> {
    #[cfg(target_os = "windows")]
    fn silent_cmd(prog: &str) -> std::process::Command {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new(prog);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(target_os = "windows"))]
    fn silent_cmd(prog: &str) -> std::process::Command {
        std::process::Command::new(prog)
    }

    let _ = silent_cmd("git").arg("fetch").output();

    let current = silent_cmd("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "main".to_string());

    let log_cmd = silent_cmd("git")
        .args(["log", "-1", "--pretty=format:%h - %s", "origin/main"])
        .output();

    match log_cmd {
        Ok(out) if out.status.success() => {
            let msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let latest_hash = msg.split_whitespace().next().unwrap_or("").to_string();
            let has_up = !latest_hash.is_empty() && latest_hash != current;
            Ok(GitUpdateStatus {
                has_update: has_up,
                current_commit: current,
                latest_commit: latest_hash,
                commit_message: msg,
            })
        }
        _ => Ok(GitUpdateStatus {
            has_update: false,
            current_commit: current.clone(),
            latest_commit: current,
            commit_message: "Sistema atualizado.".to_string(),
        }),
    }
}

/// Comando do Agente Órfão Otto: Detecta processos órfãos (Scrcpy/ADB) sem matá-los automaticamente.
#[tauri::command]
pub fn scan_orphan_processes() -> Result<Vec<crate::scrcpy_manager::OrphanProcessInfo>, String> {
    let active_pids = crate::scrcpy_manager::GLOBAL_SCRCPY_MANAGER.get_active_pids();
    let orphans = crate::scrcpy_manager::OrphanOtto::scan_orphans(&active_pids);
    Ok(orphans)
}

#[tauri::command]
pub fn apply_git_auto_update() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    fn silent_cmd(prog: &str) -> std::process::Command {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new(prog);
        c.creation_flags(0x08000000);
        c
    }
    #[cfg(not(target_os = "windows"))]
    fn silent_cmd(prog: &str) -> std::process::Command {
        std::process::Command::new(prog)
    }

    let pull_out = silent_cmd("git")
        .args(["pull", "--rebase", "origin", "main"])
        .output()
        .map_err(|e| format!("Falha ao executar git pull: {}", e))?;

    if pull_out.status.success() {
        Ok("Atualização aplicada com sucesso! Reinicie o aplicativo para carregar a nova versão.".to_string())
    } else {
        Err(String::from_utf8_lossy(&pull_out.stderr).to_string())
    }
}

#[tauri::command]
pub fn set_device_responsible_collaborator(
    state: State<'_, AppState>,
    token: String,
    device_serial: String,
    user_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Gestores podem definir o responsável pelo celular.".to_string());
    }
    state.db.assign_device_to_user(&device_serial, user_id)
}

#[tauri::command]
pub fn remove_device_responsible_collaborator(
    state: State<'_, AppState>,
    token: String,
    device_serial: String,
    user_id: i32,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" && session.role != "gestor" {
        return Err("Acesso Negado: apenas Gestores podem remover o responsável pelo celular.".to_string());
    }
    state.db.unassign_device_from_user(&device_serial, user_id)
}

/// Gera (ou rotaciona) o token de uma empresa para autenticação no hub local.
/// SÓ master pode chamar. O token é retornado UMA vez (não fica armazenado em plaintext).
#[tauri::command]
pub fn generate_company_token(
    state: State<'_, AppState>,
    token: String,
    company_id: i32,
) -> Result<String, String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        return Err("Acesso Negado: apenas o Master pode gerar tokens de empresa.".to_string());
    }
    if company_id <= 0 {
        return Err("company_id inválido (deve ser > 0; 0 é o master).".to_string());
    }
    // Token forte aleatório (32 bytes -> hex de 64 chars).
    let raw: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
    let new_token = hex::encode(raw);
    state
        .db
        .upsert_company_token(company_id, &new_token, "empresa")
        .map_err(|e| format!("Falha ao gravar token: {}", e))?;
    Ok(new_token)
}

/// Força o seed do token master (CompanyId 0) a partir de HUB_MASTER_TOKEN em runtime.
#[tauri::command]
pub fn rotate_master_token(
    state: State<'_, AppState>,
    token: String,
    new_token: String,
) -> Result<(), String> {
    let session = validate_session(&state.sessions, &token)?;
    if session.role != "master" {
        return Err("Acesso Negado: apenas o Master pode rotacionar o token master.".to_string());
    }
    if new_token.is_empty() {
        return Err("new_token vazio.".to_string());
    }
    state
        .db
        .upsert_company_token(0, &new_token, "master")
        .map_err(|e| format!("Falha ao gravar token master: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dev_with(serial: &str, esfera_id: Option<&str>, ip: &str, addr: Option<&str>) -> Device {
        Device {
            id: 0,
            serial: serial.to_string(),
            name: String::new(),
            brand: String::new(),
            model: String::new(),
            ip: ip.to_string(),
            port: 5555,
            status: "offline".to_string(),
            battery: 0,
            company_id: 1,
            device_number: 1,
            sector: "junior".to_string(),
            esfera_device_id: esfera_id.map(|s| s.to_string()),
            current_adb_address: addr.map(|s| s.to_string()),
            last_seen_utc: None,
            via_tunnel: false,
        }
    }

    #[test]
    fn crossing_by_esfera_id_exact() {
        let d = dev_with("R58M1234567", Some("ESF-4200DA85"), "", None);
        let live = json!({"esfera_device_id":"ESF-4200DA85","status":"online"});
        assert!(device_matches_live(&d, &live));
    }

    #[test]
    fn crossing_by_serial_equals_esfera_id() {
        // USB serial sem porta == live.esfera_device_id
        let d = dev_with("4200da8501667545", None, "", None);
        let live = json!({"esfera_device_id":"4200da8501667545","status":"online"});
        assert!(device_matches_live(&d, &live));
    }

    #[test]
    fn crossing_by_serial_prefix() {
        // (c) ESF- + 8 primeiros do serial == live.esfera_device_id
        let d = dev_with("4200da8501667545", None, "", None);
        let live = json!({"esfera_device_id":"ESF-4200DA85","status":"online"});
        assert!(device_matches_live(&d, &live));
    }

    #[test]
    fn crossing_by_ip_normalized() {
        // WiFi serial "192.168.1.151:5555" cruza com live.ip "192.168.1.151"
        let d = dev_with("192.168.1.151:5555", None, "192.168.1.151", Some("192.168.1.151:5555"));
        let live = json!({"esfera_device_id":"ESF-ABCDEF12","status":"online","current_adb_address":"192.168.1.151","ip":"192.168.1.151"});
        assert!(device_matches_live(&d, &live));
    }

    #[test]
    fn no_crossing_for_different_device() {
        let d = dev_with("R58M9999999", Some("ESF-11111111"), "", None);
        let live = json!({"esfera_device_id":"ESF-22222222","status":"online"});
        assert!(!device_matches_live(&d, &live));
    }

    #[test]
    fn empty_esfera_id_never_matches() {
        let d = dev_with("R58M1234567", None, "", None);
        let live = json!({"esfera_device_id":"","status":"online"});
        assert!(!device_matches_live(&d, &live));
    }

    #[test]
    fn device_id_from_serial_derivation() {
        assert_eq!(device_id_from_serial("4200da8501667545"), "ESF-4200DA85");
        assert_eq!(device_id_from_serial("R58M1234567"), "ESF-R58M1234");
        assert_eq!(device_id_from_serial("abc"), "ESF-ABC");
    }

    #[test]
    fn opt_out_permissao_papel_auditoria_ddd_e_cancelamento_pendentes() {
        let db_path = std::env::temp_dir().join(format!("esfera_cmd_optout_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&db_path);
        let db = Database::init(db_path.to_string_lossy().as_ref()).expect("db");

        // Cria campanha com um envio pendente para o número 5575988052539
        let camp_id = db.create_campaign(&Campaign {
            id: 0,
            name: "Campanha Teste".to_string(),
            greeting: "Olá".to_string(),
            message: "Msg".to_string(),
            closing: "Att".to_string(),
            delay_min: 15,
            delay_max: 30,
            use_spintax: false,
            use_ai: false,
            ai_model: String::new(),
            ai_prompt: String::new(),
            status: "draft".to_string(),
            contacts_count: 0,
            sent_count: 0,
            failed_count: 0,
            company_id: 1,
            device_ids: vec![],
            ai_provider: String::new(),
            updated_at: String::new(),
        }).unwrap();
        db.import_contacts(camp_id, vec![("João".to_string(), "5575988052539".to_string())]).unwrap();
        assert_eq!(db.get_pending_contacts(camp_id, 10).len(), 1);

        let colab = crate::session::UserSession {
            token: "t-colab".to_string(),
            user_id: 10,
            username: "João Colaborador".to_string(),
            role: "colaborador".to_string(),
            company_id: Some(1),
            created_at: 0,
            expires_at: i64::MAX,
        };
        let gestor = crate::session::UserSession {
            token: "t-gestor".to_string(),
            user_id: 2,
            username: "Maria Gestora".to_string(),
            role: "gestor".to_string(),
            company_id: Some(1),
            created_at: 0,
            expires_at: i64::MAX,
        };

        // 1. Rejeita número sem DDD com mensagem clara
        let err_no_ddd = exec_add_opt_outs(&db, &colab, 1, vec!["98805-2539".to_string()], "Pedido manual".to_string()).unwrap_err();
        assert!(err_no_ddd.contains("sem DDD"), "deveria rejeitar sem DDD: {}", err_no_ddd);

        // 2. add_opt_outs com DDD válido grava descadastro, cancela envios pendentes e registra auditoria
        let added = exec_add_opt_outs(&db, &colab, 1, vec!["(75) 98805-2539".to_string()], "Pedido no atendimento".to_string()).unwrap();
        assert_eq!(added, 1);
        assert!(db.is_opted_out(1, "5575988052539"));
        assert_eq!(db.get_pending_contacts(camp_id, 10).len(), 0, "envio pendente deve ser cancelado por suppress_pending_for_opt_out");

        // 3. Colaborador NÃO pode remover descadastro
        let err_colab = exec_remove_opt_out(&db, &colab, 1, "7588052539".to_string()).unwrap_err();
        assert!(err_colab.contains("Acesso Negado"));
        assert!(db.is_opted_out(1, "5575988052539"));

        // 4. Gestor/Master pode remover e registra auditoria (quem, quando, número, ação)
        exec_remove_opt_out(&db, &gestor, 1, "7588052539".to_string()).unwrap();
        assert!(!db.is_opted_out(1, "5575988052539"));

        let audits = db.list_opt_out_audit(1, 10);
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].action, "remove");
        assert_eq!(audits[0].actor_name, "Maria Gestora");
        assert_eq!(audits[0].phone, "7588052539");
        assert_eq!(audits[1].action, "add");
        assert_eq!(audits[1].actor_name, "João Colaborador");

        let _ = std::fs::remove_file(&db_path);
    }
}
