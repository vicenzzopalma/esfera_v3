use std::env;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("HUB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(esfera_v3_lib::protocol::HUB_DEFAULT_PORT);

    println!("=== ESFERA HUB v3 ===");
    println!("Iniciando servidor na porta {}...", port);

    let hub = esfera_v3_lib::hub::Hub::new(port);
    if let Err(e) = hub.start().await {
        eprintln!("Falha fatal no Hub: {}", e);
        std::process::exit(1);
    }
}
