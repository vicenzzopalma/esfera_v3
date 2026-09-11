// ============================================================
// Esfera v3 — Hub Standalone — Router de Porta Lógica (proxy reverso)
//
// Objetivo (specs): o PROGRAMA CENTRAL conecta em VPS:assigned_vps_port
// (ex: 30017 para CELULAR_017) e a VPS roteia para o endpoint ATUAL do
// aparelho via túnel Rust. A identidade é o device_id; a porta lógica é
// estável; o IP/porta física do celular é descartável e atualizado a cada
// check-in. Nunca se cria duplicata: a mesma porta lógica sempre aponta para
// o mesmo device_id, e reconexões apenas trocam a sessão de túnel.
//
// Fluxo:
//   1. Check-in registra a rota: porta_lógica -> (company_id, esfera_device_id).
//   2. Programa conecta VPS:porta_lógica.
//   3. Router pede ao agente (via tunnel_server::request_proxy) que abra o
//      proxy na porta adbd local; o agente envia os bytes do adbd como
//      {"type":"proxy-data","b64":...} pelo túnel.
//   4. Router recebe proxy-data do túnel e escreve no socket do programa;
//      bytes do programa -> tunnel_server como proxy-data -> agente -> adbd.
// ============================================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use crate::db::Database;

/// Rota: porta lógica VPS -> (company_id, esfera_device_id).
static ROUTES: LazyLock<Mutex<HashMap<u16, (i32, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ponte Tunnel -> Router: device_id -> sender de bytes recebidos do túnel.
static PROXY_BRIDGE: LazyLock<
    Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

use std::sync::LazyLock;

/// Registra/atualiza a rota da porta lógica para um device.
pub fn register_route(logical_port: u16, company_id: i32, esfera_device_id: &str) {
    if logical_port == 0 {
        return;
    }
    ROUTES
        .lock()
        .unwrap()
        .insert(logical_port, (company_id, esfera_device_id.to_string()));
}

/// Remove a rota (usado quando o device some).
pub fn unregister_route(logical_port: u16) {
    ROUTES.lock().unwrap().remove(&logical_port);
}

/// Canal para entregar bytes do túnel (proxy-data) ao router de uma porta lógica.
pub fn deliver_proxy_data(esfera_device_id: &str, data: Vec<u8>) {
    if let Some(tx) = PROXY_BRIDGE.lock().unwrap().get(esfera_device_id) {
        let _ = tx.send(data);
    }
}

/// Aceita a conexão de um cliente (programa central) numa porta lógica e
/// estabelece a ponte bidirecional com o túnel do device.
async fn handle_client(
    client: tokio::net::TcpStream,
    _logical_port: u16,
    company_id: i32,
    esfera_device_id: String,
) {
    // Canal para receber bytes do túnel (proxy-data) destinados a este cliente.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    PROXY_BRIDGE
        .lock()
        .unwrap()
        .insert(esfera_device_id.clone(), tx);

    // Pede ao agente que abra o proxy na porta adbd local (ele enviará proxy-data).
    let adb_port: u16 = 5555; // o agente descobre a real; aqui apenas dispara.
    if let Err(e) = crate::tunnel_server::request_proxy(company_id, &esfera_device_id, adb_port) {
        eprintln!("[router] falha ao solicitar proxy para {}: {}", esfera_device_id, e);
        PROXY_BRIDGE.lock().unwrap().remove(&esfera_device_id);
        return;
    }

    let (mut cr, mut cw) = client.into_split();
    let device_id = esfera_device_id.clone();

    // Task: túnel -> cliente (proxy-data recebido da VPS).
    let writer_task = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if cw.write_all(&data).await.is_err() {
                break;
            }
        }
    });

    // Task: cliente -> túnel (envia como proxy-data).
    let reader_task = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match cr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let b64 = B64.encode(&buf[..n]);
                    let line = format!("{{\"type\":\"proxy-data\",\"b64\":\"{}\"}}\n", b64);
                    if crate::tunnel_server::send_proxy_data(company_id, &device_id, &line).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Encerra após 5min de inatividade (defesa contra sockets órfãos).
    let _ = tokio::time::timeout(Duration::from_secs(300), writer_task).await;
    reader_task.abort();
    PROXY_BRIDGE.lock().unwrap().remove(&esfera_device_id);
}

/// Inicia o router: aceita conexões TCP nas portas lógicas (30000-30100).
pub async fn start(db: Arc<Database>) {
    // Carrega rotas existentes do banco (portas já atribuídas).
    if let Ok(devices) = db.load_all_assigned_ports() {
        let mut routes = ROUTES.lock().unwrap();
        for (port, company_id, esfera_device_id) in devices {
            if port > 0 {
                routes.insert(port, (company_id, esfera_device_id));
            }
        }
    }

    // Listener em 30000-30100 (uma única porta por device; usamos um listener
    // por porta lógica seria pesado — em vez disso, aceitamos em 30000 e
    // usamos a própria conexão para descobrir a porta? Não: a VPS precisa
    // escutar a porta exata. Aqui escutamos um range via SO_REUSEPORT não é
    // trivial; simplificamos: um listener por porta atribuída, recriado quando
    // novas rotas surgem. Para o escopo atual, iniciamos listeners para as
    // portas já conhecidas e para um conjunto fixo 30000..30099.
    let ports: Vec<u16> = (30000u16..30100u16).collect();
    for port in ports {
        let db = db.clone();
        tokio::spawn(async move {
            let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(_) => return, // porta livre ou em uso: skip
            };
            println!("[router] escutando porta lógica {}", port);
            loop {
                let (client, _) = match listener.accept().await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                // Resolve a rota para esta porta.
                let route = ROUTES.lock().unwrap().get(&port).cloned();
                match route {
                    Some((company_id, esfera_device_id)) => {
                        tokio::spawn(handle_client(client, port, company_id, esfera_device_id));
                    }
                    None => {
                        // Sem rota: a VPS ainda não atribuiu porta para este device,
                        // ou o banco não tem. Tenta carregar do DB.
                        if let Some((cid, did)) = db.lookup_by_assigned_port(port) {
                            ROUTES.lock().unwrap().insert(port, (cid, did.clone()));
                            tokio::spawn(handle_client(client, port, cid, did));
                        } else {
                            drop(client);
                        }
                    }
                }
            }
        });
    }
    println!("[router] router de porta lógica iniciado (30000-30099)");
}
