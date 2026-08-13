package com.esfera.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.ComponentName
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.PrintWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate
import okhttp3.OkHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.util.concurrent.TimeUnit

@Serializable
data class EsferaConfig(
    val serverUrl: String = "",
    val deviceId: String = "",
    val tunnelEnabled: Boolean = true,
    val tunnelPort: Int = 8888,
    // COMPANY_ID: identidade de isolamento. Sem ela o VPS recusa check-in
    // (nunca derivamos empresa de IP/porta/ordem de conexão).
    val companyId: Int = 0
)

@Serializable
data class CheckInRequest(
    val esferaDeviceId: String,
    val currentAdbAddress: String,
    val companyId: Int = 0,
    val batteryLevel: Int = 0,
    val isCharging: Boolean = false,
    val isScreenOn: Boolean = false
)

@Serializable
data class TunnelHandshake(
    val type: String = "handshake",
    val hardwareUuid: String = "",
    val companyId: Int = 0,
    val macAddress: String = "",
    val serialNumber: String = "",
    val agentVersion: String = "1.0-tunnel",
    val currentLocalIp: String = ""
)

class EsferaAgentService : Service() {

    companion object {
        const val CHANNEL_ID = "esfera_agent_channel"
        const val NOTIF_ID = 1001
        const val CHECK_IN_INTERVAL_MS = 30_000L
        private const val RESPAWN_JOB_ID = 4243

        // RESPAWN DEFENSIVO: se o sistema (OEM/Moto) matar o service sem reboot,
        // reagenda um Job one-shot em 5s para religar o agente. Garante que o
        // celular continue reportando ao VPS MESMO SEM USB e SEM reboot (regra do
        // usuário: "aparece mesmo reiniciando o WiFi e desplugado"). O BootJobService
        // ja cuida do reboot; este cobre kill em runtime.
        fun scheduleRespawn(context: Context) {
            try {
                val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
                if (js.getPendingJob(RESPAWN_JOB_ID) != null) return
                val component = ComponentName(context, BootJobService::class.java)
                val builder = JobInfo.Builder(RESPAWN_JOB_ID, component)
                    .setMinimumLatency(5_000L)
                    .setOverrideDeadline(15_000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                js.schedule(builder.build())
            } catch (_: Exception) {}
        }
    }

    // ================================================================
    // LISTA BRANCA DE COMANDOS REMOTOS (allowlist autenticada)
    // Soma-se ao metodo atual (tunel reverso + WebSocket). NUNCA executa
    // shell arbitrario: o VPS so pode disparar os comandos abaixo. Isso
    // fecha a superficie de ataque (getprop/input remoto vira allowlist,
    // nao shell livre). Mantido em sincronia com o que o app desktop envia.
    // ================================================================
    private val ALLOWED_PREFIXES = listOf(
        "input ",                 // input tap/keyevent/swipe/text/etc.
        "cmd input ",            // via cmd (alguns fabricantes)
        "screencap ",            // captura de tela
        "getprop ",              // leitura de propriedade (inventario)
        "settings ",             // leitura de settings
        "am start ",             // abrir app/activity (sem shell)
        "am broadcast ",         // broadcast permitido
        "am force-stop ",        // parar app (gestao)
        "dumpsys ",              // inventario de estado (read-only)
        "self_update ",          // atualizacao remota do proprio APK (sem SSH)
    )

    // Sufixos/comandos PERIGOSOS que a allowlist DEVE bloquear mesmo se o
    // prefixo for permitido (ex: input nao deve permitir `sh`, etc.).
    private val FORBIDDEN_TOKENS = listOf(
        "rm ", "reboot", "su ", "sh ", "bash", "curl ", "wget ",
        "mount ", "umount ", "dd ", "mkfs", "chmod 777", "nc ",
        ";", "&&", "|", ">", ">>", "$(", "`", "eval ", "exec ",
    )

    /** Retorna true se o comando remoto e seguro para executar localmente. */
    private fun isCommandAllowed(command: String): Boolean {
        val c = command.trim()
        if (c.isEmpty()) return false
        // 1. Bloqueia tokens perigosos em qualquer posicao.
        for (bad in FORBIDDEN_TOKENS) {
            if (c.contains(bad)) return false
        }
        // 2. Exige que comece com um prefixo permitido (whitelist estrita).
        return ALLOWED_PREFIXES.any { c.startsWith(it) }
    }

    // ----------------------------------------------------------------\n
    private var checkInJob: Job? = null
    private var tunnelJob: Job? = null
    private var lastKnownIp: String? = null
    private var agentConfig: EsferaConfig? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // URLs do check-in (base + fallback HTTP 8080) compartilhadas entre o loop
    // periódico e o disparo imediato do NetworkCallback (troca de rede/reboot).
    @Volatile private var checkInUrls: Pair<String, String>? = null
    @Volatile private var useHttpFallback = false

    private val json = Json { ignoreUnknownKeys = true }

    // Trust-all OkHttpClient (apenas para TESTE com cert self-signed do VPS).
    // Em produção, substituir por certificado de CA real (load do KeyStore).
    private fun trustAllOkHttp(): OkHttpClient {
        return try {
            val trustAll = arrayOf<X509TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })
            val ssl = SSLContext.getInstance("TLS").apply {
                init(null, trustAll, java.security.SecureRandom())
            }
            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, trustAll[0])
                .hostnameVerifier { _, _ -> true }
                .build()
        } catch (e: Exception) {
            OkHttpClient.Builder().build()
        }
    }

    private val httpClient = HttpClient(OkHttp) {
        engine {
            preconfigured = trustAllOkHttp()
        }
        install(ContentNegotiation) {
            json(json)
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
        }
    }

    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var powerManager: PowerManager
    private var wakeLock: PowerManager.WakeLock? = null

    // ----------------------------------------------------------------\
    // Lifecycle
    // ----------------------------------------------------------------\

    private var presenceClient: PresenceClient? = null

    // Guarda de idempotência: loadConfigAndStart só roda UMA vez. O BootJobService
    // (disparado pelo próprio onCreate) e múltiplas chamadas de onStartCommand criam
    // coroutines duplicadas que se cancelam em cascata ("StandaloneCoroutine was
    // cancelled"), matando a presença/túnel. Com este flag, reinvocações apenas
    // retornam START_STICKY sem recriar jobs.
    private val started = java.util.concurrent.atomic.AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        // Agenda o job persistente de auto-start (sobrevive a reboot, sem root).
        BootJobService.schedule(this)
        // Keep-alive via AlarmManager: religa o agente se for morto por SIGKILL/OEM
        // (cobrir kill em runtime que NAO chama onDestroy). Garante que o celular
        // continue reportando ao VPS MESMO SEM USB, SEM reboot e SEM abrir o app.
        KeepAliveReceiver.schedule(this)
        createNotificationChannel()
        buildNotification() // aquece o canal de notificação
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIF_ID, notification)
        acquireWakeLock()
        android.util.Log.d("EsferaAgent", "onStartCommand: iniciando loadConfigAndStart")
        if (started.compareAndSet(false, true)) {
            // loadConfig() executa getProp()/Runtime.exec (bloqueante) e I/O de
            // arquivos: roda no Dispatchers.IO do scope SupervisorJob, NUNCA na
            // main thread. O START_STICKY + respawn cobrem kill posterior.
            scope.launch {
                loadConfigAndStart()
            }
        } else {
            android.util.Log.d("EsferaAgent", "onStartCommand: ja iniciado, ignorando duplicata")
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        unregisterNetworkCallback()
        releaseWakeLock()
        checkInJob?.cancel()
        tunnelJob?.cancel()
        presenceClient?.stop()
        scope.cancel()
        httpClient.close()
        // RESPAWN DEFENSIVO: se o sistema (OEM/Moto) matar o service sem reboot,
        // reagenda um Job one-shot em 5s para religar o agente. Garante que o
        // celular continue reportando ao VPS MESMO SEM USB e SEM reboot (regra do
        // usuário: "aparece mesmo reiniciando o WiFi e desplugado"). O BootJobService
        // ja cuida do reboot; este cobre kill em runtime.
        scheduleRespawn(this)
        super.onDestroy()
    }

    // ----------------------------------------------------------------\n    // Config
    // ----------------------------------------------------------------

    private fun getProp(name: String): String {
        return try {
            val p = Runtime.getRuntime().exec(arrayOf("getprop", name))
            val r = BufferedReader(InputStreamReader(p.inputStream))
            val v = r.readLine()?.trim() ?: ""
            p.waitFor()
            v
        } catch (e: Exception) { "" }
    }

    /**
     * Lista TODOS os caminhos candidatos de configuração, na ordem de precedência:
     * (1) /sdcard/esfera_config.json (injetado pelo app Desktop via adb shell echo —
     * sobrevive a clear de dados e é a FONTE DE VERDADE), (2) external-files do app
     * (sem permissão especial), (3) filesDir interno. O loadConfig() varre TODOS e
     * usa o primeiro com configuração VÁLIDA (não apenas o primeiro que existe — um
     * arquivo vazio não deve vencer um válido em outra ordem).
     */
    private fun resolveConfigCandidates(): List<File> {
        val list = mutableListOf<File>()
        list.add(File("/sdcard/esfera_config.json"))
        val ext = getExternalFilesDir(null)
        if (ext != null) list.add(File(ext, "esfera_config.json"))
        list.add(File(filesDir, "esfera_config.json"))
        return list
    }

    private fun isConfigValid(c: EsferaConfig): Boolean {
        return c.serverUrl.isNotBlank() && c.deviceId.isNotBlank()
    }

    private fun loadConfig(): EsferaConfig {
        // FONTE DE VERDADE: varre TODOS os caminhos candidatos e usa o primeiro
        // com configuração VÁLIDA (serverUrl + deviceId). Um arquivo existente mas
        // vazio NÃO deve vencer um válido em outra posição da lista.
        var fileConfig = EsferaConfig()
        for (candidate in resolveConfigCandidates()) {
            if (candidate.exists()) {
                try {
                    val c = json.decodeFromString<EsferaConfig>(candidate.readText())
                    if (isConfigValid(c)) { fileConfig = c; break }
                } catch (_: Exception) {}
            }
        }
        // Se nenhum arquivo válido, tenta SharedPreferences (fallback).
        if (!isConfigValid(fileConfig)) {
            val prefs = getSharedPreferences("esfera_agent", MODE_PRIVATE)
            val pc = EsferaConfig(
                serverUrl = prefs.getString("serverUrl", "") ?: "",
                deviceId = prefs.getString("deviceId", "") ?: "",
                companyId = prefs.getInt("companyId", 0)
            )
            if (isConfigValid(pc)) fileConfig = pc
        }

        // Fallback de prop (só funciona com root) — tem precedência MENOR que o arquivo.
        val propDeviceId = getProp("persist.esfera.device_id")
        val propCompany = getProp("persist.esfera.company").toIntOrNull() ?: 0
        val propServer = getProp("persist.esfera.server_address").ifEmpty { getProp("persist.esfera.hub") }

        // Mescla: arquivo tem precedência; prop preenche o que faltar (caso root).
        val resolvedDeviceId = fileConfig.deviceId.ifBlank { propDeviceId }
        val resolvedCompany = if (fileConfig.companyId > 0) fileConfig.companyId else propCompany
        val resolvedServer = fileConfig.serverUrl.ifBlank { propServer }

        // BLOQUEIO DE IDENTIDADE FACTUAL: um deviceId ESF- vindo do arquivo/prop é
        // IMUTÁVEL — nunca é substituído por ANDROID_ID (que muda em reinstall/clear
        // de dados, gerando IDs incompatíveis e sumindo o celular da VPS). Apenas se
        // NÃO houver nenhum ID persistido derivamos o fallback estável ESF-<serial>.
        val finalDeviceId = when {
            resolvedDeviceId.startsWith("ESF-") -> resolvedDeviceId
            resolvedDeviceId.isBlank() || resolvedDeviceId == "UNIQUE_DEVICE_ID" -> deriveFallbackDeviceId()
            else -> resolvedDeviceId
        }

        // Espelha a identidade resolvida de volta para o armazenamento DO APP
        // (writable sem permissão especial; o /sdcard é escrito pelo Desktop).
        try {
            val out = EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
            val ext = getExternalFilesDir(null)
            val writeTarget = if (ext != null && (ext.exists() || ext.mkdirs())) File(ext, "esfera_config.json") else File(filesDir, "esfera_config.json")
            writeTarget.writeText(json.encodeToString(EsferaConfig.serializer(), out))
        } catch (_: Exception) {}

        // 2ª camada de espelho: SharedPreferences. Hoje o prefs é apenas FONTE de
        // fallback (leitura); gravar aqui garante que a identidade factual ESF-
        // sobrevive mesmo se os 3 arquivos de config forem limpos/inacessíveis.
        try {
            getSharedPreferences("esfera_agent", MODE_PRIVATE).edit()
                .putString("serverUrl", resolvedServer)
                .putString("deviceId", finalDeviceId)
                .putInt("companyId", resolvedCompany)
                .apply()
        } catch (_: Exception) {}

        return EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
    }

    /**
     * Serial físico via Build.getSerial() (API 26+ exige READ_PHONE_STATE; sem a
     * permissão lança SecurityException e caímos no ANDROID_ID — ainda com ESF-).
     * Seriais "unknown"/vazios também são tratados como inacessíveis.
     */
    private fun getSerialNumber(): String {
        return try {
            val s = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Build.getSerial() else Build.SERIAL
            if (s.isNullOrBlank() || s.equals("unknown", ignoreCase = true)) "" else s
        } catch (_: Exception) { "" }
    }

    /**
     * Deriva o ID estável quando NÃO existe config injetada: "ESF-" + 8 primeiros
     * caracteres do serial em MAIÚSCULAS (mesmo formato que o app Desktop cruza no
     * commands.rs — serial ADB -> ESF-XXXX). Se o serial for inacessível (sem
     * permissão), usa o ANDROID_ID ainda com o prefixo ESF- (nunca pelado).
     */
    private fun deriveFallbackDeviceId(): String {
        val serial = getSerialNumber().uppercase()
        if (serial.isNotBlank()) {
            return "ESF-" + (if (serial.length >= 8) serial.substring(0, 8) else serial)
        }
        val androidId = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "UNKNOWN_DEVICE"
        } catch (e: Exception) {
            "UNKNOWN_DEVICE"
        }
        return "ESF-$androidId"
    }

    private fun startPresenceLoop(config: EsferaConfig) {
        presenceClient?.stop()
        val cleaned = config.serverUrl
            .replace("http://", "")
            .replace("https://", "")
        val host = cleaned.substringBefore(':').substringBefore('/').ifEmpty { "127.0.0.1" }
        val useTls = config.serverUrl.startsWith("https://")
        // Se TLS, a porta vem do serverUrl (ex: https://host:8443); senão fixo 7779.
        val wsPort = if (useTls) {
            cleaned.substringAfter(':').substringBefore('/').toIntOrNull() ?: 8443
        } else {
            7779
        }
        presenceClient = PresenceClient(
            context = this,
            deviceId = config.deviceId,
            serverHost = host,
            wsPort = wsPort,
            companyId = config.companyId,
            useTls = useTls,
            adbAddressProvider = { resolveCurrentIp()?.let { "$it:5555" } ?: "" }
        ).apply { start() }
    }

    private fun loadConfigAndStart() {
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: lendo config")
        val config = loadConfig()
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: serverUrl='${config.serverUrl}' deviceId='${config.deviceId}' companyId=${config.companyId}")
        android.util.Log.i("EsferaAgent", "[TUNNEL] service_started")
        android.util.Log.i("EsferaAgent", "[TUNNEL] tunnel_enabled=${config.tunnelEnabled}")
        if (config.serverUrl.isBlank() || config.deviceId.isBlank()) {
            android.util.Log.w("EsferaAgent", "loadConfigAndStart: config vazia, stopSelf")
            stopSelf()
            return
        }
        agentConfig = config
        startCheckInLoop(config)
        if (config.tunnelEnabled) {
            startTunnelLoop(config)
        }
        startPresenceLoop(config)
    }

    private fun startCheckInLoop(config: EsferaConfig) {
        android.util.Log.d("EsferaAgent", "startCheckInLoop: iniciado")
        checkInJob?.cancel()
        val host = config.serverUrl
            .replace("https://", "").replace("http://", "")
            .substringBefore(':').substringBefore('/').ifEmpty { "34.29.70.113" }
        // Compartilhado com o disparo imediato do NetworkCallback (troca de rede).
        checkInUrls = config.serverUrl to "http://$host:8080"
        checkInJob = scope.launch {
            // BACKOFF EXPONENCIAL INDESTRUTÍVEL: 2s -> 4s -> 8s -> ... -> máx 30s.
            // Reset para 2s após sucesso. Uma falha temporária de rede NUNCA derruba
            // a coroutine (SupervisorJob + scope próprio do check-in).
            var backoffMs = 2_000L
            while (isActive) {
                if (doCheckIn(config)) {
                    backoffMs = 2_000L
                    delay(CHECK_IN_INTERVAL_MS)
                } else {
                    android.util.Log.w("EsferaAgent", "Check-in falhou; retentando em ${backoffMs}ms")
                    delay(backoffMs + (0..1000).random().toLong())
                    backoffMs = (backoffMs * 2).coerceIn(2_000L, 30_000L)
                }
            }
        }
    }

    /**
     * Check-in HTTP único (loop periódico OU disparo imediato de troca de rede).
     * Retorna true em sucesso. O payload SEMPRE inclui o ID factual (esferaDeviceId),
     * o endereço ADB (<IP_LOCAL:PORTA>), companyId e o estado de bateria/tela.
     */
    private suspend fun doCheckIn(config: EsferaConfig): Boolean {
        val urls = checkInUrls ?: return false
        val ip = resolveCurrentIp()
        if (ip == null) {
            android.util.Log.w("EsferaAgent", "doCheckIn: sem IP ativo (rede indisponível)")
            return false
        }
        lastKnownIp = ip
        val battery = batteryInfo()
        return try {
            val base = if (useHttpFallback) urls.second else urls.first
            val response: HttpResponse = httpClient.post("$base/api/devices/check-in") {
                contentType(ContentType.Application.Json)
                setBody(CheckInRequest(
                    esferaDeviceId = config.deviceId,
                    currentAdbAddress = "$ip:5555",
                    companyId = config.companyId,
                    batteryLevel = battery.first,
                    isCharging = battery.second,
                    isScreenOn = isScreenInteractive()
                ))
            }
            val ok = response.status.value == 200
            if (ok) {
                android.util.Log.d("EsferaAgent", "Check-in OK: $ip")
            } else {
                android.util.Log.w("EsferaAgent", "Check-in status ${response.status.value}: $ip")
            }
            ok
        } catch (e: Exception) {
            // Fallback autônomo: se HTTPS falhar (ex: handshake TLS em Android antigo),
            // tenta HTTP (porta 8080). Garante que o celular reporta ao VPS mesmo
            // em devices mais velhos ou com incompatibilidade de cipher.
            if (!useHttpFallback && (e.message?.contains("Handshake", true) == true
                        || e.message?.contains("SSL", true) == true
                        || e.message?.contains("trust", true) == true)) {
                android.util.Log.w("EsferaAgent", "HTTPS falhou ($e), usando fallback HTTP 8080")
                useHttpFallback = true
            } else {
                android.util.Log.w("EsferaAgent", "Check-in falhou: ${e.message}")
            }
            false
        }
    }

    /** Dispara um check-in HTTP imediato (usado quando a rede ACABA de ganhar IP). */
    private fun fireImmediateCheckIn() {
        val cfg = agentConfig ?: return
        scope.launch { doCheckIn(cfg) }
    }

    private fun batteryInfo(): Pair<Int, Boolean> {
        return try {
            val bs = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = bs?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = bs?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()).toInt() else 100
            val status = bs?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL
            Pair(pct, charging)
        } catch (e: Exception) {
            Pair(100, false)
        }
    }

    private fun isScreenInteractive(): Boolean {
        return try { powerManager.isInteractive } catch (_: Exception) { false }
    }

    @Volatile private var currentTunnelSocket: Socket? = null

    // ----------------------------------------------------------------
    // Tunnel reverso (celular -> servidor, handshake por Hardware UUID)
    // Mantém socket TCP persistente; reconecta em ms quando a rede muda.
    // O backend correspondente é tunnel_server.rs (porta tunnelPort, default 8888).
    // ----------------------------------------------------------------

    private fun startTunnelLoop(config: EsferaConfig) {
        val existing = tunnelJob != null
        android.util.Log.i("EsferaAgent", "[TUNNEL] startTunnelLoop_called existing_job=$existing")
        try { currentTunnelSocket?.close() } catch (_: Exception) {}
        tunnelJob?.cancel()
        var first = true
        tunnelJob = scope.launch {
            val instanceUuid = java.util.UUID.randomUUID().toString().substring(0, 8)
            android.util.Log.i("EsferaAgent", "[TUNNEL] loop_instance_created=$instanceUuid")
            var backoffMs = 5_000L
            while (isActive) {
                val host = config.serverUrl
                    .replace("http://", "")
                    .replace("https://", "")
                    .substringBefore(':')
                    .substringBefore('/')
                    .ifEmpty { "34.29.70.113" }
                android.util.Log.i("EsferaAgent", "[TUNNEL] server_url=$host instance=$instanceUuid")
                android.util.Log.i("EsferaAgent", "[TUNNEL] tunnel_port=${config.tunnelPort}")
                try {
                    android.util.Log.i("EsferaAgent", "[TUNNEL] connect_attempt instance=$instanceUuid")
                    openTunnel(host, config.tunnelPort, config.deviceId, if (config.companyId <= 0) 1 else config.companyId, instanceUuid)
                    backoffMs = 5_000L
                } catch (e: Exception) {
                    android.util.Log.e("EsferaAgent", "[TUNNEL] connect_error instance=$instanceUuid: ${e.javaClass.simpleName}: ${e.message}")
                }
                if (first) { first = false; backoffMs = 1_000L }
                
                val waitMs = backoffMs + (0..2000).random().toLong()
                android.util.Log.i("EsferaAgent", "[TUNNEL] reconnect_scheduled instance=$instanceUuid")
                delay(waitMs)
                android.util.Log.i("EsferaAgent", "[TUNNEL] reconnect_attempt instance=$instanceUuid")
                backoffMs = (backoffMs * 2).coerceIn(5_000L, 10_000L)
            }
        }
    }

    private suspend fun openTunnel(host: String, port: Int, deviceId: String, companyId: Int, instanceUuid: String) {
        val ip = resolveCurrentIp() ?: "0.0.0.0"
        val socket = Socket()
        currentTunnelSocket = socket
        socket.connect(InetSocketAddress(host, port), 10_000)
        android.util.Log.i("EsferaAgent", "[TUNNEL] tcp_connected instance=$instanceUuid")
        socket.soTimeout = 0
        val writer = PrintWriter(socket.getOutputStream(), true)
        val reader = BufferedReader(InputStreamReader(socket.getInputStream()))

        // 1. Handshake na primeira linha (hardware_uuid = deviceId do agente)
        val hs = TunnelHandshake(
            hardwareUuid = deviceId,
            companyId = companyId,
            currentLocalIp = ip
        )
        writer.println(json.encodeToString(TunnelHandshake.serializer(), hs))
        writer.flush()
        android.util.Log.i("EsferaAgent", "[TUNNEL] handshake_sent instance=$instanceUuid")

        // 2. Loop de heartbeat L7 + leitura da resposta do servidor.
        try {
            coroutineScope {
                val readerJob = launch {
                    while (isActive) {
                        val line = try { reader.readLine() } catch (_: Exception) { null }
                        if (line == null) {
                            android.util.Log.i("EsferaAgent", "[TUNNEL] connection_closed instance=$instanceUuid")
                            return@launch
                        }
                        when {
                            line.contains("\"type\":\"ping\"") -> {
                                writer.println("""{"type":"pong"}""")
                                writer.flush()
                            }
                            line.contains("\"type\":\"welcome\"") -> {
                                android.util.Log.i("EsferaAgent", "[TUNNEL] welcome_received instance=$instanceUuid")
                                android.util.Log.i("EsferaAgent", "[TUNNEL] heartbeat_started instance=$instanceUuid")
                            }
                            line.contains("\"type\":\"proxy\"") -> {
                                val pPort = Regex("\"port\"\\s*:\\s*(\\d+)").find(line)
                                    ?.groupValues?.get(1)?.toInt() ?: 5555
                                ensureAdbdTcp(pPort)
                                try {
                                    val local = Socket("127.0.0.1", pPort)
                                    writer.println("""{"type":"proxy-ack"}""")
                                    writer.flush()
                                    launch(Dispatchers.IO) { relayToLocal(local, socket) }
                                } catch (e: Exception) {
                                    android.util.Log.e("EsferaAgent", "proxy falhou: adbd nao escuta em 127.0.0.1:$pPort (${e.message})")
                                    writer.println("""{"type":"proxy-error","message":"adbd nao escuta em 127.0.0.1:$pPort"}""")
                                    writer.flush()
                                }
                            }
                            line.contains("\"type\":\"adb_cmd\"") -> {
                                val id = Regex("\"id\"\\s*:\\s*\"?([^\",}]+)\"?").find(line)
                                    ?.groupValues?.get(1)?.trim()
                                val cmd = Regex("\"command\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(line)
                                    ?.groupValues?.get(1)
                                    ?.replace("\\\"", "\"")?.replace("\\\\", "\\")
                                if (id != null && cmd != null) {
                                    if (!isCommandAllowed(cmd)) {
                                        android.util.Log.w("EsferaAgent", "adb_cmd BLOQUEADO (fora da allowlist): $cmd")
                                        launch(Dispatchers.IO) {
                                            writer.println("""{"type":"adb_result","id":"$id","output":"ERR: comando nao permitido (allowlist): $cmd"}""")
                                            writer.flush()
                                        }
                                    } else if (cmd.startsWith("self_update ")) {
                                        val url = cmd.removePrefix("self_update ").trim()
                                        launch(Dispatchers.IO) {
                                            val out = selfUpdate(url)
                                            writer.println("""{"type":"adb_result","id":"$id","output":${JsonPrimitive(out)}}""")
                                            writer.flush()
                                        }
                                    } else {
                                        launch(Dispatchers.IO) {
                                            val out = runLocalCommand(cmd)
                                            writer.println("""{"type":"adb_result","id":"$id","output":${JsonPrimitive(out)}}""")
                                            writer.flush()
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                try {
                    while (isActive && !socket.isClosed) {
                        delay(10_000L)
                        if (socket.isClosed) break
                        writer.println("""{"type":"ping"}""")
                        writer.flush()
                    }
                } finally {
                    readerJob.cancel()
                }
            }
        } finally {
            try { socket.close() } catch (_: Exception) {}
            if (currentTunnelSocket == socket) {
                currentTunnelSocket = null
            }
        }
    }

    /// Relay bidirecional bruto entre o soquete do túnel e o ADB local do aparelho.
    /// O `local` (127.0.0.1:port) já vem conectado de quem chamou (proxy handler),
    /// que garantiu que o adbd escuta antes de confirmar o proxy-ack.
    private suspend fun relayToLocal(local: Socket, tunnel: Socket) {
        try {
            coroutineScope {
                launch { pump(tunnel.getInputStream(), local.getOutputStream()) }
                launch { pump(local.getInputStream(), tunnel.getOutputStream()) }
            }
        } catch (_: Exception) {
            // Relay encerrado (qualquer ponta fechou).
        } finally {
            try { local.close() } catch (_: Exception) {}
        }
    }

    /// Tenta deixar o adbd local escutando em TCP (porta `port`) antes de abrir o
    /// relay. AUTÔNOMO: não depende de passo manual (adb tcpip via USB). Tenta,
    /// em ordem, os métodos disponíveis no aparelho (root/su, adb nativo, setprop).
    /// Se nenhum funcionar, o relay vai falhar e o app recebe proxy-error (não trava).
    private fun ensureAdbdTcp(port: Int) {
        // Desativa o "captive portal check" do Android. Sem isso, o Android marca o
        // WiFi como "sem internet" quando o teste de conectividade falha (proxy/DNS da
        // rede da empresa) e DESCONECTA o WiFi — fazendo o celular sumir da VPS.
        try { runLocalCommand("settings put global captive_portal_mode 0") } catch (_: Exception) {}
        try { runLocalCommand("settings put global captive_portal_detection_enabled 0") } catch (_: Exception) {}

        val cmds = listOf(
            "su -c 'setprop service.adb.tcp.port $port; stop adbd; start adbd'",
            "su 0 setprop service.adb.tcp.port $port; su 0 stop adbd; su 0 start adbd",
            "adb tcpip $port",
            "setprop service.adb.tcp.port $port; stop adbd; start adbd"
        )
        for (c in cmds) {
            try { runLocalCommand(c) } catch (_: Exception) {}
            // Se a porta já abriu, para (não precisa tentar o resto).
            if (isAdbdListening(port)) break
            try { Thread.sleep(800) } catch (_: Exception) {}
        }
        // Pequena pausa extra para o adbd reiniciar em TCP.
        try { Thread.sleep(1500) } catch (_: Exception) {}
    }

    /// Verifica se o adbd local já aceita conexões TCP na porta indicada.
    private fun isAdbdListening(port: Int): Boolean {
        return try {
            val s = Socket()
            s.connect(InetSocketAddress("127.0.0.1", port), 800)
            s.close()
            true
        } catch (_: Exception) { false }
    }

    /// Copia bytes de `src` para `dst` até EOF ou erro.
    private suspend fun pump(src: InputStream, dst: OutputStream) {
        val buf = ByteArray(8192)
        try {
            var n = src.read(buf)
            while (n > 0) {
                dst.write(buf, 0, n)
                dst.flush()
                n = src.read(buf)
            }
        } catch (_: Exception) {
            // EOF ou erro de leitura/escrita: encerra este sentido do relay.
        }
    }

    /// Executa um comando localmente no aparelho (input tap/keyevent, screencap,
    /// settings, etc.) e devolve a saída concatenada (stdout+stderr). Usado pelo
    /// canal de controle remoto (adb_cmd) para fechar a bifurcação A sem root.
    private fun runLocalCommand(command: String): String {
        return try {
            val p = Runtime.getRuntime().exec(command)
            val out = p.inputStream.bufferedReader().readText()
            val err = p.errorStream.bufferedReader().readText()
            val code = try { p.waitFor() } catch (_: Exception) { -1 }
            val sb = StringBuilder()
            if (out.isNotBlank()) sb.append(out)
            if (err.isNotBlank()) sb.append(err)
            if (sb.isEmpty()) sb.append("exit=$code")
            sb.toString().trim()
        } catch (e: Exception) {
            "ERR: ${e.message}"
        }
    }

    /// Atualização remota do próprio APK SEM SSH: baixa de uma URL (servida pela VPS
    /// ou backend) e instala com `pm install -r`. Permite distribuir nova versão do
    /// agente para a operação inteira a partir do app desktop, via túnel VPS.
    private fun selfUpdate(apkUrl: String): String {
        if (apkUrl.isBlank() || (!apkUrl.startsWith("http://") && !apkUrl.startsWith("https://"))) {
            return "ERR: URL invalida (use http(s)://...)"
        }
        return try {
            val client = OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .build()
            val req = okhttp3.Request.Builder().url(apkUrl).build()
            val resp = client.newCall(req).execute()
            if (!resp.isSuccessful) return "ERR: download falhou (${resp.code})"
            val apkFile = File(filesDir, "esfera_agent_update.apk")
            resp.body?.byteStream()?.use { input ->
                apkFile.outputStream().use { out -> input.copyTo(out) }
            }
            if (!apkFile.exists() || apkFile.length() < 100_000) return "ERR: APK vazio/pequeno"
            val install = runLocalCommand("pm install -r -d ${apkFile.absolutePath}")
            "OK: baixado (${(apkFile.length() / 1024)}KB) instalado: $install"
        } catch (e: Exception) {
            "ERR: ${e.message}"
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        // DISPARO IMEDIATO: no exato momento em que uma interface (Wi-Fi/Dados
        // Móveis) ganha conectividade, faz check-in HTTP na hora — sem esperar o
        // intervalo de 30s. Sem isso o celular ficava amarelo/offline na VPS após
        // trocar de rede, ser desplugado do USB ou reiniciar.
        override fun onAvailable(network: Network) {
            android.util.Log.d("EsferaAgent", "onAvailable: rede ganhou conectividade — check-in imediato")
            fireImmediateCheckIn()
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = linkProperties.linkAddresses
                .firstOrNull { it.address is java.net.Inet4Address }
                ?.address?.hostAddress
            if (ip != null && ip != lastKnownIp) {
                lastKnownIp = ip
                android.util.Log.d("EsferaAgent", "IP mudou: $ip — check-in imediato + reconexão do túnel")
                // Reconexão imediata do túnel (entrega "reconexão em ms" do design).
                // Cancela o túnel anterior para não vazar/duplicar sockets.
                tunnelJob?.cancel()
                agentConfig?.let {
                    startTunnelLoop(it)
                    fireImmediateCheckIn()
                }
            }
        }
    }

    private fun registerNetworkCallback() {
        // Sem addTransportType: captura QUALQUER mudança de rede (Wi-Fi, dados móveis,
        // VPN). Antes restringia a TRANSPORT_WIFI, o que fazia o túnel NÃO reconectar
        // quando o celular usava 4G/5G (casa sem Wi-Fi, por ex.), deixando o celular
        // invisível no app desktop.
        val request = android.net.NetworkRequest.Builder().build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
    }

    private fun unregisterNetworkCallback() {
        try { connectivityManager.unregisterNetworkCallback(networkCallback) } catch (_: Exception) {}
    }

    private fun resolveCurrentIp(): String? {
        val activeNetwork = connectivityManager.activeNetwork ?: return null
        val links = connectivityManager.getLinkProperties(activeNetwork) ?: return null
        return links.linkAddresses
            .firstOrNull { it.address is java.net.Inet4Address }
            ?.address?.hostAddress
    }

    // ----------------------------------------------------------------
    // WakeLock
    // ----------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "EsferaAgent:CheckInLock"
            ).apply { acquire(TimeUnit.MINUTES.toMillis(10)) }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
            wakeLock = null
        }
    }

    // ----------------------------------------------------------------
    // Notification
    // ----------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Esfera Agent",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Servico do Agente Esfera"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val channelId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) CHANNEL_ID else ""
        return Notification.Builder(this, channelId)
            .setContentTitle("Esfera Agent")
            .setContentText("Serviço de check-in ativo")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
    }
}
