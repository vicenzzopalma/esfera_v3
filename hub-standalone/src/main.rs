use esfera_hub_standalone::{
    checkin_server, db, hub, mqtt_fallback_server, presence_server, protocol, router, session_manager, tls_server, tunnel_server,
};
use std::env;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("HUB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(protocol::HUB_DEFAULT_PORT);

    println!("=== ESFERA HUB STANDALONE (FONTE DE VERDADE) ===");
    println!("Iniciando servidor TCP Master na porta {}...", port);
    let _ = std::io::stdout().flush();

    // 2. Banco de dados SQLite ( criado ANTES do hub, que depende dele )
    let db_path = "./esfera_cloud.db".to_string();
    let db = match db::Database::init(&db_path) {
        Ok(d) => Arc::new(d),
        Err(e) => {
            println!("FATAL DB: Nao foi possivel abrir o banco SQLite na nuvem: {}", e);
            let _ = std::io::stdout().flush();
            std::process::exit(1);
        }
    };
    println!("Banco de dados SQLite carregado com sucesso!");
    let _ = std::io::stdout().flush();

    // 1. Inicia o Hub TCP Master (relay master <-> empresas)
    let hub = hub::Hub::new(port, db.clone());
    tokio::spawn(async move {
        if let Err(e) = hub.start().await {
            println!("Falha fatal no Hub TCP: {}", e);
            let _ = std::io::stdout().flush();
        }
    });

    // 3. Monitor de estado: sweep de canais mortos (túnel 45s / presença 30s)
    //    e RECONCILIAÇÃO RAM -> DB. O estado vivo (túnel/presença) tem
    //    precedência sobre o timeout de check-in: sem isso, um device com
    //    túnel ativo era marcado offline no banco (duas fontes de verdade).
    {
        let db_mark = db.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                session_manager::sweep_stale(45, 30);
                let live = session_manager::live_snapshot();
                if let Err(e) = db_mark.sync_live_state(&live, 120) {
                    eprintln!("Aviso: falha ao reconciliar estado vivo com o DB: {}", e);
                }
            }
        });
    }
    println!("Status monitor iniciado (sweep de presença/túnel + reconciliação RAM->DB)");
    let _ = std::io::stdout().flush();

    // 3b. Heartbeat reaper: marca devices como OFFLINE após timeout sem heartbeat.
    // Mega Prompt §11: "heartbeat ausente → suspeita → timeout → OFFLINE"
    tokio::spawn(async move {
        session_manager::heartbeat_reaper().await;
    });

    // 4. Check-in HTTP (agente Kotlin) :8080
    let http_port: u16 = env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let db_checkin = db.clone();
    tokio::spawn(async move {
        checkin_server::start(db_checkin, http_port).await;
    });

    // 4b. Router de porta lógica (proxy reverso VPS:porta_lógica -> túnel -> adbd)
    let db_router = db.clone();
    tokio::spawn(async move {
        router::start(db_router).await;
    });

    // 5. Tunnel server (agente RUST) :8888 — canal de CONTROLE ADB
    let tunnel_port: u16 = env::var("TUNNEL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8888);
    let tp = tunnel_port;
    tokio::spawn(async move {
        match tunnel_server::start(tp).await {
            Ok(()) => {}
            Err(e) => {
                // Erro CRÍTICO: o handler de túnel não subiu (ex: porta 8888 já
                // ocupada por zumbi/segunda instância). Sem isso, o agente conecta
                // num processo que não responde handshake e o celular nunca aparece.
                eprintln!("❌ TUNNEL SERVER FALHOU AO SUBIR: {}", e);
            }
        }
    });

    // 6. Presence WebSocket (agente KOTLIN) :7779 — telemetria
    let presence_port: u16 = env::var("PRESENCE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7779);
    tokio::spawn(async move {
        presence_server::start(presence_port).await;
    });

    // 7. TLS 443 / Outbound Encrypted Tunnel (MDM Enterprise Edge) :443 (fallback 8443)
    // Canal PRIMÁRIO criptografado para o agente Kotlin (HTTPS check-in + WSS presença).
    // Reutiliza os handlers de checkin_server/presence_server sobre TLS.
    // O 8080/7779 (HTTP/WS) permanece como FALLBACK.
    let tls_port: u16 = env::var("TLS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8443);
    let db_tls = db.clone();
    tokio::spawn(async move {
        tls_server::start(db_tls, tls_port).await;
    });

    // 8. MQTT Fallback Server :1883 — Canal Secundário Redundante
    let mqtt_port: u16 = env::var("MQTT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(1883);
    tokio::spawn(async move {
        mqtt_fallback_server::start(mqtt_port).await;
    });

    println!(
        "Hub Standalone ATIVO: master={} checkin={} tunnel={} presence={} tls={} mqtt={}",
        port, http_port, tunnel_port, presence_port, tls_port, mqtt_port
    );
    let _ = std::io::stdout().flush();

    // Mantém o processo vivo (os servidores rodam em tasks).
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
