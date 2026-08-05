// Teste de integração determinístico: valida isolamento e ciclo de vida
// de dispositivos nas 3 portas (tunnel TCP, check-in HTTP, presence WS).
// Não usa celulares físicos — simula o protocolo exato dos agentes.
//
// Determinismo:
//  - Portas únicas por execução (derivadas de um contador atômico) para evitar
//    colisão entre testes concorrentes.
//  - Servidores sobem e o teste espera ACK real do servidor (não sleep fixo).
//  - Desconexão é feita FECHANDO o socket real (drop do TcpStream/WebSocket),
//    nunca chamando funções internas de estado.
//  - Não há compartilhamento de estado entre cenários além do roteamento por company_id.

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use futures_util::sink::SinkExt;
use esfera_hub_standalone::session_manager as sm;

static PORT_BASE: AtomicU16 = AtomicU16::new(20000);

fn next_port() -> u16 {
    PORT_BASE.fetch_add(10, Ordering::Relaxed)
}

const COMPANY_A: i32 = 10;
const COMPANY_B: i32 = 20;
const COMPANY_C: i32 = 30;

// Conecta o túnel (device-agent Rust) e RETORNA o stream real para poder derrubá-lo.
// O handshake é enviado e o welcome lido; o stream reconstruído é devolvido ao teste,
// que o descarta (drop) para simular queda de conexão (o servidor detecta EOF).
async fn connect_tunnel(tunnel_port: u16, company_id: i32, device_id: &str) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", tunnel_port)).await.unwrap();
    let hs = format!(
        "{{\"type\":\"handshake\",\"hardwareUuid\":\"{}\",\"macAddress\":\"aa:bb\",\"serialNumber\":\"SN\",\"agentVersion\":\"t\",\"currentLocalIp\":\"10.0.0.1\",\"companyId\":{}}}\n",
        device_id, company_id
    );
    stream.write_all(hs.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    assert!(line.contains("welcome"), "esperado welcome, got {}", line);
    // Reconstrói o TcpStream original (após consumir o welcome) para devolver ao teste.
    reader.into_inner()
}

// Conecta presença WS e RETORNA o WebSocket para poder derrubá-lo (drop = queda).
// Sem heartbeat em task separada: o teste roda bem abaixo do grace de 30s do servidor.
async fn connect_presence(presence_port: u16, company_id: i32, device_id: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use url::Url;
    let url = Url::parse(&format!("ws://127.0.0.1:{}/ws/presence", presence_port)).unwrap();
    let (mut ws, _resp) = connect_async(url).await.unwrap();
    let payload = format!(
        "{{\"uuid\":\"{}\",\"batteryLevel\":80,\"isCharging\":false,\"isScreenOn\":true,\"companyId\":{}}}",
        device_id, company_id
    );
    ws.send(Message::Text(payload)).await.unwrap();
    ws
}

async fn check_in(http_port: u16, company_id: i32, device_id: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post(format!("http://127.0.0.1:{}/api/devices/check-in", http_port))
        .json(&serde_json::json!({
            "esferaDeviceId": device_id,
            "currentAdbAddress": "10.0.0.1:5555",
            "companyId": company_id,
        }))
        .send()
        .await;
}

fn status_of(company_id: i32, device_id: &str) -> Option<sm::ConnectionStatus> {
    sm::get_state(company_id, device_id).map(|s| s.status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn scenario_full_lifecycle() {
    let tunnel_port = next_port();
    let presence_port = tunnel_port + 1;
    let http_port = tunnel_port + 2;
    let _hub_port = tunnel_port + 3;

    // Sobe os servidores.
    let test_db = std::sync::Arc::new(esfera_hub_standalone::db::Database::init("./test_sim.db").unwrap());
    // Garante que as empresas usadas no teste existam (isolamento exige company_id válido).
    test_db.ensure_company(COMPANY_A, "Empresa_A").unwrap();
    test_db.ensure_company(COMPANY_B, "Empresa_B").unwrap();
    test_db.ensure_company(COMPANY_C, "Empresa_C").unwrap();

    tokio::spawn(esfera_hub_standalone::tunnel_server::start(tunnel_port));
    tokio::spawn(esfera_hub_standalone::presence_server::start(presence_port));
    tokio::spawn(esfera_hub_standalone::checkin_server::start(
        test_db.clone(),
        http_port,
    ));

    // Espera os servidores aceitarem conexões (polling real, não sleep fixo).
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", tunnel_port)).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Limpa estado dos devices usados.
    sm::forget(COMPANY_A, "ESF-A");
    sm::forget(COMPANY_A, "ESF-B");
    sm::forget(COMPANY_C, "ESF-C");

    // CENÁRIO 1: 3 dispositivos (A e B na Empresa A; C na Empresa C).
    check_in(http_port, COMPANY_A, "ESF-A").await;
    check_in(http_port, COMPANY_A, "ESF-B").await;
    check_in(http_port, COMPANY_C, "ESF-C").await;

    let _ta = connect_tunnel(tunnel_port, COMPANY_A, "ESF-A").await;
    let _tb = connect_tunnel(tunnel_port, COMPANY_A, "ESF-B").await;
    let _tc = connect_tunnel(tunnel_port, COMPANY_C, "ESF-C").await;
    let _pa = connect_presence(presence_port, COMPANY_A, "ESF-A").await;
    let _pb = connect_presence(presence_port, COMPANY_A, "ESF-B").await;
    let _pc = connect_presence(presence_port, COMPANY_C, "ESF-C").await;

    // Aguarda o estado convergir para Online (polling).
    for _ in 0..40 {
        if status_of(COMPANY_A, "ESF-A") == Some(sm::ConnectionStatus::Online)
            && status_of(COMPANY_A, "ESF-B") == Some(sm::ConnectionStatus::Online)
            && status_of(COMPANY_C, "ESF-C") == Some(sm::ConnectionStatus::Online)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert_eq!(status_of(COMPANY_A, "ESF-A"), Some(sm::ConnectionStatus::Online), "A deve estar online");
    assert_eq!(status_of(COMPANY_A, "ESF-B"), Some(sm::ConnectionStatus::Online), "B deve estar online");
    assert_eq!(status_of(COMPANY_C, "ESF-C"), Some(sm::ConnectionStatus::Online), "C deve estar online");

    // CENÁRIO 8: isolamento — Empresa B NUNCA recebe device da Empresa A/C.
    assert_eq!(status_of(COMPANY_B, "ESF-A"), None, "Empresa B não pode ver device da A");
    assert_eq!(status_of(COMPANY_B, "ESF-C"), None, "Empresa B não pode ver device da C");

    // CENÁRIO 3/4: queda de B (fechando sockets reais) -> offline; A e C intactos.
    drop(_tb);
    drop(_pb);
    for _ in 0..40 {
        if status_of(COMPANY_A, "ESF-B") == Some(sm::ConnectionStatus::Offline) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(status_of(COMPANY_A, "ESF-B"), Some(sm::ConnectionStatus::Offline), "B deve estar offline após saída");
    assert_eq!(status_of(COMPANY_A, "ESF-A"), Some(sm::ConnectionStatus::Online), "A NÃO deve ser afetado pela saída de B");
    assert_eq!(status_of(COMPANY_C, "ESF-C"), Some(sm::ConnectionStatus::Online), "C NÃO deve ser afetado pela saída de B");

    // Reconexão de B (novo SESSION_ID, mesmo DEVICE_ID/COMPANY_ID).
    let _tb2 = connect_tunnel(tunnel_port, COMPANY_A, "ESF-B").await;
    let _pb2 = connect_presence(presence_port, COMPANY_A, "ESF-B").await;
    for _ in 0..40 {
        if status_of(COMPANY_A, "ESF-B") == Some(sm::ConnectionStatus::Online) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(status_of(COMPANY_A, "ESF-B"), Some(sm::ConnectionStatus::Online), "B deve reconectar online");
    assert_eq!(status_of(COMPANY_A, "ESF-A"), Some(sm::ConnectionStatus::Online), "A intacto após reconexão de B");
    assert_eq!(status_of(COMPANY_C, "ESF-C"), Some(sm::ConnectionStatus::Online), "C intacto após reconexão de B");

    // CENÁRIO 5: queda de A -> offline; B/C intactos.
    drop(_ta);
    drop(_pa);
    for _ in 0..40 {
        if status_of(COMPANY_A, "ESF-A") == Some(sm::ConnectionStatus::Offline) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(status_of(COMPANY_A, "ESF-A"), Some(sm::ConnectionStatus::Offline), "A offline após queda");
    assert_eq!(status_of(COMPANY_A, "ESF-B"), Some(sm::ConnectionStatus::Online), "B intacto");
    assert_eq!(status_of(COMPANY_C, "ESF-C"), Some(sm::ConnectionStatus::Online), "C intacto");

    // Isolamento por company_id nas listagens.
    let a_devices = sm::list_by_company(COMPANY_A);
    assert!(a_devices.iter().all(|d| d.company_id == COMPANY_A), "isolamento: Empresa A só lista seus devices");
    assert!(a_devices.len() >= 2, "Empresa A deve listar A e B");

    let c_state = sm::get_state(COMPANY_C, "ESF-C");
    assert!(c_state.is_some(), "Master deve alcançar device C via company_id");

    let _ = std::fs::remove_file("./test_sim.db");
}
