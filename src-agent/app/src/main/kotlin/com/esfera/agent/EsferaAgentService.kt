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
    val companyId: Int = 0
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

    // ----------------------------------------------------------------\n
    private var checkInJob: Job? = null
    private var tunnelJob: Job? = null
    private var lastKnownIp: String? = null
    private var agentConfig: EsferaConfig? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val json = Json { ignoreUnknownKeys = true }
    private val httpClient = HttpClient(OkHttp) {
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
            loadConfigAndStart()
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
     * Resolve o arquivo de configuração. O app (Android 11+) NÃO tem permissão de
     * ler /sdcard/ raiz sem MANAGE_EXTERNAL_STORAGE, mas TEM acesso total a
     * getExternalFilesDir (sdcard/Android/data/com.esfera.agent/files) sem permissão
     * extra. Tentamos, em ordem: (1) external-files do app, (2) /sdcard/esfera_config.json
     * (legado, escrito pelo desktop via adb — exige permissão), (3) filesDir interno.
     * O primeiro que existir vence; se nenhum existir, retorna o external-files (local
     * padrão de escrita).
     */
    private fun resolveConfigFile(): File {
        val ext = getExternalFilesDir(null)
        if (ext != null) {
            val f = File(ext, "esfera_config.json")
            if (f.exists()) return f
        }
        val legacy = File("/sdcard/esfera_config.json")
        if (legacy.exists()) return legacy
        val internal = File(filesDir, "esfera_config.json")
        if (internal.exists()) return internal
        // Nenhum existe: usa external-files como padrão de escrita.
        return if (ext != null) File(ext, "esfera_config.json") else internal
    }

    private fun loadConfig(): EsferaConfig {
        val defaultAndroidId = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "UNKNOWN_DEVICE"
        } catch (e: Exception) {
            "UNKNOWN_DEVICE"
        }

        // FONTE DE VERDADE: arquivo de config resolvido por resolveConfigFile()
        // (external-files do app, sem permissão especial; sobrevive a reboot e
        // reinstalação do app). Props persist.esfera.* NÃO são graváveis em runtime
        // sem root, então são apenas fallback secundário. O arquivo garante que o
        // celular NUNCA perca a identidade nem a empresa ao reiniciar.
        val configFile = resolveConfigFile()
        val fileConfig = if (configFile.exists()) {
            try {
                json.decodeFromString<EsferaConfig>(configFile.readText())
            } catch (e: Exception) {
                EsferaConfig()
            }
        } else {
            val prefs = getSharedPreferences("esfera_agent", MODE_PRIVATE)
            EsferaConfig(
                serverUrl = prefs.getString("serverUrl", "") ?: "",
                deviceId = prefs.getString("deviceId", "") ?: "",
                companyId = prefs.getInt("companyId", 0)
            )
        }

        // Fallback de prop (só funciona com root) — tem precedência MENOR que o arquivo.
        val propDeviceId = getProp("persist.esfera.device_id")
        val propCompany = getProp("persist.esfera.company").toIntOrNull() ?: 0
        val propServer = getProp("persist.esfera.server_address").ifEmpty { getProp("persist.esfera.hub") }

        // Mescla: arquivo tem precedência; prop preenche o que faltar (caso root).
        val resolvedDeviceId = fileConfig.deviceId.ifBlank { propDeviceId }
        val resolvedCompany = if (fileConfig.companyId > 0) fileConfig.companyId else propCompany
        val resolvedServer = fileConfig.serverUrl.ifBlank { propServer }

        val finalDeviceId = if (resolvedDeviceId.isBlank() || resolvedDeviceId == "UNIQUE_DEVICE_ID") {
            defaultAndroidId
        } else {
            resolvedDeviceId
        }

        // Espelha a identidade resolvida de volta no arquivo para resiliência cruzada.
        try {
            val out = EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
            configFile.writeText(json.encodeToString(EsferaConfig.serializer(), out))
        } catch (_: Exception) {}

        return EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
    }

    private fun startPresenceLoop(config: EsferaConfig) {
        presenceClient?.stop()
        val host = config.serverUrl
            .replace("http://", "")
            .replace("https://", "")
            .substringBefore(':')
            .substringBefore('/')
            .ifEmpty { "127.0.0.1" }
        presenceClient = PresenceClient(
            context = this,
            deviceId = config.deviceId,
            serverHost = host,
            wsPort = 7779,
            companyId = config.companyId
        ).apply { start() }
    }

    private fun loadConfigAndStart() {
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: lendo config")
        val config = loadConfig()
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: serverUrl='${config.serverUrl}' deviceId='${config.deviceId}' companyId=${config.companyId}")
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
        checkInJob = scope.launch {
            while (isActive) {
                val ip = resolveCurrentIp()
                android.util.Log.d("EsferaAgent", "startCheckInLoop: ip=$ip")
                if (ip != null) {
                    lastKnownIp = ip
                    try {
                        val response: HttpResponse = httpClient.post("${config.serverUrl}/api/devices/check-in") {
                            contentType(ContentType.Application.Json)
                            setBody(CheckInRequest(
                                esferaDeviceId = config.deviceId,
                                currentAdbAddress = ip,
                                companyId = config.companyId
                            ))
                        }
                        if (response.status.value == 200) {
                            android.util.Log.d("EsferaAgent", "Check-in OK: $ip")
                        } else {
                            android.util.Log.w("EsferaAgent", "Check-in status ${response.status.value}: $ip")
                        }
                    } catch (e: Exception) {
                        android.util.Log.w("EsferaAgent", "Check-in falhou: ${e.message}")
                    }
                }
                delay(CHECK_IN_INTERVAL_MS)
            }
        }
    }

    // ----------------------------------------------------------------
    // Tunnel reverso (celular -> servidor, handshake por Hardware UUID)
    // Mantém socket TCP persistente; reconecta em ms quando a rede muda.
    // O backend correspondente é tunnel_server.rs (porta tunnelPort, default 8888).
    // ----------------------------------------------------------------

    private fun startTunnelLoop(config: EsferaConfig) {
        tunnelJob?.cancel() // evita duplo túnel se rechamado
        var first = true
        tunnelJob = scope.launch {
            var backoffMs = 5_000L
            while (isActive) {
                val host = config.serverUrl
                    .replace("http://", "")
                    .replace("https://", "")
                    .substringBefore(':')
                    .substringBefore('/')
                    .ifEmpty { "127.0.0.1" }
                try {
                    openTunnel(host, config.tunnelPort, config.deviceId, config.companyId)
                    backoffMs = 5_000L // reset em caso de fechamento limpo
                } catch (e: Exception) {
                    android.util.Log.w("EsferaAgent", "Túnel caiu: ${e.message}")
                }
                if (first) { first = false; backoffMs = 1_000L } // A primeira tentativa após ligar o app é rápida
                
                // Adiciona um Jitter de 0 a 2 segundos para evitar "thundering herd" (todos conectando no mesmo ms)
                delay(backoffMs + (0..2000).random().toLong())
                
                // Backoff respeitando o limite pedido: entre 5 e 10 segundos de máximo.
                backoffMs = (backoffMs * 2).coerceIn(5_000L, 10_000L)
            }
        }
    }

    private suspend fun openTunnel(host: String, port: Int, deviceId: String, companyId: Int) {
        val ip = resolveCurrentIp() ?: "0.0.0.0"
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), 10_000)
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

        // 2. Loop de heartbeat L7 + leitura da resposta do servidor.
        //    Se o servidor fechar o socket (readLine() == null), encerramos o
        //    coroutineScope filho -> openTunnel retorna -> startTunnelLoop reconecta.
        coroutineScope {
            val readerJob = launch {
                while (isActive) {
                    val line = try { reader.readLine() } catch (_: Exception) { null }
                    if (line == null) {
                        // EOF ou erro de leitura: o servidor caiu. Sai do escopo.
                        return@launch
                    }
                    // Trata mensagens de controle enviadas pelo servidor (túnel reverso).
                    when {
                        line.contains("\"type\":\"ping\"") -> {
                            writer.println("""{"type":"pong"}""")
                            writer.flush()
                        }
                        line.contains("\"type\":\"proxy\"") -> {
                            val port = Regex("\"port\"\\s*:\\s*(\\d+)").find(line)
                                ?.groupValues?.get(1)?.toInt() ?: 5555
                            // Sinaliza ack e abre o relay local (ADB do aparelho <-> túnel).
                            writer.println("""{"type":"proxy-ack"}""")
                            writer.flush()
                            launch(Dispatchers.IO) { relayToLocal(socket, port) }
                        }
                        line.contains("\"type\":\"adb_cmd\"") -> {
                            // Comando remoto solicitado pelo app desktop via VPS.
                            // Executa LOCALMENTE no aparelho (input/screencap/etc.) e
                            // devolve a saída. Fecha a bifurcação A: celular remoto
                            // (via_tunnel) passa a ser controlável sem root.
                            val id = Regex("\"id\"\\s*:\\s*\"?([^\",}]+)\"?").find(line)
                                ?.groupValues?.get(1)?.trim()
                            val cmd = Regex("\"command\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(line)
                                ?.groupValues?.get(1)
                                ?.replace("\\\"", "\"")?.replace("\\\\", "\\")
                            if (id != null && cmd != null) {
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

            try {
                while (isActive && !socket.isClosed) {
                    delay(10_000L) // envia ping a cada 10s (backend tolera 45s de silêncio)
                    if (socket.isClosed) break
                    writer.println("""{"type":"ping"}""")
                    writer.flush()
                }
            } finally {
                readerJob.cancel()
            }
        }
    }

    /// Relay bidirecional bruto entre o soquete do túnel e o ADB local do aparelho
    /// (127.0.0.1:port). Chamado quando o servidor pede um proxy (ADB reverso via túnel).
    private suspend fun relayToLocal(tunnel: Socket, port: Int) {
        try {
            val local = Socket("127.0.0.1", port)
            coroutineScope {
                launch { pump(tunnel.getInputStream(), local.getOutputStream()) }
                launch { pump(local.getInputStream(), tunnel.getOutputStream()) }
            }
            local.close()
        } catch (_: Exception) {
            // Relay encerrado (qualquer ponta fechou).
        }
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

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = linkProperties.linkAddresses
                .firstOrNull { it.address is java.net.Inet4Address }
                ?.address?.hostAddress
            if (ip != null && ip != lastKnownIp) {
                lastKnownIp = ip
                android.util.Log.d("EsferaAgent", "IP mudou: $ip — reconectando túnel reverso")
                // Reconexão imediata do túnel (entrega "reconexão em ms" do design).
                // Cancela o túnel anterior para não vazar/duplicar sockets.
                tunnelJob?.cancel()
                agentConfig?.let { startTunnelLoop(it) }
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
