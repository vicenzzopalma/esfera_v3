mod db;
mod protocol;
mod hub;
mod checkin_server;

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

    println!("=== ESFERA HUB STANDALONE (ULTRA FAST) ===");
    println!("Iniciando servidor TCP Master na porta {}...", port);
    let _ = std::io::stdout().flush();

    // 1. Inicia o Hub TCP Master (em background)
    let hub = hub::Hub::new(port);
    tokio::spawn(async move {
        if let Err(e) = hub.start().await {
            println!("Falha fatal no Hub TCP: {}", e);
            let _ = std::io::stdout().flush();
        }
    });

    println!("Iniciando banco de dados SQLite...");
    let _ = std::io::stdout().flush();

    // 2. Inicializa o Banco de Dados local do Hub
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

    // 3. Status monitor: marca devices offline se check-in expirou (>120s)
    let db_clone = db.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            match db_clone.mark_stale_devices_offline(120) {
                Ok(n) if n > 0 => println!("Status monitor: {} devices marcados offline", n),
                _ => {}
            }
        }
    });
    println!("Status monitor iniciado (a cada 30s, timeout 120s)");
    let _ = std::io::stdout().flush();

    // 4. Inicia o Servidor Check-in HTTP (Axum) na porta 8080
    let http_port: u16 = env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    
    println!("Iniciando Servidor HTTP Check-in na porta {}...", http_port);
    let _ = std::io::stdout().flush();
    checkin_server::start(db, http_port).await;
}

