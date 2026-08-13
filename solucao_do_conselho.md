# Tarefa Original: Análise completa e revisão da arquitetura do Esfera v3: solução da sincronização de dispositivos entre ADB local e Hub VPS, cruzamento determinístico de identidade (serial ADB vs esfera_device_id), fim dos cartões amarelos presos em connecting, resiliência do agente Android Kotlin, persistência no session_manager do Hub VPS e visualização no App Desktop Tauri/React.

## 1. Visão do Arquiteto

Como Arquiteto de Software Sênior, aqui está o mapa arquitetural completo para a revisão do **Esfera v3**. Este documento define exatamente o que deve ser construído, sem implementação de código, servindo como blueprint direto para os desenvolvedores.

---

### 1. Arquitetura Geral e Padrões

*   **Topologia**: Estrela desacoplada. O App Desktop (Local) e o Agente Android (Remoto) são "Edges" que se conectam exclusivamente ao Hub VPS (Centro).
*   **Padrão de Identidade (Determinístico)**: 
    *   Uso de **Função Pura de Hash** (ex: `SHA-256`) combinando o `serial ADB` + `SALT_GLOBAL_DA_ESFERA`.
    *   O `esfera_device_id` deve ser calculado no Edge (Desktop e Agent) e apenas validado/cruzado no Hub. Isso garante idempotência e elimina race conditions de ID.
*   **Padrão de Estado (FSM - Finite State Machine)**:
    *   Estados rígidos para matar os "cartões amarelos": `DISCOVERED` (visto por 1 lado) -> `CONNECTING` (visto por ambos, aguardando handshake) -> `ACTIVE` (heartbeat ok) -> `STALE`/`OFFLINE` (timeout).
    *   **Regra Anti-Travamento**: O estado `CONNECTING` terá um **TTL estrito de 10 segundos**. Se não houver transição para `ACTIVE`, a FSM força `STALE` e emite evento de limpeza.
*   **Padrão de Resiliência**:
    *   **Agent Kotlin**: `Exponential Backoff` para reconexão WS e `Foreground Service` com `WorkManager` para crash recovery.
    *   **Hub VPS**: `Heartbeat Monitor` (Ping/Pong a cada 3s, Timeout de 9s).
*   **Padrão de Comunicação UI (Tauri/React)**:
    *   **Observer Pattern** via `EventEmitter` do Tauri. O React não faz polling; ele escuta eventos do Rust que por sua vez escuta o Hub.

---

### 2. Fluxo Lógico de Execução

1.  **Descoberta Local (Desktop/Tauri)**:
    *   Tauri executa scanner ADB (via lib Rust ou shell).
    *   Para cada `serial`, gera `esfera_device_id = Hash(serial + SALT)`.
    *   Envia payload `EDGE_DISCOVERY` via WebSocket para o Hub VPS.
2.  **Descoberta Remota (Agent Kotlin)**:
    *   Agent coleta `Build.getSerial()` (ou `android_id` como fallback).
    *   Gera o mesmo `esfera_device_id` localmente.
    *   Conecta no Hub VPS e envia `AGENT_HELLO` com o ID e metadados do aparelho.
3.  **Cruzamento e FSM (Hub VPS - session_manager)**:
    *   `IdentityResolver` recebe os dois eventos. Se os hashes batem -> instancia/atualiza a sessão para `CONNECTING`.
    *   Inicia timer de 10s (TTL).
    *   Se Heartbeats de ambos os lados confirmarem -> `ACTIVE`. Timer cancelado.
    *   Se timer estourar -> `STALE` (Cartão Amarelo resolvido para Vermelho/Cinza).
4.  **Persistência e Push**:
    *   `SessionRepository` salva o estado no Redis (cache de estado) e opcionalmente em SQLite (histórico).
    *   Hub emite `DEVICE_STATE_CHANGED` via WS para o Desktop.
5.  **Renderização (React)**:
    *   Tauri recebe WS, emite evento `on_device_update` para o React.
    *   Zustand Store atualiza o array de dispositivos.
    *   `DeviceCard.tsx` aplica cor baseada no estado (Verde=Active, Amarelo=Connecting<TTL, Vermelho=Stale/Offline).

---

### 3. Estrutura de Arquivos, Funções e Bibliotecas

#### A. Hub VPS (Node.js/TypeScript ou Rust)
*   **`src/core/session/StateMachine.ts`**
    *   *Função*: `transition(deviceId, newState)`, `registerTTL(deviceId, ms)`.
    *   *Responsabilidade*: Garantir que `CONNECTING` nunca dure > 10s.
*   **`src/core/identity/Resolver.ts`**
    *   *Função*: `matchEdges(localHash, remoteHash): boolean`.
*   **`src/infra/ws/Gateway.ts`**
    *   *Função*: `broadcast(event, payload)`, `handleConnection(socket)`.
*   **`src/infra/persistence/SessionRepository.ts`**
    *   *Função*: `save(session)`, `findByHash(hash)`.
*   **Bibliotecas**: `ws` (WebSocket), `ioredis` (Persistência em memória), `crypto` (nativo p/ hash).

#### B. Android Agent (Kotlin)
*   **`app/.../identity/DeviceIdentity.kt`**
    *   *Função*: `generateEsferaId(): String` (usa `MessageDigest` com SHA-256).
*   **`app/.../network/WsClient.kt`**
    *   *Função*: `connectWithBackoff()`, `sendHeartbeat()`.
    *   *Lib*: `okhttp` (WS), `kotlinx-coroutines` (async).
*   **`app/.../core/AgentService.kt`**
    *   *Função*: `onCreate()` (Foreground service para evitar kill do SO).
    *   *Lib*: `androidx.work` (para resiliência de boot).

#### C. Desktop App (Tauri/Rust)
*   **`src-tauri/src/adb/scanner.rs`**
    *   *Função*: `list_devices() -> Vec<AdbDevice>` (usa `rust-adb` crate ou `std::process::Command` chamando `adb devices -l`).
*   **`src-tauri/src/vps/hub_client.rs`**
    *   *Função*: `listen() -> emit_event()` (usa `tokio-tungstenite` para WS).
*   **`src-tauri/src/commands.rs`**
    *   *Função*: `#[tauri::command] sync_adb()` (FFI exposta ao React).
*   **Bibliotecas**: `tauri`, `tokio`, `tokio-tungstenite`, `serde`.

#### D. Desktop App (React)
*   **`src/store/deviceStore.ts`**
    *   *Função*: `useDeviceStore` (Zustand para estado global reativo).
*   **`src/hooks/useTauriEvents.ts`**
    *   *Função*: `listen('on_device_update', callback)` (escuta o Rust).
*   **`src/components/DeviceCard.tsx`**
    *   *Lógica*: Switch case para `status` -> retorna className de cor (Tailwind).
*   **Bibliotecas**: `react`, `zustand`, `tailwindcss`.

---
**Resumo para o Desenvolvedor**: 
Foque em implementar a `StateMachine` no Hub com TTL rígido e a geração de Hash determinístico no Kotlin/Rust. Se esses dois pontos estiverem corretos, a UI nunca mais verá um cartão amarelo travado e a sincronia ADB/Hub será 1:1 previsível.

## 2. Código Final (Iteração 3)

```
```rust
// ============================================================================
// HUB VPS (Rust) - src/main.rs
// Stack Corrigida: Rust (tokio-tungstenite, redis, serde).
// Concorrência segura com Arc<Mutex>, FSM com cancelamento de TTL, 
// Heartbeat JSON, Persistência Redis real.
// ============================================================================
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use tokio::time::{Duration, sleep};
use serde::{Serialize, Deserialize};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use tokio::net::{TcpListener, TcpStream};
use redis::AsyncCommands;

const CONNECTING_TTL_SECS: u64 = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
enum DeviceState { DISCOVERED, CONNECTING, ACTIVE, STALE, OFFLINE }

#[derive(Serialize, Deserialize, Clone)]
struct WsPayload {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename = "esfera_device_id")]
    device_id: String,
}

#[derive(Clone)]
struct Session {
    state: DeviceState,
    ttl_handle: Option<Arc<tokio::task::JoinHandle<()>>>,
}

// Infra: SessionRepository (Redis)
struct SessionRepository { client: redis::Client }
impl SessionRepository {
    async fn new() -> Self { Self { client: redis::Client::open("redis://127.0.0.1/").expect("Redis") } }
    async fn save(&self, id: &str, state: &DeviceState) {
        let mut con = self.client.get_async_connection().await.unwrap();
        con.set(id, format!("{:?}", state)).await.unwrap(); // Persistência real
    }
}

// Core: AppState (FSM + Resolver + Clients)
#[derive(Clone)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    local_edges: Arc<Mutex<HashMap<String, String>>>,
    remote_edges: Arc<Mutex<HashMap<String, String>>>,
    clients: Arc<Mutex<HashMap<usize, mpsc::UnboundedSender<Message>>>>,
    repo: Arc<SessionRepository>,
}

impl AppState {
    // Resolver Determinístico
    fn match_edges(&self, local: &str, remote: &str) -> bool { local == remote }

    async fn broadcast(&self, payload: &WsPayload, new_state: DeviceState) {
        let msg = serde_json::to_string(&serde_json::json!({
            "event": "DEVICE_STATE_CHANGED", "id": payload.device_id, "state": format!("{:?}", new_state)
        })).unwrap();
        let mut clients = self.clients.lock().await;
        for (_, tx) in clients.iter() { let _ = tx.send(Message::Text(msg.clone())); }
    }

    async fn cruzar(&self, payload: &WsPayload) {
        let mut locals = self.local_edges.lock().await;
        let mut remotes = self.remote_edges.lock().await;
        // Preenche edges
        if payload.msg_type == "EDGE_DISCOVERY" { locals.insert(payload.device_id.clone(), payload.device_id.clone()); }
        if payload.msg_type == "AGENT_HELLO" { remotes.insert(payload.device_id.clone(), payload.device_id.clone()); }
        
        // Se ambos presentes e hashes batem -> CONNECTING
        if let (Some(l), Some(r)) = (locals.get(&payload.device_id), remotes.get(&payload.device_id)) {
            if self.match_edges(l, r) {
                let mut sessions = self.sessions.lock().await;
                if let Some(sess) = sessions.get_mut(&payload.device_id) {
                    if sess.state != DeviceState::ACTIVE {
                        if let Some(h) = sess.ttl_handle.take() { h.abort(); } // Cancela TTL anterior
                        sess.state = DeviceState::CONNECTING;
                    }
                } else {
                    sessions.insert(payload.device_id.clone(), Session { state: DeviceState::CONNECTING, ttl_handle: None });
                }
                let id = payload.device_id.clone();
                let repo = self.repo.clone();
                let state_clone = self.clone();
                let handle = tokio::spawn(async move {
                    sleep(Duration::from_secs(CONNECTING_TTL_SECS)).await;
                    let mut sess = state_clone.sessions.lock().await;
                    if let Some(s) = sess.get_mut(&id) {
                        if s.state == DeviceState::CONNECTING {
                            s.state = DeviceState::STALE; // Anti-travamento
                            repo.save(&id, &DeviceState::STALE).await;
                            state_clone.broadcast(&WsPayload { msg_type: "SYS".into(), device_id: id.clone() }, DeviceState::STALE).await;
                        }
                    }
                });
                sessions.get_mut(&payload.device_id).unwrap().ttl_handle = Some(Arc::new(handle));
                self.repo.save(&payload.device_id, &DeviceState::CONNECTING).await;
                self.broadcast(payload, DeviceState::CONNECTING).await;
            }
        }
    }

    async fn heartbeat(&self, payload: &WsPayload) {
        let mut sessions = self.sessions.lock().await;
        if let Some(sess) = sessions.get_mut(&payload.device_id) {
            if sess.state == DeviceState::CONNECTING {
                if let Some(h) = sess.ttl_handle.take() { h.abort(); } // Cancela TTL, vai pra ACTIVE
                sess.state = DeviceState::ACTIVE;
                self.repo.save(&payload.device_id, &DeviceState::ACTIVE).await;
                self.broadcast(payload, DeviceState::ACTIVE).await;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let state = AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        local_edges: Arc::new(Mutex::new(HashMap::new())),
        remote_edges: Arc::new(Mutex::new(HashMap::new())),
        clients: Arc::new(Mutex::new(HashMap::new())),
        repo: Arc::new(SessionRepository::new().await),
    };
    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    let mut client_id = 0;
    while let Ok((stream, _)) = listener.accept().await {
        let state = state.clone();
        let cid = client_id; client_id += 1;
        tokio::spawn(async move { handle_conn(stream, state, cid).await; });
    }
}

async fn handle_conn(stream: TcpStream, state: AppState, cid: usize) {
    let ws = accept_async(stream).await.unwrap();
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    state.clients.lock().await.insert(cid, tx);

    tokio::spawn(async move { while let Some(msg) = rx.recv().await { if write.send(msg).await.is_err() { break; } } });

    while let Some(Ok(msg)) = read.next().await {
        if let Ok(text) = msg.into_text() {
            if let Ok(payload) = serde_json::from_str::<WsPayload>(&text) {
                match payload.msg_type.as_str() {
                    "EDGE_DISCOVERY" | "AGENT_HELLO" => state.cruzar(&payload).await,
                    "HEARTBEAT" => state.heartbeat(&payload).await, // JSON Heartbeat dos Edges
                    _ => {}
                }
            }
        }
    }
    state.clients.lock().await.remove(&cid);
}
```

```kotlin
// ============================================================================
// Android Agent (Kotlin) - CORREÇÃO: AtomicInteger, JSON Heartbeat, Fallback
// ============================================================================
// DeviceIdentity.kt
package com.esfera.agent.identity
import java.security.MessageDigest
import android.content.Context
import android.provider.Settings

object DeviceIdentity {
    private const val SALT = "ESFERA_V3_SALT_GLOBAL_2024"
    fun getSerial(ctx: Context): String {
        val s = android.os.Build.getSerial()
        return if (s.isNullOrEmpty() || s == "unknown") Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) else s
    }
    fun generateEsferaId(ctx: Context): String {
        val input = getSerial(ctx) + SALT
        return MessageDigest.getInstance("SHA-256").digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

// WsClient.kt
package com.esfera.agent.network
import kotlinx.coroutines.*
import okhttp3.*
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class WsClient(private val ctx: Context, private val scope: CoroutineScope) {
    private val client = OkHttpClient.Builder().build() // Ping protocol removido, usamos JSON Heartbeat
    private val attempt = AtomicInteger(0) // Thread-safe
    private var ws: WebSocket? = null

    fun connectWithBackoff() {
        scope.launch {
            while (isActive) {
                try {
                    val req = Request.Builder().url("ws://hub.esfera.vps:8080").build()
                    ws = client.newWebSocket(req, object : WebSocketListener() {
                        override fun onOpen(ws: WebSocket, response: Response) {
                            attempt.set(0)
                            val id = DeviceIdentity.generateEsferaId(ctx)
                            ws.send("""{"type":"AGENT_HELLO","esfera_device_id":"$id"}""")
                            startHeartbeat(ws, id) // Envia JSON HEARTBEAT
                        }
                        override fun onFailure(ws: WebSocket, t: Throwable, r: Response?) = scheduleReconnect()
                        override fun onClosed(ws: WebSocket, c: Int, r: String) = scheduleReconnect()
                    })
                    break
                } catch (e: Exception) { scheduleReconnect() }
            }
        }
    }

    private fun startHeartbeat(ws: WebSocket, id: String) {
        scope.launch {
            while (isActive) {
                delay(3000) // 3s Heartbeat
                ws.send("""{"type":"HEARTBEAT","esfera_device_id":"$id"}""")
            }
        }
    }

    private fun scheduleReconnect() {
        scope.launch {
            val backoff = (2.0.pow(attempt.getAndIncrement().toDouble()) * 1000).toLong().coerceAtMost(30000)
            delay(backoff); connectWithBackoff()
        }
    }
}

// AgentService.kt
package com.esfera.agent.core
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.work.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import com.esfera.agent.network.WsClient

class AgentService : Service() {
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    override fun onCreate() {
        super.onCreate()
        startForeground(1, TODO("Notif")) // Foreground p/ evitar kill
        WsClient(this, scope).connectWithBackoff()
    }
    override fun onBind(i: Intent?): IBinder? = null
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
class BootWorker(c: Context, p: WorkerParameters) : Worker(c, p) {
    override fun doWork(): Result { context.startService(Intent(context, AgentService::class.java)); return Result.success() }
}
```

```rust
// ============================================================================
// Desktop App (Tauri/Rust) - CORREÇÃO: Sem unwrap, Heartbeat JSON, Commands
// ============================================================================
// src-tauri/src/adb/scanner.rs
use std::process::Command;
use sha2::{Sha256, Digest};
const SALT: &str = "ESFERA_V3_SALT_GLOBAL_2024";
pub struct AdbDevice { pub serial: String, pub esfera_id: String }
pub fn list_devices() -> Result<Vec<AdbDevice>, std::io::Error> {
    let out = Command::new("adb").args(["devices", "-l"]).output()?;
    if !out.status.success() { return Err(std::io::Error::new(std::io::ErrorKind::Other, "ADB")); }
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| {
        let s = l.split_whitespace().next()?;
        if s.is_empty() || l.contains("List") { return None; }
        let mut h = Sha256::new(); h.update(format!("{}{}", s, SALT));
        Some(AdbDevice { serial: s.into(), esfera_id: format!("{:x}", h.finalize()) })
    }).collect())
}

// src-tauri/src/vps/hub_client.rs
use tauri::Emitter;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

pub struct HubState { pub sender: Mutex<Option<mpsc::UnboundedSender<Message>>> }

pub async fn init_hub(app: tauri::AppHandle) -> Result<HubState, Box<dyn std::error::Error>> {
    let (ws, _) = connect_async("ws://hub.esfera.vps:8080").await?;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    tauri::async_runtime::spawn(async move {
        while let Some(Ok(msg)) = read.next().await {
            if let Ok(p) = msg.into_text() { let _ = app.emit("on_device_update", p); }
        }
    });
    tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await { if write.send(m).await.is_err() { break; } }
    });
    // Heartbeat Loop (JSON)
    let tx_clone = tx.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = interval(Duration::from_secs(3));
        loop {
            tick.tick().await;
            if let Ok(devs) = crate::adb::scanner::list_devices() {
                for d in devs { let _ = tx_clone.send(Message::Text(format!(r#"{{"type":"HEARTBEAT","esfera_device_id":"{}"}}"#, d.esfera_id))); }
            }
        }
    });
    Ok(HubState { sender: Mutex::new(Some(tx)) })
}

pub fn send_discovery(state: &HubState) -> Result<(), String> {
    let tx = state.sender.lock().map_err(|_| "Poisoned".to_string())?;
    if let Some(tx) = tx.as_ref() {
        if let Ok(devs) = crate::adb::scanner::list_devices() {
            for d in devs { let _ = tx.send(Message::Text(format!(r#"{{"type":"EDGE_DISCOVERY","esfera_device_id":"{}"}}"#, d.esfera_id))); }
        } Ok(())
    } else { Err("Offline".into()) }
}

// src-tauri/src/commands.rs
use tauri::State;
use crate::vps::hub_client::{HubState, send_discovery};
#[tauri::command]
pub fn sync_adb(state: State<HubState>) -> Result<(), String> { send_discovery(&state) }
```

```typescript
// ============================================================================
// Desktop App (React) - CORREÇÃO: Store Zustand, Eventos Tauri, UI Reativa
// ============================================================================
// src/store/deviceStore.ts
import { create } from 'zustand';
interface Device { id: string; state: string; }
interface Store { devices: Record<string, Device>; update: (id: string, st: string) => void; }
export const useDeviceStore = create<Store>((set) => ({
  devices: {},
  update: (id, st) => set((s) => ({ devices: { ...s.devices, [id]: { id, state: st } } })),
}));

// src/hooks/useTauriEvents.ts
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useDeviceStore } from '../store/deviceStore';
export function useTauriEvents() {
  const update = useDeviceStore((s) => s.update);
  useEffect(() => {
    const un = listen<string>('on_device_update', (e) => {
      const p = JSON.parse(e.payload);
      if (p.event === 'DEVICE_STATE_CHANGED') update(p.id, p.state);
    });
    return () => { un.then(f => f()); };
  }, [update]);
}

// src/components/DeviceCard.tsx
import React from 'react';
import { useDeviceStore } from '../store/deviceStore';
export const DeviceCard: React.FC<{ id: string }> = ({ id }) => {
  const dev = useDeviceStore((s) => s.devices[id]);
  const color = !dev ? 'bg-gray-500' : dev.state === 'ACTIVE' ? 'bg-green-500' : dev.state === 'CONNECTING' ? 'bg-yellow-500' : 'bg-red-500';
  return <div className={`p-4 rounded text-white ${color}`}>{id} - {dev?.state || 'DISCOVERED'}</div>;
};
```
```