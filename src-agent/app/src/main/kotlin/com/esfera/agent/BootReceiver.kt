package com.esfera.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "android.intent.action.MY_PACKAGE_REPLACED" -> {
                // Android 12+ proíbe startService em background a partir de receiver;
                // usa startForegroundService para subir o agente automaticamente.
                val serviceIntent = Intent(context, EsferaAgentService::class.java)
                try {
                    context.startForegroundService(serviceIntent)
                } catch (e: Exception) {
                    // Fallback para versões antigas
                    context.startService(serviceIntent)
                }
            }
        }
    }
}
