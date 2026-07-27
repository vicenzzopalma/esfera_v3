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
    pub mode: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            hub_enabled: false,
            hub_address: String::new(),
            empresa_server_enabled: false,
            empresa_server_port: 7777,
            checkin_server_enabled: true,
            checkin_server_port: 8080,
            mode: "local".to_string(),
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
