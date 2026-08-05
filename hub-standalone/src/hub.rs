use crate::protocol::*;
use crate::db::Database;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

struct HubConnection {
    writer: Arc<Mutex<BufWriter<OwnedWriteHalf>>>,
    role: String,
    company_id: Option<i32>,
    company_name: Option<String>,
}

pub struct Hub {
    port: u16,
    connections: Arc<Mutex<HashMap<String, HubConnection>>>,
    pending: Arc<Mutex<HashMap<String, String>>>, // cmd_id → master_session_id
    db: Arc<Database>,
}

impl Hub {
    pub fn new(port: u16, db: Arc<Database>) -> Self {
        Self { port, connections: Arc::new(Mutex::new(HashMap::new())), pending: Arc::new(Mutex::new(HashMap::new())), db }
    }

    pub async fn start(self) -> Result<(), String> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", self.port))
            .await
            .map_err(|e| format!("Falha ao iniciar Hub na porta {}: {}", self.port, e))?;
        println!("Hub iniciado na porta {}", self.port);

        loop {
            let (stream, addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    println!("Aviso: erro ao aceitar conexão TCP: {}", e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let connections = self.connections.clone();
            let pending = self.pending.clone();
            let db = self.db.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(connections, pending, db, stream, addr).await {
                    eprintln!("Erro na conexão {}: {}", addr, e);
                }
            });
        }
    }
}

async fn send_raw(
    writer: &Mutex<BufWriter<OwnedWriteHalf>>,
    msg: &HubMessage,
) -> Result<(), String> {
    let data = serialize_msg(msg)?;
    let mut w = writer.lock().await;
    w.write_all(&data).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

async fn handle_connection(
    connections: Arc<Mutex<HashMap<String, HubConnection>>>,
    pending: Arc<Mutex<HashMap<String, String>>>,
    db: Arc<Database>,
    stream: TcpStream,
    addr: std::net::SocketAddr,
) -> Result<(), String> {
    let (reader, writer) = stream.into_split();
    let writer = BufWriter::new(writer);
    let writer_lock = Arc::new(Mutex::new(writer));
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let session_id = format!("sess_{}_{}", addr.port(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis());
    let mut authenticated = false;
    let mut auth_company_id: Option<i32> = None;
    let mut auth_role: Option<String> = None;

    loop {
        line.clear();
        let n = match timeout(Duration::from_secs(300), reader.read_line(&mut line)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => return Err("Timeout de leitura no Hub".to_string()),
        };
        if n == 0 {
            break;
        }
        let msg: HubMessage = deserialize_msg(line.trim().as_bytes())?;

        match msg {
            HubMessage::Auth { token, role } => {
                // Validação company-scoped: o token define papel e empresa.
                // NUNCA existe credencial global em código.
                match db.validate_token(&token) {
                    Some((company_id, token_role)) => {
                        // O papel declarado pelo cliente deve bater com o do token.
                        if token_role != role {
                            let resp = HubMessage::AuthResponse { success: false, session_id: None, company_id: None, error: Some("Papel incompatível com o token.".to_string()) };
                            send_raw(&writer_lock, &resp).await?;
                            continue;
                        }
                        authenticated = true;
                        auth_company_id = Some(company_id);
                        auth_role = Some(role.clone());
                        let conn = HubConnection {
                            writer: writer_lock.clone(),
                            role: role.clone(),
                            company_id: Some(company_id),
                            company_name: None,
                        };
                        connections.lock().await.insert(session_id.clone(), conn);
                        let resp = HubMessage::AuthResponse { success: true, session_id: Some(session_id.clone()), company_id: Some(company_id), error: None };
                        send_raw(&writer_lock, &resp).await?;
                        println!("'{}' autenticado no Hub (company {})", role, company_id);
                    }
                    None => {
                        let resp = HubMessage::AuthResponse { success: false, session_id: None, company_id: None, error: Some("Token inválido.".to_string()) };
                        send_raw(&writer_lock, &resp).await?;
                    }
                }
            }
            HubMessage::Register { company_id, company_name } => {
                if !authenticated { continue; }
                // REGRA DE ISOLAMENTO: empresa só pode registrar a PRÓPRIA company_id.
                // Master (company 0) pode registrar qualquer empresa.
                let allowed = match auth_role.as_deref() {
                    Some("master") => true,
                    Some("empresa") => auth_company_id == Some(company_id),
                    _ => false,
                };
                if !allowed {
                    let resp = HubMessage::RegisterResponse { success: false, error: Some("Empresa não pode registrar company_id alheio.".to_string()) };
                    send_raw(&writer_lock, &resp).await?;
                    continue;
                }
                let mut conns = connections.lock().await;
                if let Some(conn) = conns.get_mut(&session_id) {
                    conn.company_id = Some(company_id);
                    conn.company_name = Some(company_name.clone());
                }
                drop(conns);
                println!("Empresa '{}' (ID {}) registrada", company_name, company_id);
                let resp = HubMessage::RegisterResponse { success: true, error: None };
                send_raw(&writer_lock, &resp).await?;
            }
            HubMessage::Command { from, to_company, cmd, args, id } => {
                if !authenticated { continue; }
                // Apenas master despacha comandos. Empresa nunca despacha para outra empresa.
                if auth_role.as_deref() != Some("master") {
                    let resp = HubMessage::CommandResponse { id, result: None, error: Some("Apenas master pode enviar comandos.".to_string()) };
                    send_raw(&writer_lock, &resp).await?;
                    continue;
                }
                let conns = connections.lock().await;
                let target = conns.iter().find(|(_, c)| {
                    c.role == "empresa" && c.company_id == to_company
                }).map(|(sid, _)| sid.clone());
                if let Some(target_sid) = target {
                    pending.lock().await.insert(id.clone(), session_id.clone());
                    let relay = HubMessage::Command { from, to_company, cmd, args, id: id.clone() };
                    if let Some(target_conn) = conns.get(&target_sid) {
                        send_raw(&target_conn.writer, &relay).await?;
                    }
                } else {
                    let resp = HubMessage::CommandResponse { id, result: None, error: Some("Empresa não conectada ao Hub.".to_string()) };
                    send_raw(&writer_lock, &resp).await?;
                }
            }
            HubMessage::CommandResponse { id, result, error } => {
                if !authenticated { continue; }
                let master_sid = {
                    let mut pend = pending.lock().await;
                    pend.remove(&id)
                };
                if let Some(master_sid) = master_sid {
                    let conns = connections.lock().await;
                    if let Some(master_conn) = conns.get(&master_sid) {
                        let resp = HubMessage::CommandResponse { id, result, error };
                        send_raw(&master_conn.writer, &resp).await?;
                    }
                }
            }
            HubMessage::EmpresaList { .. } => {
                if !authenticated { continue; }
                let conns = connections.lock().await;
                let empresas: Vec<EmpresaInfo> = conns.values()
                    .filter(|c| c.role == "empresa" && c.company_id.is_some())
                    .map(|c| EmpresaInfo {
                        company_id: c.company_id.unwrap(),
                        company_name: c.company_name.clone().unwrap_or_default(),
                        connected_since: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64,
                    })
                    .collect();
                let resp = HubMessage::EmpresaList { empresas };
                send_raw(&writer_lock, &resp).await?;
            }
            HubMessage::Ping => {
                send_raw(&writer_lock, &HubMessage::Pong).await?;
            }
            _ => {}
        }
    }

    connections.lock().await.remove(&session_id);
    println!("Conexão {} encerrada", addr);
    Ok(())
}
