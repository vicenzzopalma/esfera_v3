mod db;
mod protocol;
mod hub;
mod checkin_server;

use std::env;
use std::sync::Arc;
use db::Database;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("HUB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(protocol::HUB_DEFAULT_PORT);

    println!("=== ESFERA HUB STANDALONE (ULTRA FAST) ===");
    println!("Iniciando servidor TCP Master na porta {}...", port);

    // 1. Inicia o Hub TCP Master (em background)
    let hub = hub::Hub::new(port);
    tokio::spawn(async move {
        if let Err(e) = hub.start().await {
            eprintln!("Falha fatal no Hub TCP: {}", e);
            std::process::exit(1);
        }
    });

    // 2. Inicializa o Banco de Dados local do Hub
    let db_path = "./esfera_cloud.db".to_string();
    let db = match Database::init(&db_path) {
        Ok(d) => Arc::new(d),
        Err(e) => {
            eprintln!("FATAL: Nao foi possivel abrir o banco SQLite na nuvem: {}", e);
            std::process::exit(1);
        }
    };
    println!("Banco de dados SQLite carregado em {}", db_path);

    // 3. Inicia o Servidor Check-in HTTP (Axum) na porta 8080
    let http_port: u16 = env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    
    println!("Iniciando Servidor HTTP Check-in na porta {}...", http_port);
    checkin_server::start(db, http_port).await;
}
