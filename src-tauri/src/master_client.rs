use crate::protocol::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub struct MasterClient {
    writer: Mutex<tokio::io::BufWriter<OwnedWriteHalf>>,
    reader: Mutex<BufReader<OwnedReadHalf>>,
    session_id: Option<String>,
}

impl MasterClient {
    pub async fn connect(hub_addr: &str) -> Result<Self, String> {
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

        client.authenticate().await?;
        println!("Conectado ao Hub {} como Master", hub_addr);
        Ok(client)
    }

    async fn authenticate(&mut self) -> Result<(), String> {
        // Token do Hub lido de env (obrigatório). Sem fallback de credencial em código.
        let token = std::env::var("ESFERA_HUB_TOKEN")
            .or_else(|_| std::env::var("HUB_MASTER_TOKEN"))
            .map_err(|_| "Token do Hub não configurado (defina ESFERA_HUB_TOKEN).".to_string())?;
        let msg = HubMessage::Auth {
            token,
            role: "master".to_string(),
        };
        self.send_raw(&msg).await?;

        match self.read_one().await? {
            HubMessage::AuthResponse { success: true, session_id, .. } => {
                self.session_id = session_id;
                Ok(())
            }
            HubMessage::AuthResponse { success: false, error, .. } => {
                Err(error.unwrap_or_else(|| "Autenticação Master falhou.".to_string()))
            }
            _ => Err("Resposta inválida do Hub.".to_string()),
        }
    }

    pub async fn send_raw(&self, msg: &HubMessage) -> Result<(), String> {
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
            Err(_) => return Err("Timeout de leitura no MasterClient".to_string()),
        }
        if line.trim().is_empty() {
            return Err("Conexão com Hub perdida.".to_string());
        }
        deserialize_msg(line.trim().as_bytes())
    }

    pub async fn get_empresas(&self) -> Result<Vec<EmpresaInfo>, String> {
        self.send_raw(&HubMessage::EmpresaList { empresas: vec![] }).await?;
        match self.read_one().await? {
            HubMessage::EmpresaList { empresas } => Ok(empresas),
            _ => Err("Resposta inválida ao solicitar lista de empresas.".to_string()),
        }
    }

    pub async fn send_command(
        &self,
        company_id: i32,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let msg = HubMessage::Command {
            from: "master".to_string(),
            to_company: Some(company_id),
            cmd: cmd.to_string(),
            args,
            id: format!("cmd_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()),
        };
        self.send_raw(&msg).await?;
        match self.read_one().await? {
            HubMessage::CommandResponse { result: Some(val), .. } => Ok(val),
            HubMessage::CommandResponse { error: Some(e), .. } => Err(e),
            _ => Err("Resposta inválida do Hub.".to_string()),
        }
    }
}
