use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub hub_enabled: bool,
    pub hub_address: String,
    /// Token master do Hub VPS. Se vazio, usa o default embutido
    /// (EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b) que bate com o seed do VPS.
    /// Configurável em Settings (master) para alinhar com HUB_MASTER_TOKEN da VPS.
    pub hub_token: String,
    pub vexor_token: String,
    pub empresa_server_enabled: bool,
    pub empresa_server_port: u16,
    pub checkin_server_enabled: bool,
    pub checkin_server_port: u16,
    pub tunnel_server_enabled: bool,
    pub tunnel_server_port: u16,
    pub mode: String,
    /// Endereço do CRM de celulares do VERITAS ("Gestão de celulares"), lido
    /// apenas para exibir número e status de WhatsApp de cada aparelho.
    pub crm_base_url: String,
    /// Grava no Konfiansa a conversa do WhatsApp do disparo (histórico interno AUTOMÁTICO).
    pub konfiansa_history_enabled: bool,
    /// Credenciais do serviço do Konfiansa: ficam só neste arquivo local, nunca no código.
    pub konfiansa_win_user: String,
    pub konfiansa_win_pass: String,
    pub konfiansa_logon: String,
    /// "WhatsApp retorno": resposta ao disparo vai ao negociador (ou ao grupo da equipe, em rodízio)
    /// e vira histórico interno + externo no Konfiansa. Desligado por padrão.
    pub retorno_negociador_enabled: bool,
    /// Só respostas recebidas a partir deste instante (UTC "AAAA-MM-DD HH:MM:SS"). Vazio: o Esfera
    /// grava "agora" na primeira rodada, para não reencaminhar respostas já tratadas à mão.
    pub retorno_desde: String,
    /// Instância da Evolution (no hub) que envia o aviso; precisa participar do grupo da equipe.
    pub retorno_instancia: String,
    /// Grupo da equipe (JID "...@g.us") e o nome dele no histórico interno.
    pub retorno_grupo: String,
    pub retorno_grupo_nome: String,
    /// Pessoas do rodízio do grupo, na ordem (equipe que atende o credor do grupo).
    pub retorno_rodizio: Vec<String>,
    /// Carteiras (login do cobrador no Konfiansa) que não têm negociador próprio: vão ao grupo.
    pub retorno_carteiras_equipe: Vec<String>,
    /// Único credor cujo retorno vai ao grupo da equipe. Outro credor sem negociador não vai a ninguém.
    pub retorno_credor_equipe: i32,
    /// Modelo do Groq que escreve o histórico externo (chave: a do Groq em Configurações > IA).
    pub retorno_ia_modelo: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            hub_enabled: false,
            // Modo Standalone Local (Opera direto via USB ou WireGuard VPN P2P)
            hub_address: "127.0.0.1:8555".to_string(),
            hub_token: "root123".to_string(),
            vexor_token: String::new(),
            empresa_server_enabled: false,
            empresa_server_port: 7777,
            checkin_server_enabled: true,
            checkin_server_port: 8080,
            tunnel_server_enabled: false,
            tunnel_server_port: 8888,
            mode: "standalone".to_string(),
            crm_base_url: "http://187.77.243.224:3000".to_string(),
            konfiansa_history_enabled: true,
            konfiansa_win_user: String::new(),
            konfiansa_win_pass: String::new(),
            konfiansa_logon: String::new(),
            retorno_negociador_enabled: false,
            retorno_desde: String::new(),
            retorno_instancia: String::new(),
            retorno_grupo: String::new(),
            retorno_grupo_nome: "grupo da equipe".to_string(),
            retorno_rodizio: Vec::new(),
            retorno_carteiras_equipe: vec!["MARCELA".to_string(), "REGINA".to_string()],
            retorno_credor_equipe: 598,
            retorno_ia_modelo: "qwen/qwen3.8-27b".to_string(),
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

pub fn vexor_token() -> String {
    let stored = load_config().vexor_token;
    if !stored.trim().is_empty() { return stored.trim().to_string(); }
    std::env::var("ESFERA_SAIR_TOKEN").or_else(|_| std::env::var("ESFERA_COMPANY_TOKEN")).unwrap_or_default().trim().to_string()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}
