package com.esfera.agent

import android.icu.text.BreakIterator
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class EsferaKeyboardService : InputMethodService() {
    companion object {
        private const val TYPING_TAG = "EsferaTyping"
        var instance: EsferaKeyboardService? = null
            private set
    }

    private val handler = Handler(Looper.getMainLooper())
    private var inputStarted = false
    private var requestId: String? = null
    private var nextKey: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onEvaluateFullscreenMode(): Boolean = false

    override fun onCreateInputView(): View {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(16, 0, 16, 0)
            setBackgroundColor(0xffeeeeee.toInt())
        }
        bar.addView(TextView(this).apply {
            text = "Esfera"
            textSize = 18f
            setTextColor(0xff222222.toInt())
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(this).apply {
            text = "Voltar ao teclado"
            setOnClickListener {
                finishTyping(false, "troca de teclado pelo operador")
                val switched = if (Build.VERSION.SDK_INT >= 28) switchToPreviousInputMethod() else false
                if (!switched) {
                    (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
                }
            }
        })
        return bar
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        finishTyping(false, "campo de texto reiniciado")
        super.onStartInput(attribute, restarting)
        inputStarted = true
    }

    override fun onFinishInput() {
        inputStarted = false
        finishTyping(false, "campo de texto perdeu a conexao")
        super.onFinishInput()
    }

    override fun onUnbindInput() {
        inputStarted = false
        finishTyping(false, "teclado desconectado")
        super.onUnbindInput()
    }

    override fun onDestroy() {
        inputStarted = false
        finishTyping(false, "teclado encerrado")
        if (instance === this) instance = null
        super.onDestroy()
    }

    // null permite ao receiver usar a acessibilidade antes de qualquer escrita.
    fun typeHumanAsync(id: String, text: String, delays: List<Long>, clear: Boolean): Int? {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (requestId != null) return 5
        val connection = currentInputConnection ?: return null
        val active = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
        } catch (_: Exception) {
            return null
        }
        if (!inputStarted || active !in listOf(
                "com.esfera.agent/.EsferaKeyboardService",
                "com.esfera.agent/com.esfera.agent.EsferaKeyboardService"
            )) return null

        requestId = id
        // ICU mantém acentos combinados, pares substitutos e sequências de emoji juntos.
        val iterator = BreakIterator.getCharacterInstance().apply { setText(text) }
        var start = iterator.first()
        var end = iterator.next()
        var codePointIndex = 0
        var keys = 0

        fun connected(): Boolean = inputStarted && currentInputConnection === connection

        fun scheduleNext() {
            if (end == BreakIterator.DONE) {
                finishTyping(true, "teclas=$keys")
                return
            }
            val grapheme = text.substring(start, end)
            val count = grapheme.codePointCount(0, grapheme.length)
            // O desktop manda um atraso por code point; preserva a soma por grafema.
            var wait = 0L
            repeat(count) {
                wait += (delays.getOrNull(codePointIndex++) ?: 110L).coerceAtLeast(0L)
            }
            val task = Runnable {
                try {
                    if (!connected()) {
                        finishTyping(false, "campo de texto mudou")
                    } else if (!connection.commitText(grapheme, 1)) {
                        finishTyping(false, "commitText recusado na tecla ${keys + 1}")
                    } else {
                        keys++
                        start = end
                        end = iterator.next()
                        scheduleNext()
                    }
                } catch (e: Exception) {
                    finishTyping(false, "${e.javaClass.simpleName}: ${e.message}")
                }
            }
            nextKey = task
            handler.postDelayed(task, wait)
        }

        // Até a limpeza passa pelo Handler principal, após o broadcast ser aceito.
        val begin = Runnable {
            try {
                if (!connected()) {
                    finishTyping(false, "campo de texto mudou")
                } else if (clear && !clearField(connection)) {
                    finishTyping(false, "nao foi possivel limpar o campo")
                } else {
                    scheduleNext()
                }
            } catch (e: Exception) {
                finishTyping(false, "${e.javaClass.simpleName}: ${e.message}")
            }
        }
        nextKey = begin
        handler.post(begin)
        return 1
    }

    private fun clearField(connection: InputConnection): Boolean {
        connection.finishComposingText()
        return connection.performContextMenuAction(android.R.id.selectAll) && connection.commitText("", 1)
    }

    private fun finishTyping(ok: Boolean, detail: String) {
        nextKey?.let { handler.removeCallbacks(it) }
        nextKey = null
        val id = requestId ?: return
        requestId = null
        val message = "TYPED $id ${if (ok) "OK" else "FAIL"} via=ime $detail"
        if (ok) Log.i(TYPING_TAG, message) else Log.w(TYPING_TAG, message)
    }
}
