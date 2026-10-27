package com.esfera.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import com.esfera.agent.accessibility.EsferaAccessibilityService

/**
 * Recebe pedidos de digitação humana do Desktop (`adb shell am broadcast -a com.esfera.agent.TYPE_TEXT`)
 * e os entrega ao serviço de acessibilidade, que digita tecla a tecla no campo focado seguindo o
 * cronograma (ms por tecla) calculado pelo modelo psicomotor do motor C++ do Desktop.
 *
 * Extras: `id` (identificador do pedido), `b64` (texto UTF-8 em Base64), `delays` (ms por code point,
 * separados por vírgula), `clear` (esvaziar o campo antes de digitar).
 *
 * Responde pelo código de resultado do broadcast ordenado (o `am broadcast` imprime
 * "Broadcast completed: result=N"): 1 aceito, 2 acessibilidade inativa, 3 sem campo editável,
 * 4 argumentos inválidos, 5 ocupado digitando outro pedido.
 * O fim da digitação é anunciado no logcat (tag EsferaTyping): "TYPED <id> OK" ou "TYPED <id> FAIL <motivo>".
 */
class TypeTextReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION = "com.esfera.agent.TYPE_TEXT"
        const val ACTION_DUMP_UI = "com.esfera.agent.DUMP_UI"
        private const val TAG = "EsferaTyping"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == ACTION_DUMP_UI) {
            // Leitura rápida da tela: XML no formato do uiautomator, em Base64 no resultData
            // (o `am broadcast` imprime `data="..."`). Código 1 ok, 2 acessibilidade inativa, 3 sem janela.
            val service = EsferaAccessibilityService.instance
            if (service == null) {
                resultCode = 2
                return
            }
            val xml = try { service.dumpUiXml() } catch (e: Exception) { null }
            if (xml == null) {
                resultCode = 3
                return
            }
            resultData = Base64.encodeToString(xml.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
            resultCode = 1
            return
        }
        if (intent?.action != ACTION) return
        val id = intent.getStringExtra("id")?.takeIf { it.isNotBlank() } ?: "sem-id"
        val b64 = intent.getStringExtra("b64")
        val delaysRaw = intent.getStringExtra("delays") ?: ""
        val clear = intent.getBooleanExtra("clear", false)

        val text: String? = try {
            if (b64 == null) null else String(Base64.decode(b64, Base64.DEFAULT), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
        if (text == null) {
            resultCode = 4
            Log.w(TAG, "TYPED $id FAIL argumentos invalidos (b64 ausente ou corrompido)")
            return
        }
        val delays = delaysRaw.split(',')
            .filter { it.isNotBlank() }
            .mapNotNull { it.trim().toLongOrNull() }

        val service = EsferaAccessibilityService.instance
        if (service == null) {
            resultCode = 2
            Log.w(TAG, "TYPED $id FAIL servico de acessibilidade inativo")
            return
        }
        resultCode = service.typeHumanAsync(id, text, delays, clear)
    }
}
