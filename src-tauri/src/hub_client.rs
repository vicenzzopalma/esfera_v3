use crate::protocol::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

// Certificado publico da VPS; a chave privada permanece no servidor.
const CERTIFICADO_VPS: &str = r#"-----BEGIN CERTIFICATE-----
MIIBojCCAUigAwIBAgIUESUE4dHvfL20FxhPctEIuk6qqsAwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKZXNmZXJhLXZwczAeFw0yNjEwMzAxMjAwNDlaFw0zNjEwMjcx
MjAwNDlaMBUxEzARBgNVBAMMCmVzZmVyYS12cHMwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQcd4U+CopieYApwbqOUdk/izE7xucs9RM8TR1SCMd4LM540le/dQ4Z
MMpGlMfVA75mXxoxm7UT22ImpsgGe/1ko3YwdDAdBgNVHQ4EFgQU54tg8DntyeT3
FbqykR9K7JOcXuMwHwYDVR0jBBgwFoAU54tg8DntyeT3FbqykR9K7JOcXuMwDwYD
VR0RBAgwBocEu03z4DAMBgNVHRMBAf8EAjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMB
MAoGCCqGSM49BAMCA0gAMEUCIQCWoC5aj5t0H5f1sJe0Htj9Nv9MnKOKer3Pi9Ym
d2VUZwIgb6JLH+79cKQZICyXB6iHDHRdQz7d9rQ2krCUIZE29eE=
-----END CERTIFICATE-----"#;

fn client_vps_com_pem(pem: &[u8], timeout: Duration) -> Result<reqwest::Client, String> {
    let cert = reqwest::Certificate::from_pem(pem).map_err(|_| "Certificado da VPS invalido".to_string())?;
    reqwest::Client::builder()
        .use_rustls_tls()
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build().map_err(|_| "Falha ao preparar HTTPS da VPS".to_string())
}

pub fn client_vps(timeout: Duration) -> Result<reqwest::Client, String> {
    client_vps_com_pem(CERTIFICADO_VPS.as_bytes(), timeout)
}

pub fn usa_certificado_vps(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint).map(|u| u.scheme() == "https" && u.host_str() == Some("187.77.243.224")).unwrap_or(false)
}

pub fn endpoint_vps_https(endpoint: &str) -> String {
    if let Ok(mut url) = reqwest::Url::parse(endpoint) {
        if url.scheme() == "http" && url.host_str() == Some("187.77.243.224") && url.port() == Some(11435) {
            if url.set_scheme("https").is_ok() { return url.to_string(); }
        }
    }
    endpoint.to_string()
}

pub struct HubClient {
    writer: Mutex<tokio::io::BufWriter<OwnedWriteHalf>>,
    reader: Mutex<BufReader<OwnedReadHalf>>,
    session_id: Option<String>,
    command_lock: Mutex<()>,
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
            command_lock: Mutex::new(()),
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
        match timeout(Duration::from_secs(300), (&mut *reader).take(16777217).read_line(&mut line)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("Timeout de leitura no HubClient".to_string()),
        }
        if line.is_empty() { return Err("Conexao fechada.".into()); }
        if line.len() > 16777216 || !line.ends_with('\n') { return Err("Resposta do hub invalida ou muito grande.".into()); }
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
        let operation = async {
            let _guard = self.command_lock.lock().await;
            let id = uuid::Uuid::new_v4().to_string();
            let msg = HubMessage::Command { from: "empresa".to_string(), to_company: Some(to_company), cmd: cmd.to_string(), args, id: id.clone() };
            self.send(&msg).await?;
            loop {
                match self.read_one().await? {
                    HubMessage::CommandResponse { id: response_id, result, error } if response_id == id => {
                        return match (result, error) { (Some(value), _) => Ok(value), (_, Some(e)) => Err(e), _ => Err("Resposta vazia do hub.".into()) };
                    }
                    HubMessage::Ping => { self.send(&HubMessage::Pong).await?; }
                    HubMessage::CommandResponse { .. } | HubMessage::Pong => continue,
                    _ => return Err("Resposta inesperada do hub.".into()),
                }
            }
        };
        timeout(Duration::from_secs(8), operation).await.map_err(|_| "O hub demorou para responder.".to_string())?
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
    let client = if usa_certificado_vps(&url) {
        client_vps(Duration::from_secs(5))?
    } else {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build().map_err(|_| "Falha ao preparar conexao HTTPS com o Hub.".to_string())?
    };
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

#[cfg(test)]
mod vps_tls_tests {
    use super::*;

    #[test]
    fn certificado_vps_valido_e_invalido() {
        assert!(client_vps_com_pem(CERTIFICADO_VPS.as_bytes(), Duration::from_secs(5)).is_ok());
        assert!(client_vps_com_pem(b"pem invalido", Duration::from_secs(5)).is_err());
    }

    #[test]
    fn identifica_e_migra_somente_o_endereco_correto() {
        assert_eq!(endpoint_vps_https("http://187.77.243.224:11435/v1/chat/completions"), "https://187.77.243.224:11435/v1/chat/completions");
        assert_eq!(endpoint_vps_https("http://187.77.243.224:11436/v1"), "http://187.77.243.224:11436/v1");
        assert!(usa_certificado_vps("https://187.77.243.224:8443/teste"));
        assert!(!usa_certificado_vps("https://187.77.243.224.outro.example:8443/teste"));
        assert!(!usa_certificado_vps("http://187.77.243.224:11435"));
    }
}
