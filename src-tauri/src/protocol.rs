use serde::{Deserialize, Serialize};

// Portas padrão
pub const HUB_DEFAULT_PORT: u16 = 8888;
pub const EMPRESA_DEFAULT_PORT: u16 = 7777;

// IMPORTANTE: não existe mais credencial global em código.
// A autenticação é por TOKEN por empresa (tabela ESF_CompanyToken no hub).
// Master => CompanyId = 0. Empresa => CompanyId = N (isolada).

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HubMessage {
    #[serde(rename = "auth")]
    Auth { token: String, role: String },

    #[serde(rename = "auth_response")]
    AuthResponse { success: bool, session_id: Option<String>, company_id: Option<i32>, error: Option<String> },

    #[serde(rename = "register")]
    Register { company_id: i32, company_name: String },

    #[serde(rename = "register_response")]
    RegisterResponse { success: bool, error: Option<String> },

    #[serde(rename = "command")]
    Command { from: String, to_company: Option<i32>, cmd: String, args: serde_json::Value, id: String },

    #[serde(rename = "command_response")]
    CommandResponse { id: String, result: Option<serde_json::Value>, error: Option<String> },

    #[serde(rename = "empresa_list")]
    EmpresaList { empresas: Vec<EmpresaInfo> },

    #[serde(rename = "ping")]
    Ping,

    #[serde(rename = "pong")]
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmpresaInfo {
    pub company_id: i32,
    pub company_name: String,
    pub connected_since: i64,
}

pub fn serialize_msg(msg: &HubMessage) -> Result<Vec<u8>, String> {
    let mut data = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    data.push(b'\n');
    Ok(data)
}

pub fn deserialize_msg(data: &[u8]) -> Result<HubMessage, String> {
    serde_json::from_slice(data).map_err(|e| e.to_string())
}
