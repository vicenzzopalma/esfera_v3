# Tarefa Original: Auditoria e avaliacao do Conselho de IAs para APROVACAO DO ESTADO ATUAL do sistema Esfera v3 (v3.13.0): Arquitetura Hibrida MDM Enterprise (Device Owner / DPC com AdminReceiver), resiliencia de check-in com auto-provisionamento de CompanyId em Rust db.rs, transporte encriptado TLS 443/8443 no VPS hub-standalone, motor de roteamento C++ com AVX2/SIMD, e allowlist de comandos remotos de seguranca no agente Kotlin

## 1. Visão do Arquiteto

Aqui está o mapa arquitetural e de implementação para o sistema **Esfera v3 (v3.13.0)**, estruturado para atender aos requisitos de MDM, resiliência, transporte seguro, roteamento de alta performance e auditoria pelo Conselho de IAs.

### 1. Arquitetura Geral e Padrões
*   **Topologia**: Monorepo Poliglota com fronteiras FFI (Foreign Function Interface) estritas e contrato de dados via Protobuf/FlatBuffers.
*   **MDM (Kotlin/Android)**: Padrão `Device Owner` com `DeviceAdminReceiver` (Proxy/Receiver) para imposição de políticas de segurança.
*   **Resiliência e DB (Rust)**: Padrão `Repository` em `db.rs` usando `tokio` (assíncrono) e `rusqlite`/`sqlx` para auto-provisionamento de `CompanyId` com retry/backoff.
*   **Transporte (VPS Hub - Rust)**: Padrão `Async Server` (`tokio` + `rustls`) escutando TLS 1.3 nas portas 443/8443.
*   **Motor de Roteamento (C++)**: Padrão `Strategy` com otimização `SIMD/AVX2` via intrínsecos (`<immintrin.h>`), exposto via ABI C (`extern "C"`) para FFI com o Hub Rust.
*   **Allowlist (Kotlin)**: Padrão `Command Pattern` com `Map<CommandId, SecurityAction>` imutável (thread-safe).
*   **Conselho de IAs (Auditoria)**: Padrão `Observer/Pipeline` (Módulo Rust no Hub) que coleta telemetria assinada (Ed25519) dos nós e emite `ApprovalState`.

### 2. Fluxo Lógico de Execução
1.  **Inicialização MDM**: Agente Kotlin é provisionado como Device Owner; `AdminReceiver` registra políticas restritas.
2.  **Check-in Resiliente**: Agente Kotlin abre canal TLS 443 com o Hub. Em caso de falha de rede, executa retry com jitter exponencial.
3.  **Auto-Provisionamento (Rust)**: Hub recebe o handshake e chama `db.rs::ensure_company_id()`. Se o `CompanyId` estiver ausente, gera e persiste atomicamente.
4.  **Roteamento (C++)**: Hub invoca `librouting::compute_route_avx2()` via FFI para processar a regra de roteamento do payload com instruções vetoriais.
5.  **Execução Segura**: Hub envia comando cifrado ao Agente. O Agente valida o `CommandId` contra a `SecurityAllowlist` antes de executar qualquer ação.
6.  **Auditoria (AI Council)**: Módulo de Auditoria consome snapshots de saúde (Kotlin, Rust DB, C++ Engine). Valida integridade (AVX2 ativo, TLS válido, Allowlist intacta, CompanyId presente) e emite `SystemApproval::Approved` ou `Rejected`.

### 3. Estrutura de Arquivos, Funções e Bibliotecas

```text
esfera-v3/
├── android-agent/ (Kotlin)
│   ├── build.gradle (Dep: androidx.work, okhttp, protobuf)
│   ├── receiver/
│   │   └── EsferaAdminReceiver.kt (Extends DeviceAdminReceiver)
│   ├── network/
│   │   └── SecureCheckInClient.kt (OkHttp com TLS Pinning)
│   ├── security/
│   │   └── CommandAllowlist.kt (Map imutável de comandos permitidos)
│   └── audit/
│       └── CouncilTelemetry.kt (Coleta e assina estado local p/ o Hub)
│
├── hub-standalone/ (Rust)
│   ├── Cargo.toml (Dep: tokio, rustls, rusqlite, serde, ed25519-dalek)
│   ├── src/
│   │   ├── main.rs (Bootstrap do servidor TLS 443/8443)
│   │   ├── db.rs (Lógica de persistência e CompanyId)
│   │   ├── ffi.rs (Links externos para librouting C++)
│   │   └── ai_council.rs (Motor de auditoria e aprovação)
│
├── routing-engine/ (C++)
│   ├── CMakeLists.txt (Flags: -mavx2 -O3)
│   ├── include/
│   │   └── routing.h (Assinaturas extern "C")
│   └── src/
│       └── router_avx2.cpp (Lógica SIMD com _mm256_*)
│
└── shared-proto/ (Protobuf)
    └── esfera.proto (Definição de CheckIn, Command, AuditSnapshot)
```

**Assinaturas de Funções Essenciais (Para o Desenvolvedor Implementar):**

*   **Kotlin (`EsferaAdminReceiver.kt`)**:
    ```kotlin
    class EsferaAdminReceiver : DeviceAdminReceiver() {
        override fun onEnabled(context: Context, intent: Intent) { /* Lock task mode */ }
        override fun onReceive(context: Context, intent: Intent) { /* Proxy p/ allowlist */ }
    }
    ```
*   **Kotlin (`CommandAllowlist.kt`)**:
    ```kotlin
    object CommandAllowlist {
        val allowed: Map<String, (Context) -> Unit> = mapOf(
            "SEC_WIPE" to { ctx -> /* lógica DPC */ },
            "SEC_LOCK" to { ctx -> /* lock now */ }
        )
    }
    ```
*   **Rust (`db.rs`)**:
    ```rust
    pub async fn ensure_company_id(device_hash: &str) -> Result<String, DbError> {
        // 1. SELECT company_id FROM devices WHERE hash = ?
        // 2. Se None: INSERT com UUIDv4 (auto-provisioning)
        // 3. Retorna CompanyId
    }
    ```
*   **C++ (`routing.h` / `router_avx2.cpp`)**:
    ```cpp
    extern "C" RoutingResult* route_packet_avx2(const uint8_t* payload, size_t len);
    // Implementação usa __m256i para processar regras de roteamento em paralelo.
    ```
*   **Rust (`ai_council.rs`)**:
    ```rust
    pub struct AuditEngine;
    impl AuditEngine {
        pub fn evaluate_and_approve(snapshot: &SystemSnapshot) -> ApprovalStatus {
            // Valida: TLS ativo, AVX2 disponível (via FFI), Allowlist não violada, CompanyId != ""
            // Retorna ApprovalStatus::Approved ou Rejected
        }
    }
    ```

**Bibliotecas Críticas:**
*   **Kotlin**: `androidx.work`, `okhttp3`, `protobuf-kotlin`.
*   **Rust**: `tokio` (async), `rustls` (TLS), `rusqlite` (DB), `cbindgen` (geração de header C++), `ed25519-dalek` (assinaturas de auditoria).
*   **C++**: `STL`, `<immintrin.h>` (intrínsecos AVX2), `CMake`.

## 2. Código Final (Iteração 3)

```
### C++ (`routing-engine/src/router_avx2.cpp`)
```cpp
#include "routing.h"
#include <immintrin.h>
#include <cstdlib>

extern "C" {

// Corrige processamento de payloads > 32 bytes (loop vetorial)
RoutingResult* route_packet_avx2(const uint8_t* payload, size_t len) {
    auto* res = static_cast<RoutingResult*>(malloc(sizeof(RoutingResult)));
    if (!res) return nullptr;

    res->target_node_id = 0;
    res->priority = 0;
    res->status = 1; // Default DROP

    if (len < 32) return res;

    __m256i max_prio = _mm256_setzero_si256();
    __m256i max_nodes = _mm256_setzero_si256();

    // Processa todo o payload em blocos de 256 bits
    size_t offset = 0;
    while (offset + 32 <= len) {
        __m256i data = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(payload + offset));
        
        __m256i node_mask = _mm256_set1_epi32(0xFF000000);
        __m256i prio_mask = _mm256_set1_epi32(0x00FF0000);
        __m256i nodes = _mm256_srli_epi32(_mm256_and_si256(data, node_mask), 24);
        __m256i prios = _mm256_srli_epi32(_mm256_and_si256(data, prio_mask), 16);
        
        // Redução intra-bloco SIMD
        __m256i shuf_p, shuf_n, cmp;
        shuf_p = _mm256_shuffle_epi32(prios, _MM_SHUFFLE(2, 3, 0, 1));
        shuf_n = _mm256_shuffle_epi32(nodes, _MM_SHUFFLE(2, 3, 0, 1));
        cmp = _mm256_cmpgt_epi32(shuf_p, prios);
        prios = _mm256_max_epi32(prios, shuf_p);
        nodes = _mm256_blendv_epi8(nodes, shuf_n, cmp);
        
        shuf_p = _mm256_shuffle_epi32(prios, _MM_SHUFFLE(1, 0, 3, 2));
        shuf_n = _mm256_shuffle_epi32(nodes, _MM_SHUFFLE(1, 0, 3, 2));
        cmp = _mm256_cmpgt_epi32(shuf_p, prios);
        prios = _mm256_max_epi32(prios, shuf_p);
        nodes = _mm256_blendv_epi8(nodes, shuf_n, cmp);
        
        // Acumula no global
        cmp = _mm256_cmpgt_epi32(prios, max_prio);
        max_prio = _mm256_max_epi32(max_prio, prios);
        max_nodes = _mm256_blendv_epi8(max_nodes, nodes, cmp);
        
        offset += 32;
    }

    res->priority = static_cast<uint8_t>(_mm256_extract_epi32(max_prio, 0));
    res->target_node_id = static_cast<uint32_t>(_mm256_extract_epi32(max_nodes, 0));
    res->status = 0;
    return res;
}

void free_routing_result(RoutingResult* res) { free(res); }
}
```

### Rust (`hub-standalone/src/db.rs`)
```rust
use sqlx::{sqlite::SqlitePool, Error as SqlxError};
use uuid::Uuid;
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug)]
pub enum DbError { Sqlx(SqlxError), RetryExhausted }

pub struct DeviceRepository { pool: SqlitePool }

impl DeviceRepository {
    pub async fn new(path: &str) -> Result<Self, DbError> {
        let pool = SqlitePool::connect(&format!("sqlite://{}?mode=rwc", path)).await.map_err(DbError::Sqlx)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, device_hash TEXT UNIQUE NOT NULL, company_id TEXT NOT NULL)")
            .execute(&pool).await.map_err(DbError::Sqlx)?;
        Ok(Self { pool })
    }

    pub async fn ensure_company_id(&self, device_hash: &str) -> Result<String, DbError> {
        let mut attempts = 0;
        loop {
            match self.try_ensure(device_hash).await {
                Ok(id) => return Ok(id),
                Err(_) => {
                    if attempts >= 5 { return Err(DbError::RetryExhausted); }
                    sleep(Duration::from_millis(100 * (1 << attempts) as u64)).await;
                    attempts += 1;
                }
            }
        }
    }

    // Corrige Race Condition com INSERT OR IGNORE + SELECT
    async fn try_ensure(&self, device_hash: &str) -> Result<String, DbError> {
        let new_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT OR IGNORE INTO devices (device_hash, company_id) VALUES (?, ?)")
            .bind(device_hash).bind(&new_id).execute(&self.pool).await.map_err(DbError::Sqlx)?;
        
        let row: Option<(String,)> = sqlx::query_as("SELECT company_id FROM devices WHERE device_hash = ?")
            .bind(device_hash).fetch_optional(&self.pool).await.map_err(DbError::Sqlx)?;
        
        row.map(|(id,)| id).ok_or(DbError::Sqlx(SqlxError::RowNotFound))
    }
}
```

### Rust (`hub-standalone/src/ffi.rs`)
```rust
use std::os::raw::{c_uchar, c_size_t};

#[repr(C)]
pub struct RoutingResult { pub target_node_id: u32, pub priority: u8, pub status: u8 }

extern "C" {
    fn route_packet_avx2(payload: *const c_uchar, len: c_size_t) -> *mut RoutingResult;
    fn free_routing_result(res: *mut RoutingResult);
}

// Garante liberação de memória C++ (sem memory leak)
pub fn compute_route(payload: &[u8]) -> Option<RoutingResult> {
    unsafe {
        let ptr = route_packet_avx2(payload.as_ptr(), payload.len());
        if ptr.is_null() { return None; }
        let result = ptr.read();
        free_routing_result(ptr);
        if result.status == 0 { Some(result) } else { None }
    }
}
```

### Rust (`hub-standalone/src/main.rs`)
```rust
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use rustls::{ServerConfig, NoClientAuth, ProtocolVersion};
use std::sync::Arc;
use std::fs::File;
use std::io::BufReader;
use rustls_pemfile as pemfile;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use crate::db::DeviceRepository;
use crate::ffi::compute_route;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let repo = Arc::new(DeviceRepository::new("esfera.db").await?);
    
    let mut config = ServerConfig::new(NoClientAuth::new());
    let cert_file = &mut BufReader::new(File::open("certs/cert.pem")?);
    let key_file = &mut BufReader::new(File::open("certs/key.pem")?);
    config.set_single_cert(pemfile::certs(cert_file)?, pemfile::pkcs8_private_keys(key_file)?.remove(0))?;
    config.versions = vec![ProtocolVersion::TLSv1_3];
    
    let acceptor = TlsAcceptor::from(Arc::new(config));
    
    for port in [443, 8443] {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
        println!("[HUB] Esfera v3.13.0 TLS 1.3 Listener ativo ({})", port);
        let acceptor = acceptor.clone();
        let repo = repo.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    let acceptor = acceptor.clone();
                    let repo = repo.clone();
                    tokio::spawn(async move {
                        if let Ok(mut tls_stream) = acceptor.accept(stream).await {
                            // Handshake / Check-in (len-prefix proto)
                            let mut len_buf = [0u8; 2];
                            if tls_stream.read_exact(&mut len_buf).await.is_ok() {
                                let plen = u16::from_be_bytes(len_buf) as usize;
                                let mut payload = vec![0u8; plen];
                                if tls_stream.read_exact(&mut payload).await.is_ok() {
                                    let dev_hash = format!("dev_{:?}", &payload[..std::cmp::min(8, plen)]);
                                    // Auto-provisionamento e Roteamento
                                    if let Ok(cid) = repo.ensure_company_id(&dev_hash).await {
                                        let _route = compute_route(&payload); // FFI com free interno
                                        let _ = tls_stream.write_all(format!("CMD:SEC_LOCK:{}", cid).as_bytes()).await;
                                    }
                                }
                            }
                        }
                    });
                }
            }
        });
    }
    tokio::signal::ctrl_c().await?;
    Ok(())
}
```

### Kotlin (`android-agent/network/SecureCheckInClient.kt`)
```kotlin
package com.esfera.agent.network

import okhttp3.CertificatePinner
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit
import kotlin.random.Random

// Retry com jitter exponencial customizado
class BackoffInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var attempt = 0
        var lastErr: Exception? = null
        while (attempt < 5) {
            try {
                val res = chain.proceed(chain.request())
                if (res.isSuccessful) return res
                res.close()
            } catch (e: Exception) { lastErr = e }
            TimeUnit.MILLISECONDS.sleep((100 * (1 shl attempt)) + Random.nextLong(0, 50))
            attempt++
        }
        throw lastErr ?: RuntimeException("Check-in falhou")
    }
}

class SecureCheckInClient {
    private val pinner = CertificatePinner.Builder()
        .add("hub.esfera.local", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").build()

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .certificatePinner(pinner)
        .addInterceptor(BackoffInterceptor()) // Resiliência exigida
        .build()
}
```

### Kotlin (`android-agent/audit/CouncilTelemetry.kt`)
```kotlin
package com.esfera.agent.audit

import android.content.Context
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import com.esfera.agent.receiver.EsferaAdminReceiver
import com.esfera.agent.security.CommandAllowlist
import java.security.KeyStore
import java.security.Signature

object CouncilTelemetry {
    private const val ALIAS = "esfera_ed25519"

    // Chave persistente no AndroidKeyStore (não gera a cada chamada)
    private fun ensureKey(context: Context) {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(ALIAS)) {
            val kpg = java.security.KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore")
            kpg.initialize(android.security.keystore.KeyGenParameterSpec.Builder(
                ALIAS, android.security.keystore.KeyProperties.PURPOSE_SIGN).build())
            kpg.generateKeyPair()
        }
    }

    // Coleta abrangente (company_id, tls, avx2, etc.)
    fun collectSnapshot(ctx: Context, cidPresent: Boolean, tls: Boolean, avx2: Boolean): Map<String, Boolean> {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(ctx, EsferaAdminReceiver::class.java)
        return mapOf(
            "dpc_active" to (dpm.isDeviceOwnerApp(ctx.packageName) && dpm.isAdminActive(admin)),
            "allowlist_intact" to (CommandAllowlist.isAllowed("SEC_WIPE") && CommandAllowlist.isAllowed("SEC_LOCK")),
            "company_id_present" to cidPresent,
            "tls_active" to tls,
            "avx2_available" to avx2
        )
    }

    fun signSnapshot(context: Context, data: ByteArray): ByteArray {
        ensureKey(context)
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val pk = (ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry).privateKey
        return Signature.getInstance("Ed25519").apply {
            initSign(pk); update(data)
        }.sign()
    }
}
```

### Kotlin (`android-agent/receiver/EsferaAdminReceiver.kt`)
```kotlin
package com.esfera.agent.receiver

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.esfera.agent.security.CommandAllowlist

class EsferaAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        // Delega LockTask para Activity (corrige compilação)
        context.startActivity(Intent(context, LockTaskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // Proxy p/ Allowlist (Passo 5)
        intent.getStringExtra("COMMAND_ID")?.takeIf { CommandAllowlist.isAllowed(it) }
            ?.let { CommandAllowlist.allowed[it]?.invoke(context) }
    }
}
```
```