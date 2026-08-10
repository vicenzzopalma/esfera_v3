package com.esfera.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.ComponentName
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.PrintWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.security.cert.X509Certificate
import okhttp3.OkHttpClient
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.util.concurrent.TimeUnit

@Serializable
data class EsferaConfig(
    val serverUrl: String = "",
    val deviceId: String = "",
    val tunnelEnabled: Boolean = true,
    val tunnelPort: Int = 8888,
    // COMPANY_ID: identidade de isolamento. Sem ela o VPS recusa check-in
    // (nunca derivamos empresa de IP/porta/ordem de conexão).
    val companyId: Int = 0
)

@Serializable
data class CheckInRequest(
    val esferaDeviceId: String,
    val currentAdbAddress: String,
    val companyId: Int = 0
)

@Serializable
data class TunnelHandshake(
    val type: String = "handshake",
    val hardwareUuid: String = "",
    val companyId: Int = 0,
    val macAddress: String = "",
    val serialNumber: String = "",
    val agentVersion: String = "1.0-tunnel",
    val currentLocalIp: String = ""
)

class EsferaAgentService : Service() {

    companion object {
        const val CHANNEL_ID = "esfera_agent_channel"
        const val NOTIF_ID = 1001
        const val CHECK_IN_INTERVAL_MS = 30_000L
        private const val RESPAWN_JOB_ID = 4243

        // RESPAWN DEFENSIVO: se o sistema (OEM/Moto) matar o service sem reboot,
        // reagenda um Job one-shot em 5s para religar o agente. Garante que o
        // celular continue reportando ao VPS MESMO SEM USB e SEM reboot (regra do
        // usuário: "aparece mesmo reiniciando o WiFi e desplugado"). O BootJobService
        // ja cuida do reboot; este cobre kill em runtime.
        fun scheduleRespawn(context: Context) {
            try {
                val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
                if (js.getPendingJob(RESPAWN_JOB_ID) != null) return
                val component = ComponentName(context, BootJobService::class.java)
                val builder = JobInfo.Builder(RESPAWN_JOB_ID, component)
                    .setMinimumLatency(5_000L)
                    .setOverrideDeadline(15_000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                js.schedule(builder.build())
            } catch (_: Exception) {}
        }
    }

    // ================================================================
    // LISTA BRANCA DE COMANDOS REMOTOS (allowlist autenticada)
    // Soma-se ao metodo atual (tunel reverso + WebSocket). NUNCA executa
    // shell arbitrario: o VPS so pode disparar os comandos abaixo. Isso
    // fecha a superficie de ataque (getprop/input remoto vira allowlist,
    // nao shell livre). Mantido em sincronia com o que o app desktop envia.
    // ================================================================
    private val ALLOWED_PREFIXES = listOf(
        "input ",                 // input tap/keyevent/swipe/text/etc.
        "cmd input ",            // via cmd (alguns fabricantes)
        "screencap ",            // captura de tela
        "getprop ",              // leitura de propriedade (inventario)
        "settings ",             // leitura de settings
        "am start ",             // abrir app/activity (sem shell)
        "am broadcast ",         // broadcast permitido
        "am force-stop ",        // parar app (gestao)
        "dumpsys ",              // inventario de estado (read-only)
    )

    // Sufixos/comandos PERIGOSOS que a allowlist DEVE bloquear mesmo se o
    // prefixo for permitido (ex: input nao deve permitir `sh`, etc.).
    private val FORBIDDEN_TOKENS = listOf(
        "rm ", "reboot", "su ", "sh ", "bash", "curl ", "wget ",
        "mount ", "umount ", "dd ", "mkfs", "chmod 777", "nc ",
        ";", "&&", "|", ">", ">>", "$(", "`", "eval ", "exec ",
    )

    /** Retorna true se o comando remoto e seguro para executar localmente. */
    private fun isCommandAllowed(command: String): Boolean {
        val c = command.trim()
        if (c.isEmpty()) return false
        // 1. Bloqueia tokens perigosos em qualquer posicao.
        for (bad in FORBIDDEN_TOKENS) {
            if (c.contains(bad)) return false
        }
        // 2. Exige que comece com um prefixo permitido (whitelist estrita).
        return ALLOWED_PREFIXES.any { c.startsWith(it) }
    }

    // ----------------------------------------------------------------\n
    private var checkInJob: Job? = null
    private var tunnelJob: Job? = null
    private var lastKnownIp: String? = null
    private var agentConfig: EsferaConfig? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val json = Json { ignoreUnknownKeys = true }

    // Trust-all OkHttpClient (apenas para TESTE com cert self-signed do VPS).
    // Em produção, substituir por certificado de CA real (load do KeyStore).
    private fun trustAllOkHttp(): OkHttpClient {
        return try {
            val trustAll = arrayOf<X509TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })
            val ssl = SSLContext.getInstance("TLS").apply {
                init(null, trustAll, java.security.SecureRandom())
            }
            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, trustAll[0])
                .hostnameVerifier { _, _ -> true }
                .build()
        } catch (e: Exception) {
            OkHttpClient.Builder().build()
        }
    }

    private val httpClient = HttpClient(OkHttp) {
        engine {
            preconfigured = trustAllOkHttp()
        }
        install(ContentNegotiation) {
            json(json)
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 10_000
        }
    }

    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var powerManager: PowerManager
    private var wakeLock: PowerManager.WakeLock? = null

    // ----------------------------------------------------------------\
    // Lifecycle
    // ----------------------------------------------------------------\

    private var presenceClient: PresenceClient? = null

    // Guarda de idempotência: loadConfigAndStart só roda UMA vez. O BootJobService
    // (disparado pelo próprio onCreate) e múltiplas chamadas de onStartCommand criam
    // coroutines duplicadas que se cancelam em cascata ("StandaloneCoroutine was
    // cancelled"), matando a presença/túnel. Com este flag, reinvocações apenas
    // retornam START_STICKY sem recriar jobs.
    private val started = java.util.concurrent.atomic.AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        // Agenda o job persistente de auto-start (sobrevive a reboot, sem root).
        BootJobService.schedule(this)
        // Keep-alive via AlarmManager: religa o agente se for morto por SIGKILL/OEM
        // (cobrir kill em runtime que NAO chama onDestroy). Garante que o celular
        // continue reportando ao VPS MESMO SEM USB, SEM reboot e SEM abrir o app.
        KeepAliveReceiver.schedule(this)
        createNotificationChannel()
        buildNotification() // aquece o canal de notificação
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        startForeground(NOTIF_ID, notification)
        acquireWakeLock()
        android.util.Log.d("EsferaAgent", "onStartCommand: iniciando loadConfigAndStart")
        if (started.compareAndSet(false, true)) {
            loadConfigAndStart()
        } else {
            android.util.Log.d("EsferaAgent", "onStartCommand: ja iniciado, ignorando duplicata")
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        unregisterNetworkCallback()
        releaseWakeLock()
        checkInJob?.cancel()
        tunnelJob?.cancel()
        presenceClient?.stop()
        scope.cancel()
        httpClient.close()
        // RESPAWN DEFENSIVO: se o sistema (OEM/Moto) matar o service sem reboot,
        // reagenda um Job one-shot em 5s para religar o agente. Garante que o
        // celular continue reportando ao VPS MESMO SEM USB e SEM reboot (regra do
        // usuário: "aparece mesmo reiniciando o WiFi e desplugado"). O BootJobService
        // ja cuida do reboot; este cobre kill em runtime.
        scheduleRespawn(this)
        super.onDestroy()
    }

    // ----------------------------------------------------------------\n    // Config
    // ----------------------------------------------------------------

    private fun getProp(name: String): String {
        return try {
            val p = Runtime.getRuntime().exec(arrayOf("getprop", name))
            val r = BufferedReader(InputStreamReader(p.inputStream))
            val v = r.readLine()?.trim() ?: ""
            p.waitFor()
            v
        } catch (e: Exception) { "" }
    }

    /**
     * Lista TODOS os caminhos candidatos de configuração, na ordem de precedência:
     * (1) external-files do app (sem permissão especial), (2) /sdcard/esfera_config.json
     * (legado, escrito pelo desktop via adb), (3) filesDir interno. O loadConfig()
     * varre TODOS e usa o primeiro com configuração VÁLIDA (não apenas o primeiro
     * que existe — um arquivo vazio não deve vencer um válido em outra ordem).
     */
    private fun resolveConfigCandidates(): List<File> {
        val list = mutableListOf<File>()
        val ext = getExternalFilesDir(null)
        if (ext != null) list.add(File(ext, "esfera_config.json"))
        list.add(File("/sdcard/esfera_config.json"))
        list.add(File(filesDir, "esfera_config.json"))
        return list
    }

    private fun isConfigValid(c: EsferaConfig): Boolean {
        return c.serverUrl.isNotBlank() && c.deviceId.isNotBlank()
    }

    private fun loadConfig(): EsferaConfig {
        val defaultAndroidId = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "UNKNOWN_DEVICE"
        } catch (e: Exception) {
            "UNKNOWN_DEVICE"
        }

        // FONTE DE VERDADE: varre TODOS os caminhos candidatos e usa o primeiro
        // com configuração VÁLIDA (serverUrl + deviceId). Um arquivo existente mas
        // vazio NÃO deve vencer um válido em outra posição da lista.
        var fileConfig = EsferaConfig()
        for (candidate in resolveConfigCandidates()) {
            if (candidate.exists()) {
                try {
                    val c = json.decodeFromString<EsferaConfig>(candidate.readText())
                    if (isConfigValid(c)) { fileConfig = c; break }
                } catch (_: Exception) {}
            }
        }
        // Se nenhum arquivo válido, tenta SharedPreferences (fallback).
        if (!isConfigValid(fileConfig)) {
            val prefs = getSharedPreferences("esfera_agent", MODE_PRIVATE)
            val pc = EsferaConfig(
                serverUrl = prefs.getString("serverUrl", "") ?: "",
                deviceId = prefs.getString("deviceId", "") ?: "",
                companyId = prefs.getInt("companyId", 0)
            )
            if (isConfigValid(pc)) fileConfig = pc
        }

        // Fallback de prop (só funciona com root) — tem precedência MENOR que o arquivo.
        val propDeviceId = getProp("persist.esfera.device_id")
        val propCompany = getProp("persist.esfera.company").toIntOrNull() ?: 0
        val propServer = getProp("persist.esfera.server_address").ifEmpty { getProp("persist.esfera.hub") }

        // Mescla: arquivo tem precedência; prop preenche o que faltar (caso root).
        val resolvedDeviceId = fileConfig.deviceId.ifBlank { propDeviceId }
        val resolvedCompany = if (fileConfig.companyId > 0) fileConfig.companyId else propCompany
        val resolvedServer = fileConfig.serverUrl.ifBlank { propServer }

        val finalDeviceId = if (resolvedDeviceId.isBlank() || resolvedDeviceId == "UNIQUE_DEVICE_ID") {
            defaultAndroidId
        } else {
            resolvedDeviceId
        }

        // Espelha a identidade resolvida de volta no arquivo para resiliência cruzada.
        try {
            val out = EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
            val writeTarget = resolveConfigCandidates().firstOrNull { it.exists() } ?: resolveConfigCandidates().first()
            writeTarget.writeText(json.encodeToString(EsferaConfig.serializer(), out))
        } catch (_: Exception) {}

        return EsferaConfig(serverUrl = resolvedServer, deviceId = finalDeviceId, companyId = resolvedCompany)
    }

    private fun startPresenceLoop(config: EsferaConfig) {
        presenceClient?.stop()
        val cleaned = config.serverUrl
            .replace("http://", "")
            .replace("https://", "")
        val host = cleaned.substringBefore(':').substringBefore('/').ifEmpty { "127.0.0.1" }
        val useTls = config.serverUrl.startsWith("https://")
        // Se TLS, a porta vem do serverUrl (ex: https://host:8443); senão fixo 7779.
        val wsPort = if (useTls) {
            cleaned.substringAfter(':').substringBefore('/').toIntOrNull() ?: 8443
        } else {
            7779
        }
        presenceClient = PresenceClient(
            context = this,
            deviceId = config.deviceId,
            serverHost = host,
            wsPort = wsPort,
            companyId = config.companyId,
            useTls = useTls
        ).apply { start() }
    }

    private fun loadConfigAndStart() {
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: lendo config")
        val config = loadConfig()
        android.util.Log.d("EsferaAgent", "loadConfigAndStart: serverUrl='${config.serverUrl}' deviceId='${config.deviceId}' companyId=${config.companyId}")
        if (config.serverUrl.isBlank() || config.deviceId.isBlank()) {
            android.util.Log.w("EsferaAgent", "loadConfigAndStart: config vazia, stopSelf")
            stopSelf()
            return
        }
        agentConfig = config
        startCheckInLoop(config)
        if (config.tunnelEnabled) {
            startTunnelLoop(config)
        }
        startPresenceLoop(config)
    }

    private fun startCheckInLoop(config: EsferaConfig) {
        android.util.Log.d("EsferaAgent", "startCheckInLoop: iniciado")
        checkInJob?.cancel()
        val host = config.serverUrl
            .replace("https://", "").replace("http://", "")
            .substringBefore(':').substringBefore('/').ifEmpty { "34.29.70.113" }
        val httpFallback = "http://$host:8080"
        checkInJob = scope.launch {
            var useHttps = config.serverUrl.startsWith("https://")
            while (isActive) {
                val ip = resolveCurrentIp()
                android.util.Log.d("EsferaAgent", "startCheckInLoop: ip=$ip")
                if (ip != null) {
                    lastKnownIp = ip
                    try {
                        val base = if (useHttps) config.serverUrl else httpFallback
                        val response: HttpResponse = httpClient.post("$base/api/devices/check-in") {
                            contentType(ContentType.Application.Json)
                            setBody(CheckInRequest(
                                esferaDeviceId = config.deviceId,
                                currentAdbAddress = ip,
                                companyId = config.companyId
                            ))
                        }
                        if (response.status.value == 200) {
                            android.util.Log.d("EsferaAgent", "Check-in OK: $ip")
                        } else {
                            android.util.Log.w("EsferaAgent", "Check-in status ${response.status.value}: $ip")
                        }
                    } catch (e: Exception) {
                        // Fallback autônomo: se HTTPS falhar (ex: handshake TLS em Android antigo),
                        // tenta HTTP (porta 8080). Garante que o celular reporta ao VPS mesmo
                        // em devices mais velhos ou com incompatibilidade de cipher.
                        if (useHttps && (e.message?.contains("Handshake", true) == true
                                    || e.message?.contains("SSL", true) == true
                                    || e.message?.contains("trust", true) == true)) {
                            android.util.Log.w("EsferaAgent", "HTTPS falhou ($e), usando fallback HTTP 8080")
                            useHttps = false
                        } else {
                            android.util.Log.w("EsferaAgent", "Check-in falhou: ${e.message}")
                        }
                    }
                }
                delay(CHECK_IN_INTERVAL_MS)
            }
        }
    }

    // ----------------------------------------------------------------
    // Tunnel reverso (celular -> servidor, handshake por Hardware UUID)
    // Mantém socket TCP persistente; reconecta em ms quando a rede muda.
    // O backend correspondente é tunnel_server.rs (porta tunnelPort, default 8888).
    // ----------------------------------------------------------------

    private fun startTunnelLoop(config: EsferaConfig) {
        tunnelJob?.cancel() // evita duplo túnel se rechamado
        var first = true
        tunnelJob = scope.launch {
            var backoffMs = 5_000L
            while (isActive) {
                val host = config.serverUrl
                    .replace("http://", "")
                    .replace("https://", "")
                    .substringBefore(':')
                    .substringBefore('/')
                    .ifEmpty { "127.0.0.1" }
                try {
                    openTunnel(host, config.tunnelPort, config.deviceId, config.companyId)
                    backoffMs = 5_000L // reset em caso de fechamento limpo
                } catch (e: Exception) {
                    android.util.Log.w("EsferaAgent", "Túnel caiu: ${e.message}")
                }
                if (first) { first = false; backoffMs = 1_000L } // A primeira tentativa após ligar o app é rápida
                
                // Adiciona um Jitter de 0 a 2 segundos para evitar "thundering herd" (todos conectando no mesmo ms)
                delay(backoffMs + (0..2000).random().toLong())
                
                // Backoff respeitando o limite pedido: entre 5 e 10 segundos de máximo.
                backoffMs = (backoffMs * 2).coerceIn(5_000L, 10_000L)
            }
        }
    }

    private suspend fun openTunnel(host: String, port: Int, deviceId: String, companyId: Int) {
        val ip = resolveCurrentIp() ?: "0.0.0.0"
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), 10_000)
        socket.soTimeout = 0
        val writer = PrintWriter(socket.getOutputStream(), true)
        val reader = BufferedReader(InputStreamReader(socket.getInputStream()))

        // 1. Handshake na primeira linha (hardware_uuid = deviceId do agente)
        val hs = TunnelHandshake(
            hardwareUuid = deviceId,
            companyId = companyId,
            currentLocalIp = ip
        )
        writer.println(json.encodeToString(TunnelHandshake.serializer(), hs))
        writer.flush()

        // 2. Loop de heartbeat L7 + leitura da resposta do servidor.
        //    Se o servidor fechar o socket (readLine() == null), encerramos o
        //    coroutineScope filho -> openTunnel retorna -> startTunnelLoop reconecta.
        coroutineScope {
            val readerJob = launch {
                while (isActive) {
                    val line = try { reader.readLine() } catch (_: Exception) { null }
                    if (line == null) {
                        // EOF ou erro de leitura: o servidor caiu. Sai do escopo.
                        return@launch
                    }
                    // Trata mensagens de controle enviadas pelo servidor (túnel reverso).
                    when {
                        line.contains("\"type\":\"ping\"") -> {
                            writer.println("""{"type":"pong"}""")
                            writer.flush()
                        }
                        line.contains("\"type\":\"proxy\"") -> {
                            val port = Regex("\"port\"\\s*:\\s*(\\d+)").find(line)
                                ?.groupValues?.get(1)?.toInt() ?: 5555
                            // Garante que o adbd local escute em TCP antes de abrir o relay.
                            // Sem isso o app trava em "processando ADB" (relay falha silenciosamente).
                            ensureAdbdTcp(port)
                            try {
                                val local = Socket("127.0.0.1", port)
                                // Só confirma o proxy APÓS a conexão local existir de verdade.
                                writer.println("""{"type":"proxy-ack"}""")
                                writer.flush()
                                launch(Dispatchers.IO) { relayToLocal(local, socket) }
                            } catch (e: Exception) {
                                android.util.Log.e("EsferaAgent", "proxy falhou: adbd nao escuta em 127.0.0.1:$port (${e.message})")
                                writer.println("""{"type":"proxy-error","message":"adbd nao escuta em 127.0.0.1:$port"}""")
                                writer.flush()
                            }
                        }
                        line.contains("\"type\":\"adb_cmd\"") -> {
                            // Comando remoto solicitado pelo app desktop via VPS.
                            // Executa LOCALMENTE no aparelho (input/screencap/etc.) e
                            // devolve a saída. Fecha a bifurcação A: celular remoto
                            // (via_tunnel) passa a ser controlável sem root.
                            // SEGURANÇA: só executa se na LISTA BRANCA (allowlist
                            // autenticada) — nunca shell arbitrário.
                            val id = Regex("\"id\"\\s*:\\s*\"?([^\",}]+)\"?").find(line)
                                ?.groupValues?.get(1)?.trim()
                            val cmd = Regex("\"command\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(line)
                                ?.groupValues?.get(1)
                                ?.replace("\\\"", "\"")?.replace("\\\\", "\\")
                            if (id != null && cmd != null) {
                                if (!isCommandAllowed(cmd)) {
                                    android.util.Log.w("EsferaAgent", "adb_cmd BLOQUEADO (fora da allowlist): $cmd")
                                    launch(Dispatchers.IO) {
                                        writer.println("""{"type":"adb_result","id":"$id","output":"ERR: comando nao permitido (allowlist): $cmd"}""")
                                        writer.flush()
                                    }
                                } else {
                                    launch(Dispatchers.IO) {
                                        val out = runLocalCommand(cmd)
                                        writer.println("""{"type":"adb_result","id":"$id","output":${JsonPrimitive(out)}}""")
                                        writer.flush()
                                    }
                                }
                            }
                        }
                    }
                }
            }

            try {
                while (isActive && !socket.isClosed) {
                    delay(10_000L) // envia ping a cada 10s (backend tolera 45s de silêncio)
                    if (socket.isClosed) break
                    writer.println("""{"type":"ping"}""")
                    writer.flush()
                }
            } finally {
                readerJob.cancel()
            }
        }
    }

    /// Relay bidirecional bruto entre o soquete do túnel e o ADB local do aparelho.
    /// O `local` (127.0.0.1:port) já vem conectado de quem chamou (proxy handler),
    /// que garantiu que o adbd escuta antes de confirmar o proxy-ack.
    private suspend fun relayToLocal(local: Socket, tunnel: Socket) {
        try {
            coroutineScope {
                launch { pump(tunnel.getInputStream(), local.getOutputStream()) }
                launch { pump(local.getInputStream(), tunnel.getOutputStream()) }
            }
        } catch (_: Exception) {
            // Relay encerrado (qualquer ponta fechou).
        } finally {
            try { local.close() } catch (_: Exception) {}
        }
    }

    /// Tenta deixar o adbd local escutando em TCP (porta `port`) antes de abrir o
    /// relay. AUTÔNOMO: não depende de passo manual (adb tcpip via USB). Tenta,
    /// em ordem, os métodos disponíveis no aparelho (root/su, adb nativo, setprop).
    /// Se nenhum funcionar, o relay vai falhar e o app recebe proxy-error (não trava).
    private fun ensureAdbdTcp(port: Int) {
        val cmds = listOf(
            "su -c 'setprop service.adb.tcp.port $port; stop adbd; start adbd'",
            "su 0 setprop service.adb.tcp.port $port; su 0 stop adbd; su 0 start adbd",
            "adb tcpip $port",
            "setprop service.adb.tcp.port $port; stop adbd; start adbd"
        )
        for (c in cmds) {
            try { runLocalCommand(c) } catch (_: Exception) {}
            // Se a porta já abriu, para (não precisa tentar o resto).
            if (isAdbdListening(port)) break
            try { Thread.sleep(800) } catch (_: Exception) {}
        }
        // Pequena pausa extra para o adbd reiniciar em TCP.
        try { Thread.sleep(1500) } catch (_: Exception) {}
    }

    /// Verifica se o adbd local já aceita conexões TCP na porta indicada.
    private fun isAdbdListening(port: Int): Boolean {
        return try {
            val s = Socket()
            s.connect(InetSocketAddress("127.0.0.1", port), 800)
            s.close()
            true
        } catch (_: Exception) { false }
    }

    /// Copia bytes de `src` para `dst` até EOF ou erro.
    private suspend fun pump(src: InputStream, dst: OutputStream) {
        val buf = ByteArray(8192)
        try {
            var n = src.read(buf)
            while (n > 0) {
                dst.write(buf, 0, n)
                dst.flush()
                n = src.read(buf)
            }
        } catch (_: Exception) {
            // EOF ou erro de leitura/escrita: encerra este sentido do relay.
        }
    }

    /// Executa um comando localmente no aparelho (input tap/keyevent, screencap,
    /// settings, etc.) e devolve a saída concatenada (stdout+stderr). Usado pelo
    /// canal de controle remoto (adb_cmd) para fechar a bifurcação A sem root.
    private fun runLocalCommand(command: String): String {
        return try {
            val p = Runtime.getRuntime().exec(command)
            val out = p.inputStream.bufferedReader().readText()
            val err = p.errorStream.bufferedReader().readText()
            val code = try { p.waitFor() } catch (_: Exception) { -1 }
            val sb = StringBuilder()
            if (out.isNotBlank()) sb.append(out)
            if (err.isNotBlank()) sb.append(err)
            if (sb.isEmpty()) sb.append("exit=$code")
            sb.toString().trim()
        } catch (e: Exception) {
            "ERR: ${e.message}"
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val ip = linkProperties.linkAddresses
                .firstOrNull { it.address is java.net.Inet4Address }
                ?.address?.hostAddress
            if (ip != null && ip != lastKnownIp) {
                lastKnownIp = ip
                android.util.Log.d("EsferaAgent", "IP mudou: $ip — reconectando túnel reverso")
                // Reconexão imediata do túnel (entrega "reconexão em ms" do design).
                // Cancela o túnel anterior para não vazar/duplicar sockets.
                tunnelJob?.cancel()
                agentConfig?.let { startTunnelLoop(it) }
            }
        }
    }

    private fun registerNetworkCallback() {
        // Sem addTransportType: captura QUALQUER mudança de rede (Wi-Fi, dados móveis,
        // VPN). Antes restringia a TRANSPORT_WIFI, o que fazia o túnel NÃO reconectar
        // quando o celular usava 4G/5G (casa sem Wi-Fi, por ex.), deixando o celular
        // invisível no app desktop.
        val request = android.net.NetworkRequest.Builder().build()
        connectivityManager.registerNetworkCallback(request, networkCallback)
    }

    private fun unregisterNetworkCallback() {
        try { connectivityManager.unregisterNetworkCallback(networkCallback) } catch (_: Exception) {}
    }

    private fun resolveCurrentIp(): String? {
        val activeNetwork = connectivityManager.activeNetwork ?: return null
        val links = connectivityManager.getLinkProperties(activeNetwork) ?: return null
        return links.linkAddresses
            .firstOrNull { it.address is java.net.Inet4Address }
            ?.address?.hostAddress
    }

    // ----------------------------------------------------------------
    // WakeLock
    // ----------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "EsferaAgent:CheckInLock"
            ).apply { acquire(TimeUnit.MINUTES.toMillis(10)) }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
            wakeLock = null
        }
    }

    // ----------------------------------------------------------------
    // Notification
    // ----------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Esfera Agent",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Servico do Agente Esfera"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val channelId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) CHANNEL_ID else ""
        return Notification.Builder(this, channelId)
            .setContentTitle("Esfera Agent")
            .setContentText("Serviço de check-in ativo")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
    }
}
