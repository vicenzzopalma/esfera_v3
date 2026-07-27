use std::env;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("HUB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(esfera_v3_lib::protocol::HUB_DEFAULT_PORT);

    println!("=== ESFERA HUB v3 ===");
    println!("Iniciando servidor TCP Master na porta {}...", port);

    // 1. Inicia o Hub TCP Master (em background)
    let hub = esfera_v3_lib::hub::Hub::new(port);
    tokio::spawn(async move {
        if let Err(e) = hub.start().await {
            eprintln!("Falha fatal no Hub TCP: {}", e);
            std::process::exit(1);
        }
    });

    // 2. Inicializa o Banco de Dados local do Hub (para celulares)
    let db_path = "./esfera_cloud.db".to_string();
    let db = match esfera_v3_lib::db::Database::init(&db_path) {
        Ok(d) => std::sync::Arc::new(d),
        Err(e) => {
            eprintln!("FATAL: Não foi possível abrir o banco SQLite na nuvem: {}", e);
            std::process::exit(1);
        }
    };
    println!("Banco de dados SQLite carregado em {}", db_path);

    // 3. Inicia o Check-in Server HTTP na porta 8080 bloqueando a thread principal
    let http_port = env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    
    println!("Iniciando Servidor HTTP Check-in na porta {}...", http_port);
    esfera_v3_lib::checkin_server::start(db, http_port, None).await;
}
