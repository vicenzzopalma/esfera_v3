// ============================================================
// Esfera v3 — Hub Standalone — Servidor MQTT Secundário (Porta 1883)
// (mqtt_fallback_server.rs)
//
// CANAL SECUNDÁRIO E REDUNDANTE DE PRESENÇA E TELEMETRIA
// Quando as portas TCP diretas ou WebSocket forem filtradas por
// operadoras/firewalls móveis (CGNAT), os dispositivos publicam
// heartbeats e status no tópico MQTT `esfera/device/<esfera_id>/heartbeat`.
// ============================================================

use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use crate::session_manager;

pub async fn start(port: u16) {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[MQTT Fallback] Erro ao abrir porta {}: {}", port, e);
            return;
        }
    };

    println!("[MQTT Fallback] Listener ativo na porta TCP {} (Canal Secundário)", port);

    loop {
        match listener.accept().await {
            Ok((mut socket, remote_addr)) => {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    loop {
                        match socket.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                let payload = String::from_utf8_lossy(&buf[..n]);
                                if payload.contains("ESF-") {
                                    for line in payload.lines() {
                                        if line.contains("ESF-") {
                                            let parts: Vec<&str> = line.split(':').collect();
                                            if parts.len() >= 2 {
                                                let esfera_id = parts[0].trim();
                                                let comp_id = parts[1].trim().parse::<i32>().unwrap_or(1);
                                                session_manager::touch_presence(comp_id, esfera_id, &remote_addr.ip().to_string());
                                            }
                                        }
                                    }
                                }
                                // Resposta MQTT CONNACK / PINGRESP simplificada
                                let _ = socket.write_all(b"\x20\x02\x00\x00").await;
                            }
                            Err(_) => break,
                        }
                    }
                });
            }
            Err(_) => {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
    }
}
