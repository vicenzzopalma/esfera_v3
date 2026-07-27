# Plano de Implementação — 2 Frentes

**Referência:** `docs/AI_Council_Android_Agent_Solution.md` (solução completa do Conselho das IAs)

## Problema

Dispositivos identificados por IP:Porta (`AdbDeviceId` = `192.168.1.185:5555`). Quando o IP muda, o dispositivo "some" do sistema — perde histórico, vínculos e permissões.

## Solução

Criar um **Agente Android Persistente** que se identifica por `HardwareId` imutável (ANDROID_ID) e se comunica via WebSocket com o servidor Esfera, informando seu IP atual continuamente.

---

## FRENTE 1: Backend (Rust) + Frontend (React)

**Responsável:** Servidor Esfera (Tauri + SQLite + React)

### Tarefas

| # | Tarefa | Arquivos | Descrição |
|---|--------|----------|-----------|
| 1.1 | **Migração DB: HardwareId** | `src-tauri/src/db.rs` | Adicionar coluna `HardwareId TEXT` na `ESF_Device`. Criar índice único. Populate com `legacy-{AdbDeviceId}` para devices existentes. |
| 1.2 | **Migração DB: Tabelas filhas** | `src-tauri/src/db.rs` | Adicionar `HardwareId TEXT` em `ESF_DeviceAssignment` e `ESF_DevicePermissionRequest`. UPDATE com JOIN para popular. |
| 1.3 | **Servidor WebSocket** | `src-tauri/src/websocket/server.rs` + `handler.rs` | Listener TCP na porta 9120 via `tokio-tungstenite`. Aceitar conexões de agents Android. |
| 1.4 | **Processamento de Heartbeat** | `src-tauri/src/websocket/handler.rs` | Receber `{ type: "HEARTBEAT", payload: { hardwareId, currentIp, adbPort, batteryLevel } }`. Atualizar `CurrentAdbAddress`, `LastHeartbeat`, `BatteryLevel` no DB via `spawn_blocking`. Emitir evento `device-updated` para frontend. |
| 1.5 | **Processamento de Registro** | `src-tauri/src/websocket/handler.rs` | Receber `{ type: "REGISTER", payload: { hardwareId, model, brand, sdkVersion } }`. Criar device no DB se não existir. |
| 1.6 | **Comando IPC: provision_device** | `src-tauri/src/commands.rs` | Novo comando que orquestra: gerar UUID → injetar via ADB (`setprop persist.esfera.device_id` + `persist.esfera.server_address`) → instalar APK do agente → iniciar serviço. |
| 1.7 | **Comando IPC: get_devices_with_hardware** | `src-tauri/src/commands.rs` | Retorna lista de devices incluindo `hardwareId`, `currentAdbAddress`, `lastHeartbeat`, `status`. |
| 1.8 | **Auto-reconnect Daemon** | `src-tauri/src/adb_manager.rs` | Atualizar para: 1) Tentar reconnect pelo `CurrentAdbAddress` do registry; 2) Se falhar 3x, marcar como `offline` mas manter `HardwareId`. |
| 1.9 | **Injeção de Config no Provisionamento** | `src-tauri/src/adb_manager.rs` | Após instalar APK, injetar: `setprop persist.esfera.server_address <ip>:9120` e `setprop persist.esfera.device_id <HardwareId>`. |
| 1.10 | **Frontend: DeviceCard com HardwareId** | `src/pages/DevicesTab.tsx` + `src/components/*` | Mostrar badge com hardwareId + último heartbeat. Status: `online_agent` (verde) vs `offline` (cinza). Atualização em tempo real via `listen("device-updated")`. |
| 1.11 | **Frontend: SupervisorView com heartbeat** | `src/components/SupervisorView.tsx` | Adicionar indicador "Conexão" com timestamp do último heartbeat. |
| 1.12 | **Registrar handlers no lib.rs** | `src-tauri/src/lib.rs` | Adicionar `mod websocket`, iniciar servidor WS no `setup()`, registrar novos comandos no `generate_handler![]`. |

### Dependências Rust a adicionar
- `tokio-tungstenite` (WebSocket server)
- `uuid` (geração de HardwareId)
- `chrono` (timestamps RFC 3339)

### Estrutura de arquivos nova
```
src-tauri/src/
├── websocket/
│   ├── mod.rs
│   ├── server.rs        # Inicialização do listener
│   └── handler.rs       # Processamento de mensagens dos agents
├── db/
│   └── migration.rs     # Lógica de migração do schema
```

---

## FRENTE 2: Android Agent (Kotlin APK)

**Responsável:** App Android que roda nos celulares da empresa

### Tarefas

| # | Tarefa | Arquivos | Descrição |
|---|--------|----------|-----------|
| 2.1 | **Estrutura do projeto Android** | `src-agent/` | Android Studio project com Gradle Kotlin DSL. Package: `com.esfera.agent`. |
| 2.2 | **AndroidManifest.xml** | `src-agent/app/src/main/AndroidManifest.xml` | Permissions: INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, RECEIVE_BOOT_COMPLETED, FOREGROUND_SERVICE, WAKE_LOCK, FOREGROUND_SERVICE_DATA_SYNC. |
| 2.3 | **DeviceIdProvider.kt** | `src-agent/app/src/main/java/com/esfera/agent/utils/DeviceIdProvider.kt` | Estratégia de fallback: 1) `persist.esfera.device_id` (via ADB); 2) `Settings.Secure.ANDROID_ID`; 3) UUID aleatório persistido em SharedPreferences. |
| 2.4 | **SystemProperties.kt** | `src-agent/app/src/main/java/com/esfera/agent/utils/SystemProperties.kt` | Ler propriedades do sistema via reflection (`android.os.SystemProperties.get`). Usado para ler `persist.esfera.server_address`. |
| 2.5 | **NetworkUtils.kt** | `src-agent/app/src/main/java/com/esfera/agent/utils/NetworkUtils.kt` | Obter IP atual do device via `ConnectivityManager.getLinkProperties()`. |
| 2.6 | **PersistentAgentService.kt** | `src-agent/app/src/main/java/com/esfera/agent/service/PersistentAgentService.kt` | Foreground Service com notificação persistente. Lê server_address de `SystemProperties`. Inicia `WebSocketManager`. `START_STICKY`. |
| 2.7 | **WebSocketManager.kt** | `src-agent/app/src/main/java/com/esfera/agent/network/WebSocketManager.kt` | Conexão OkHttp WebSocket. Heartbeat a cada 30s com IP+bateria atuais. Reconexão com exponential backoff (5s → 60s max). |
| 2.8 | **EsferaWebSocketListener.kt** | `src-agent/app/src/main/java/com/esfera/agent/network/EsferaWebSocketListener.kt` | Processar `onOpen` (iniciar heartbeat), `onMessage` (comandos do servidor), `onFailure` (reconectar). |
| 2.9 | **BootReceiver.kt** | `src-agent/app/src/main/java/com/esfera/agent/broadcast/BootReceiver.kt` | BroadcastReceiver para `ACTION_BOOT_COMPLETED`. Reinicia o `PersistentAgentService`. |
| 2.10 | **KeepAliveWorker.kt** | `src-agent/app/src/main/java/com/esfera/agent/workers/KeepAliveWorker.kt` | WorkManager periódico (a cada 15min) para verificar se ADB TCP está ativo e o serviço está rodando. |
| 2.11 | **build.gradle.kts** | `src-agent/app/build.gradle.kts` | Dependências: OkHttp, Kotlinx Coroutines, AndroidX WorkManager, Gson. |
| 2.12 | **Script de build automático** | `build_agent.ps1` | PowerShell script que: 1) Navega para `src-agent/`; 2) Executa `./gradlew assembleRelease`; 3) Copia APK para `public/Esfera_Agent_v4.apk`. |

### Dependências (Gradle)
```kotlin
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    implementation("com.google.code.gson:gson:2.10.1")
}
```

### Estrutura de arquivos nova
```
src-agent/
├── build.gradle.kts              # Root project
├── settings.gradle.kts
├── gradle.properties
├── app/
│   ├── build.gradle.kts          # App module
│   └── src/main/
│       ├── AndroidManifest.xml
│       └── java/com/esfera/agent/
│           ├── service/
│           │   └── PersistentAgentService.kt
│           ├── network/
│           │   ├── WebSocketManager.kt
│           │   └── EsferaWebSocketListener.kt
│           ├── broadcast/
│           │   └── BootReceiver.kt
│           ├── workers/
│           │   └── KeepAliveWorker.kt
│           └── utils/
│               ├── DeviceIdProvider.kt
│               ├── SystemProperties.kt
│               └── NetworkUtils.kt
build_agent.ps1
```

---

## Fluxo de Integração entre as Frentes

```
[Provisionamento]
  Front 1.6: provision_device()
    → ADB inject: persist.esfera.device_id = "ESF-HW-<uuid>"
    → ADB inject: persist.esfera.server_address = "192.168.1.100:9120"
    → ADB install: Esfera_Agent_v4.apk
    → ADB am start-service: com.esfera.agent/.service.PersistentAgentService

[Agent Android (Front 2)]
  → Lê server_address (SystemProperties)
  → Lê device_id (DeviceIdProvider)
  → Conecta WebSocket → envia REGISTER
  → A cada 30s: envia HEARTBEAT { hardwareId, currentIp, adbPort, battery }

[Servidor WebSocket (Front 1.3-1.5)]
  → Recebe REGISTER → cria/atualiza device no DB
  → Recebe HEARTBEAT → atualiza CurrentAdbAddress, LastHeartbeat, BatteryLevel
  → Emite evento "device-updated" para o frontend React

[Frontend (Front 1.10-1.11)]
  → Escuta "device-updated" → atualiza card em tempo real
  → Mostra: hardwareId, nome, status (online_agent/offline), último heartbeat

[Gestor usando ADB (scrcpy, tap, etc.)]
  → Frontend pega o hardwareId
  → Busca CurrentAdbAddress (IP:Port) mais recente do DB
  → Executa comando ADB contra esse IP
```

## Ordem de Implementação

1. **Front 1.1-1.2** — Migração DB (base para tudo)
2. **Front 1.3-1.5** — Servidor WebSocket (core da comunicação)
3. **Front 1.12** — Integrar no Tauri (lib.rs)
4. **Front 2.1-2.11** — Projeto Android completo
5. **Front 2.12** — Build script
6. **Front 1.6-1.9** — Provisionamento (injeção via ADB)
7. **Front 1.10-1.11** — Frontend React
8. **Testes:** Provisionar device → instalar agent → ver heartbeat → mudar IP → ver reconexão
