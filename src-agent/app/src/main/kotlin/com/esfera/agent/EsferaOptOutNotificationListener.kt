package com.esfera.agent

import android.app.Notification
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.text.Normalizer
import java.util.Locale

class EsferaOptOutNotificationListener : NotificationListenerService() {
    // Apenas chaves de pedidos reconhecidos, para evitar repetição ao atualizar a notificação.
    private val recorded = LinkedHashSet<String>()

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "Listener de notificações conectado")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != "com.whatsapp") return
        val notification = sbn.notification ?: return
        if ((notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return
        val extras = notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        if (title.isEmpty() || ':' in title) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)) return
        if (!extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE).isNullOrBlank()) return

        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (messages != null) {
            val self = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                extras.getParcelable<android.app.Person>(Notification.EXTRA_MESSAGING_PERSON) else null
            for (message in Notification.MessagingStyle.Message.getMessagesFromBundleArray(messages)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val sender = message.senderPerson ?: continue // null indica envio próprio
                    if (self != null && ((self.key != null && self.key == sender.key) ||
                            (self.name != null && self.name == sender.name))) continue
                } else if (message.sender == null) continue
                val text = message.text?.toString()?.trim().orEmpty()
                recordIfOptOut(sbn.key, title, text, message.timestamp)
            }
        } else {
            // Resumos agregados e texto com prefixo de remetente são ambíguos (grupos/envios próprios).
            if (extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES) != null) return
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
            if (':' in text) return
            recordIfOptOut(sbn.key, title, text, sbn.postTime)
        }
    }

    private fun recordIfOptOut(notificationKey: String, title: String, text: String, timestamp: Long) {
        if (!isOptOut(text)) return
        val key = "$notificationKey\u0000$timestamp\u0000$title\u0000$text"
        synchronized(recorded) {
            if (key in recorded) return
            try {
                val row = JSONObject().put("title", title).put("text", text)
                    .put("ts", System.currentTimeMillis()).toString()
                File("/sdcard/esfera_optout.jsonl").appendText("$row\n", Charsets.UTF_8)
                recorded.add(key)
                if (recorded.size > 512) recorded.remove(recorded.first())
                Log.i(TAG, "Pedido de descadastro registrado")
            } catch (e: Exception) {
                Log.e(TAG, "Falha ao gravar pedido de descadastro: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun isOptOut(text: String): Boolean {
        val normalized = Normalizer.normalize(text, Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
            .lowercase(Locale.ROOT)
            .replace(Regex("[^\\p{L}\\p{N}]+"), " ")
            .trim().replace(Regex("\\s+"), " ")
        if (normalized.isEmpty() || normalized.split(' ').size > 8) return false
        return normalized in PHRASES
    }

    companion object {
        private const val TAG = "EsferaOptOut"
        private val PHRASES = setOf(
            "sair", "parar", "pare", "stop", "cancelar", "descadastrar",
            "nao quero mais receber", "remover meu numero",
            "quero sair", "quero parar", "pode parar", "pare de enviar",
            "pare de mandar", "parar de enviar", "parar de mandar",
            "nao envie mais", "nao mande mais", "nao me envie mais mensagens",
            "nao quero receber", "nao quero receber mensagens", "nao quero mais receber mensagens", "nao quero mais mensagens",
            "cancelar mensagens", "cancelar envio", "quero cancelar", "quero me descadastrar",
            "me descadastrar", "me descadastre", "descadastre meu numero",
            "remova meu numero", "excluir meu numero", "exclua meu numero",
            "retirar meu numero", "retire meu numero", "remover numero", "remova meu contato"
        )
    }
}
