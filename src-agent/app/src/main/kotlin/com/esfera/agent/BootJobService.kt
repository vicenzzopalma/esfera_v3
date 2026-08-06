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
 *
 * CORREÇÃO DO LOOP (v3.4.1): onStartJob NÃO reagenda o próprio job e retorna
 * `true` + jobFinished. O setPersisted(true) já garante execução pós-boot;
 * reagendar no onStartJob criava disparos em cascata (10x/segundo) porque o
 * JobScheduler via o job "não completado" (foreground async) e re-disparava.
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
        // Trabalho curto e síncrono: avisa o JobScheduler que terminamos.
        // NÃO chamamos schedule() aqui — o job persiste por si só (setPersisted).
        jobFinished(params, false)
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean = false

    companion object {
        const val JOB_ID = 4242

        /** Agenda o job UMA vez. Idempotente: reagendar o mesmo JOB_ID só atualiza. */
        fun schedule(context: Context) {
            val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            // Se já está agendado, não faz nada (evita duplicar/cascade).
            if (js.getPendingJob(JOB_ID) != null) return
            val component = ComponentName(context, BootJobService::class.java)
            val builder = JobInfo.Builder(JOB_ID, component)
                .setPersisted(true)          // sobrevive a reboot (requer RECEIVE_BOOT_COMPLETED)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_LINEAR)
            try {
                js.schedule(builder.build())
            } catch (e: Exception) {
                Log.w("EsferaAgent", "Falha ao agendar BootJob: ${e.message}")
            }
        }
    }
}
