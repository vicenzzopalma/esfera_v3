package com.esfera.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
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
import io.ktor.client.engine.android.Android
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
        const val CONFIG_FILE = "/sdcard/esfera_config.json"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var checkInJob: Job? = null
    private var tunnelJob: Job? = null
    private var lastKnownIp: String? = null
    private var agentConfig: EsferaConfig? = null

    private val json = Json { ignoreUnknownKeys = true }
    private val httpClient = HttpClient(Android) {
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

    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------

    private var presenceClient: PresenceClient? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIF_ID, notification)
        acquireWakeLock()
        loadConfigAndStart()
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
        super.onDestroy()
    }

    // ----------------------------------------------------------------
    // Config
    // ----------------------------------------------------------------

    private fun loadConfig(): EsferaConfig {
        val defaultAndroidId = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "UNKNOWN_DEVICE"
        } catch (e: Exception) {
            "UNKNOWN_DEVICE"
        }

        val configFile = File(filesDir, "esfera_config.json")
        val loadedConfig = if (configFile.exists()) {
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

        val finalDeviceId = if (loadedConfig.deviceId.isBlank() || loadedConfig.deviceId == "UNIQUE_DEVICE_ID") {
            defaultAndroidId
        } else {
            loadedConfig.deviceId
        }

        return loadedConfig.copy(deviceId = finalDeviceId)
    }

    private fun loadConfigAndStart() {
        val config = loadConfig()
        if (config.serverUrl.isBlank() || config.deviceId.isBlank()) {
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

    // ----------------------------------------------------------------
    // Check-in loop
    // ----------------------------------------------------------------

    private fun startCheckInLoop(config: EsferaConfig) {
        checkInJob?.cancel()
        checkInJob = scope.launch {
            while (isActive) {
                val ip = resolveCurrentIp()
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

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = linkProperties.linkAddresses
                .firstOrNull { it.address is java.net.Inet4Address }
                ?.address?.hostAddress
            if (ip != null && ip != lastKnownIp) {
                lastKnownIp = ip
                android.util.Log.d("EsferaAgent", "IP mudou: $ip — reconectando túnel reverso")
                // Reconexão imediata do túnel (entrega "reconexão em ms" do design)
                agentConfig?.let { startTunnelLoop(it) }
            }
        }
    }

    private fun registerNetworkCallback() {
        val request = android.net.NetworkRequest.Builder()
            .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
            .build()
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
