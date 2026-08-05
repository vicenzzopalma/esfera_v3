use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub hub_enabled: bool,
    pub hub_address: String,
    pub empresa_server_enabled: bool,
    pub empresa_server_port: u16,
    pub checkin_server_enabled: bool,
    pub checkin_server_port: u16,
    pub tunnel_server_enabled: bool,
    pub tunnel_server_port: u16,
    pub mode: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            hub_enabled: true,
            // Hub master na VPS (fonte de verdade — Opção A do HERMES_CONTEXT).
            // Porta 8555 = hub TCP master (Auth/Command/Register). NÃO é a :8888
            // (tunnel server do device-agent) nem localhost.
            hub_address: "34.29.70.113:8555".to_string(),
            empresa_server_enabled: false,
            empresa_server_port: 7777,
            checkin_server_enabled: true,
            checkin_server_port: 8080,
            tunnel_server_enabled: true,
            tunnel_server_port: 8888,
            mode: "empresa".to_string(),
        }
    }
}

fn config_path() -> PathBuf {
    let mut dir = if let Some(appdata) = std::env::var_os("APPDATA") {
        let mut p = PathBuf::from(appdata);
        p.push("esfera_v3");
        p
    } else {
        PathBuf::from(".")
    };
    let _ = std::fs::create_dir_all(&dir);
    dir.push("config.json");
    dir
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}
