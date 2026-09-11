package com.esfera.agent.accessibility

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * Módulo de Auto-Habilitação e Auto-Cura do Serviço de Acessibilidade.
 *
 * Utiliza a permissão WRITE_SECURE_SETTINGS (concedida 1x via USB/ADB)
 * para ativar o EsferaAccessibilityService programaticamente sem
 * qualquer dependência de clique ou interação manual do usuário.
 */
object AccessibilitySelfEnabler {

    private const val TAG = "EsferaAccessibility"

    /**
     * Verifica se o aplicativo possui a permissão WRITE_SECURE_SETTINGS.
     */
    fun hasWriteSecureSettings(context: Context): Boolean {
        return context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) ==
                PackageManager.PERMISSION_GRANTED
    }

    /**
     * Verifica se o serviço de acessibilidade está ativo no sistema e em execução.
     */
    fun isAccessibilityEnabled(context: Context): Boolean {
        if (EsferaAccessibilityService.isRunning()) {
            return true
        }

        return try {
            val expectedComponent = ComponentName(context, EsferaAccessibilityService::class.java).flattenToString()
            val shortComponent = ComponentName(context, EsferaAccessibilityService::class.java).flattenToShortString()

            val accessibilityEnabled = Settings.Secure.getInt(
                context.contentResolver,
                Settings.Secure.ACCESSIBILITY_ENABLED,
                0
            ) == 1

            if (!accessibilityEnabled) return false

            val enabledServices = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""

            val list = enabledServices.split(":")
            list.contains(expectedComponent) || list.contains(shortComponent)
        } catch (e: Exception) {
            Log.w(TAG, "Erro ao checar status de acessibilidade: ${e.message}")
            false
        }
    }

    /**
     * Garante que o EsferaAccessibilityService esteja habilitado e ativo.
     * Idempotente: se já estiver ativo, retorna true imediatamente sem tocar nas configurações.
     */
    fun ensureEnabled(context: Context): Boolean {
        if (isAccessibilityEnabled(context)) {
            return true
        }

        if (!hasWriteSecureSettings(context)) {
            Log.w(TAG, "Falha na auto-habilitacao: permissao WRITE_SECURE_SETTINGS nao concedida")
            return false
        }

        return try {
            val component = ComponentName(context, EsferaAccessibilityService::class.java).flattenToString()
            val currentSetting = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""

            val services = currentSetting.split(":")
                .filter { it.isNotBlank() }
                .toMutableSet()

            if (!services.contains(component)) {
                services.add(component)
                val newSetting = services.joinToString(":")
                Settings.Secure.putString(
                    context.contentResolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                    newSetting
                )
                Log.i(TAG, "ENABLED_ACCESSIBILITY_SERVICES atualizado com sucesso: $newSetting")
            }

            Settings.Secure.putInt(
                context.contentResolver,
                Settings.Secure.ACCESSIBILITY_ENABLED,
                1
            )
            Log.i(TAG, "ACCESSIBILITY_ENABLED definido para 1 com sucesso")

            true
        } catch (e: Exception) {
            Log.e(TAG, "Excecao ao tentar auto-habilitar acessibilidade via Settings.Secure: ${e.message}", e)
            false
        }
    }
}
