package com.esfera.agent

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.util.Log
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class HeartbeatPayload(
    val uuid: String,
    val batteryLevel: Int,
    val isCharging: Boolean,
    val isScreenOn: Boolean
)

class PresenceClient(
    private val context: Context,
    private val deviceId: String,
    private val serverHost: String,
    private val wsPort: Int = 7779
) {
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var job: Job? = null
    private val json = Json { ignoreUnknownKeys = true }

    private val client = HttpClient(Android) {
        install(WebSockets)
    }

    fun start() {
        job?.cancel()
        job = scope.launch {
            var backoffMs = 5_000L
            while (isActive) {
                try {
                    val url = "ws://$serverHost:$wsPort/ws/presence"
                    Log.d("PresenceClient", "Conectando ao Presence WS: $url")
                    
                    client.webSocket(urlString = url) {
                        Log.i("PresenceClient", "WebSocket de Presença CONECTADO!")
                        backoffMs = 5_000L

                        while (isActive) {
                            val batteryInfo = getBatteryInfo(context)
                            val screenOn = isScreenOn(context)

                            val payload = HeartbeatPayload(
                                uuid = deviceId,
                                batteryLevel = batteryInfo.first,
                                isCharging = batteryInfo.second,
                                isScreenOn = screenOn
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

                delay(backoffMs + (0..2000).random().toLong())
                backoffMs = (backoffMs * 2).coerceIn(5_000L, 10_000L)
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
