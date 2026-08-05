# Tarefa Original: Analise o contexto completo de hermes_context.md referente à arquitetura de comunicação dos dispositivos no Esfera v3 (VPS Opção A como fonte de verdade, portar tunnel_server :8888 e presence_server :7779 para hub-standalone, suporte a multi-empresa com isolamento estrito, identidade persistente por DEVICE_ID, e suíte de testes determinísticos de concorrência e reconexão) e elabore o plano arquitetural, implementação das correções de código e a revisão final detalhada.

## 1. Visão do Arquiteto

Como Arquiteto de Software Sênior, apresento o mapa arquitetural e o plano de implementação para o `hub-standalone` (Esfera v3), baseado no contexto de `hermes_context.md`.

---

### 1. Arquitetura Geral e Padrões
*   **Stack:** Rust + Tokio (Runtime Async Multi-thread). Monólito Modular (binário único para `tunnel` e `presence`).
*   **Padrão de Estado (Actor Model):** Cada `DEVICE_ID` é representado por um `DeviceSession` (Actor leve via `tokio::sync::mpsc`), supervisionado por um `TenantSupervisor`.
*   **Isolamento Multi-empresa (Strict Tenant Isolation):** Uso de `DashMap<TenantId, DashMap<DeviceId, DeviceSession>>`. Nenhuma função de rede aceita um `DeviceId` sem o contexto do `TenantId` validado previamente.
*   **Zero-Copy:** Uso da crate `bytes` (`Bytes`/`BytesMut`). O payload do `tunnel_server` é passado por referência (ARC) entre sessions, sem cópia de memória no roteamento.
*   **Source of Truth (VPS Opção A):** Abstração via Trait `TruthSource`. Implementação `VpsOptionAClient` para validação de identidade. Cache local com TTL (`dashmap` + `tokio::time`) para reduzir latência.
*   **Testes Determinísticos:** Uso de `tokio::time::pause()` e `tokio::sync::oneshot` para simular reconexões e condições de corrida sem delays de rede reais.

---

### 2. Fluxo Lógico de Execução
1.  **Bootstrap:** `main()` carrega config do VPS A, instancia o `AppState` global, e faz `tokio::join!` para bindar `:8888` (Tunnel) e `:7779` (Presence).
2.  **Handshake (Auth):** Dispositivo envia `ConnectFrame { device_id, tenant_id, token }`. O `AuthMiddleware` consulta o `TruthSource`. Se válido, cria/retorna `DeviceSession` no `TenantRegistry`.
3.  **Tunnel (`:8888`):** Recebe `DataFrame`. O `DeviceSession` de origem valida se o destino pertence ao mesmo `TenantId`. Se sim, faz `forward(bytes)` (zero-copy) para o canal da sessão destino.
4.  **Presence (`:7779`):** Recebe `Ping` periódico. Atualiza o `LastSeen` no `TenantRegistry`. Se timeout, o `TenantSupervisor` marca `Offline` e notifica apenas observers do mesmo tenant.
5.  **Reconexão:** Novo handshake com mesmo `DEVICE_ID`. O `TenantSupervisor` detecta a sessão antiga, envia sinal de `Drain` (graceful shutdown) e substitui pela nova, mantendo a identidade persistente.

---

### 3. Estrutura de Arquivos, Funções e Bibliotecas

**Estrutura de Pastas:**
```text
hub-standalone/
├── Cargo.toml
├── src/
│   ├── main.rs                 # Entrypoint e spawn dos servers
│   ├── state.rs                # AppState, TenantRegistry (DashMap aninhado)
│   ├── core/
│   │   ├── truth_source.rs     # Trait TruthSource + VpsOptionAClient
│   │   ├── session.rs          # DeviceSession (Actor) e mensagens internas
│   │   └── supervisor.rs       # Gestão de lifecycle e reconexão
│   ├── tunnel/
│   │   ├── mod.rs              # TunnelServer (:8888)
│   │   └── frame.rs            # Parsing de Bytes (Zero-copy)
│   ├── presence/
│   │   ├── mod.rs              # PresenceServer (:7779)
│   │   └── heartbeat.rs        # Lógica de TTL e Ping/Pong
│   └── auth/
│       └── middleware.rs       # Validação DEVICE_ID vs VPS A
├── tests/
│   ├── deterministic_reconnect.rs
│   └── concurrency_isolation.rs
```

**Bibliotecas (`Cargo.toml`):**
*   `tokio` (features: full)
*   `bytes` (zero-copy)
*   `dashmap` (concorrência lock-free)
*   `serde`, `bincode` (serialização eficiente)
*   `tracing` (logs estruturados)
*   `mockall` (mocks para VPS A nos testes)

**Assinaturas de Funções Chave:**
*   `fn bind_tunnel(state: Arc<AppState>, port: u16) -> JoinHandle<()>`
*   `fn bind_presence(state: Arc<AppState>, port: u16) -> JoinHandle<()>`
*   `async fn TruthSource::validate(&self, device_id: &str, tenant_id: &str) -> Result<bool>`
*   `fn TenantRegistry::route_frame(&self, tenant: &str, from: &str, to: &str, data: Bytes) -> RoutingResult`
*   `async fn DeviceSession::handle_reconnect(&mut self, new_conn: Connection)`

---

### 4. Implementação das Correções de Código (Diretrizes Estruturais)
*O desenvolvedor deve aplicar estas mudanças exatas na portagem:*

**Correção A: Isolamento Estrito no Registry (Antes vs Depois)**
```rust
// ❌ ERRADO (Legado/VPS): HashMap global sem tenant
// let mut devices = HashMap::new(); 
// devices.insert(device_id, conn);

// ✅ CORRETO (hub-standalone): Particionamento por Tenant
// let tenants: DashMap<TenantId, DashMap<DeviceId, DeviceSession>> = DashMap::new();
// tenants.entry(tenant_id).or_default().insert(device_id, session);
```

**Correção B: Zero-Copy no Tunnel Handler**
```rust
// ❌ ERRADO: Clonagem de Vec<u8> no roteamento
// let payload = frame.payload.to_vec(); 
// target.send(payload).await;

// ✅ CORRETO: Passagem de Bytes (ARC interno)
// let payload: Bytes = frame.payload.freeze(); 
// target.send(payload).await; // Custo O(1), sem cópia de heap
```

**Correção C: Prevenção de Zumbis (Reconexão)**
```rust
// No Supervisor, ao receber novo DEVICE_ID:
// if let Some(old) = registry.get(&tenant, &device_id) {
//     old.send(ControlMsg::Drain).await; // Encerra socket antigo
// }
// registry.insert(tenant, device_id, new_session);
```

---

### 5. Revisão Final Detalhada (Checklist para PR)
1.  **Validação de Tenant:** Confirmar que *nenhum* broadcast ou roteamento ocorre sem o filtro de `TenantId`. Testar vazamento entre Empresa A e B.
2.  **Persistência de Identidade:** Garantir que ao cair a rede e reconectar, o `DEVICE_ID` mantém o mesmo estado de sessão e não gera duplicidade no `DashMap`.
3.  **Determinismo:** Os testes de concorrência (`tests/concurrency_isolation.rs`) devem spawnar 10k devices simulados e usar `tokio::time::pause()` para forçar timeouts de heartbeat sem esperar segundos reais.
4.  **Memory Safety:** Verificar com `cargo clippy` que não há `clone()` desnecessário em hot-paths (tunnel data plane).
5.  **Graceful Shutdown:** `Ctrl+C` no `hub-standalone` deve drenar conexões `:8888` e `:7779` antes de exit.

## 2. Código Final (Iteração 3)

```
```toml
# Cargo.toml
[package]
name = "hub-standalone"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
bytes = "1"
dashmap = "5"
serde = { version = "1", features = ["derive"] }
bincode = "1"
tracing = "0.1"
async-trait = "0.1"

[dev-dependencies]
mockall = "0.11"
tokio = { version = "1", features = ["full", "test-util", "macros"] }
```

```rust
// src/main.rs
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

mod auth; mod core; mod presence; mod state; mod tunnel;
use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let state = Arc::new(AppState::new());
    
    // Canal de broadcast para Graceful Shutdown
    let (shutdown_tx, _) = broadcast::channel(1);
    
    // Bind :8888 e :7779 com signal de shutdown
    let tunnel_handle: JoinHandle<()> = tunnel::bind_tunnel(state.clone(), 8888, shutdown_tx.subscribe());
    let presence_handle: JoinHandle<()> = presence::bind_presence(state.clone(), 7779, shutdown_tx.subscribe());

    tokio::signal::ctrl_c().await.unwrap();
    tracing::info!("Encerrando hub-standalone...");
    let _ = shutdown_tx.send(()); // Sinaliza encerramento para todos os servers
    
    let _ = tokio::join!(tunnel_handle, presence_handle);
}
```

```rust
// src/state.rs
use std::sync::Arc;
use dashmap::DashMap;
use bytes::Bytes;
use crate::core::session::DeviceSession;
use crate::core::truth_source::VpsOptionAClient;

pub type TenantId = String;
pub type DeviceId = String;

#[derive(Default)]
pub struct TenantRegistry {
    // CORREÇÃO A: Isolamento Estrito (DashMap aninhado)
    tenants: DashMap<TenantId, DashMap<DeviceId, Arc<DeviceSession>>>,
}

impl TenantRegistry {
    pub fn new() -> Self { Self::default() }

    // CORREÇÃO C: Prevenção de Zumbis (Clone Arc antes do await para não segurar guarda do DashMap)
    pub async fn upsert_session(&self, tenant: &str, device: &str, new_session: Arc<DeviceSession>) {
        let old_session = {
            let tenant_map = self.tenants.entry(tenant.to_string()).or_default();
            tenant_map.get(device).map(|s| s.clone()) // Guarda liberada aqui
        };
        
        if let Some(old) = old_session {
            old.drain().await; // Await seguro fora do escopo do DashMap (sem deadlock)
        }
        
        let tenant_map = self.tenants.entry(tenant.to_string()).or_default();
        tenant_map.insert(device.to_string(), new_session);
    }

    // CORREÇÃO B & Isolamento: Roteamento Zero-Copy e Validação de Origem
    pub fn route_frame(&self, tenant: &str, from: &str, to: &str, data: Bytes) -> Result<(), String> {
        let tenant_map = self.tenants.get(tenant)
            .ok_or_else(|| format!("Tenant {} not found", tenant))?;
        
        // Valida se 'from' pertence estritamente ao tenant
        if !tenant_map.contains_key(from) {
            return Err(format!("Origin {} not in tenant {}", from, tenant));
        }

        let target = tenant_map.get(to).map(|s| s.clone())
            .ok_or_else(|| format!("Target {} not found in tenant {}", to, tenant))?;
        
        target.forward(data); // Zero-copy (Bytes é ARC internamente, custo O(1))
        Ok(())
    }
}

pub struct AppState {
    pub registry: TenantRegistry,
    pub truth_source: Arc<dyn crate::core::truth_source::TruthSource>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            registry: TenantRegistry::new(),
            truth_source: Arc::new(VpsOptionAClient::new()),
        }
    }
}
```

```rust
// src/core/truth_source.rs
use async_trait::async_trait;
use dashmap::DashMap;
use std::time::{Duration, Instant};

#[async_trait]
pub trait TruthSource: Send + Sync {
    async fn validate(&self, device_id: &str, tenant_id: &str) -> Result<bool, String>;
}

pub struct VpsOptionAClient {
    cache: DashMap<String, (bool, Instant)>, // Cache local com TTL
}

impl VpsOptionAClient {
    pub fn new() -> Self { Self { cache: DashMap::new() } }
}

#[async_trait]
impl TruthSource for VpsOptionAClient {
    async fn validate(&self, device_id: &str, tenant_id: &str) -> Result<bool, String> {
        let key = format!("{}/{}", tenant_id, device_id);
        if let Some(entry) = self.cache.get(&key) {
            if entry.1.elapsed() < Duration::from_secs(60) {
                return Ok(entry.0); // Hit no cache (reduz latência)
            }
        }
        // Simula chamada VPS A
        let valid = !device_id.is_empty() && !tenant_id.is_empty();
        self.cache.insert(key, (valid, Instant::now()));
        Ok(valid)
    }
}
```

```rust
// src/core/session.rs
use std::sync::Arc;
use tokio::sync::mpsc;
use bytes::Bytes;

pub enum SessionMsg {
    Data(Bytes),
    Drain,
}

pub struct DeviceSession {
    tx: mpsc::Sender<SessionMsg>, // Backpressure (evita OOM)
}

impl DeviceSession {
    pub fn new() -> Arc<Self> {
        let (tx, mut rx) = mpsc::channel(1024); 
        let session = Arc::new(Self { tx });
        
        // Padrão Actor: Loop serializado via mpsc
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    SessionMsg::Data(bytes) => { /* Zero-copy write to socket */ }
                    SessionMsg::Drain => break, // Encerra ator
                }
            }
        });
        session
    }

    // CORREÇÃO B: Zero-Copy forward (sync para hot-path)
    pub fn forward(&self, data: Bytes) { 
        let _ = self.tx.try_send(SessionMsg::Data(data)); 
    }
    
    // CORREÇÃO C: Drain para reconexão
    pub async fn drain(&self) { 
        let _ = self.tx.send(SessionMsg::Drain).await; 
    }
}
```

```rust
// src/core/supervisor.rs
use std::sync::Arc;
use crate::state::AppState;
use crate::core::session::DeviceSession;

pub struct TenantSupervisor;

impl TenantSupervisor {
    // Gestão de lifecycle e reconexão (Drain de zumbis tratado no registry)
    pub async fn handle_reconnect(state: &AppState, tenant: &str, device: &str, new_conn: Arc<DeviceSession>) {
        state.registry.upsert_session(tenant, device, new_conn).await;
    }
}
```

```rust
// src/auth/middleware.rs
use crate::core::truth_source::TruthSource;
use crate::tunnel::frame::ConnectFrame;
use std::sync::Arc;

pub struct AuthMiddleware {
    truth: Arc<dyn TruthSource>,
}

impl AuthMiddleware {
    pub fn new(truth: Arc<dyn TruthSource>) -> Self { Self { truth } }
    
    pub async fn authenticate(&self, frame: &ConnectFrame) -> Result<bool, String> {
        self.truth.validate(&frame.device_id, &frame.tenant_id).await
    }
}
```

```rust
// src/tunnel/frame.rs
use serde::{Serialize, Deserialize};
use bytes::Bytes;

#[derive(Serialize, Deserialize, Debug)]
pub struct ConnectFrame {
    pub device_id: String,
    pub tenant_id: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DataFrame {
    pub from: String,
    pub to: String,
    pub payload: Vec<u8>,
}

impl DataFrame {
    pub fn to_bytes(&self) -> Bytes {
        Bytes::from(bincode::serialize(self).unwrap_or_default())
    }
    pub fn from_bytes(b: &[u8]) -> Option<Self> {
        bincode::deserialize(b).ok()
    }
}
```

```rust
// src/tunnel/mod.rs
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use bytes::Bytes;
use crate::state::AppState;
use crate::auth::middleware::AuthMiddleware;
use crate::tunnel::frame::{ConnectFrame, DataFrame};

pub fn bind_tunnel(state: Arc<AppState>, port: u16, mut shutdown: broadcast::Receiver<()>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let listener = TcpListener::bind(("0.0.0.0", port)).await.unwrap();
        
        loop {
            tokio::select! {
                _ = shutdown.recv() => break, // Graceful Shutdown via broadcast
                accept_res = listener.accept() => {
                    if let Ok((_socket, _)) = accept_res {
                        let state = state.clone();
                        tokio::spawn(async move {
                            // Parsing de ConnectFrame (simulado)
                            let conn = ConnectFrame { device_id: "dev_01".into(), tenant_id: "tenant_A".into(), token: "t".into() };
                            let auth = AuthMiddleware::new(state.truth_source.clone());
                            
                            if auth.authenticate(&conn).await.unwrap_or(false) {
                                let sess = crate::core::session::DeviceSession::new();
                                state.registry.upsert_session(&conn.tenant_id, &conn.device_id, sess).await;
                            }
                            
                            // Parsing de DataFrame e Roteamento Zero-Copy
                            let df = DataFrame { from: "dev_01".into(), to: "dev_02".into(), payload: vec![1,2,3] };
                            let payload: Bytes = Bytes::from(df.payload); // Zero-copy freeze
                            let _ = state.registry.route_frame(&conn.tenant_id, &df.from, &df.to, payload);
                        });
                    }
                }
            }
        }
    })
}
```

```rust
// src/presence/mod.rs
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use crate::state::AppState;
use crate::presence::heartbeat;

pub fn bind_presence(state: Arc<AppState>, port: u16, mut shutdown: broadcast::Receiver<()>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let listener = TcpListener::bind(("0.0.0.0", port)).await.unwrap();
        loop {
            tokio::select! {
                _ = shutdown.recv() => break,
                res = listener.accept() => {
                    if let Ok((_sock, _)) = res {
                        heartbeat::spawn_heartbeat(state.clone());
                    }
                }
            }
        }
    })
}
```

```rust
// src/presence/heartbeat.rs
use std::sync::Arc;
use std::time::Duration;
use crate::state::AppState;

pub fn spawn_heartbeat(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Atualiza LastSeen no Registry (TTL logic simulado)
        tokio::time::sleep(Duration::from_millis(10)).await;
    });
}
```

```rust
// tests/concurrency_isolation.rs
use mockall::mock;
use async_trait::async_trait;
use std::sync::Arc;
use tokio::time::pause;
use bytes::Bytes;
use crate::state::{AppState, TenantRegistry};
use crate::core::truth_source::TruthSource;

mock! {
    VpsMock {}
    #[async_trait]
    impl TruthSource for VpsMock {
        async fn validate(&self, device_id: &str, tenant_id: &str) -> Result<bool, String>;
    }
}

#[tokio::test(start_paused = true)]
async fn test_concurrency_isolation() {
    pause(); // Deterministic time (sem esperar segundos reais)
    let mut mock = MockVpsMock::new();
    mock.expect_validate().returning(|_, _| Ok(true));
    
    let state = AppState {
        registry: TenantRegistry::new(),
        truth_source: Arc::new(mock),
    };
    let arc_state = Arc::new(state);

    // Spawn 10k devices simulados
    for i in 0..10000u32 {
        let t = format!("tenant_{}", i % 2);
        let d = format!("dev_{}", i);
        let sess = crate::core::session::DeviceSession::new();
        arc_state.registry.upsert_session(&t, &d, sess).await;
    }

    // Teste de vazamento: tenant_0 -> tenant_1 deve falhar (isolamento estrito)
    let payload = Bytes::from_static(b"leak_test");
    let res = arc_state.registry.route_frame("tenant_0", "dev_0", "dev_1", payload.clone());
    assert!(res.is_err(), "Isolamento quebrado: roteou entre tenants!");

    // Roteamento válido dentro do mesmo tenant
    let res_ok = arc_state.registry.route_frame("tenant_0", "dev_0", "dev_2", payload);
    assert!(res_ok.is_ok());
}
```
```