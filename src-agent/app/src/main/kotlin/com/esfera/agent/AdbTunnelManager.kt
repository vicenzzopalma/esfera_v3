package com.esfera.agent

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.consumeEach
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer

/**
 * Gerenciador de Túnel ADB Reverso de Alta Performance.
 * Estabelece a ponte bidirecional entre o socket do adbd local (porta 5555) e o servidor de túnel.
 * 
 * Implementa as recomendações do Conselho de IAs:
 * 1. Processamento FIFO Downstream via `Channel<ByteArray>` (garante a ordem exata dos pacotes TCP do ADB).
 * 2. Manipulação de Buffer Upstream via `buffer.clear()` (evita resíduos e vazamentos de memória).
 */
class AdbTunnelManager(
    private val adbHost: String = "127.0.0.1",
    private val adbPort: Int = 5555,
    private val onSendToServer: suspend (ByteArray) -> Unit
) {

    companion object {
        private const val TAG = "AdbTunnelManager"
        private const val BUFFER_SIZE = 16384
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val downstreamChannel = Channel<ByteArray>(Channel.UNLIMITED)
    
    @Volatile
    private var isRunning = false
    private var adbSocket: Socket? = null

    /**
     * Inicia a ponte bidirecional com o socket local do adbd.
     */
    fun start(inputStream: InputStream, outputStream: OutputStream) {
        synchronized(this) {
            if (isRunning) return
            isRunning = true
        }

        scope.launch {
            try {
                adbSocket = Socket()
                adbSocket?.connect(InetSocketAddress(adbHost, adbPort), 5000)
                Log.d(TAG, "Conectado ao adbd local em $adbHost:$adbPort")

                val adbInput = adbSocket!!.getInputStream()
                val adbOutput = adbSocket!!.getOutputStream()

                // Job 1: Consumidor FIFO Downstream (Servidor -> ADB Local)
                val downstreamJob = launch {
                    downstreamChannel.consumeEach { data ->
                        try {
                            adbOutput.write(data)
                            adbOutput.flush()
                        } catch (e: Exception) {
                            Log.e(TAG, "Erro ao escrever no adbd: ${e.message}")
                            throw e
                        }
                    }
                }

                // Job 2: Leitor Upstream (ADB Local -> Servidor)
                val upstreamJob = launch {
                    val buffer = ByteBuffer.allocate(BUFFER_SIZE)
                    val rawArray = ByteArray(BUFFER_SIZE)

                    while (isActive && isRunning) {
                        buffer.clear() // Recomendação do Conselho: clear() em vez de compact()
                        val bytesRead = adbInput.read(rawArray, 0, BUFFER_SIZE)
                        if (bytesRead == -1) break

                        buffer.put(rawArray, 0, bytesRead)
                        buffer.flip()

                        val dataToSend = ByteArray(buffer.remaining())
                        buffer.get(dataToSend)
                        onSendToServer(dataToSend)
                    }
                }

                // Aguarda falha em qualquer uma das direções
                joinAll(downstreamJob, upstreamJob)
            } catch (e: Exception) {
                Log.w(TAG, "Ponte de túnel ADB encerrada: ${e.message}")
            } finally {
                stop()
            }
        }
    }

    /**
     * Enfileira pacotes recebidos do servidor para escrita no adbd local (FIFO).
     */
    fun enqueueDownstreamData(data: ByteArray) {
        if (isRunning) {
            downstreamChannel.trySend(data)
        }
    }

    /**
     * Encerra com segurança os sockets e coroutines do túnel.
     */
    fun stop() {
        synchronized(this) {
            if (!isRunning) return
            isRunning = false
        }
        try {
            adbSocket?.close()
        } catch (_: Exception) {}
        downstreamChannel.close()
        scope.cancel()
        Log.d(TAG, "Túnel ADB encerrado com sucesso.")
    }
}
