package com.esfera.agent

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receiver de Device Admin (complementa o device_admin.xml e o <receiver> do
 * AndroidManifest). Mantido enxuto de propósito: a política de administração é
 * declarada no XML; este receiver apenas sinaliza ao sistema os eventos de
 * admin (habilitado/desabilitado/provisioning).
 *
 * NOTA DE INTEGRAÇÃO: criado para fechar o receiver que o AndroidManifest
 * referencia (android:name=".AdminReceiver"). Soma-se ao agente resiliente
 * (KeepAlive + BootJob + allowlist de comandos) — não o substitui. Se no futuro
 * o alvo virar Device Owner (DPC), este receiver continua válido como
 * componente de políticas locais.
 */
class AdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i("EsferaAgent", "AdminReceiver: device admin HABILITADO")
        startAgent(context)
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.i("EsferaAgent", "AdminReceiver: device admin desabilitado")
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        Log.i("EsferaAgent", "AdminReceiver: profile provisioning completo (Device Owner)")
        startAgent(context)
    }

    /** Ao virar Device Owner/Admin, inicia o agente em foreground sozinho.
     *  Garante auto-start nativo sem depender de abrir o app (resolve o
     *  bloqueio de background-start do Android 8 em apps recém-instalados). */
    private fun startAgent(context: Context) {
        try {
            val i = Intent(context, EsferaAgentService::class.java)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        } catch (e: Exception) {
            Log.w("EsferaAgent", "AdminReceiver: falha ao iniciar agente: ${e.message}")
        }
    }
}
