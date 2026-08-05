package com.esfera.agent

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log

/**
 * Job persistente agendado pelo app. Diferente do BOOT_COMPLETED receiver (que o
 * Android 12+ de fabricantes como Moto bloqueia quando disparado de um
 * BroadcastReceiver em background), o JobScheduler com setPersisted(true) é
 * executado pelo sistema APÓS o reboot, sem depender do app estar rodando.
 * É a forma oficial e sem-root de garantir auto-start do agente.
 */
class BootJobService : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        Log.i("EsferaAgent", "BootJobService: iniciando agente apos boot")
        val intent = android.content.Intent(this, EsferaAgentService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (e: Exception) {
            Log.w("EsferaAgent", "BootJobService falhou ao iniciar: ${e.message}")
        }
        // Reagenda para o próximo boot (persistência contínua)
        schedule(this)
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean = false

    companion object {
        const val JOB_ID = 4242

        fun schedule(context: Context) {
            val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val component = ComponentName(context, BootJobService::class.java)
            val builder = JobInfo.Builder(JOB_ID, component)
                .setPersisted(true)          // sobrevive a reboot (requer RECEIVE_BOOT_COMPLETED)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(5000, JobInfo.BACKOFF_POLICY_LINEAR)
            // Executa também em idle para garantir que rode logo após boot
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder.setRequiresCharging(false)
            }
            try {
                js.schedule(builder.build())
            } catch (e: Exception) {
                Log.w("EsferaAgent", "Falha ao agendar BootJob: ${e.message}")
            }
        }
    }
}
