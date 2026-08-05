// Testes das correções de identidade/isolamento/controle (Opção A — VPS fonte de verdade).
//
// Cobrem exatamente o que estava quebrado antes:
//  1. companyId ausente/zero => sessão RECUSADA (antes caía tudo na empresa 0);
//  2. check-in sem companyId => HTTP 400 (antes respondia "ok" silenciosamente);
//  3. proxy de controle só alcança device da PRÓPRIA empresa (antes não existia);
//  4. reconciliação RAM -> DB: device com túnel vivo NÃO é marcado offline pelo
//     sweeper de check-in (antes havia duas fontes de verdade em conflito).
//
// Determinismo: portas únicas por execução, ACK real do servidor, sem sleep fixo
// como condição de asserção.

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use esfera_hub_standalone::db::{Database, LiveDeviceState};
use esfera_hub_standalone::session_manager as sm;
use esfera_hub_standalone::tunnel_server;

static PORT_BASE: AtomicU16 = AtomicU16::new(31000);

fn next_port() -> u16 {
    PORT_BASE.fetch_add(10, Ordering::Relaxed)
}

const EMP_X: i32 = 41;
const EMP_Y: i32 = 42;

async fn wait_listening(port: u16) {
    for _ in 0..60 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("servidor na porta {} não subiu", port);
}

/// Handshake cru: devolve a primeira resposta do servidor (welcome ou error).
async fn handshake_raw(port: u16, body: &str) -> (TcpStream, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let _ = reader.read_line(&mut line).await;
    (reader.into_inner(), line)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_recusa_handshake_sem_company_id() {
    let port = next_port();
    tokio::spawn(tunnel_server::start(port));
    wait_listening(port).await;

    // Sem campo companyId (o que o agente antigo enviava).
    let (_s, resp) = handshake_raw(
        port,
        "{\"type\":\"handshake\",\"hardwareUuid\":\"ESF-NOCOMPANY\",\"currentLocalIp\":\"10.0.0.9\"}\n",
    )
    .await;
    assert!(
        resp.contains("error") && resp.contains("companyId"),
        "esperado erro de companyId, veio: {:?}",
        resp
    );

    // E, crucialmente, NÃO existe sessão criada na empresa 0.
    assert!(
        sm::get_state(0, "ESF-NOCOMPANY").is_none(),
        "device sem companyId não pode criar estado na empresa 0"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checkin_recusa_sem_company_id() {
    let port = next_port();
    let db = std::sync::Arc::new(Database::init("./test_isolation_checkin.db").unwrap());
    tokio::spawn(esfera_hub_standalone::checkin_server::start(
        db.clone(),
        port,
    ));
    wait_listening(port).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/api/devices/check-in", port))
        .json(&serde_json::json!({
            "esferaDeviceId": "ESF-SEM-EMPRESA",
            "currentAdbAddress": "10.0.0.5:5555"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(
        resp.status().as_u16(),
        400,
        "check-in sem companyId deve ser recusado, não aceito silenciosamente"
    );

    let _ = std::fs::remove_file("./test_isolation_checkin.db");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_de_controle_respeita_isolamento_por_empresa() {
    let port = next_port();
    tokio::spawn(tunnel_server::start(port));
    wait_listening(port).await;

    sm::forget(EMP_X, "ESF-CTRL");
    let hs = format!(
        "{{\"type\":\"handshake\",\"hardwareUuid\":\"ESF-CTRL\",\"companyId\":{}}}\n",
        EMP_X
    );
    let (stream, resp) = handshake_raw(port, &hs).await;
    assert!(resp.contains("welcome"), "handshake válido deve receber welcome: {}", resp);

    // Espera o registro do canal de controle ficar visível.
    let mut ok = false;
    for _ in 0..40 {
        if tunnel_server::request_proxy(EMP_X, "ESF-CTRL", 5555).is_ok() {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "empresa dona deve conseguir pedir proxy pelo túnel");

    // Empresa Y NUNCA alcança o device da empresa X.
    assert!(
        tunnel_server::request_proxy(EMP_Y, "ESF-CTRL", 5555).is_err(),
        "empresa alheia não pode pedir proxy para device de outra empresa"
    );
    // Device inexistente também falha.
    assert!(tunnel_server::request_proxy(EMP_X, "ESF-INEXISTENTE", 5555).is_err());

    // O device recebe de fato a linha de proxy pelo socket.
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await;
    assert!(read.is_ok(), "device deveria receber o pedido de proxy");
    assert!(
        line.contains("\"proxy\"") && line.contains("5555"),
        "linha recebida inesperada: {:?}",
        line
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconciliacao_ram_db_protege_device_com_canal_vivo() {
    let db = Database::init("./test_isolation_sync.db").unwrap();
    db.ensure_company(EMP_X, "Empresa_X").unwrap();

    // Device com LastSeenUTC MUITO antigo (não faz check-in há horas).
    let antigo = "2000-01-01T00:00:00+00:00";
    db.process_checkin("ESF-VIVO", "10.0.0.7:5555", "10.0.0.7", 5555, antigo, EMP_X)
        .unwrap();
    db.process_checkin("ESF-MORTO", "10.0.0.8:5555", "10.0.0.8", 5555, antigo, EMP_X)
        .unwrap();

    // Só ESF-VIVO tem canal vivo em RAM.
    let live = vec![LiveDeviceState {
        company_id: EMP_X,
        esfera_device_id: "ESF-VIVO".to_string(),
        status: "online".to_string(),
        battery_level: 77,
        last_seen_utc: chrono::Utc::now().to_rfc3339(),
    }];
    db.sync_live_state(&live, 120).unwrap();

    let vivo = db.get_device_by_esfera_id("ESF-VIVO").unwrap();
    let morto = db.get_device_by_esfera_id("ESF-MORTO").unwrap();

    assert_eq!(
        vivo.status, "online",
        "device com túnel/presença vivos NÃO pode ser marcado offline pelo sweeper de check-in"
    );
    assert_eq!(vivo.battery, 77, "telemetria da presença deve chegar ao DB");
    assert_eq!(
        morto.status, "offline",
        "device sem canal vivo e com check-in vencido deve cair para offline"
    );

    let _ = std::fs::remove_file("./test_isolation_sync.db");
}
