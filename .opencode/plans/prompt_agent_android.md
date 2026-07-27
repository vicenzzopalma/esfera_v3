# ANÁLISE E IMPLEMENTAÇÃO: Agente Android Persistente para Esfera v3

## CONTEXTO DO PROBLEMA

O Esfera v3 gerencia celulares Android via ADB (Android Debug Bridge). Atualmente os dispositivos são identificados **exclusivamente pelo IP:Porta** (ex: `192.168.1.185:5555`), que é usado como `AdbDeviceId` (PRIMARY KEY) na tabela `ESF_Device`.

### Problema Crítico
Quando um celular muda de rede Wi-Fi ou o DHCP renova o IP, o dispositivo inteiro "some" do sistema — ele aparece como um device novo com um IP diferente, perdendo todo o histórico, vínculos com colaboradores, permissões concedidas, etc. O auto-reconnect daemon tenta reconectar a cada 25s, mas se o IP mudou, ele falha.

### Stack Tecnológica
- **Backend:** Rust + Tauri v2 + SQLite (rusqlite)
- **Frontend:** React 19 + TypeScript + Vite + TailwindCSS v4
- **Comunicação ADB:** CLI do ADB via Command nativo Rust
- **APK existente:** `Esfera_Agent_ADB.apk` (package: `com.mouldybread.adbautoenable`) — APK simples que só ativa Wi-Fi ADB com 1 toque. Não faz identificação persistente, não se comunica com o servidor.
- **Autenticação:** JWT-like sessions em Rust

## ARQUITETURA ATUAL (CÓDIGO RELEVANTE)

### 1. Tabela ESF_Device (db.rs)
```sql
CREATE TABLE IF NOT EXISTS ESF_Device (
    AdbDeviceId TEXT PRIMARY KEY,       -- "192.168.1.185:5555" (IP:Port)
    DeviceName TEXT NOT NULL,
    Brand TEXT NOT NULL DEFAULT 'Android',
    Model TEXT NOT NULL DEFAULT 'Smartphone',
    DeviceIp TEXT NOT NULL DEFAULT '',
    DevicePort INTEGER NOT NULL DEFAULT 5555,
    Status TEXT NOT NULL DEFAULT 'offline',
    BatteryLevel INTEGER NOT NULL DEFAULT 0,
    CompanyId INTEGER NOT NULL,
    DeviceNumber INTEGER NOT NULL DEFAULT 1,
    Sector TEXT NOT NULL DEFAULT 'junior'
);
```

### 2. Struct Device (db.rs)
```rust
pub struct Device {
    pub id: i32,
    pub serial: String,       // ADB serial = IP:Port
    pub name: String,
    pub brand: String,
    pub model: String,
    pub ip: String,
    pub port: i32,
    pub status: String,
    pub battery: i32,
    pub company_id: i32,
    pub device_number: i32,
    pub sector: String,
}
```

### 3. ADB Manager — Injeção de ID Persistente (adb_manager.rs)
```rust
pub fn get_persistent_device_id(serial: &str) -> Option<String> {
    // Lê: getprop persist.esfera.device_id
    // Fallback: cat /sdcard/.esfera_device_id
    // Retorna algo como "ESFERA_DEV_001"
}

pub fn inject_persistent_device_id(serial: &str, persistent_id: &str) -> Result<String, String> {
    // setprop persist.esfera.device_id <id>
    // echo '<id>' > /sdcard/.esfera_device_id
}

pub fn inject_device_immunity(serial: &str, persistent_id: Option<&str>) -> Result<String, String> {
    // Injeta: persist.adb.tcp.port 5555, desliga randomização MAC,
    // desliga Doze mode, whitelist do app, etc.
}

pub fn deploy_keepalive(serial: &str) -> Result<String, String> {
    // setprop persist.adb.tcp.port 5555
    // wifi_sleep_policy 2, stay_on_while_plugged_in 7
    // deviceidle disable, etc.
}
```

### 4. Auto-Reconnect Daemon (adb_manager.rs)
```rust
pub fn start_auto_reconnect_daemon(db_conn: Arc<Database>) {
    // Thread que a cada 25s:
    //   1. Pega devices do banco
    //   2. Tenta adb connect <ip>:<port>
    //   3. Se primeira vez, injeta immunity com ESFERA_DEV_XXX
}
```

### 5. install_agent_apk (adb_manager.rs)
```rust
pub fn install_agent_apk(serial: &str) -> Result<String, String> {
    // 1. adb install -r -g Esfera_Agent_ADB.apk
    // 2. am start -n com.mouldybread.adbautoenable/.MainActivity
    // 3. deploy_keepalive + inject_device_immunity
}
```

### 6. Tabelas de Vínculo (ESF_DeviceAssignment, ESF_DevicePermissionRequest)
Ambas usam `AdbDeviceId TEXT NOT NULL` como FK para o device — ativamente o IP:Port.

## O QUE PRECISA SER CRIADO/ADAPTADO

### A. NOVO APK ANDROID (Agente Esfera v4)

Um app Android que será instalado via ADB nos celulares da empresa (já é company-owned, pode ser agressivo). Deve ter:

1. **Identificador Único e Persistente:**
   - Usar `Settings.Secure.ANDROID_ID` como base (não muda mesmo após factory reset se mesma conta Google)
   - OU combinar ANDROID_ID + kernel property `persist.esfera.device_id`
   - Gravar em `getprop persist.esfera.device_id` via root ou `setprop` (se disponível)
   - Fallback: arquivo em `/sdcard/.esfera_device_id`

2. **Comunicação com Servidor:**
   - Conectar via WebSocket ou TCP persistente para o servidor Esfera
   - Endereço do servidor configurável (lido de `persist.esfera.server` ou um DNS fixo)
   - Auto-reconexão com exponential backoff
   - Enviar heartbeat a cada 30s contendo:
     ```json
     {
       "deviceId": "ANDROID_ID_ou_ESFERA_DEV_001",
       "ip": "192.168.1.50",
       "adbPort": 5555,
       "battery": 85,
       "status": "online",
       "model": "Xiaomi Redmi Note",
       "brand": "Xiaomi",
       "sdkVersion": 33,
       "timestamp": 1234567890
     }
     ```
   - Receber comandos do servidor (ex: reiniciar ADB, atualizar config)

3. **Serviço Foreground Persistente:**
   - Notification persistente (importante para não ser morto pelo Android)
   - `START_STICKY` no Service
   - WakeLock parcial para manter conexão
   - Re-registrar no boot via `BOOT_COMPLETED` broadcast
   - JobScheduler/WorkManager para reconnect

4. **ADB TCP Keep-Alive:**
   - Se ADB via TCP cair, reativar automaticamente
   - `setprop persist.adb.tcp.port 5555`
   - Tentar `adb start-server` local se tiver root

5. **Permissões (agressivo, empresa-owned):**
   - `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`
   - `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`
   - `RECEIVE_BOOT_COMPLETED`
   - `WAKE_LOCK`
   - `SYSTEM_ALERT_WINDOW` (para debug)
   - `REQUEST_INSTALL_PACKAGES` (para auto-update)
   - `WRITE_SETTINGS` (para configurar ADB TCP)
   - `BIND_ACCESSIBILITY_SERVICE` (para automação WhatsApp)

### B. MUDANÇAS NO BACKEND RUST

1. **Nova tabela ESF_DeviceRegistry:**
   ```sql
   CREATE TABLE IF NOT EXISTS ESF_DeviceRegistry (
       HardwareId TEXT PRIMARY KEY,      -- ANDROID_ID ou ESFERA_DEV_001
       AdbDeviceId TEXT NOT NULL,        -- IP:Port atual (pode mudar)
       LastSeenIp TEXT NOT NULL DEFAULT '',
       LastSeenPort INTEGER NOT NULL DEFAULT 5555,
       LastHeartbeat TEXT,
       BatteryLevel INTEGER NOT NULL DEFAULT 0,
       Status TEXT NOT NULL DEFAULT 'offline',
       FOREIGN KEY (AdbDeviceId) REFERENCES ESF_Device(AdbDeviceId)
   );
   ```

2. **Servidor WebSocket no Rust (Tauri):**
   - Listener em uma porta (ex: 9120) para as conexões dos agents Android
   - Receber heartbeats e atualizar o registry
   - Atualizar o IP do device no ESF_Device quando o heartbeat vier de IP diferente
   - Comandar devices (ex: solicitar screenshot, reiniciar)
   - Usar `tokio-tungstenite` ou `tokio::net::TcpListener` para o servidor

3. **Modificar ESF_Device:**
   - Adicionar coluna `HardwareId TEXT` (opcional, pode ser NULL para devices legados)
   - Ou criar uma VIEW que junta ESF_Device com ESF_DeviceRegistry

4. **Modificar ESF_DeviceAssignment e ESF_DevicePermissionRequest:**
   - Mudar de `AdbDeviceId TEXT` para `HardwareId TEXT` como chave estrangeira
   - Ou adicionar `HardwareId` e manter ambas

5. **Novos comandos IPC:**
   - `register_agent_device(agentId, ip, port, model, brand, battery)` — chamado pelo servidor WebSocket
   - `get_registered_devices()` — lista devices conectados via agent
   - `get_device_by_hardware_id(hardwareId)` — lookup por ID persistente

6. **Modificar auto-reconnect daemon:**
   - Tentar reconnect para devices no registry pelo IP atual
   - Se falhar, marcar como offline mas manter o hardwareId

### C. MUDANÇAS NO FRONTEND

1. **DevicesTab.tsx — Identificação por hardware ID:**
   - Mostrar devices pelo nome persistente (não pelo IP)
   - Badge mostrando o hardware ID
   - Indicar conexão via agent vs conexão ADB direta

2. **SupervisorView.tsx — Heartbeat status:**
   - Mostrar "último heartbeat" em cada card
   - Indicar "Conexão Estável" (heartbeat recente) vs "Perdido" (sem heartbeat)

3. **API frontend:**
   - Adicionar novas funções de API para os comandos novos

## ANÁLISE DE VIABILIDADE

O Conselho deve responder:
1. **É viável criar o APK Android** descrito acima? Quais as limitações?
   - `setprop` requer ADB shell ou root — no Android 14+ está mais restrito
   - `persist.*` properties podem não ser graváveis sem root
   - Alternativas: ContentProvider, arquivo em `/data/local/tmp/` via ADB, ou SharedPreferences
   - Android Background Execution Limits (doze mode, battery optimization) — como contornar com foreground service

2. **Qual a melhor arquitetura de comunicação?**
   - WebSocket (tokio-tungstenite) vs TCP raw vs HTTP polling
   - Servidor embutido no Tauri vs processo separado
   - Criptografia: TLS ou custom?

3. **Como mapear o hardware ID para o ADB serial (IP:Port)?**
   - O agent envia heartbeat com IP atual → backend atualiza o map
   - Quando gestor/master precisa usar ADB (scrcpy, install, tap), usa o IP mais recente

4. **Riscos:**
   - Android pode matar o foreground service (depende da OEM)
   - Xiaomi, Samsung, Motorola têm comportamentos diferentes de battery optimization
   - Sem root, `setprop` e modificação de `persist.*` não funciona
   - Alternativa sem root: usar ADB para gravar ID em `/data/local/tmp/`

## ENTREGÁVEIS ESPERADOS

1. Código do **APK Android** (Android Studio project) em Java/Kotlin com Gradle build
2. Código **Rust** do servidor WebSocket + novos comandos IPC
3. **SQL migrations** para as novas tabelas
4. **Mudanças no frontend** React para exibir os novos dados
5. **Script de build** para compilar o APK automaticamente

## RESULTADO DA ANÁLISE

O Conselho deve retornar:
- ✅ APROVADO: O plano é viável e aqui está a implementação completa
- ❌ REPROVADO: Explicar os bloqueios técnicos e sugerir alternativas
- ⚠️ PARCIAL: O que é viável, o que não é, e como fazer o possível
