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
//
// CRUZAMENTO POR IP (fix do status AMARELO no app desktop):
//   O `current_adb_address` (ip:porta) e `ip` são reportados pelo agente Kotlin
//   no check-in HTTP (:8080). Eles são projetados em `live_snapshot()` para que o
//   `get_live_devices` da VPS devolva o endereço do celular. O app desktop então
//   consegue cruzar o cartão ADB local (serial 192.168.1.83:5555) com o gêmeo VPS
//   por IP e marcar o dispositivo como "online" (verde) em vez de "connecting"
//   (amarelo) eternamente. Sem esses campos, o cartão local ficava órfão.
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
#[serde(rename_all = "lowercase")]
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
    // Identidade de rede do aparelho (precisa bater com o cartão local do ADB
    // no desktop, que usa ip:porta ou serial). Sem isso, o cruzamento por IP
    // no app desktop falha e o celular fica "connecting" (amarelo) eternamente.
    pub ip: String,
    pub current_adb_address: String,
    pub battery_level: u8,
    pub is_charging: bool,
    pub is_screen_on: bool,
    pub status: ConnectionStatus,
    pub tunnel: Option<ChannelSession>,   // EXCLUSIVO do agente rust
    pub presence: Option<ChannelSession>, // EXCLUSIVO do agente kotlin
    pub last_seen_utc: String,
    // Rastreia o último check-in HTTP (touch_presence) como Instant para que
    // recently_active_90s() considere dispositivos que fazem check-in via HTTP
    // mesmo quando não há sessão WS/túnel ativa.
    #[serde(skip)]
    pub last_touch_instant: Option<Instant>,
    /// Porta lógica atribuída na VPS para este dispositivo (router de porta lógica)
    pub assigned_vps_port: u16,
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

/// Remove a porta de um endereço (ex: "192.168.1.5:5555" -> "192.168.1.5").
fn strip_port(s: &str) -> String {
    s.rsplit_once(':').map(|(ip, _)| ip.to_string()).unwrap_or_else(|| s.to_string())
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
/// `local_port`: porta ADB real reportada pelo agente (NÃO fixar 5555).
pub fn open_tunnel(company_id: i32, esfera_device_id: &str, current_local_ip: &str, local_port: u16) -> String {
    let key = derive_device_key(company_id, esfera_device_id);
    let port = if local_port > 0 { local_port } else { 5555 };
    let adb_addr = if current_local_ip.is_empty() {
        String::new()
    } else {
        format!("{}:{}", current_local_ip, port)
    };
    let mut map = STATES.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(key).or_insert_with(|| DeviceState {
        key,
        esfera_device_id: esfera_device_id.to_string(),
        company_id,
        ip: current_local_ip.to_string(),
        current_adb_address: adb_addr.clone(),
        battery_level: 0,
        is_charging: false,
        is_screen_on: false,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
        last_touch_instant: None,
        assigned_vps_port: 0,
    });
    entry.esfera_device_id = esfera_device_id.to_string();
    entry.company_id = company_id;
    if !current_local_ip.is_empty() {
        entry.ip = current_local_ip.to_string();
        entry.current_adb_address = adb_addr;
    }
    entry.tunnel = Some(new_session("rust"));
    entry.last_seen_utc = now;
    entry.recalc();
    entry.tunnel.as_ref().unwrap().session_id.clone()
}

/// Canal PRESENÇA (agente kotlin). Substitui a sessão de presença; não toca túnel.
/// O WS de presença não carrega o endereço ADB, então `ip`/`current_adb_address`
/// só são preenchidos se já existirem (vindos do check-in HTTP).
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
        ip: String::new(),
        current_adb_address: String::new(),
        battery_level: battery,
        is_charging: charging,
        is_screen_on: screen_on,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
        last_touch_instant: None,
        assigned_vps_port: 0,
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
/// O `current_adb_address` (ip:porta) reportado pelo check-in é preservado no
/// estado para que o app desktop cruze o cartão local por IP (fix do amarelo).
/// Sem isso, o check-in só gravava o DB e o session_manager ficava vazio ->
/// app mostrava os celulares como "connecting" (amarelo) eternamente.
pub fn touch_presence(company_id: i32, esfera_device_id: &str, current_adb_address: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let ip = strip_port(current_adb_address);
    let mut map = STATES.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    let entry = map.entry(key).or_insert_with(|| DeviceState {
        key,
        esfera_device_id: esfera_device_id.to_string(),
        company_id,
        ip: ip.clone(),
        current_adb_address: current_adb_address.to_string(),
        battery_level: 0,
        is_charging: false,
        is_screen_on: false,
        status: ConnectionStatus::Offline,
        tunnel: None,
        presence: None,
        last_seen_utc: now.clone(),
        last_touch_instant: Some(Instant::now()),
        assigned_vps_port: 0,
    });
    entry.esfera_device_id = esfera_device_id.to_string();
    entry.company_id = company_id;
    if !current_adb_address.is_empty() {
        entry.current_adb_address = current_adb_address.to_string();
        entry.ip = ip;
    }
    // Preserva telemetria existente; renova a sessão de presença se ausente.
    if entry.presence.is_none() {
        entry.presence = Some(new_session("kotlin"));
    } else if let Some(p) = entry.presence.as_mut() {
        p.last_heartbeat = now.clone();
        p.last_heartbeat_instant = Some(Instant::now());
    }
    entry.last_seen_utc = now;
    // Sempre renova o instant do check-in HTTP para que recently_active_90s()
    // inclua este device mesmo sem sessão WS/túnel ativa.
    entry.last_touch_instant = Some(Instant::now());
    entry.recalc();
}

/// Define/atualiza a porta lógica VPS atribuída a um dispositivo no estado em RAM.
pub fn set_assigned_vps_port(company_id: i32, esfera_device_id: &str, port: u16) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        entry.assigned_vps_port = port;
    }
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

/// Fecha apenas o canal TÚNEL (agente rust desconectou) se a session_id bater com a ativa.
pub fn close_tunnel(company_id: i32, esfera_device_id: &str, session_id: &str) {
    let key = derive_device_key(company_id, esfera_device_id);
    let mut map = STATES.lock().unwrap();
    if let Some(entry) = map.get_mut(&key) {
        if let Some(ref t) = entry.tunnel {
            if t.session_id == session_id {
                entry.tunnel = None;
                entry.recalc();
            }
        }
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

/// Device considerado "atividade recente" se tiver:
///   1. Heartbeat de túnel ou presença WS nos últimos 90s, OU
///   2. Check-in HTTP recente (last_touch_instant) nos últimos 90s.
/// Sem o critério 2, dispositivos que só fazem check-in HTTP (sem WS/túnel)
/// ficam invisíveis no get_live_devices e aparecem amarelos no app desktop.
pub fn recently_active_90s() -> Vec<DeviceState> {
    let cutoff = Instant::now() - Duration::from_secs(90);
    STATES
        .lock()
        .unwrap()
        .values()
        .filter(|s| {
            // Critério 1: canal WS ou túnel com heartbeat recente
            let has_recent_channel = s.tunnel.as_ref().and_then(|t| t.last_heartbeat_instant)
                .map_or(false, |instant| instant > cutoff)
                || s.presence.as_ref().and_then(|p| p.last_heartbeat_instant)
                    .map_or(false, |instant| instant > cutoff);
            // Critério 2: check-in HTTP recente (touch_presence foi chamado < 90s)
            let has_recent_checkin = s.last_touch_instant
                .map_or(false, |instant| instant > cutoff);
            has_recent_channel || has_recent_checkin
        })
        .cloned()
        .collect()
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
/// Só include dispositivos com atividade nos últimos 90 segundos (check-in HTTP,
/// presença WS ou túnel Rust) para que o `get_live_devices` da VPS devolva a
/// lista completa e correta.
/// Inclui `ip` e `current_adb_address` para que o `get_live_devices` da VPS
/// devolva o endereço do aparelho e o app desktop cruze o cartão local (fix
/// do status amarelo "connecting").
pub fn live_snapshot() -> Vec<crate::db::LiveDeviceState> {
    recently_active_90s()
        .into_iter()
        .map(|s| crate::db::LiveDeviceState {
            company_id: s.company_id,
            esfera_device_id: s.esfera_device_id.clone(),
            status: s.status.as_str().to_string(),
            battery_level: s.battery_level,
            last_seen_utc: s.last_seen_utc.clone(),
            ip: s.ip.clone(),
            current_adb_address: s.current_adb_address.clone(),
            assigned_vps_port: s.assigned_vps_port,
        })
        .collect()
}

/// Heartbeat reaper: roda periodicamente e marca como OFFLINE os devices que
/// não mandaram heartbeat dentro do timeout. Limpa sessões mortas (túnel e/ou
/// presença) para liberar recursos. Sem essa rotina, um device que perde conexão
/// fica "online" eternamente no sistema.
///
/// Mega Prompt §11: "heartbeat ausente → suspeita → timeout → OFFLINE"
pub async fn heartbeat_reaper() {
    let timeout = Duration::from_secs(90);
    let interval = Duration::from_secs(30);
    loop {
        tokio::time::sleep(interval).await;
        let now = Instant::now();
        let mut map = STATES.lock().unwrap();
        for state in map.values_mut() {
            // Verifica se o túnel está morto (sem heartbeat dentro do timeout)
            if let Some(ref t) = state.tunnel {
                if t.last_heartbeat_instant.map_or(true, |i| now.duration_since(i) > timeout) {
                    state.tunnel = None;
                }
            }
            // Verifica se a presença está morta
            if let Some(ref p) = state.presence {
                if p.last_heartbeat_instant.map_or(true, |i| now.duration_since(i) > timeout) {
                    state.presence = None;
                }
            }
            // Verifica se o touch_presence (check-in HTTP) está expirado
            let touch_alive = state.last_touch_instant
                .map_or(false, |i| now.duration_since(i) <= timeout);
            // Se nenhum canal está vivo E o touch está expirado → OFFLINE
            if state.tunnel.is_none() && state.presence.is_none() && !touch_alive {
                if state.status != ConnectionStatus::Offline {
                    println!(
                        "[reaper] device {} (company={}) → OFFLINE (timeout {}s)",
                        state.esfera_device_id, state.company_id, timeout.as_secs()
                    );
                    state.status = ConnectionStatus::Offline;
                }
            } else {
                state.recalc();
            }
        }
    }
}
