package com.esfera.agent.shizuku

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import rikka.shizuku.Shizuku

/**
 * Gerenciador Oportunista de Acesso Privilegiado via Shizuku.
 *
 * Não é a solução de persistência pós-reboot (essa é o AccessibilitySelfEnabler),
 * mas expande as capacidades para execução de comandos shell privileged (ex: pm, dumpsys, input)
 * quando o serviço do Shizuku estiver disponível e autorizado no aparelho.
 *
 * Degrada silenciosamente para falha tratável caso o Shizuku não esteja presente ou autorizado.
 */
object ShizukuManager {
    private const val TAG = "EsferaShizuku"
    private const val REQUEST_CODE = 9421

    @Volatile
    private var permissionGranted = false

    private val binderReceivedListener = Shizuku.OnBinderReceivedListener {
        Log.i(TAG, "Binder do Shizuku recebido — serviço disponível")
        requestPermissionIfNeeded()
    }

    private val binderDeadListener = Shizuku.OnBinderDeadListener {
        Log.w(TAG, "Binder do Shizuku caiu — voltando ao modo degradado (sem Shizuku)")
        permissionGranted = false
    }

    private val permissionResultListener =
        Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
            if (requestCode == REQUEST_CODE) {
                permissionGranted = grantResult == android.content.pm.PackageManager.PERMISSION_GRANTED
                Log.i(TAG, "Resultado da permissão Shizuku: $permissionGranted")
            }
        }

    /**
     * Inicialização de listeners do Shizuku.
     * Deve ser chamada na inicialização da aplicação (EsferaApp.onCreate).
     */
    fun init() {
        try {
            Shizuku.addBinderReceivedListenerSticky(binderReceivedListener)
            Shizuku.addBinderDeadListener(binderDeadListener)
            Shizuku.addRequestPermissionResultListener(permissionResultListener)
            Log.i(TAG, "ShizukuManager inicializado")
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao registrar listeners do Shizuku: ${e.message}")
        }
    }

    /**
     * Verifica se o Shizuku está online e com permissão concedida.
     */
    fun isAvailable(): Boolean {
        return try {
            Shizuku.pingBinder() && permissionGranted
        } catch (e: Exception) {
            false
        }
    }

    private fun requestPermissionIfNeeded() {
        try {
            if (!Shizuku.pingBinder()) return
            if (Shizuku.isPreV11()) {
                Log.w(TAG, "Versão do Shizuku pré-v11 detectada, ignorando")
                return
            }
            if (Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                permissionGranted = true
                Log.i(TAG, "Permissão do Shizuku já concedida")
                return
            }
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                Log.w(TAG, "Usuário já negou a permissão do Shizuku anteriormente")
            }
            Shizuku.requestPermission(REQUEST_CODE)
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao solicitar permissão Shizuku: ${e.message}")
        }
    }

    /**
     * Executa um comando de shell via Shizuku, se disponível.
     * Retorna failure (sem lançar crash) se o Shizuku não estiver pronto.
     */
    suspend fun runPrivileged(cmd: String): Result<String> = withContext(Dispatchers.IO) {
        if (!isAvailable()) {
            return@withContext Result.failure(IllegalStateException("Shizuku indisponível"))
        }
        try {
            val newProcessMethod = Shizuku::class.java.getDeclaredMethod(
                "newProcess",
                Array<String>::class.java,
                Array<String>::class.java,
                String::class.java
            ).apply { isAccessible = true }

            val process = newProcessMethod.invoke(null, arrayOf("sh", "-c", cmd), null, null) as Process
            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()
            val exitCode = process.waitFor()
            if (exitCode == 0) {
                Result.success(stdout.ifEmpty { stderr })
            } else {
                Result.failure(RuntimeException("Comando falhou com código $exitCode: $stderr"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao executar comando via Shizuku: ${e.message}", e)
            Result.failure(e)
        }
    }
}
