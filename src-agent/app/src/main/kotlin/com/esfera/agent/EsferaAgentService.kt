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
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.timeout
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
    val deviceId: String = ""
)

@Serializable
data class CheckInRequest(
    val esferaDeviceId: String,
    val currentAdbAddress: String
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
    private var lastKnownIp: String? = null

    private val json = Json { ignoreUnknownKeys = true }
    private val httpClient = HttpClient(Android) {
        install(io.ktor.client.plugins.contentnegotiation.ContentNegotiation) {
            json(json)
        }
        timeout { requestTimeoutMillis = 10_000 }
    }

    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var powerManager: PowerManager
    private var wakeLock: PowerManager.WakeLock? = null

    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------

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
        scope.cancel()
        httpClient.close()
        super.onDestroy()
    }

    // ----------------------------------------------------------------
    // Config
    // ----------------------------------------------------------------

    private fun loadConfig(): EsferaConfig {
        val file = File(CONFIG_FILE)
        return if (file.exists()) {
            try {
                json.decodeFromString(file.readText())
            } catch (e: Exception) {
                EsferaConfig()
            }
        } else {
            // Fallback: SharedPreferences
            val prefs = getSharedPreferences("esfera_agent", MODE_PRIVATE)
            EsferaConfig(
                serverUrl = prefs.getString("serverUrl", "") ?: "",
                deviceId = prefs.getString("deviceId", "") ?: ""
            )
        }
    }

    private fun loadConfigAndStart() {
        val config = loadConfig()
        if (config.serverUrl.isBlank() || config.deviceId.isBlank()) {
            stopSelf()
            return
        }
        startCheckInLoop(config)
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
                            setBody(CheckInRequest(esferaDeviceId = config.deviceId, currentAdbAddress = ip))
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
    // IP resolution via ConnectivityManager.NetworkCallback
    // ----------------------------------------------------------------

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = linkProperties.linkAddresses
                .firstOrNull { it.address is java.net.Inet4Address }
                ?.address?.hostAddress
            if (ip != null && ip != lastKnownIp) {
                android.util.Log.d("EsferaAgent", "IP mudou: $ip")
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
