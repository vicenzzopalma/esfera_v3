mod db;
pub mod protocol;
mod hub;
mod checkin_server;
pub mod tunnel_server;
pub mod presence_server;
pub mod session_manager;

use std::env;
use std::sync::Arc;
use std::time::Duration;
use std::io::Write;
use db::Database;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("HUB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(protocol::HUB_DEFAULT_PORT);

    println!("=== ESFERA HUB STANDALONE (FONTE DE VERDADE) ===");
    println!("Iniciando servidor TCP Master na porta {}...", port);
    let _ = std::io::stdout().flush();

    // 1. Inicia o Hub TCP Master (relay master <-> empresas)
    let hub = hub::Hub::new(port);
    tokio::spawn(async move {
        if let Err(e) = hub.start().await {
            println!("Falha fatal no Hub TCP: {}", e);
            let _ = std::io::stdout().flush();
        }
    });

    // 2. Banco de dados SQLite
    let db_path = "./esfera_cloud.db".to_string();
    let db = match Database::init(&db_path) {
        Ok(d) => Arc::new(d),
        Err(e) => {
            println!("FATAL DB: Nao foi possivel abrir o banco SQLite na nuvem: {}", e);
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
    };
    println!("Banco de dados SQLite carregado com sucesso!");
    let _ = std::io::stdout().flush();

    // 3. Monitor de stale: túnel 45s, presença 30s (marca Offline se silenciou)
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            session_manager::sweep_stale(45, 30);
            // Também marca no DB devices cujo check-in expirou (>120s)
            let _ = db.mark_stale_devices_offline(120);
        }
    });
    println!("Status monitor iniciado (sweep de presença/túnel + check-in 120s)");
    let _ = std::io::stdout().flush();

    // 4. Check-in HTTP (agente Kotlin) :8080
    let http_port: u16 = env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let db_checkin = db.clone();
    tokio::spawn(async move {
        checkin_server::start(db_checkin, http_port).await;
    });

    // 5. Tunnel server (agente RUST) :8888 — canal de CONTROLE ADB
    let tunnel_port: u16 = env::var("TUNNEL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8888);
    tokio::spawn(async move {
        tunnel_server::start(tunnel_port).await;
    });

    // 6. Presence WebSocket (agente KOTLIN) :7779 — telemetria
    let presence_port: u16 = env::var("PRESENCE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7779);
    tokio::spawn(async move {
        presence_server::start(presence_port).await;
    });

    println!(
        "Hub Standalone ATIVO: master={} checkin={} tunnel={} presence={}",
        port, http_port, tunnel_port, presence_port
    );
    let _ = std::io::stdout().flush();

    // Mantém o processo vivo (os servidores rodam em tasks).
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
