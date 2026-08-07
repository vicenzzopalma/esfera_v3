// Biblioteca do hub-standalone (permite testes de integração importarem os módulos).
pub mod db;
pub mod protocol;
pub mod hub;
pub mod checkin_server;
pub mod tunnel_server;
pub mod presence_server;
pub mod session_manager;
pub mod tls_server;

use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpSocket};

/// Bind com SO_REUSEADDR para permitir self-restart limpo do hub (o novo
/// processo consegue re-bindar a porta enquanto o antigo ainda está no gap de
/// exit). Essencial para o self-update remoto (POST /admin/update).
pub async fn bind_reuse(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    socket.listen(1024)
}
