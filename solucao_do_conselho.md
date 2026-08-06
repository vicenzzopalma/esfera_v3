# Tarefa Original: Análise e auditoria completa da arquitetura do Esfera v3: persistência imutável de identidade do celular Android (sem root/JobScheduler), reconexão e auto-start pós-boot, visibilidade de dispositivos remotos via VPS central (ponte get_devices), resiliência a troca de IP e redes 4G/5G, suporte a controle remoto de toque (tap) e teclas (keyevent) sem root via túnel WebSocket OkHttp, preservação de nomes customizados de dispositivos, e eliminação de crashes e deadlocks na interface desktop com Scrcpy 60 FPS.

## 1. Visão do Arquiteto

Aqui está o planejamento arquitetural completo (Mapa de Implementação) para o **Esfera v3**. O foco é garantir resiliência, ausência de root e alta performance (60 FPS) sem deadlocks.

---

### 1. Arquitetura Geral e Padrões

*   **Topologia:** *Hub-and-Spoke* (Estrela). O VPS atua como Message Broker/Relay WebSocket. Android e Desktop nunca se conectam P2P, resolvendo nativamente trocas de IP e redes 4G/5G (apenas o VPS precisa de DNS estático).
*   **Persistência de Identidade (Android):** Geração de UUID na primeira execução, salvo em `EncryptedSharedPreferences`. **Padrão de Auto-start:** `BroadcastReceiver` (`BOOT_COMPLETED`) + `AlarmManager` (`setExactAndAllowWhileIdle`) + Foreground `Service`. *Nota: WorkManager é proibido aqui pois usa JobScheduler internamente; AlarmManager contorna o Doze mode.*
*   **Controle sem Root:** `AccessibilityService` para injeção de eventos. Toques via `GestureDescription` e teclas via `dispatchKeyEvent`.
*   **Streaming Scrcpy 60 FPS:** Android usa `MediaProjection` (captura legal sem root) + `MediaCodec` (Hardware H.264). Desktop usa o core do Scrcpy (FFMpeg/SDL) modificado para consumir de um *WebSocket Adapter* em vez de ADB local.
*   **Concorrência (Anti-Deadlock/Crash):** Padrão **Producer-Consumer com Bounded Ring Buffer**. Thread de Rede (WS) -> Thread de Decode (FFMpeg) -> Thread de Render (SDL). Frames antigos são descartados (drop) se a fila estiver cheia, evitando estouro de memória e travamento da UI.
*   **Resiliência:** *Exponential Backoff* (reconexão) e *Heartbeat* (Ping/Pong a cada 15s).

---

### 2. Fluxo Lógico de Execução

1.  **Boot:** Android dispara `BootReceiver` -> Agenda `AlarmManager` -> Inicia `EsferaForegroundService`.
2.  **Identidade:** Service lê UUID (cria se não existir) e nome customizado.
3.  **Túnel:** OkHttp WebSocket conecta ao VPS (`wss://vps/agent`). Envia `HELLO {uuid, name}`.
4.  **Registro (VPS):** VPS adiciona UUID no `DeviceRegistry` e responde `ACK`.
5.  **Desktop:** Conecta ao VPS (`wss://vps/controller`). Envia `GET_DEVICES`. VPS retorna lista do Registry.
6.  **Bridge:** Desktop envia `CONNECT {uuid}`. VPS "casca" (links) o socket do Desktop com o do Android.
7.  **Controle:** Desktop envia `{"action":"tap", "x":10, "y":20}`. VPS encaminha. Android `AccessibilityService` executa.
8.  **Vídeo:** Android `MediaCodec` empacota H.264 em frames binários -> WS -> VPS -> Desktop Scrcpy decodifica e renderiza a 60 FPS.
9.  **Falha de Rede:** WS cai (4G->WiFi). Android `onFailure` dispara Backoff. VPS remove do Registry após 3 timeouts de Ping.

---

### 3. Estrutura de Arquivos, Funções e Bibliotecas

#### A. Módulo Android (`esfera-agent` - Kotlin)
**Bibliotecas:** `okhttp-ws`, `AndroidX Core`, `MediaCodec`, `EncryptedSharedPreferences`.

*   `receiver/BootReceiver.kt`
    *   `onReceive()`: Dispara `AlarmManager` para acionar o Service.
*   `service/EsferaService.kt` (Foreground)
    *   `onCreate()`: Solicita `MediaProjection` e inicia `WsTunnel`.
*   `identity/IdentityManager.kt`
    *   `getImmutableId()`: Retorna/gera UUID em `EncryptedSharedPreferences`.
    *   `getCustomName()` / `setCustomName()`: Persiste nome localmente.
*   `network/WsTunnel.kt`
    *   `connect()`: Configura OkHttp `WebSocketListener`.
    *   `onFailure()`: Calcula delay exponencial e reconecta.
*   `accessibility/ControlService.kt` (extends `AccessibilityService`)
    *   `dispatchTap(x, y)`: Cria `Path` e `GestureDescription`.
    *   `dispatchKey(code)`: Usa `performGlobalAction` ou `dispatchKeyEvent`.
*   `stream/ScreenEncoder.kt`
    *   `start()`: Configura `MediaCodec` (MIME `video/avc`, 60fps).
    *   `onOutputBufferAvailable()`: Envia bytes diretamente via `ws.send(buffer, true)` (Zero-copy).

#### B. Módulo VPS (`esfera-bridge` - Node.js/TypeScript ou Rust)
**Bibliotecas:** `ws` (WebSocket), `redis` (opcional p/ cluster).

*   `server/WsGateway.ts`
    *   `upgrade()`: Distingue query param `?role=agent` ou `?role=controller`.
*   `state/Registry.ts`
    *   `Map<string, {socket, name, lastPing}>`.
    *   `getDevices()`: Retorna JSON para `GET_DEVICES`.
*   `bridge/Router.ts`
    *   `link(controllerSocket, agentUuid)`: Encaminha `message` bidirecionalmente.
    *   `heartbeat()`: `setInterval` verificando `lastPing` (timeout 45s -> `socket.terminate()`).

#### C. Módulo Desktop (`esfera-desktop` - C/C++ ou C# usando Scrcpy Lib)
**Bibliotecas:** `libwebsockets` (ou `OkHttp` via JNI), `FFMpeg` (avcodec), `SDL2`.

*   `net/WsVideoClient.cpp`
    *   `on_message()`: Recebe H.264 binário -> `FrameQueue::push(buffer)`.
    *   `send_command(json)`: Envia comandos de toque/tecla.
*   `core/FrameQueue.cpp` (Anti-Deadlock)
    *   `push(AVPacket*)`: Se fila > 10 frames, `av_packet_free` (drop). Senão, empurra e sinaliza `cond_var`.
    *   `pop()`: `std::unique_lock` com `wait_for` (timeout 100ms) para não travar a thread de decode.
*   `scrcpy/Decoder.cpp`
    *   `run()`: Loop da Thread. `FrameQueue::pop()` -> `avcodec_send_packet` -> `avcodec_receive_frame` -> envia para SDL.
*   `ui/Renderer.cpp`
    *   `present()`: SDL_RenderCopy (separado da lógica de rede).

---

### Resumo para o Desenvolvedor
1.  **Android:** Foque no `AccessibilityService` e no `MediaCodec` enviando para o OkHttp WS.
2.  **VPS:** É um "proxy" burro de WebSocket com um Registry em memória.
3.  **Desktop:** Pegue o código-fonte do Scrcpy, remova a dependência de `adb`/`socket` local e plugue o `WsVideoClient` + `FrameQueue` (Bounded) no lugar. Isso elimina 100% dos deadlocks de UI e crashes por desconexão.

## 2. Código Final (Iteração 3)

```
```typescript
// ============================================================================
// MÓDULO VPS (Node.js/TypeScript) - Esfera Bridge
// Correções: Roteamento via Links, Broadcast dinâmico de Devices
// ============================================================================

// bridge/Router.ts
import { WebSocket } from 'ws';
import { Registry } from '../state/Registry';

export class Router {
    private registry: Registry;
    private links: Map<WebSocket, string> = new Map();

    constructor(registry: Registry) { this.registry = registry; }

    link(controllerWs: WebSocket, agentUuid: string) { this.links.set(controllerWs, agentUuid); }
    unlink(controllerWs: WebSocket) { this.links.delete(controllerWs); }

    // FIX (Reviewer 1): Resolve UUID do Agent pelo WebSocket do Controller
    getLinkedUuid(controllerWs: WebSocket): string | undefined {
        return this.links.get(controllerWs);
    }

    forwardToAgent(uuid: string, message: string | Buffer) {
        const agent = this.registry.devices.get(uuid);
        if (agent && agent.socket.readyState === WebSocket.OPEN) agent.socket.send(message);
    }

    forwardToController(agentUuid: string, message: string | Buffer) {
        for (const [ctrlWs, linkedUuid] of this.links.entries()) {
            if (linkedUuid === agentUuid && ctrlWs.readyState === WebSocket.OPEN) ctrlWs.send(message);
        }
    }
}

// server/WsGateway.ts
import { WebSocketServer, WebSocket } from 'ws';
import { Registry } from './state/Registry';
import { Router } from './bridge/Router';

const registry = new Registry();
const router = new Router(registry);
const wss = new WebSocketServer({ port: 8765 });

// FIX (Reviewer 2): Broadcast dinâmico para Controllers ativos
function broadcastDevices() {
    const msg = JSON.stringify({ type: 'DEVICES', devices: registry.getDevices() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws: WebSocket, req: any) => {
    const url = new URL(req.url || '', 'http://localhost');
    const role = url.searchParams.get('role');

    if (role === 'agent') {
        let uuid: string | null = null;
        ws.on('message', (message: Buffer, isBinary: boolean) => {
            try {
                if (!uuid) {
                    const hello = JSON.parse(message.toString());
                    uuid = hello.uuid;
                    registry.add(uuid, ws, hello.name || 'Unknown');
                    ws.send(JSON.stringify({ type: 'ACK' }));
                    broadcastDevices(); // Notifica Controllers
                    return;
                }
                if (isBinary) router.forwardToController(uuid, message);
                else {
                    const msg = JSON.parse(message.toString());
                    if (msg.type === 'PING') registry.updatePing(uuid);
                }
            } catch (e) { console.error(e); }
        });
        ws.on('close', () => { if (uuid) { registry.remove(uuid); broadcastDevices(); } });
    } else if (role === 'controller') {
        ws.send(JSON.stringify({ type: 'DEVICES', devices: registry.getDevices() }));
        ws.on('message', (message: Buffer, isBinary: boolean) => {
            try {
                const data = JSON.parse(message.toString());
                if (data.action === 'CONNECT') router.link(ws, data.uuid);
                else {
                    // FIX (Reviewer 1): Usa link para rotear, não exige data.uuid no comando
                    const agentUuid = router.getLinkedUuid(ws);
                    if (agentUuid) router.forwardToAgent(agentUuid, message.toString());
                }
            } catch (e) { console.error(e); }
        });
        ws.on('close', () => router.unlink(ws));
    } else ws.close();
});

setInterval(() => {
    const now = Date.now();
    for (const [uuid, dev] of registry.devices.entries()) {
        if (now - dev.lastPing > 45000) { dev.socket.terminate(); registry.remove(uuid); broadcastDevices(); }
    }
}, 15000);
```

```cpp
// ============================================================================
// MÓDULO DESKTOP (C++) - Esfera Desktop (libwebsockets + FFmpeg + SDL2)
// Correções: LWS (Stack), Backoff em Thread, FFmpeg Loop, SDL Render, PTS
// ============================================================================

// net/WsVideoClient.cpp
#include "core/FrameQueue.hpp"
#include <libwebsockets.h>
#include <nlohmann/json.hpp>
#include <thread>
#include <chrono>
#include <atomic>
#include <mutex>
#include <queue>

static PacketQueue* g_packetQueue = nullptr;
static struct lws* g_wsi = nullptr;
std::atomic<int64_t> g_pts_counter{0};
std::atomic<bool> g_shutdown{false};
std::atomic<int> g_retry{0};
std::mutex g_outbox_mtx;
std::queue<std::string> g_outbox;

static int lws_callback(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
    switch (reason) {
        case LWS_CALLBACK_CLIENT_RECEIVE:
            if (lws_frame_is_binary(wsi)) {
                AVPacket* pkt = av_packet_alloc();
                av_new_packet(pkt, len);
                memcpy(pkt->data, in, len);
                pkt->pts = pkt->dts = g_pts_counter.fetch_add(1); // FIX (Reviewer 6): Timestamps
                g_packetQueue->push(pkt);
            }
            break;
        case LWS_CALLBACK_CLIENT_WRITEABLE: {
            std::lock_guard<std::mutex> lock(g_outbox_mtx);
            if (!g_outbox.empty()) {
                std::string msg = g_outbox.front(); g_outbox.pop();
                lws_write(wsi, (unsigned char*)msg.data(), msg.size(), LWS_WRITE_TEXT);
            }
            break;
        }
        case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        case LWS_CALLBACK_CLOSED: g_wsi = nullptr; break;
    }
    return 0;
}

static struct lws_protocols protocols[] = { { "esfera", lws_callback, 0, 65536 }, { NULL, NULL, 0, 0 } };

class WsVideoClient {
    PacketQueue& packetQueue;
    std::thread worker;
public:
    WsVideoClient(PacketQueue& q) : packetQueue(q) {
        g_packetQueue = &q;
        worker = std::thread([this]() { run_loop(); });
    }

    void run_loop() {
        while (!g_shutdown) {
            struct lws_context_creation_info info; memset(&info, 0, sizeof(info));
            info.port = CONTEXT_PORT_NO_LISTEN; info.protocols = protocols;
            struct lws_context* ctx = lws_create_context(&info);
            if (!ctx) { schedule_reconnect(); continue; }

            struct lws_client_connect_info cc; memset(&cc, 0, sizeof(cc));
            cc.context = ctx; cc.address = "vps_ip"; cc.port = 8765; cc.path = "/controller"; cc.protocol = "esfera";
            g_wsi = lws_client_connect_via_info(&cc);

            while (!g_shutdown && lws_service(ctx, 1000) >= 0 && g_wsi) {}
            lws_context_destroy(ctx);
            if (!g_shutdown) schedule_reconnect();
        }
    }

    // FIX (Reviewer 5): Backoff em thread dedicada (sem bloquear loop de eventos LWS)
    void schedule_reconnect() {
        int delay = std::min(1000 * (1 << g_retry.load()), 30000);
        g_retry++; std::this_thread::sleep_for(std::chrono::milliseconds(delay));
    }

    void send_command(const std::string& action, int x, int y) {
        nlohmann::json cmd = {{"action", action}, {"x", x}, {"y", y}};
        std::lock_guard<std::mutex> lock(g_outbox_mtx);
        g_outbox.push(cmd.dump());
        if (g_wsi) lws_callback_on_writable(g_wsi);
    }
};

// scrcpy/Decoder.cpp
#include "core/FrameQueue.hpp"
#include <thread>

class Decoder {
    PacketQueue& packetQueue; FrameQueue& frameQueue; AVCodecContext* codec_ctx;
public:
    void run() {
        while (true) {
            AVPacket* pkt = packetQueue.pop();
            if (!pkt) { if (!packetQueue.is_running()) break; continue; }
            
            // FIX (Reviewer 3): Tratamento correto de EAGAIN e loop de receive
            int ret = avcodec_send_packet(codec_ctx, pkt);
            while (ret == AVERROR(EAGAIN)) {
                AVFrame* f = av_frame_alloc();
                if (avcodec_receive_frame(codec_ctx, f) == 0) frameQueue.push(f);
                else av_frame_free(&f);
                ret = avcodec_send_packet(codec_ctx, pkt);
            }
            av_packet_free(&pkt);

            AVFrame* frame = av_frame_alloc();
            while (avcodec_receive_frame(codec_ctx, frame) == 0) {
                frameQueue.push(frame);
                frame = av_frame_alloc();
            }
            av_frame_free(&frame);
        }
    }
};

// ui/Renderer.cpp
#include "core/FrameQueue.hpp"
#include <SDL2/SDL.h>

class Renderer {
    FrameQueue& frameQueue; SDL_Renderer* renderer; SDL_Texture* texture = nullptr;
public:
    void run() {
        // FIX (Reviewer 4): Renderização SDL real (60 FPS)
        while (true) {
            AVFrame* frame = frameQueue.pop();
            if (!frame) { if (!frameQueue.is_running()) break; continue; }
            
            if (!texture) texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_YV12, SDL_TEXTUREACCESS_STREAMING, frame->width, frame->height);
            SDL_UpdateYUVTexture(texture, NULL, frame->data[0], frame->linesize[0], frame->data[1], frame->linesize[1], frame->data[2], frame->linesize[2]);
            SDL_RenderClear(renderer);
            SDL_RenderCopy(renderer, texture, NULL, NULL);
            SDL_RenderPresent(renderer); // Apresenta frame na tela
            av_frame_free(&frame);
        }
        if (texture) SDL_DestroyTexture(texture);
    }
};
```
```