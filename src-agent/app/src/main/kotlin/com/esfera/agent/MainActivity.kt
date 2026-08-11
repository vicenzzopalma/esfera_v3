package com.esfera.agent

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Assistente de primeira execução: deixa o agente "indestrutível" sem depender
 * de o usuário saber configurar nada.
 *
 * Camadas de sobrevivência (todas acionadas aqui):
 *  1. Agenda BootJobService (JobScheduler setPersisted) + KeepAliveReceiver (AlarmManager).
 *  2. Pede "Sem restrição de bateria" (senão o Android mata o serviço em minutos).
 *  3. Leva o usuário a ativar o Device Admin (e, em seguida, o dono aplica
 *     `dpm set-device-owner` via ADB para travar como Device Owner — app não
 *     desinstalável e imune a otimização de bateria, sem root).
 *  4. Inicia o agente em foreground.
 *
 * Nota: se o aparelho estiver ROOTEADO e o app instalado em /system/priv-app,
 * as camadas acima são redundantes mas inofensivas — o app já é de sistema.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        private const val REQ_IGNORE_BATTERY = 1001
        private const val REQ_DEVICE_ADMIN = 1002
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Agenda autostart (idempotente).
        BootJobService.schedule(this)
        KeepAliveReceiver.schedule(this)

        // 2. Bateria sem restrição.
        requestBatteryWhiteList()

        // 3. Device Admin (preparação para Device Owner).
        requestDeviceAdmin()

        // 4. Sobe o agente em foreground.
        val svc = Intent(this, EsferaAgentService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc)
        } else {
            startService(svc)
        }

        Toast.makeText(this, "Esfera Agent ativo — mantenha a bateria sem restrição e ative o administrador.", Toast.LENGTH_LONG).show()
        finish()
    }

    private fun requestBatteryWhiteList() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            val pkg = packageName
            if (!pm.isIgnoringBatteryOptimizations(pkg)) {
                try {
                    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    i.data = Uri.parse("package:$pkg")
                    startActivityForResult(i, REQ_IGNORE_BATTERY)
                } catch (e: Exception) {
                    // fallback: abre a tela geral de bateria
                    try {
                        startActivity(Intent(Settings.ACTION_SETTINGS))
                    } catch (_: Exception) { }
                }
            }
        }
    }

    private fun requestDeviceAdmin() {
        val admin = ComponentName(this, AdminReceiver::class.java)
        val dm = getSystemService(android.app.admin.DevicePolicyManager::class.java)
        if (dm != null && !dm.isAdminActive(admin)) {
            val i = Intent(android.app.admin.DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
            i.putExtra(android.app.admin.DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
            i.putExtra(android.app.admin.DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "O Esfera Agent precisa de privilégios de administrador para permanecer ativo e rastreável.")
            try {
                startActivityForResult(i, REQ_DEVICE_ADMIN)
            } catch (_: Exception) { }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_DEVICE_ADMIN && resultCode == Activity.RESULT_OK) {
            // Usuário ativou o admin. O dono deve aplicar Device Owner via ADB:
            //   adb shell dpm set-device-owner com.esfera.agent/.AdminReceiver
            Toast.makeText(this, "Administrador ativo. Para travar como Device Owner, rode o script setup_esfera_device.bat no PC.", Toast.LENGTH_LONG).show()
        }
        finish()
    }
}
