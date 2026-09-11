package com.esfera.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Serviço de Acessibilidade Resiliente do Esfera v3.
 *
 * Fornece primitivas genéricas de controle remoto sobre o Android:
 * - Toques (click)
 * - Gestos e swipes (incluindo curvas multi-ponto Bézier)
 * - Digitação de texto direta em inputs focados
 * - Inspeção e clique em nós por ID ou Texto
 * - Leitura e dump serializado da árvore de Views
 * - Captura de tela (API 30+)
 * - Navegação do sistema (Back, Home, Recents)
 * - Abertura de aplicativos por packageName
 */
class EsferaAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "EsferaAccessibility"

        @Volatile
        var instance: EsferaAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "EsferaAccessibilityService CONECTADO e operacional")
    }

    override fun onDestroy() {
        Log.w(TAG, "EsferaAccessibilityService DESTRUÍDO")
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    override fun onInterrupt() {
        Log.w(TAG, "EsferaAccessibilityService INTERROMPIDO")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Eventos são monitorados passivamente. Não bloqueia a pipeline.
    }

    // ================================================================
    // PRIMITIVAS DE TOQUE E GESTO (dispatchGesture)
    // ================================================================

    /**
     * Executa toque físico (tap) em coordenadas absolutas de tela (X, Y).
     */
    fun click(x: Float, y: Float, durationMs: Long = 80L, callback: ((Boolean) -> Unit)? = null): Boolean {
        val path = Path().apply {
            moveTo(x, y)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(10L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                callback?.invoke(true)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                callback?.invoke(false)
            }
        }, null)
    }

    /**
     * Executa gesto linear (swipe) de (startX, startY) até (endX, endY).
     */
    fun swipe(
        startX: Float,
        startY: Float,
        endX: Float,
        endY: Float,
        durationMs: Long = 300L,
        callback: ((Boolean) -> Unit)? = null
    ): Boolean {
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(50L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                callback?.invoke(true)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                callback?.invoke(false)
            }
        }, null)
    }

    /**
     * Executa trajetória curva através de lista de pontos (ex: Curvas de Bézier cúbicas geradas em C++).
     */
    fun gestureCurve(
        points: List<Pair<Float, Float>>,
        durationMs: Long = 350L,
        callback: ((Boolean) -> Unit)? = null
    ): Boolean {
        if (points.isEmpty()) return false
        val path = Path().apply {
            moveTo(points[0].first, points[0].second)
            for (i in 1 until points.size) {
                lineTo(points[i].first, points[i].second)
            }
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(50L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                callback?.invoke(true)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                callback?.invoke(false)
            }
        }, null)
    }

    // ================================================================
    // DIGITAÇÃO E MANIPULAÇÃO DE NÓS (AccessibilityNodeInfo)
    // ================================================================

    /**
     * Digita texto no campo atualmente focado (ou primeiro campo editável da tela).
     */
    fun inputText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) {
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }

        // Se não houver campo com foco explícito, procura o primeiro nó editável
        val editableNode = findFirstEditable(root)
        if (editableNode != null) {
            editableNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            return editableNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }
        return false
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i)
            val found = findFirstEditable(child)
            if (found != null) return found
        }
        return null
    }

    /**
     * Localiza nó pelo viewId (ex: "com.whatsapp:id/send") e aciona ACTION_CLICK.
     */
    fun clickNodeById(viewId: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
        for (node in nodes) {
            if (performClickOnNodeOrParent(node)) {
                return true
            }
        }
        return false
    }

    /**
     * Localiza nó por correspondência de texto e aciona ACTION_CLICK.
     */
    fun clickNodeByText(text: String, exact: Boolean = false): Boolean {
        val root = rootInActiveWindow ?: return false
        val nodes = root.findAccessibilityNodeInfosByText(text)
        for (node in nodes) {
            val nodeText = node.text?.toString() ?: ""
            if (exact && !nodeText.equals(text, ignoreCase = true)) {
                continue
            }
            if (performClickOnNodeOrParent(node)) {
                return true
            }
        }
        return false
    }

    private fun performClickOnNodeOrParent(node: AccessibilityNodeInfo?): Boolean {
        var current = node
        while (current != null) {
            if (current.isClickable) {
                return current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            current = current.parent
        }
        return false
    }

    // ================================================================
    // DUMP DA ÁRVORE DE VIEWS (INSPEÇÃO E VISÃO REMOTA)
    // ================================================================

    @Serializable
    data class NodeDump(
        val className: String = "",
        val viewId: String = "",
        val text: String = "",
        val contentDesc: String = "",
        val packageName: String = "",
        val isClickable: Boolean = false,
        val isEditable: Boolean = false,
        val isEnabled: Boolean = false,
        val bounds: List<Int> = emptyList(),
        val children: List<NodeDump> = emptyList()
    )

    /**
     * Exporta a hierarquia completa de nós visíveis da tela em JSON.
     */
    fun dumpNodeTree(): String {
        val root = rootInActiveWindow ?: return "{}"
        val tree = serializeNode(root)
        return try {
            json.encodeToString(tree)
        } catch (e: Exception) {
            "{}"
        }
    }

    private fun serializeNode(node: AccessibilityNodeInfo?): NodeDump {
        if (node == null) return NodeDump()
        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val children = mutableListOf<NodeDump>()
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                children.add(serializeNode(child))
            }
        }

        return NodeDump(
            className = node.className?.toString() ?: "",
            viewId = node.viewIdResourceName ?: "",
            text = node.text?.toString() ?: "",
            contentDesc = node.contentDescription?.toString() ?: "",
            packageName = node.packageName?.toString() ?: "",
            isClickable = node.isClickable,
            isEditable = node.isEditable,
            isEnabled = node.isEnabled,
            bounds = listOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
            children = children
        )
    }

    // ================================================================
    // CAPTURA DE TELA E NAVEGAÇÃO DO SISTEMA
    // ================================================================

    /**
     * Captura screenshot na API 30+ (Android 11+). Em versões inferiores devolve null.
     */
    fun takeScreenShotCompat(callback: (Bitmap?) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshotResult: ScreenshotResult) {
                        val hardwareBuffer = screenshotResult.hardwareBuffer
                        val colorSpace = screenshotResult.colorSpace
                        val bitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, colorSpace)
                        hardwareBuffer.close()
                        callback(bitmap)
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "takeScreenshot falhou com código: $errorCode")
                        callback(null)
                    }
                }
            )
        } else {
            callback(null)
        }
    }

    fun openApp(packageName: String): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                true
            } else {
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao abrir app $packageName: ${e.message}")
            false
        }
    }

    fun pressBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
    fun pressHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
    fun pressRecents(): Boolean = performGlobalAction(GLOBAL_ACTION_RECENTS)
    fun pressNotifications(): Boolean = performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
}
