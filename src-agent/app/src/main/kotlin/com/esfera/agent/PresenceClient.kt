package com.esfera.agent

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.util.Log
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate
import okhttp3.OkHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class HeartbeatPayload(
    val uuid: String,
    val esferaDeviceId: String = "",
    val currentAdbAddress: String = "",
    val batteryLevel: Int,
    val isCharging: Boolean,
    val isScreenOn: Boolean,
    // COMPANY_ID: isolamento obrigatório no VPS (presence_server.rs).
    val companyId: Int = 0
)

class PresenceClient(
    private val context: Context,
    private val deviceId: String,
    private val serverHost: String,
    private val wsPort: Int = 7779,
    private val companyId: Int = 0,
    private val useTls: Boolean = false,
    private val adbAddressProvider: () -> String = { "" }
) {
    // SupervisorJob: uma falha temporária do WebSocket (oscilação de rede) NUNCA
    // cancela coroutines irmãs do scope (regra de indelestrutibilidade do agente).
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val json = Json { ignoreUnknownKeys = true }

    // Trust-all para WSS com cert self-signed (TESTE). Producao: CA real.
    private fun trustAllOkHttp(): okhttp3.OkHttpClient {
        return try {
            val trustAll = arrayOf<X509TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })
            val ssl = SSLContext.getInstance("TLS").apply { init(null, trustAll, java.security.SecureRandom()) }
            okhttp3.OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, trustAll[0])
                .hostnameVerifier { _, _ -> true }
                .build()
        } catch (e: Exception) { okhttp3.OkHttpClient.Builder().build() }
    }

    private val client = HttpClient(OkHttp) {
        engine { preconfigured = trustAllOkHttp() }
        install(WebSockets)
    }

    fun start() {
        job?.cancel()
        job = scope.launch {
            // BACKOFF EXPONENCIAL INDESTRUTÍVEL: 2s -> 4s -> 8s -> ... -> máx 30s.
            // Reset para 2s assim que a conexão WebSocket voltar a subir.
            var backoffMs = 2_000L
            while (isActive) {
                try {
                    val scheme = if (useTls) "wss" else "ws"
                    val url = "$scheme://$serverHost:$wsPort/ws/presence"
                    Log.d("PresenceClient", "Conectando ao Presence WS: $url")

                    client.webSocket(urlString = url) {
                        Log.i("PresenceClient", "WebSocket de Presença CONECTADO!")
                        backoffMs = 2_000L

                        while (isActive) {
                            val batteryInfo = getBatteryInfo(context)
                            val screenOn = isScreenOn(context)

                            val payload = HeartbeatPayload(
                                uuid = deviceId,
                                esferaDeviceId = deviceId,
                                currentAdbAddress = adbAddressProvider(),
                                batteryLevel = batteryInfo.first,
                                isCharging = batteryInfo.second,
                                isScreenOn = screenOn,
                                companyId = companyId
                            )

                            val text = json.encodeToString(payload)
                            send(Frame.Text(text))

                            // Aguarda ACK ou intervalo de 5 segundos
                            delay(5_000L)
                        }
                    }
                } catch (e: Exception) {
                    Log.w("PresenceClient", "Erro/Queda no WebSocket de Presença: ${e.message}")
                }

                Log.w("PresenceClient", "Reconectando em ${backoffMs}ms")
                delay(backoffMs + (0..1000).random().toLong())
                backoffMs = (backoffMs * 2).coerceIn(2_000L, 30_000L)
            }
        }
    }

    fun stop() {
        job?.cancel()
        client.close()
    }

    private fun getBatteryInfo(context: Context): Pair<Int, Boolean> {
        val intentFilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryStatus: Intent? = context.registerReceiver(null, intentFilter)
        val level: Int = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale: Int = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()).toInt() else 100

        val status: Int = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL

        return Pair(batteryPct, isCharging)
    }

    private fun isScreenOn(context: Context): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return powerManager.isInteractive
    }
}
