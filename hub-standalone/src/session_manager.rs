// ============================================================
// Esfera v3 — Hub Standalone — Gerenciador de Sessão e Identidade
// (session_manager.rs)
//
// FONTE DE VERDADE DA PRESENÇA E DO TÚNEL NO VPS.
//
// Modelo de identidade (persistente, NUNCA derivada de IP/socket/ADB):
//   COMPANY_ID  -> isolamento obrigatório (Empresa A não vê Empresa B)
//   DEVICE_ID   -> identidade lógica estável do aparelho (ex: ESF-<uuid>)
//   AGENT_ID    -> "rust" (túnel ADB reverso) | "kotlin" (check-in/presença)
//   SESSION_ID  -> UUID por conexão; recriado a cada reconexão
//   LAST_SEEN   -> UTC do último heartbeat válido
//   STATUS      -> online | degraded | offline
//
// REGRA DE CONCORRÊNCIA (objetivo 6):
//   Cada (company_id, device_id) tem EXATAMENTE UM DeviceState.
//   Os dois agentes ocupam CANAIS DISTINTOS e EXCLUSIVOS:
//     - túnel  (rust)  -> session.tunnel
//     - presença(kotlin)-> session.presence
//   Eles NUNCA disputam a mesma sessão/porta/identidade.
//   Reconectar gera novo SESSION_ID, mantém DEVICE_ID+COMPANY_ID.
//   Desconectar B só mexe em B.
// ============================================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Serialize, Deserialize};

/// Chave de roteamento: identidade persistente, NUNCA IP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DeviceKey {
    pub company_id: i32,
    pub device_id: i32, // surrogate id no DB da empresa (ou hash do esfera_device_id)
}

/// Identidade lógica do aparelho (independente de conexão).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub company_id: i32,
    pub esfera_device_id: String, // ex: ESF-xxxx (DEVICE_ID persistente)
    pub device_key: DeviceKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionStatus {
    Online,   // túnel + presença OK
    Degraded, // apenas um dos canais OK
    Offline,  // nenhum canal ativo
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSession {
    pub session_id: String, // recriado a cada reconexão
    pub agent_id: String,   // "rust" | "kotlin"
    pub connected_at: String,
    pub last_heartbeat: String,
    #[serde(skip)]
    pub last_heartbeat_instant: Option<Instant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceState {
    pub key: DeviceKey,
    pub esfera_device_id: String,
    pub company_id: i32,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
    pub status: ConnectionStatus,
    pub tunnel: Option<ChannelSession>,   // EXCLUSIVO do agente rust
    pub presence: Option<ChannelSession>, // EXCLUSIVO do agente kotlin
    pub last_seen_utc: String,
}

impl DeviceState {
    fn recalc(&mut self) {
        self.status = match (self.tunnel.is_some(), self.presence.is_some()) {
            (true, true) => ConnectionStatus::Online,
            (true, false) | (false, true) => ConnectionStatus::Degraded,
            (false, false) => ConnectionStatus::Offline,
        };
    }
}

// Mapa global indexado por (company_id, device_id). Ponto único de verdade.
static STATES: LazyLock<Mutex<HashMap<DeviceKey, DeviceState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

use std::sync::LazyLock;

/// Resolve (ou cria) o DeviceKey a partir do esfera_device_id + company_id.
/// O device_id (surrogate) é derivado de forma estável (hash) para não dependermos
/// do DB aqui; o roteamento de comandos usa company_id + esfera_device_id.
fn derive_device_key(company_id: i32, esfera_device_id: &str) -> DeviceKey {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in format!("{}|{}", company_id, esfera_device_id.to_lowercase()).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    DeviceKey { company_id, device_id: (h >> 32) as i32 }
}

fn new_session(agent_id: &str) -> ChannelSession {
    let now = chrono::Utc::now();
    ChannelSession {
        session_id: uuid::Uuid::new_v4().to_string(),
        agent_id: agent_id.to_string(),
        connected_at: now.to_rfc3339(),
        last_heartbeat: now.to_rfc3339(),
        last_heartbeat_instant: Some(Instant::now()),
    }
}

// ---- API PÚBLICA ----

/// Canal TÚNEL (agente rust). Substitui a sessão de túnel do device; não toca presença.
pub fn open_tunnel(company_id: i32, esfera_device_id: &str) -> String {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(key).or_insert_with(|| DeviceState {
        key,
        esfera_device_id: esfera_device_id.to_string(),
        company_id,
        battery_level: 0,
        is_charging: false,
        is_screen_on: false,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
    });
    entry.esfera_device_id = esfera_device_id.to_string();
    entry.company_id = company_id;
    entry.tunnel = Some(new_session("rust"));
    entry.last_seen_utc = now;
    entry.recalc();
    entry.tunnel.as_ref().unwrap().session_id.clone()
}

/// Canal PRESENÇA (agente kotlin). Substitui a sessão de presença; não toca túnel.
pub fn open_presence(
    company_id: i32,
    esfera_device_id: &str,
    battery: u8,
    charging: bool,
    screen_on: bool,
) -> String {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(key).or_insert_with(|| DeviceState {
        key,
        esfera_device_id: esfera_device_id.to_string(),
        company_id,
        battery_level: battery,
        is_charging: charging,
        is_screen_on: screen_on,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
    });
    entry.esfera_device_id = esfera_device_id.to_string();
    entry.company_id = company_id;
    entry.battery_level = battery;
    entry.is_charging = charging;
    entry.is_screen_on = screen_on;
    entry.presence = Some(new_session("kotlin"));
    entry.last_seen_utc = now;
    entry.recalc();
    entry.presence.as_ref().unwrap().session_id.clone()
}

/// Heartbeat de presença (kotlin) — atualiza telemetria e renova last_heartbeat.
pub fn heartbeat_presence(
    company_id: i32,
    esfera_device_id: &str,
    battery: u8,
    charging: bool,
    screen_on: bool,
) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        let now = chrono::Utc::now().to_rfc3339();
        entry.battery_level = battery;
        entry.is_charging = charging;
        entry.is_screen_on = screen_on;
        if let Some(p) = entry.presence.as_mut() {
            p.last_heartbeat = now.clone();
            p.last_heartbeat_instant = Some(Instant::now());
        }
        entry.last_seen_utc = now;
        entry.recalc();
    }
}

/// Garante que o device tenha uma sessão de PRESENÇA (kotlin) ativa no VPS,
/// sem sobrescrever telemetria (bateria/carga/tela) que já exista. Usado pelo
/// check-in HTTP (que o agente Kotlin chama em loop) para que o device SURJA
/// no get_live_devices mesmo quando o WS de presença não está conectado.
/// Sem isso, o check-in só gravava o DB e o session_manager ficava vazio ->
/// app mostrava os celulares como "connecting" (amarelo) eternamente.
pub fn touch_presence(company_id: i32, esfera_device_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(key).or_insert_with(|| DeviceState {
        key,
        esfera_device_id: esfera_device_id.to_string(),
        company_id,
        battery_level: 0,
        is_charging: false,
        is_screen_on: false,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
    });
    entry.esfera_device_id = esfera_device_id.to_string();
    entry.company_id = company_id;
    // Preserva telemetria existente; só cria a sessão de presença se ausente.
    if entry.presence.is_none() {
        entry.presence = Some(new_session("kotlin"));
    } else if let Some(p) = entry.presence.as_mut() {
        p.last_heartbeat = now.clone();
        p.last_heartbeat_instant = Some(Instant::now());
    }
    entry.last_seen_utc = now;
    entry.recalc();
}

/// Heartbeat de túnel (rust) — renovado pelo loop ping/pong do tunnel_server.
pub fn heartbeat_tunnel(company_id: i32, esfera_device_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        let now = chrono::Utc::now().to_rfc3339();
        if let Some(t) = entry.tunnel.as_mut() {
            t.last_heartbeat = now.clone();
            t.last_heartbeat_instant = Some(Instant::now());
        }
        entry.last_seen_utc = now;
        entry.recalc();
    }
}

/// Fecha apenas o canal TÚNEL (agente rust desconectou). Presença intocada.
pub fn close_tunnel(company_id: i32, esfera_device_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        entry.tunnel = None;
        entry.recalc();
    }
}

/// Fecha apenas o canal PRESENÇA (agente kotlin desconectou). Túnel intocado.
pub fn close_presence(company_id: i32, esfera_device_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        entry.presence = None;
        entry.recalc();
    }
}

/// Varredura: marca Offline canais que silenciaram > timeout.
/// Canal túnel: gracefully 45s. Canal presença: 2x heartbeat (10s) -> 30s.
pub fn sweep_stale(grace_tunnel_secs: u64, grace_presence_secs: u64) {
    let mut map = STATES.lock().unwrap();
    let now = Instant::now();
    for entry in map.values_mut() {
        if let Some(t) = entry.tunnel.as_ref() {
            if let Some(last) = t.last_heartbeat_instant {
                if now.duration_since(last) > Duration::from_secs(grace_tunnel_secs) {
                    entry.tunnel = None;
                }
            }
        }
        if let Some(p) = entry.presence.as_ref() {
            if let Some(last) = p.last_heartbeat_instant {
                if now.duration_since(last) > Duration::from_secs(grace_presence_secs) {
                    entry.presence = None;
                }
            }
        }
        entry.recalc();
    }
}

/// Consulta de estado (usado por testes e pelo roteamento do master).
pub fn get_state(company_id: i32, esfera_device_id: &str) -> Option<DeviceState> {
    let key = derive_device_key(company_id, esfera_device_id);
    STATES.lock().unwrap().get(&key).cloned()
}

/// Lista dispositivos de UMA empresa (isolamento estrito por company_id).
pub fn list_by_company(company_id: i32) -> Vec<DeviceState> {
    STATES
        .lock()
        .unwrap()
        .values()
        .filter(|s| s.company_id == company_id)
        .cloned()
        .collect()
}

/// Lista TODOS (apenas para o master/diagnóstico).
pub fn list_all() -> Vec<DeviceState> {
    STATES.lock().unwrap().values().cloned().collect()
}

/// Remove completamente um device do estado em RAM (usado em testes de isolamento).
pub fn forget(company_id: i32, esfera_device_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    STATES.lock().unwrap().remove(&key);
}

impl ConnectionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectionStatus::Online => "online",
            ConnectionStatus::Degraded => "degraded",
            ConnectionStatus::Offline => "offline",
        }
    }
}

/// Projeta o estado vivo (RAM) para o formato persistível do DB.
/// É o ÚNICO ponto de tradução RAM -> banco; evita duas fontes de verdade.
pub fn live_snapshot() -> Vec<crate::db::LiveDeviceState> {
    STATES
        .lock()
        .unwrap()
        .values()
        .map(|s| crate::db::LiveDeviceState {
            company_id: s.company_id,
            esfera_device_id: s.esfera_device_id.clone(),
            status: s.status.as_str().to_string(),
            battery_level: s.battery_level,
            last_seen_utc: s.last_seen_utc.clone(),
        })
        .collect()
}
