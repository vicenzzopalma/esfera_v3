package com.esfera.agent

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Keep-alive via AlarmManager: acorda periodicamente (a cada 10 min) e religa o
 * EsferaAgentService CASO ele não esteja rodando.
 *
 * Por que isso e não so JobScheduler/onDestroy:
 *  - OEMs (Moto) matam o service com SIGKILL para liberar RAM -> onDestroy NAO
 *    e chamado -> o respawn agendado em onDestroy nunca dispara.
 *  - O BootReceiver so cobre reboot REAL, nao kill em runtime.
 *  - AlarmManager setExactAndAllowWhileIdle ignora Doze e garante que o agente
 *    volte SOZINHO mesmo sem USB, sem reboot e sem abrir o app (regra do usuario:
 *    "aparece mesmo reiniciando o WiFi e desplugado").
 *
 * O alarme e reagendado a cada disparo, formando um heartbeat de sobrevivencia.
 */
class KeepAliveReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION = "com.esfera.agent.KEEP_ALIVE"
        const val REQUEST_CODE = 4244
        const val INTERVAL_MS = 10 * 60 * 1000L // 10 minutos

        /** Agenda o proximo disparo do keep-alive. Idempotente. */
        fun schedule(context: Context) {
            try {
                val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                val intent = Intent(context, KeepAliveReceiver::class.java).apply {
                    action = ACTION
                }
                val pi = android.app.PendingIntent.getBroadcast(
                    context,
                    REQUEST_CODE,
                    intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                                android.app.PendingIntent.FLAG_IMMUTABLE else 0
                )
                // Cancella agendamento anterior e cria um novo (evita duplicar).
                am.cancel(pi)
                val trigger = System.currentTimeMillis() + INTERVAL_MS
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(
                        android.app.AlarmManager.RTC_WAKEUP,
                        trigger,
                        pi
                    )
                } else {
                    am.setExact(android.app.AlarmManager.RTC_WAKEUP, trigger, pi)
                }
                Log.i("EsferaAgent", "KeepAlive agendado (prox. em 10min)")
            } catch (e: Exception) {
                Log.w("EsferaAgent", "KeepAlive falhou ao agendar: ${e.message}")
            }
        }
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != ACTION) return
        Log.i("EsferaAgent", "KeepAlive disparado — verificando agente")
        // Reagenda o proximo (heartbeat de sobrevivencia).
        schedule(context)
        // Se o service nao estiver rodando, religa.
        if (!isServiceRunning(context)) {
            Log.i("EsferaAgent", "KeepAlive: agente morto, religando...")
            val serviceIntent = Intent(context, EsferaAgentService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.w("EsferaAgent", "KeepAlive falhou ao religar: ${e.message}")
            }
        } else {
            Log.i("EsferaAgent", "KeepAlive: agente vivo, ok")
        }
    }

    private fun isServiceRunning(context: Context): Boolean {
        val mgr = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        for (info in mgr.getRunningServices(Int.MAX_VALUE)) {
            if (EsferaAgentService::class.java.name == info.service.className) {
                return true
            }
        }
        return false
    }
}
