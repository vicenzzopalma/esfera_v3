use crate::protocol::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub struct HubClient {
    writer: Mutex<tokio::io::BufWriter<OwnedWriteHalf>>,
    reader: Mutex<BufReader<OwnedReadHalf>>,
    session_id: Option<String>,
}

impl HubClient {
    pub async fn connect(
        hub_addr: &str,
        token: &str,
        role: &str,
        company_id: i32,
        company_name: &str,
    ) -> Result<Self, String> {
        let stream = TcpStream::connect(hub_addr)
            .await
            .map_err(|e| format!("Falha ao conectar ao Hub {}: {}", hub_addr, e))?;

        let (reader, writer) = stream.into_split();
        let writer = tokio::io::BufWriter::new(writer);
        let reader = BufReader::new(reader);

        let mut client = Self {
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
            session_id: None,
        };

        client.authenticate(token, role).await?;
        // Apenas empresa precisa registrar a própria company; master não.
        if role == "empresa" {
            client.register(company_id, company_name).await?;
        }

        println!("Conectado ao Hub {} como {} '{}' (ID {})", hub_addr, role, company_name, company_id);
        Ok(client)
    }

    async fn authenticate(&mut self, token: &str, role: &str) -> Result<(), String> {
        if token.is_empty() {
            return Err("Token do Hub ausente (faça login para obter as credenciais).".to_string());
        }
        let msg = HubMessage::Auth {
            token: token.to_string(),
            role: role.to_string(),
        };
        self.send(&msg).await?;

        let response = self.read_one().await?;
        match response {
            HubMessage::AuthResponse { success: true, session_id, .. } => {
                self.session_id = session_id;
                Ok(())
            }
            HubMessage::AuthResponse { success: false, error, .. } => {
                Err(error.unwrap_or_else(|| "Autenticação falhou.".to_string()))
            }
            _ => Err("Resposta de autenticação inválida.".to_string()),
        }
    }

    async fn register(&mut self, company_id: i32, company_name: &str) -> Result<(), String> {
        let msg = HubMessage::Register {
            company_id,
            company_name: company_name.to_string(),
        };
        self.send(&msg).await?;
        let response = self.read_one().await?;
        match response {
            HubMessage::RegisterResponse { success: true, .. } => Ok(()),
            HubMessage::RegisterResponse { success: false, error, .. } => {
                Err(error.unwrap_or_else(|| "Registro falhou.".to_string()))
            }
            _ => Err("Resposta de registro inválida.".to_string()),
        }
    }

    pub async fn send(&self, msg: &HubMessage) -> Result<(), String> {
        let data = serialize_msg(msg)?;
        let mut writer = self.writer.lock().await;
        writer.write_all(&data).await.map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())
    }

    pub async fn read_one(&self) -> Result<HubMessage, String> {
        let mut reader = self.reader.lock().await;
        let mut line = String::new();
        match timeout(Duration::from_secs(300), reader.read_line(&mut line)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("Timeout de leitura no HubClient".to_string()),
        }
        if line.trim().is_empty() {
            return Err("Conexão fechada.".to_string());
        }
        deserialize_msg(line.trim().as_bytes())
    }

    pub async fn send_command(
        &self,
        to_company: i32,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let msg = HubMessage::Command {
            from: "empresa".to_string(),
            to_company: Some(to_company),
            cmd: cmd.to_string(),
            args,
            id: format!("cmd_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()),
        };
        self.send(&msg).await?;
        let response = self.read_one().await?;
        match response {
            HubMessage::CommandResponse { result: Some(val), .. } => Ok(val),
            HubMessage::CommandResponse { error: Some(e), .. } => Err(e),
            _ => Err("Resposta de comando inválida.".to_string()),
        }
    }

    pub async fn listen<F>(&self, on_command: F) -> Result<(), String>
    where
        F: Fn(String, serde_json::Value, String) -> Result<serde_json::Value, String>,
    {
        loop {
            let msg = self.read_one().await?;
            match msg {
                HubMessage::Command { from: _, cmd, args, id, .. } => {
                    let result = on_command(cmd, args, id.clone());
                    match result {
                        Ok(val) => {
                            let resp = HubMessage::CommandResponse {
                                id, result: Some(val), error: None,
                            };
                            self.send(&resp).await?;
                        }
                        Err(e) => {
                            let resp = HubMessage::CommandResponse {
                                id, result: None, error: Some(e),
                            };
                            self.send(&resp).await?;
                        }
                    }
                }
                HubMessage::Ping => {
                    self.send(&HubMessage::Pong).await?;
                }
                _ => {}
            }
        }
    }
}

/// Obtem a configuracao da IA pelo canal HTTPS autenticado do hub.
/// Nunca aceita redirecionamentos, para nao encaminhar a credencial a terceiros.
pub async fn fetch_vps_ia(hub_address: &str, hub_token: &str, company_id: i32) -> Result<Option<(String, String, String)>, String> {
    if hub_token.trim().is_empty() || company_id <= 0 {
        return Err("Credenciais ou empresa do Hub ausentes.".into());
    }
    let addr: std::net::SocketAddr = hub_address.parse()
        .map_err(|_| "Endereco do Hub deve ser IP:porta.".to_string())?;
    let host = match addr.ip() {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => format!("[{}]", ip),
    };
    let url = format!("https://{}:8443/api/desktop/vps-ia?companyId={}", host, company_id);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build().map_err(|_| "Falha ao preparar conexao HTTPS com o Hub.".to_string())?;
    let response = client.get(url).bearer_auth(hub_token).send().await
        .map_err(|_| "Falha na conexao HTTPS com o Hub de IA.".to_string())?;
    if !response.status().is_success() { return Err(format!("Hub de IA retornou HTTP {}.", response.status())); }
    #[derive(serde::Deserialize)]
    struct Config { enabled: bool, token: Option<String>, endpoint: Option<String>, model: Option<String> }
    let cfg: Config = response.json().await.map_err(|_| "Resposta invalida do Hub de IA.".to_string())?;
    if !cfg.enabled { return Ok(None); }
    let (token, endpoint, model) = match (cfg.token, cfg.endpoint, cfg.model) {
        (Some(t), Some(e), Some(m)) => (t, e, m),
        _ => return Err("Configuracao de IA incompleta no Hub.".into()),
    };
    if token.trim().is_empty() || endpoint.trim().is_empty() || model.trim().is_empty() {
        return Err("Configuracao de IA incompleta no Hub.".into());
    }
    Ok(Some((token, endpoint, model)))
}
