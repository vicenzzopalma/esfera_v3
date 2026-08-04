use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

const READ_LINE_TIMEOUT: Duration = Duration::from_secs(300);
const WRITE_TIMEOUT: Duration = Duration::from_millis(1200);
const MAX_LINE: usize = 8192;

struct HubConnection {
    writer: Arc<Mutex<BufWriter<OwnedWriteHalf>>>,
    role: String,
    company_id: Option<i32>,
    company_name: Option<String>,
}

pub struct Hub {
    port: u16,
    connections: Arc<Mutex<HashMap<String, HubConnection>>>,
    pending: Arc<Mutex<HashMap<String, String>>>,
}

impl Hub {
    pub fn new(port: u16) -> Self {
        Self { port, connections: Arc::new(Mutex::new(HashMap::new())), pending: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn start(self) -> Result<(), String> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", self.port))
            .await
            .map_err(|e| format!("Falha ao iniciar Hub na porta {}: {}", self.port, e))?;
        println!("Hub iniciado na porta {}", self.port);

        let connections = self.connections.clone();
        let pending = self.pending.clone();
        loop {
            let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
            let connections = connections.clone();
            let pending = pending.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(connections, pending, stream, addr).await {
                    eprintln!("Erro na conexão {}: {}", addr, e);
                }
            });
        }
    }

    pub async fn broadcast_command(&self, _to_company: i32, _cmd: &str, _args: &[String]) -> Result<Vec<String>, String> {
        Ok(vec!["ok".to_string()])
    }
}

async fn send_raw(writer: &Mutex<BufWriter<OwnedWriteHalf>>, msg: &HubMessage) -> Result<(), String> {
    let data = serialize_msg(msg)?;
    let mut w = timeout(WRITE_TIMEOUT, writer.lock())
        .await
        .map_err(|_| "timeout no writer do hub".to_string())?;

    w.write_all(&data).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn send_to_master(connections: &Mutex<HashMap<String, HubConnection>>, master_sid: &str, payload: &[u8]) -> Result<(), String> {
    let conns = connections.lock().await;
    if let Some(master_conn) = conns.get(master_sid) {
        let mut w = timeout(WRITE_TIMEOUT, master_conn.writer.lock())
            .await
            .map_err(|_| "timeout no writer master".to_string())?;

        w.write_all(payload).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("master_session_removed".into())
    }
}

async fn handle_connection(
    connections: Arc<Mutex<HashMap<String, HubConnection>>>,
    pending: Arc<Mutex<HashMap<String, String>>>,
    stream: TcpStream,
    addr: std::net::SocketAddr,
) -> Result<(), String> {
    let (reader, writer) = stream.into_split();
    let writer = BufWriter::new(writer);
    let writer_lock = Arc::new(Mutex::new(writer));
    let mut reader = BufReader::new(reader);
    let session_id = format!("sess_{}_{}", addr.port(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis());
    let conn = HubConnection {
        writer: writer_lock.clone(),
        role: String::new(),
        company_id: None,
        company_name: None,
    };
    connections.lock().await.insert(session_id.clone(), conn);
    let mut line = String::new();

    loop {
        line.clear();
        let n = match timeout(READ_LINE_TIMEOUT, reader.read_line(&mut line)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("Timeout de leitura no Hub".to_string()),
        };
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_LINE {
            continue;
        }

        let msg = match deserialize_msg(trimmed.as_bytes()) {
            Ok(m) => m,
            Err(_) => continue,
        };

        match msg {
            HubMessage::Auth { username, password, role } => {
                let auth_ok = (role == "master" || role == "empresa") && username == AUTH_MASTER_USER && password == AUTH_MASTER_PASS;
                let mut conns = connections.lock().await;
                if let Some(conn) = conns.get_mut(&session_id) {
                    if auth_ok {
                        conn.role = role.clone();
                        let resp = HubMessage::AuthResponse { success: true, session_id: Some(session_id.clone()), error: None };
                        let _ = send_raw(&conn.writer, &resp).await;
                        println!("{} '{}' autenticado no Hub", role, username);
                    } else {
                        let resp = HubMessage::AuthResponse { success: false, session_id: None, error: Some("Credenciais inválidas.".to_string()) };
                        let _ = send_raw(&conn.writer, &resp).await;
                    }
                }
            }
            HubMessage::Register { company_id, company_name } => {
                let mut conns = connections.lock().await;
                if let Some(conn) = conns.get_mut(&session_id) {
                    if conn.role == "master" || !conn.role.is_empty() {
                        conn.company_id = Some(company_id);
                        conn.company_name = Some(company_name.clone());
                        let resp = HubMessage::RegisterResponse { success: true, error: None };
                        let _ = send_raw(&conn.writer, &resp).await;
                        println!("Empresa '{}' (ID {}) registrada", company_name, company_id);
                    }
                }
            }
            HubMessage::Command { from, to_company, cmd, args, id } => {
                let conns = connections.lock().await;
                if let Some(c) = conns.get(&session_id) {
                    if c.role.is_empty() {
                        continue;
                    }
                } else {
                    continue;
                }

                let target_sid = conns.iter()
                    .find(|(_, c)| c.role == "empresa" && c.company_id == Some(to_company))
                    .map(|(sid, _)| sid.clone());

                if let Some(target_sid) = target_sid {
                    pending.lock().await.insert(id.clone(), session_id.clone());
                    let relay = HubMessage::Command { from, to_company, cmd, args, id: id.clone() };
                    let payload = serialize_msg(&relay)?;
                    drop(conns);

                    if let Some(target_conn) = connections.lock().await.get(&target_sid) {
                        if let Err(_) = send_raw(&target_conn.writer, &deserialize_msg(&payload).unwrap_or(HubMessage::Pong)).await {
                            let _ = send_raw(&writer_lock, &HubMessage::CommandResponse { id, result: None, error: Some("Falha no relay para empresa".into()) }).await;
                        }
                    }
                } else {
                    let resp = HubMessage::CommandResponse { id, result: None, error: Some("Empresa não conectada ao Hub.".to_string()) };
                    let _ = send_raw(&writer_lock, &resp).await;
                }
            }
            HubMessage::CommandResponse { id, result, error } => {
                let master_sid = {
                    let mut pend = pending.lock().await;
                    pend.remove(&id)
                };
                if let Some(master_sid) = master_sid {
                    let payload = serialize_msg(&HubMessage::CommandResponse { id, result, error })?;
                    let _ = send_to_master(&connections, &master_sid, &payload).await;
                }
            }
            HubMessage::EmpresaList { .. } => {
                let conns = connections.lock().await;
                let empresas: Vec<EmpresaInfo> = conns.values()
                    .filter(|c| c.role == "empresa" && c.company_id.is_some())
                    .map(|c| EmpresaInfo {
                        company_id: c.company_id.unwrap_or(0),
                        company_name: c.company_name.clone().unwrap_or_default(),
                        connected_since: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64,
                    })
                    .collect();
                let resp = HubMessage::EmpresaList { empresas };
                let _ = send_raw(&writer_lock, &resp).await;
            }
            HubMessage::Ping => {
                let _ = send_raw(&writer_lock, &HubMessage::Pong).await;
            }
            _ => {}
        }
    }

    connections.lock().await.remove(&session_id);
    println!("Conexão {} encerrada", addr);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum HubMessage {
    Auth { username: String, password: String, role: String },
    AuthResponse { success: bool, session_id: Option<String>, error: Option<String> },
    Register { company_id: i32, company_name: String },
    RegisterResponse { success: bool, error: Option<String> },
    Command { from: String, to_company: i32, cmd: String, args: Vec<String>, id: String },
    CommandResponse { id: String, result: Option<serde_json::Value>, error: Option<String> },
    EmpresaList { empresas: Vec<EmpresaInfo> },
    Ping,
    Pong,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EmpresaInfo {
    pub company_id: i32,
    pub company_name: String,
    pub connected_since: i64,
}

const AUTH_MASTER_USER: &str = "master";
const AUTH_MASTER_PASS: &str = "admin123";

fn serialize_msg(msg: &HubMessage) -> Result<Vec<u8>, String> {
    let mut data = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    data.push(b'\n');
    Ok(data)
}

fn deserialize_msg(bytes: &[u8]) -> Result<HubMessage, String> {
    let msg: HubMessage = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    Ok(msg)
}
