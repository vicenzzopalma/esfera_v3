// ============================================================
// Esfera v3 — Servidor do Túnel Inverso (tunnel_server.rs)
// Recebe conexões dos daemons Android (device-agent), faz o
// handshake por Hardware UUID, mantém heartbeat L7 (ping/pong)
// e descarta sockets obsoletos quando o aparelho reconecta.
// Sobre a sessão ativa, aceita pedidos de PROXY TCP: o hub cria
// uma ponte 127.0.0.1:0 e faz relay bidirecional entre o daemon
// e o cliente local (adb_tcp), permitindo ADB completo em
// aparelhos atrás de NAT sem rota direta ao IP:5555.
// ============================================================

use chrono::Utc;
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, oneshot};
use crate::db::Database;

/// Pedido de proxy: o control loop negocia o JSON com o daemon e sinaliza o ack.
struct ProxyRequest {
    port: u16,
    local_addr: SocketAddr,
    ack: oneshot::Sender<Result<(), String>>,
}

type ConnMap = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ProxyRequest>>>>;

static REGISTRY: LazyLock<ConnMap> = LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

const ADB_PORT: u16 = 5555;
const HEARTBEAT_GRACE_SECS: u64 = 45;
const PROXY_ACK_TIMEOUT_SECS: u64 = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentHandshake {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    hardware_uuid: Option<String>,
    #[serde(default)]
    mac_address: String,
    #[serde(default)]
    serial_number: String,
    #[serde(default)]
    agent_version: String,
    #[serde(default)]
    current_local_ip: String,
}

/// Leitor de linhas manual sobre o TcpStream (compartilhado via AsyncMutex),
/// mantendo os bytes lidos além da linha em `buf` para repasse ao relay de proxy.
struct LineReader {
    stream: Arc<AsyncMutex<TcpStream>>,
    buf: Vec<u8>,
}

impl LineReader {
    async fn next_line(&mut self, timeout: Option<Duration>) -> Option<String> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line = String::from_utf8_lossy(&self.buf[..pos]).to_string();
                self.buf.drain(..=pos);
                return Some(line);
            }
            let mut guard = self.stream.lock().await;
            let mut chunk = [0u8; 2048];
            let read = tokio::time::timeout(
                timeout.unwrap_or(Duration::from_secs(30)),
                guard.read(&mut chunk),
            );
            match read.await {
                Ok(Ok(n)) if n > 0 => self.buf.extend_from_slice(&chunk[..n]),
                Ok(Ok(_)) => return None, // EOF
                Ok(Err(_)) => return None,
                Err(_) => return None,    // timeout de leitura
            }
        }
    }
}

pub async fn start(db: Arc<Database>, port: u16, app_handle: Option<AppHandle>) {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("AVISO: Túnel inverso na porta {} já em uso: {}", port, e);
            return;
        }
    };

    println!("🔌 Túnel Inverso ativo na porta {} (daemons Android)", port);

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let db2 = db.clone();
                let handle = app_handle.clone();
                tokio::spawn(async move {
                    handle_agent(stream, db2, handle).await;
                });
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn handle_agent(stream: TcpStream, db: Arc<Database>, app_handle: Option<AppHandle>) {
    // Soquete compartilhado entre leitura (LineReader) e escrita (handshake/heartbeat/relay).
    let shared = Arc::new(AsyncMutex::new(stream));
    let mut reader = LineReader {
        stream: shared.clone(),
        buf: Vec::with_capacity(4096),
    };

    // 1. Handshake na primeira linha (timeout 10s)
    let first = match tokio::time::timeout(Duration::from_secs(10), reader.next_line(None)).await {
        Ok(Some(l)) => l,
        _ => return,
    };
    let hs: AgentHandshake = match serde_json::from_str(&first) {
        Ok(h) => h,
        Err(_) => return,
    };
    let Some(uuid) = hs.hardware_uuid.filter(|u| !u.is_empty()) else {
        return;
    };

    // 2. Confirma o handshake
    {
        let mut guard = shared.lock().await;
        if guard
            .write_all(b"{\"type\":\"welcome\"}\n")
            .await
            .is_err()
        {
            return;
        }
    }

    // 3. Check-in no DB (dispositivo online via túnel) + rota de túnel + evento na UI
    let ip = if hs.current_local_ip.is_empty() {
        "0.0.0.0".to_string()
    } else {
        hs.current_local_ip.clone()
    };
    let adb_addr = format!("{}:{}", ip, ADB_PORT);
    let now = Utc::now().to_rfc3339();

    {
        let db2 = db.clone();
        let uuid2 = uuid.clone();
        let adb_addr2 = adb_addr.clone();
        let ip2 = ip.clone();
        let now2 = now.clone();
        tokio::task::spawn_blocking(move || {
            let updated = db2.process_checkin(&uuid2, &adb_addr2, &ip2, ADB_PORT, &now2);
            if let Ok(0) = updated {
                let _ = db2.insert_unknown_device(&uuid2, &adb_addr2, &ip2, ADB_PORT, &now2);
            }
        });
    }
    crate::adb_tcp::register_tunnel_serial(&uuid);

    if let Some(ref app) = app_handle {
        let _ = app.emit(
            "device-updated",
            serde_json::json!({
                "esferaDeviceId": uuid,
                "currentAdbAddress": adb_addr,
                "status": "online",
                "lastSeenUtc": now,
                "viaTunnel": true,
            }),
        );
    }

    // 4. Registra no mapa — substitui conexão antiga (socket obsoleto) do mesmo aparelho
    let (tx, mut rx) = mpsc::unbounded_channel::<ProxyRequest>();
    REGISTRY.lock().unwrap().insert(uuid.clone(), tx);

    // 5. Loop de heartbeat L7: responde ping com pong; derruba se silencioso por 45s.
    //    Pedido de proxy interrompe o loop e entrega o soquete cru ao relay.
    let mut pending_proxy: Option<ProxyRequest> = None;
    let silent = Duration::from_secs(HEARTBEAT_GRACE_SECS);
    let mut last_line = Instant::now();
    loop {
        tokio::select! {
            line = reader.next_line(None) => {
                let line = match line {
                    Some(l) => l,
                    None => break,
                };
                last_line = Instant::now();
                let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
                if v.get("type").and_then(|t| t.as_str()) == Some("ping") {
                    let mut guard = shared.lock().await;
                    if guard.write_all(b"{\"type\":\"pong\"}\n").await.is_err() {
                        break;
                    }
                }
            }
            req = rx.recv() => {
                match req {
                    Some(r) => {
                        pending_proxy = Some(r);
                        break;
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep(silent) => {
                if last_line.elapsed() >= silent {
                    break;
                }
            }
        }
    }

    if let Some(req) = pending_proxy {
        run_proxy_relay(&mut reader, shared, req).await;
    }

    REGISTRY.lock().unwrap().remove(&uuid);
    crate::adb_tcp::unregister_tunnel_serial(&uuid);
}

/// Negocia o proxy com o daemon (JSON) e faz relay bidirecional bruto.
async fn run_proxy_relay(
    reader: &mut LineReader,
    shared: Arc<AsyncMutex<TcpStream>>,
    req: ProxyRequest,
) {
    // 1. Pedido ao daemon + ack (timeout 5s)
    {
        let mut guard = shared.lock().await;
        let request = format!("{{\"type\":\"proxy\",\"port\":{}}}\n", req.port);
        if guard.write_all(request.as_bytes()).await.is_err() {
            let _ = req.ack.send(Err("falha ao enviar pedido de proxy ao daemon".to_string()));
            return;
        }
    }
    let ack = tokio::time::timeout(
        Duration::from_secs(PROXY_ACK_TIMEOUT_SECS),
        reader.next_line(None),
    )
    .await;

    let ack_line = match ack {
        Ok(Some(l)) => l,
        _ => {
            let _ = req.ack.send(Err("daemon não respondeu ao pedido de proxy".to_string()));
            return;
        }
    };
    let v: serde_json::Value =
        serde_json::from_str(ack_line.trim()).unwrap_or(serde_json::Value::Null);
    if v.get("type").and_then(|t| t.as_str()) != Some("proxy-ack") {
        let err = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("daemon recusou o proxy");
        let _ = req.ack.send(Err(format!("proxy recusado: {}", err)));
        return;
    }

    // 2. Conecta na ponte local (o caller aceita o outro extremo)
    let mut local = match TcpStream::connect(&req.local_addr).await {
        Ok(s) => s,
        Err(e) => {
            let _ = req.ack.send(Err(format!("falha na ponte local: {}", e)));
            return;
        }
    };

    // 3. Libera o caller (o transporte está pronto)
    if req.ack.send(Ok(())).is_err() {
        return;
    }

    // 4. Relay bruto bidirecional (soquete cru do daemon + ponte local).
    //    Sobras do buffer de controle pertencem ao fluxo daemon → local.
    //    O soquete é o mesmo TcpStream compartilhado (lockado para o relay).
    let leftover = std::mem::take(&mut reader.buf);
    let mut guard = shared.lock().await;
    if !leftover.is_empty() {
        let _ = guard.write_all(&leftover).await;
    }
    let _ = tokio::io::copy_bidirectional(&mut *guard, &mut local).await;
}

/// Abre uma ponte local de proxy para um dispositivo de túnel e devolve o
/// TcpStream pronto para o protocolo ADB (chamado de thread de spawn_blocking).
pub async fn open_proxy(uuid: &str, port: u16) -> Result<std::net::TcpStream, String> {
    let sender = REGISTRY
        .lock()
        .unwrap()
        .get(uuid)
        .cloned()
        .ok_or_else(|| format!("dispositivo '{}' sem sessão de túnel ativa", uuid))?;

    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let local_addr = listener.local_addr().map_err(|e| e.to_string())?;

    let (ack_tx, ack_rx) = oneshot::channel();
    sender
        .send(ProxyRequest {
            port,
            local_addr,
            ack: ack_tx,
        })
        .map_err(|_| "sessão de túnel encerrada".to_string())?;

    ack_rx
        .await
        .map_err(|_| "sessão de túnel encerrada durante handshake de proxy".to_string())??;

    listener
        .accept()
        .map(|(s, _)| s)
        .map_err(|e| format!("falha no aceite da ponte local: {}", e))
}

/// Encerra o servidor de túnel: limpa o registro de sessões ativas e o estado
/// global de seriais virtuais em adb_tcp, evitando "túneis fantasmas" caso o
/// servidor seja derrubado ou o app encerre.
pub fn shutdown() {
    REGISTRY.lock().unwrap().clear();
    crate::adb_tcp::unregister_all_tunnel_serials();
}
