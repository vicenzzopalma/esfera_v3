use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::db::Database;
use crate::protocol::{EmpresaInfo, HubMessage};

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
    db: Arc<Database>,
    connections: Arc<Mutex<HashMap<String, HubConnection>>>,
    pending: Arc<Mutex<HashMap<String, String>>>,
}

impl Hub {
    pub fn new(port: u16, db: Arc<Database>) -> Self {
        Self {
            port,
            db,
            connections: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(self) -> Result<(), String> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", self.port))
            .await
            .map_err(|e| format!("Falha ao iniciar Hub na porta {}: {}", self.port, e))?;
        println!("Hub iniciado na porta {}", self.port);

        let connections = self.connections.clone();
        let pending = self.pending.clone();
        let db = self.db.clone();
        loop {
            let (stream, addr) = listener.accept().await.map_err(|e| e.to_string())?;
            let connections = connections.clone();
            let pending = pending.clone();
            let db = db.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(connections, pending, db, stream, addr).await {
                    eprintln!("Erro na conexão {}: {}", addr, e);
                }
            });
        }
    }

    #[allow(dead_code)]
    pub async fn broadcast_command(&self, _to_company: i32, _cmd: &str, _args: &[String]) -> Result<Vec<String>, String> {
        Ok(vec!["ok".to_string()])
    }
}

async fn send_raw(writer: &Mutex<BufWriter<OwnedWriteHalf>>, msg: &HubMessage) -> Result<(), String> {
    let data = crate::protocol::serialize_msg(msg)?;
    let mut w = timeout(WRITE_TIMEOUT, writer.lock())
        .await
        .map_err(|_| "timeout no writer do hub".to_string())?;

    w.write_all(&data).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn send_to_master(
    connections: &Mutex<HashMap<String, HubConnection>>,
    master_sid: &str,
    payload: &[u8],
) -> Result<(), String> {
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
    db: Arc<Database>,
    stream: TcpStream,
    addr: std::net::SocketAddr,
) -> Result<(), String> {
    let (reader, writer) = stream.into_split();
    let writer = BufWriter::new(writer);
    let writer_lock = Arc::new(Mutex::new(writer));
    let mut reader = BufReader::new(reader);
    let session_id = format!(
        "sess_{}_{}",
        addr.port(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let conn = HubConnection {
        writer: writer_lock.clone(),
        role: String::new(),
        company_id: None,
        company_name: None,
    };
    connections.lock().await.insert(session_id.clone(), conn);

    // RAII Cleanup Guard: garante remoção de connections SEMPRE que a função encerrar
    // (seja por break, error, timeout ou panic). Elimina vazamentos em CLOSE-WAIT.
    struct ConnectionGuard {
        connections: Arc<Mutex<HashMap<String, HubConnection>>>,
        session_id: String,
        addr: std::net::SocketAddr,
    }
    impl Drop for ConnectionGuard {
        fn drop(&mut self) {
            let connections = self.connections.clone();
            let session_id = self.session_id.clone();
            let addr = self.addr;
            tokio::spawn(async move {
                connections.lock().await.remove(&session_id);
                println!("Conexão {} ({}) limpa do Hub com sucesso", addr, session_id);
            });
        }
    }
    let _guard = ConnectionGuard { connections: connections.clone(), session_id: session_id.clone(), addr };

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

        let msg = match crate::protocol::deserialize_msg(trimmed.as_bytes()) {
            Ok(m) => m,
            Err(_) => continue,
        };

        match msg {
            HubMessage::Auth { token, role } => {
                // Auth por TOKEN de empresa (sem credencial global em código).
                // Master => CompanyId 0; Empresa => CompanyId N (isolada).
                let validated = db.validate_token(&token);
                let (company_id, _role_out) = match validated {
                    Some((cid, r)) => (cid, r),
                    None => {
                        let resp = HubMessage::AuthResponse {
                            success: false,
                            session_id: None,
                            company_id: None,
                            error: Some("Token inválido.".to_string()),
                        };
                        let _ = send_raw(&writer_lock, &resp).await;
                        continue;
                    }
                };
                // O papel do token deve bater com o role pedido (master só com token master).
                let effective_role = if role == "master" && company_id == 0 {
                    "master".to_string()
                } else if role == "empresa" && company_id > 0 {
                    "empresa".to_string()
                } else {
                    let resp = HubMessage::AuthResponse {
                        success: false,
                        session_id: None,
                        company_id: None,
                        error: Some("Token não autoriza este papel.".to_string()),
                    };
                    let _ = send_raw(&writer_lock, &resp).await;
                    continue;
                };
                let mut conns = connections.lock().await;
                if let Some(conn) = conns.get_mut(&session_id) {
                    conn.role = effective_role.clone();
                    conn.company_id = Some(company_id);
                    let resp = HubMessage::AuthResponse {
                        success: true,
                        session_id: Some(session_id.clone()),
                        company_id: Some(company_id),
                        error: None,
                    };
                    let _ = send_raw(&conn.writer, &resp).await;
                    println!("{} autenticado no Hub (company {})", effective_role, company_id);
                }
            }
            HubMessage::Register { company_id, company_name } => {
                // Register amarrado à sessão autenticada: empresa só registra a PRÓPRIA
                // company_id; master pode registrar qualquer uma.
                let mut conns = connections.lock().await;
                if let Some(conn) = conns.get_mut(&session_id) {
                    let allowed = match conn.role.as_str() {
                        "master" => true,
                        "empresa" => conn.company_id == Some(company_id),
                        _ => false,
                    };
                    if allowed {
                        conn.company_id = Some(company_id);
                        conn.company_name = Some(company_name.clone());
                        let resp = HubMessage::RegisterResponse { success: true, error: None };
                        let _ = send_raw(&conn.writer, &resp).await;
                        println!("Empresa '{}' (ID {}) registrada", company_name, company_id);
                    } else {
                        let resp = HubMessage::RegisterResponse {
                            success: false,
                            error: Some("Não autorizado a registrar esta empresa.".to_string()),
                        };
                        let _ = send_raw(&conn.writer, &resp).await;
                    }
                }
            }
            HubMessage::Command { from, to_company, cmd, args, id } => {
                // Só encaminha se a sessão está autenticada E (master OU dona da empresa alvo).
                let authorized = {
                    let conns = connections.lock().await;
                    match conns.get(&session_id) {
                        Some(c) if c.role == "master" => true,
                        Some(c) => c.company_id == to_company,
                        None => false,
                    }
                };
                if !authorized {
                    let resp = HubMessage::CommandResponse {
                        id,
                        result: None,
                        error: Some("Não autorizado.".to_string()),
                    };
                    let _ = send_raw(&writer_lock, &resp).await;
                    continue;
                }

                let target_sid = {
                    let conns = connections.lock().await;
                    conns
                        .iter()
                        .find(|(_, c)| {
                            c.role == "empresa"
                                && c.company_id == to_company.or(Some(c.company_id.unwrap_or(0)))
                        })
                        .map(|(sid, _)| sid.clone())
                };

                if let Some(target_sid) = target_sid {
                    pending.lock().await.insert(id.clone(), session_id.clone());
                    let relay = HubMessage::Command {
                        from,
                        to_company,
                        cmd,
                        args,
                        id: id.clone(),
                    };
                    let payload = crate::protocol::serialize_msg(&relay)?;
                    // Resolve a writer da sessão alvo ANTES de qualquer await, para não
                    // segurar o guard do Mutex além do seu escopo.
                    let target_writer: Option<Arc<Mutex<BufWriter<OwnedWriteHalf>>>> = {
                        let conns = connections.lock().await;
                        conns.get(&target_sid).map(|c| c.writer.clone())
                    };

                    if let Some(writer) = target_writer {
                        if let Err(_) = send_raw(&writer, &crate::protocol::deserialize_msg(&payload).unwrap_or(HubMessage::Pong)).await {
                            let _ = send_raw(
                                &writer_lock,
                                &HubMessage::CommandResponse {
                                    id,
                                    result: None,
                                    error: Some("Falha no relay para empresa".into()),
                                },
                            )
                            .await;
                        }
                    }
                } else {
                    let resp = HubMessage::CommandResponse {
                        id,
                        result: None,
                        error: Some("Empresa não conectada ao Hub.".to_string()),
                    };
                    let _ = send_raw(&writer_lock, &resp).await;
                }
            }
            HubMessage::CommandResponse { id, result, error } => {
                let master_sid = {
                    let mut pend = pending.lock().await;
                    pend.remove(&id)
                };
                if let Some(master_sid) = master_sid {
                    let payload = crate::protocol::serialize_msg(&HubMessage::CommandResponse {
                        id,
                        result,
                        error,
                    })?;
                    let _ = send_to_master(&connections, &master_sid, &payload).await;
                }
            }
            HubMessage::EmpresaList { .. } => {
                let conns = connections.lock().await;
                let empresas: Vec<EmpresaInfo> = conns
                    .values()
                    .filter(|c| c.role == "empresa" && c.company_id.is_some())
                    .map(|c| EmpresaInfo {
                        company_id: c.company_id.unwrap_or(0),
                        company_name: c.company_name.clone().unwrap_or_default(),
                        connected_since: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as i64,
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
