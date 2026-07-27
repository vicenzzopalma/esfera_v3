# Plano Consolidado Final — Identificação Persistente de Dispositivos

## Origem das Decisões

| Fonte | Pontos fortes incorporados |
|-------|---------------------------|
| **Conselho IAs** | UUID v4, HTTP/Axum (não WS), NetworkCallback, LinkProperties, UPSERT, Server URL parametrizada, poison error handling, POST_NOTIFICATIONS, delay(2s) DHCP |
| **Gemini** | Duas frentes, DeviceIdProvider fallback chain, BootReceiver, build_agent.ps1 |
| **Análise do código real** | r2d2 pool + Arc<Database> (sem Arc<Mutex<Connection>>), bg_runtime existente, extender Device struct, padrão listen/event já usado, inject_device_immunity já existe |
| **Projetos similares** | Chip FK fix, Campaign dispatch serial→CurrentAdbAddress, Hub/Master bug (Drop), unificar 25s+45s loops |

---

## FASE 1 — CORE (Device ID + Android Agent)

### FRENTE 1: Backend Rust + Frontend React

#### 1.1 — Migração DB (db.rs)

**O que fazer:**
Adicionar colunas na `ESF_Device` sem quebrar nada existente:

```sql
ALTER TABLE ESF_Device ADD COLUMN EsferaDeviceId TEXT;
ALTER TABLE ESF_Device ADD COLUMN CurrentAdbAddress TEXT;
ALTER TABLE ESF_Device ADD COLUMN LastSeenUTC TEXT;
```

Popular `EsferaDeviceId` com UUID v4 determinístico para os 8 devices existentes:
```sql
UPDATE ESF_Device SET EsferaDeviceId = 'ESF-' || hex(randomblob(16)) WHERE EsferaDeviceId IS NULL;
```

Criar índice único e NOT NULL:
```sql
UPDATE ESF_Device SET EsferaDeviceId = 'ESF-LEGACY-' || DeviceNumber WHERE EsferaDeviceId IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_esfera_id ON ESF_Device(EsferaDeviceId);
```

**Extender `struct Device` em db.rs:**
```rust
pub struct Device {
    pub id: i32,                    // rowid (existente)
    pub serial: String,             // AdbDeviceId — IP:Port (existente, mantido para compatibilidade)
    pub esfera_device_id: String,   // NOVO — UUID persistente
    pub current_adb_address: Option<String>, // NOVO — IP:Port atual vindo do check-in
    pub last_seen_utc: Option<String>,       // NOVO — timestamp do último check-in
    pub name: String,               // DeviceName (existente)
    pub brand: String,              // (existente)
    pub model: String,              // (existente)
    pub ip: String,                 // DeviceIp (existente, mantido para fallback)
    pub port: i32,                  // DevicePort (existente)
    pub status: String,             // (existente)
    pub battery: i32,               // (existente)
    pub company_id: i32,            // (existente)
    pub device_number: i32,         // (existente)
    pub sector: String,             // (existente)
}
```

**Por que essa abordagem e não rename table (Council)?**
- Projeto REAL usa rowid como FK em ESF_Chip.DeviceId
- ALTER TABLE é seguro, reversível (DROP INDEX), e não quebra FKs existentes
- Dados existentes continuam funcionando durante a migração

**Pontos fortes aplicados:**
- ✅ UUID v4 persistente (Council)
- ✅ Determinístico por DeviceNumber (Gemini — previsível)
- ✅ r2d2 pool existente usado — sem Arc<Mutex<Connection>> (código real)
- ✅ Device struct estendido, não substituído (código real)

#### 1.2 — Servidor HTTP Check-in (axum) dentro do setup()

**Arquivos novos:**
- `src-tauri/src/checkin_server.rs`

**O que fazer:**
Adicionar `axum` + `chrono` no Cargo.toml. Criar servidor HTTP que roda dentro do `setup()` do Tauri, onde o `AppHandle` está disponível — igual o `dispatcher::start_worker` já faz.

```rust
// checkin_server.rs
use axum::{Router, routing::post, Json, extract::State};
use std::sync::Arc;
use tauri::AppHandle;
use crate::db::Database;

pub async fn start(db: Arc<Database>, port: u16, app_handle: AppHandle) {
    let app = Router::new()
        .route("/api/devices/check-in", post(handle_checkin))
        .with_state((db, app_handle));

    let addr = ([0, 0, 0, 0], port);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

**Endpoint POST `/api/devices/check-in`:**
```json
{
  "deviceId": "ESF-<uuid>",
  "ipAddress": "192.168.1.200",
  "adbPort": 5555
}
```

**Lógica:** UPSERT no DB:
```sql
UPDATE ESF_Device SET
    CurrentAdbAddress = ?1,
    Status = 'online',
    LastSeenUTC = ?2,
    DeviceIp = ?3,
    DevicePort = ?4
WHERE EsferaDeviceId = ?5;
-- Se não achou, INSERT com os dados que tem
```

**Registrar em lib.rs (dentro do setup()):**
```rust
.setup(move |app| {
    let handle = app.handle().clone();

    // Check-in server com AppHandle para emitir eventos ao frontend
    if app_config.checkin_server_enabled {
        let db = db_arc.clone();
        let port = app_config.checkin_server_port;
        tauri::async_runtime::spawn(async move {
            checkin_server::start(db, port, handle).await;
        });
    }

    dispatcher::Dispatcher::start_worker(db_arc_clone.clone(), Some(app.handle().clone()));
    dispatcher::Dispatcher::start_persistent_adb_keepalive_loop(db_arc_clone.clone());
    adb_manager::start_status_monitor(db_arc_clone);
    Ok(())
})
```

Adicionar ao `AppConfig`:
```rust
pub struct AppConfig {
    // ... existing fields ...
    pub checkin_server_enabled: bool,   // default: true
    pub checkin_server_port: u16,       // default: 8080
}
```

**Emitir evento Tauri para frontend quando chegar check-in:**
Usar `AppHandle` armazenado em setup. Após o UPSERT, emitir:
```rust
let _ = app_handle.emit("device-updated", serde_json::json!({
    "esferaDeviceId": device_id,
    "currentAdbAddress": adb_address,
    "status": "online",
    "lastSeenUtc": now
}));
```

**Pontos fortes aplicados:**
- ✅ HTTP em vez de WebSocket (Council — mais resiliente)
- ✅ Axum na bg_runtime existente (código real)
- ✅ UPSERT pattern (Council)
- ✅ Server URL parametrizada (Council)
- ✅ Event Tauri para frontend em tempo real (código real já usa este padrão)
- ✅ r2d2 pool existente — sem blocking (código real)

#### 1.3 — Status Monitor (substitui auto-reconnect daemon)

**O que fazer:**
Substituir `AdbManager::start_auto_reconnect_daemon` (25s thread raw) por um monitor async.

**Arquivo:** Modificar `adb_manager.rs` ou criar `adb_status.rs`.

**Lógica:**
```rust
pub fn start_status_monitor(db_arc: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;

            let db = db_arc.clone();
            spawn_blocking(move || {
                // Marcas devices com check-in expirado como offline
                db.conn().execute(
                    "UPDATE ESF_Device SET Status = 'offline'
                     WHERE EsferaDeviceId IN (
                         SELECT EsferaDeviceId FROM ESF_Device
                         WHERE Status = 'online'
                         AND LastSeenUTC IS NOT NULL
                         AND datetime(LastSeenUTC) < datetime('now', '-120 seconds')
                     )",
                    [],
                ).ok();
            }).await;
        }
    });
}
```

Também manter (simplificado) o `adb connect` apenas para devices sem check-in (legado):
```rust
// Para devices que NUNCA fizeram check-in (EsferaDeviceId IS NULL ou legacy),
// continua tentando adb connect no IP salvo (fallback)
```

**Remover de lib.rs linha 157:**
```rust
// ANTIGO (remover):
adb_manager::AdbManager::start_auto_reconnect_daemon(db_arc_clone);

// NOVO (adicionar):
adb_manager::start_status_monitor(db_arc_clone.clone());
```

**Manter** o `dispatcher::start_persistent_adb_keepalive_loop` (45s) — ele ainda é útil para manter settings ADB ativos (Wi-Fi sleep, keepalive TCP, etc.).

**Pontos fortes aplicados:**
- ✅ Monitor em vez de reconnect cego (Council — baseado em fato, não conjectura)
- ✅ 90-120s timeout (Council)
- ✅ Substitui a thread raw de 25s (similar projects — unificar loops)
- ✅ Async no runtime do Tauri em vez de OS thread raw (código real)
- ✅ Fallback legado para devices sem agent (código real — compatibilidade)

#### 1.4 — Provisionamento via ADB (adb_manager.rs)

**O que fazer:**
Criar comando Tauri `provision_device` que orquestra:

1. Conectar via ADB ao IP:Port
2. Gerar UUID v4
3. Injetar `persist.esfera.device_id = ESF-<uuid>`
4. Injetar `persist.esfera.server_address = <ip_do_servidor>:8080`
5. Instalar APK (`adb install -r public/Esfera_Agent_v4.apk`)
6. Iniciar serviço (`adb shell am start-foreground-service ...`)
7. Aguardar primeiro check-in (poll por até 30s)
8. Se receber check-in, marcar provisionado

**Já existe:**
- `inject_persistent_device_id()` — faz setprop + /sdcard/.esfera_device_id ✅
- `inject_device_immunity()` — faz MAC fix, Wi-Fi sleep, Doze disable ✅
- `install_agent_apk` — comando que instala o APK ✅

**Extender:**
```rust
pub fn provision_device(serial: &str, server_url: &str) -> Result<ProvisionResult, String> {
    let uuid = Uuid::new_v4().to_string();
    let device_id = format!("ESF-{}", uuid);

    // 1. Injetar ID
    inject_persistent_device_id(serial, &device_id)?;

    // 2. Injetar server address
    inject_server_config(serial, server_url)?;

    // 3. Injetar imunidade (MAC, Wi-Fi, Doze)
    inject_device_immunity(serial, Some(&device_id))?;

    // 4. Instalar APK
    install_agent_apk(serial)?;

    // 5. Iniciar serviço
    start_agent_service(serial)?;

    Ok(ProvisionResult { device_id, status: "provisioned" })
}
```

**Arquivo de config no Android** (`/sdcard/esfera_config.json`):
```json
{
  "serverUrl": "http://192.168.1.100:8080",
  "heartbeatIntervalSec": 300,
  "adbPort": 5555
}
```

**Pontos fortes aplicados:**
- ✅ Provisionamento completo em um comando (Council)
- ✅ UUID v4 com prefixo ESF- (Council + Gemini)
- ✅ Config JSON (Gemini — mais flexível que setprop)
- ✅ Código existente reutilizado (código real — inject_persistent_device_id, install_agent_apk)

#### 1.5 — Comandos Tauri (commands.rs)

**Novos comandos:**

```rust
#[tauri::command]
fn provision_device(state, token, serial: String, server_url: String) -> Result<ProvisionResult, String>

#[tauri::command]
fn get_devices_with_esfera_id(state, token, company_id: i32) -> Result<Vec<Device>, String>

#[tauri::command]
fn get_device_by_esfera_id(state, token, esfera_device_id: String) -> Result<Device, String>
```

**Registrar em lib.rs:**
```rust
.invoke_handler(tauri::generate_handler![
    // ... ...existing 80+ commands...
    provision_device,
    get_devices_with_esfera_id,
    get_device_by_esfera_id,
])
```

**Pontos fortes aplicados:**
- ✅ Comandos novos junto com os existentes (código real)
- ✅ Reutiliza o padrão de session/token existente

#### 1.6 — Frontend React

**O que fazer:**
- Em `DevicesTab.tsx`, adicionar listener `listen("device-updated")` — evento emitido diretamente pelo check-in server quando um Android faz check-in:
```typescript
useEffect(() => {
    const unlisten = listen<DeviceUpdatedEvent>("device-updated", (event) => {
        setDevicesList(prev => prev.map(d =>
            d.esferaDeviceId === event.payload.esferaDeviceId
                ? { ...d, ...event.payload }
                : d
        ));
    });
    return () => { unlisten.then(fn => fn()); };
}, []);
```

**Sem polling.** O evento chega em tempo real porque o check-in server tem acesso ao `AppHandle` (roda dentro do `setup()`).

- Em `DeviceCard.tsx`, mostrar:
  - Badge com `esferaDeviceId` (truncado: `ESF-a1b2...`)
  - Indicador de status: verde se `LastSeenUTC < 120s`, cinza se não
  - Tooltip com "Último check-in: há X segundos"
  - IP atual (`currentAdbAddress`)

- Criar `DeviceStatusBadge.tsx` componente reutilizável:
```typescript
interface Props {
    status: 'online_agent' | 'online_legacy' | 'offline';
    lastSeenUtc?: string;
}
```

**Pontos fortes aplicados:**
- ✅ Listener de evento Tauri (código real já usa `listen("campaign-progress")`)
- ✅ Badge com hardwareId (Council)
- ✅ Status baseado em timestamp, não em tentativa de conexão (Council)

---

### FRENTE 2: Android Agent (Kotlin APK)

#### 2.1 — Estrutura do projeto

```
src-agent/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       └── java/com/esfera/agent/
│           ├── EsferaAgentService.kt
│           ├── CheckInManager.kt
│           ├── ConfigManager.kt
│           ├── BootReceiver.kt
│           └── KeepAliveWorker.kt
├── build_agent.ps1
```

#### 2.2 — AndroidManifest.xml

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

<application ...>
    <service
        android:name=".EsferaAgentService"
        android:enabled="true"
        android:exported="false"
        android:foregroundServiceType="dataSync" />

    <receiver
        android:name=".BootReceiver"
        android:enabled="true"
        android:exported="true">
        <intent-filter>
            <action android:name="android.intent.action.BOOT_COMPLETED" />
        </intent-filter>
    </receiver>
</application>
```

**Pontos fortes:** ✅ POST_NOTIFICATIONS (Api 33+) — Council, ✅ REQUEST_IGNORE_BATTERY_OPTIMIZATIONS — análise própria, ✅ FOREGROUND_SERVICE_DATA_SYNC — Gemini

#### 2.3 — ConfigManager.kt (identidade)

**Fallback chain (Council + Gemini combinados):**

```kotlin
object ConfigManager {
    fun getEsferaDeviceId(): String? {
        // 1. Tenta persist.esfera.device_id (injetado via ADB)
        val propId = SystemProperties.get("persist.esfera.device_id")
        if (!propId.isNullOrBlank()) return propId

        // 2. Tenta ANDROID_ID (UUID do SO)
        val androidId = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ANDROID_ID
        )
        if (!androidId.isNullOrBlank()) return "AID-$androidId"

        // 3. Tenta arquivo em /sdcard/.esfera_device_id (escrito via ADB)
        val fileId = readFile("/sdcard/.esfera_device_id")
        if (!fileId.isNullOrBlank()) return fileId

        // 4. Fallback: SharedPreferences (último recurso)
        val prefs = context.getSharedPreferences("esfera", Context.MODE_PRIVATE)
        var localId = prefs.getString("device_id", null)
        if (localId == null) {
            localId = "LOCAL-${UUID.randomUUID()}"
            prefs.edit().putString("device_id", localId).apply()
        }
        return localId
    }

    fun getServerUrl(): String? {
        return SystemProperties.get("persist.esfera.server_address")
            ?: readConfigFile()?.serverUrl
    }
}
```

**Pontos fortes:** ✅ Fallback robusto (Council + Gemini), ✅ SharedPreferences como último recurso (Gemini), ✅ SystemProperties reflection (Council)

#### 2.4 — EsferaAgentService.kt (Foreground + NetworkCallback)

```kotlin
class EsferaAgentService : Service() {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val heartbeatMs = 5 * 60 * 1000L // 5 min
    private lateinit var connectivityManager: ConnectivityManager

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                delay(2000) // DHCP settle (Council)
                CheckInManager.performCheckIn(applicationContext)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        connectivityManager = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        connectivityManager.registerDefaultNetworkCallback(networkCallback) // Council
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, createNotification())
        scope.launch {
            while (isActive) {
                CheckInManager.performCheckIn(this@EsferaAgentService)
                delay(heartbeatMs)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        connectivityManager.unregisterNetworkCallback(networkCallback)
        super.onDestroy()
    }
}
```

**Pontos fortes:** ✅ NetworkCallback (Council) — sem BroadcastReceiver depreciado, ✅ delay(2000) DHCP settle (Council), ✅ Foreground START_STICKY (Council + Gemini), ✅ Desregistra callback no onDestroy (Council — evita memory leak)

#### 2.5 — CheckInManager.kt (HTTP via Ktor)

```kotlin
object CheckInManager {
    private val client = HttpClient(CIO) {
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
            connectTimeoutMillis = 5_000
        }
    }

    suspend fun performCheckIn(context: Context) {
        val deviceId = ConfigManager.getEsferaDeviceId(context) ?: return
        val serverUrl = ConfigManager.getServerUrl(context) ?: return
        val ipAddress = getCurrentIpAddress(context) ?: return

        try {
            client.post("$serverUrl/api/devices/check-in") {
                contentType(ContentType.Application.Json)
                setBody(CheckInPayload(
                    deviceId = deviceId,
                    ipAddress = ipAddress,
                    adbPort = 5555
                ))
            }
        } catch (e: Exception) {
            Log.w("CheckInManager", "Check-in falhou: ${e.message}")
            // Exponential backoff é implícito — próxima tentativa no próximo heartbeat
        }
    }

    private fun getCurrentIpAddress(context: Context): String? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return null
        val props = cm.getLinkProperties(network) ?: return null
        return props.linkAddresses
            .find { it.address is Inet4Address && !it.address.isLoopbackAddress }
            ?.address?.hostAddress
    }
}
```

**Pontos fortes:** ✅ Ktor (Council), ✅ LinkProperties moderna (Council) — funciona Wi-Fi + dados móveis, ✅ Timeout 10s (análise própria — não travar o serviço)

#### 2.6 — BootReceiver.kt

```kotlin
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val service = Intent(context, EsferaAgentService::class.java)
            ContextCompat.startForegroundService(context, service)
        }
    }
}
```

#### 2.7 — KeepAliveWorker.kt (WorkManager)

```kotlin
class KeepAliveWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        // Verifica se o serviço está rodando
        val isRunning = isServiceRunning(EsferaAgentService::class.java)
        if (!isRunning) {
            val service = Intent(applicationContext, EsferaAgentService::class.java)
            ContextCompat.startForegroundService(applicationContext, service)
        }
        return Result.success()
    }
}
```

Agendamento:
```kotlin
val request = PeriodicWorkRequestBuilder<KeepAliveWorker>(15, TimeUnit.MINUTES)
    .setConstraints(Constraints.Builder()
        .setRequiresBatteryNotLow(true)
        .build())
    .build()
WorkManager.getInstance(context).enqueueUniquePeriodicWork(
    "esfera-keepalive",
    ExistingPeriodicWorkPolicy.KEEP,
    request
)
```

#### 2.8 — build_agent.ps1

```powershell
# Navega para src-agent/
# Executa ./gradlew assembleRelease
# Copia APK para public/Esfera_Agent_v4.apk
# Opcional: assina com keystore se existir
```

---

## FASE 2 — PROJETOS SIMILARES (após Fase 1)

### P2.1 — Fix Hub/Master disconnect bug

**Arquivo:** `src-tauri/src/master_client.rs`

**Problema:** `master_client` em AppState nunca é limpo quando a conexão cai. Inner loop `if mc.is_none() { break; }` nunca executa.

**Solução:** Implementar `Drop` no `MasterClient` que seta o mutex para `None`:
```rust
// Dentro do reconnect loop em lib.rs, após listen() retornar (conexão perdida):
*mc.lock().await = None; // <-- falta esta linha
```

### P2.2 — Campaign Dispatch: usar CurrentAdbAddress

**Arquivo:** `src-tauri/src/dispatcher.rs`, linha 85

**Antes:**
```rust
let serial = target_dev.serial.clone(); // IP:Port fixo do banco
```

**Depois:**
```rust
let target = target_dev.current_adb_address
    .as_deref()
    .unwrap_or(&target_dev.serial); // Fallback para serial se não tiver check-in
```

### P2.3 — ESF_Chip: FK migration

**Arquivos:** `src-tauri/src/db.rs`

Atualizar JOINs de `c.DeviceId = d.rowid` / `c.DeviceId = d.AdbDeviceId` para usar `EsferaDeviceId`.

Como `DeviceId` em Chip é INTEGER, a abordagem mais segura é:
- Manter `DeviceId` como INTEGER rowid na ESF_Chip (não quebra nada)
- Atualizar apenas as queries de JOIN para usar o novo índice correto
- Adicionar coluna `EsferaDeviceId TEXT` em ESF_Chip para referência futura

### P2.4 — Remover auto-reconnect daemon antigo

Após Fase 1.3 (status monitor) funcionando, remover `start_auto_reconnect_daemon` de `adb_manager.rs`.

---

## FASE 3 — MODERNIZAÇÃO (opcional)

### P3.1 — EmpresaServer HTTP

Adicionar endpoint HTTP `GET /api/devices` junto com o TCP raw existente, usando o mesmo Axum.

---

## Ordem de Implementação

```
Fase 1:
  1.1 → 1.4 (DB migration + provisionamento)
  1.2 → 1.3 (Check-in server + status monitor, em paralelo com 1.4)
  1.5 → 1.6 (Comandos + frontend)
  2.1 → 2.8 (Android agent APK)

Fase 2:
  P2.1 (Hub/Master bug) — 1 linha, faz junto com 1.2
  P2.2 (Campaign dispatch) — após 1.1
  P2.3 (Chip FK) — após 1.1
  P2.4 (Remover daemon antigo) — após 1.3 validado

Fase 3:
  P3.1 (EmpresaServer HTTP) — quando houver tempo
```

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Xiaomi/Huawei matam Foreground Service | inject_device_immunity já desativa otimização + KeepAliveWorker 15min + START_STICKY |
| Porta 8080 em uso | Configurável via AppConfig.checkin_server_port |
| r2d2 pool exhaustion (max 8) | Check-in é leve (1 query). 8 agents simultâneos é mais que suficiente |
| APK antigo mouldybread conflita | Package names diferentes. Podem coexistir — antigo só ativa ADB, novo faz check-in |
| setprop não persiste em alguns firmwares | Fallback ANDROID_ID + SharedPreferences + /sdcard/.esfera_device_id |
