// ============================================================
// Esfera v3 — Gerenciador de Sessão e Máquina de Estados (session_manager.rs)
// Desacopla a Presença (WebSocket) da Execução (Túnel ADB).
// ============================================================

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceStatus {
    Online,   // WebSocket OK + Túnel ADB OK
    Degraded, // WebSocket OK + Túnel ADB indisponível
    Offline,  // WebSocket Desconectado ou Timeout de Heartbeat
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSession {
    pub uuid: String,
    pub ip: String,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
    pub status: DeviceStatus,
    pub ws_connected: bool,
    pub adb_tunnel_connected: bool,
    pub last_heartbeat: String,
    #[serde(skip)]
    pub last_heartbeat_instant: Option<Instant>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, DeviceSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn update_presence(
    uuid: &str,
    ip: &str,
    battery: u8,
    charging: bool,
    screen_on: bool,
) {
    let mut map = SESSIONS.lock().unwrap();
    let now_str = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(uuid.to_string()).or_insert_with(|| DeviceSession {
        uuid: uuid.to_string(),
        ip: ip.to_string(),
        battery_level: battery,
        is_charging: charging,
        is_screen_on: screen_on,
        status: DeviceStatus::Degraded, // inicia como Degraded até o túnel ADB abrir
        ws_connected: true,
        adb_tunnel_connected: false,
        last_heartbeat: now_str.clone(),
        last_heartbeat_instant: Some(Instant::now()),
    });

    entry.ip = ip.to_string();
    entry.battery_level = battery;
    entry.is_charging = charging;
    entry.is_screen_on = screen_on;
    entry.ws_connected = true;
    entry.last_heartbeat = now_str;
    entry.last_heartbeat_instant = Some(Instant::now());

    recalculate_status(entry);
}

pub fn update_adb_tunnel_status(uuid: &str, connected: bool) {
    let mut map = SESSIONS.lock().unwrap();
    if let Some(entry) = map.get_mut(uuid) {
        entry.adb_tunnel_connected = connected;
        recalculate_status(entry);
    }
}

pub fn disconnect_presence(uuid: &str) {
    let mut map = SESSIONS.lock().unwrap();
    if let Some(entry) = map.get_mut(uuid) {
        entry.ws_connected = false;
        recalculate_status(entry);
    }
}

fn recalculate_status(entry: &mut DeviceSession) {
    entry.status = match (entry.ws_connected, entry.adb_tunnel_connected) {
        (true, true) => DeviceStatus::Online,
        (true, false) => DeviceStatus::Online,
        (false, true) => DeviceStatus::Online,
        (false, false) => DeviceStatus::Offline,
    };
}

/// Varredura periódica para marcar como Offline dispositivos cujo WebSocket silenciou por > 30s.
pub fn sweep_stale_sessions() {
    let mut map = SESSIONS.lock().unwrap();
    let now = Instant::now();
    for entry in map.values_mut() {
        if entry.ws_connected {
            if let Some(last) = entry.last_heartbeat_instant {
                if now.duration_since(last) > Duration::from_secs(30) {
                    entry.ws_connected = false;
                    recalculate_status(entry);
                }
            }
        }
    }
}

pub fn get_all_sessions() -> Vec<DeviceSession> {
    sweep_stale_sessions();
    SESSIONS.lock().unwrap().values().cloned().collect()
}

pub fn get_session(uuid: &str) -> Option<DeviceSession> {
    SESSIONS.lock().unwrap().get(uuid).cloned()
}
