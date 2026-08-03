# Relatório Técnico de Engenharia de Software e Arquitetura de Automação Mobile — Esfera v3

**Data:** 2026-08-03
**Escopo:** Auditoria da base de código real em `D:\Novo\Esfera v3` (Tauri v2 + React 19 + backend Rust + módulo C++ HPC + agente Android Kotlin).
**Autor:** Hermes Agent (auditoria estática do repositório)

> AVISO DE INTEGRIDADE: Este relatório foi reconciliado contra o código-fonte real. O rascunho original fornecido pelo usuário misturava itens **já implementados**, itens **propostos/inexistentes** e ao menos um bloco **não aplicável a este projeto** (a seção "Win32 C++ ListView / LVS_OWNERDATA / dangling pointer" — ver Seção 7). Toda afirmação abaixo cita arquivo:linha.

---

## 0. Resumo Executivo — Estado Real × Proposta

| Capítulo do rascunho | Estado no código | Evidência |
|---|---|---|
| IP estático como PK (bug) | **BUG REAL, parcialmente mitigado** | `db.rs:397-412` (PK `AdbDeviceId TEXT` = `ip:porta`); porém `process_checkin` já recebe `hardware_uuid` (`checkin_server.rs:11-23,70`) |
| SQLite WAL + pragmas | **IMPLEMENTADO** | `db.rs:340-349` (WAL, busy_timeout=**10000**, cache_size=-64000, temp_store=MEMORY) |
| Fila MPSC assíncrona de escrita | **PROPOSTA (não implementada)** | `db.rs:359-365`: `conn()` devolve 1 conexão cacheada sob `Mutex` — escrita serializada, mas síncrona, sem batch em background |
| Spawning de `adb.exe` por comando | **REAL (arquitetura atual)** | `adb_manager.rs:466-491` (`create_cmd` resolve binário embutido via `Command`) |
| Cliente ADB nativo (libusb/TCP direto) | **PROPOSTA** | não há `libusb` em `Cargo.toml`; todo acesso é CLI `adb` |
| Handshake UDP 7778 | **IMPLEMENTADO (modelo inbound)** | `checkin_server.rs:48-96` |
| Túnel reverso persistente (outbound) | **PROPOSTA** | ausente no código |
| Flush preventivo de socket zumbi | **PARCIAL** | detecta "already connected" (`adb_manager.rs:891,2928`) e tem `adb disconnect` (`adb_manager.rs:933`), mas o check-in faz `adb connect` direto sem `disconnect` prévio (`checkin_server.rs:77-82`) |
| Bézier cúbica + ruído | **IMPLEMENTADO** | `esfera_hpc.cpp:286` (`generate_bezier_points`), `adb_manager.rs:2740` (swipe com Bézier) |
| Delay Gaussiano de digitação | **IMPLEMENTADO** | `esfera_hpc.cpp:215`, `adb_manager.rs:1062-1094` |
| Spintax | **IMPLEMENTADO (frontend)** | `CampaignsTab.tsx:658` (`resolveSpintax`); motor C++ citado no rascunho não existe |
| LLM local Ollama | **IMPLEMENTADO** | `ai_engine.rs:38,50-82` (também OpenAI/Anthropic) |
| Agente Android nativo kernel (Magisk/service.d) | **PROPOSTA** | o agente real é **app Kotlin** (`src-agent/.../EsferaAgentService.kt`), foreground service, não binário Rust/C++ no kernel |
| Win32 C++ ListView / dangling pointer | **NÃO APLICÁVEL** | UI é React 19 + Tauri (`src/`), não há código Win32 no repo |
| UiAutomator2 sessão persistente | **PROPOSTA** | não encontrado no código |
| Rotação de IP via proxy 4G/5G | **PROPOSTA** | não encontrado no código |

---

## 1. Arquitetura Atual (o que existe de verdade)

```
            REDE DA EMPRESA (Tenant LAN)
  Servidor Host (Windows)                    Celular Android
  ┌───────────────────────────┐             ┌──────────────────────────┐
  │ Tauri v2 + Rust backend   │  UDP 7778   │ Agente Kotlin             │
  │ - checkin_server.rs       │<────────────│ EsferaAgentService        │
  │   (listener broadcast)    │  handshake  │ (foreground, START_STICKY)│
  │ - adb_manager.rs          │  TCP 5555   │                          │
  │   (spawn adb.exe)         │────────────>│ adbd (porta 5555)         │
  │ - db.rs (SQLite WAL)      │  adb connect│                          │
  │ - ai_engine.rs (Ollama)   │  no IP      │ BootReceiver              │
  │ - native_hpc (C++ Bézier/ │  anunciado  │ (ACTION_BOOT_COMPLETED)   │
  │   Gauss)                  │             │                          │
  └───────────────────────────┘             └──────────────────────────┘
            React 19 (src/)  <--- Tauri Events / WebSocket
```

Componentes reais:
- **Backend Rust** (`src-tauri/src/`): orquestração, ADB via CLI, DB, check-in, IA, HPC bindings.
- **Agente Android Kotlin** (`src-agent/`): foreground service que faz HTTP POST de check-in a cada 30s com `esferaDeviceId` + IP atual, e reconecta via `adb connect`.
- **C++ HPC** (`src-tauri/src/native_hpc/`): funções `extern "C"` para detecção de CPU, sanitização PNG, delay Gaussiano e geração de pontos Bézier (compilado via `cc` crate, chamado do Rust).
- **Frontend React 19** (`src/`): campanhas, dispositivos, spintax preview, dashboard.

---

## 2. Gargalos Reais Confirmados no Código

### 2.1 Chave primária por IP (bug central — parcialmente mitigado)
`ESF_Device` usa `AdbDeviceId TEXT PRIMARY KEY` (= `ip:porta`, `db.rs:399`). Sob DHCP, ao trocar IP o registro antigo fica órfão e um novo é criado via `insert_unknown_device` (`checkin_server.rs:72`).
**Mitigação já presente:** o handshake carrega `hardware_uuid` (`UdpHandshakePayload.hardware_uuid`, `checkin_server.rs:18-23`) e `process_checkin` é chamado por ele (`checkin_server.rs:70`). **Falta:** promover `esfera_device_id`/`hardware_uuid` a PK real e tratar `AdbDeviceId` como atributo mutável (endereço corrente).

### 2.2 Escrita SQLite serializada, sem fila assíncrona
`Database::conn()` (`db.rs:359-365`) devolve **uma única** conexão poolada cacheada sob `Mutex`. Isso evita `SQLITE_BUSY` (só 1 escritor por vez, por design), mas:
- Não há `BEGIN IMMEDIATE` em batch nem thread consumidora MPSC.
- Cada `INSERT/UPDATE` é síncrono no caller (bloqueia a thread de evento Tauri/axum sob contenda alta).
**Correção recomendada:** adotar o padrão MPSC descrito no rascunho (canal `tokio::mpsc` + 1 writer thread com `BEGIN TRANSACTION … COMMIT`), mantendo WAL.

### 2.3 ADB por subprocesso (overhead de CPU)
Toda ação (`tap_screen`, `type_text_human_hpc`, swipe, conectar) usa `create_cmd("adb")…output()` (`adb_manager.rs:466-491, 1019, 1062, 2778`). Com N dispositivos × M ações/min gera o overhead de 500 spawns/min descrito no rascunho. **Proposta válida:** cliente ADB nativo (socket TCP 5555 ou libusb) com pool de conexões — mas **ainda não implementado**.

### 2.4 Sockets zumbis no handshake
`checkin_server.rs:77-82` faz `adb connect <ip:port>` direto. Não executa `adb disconnect` preventivo, então o erro "already connected" pode travar reconexão após queda de Wi-Fi (o `adb disconnect` existe em `adb_manager.rs:933`, só não é usado no handshake).

---

## 3. Mitigação HCI (IMPLEMENTADA)

### 3.1 Trajetória Bézier cúbica
`esfera_hpc_generate_bezier_points` (`esfera_hpc.cpp:286`) gera P1/P2 com ruído; `adb_manager.rs:2740` (`send_whatsapp_intent_and_bezier_tap`) injeta `swipe` ADB interpolado. Equação idêntica à do rascunho:
`P(t)=(1-t)³P₀ + 3(1-t)²t P₁ + 3(1-t)t² P₂ + t³ P₃`.

### 3.2 Digitação com delay Gaussiano
`esfera_hpc_calculate_gaussian_delay` (`esfera_hpc.cpp:215`); `type_text_human_hpc` (`adb_manager.rs:1062`) envia `input text <c>; sleep <gauss>` por caractere (μ=45..160 ms no trecho atual). Observação: o rascunho cita μ=110/σ=35; o código usa faixas por chamada (ex.: 2200-3500 ms em `adb_manager.rs:2767`). A distribuição está presente; os parâmetros exatos são configuráveis por caller.

### 3.3 Spintax
`resolveSpintax` (`CampaignsTab.tsx:658`) resolve `{a|b|c}` no frontend para preview. Não há motor C++ (citado no rascunho) — a resolução final em produção deve ser movida para o backend/Rust para evitar envio repetido da mesma variante.

---

## 4. Persistência Resiliente (WAL OK, fila proposta)

Pragmas aplicados em `db.rs:340-349`:
```
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=10000;      -- rascunho sugeria 5000
PRAGMA foreign_keys=ON;
PRAGMA cache_size=-64000;       -- 64 MB
PRAGMA temp_store=MEMORY;
PRAGMA mmap_size=268435456;
PRAGMA page_size=8192;
```
WAL + `busy_timeout` já eliminam o `SQLITE_BUSY` sob leitura concorrente. O **gap** é a fila MPSC assíncrona (Seção 2.2) para elevar throughput de escrita a >50k regs/s em pico.

---

## 5. Barramento de Comunicação ( handshake OK, cliente nativo e túnel = propostas)

- **UDP 7778 (inbound) — IMPLEMENTADO** (`checkin_server.rs:48-96`): o celular anuncia `hardware_uuid`+`ip` e o host faz `adb connect`. Zero-CPU event-driven no listener.
- **Túnel reverso persistente (outbound) — PROPOSTA**: não há. Hoje o host sempre inicia a conexão no IP anunciado; se o celular estiver atrás de NAT/cellular sem porta aberta, o modelo inbound falha. O rascunho está correto em propor invertar para outbound (celular abre socket para porta estática do host).
- **Cliente ADB nativo — PROPOSTA**: todo acesso é CLI (`adb.exe` embutido). Migração para socket TCP/libusb reduziria latência de ~250-500 ms para <35 ms conforme o rascunho.

---

## 6. Agente Android (Kotlin atual × Goodware Daemon proposto)

**Atual (`src-agent/`):**
- `EsferaAgentService.kt`: `Service` foreground (`START_STICKY`), `PARTIAL_WAKE_LOCK`, `ConnectivityManager.NetworkCallback` para detectar troca de IP, check-in HTTP a cada 30s (`CHECK_IN_INTERVAL_MS=30000`).
- `BootReceiver.kt`: dispara o service em `ACTION_BOOT_COMPLETED`.
- **Não é** binário Rust/C++ no kernel; está sujeito a restrições de bateria (Doze), sandbox e possível morte pelo LMK sob pressão de memória.

**Proposta do rascunho (Goodware Daemon kernel):**
- Binário nativo estático (`aarch64-linux-android`) via Magisk/KernelSU `service.d`/`post-fs-data.d`, imune a LMK, `nice -20`.
- `dumpsys deviceidle whitelist`, `WifiLock`, `KEYGUARD_DISABLE`, `STAY_ON_WHILE_PLUGGED_IN`.
- **Avaliação:** tecnicamente válida para cenários root, mas **requer bootloader desbloqueado / root** — inviável para fazenda de produção sem controle de ROM. A abordagem Kotlin atual já cobre o essencial (WakeLock + foreground + reconexão por IP). Recomenda-se, antes do kernel daemon, hardening do app atual: `deviceidle whitelist`, `WifiLock`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` e `adb tcpip 5555` persistido via `setprop`/`resetprop`.

---

## 7. Discrepâncias do Rascunho Original (importante)

1. **Seção "Win32 C++ ListView / LVS_OWNERDATA / dangling pointer" — NÃO SE APLICA.** O projeto Esfera v3 usa **React 19 + Tauri**, não API Win32. Não existe `ListView`, `WM_NOTIFY`, `LVN_GETDISPINFO` ou `LVITEM::pszText` no repositório. O código "vulnerável/seguro" dessa seção deve ser descartado ou movido para um projeto legado diferente.
2. **"UiAutomator2 sessão persistente" — não implementado** e não há referência no código. A automação de tela usa `adb shell input` + `swipe` Bézier, não o driver UiAutomator2.
3. **"Proxy 4G/5G rotação de IP / TLS fingerprint" — não implementado.** A rotação de identidade de rede não existe no código.
4. **Parâmetros Gaussiano μ=110/σ=35** são ilustrativos; o código usa faixas por função (ex.: 45-160 ms, 2200-3500 ms).
5. **busy_timeout** no código é **10000** ms, não 5000.

---

## 8. Roteiro de Implementação Priorizado

**P0 — Corrigir o bug de identidade (maior impacto):**
1. `db.rs`: adicionar coluna `hardware_uuid TEXT UNIQUE` em `ESF_Device`; migrar PK lógica para `hardware_uuid`; manter `AdbDeviceId`/`current_adb_address` como atributo de endereço corrente. Atualizar `process_checkin`/`insert_unknown_device` para upsert por `hardware_uuid`.
2. `checkin_server.rs`: executar `adb disconnect <alvo>` antes de `adb connect` (elimina socket zumbi / "already connected").

**P1 — Escalabilidade de escrita:**
3. `db.rs`: implementar fila MPSC (`tokio::mpsc`) + 1 writer thread com batch `BEGIN/COMMIT`; expor `enqueue_write(...)`.

**P2 — Resiliência de conexão:**
4. `checkin_server.rs` / `adb_manager.rs`: adicionar modo túnel reverso (celular abre socket TCP para porta estática do host) como fallback ao inbound.
5. Agente Android: `deviceidle whitelist`, `WifiLock`, `setprop service.adb.tcp.port 5555` persistente.

**P3 — Performance ADB:**
6. Cliente ADB nativo (socket TCP 5555 / libusb) substituindo `spawn adb.exe` em `adb_manager.rs` (pool de conexões, <35 ms).

**P4 — Qualidade/Higiene:**
7. Mover resolução de Spintax do frontend (`CampaignsTab.tsx`) para o backend Rust (evita repetição de variante).
8. Remover a seção Win32 ListView do rascunho (não aplicável).

---

## 9. Eficiência Operacional e Redução de Custos com LLMs Locais e Spintax

**Status no código: IMPLEMENTADO (parcial) — Ollama local + Spintax presentes; quantização Q4_K_M e "motor C++ de Spintax" são recomendação, não implementação.**

### 9.1 LLM Local (Ollama) — IMPLEMENTADO
`ai_engine.rs` já suporta provedor **ollama** (default `http://localhost:11434/api/generate`, `ai_engine.rs:51-57,59`), além de openai/anthropic/custom (`ai_engine.rs:37-43`). A função `generate_message` reescreve a mensagem respeitando o contato (`config.system_prompt` + `{nome}`) e sanitiza markdown/aspas (`ai_engine.rs:169-178`). O dispatcher expõe `rewrite_message_ai` para o frontend (`CampaignsTab.tsx:680`).

Isso confirma a tese do rascunho: **inferência local via Ollama elimina custo de API cloud** (GPT-4o/Claude). Observações de implementação:
- O modelo é configurável por `AiConfig.model` (default `llama3`, `ai_engine.rs:59`); o rascunho sugere Qwen2.5-1.5B-Instruct / Llama-3.2-3B-Instruct em **Q4_K_M** — isso é recomendação de modelo, não código. Qualquer GGUF quantizado serve, desde que o Ollama tenha o modelo puxado.
- `busy_timeout`/latência: `ai_engine.rs:21` usa `timeout(Duration::from_secs(15))`. A afirmação do rascunho "<200ms" é um alvo de hardware (GPU AVX2), não medido no código.
- LGPD: ao rodar Ollama em `localhost`, os dados de contato **não saem do host** — vantagem de privacidade confirmada pela arquitetura local.

### 9.2 Spintax — IMPLEMENTADO (frontend) + gap de backend
`resolveSpintax` (`CampaignsTab.tsx:658-670`) resolve `{opção1|opção2|opção3}` via regex `/{([^{}]+)}/g`, sorteando uma opção por bloco, com até 100 iterações (aninhamento). Há preview em tempo real no modal de campanha (`handleTestSpintax`, `CampaignsTab.tsx:657`).

**Discrepância do rascunho:** ele cita "motor de Spintax desenvolvido em C++". No Esfera v3 o C++ HPC (`native_hpc/esfera_hpc.cpp`) **não** tem spintax — só CPU detect, PNG sanitize, Gauss delay, Bézier. A resolução atual é JS no frontend.
**Risco:** resolver no frontend significa que cada cliente/abas pode gerar a mesma variante, e a variação não é determinística no backend. Recomendação P4-7 (já no roteiro): mover a resolução para o backend Rust, gravando a variante escolhida por contato em `ESF_Contact.CustomMessage`.

Fórmula de combinações (válida, independente de onde roda): `N_total = ∏ n_i`. Com 6 blocos × 4 opções → 4^6 = 4.096 variantes distintas — corredo no rascunho.

Exemplo real do rascunho (resolvido pelo `resolveSpintax` em `CampaignsTab.tsx:658`):
```
Texto Base:
"{Olá|Oi|Bom dia} {nome}, {identificamos|localizamos} uma condição {especial|exclusiva} para quitação da sua fatura."

Blocos e opções: {Olá|Oi|Bom dia}=3 · {nome}=1 (variável) · {identificamos|localizamos}=2 · {especial|exclusiva}=2
N_total = 3 × 1 × 2 × 2 = 12 variações distintas (sem contar a interpolação de {nome}).

Variação Gerada 1: "Olá Maria, identificamos uma condição especial para quitação da sua fatura."
Variação Gerada 2: "Bom dia Maria, localizamos uma condição exclusiva para quitação da sua fatura."
```
O `resolveSpintax` sorteia uma opção por bloco via `Math.random()`; para aninhamento ele reexecuta o regex até 100 iterações (`CampaignsTab.tsx:663`). Não há garantia de não-repetição entre contatos (ver risco em P4-7).

### 9.3 Arquitetura Híbrida (conforme rascunho)
```
Template Spintax ──► [resolveSpintax] ──► Mensagem Variada
                                            │
                              (se precisar de reescrita contextual)
                                            ▼
                                  [LLM Local Ollama]  ──► resposta <200ms (HW dep.)
                                            │
                                            ▼
                                  Mensagem Final (zero custo API cloud)
```
No Esfera v3: Spintax roda no React; LLM local roda em Rust→Ollama. O encadeamento "Spintax primeiro, LLM só se necessário" está correto e recomendado para custo zero.

> Nota de precisão sobre o trecho de LLM local do rascunho: o Esfera v3 integra **Ollama via HTTP** (`localhost:11434`, `ai_engine.rs:50-82`), não chama o binário `llama.cpp` direto. Modelos Q4_K_M (Qwen2.5-1.5B / Llama-3.2-3B) são recomendação de modelo, não hardcoded. Os "<200ms" são alvo de hardware (GPU AVX2), não medidos no código (timeout de 15s em `ai_engine.rs:21`). A conformidade LGPD e o "custo zero de API cloud" valem para `provider=ollama`.

---

## 7. Matriz Comparativa de Arquiteturas e Soluções Propostas

**Status no código (verificado):** cada linha abaixo traz o estado REAL do Esfera v3, não apenas a promessa do rascunho.

| Dimensão Técnica | Abordagem Legada / Amadora | Solução Otimizada (proposta no rascunho) | Estado no Esfera v3 (real) |
|---|---|---|---|
| Identificação do Celular | IP estático no banco (192.168.x.x:5555) | Hardware UUID (ro.serialno) + IP dinâmico | **PARCIAL**: PK ainda é `AdbDeviceId`=IP (`db.rs:399`); handshake já carrega `hardware_uuid` (`checkin_server.rs:18-23`) mas não é PK |
| Aperto de Mão de Rede | Polling passivo via subprocessos adb.exe | Handshake reverso UDP + sockets TCP | **INBOUND IMPLEMENTADO** (UDP 7778, `checkin_server.rs:48-96`); túnel reverso outbound = PROPOSTA |
| Gestão de Sockets ADB | Conexão sobre socket morto/zumbi | Flush ativo de sockets zumbis (`adb disconnect`) | **PARCIAL**: detecta "already connected" (`adb_manager.rs:891`) e tem `adb disconnect` (`adb_manager.rs:933`), mas o handshake faz `connect` sem `disconnect` prévio (`checkin_server.rs:77-82`) |
| Modo de Bateria (Doze) | `wifi_sleep_policy` passivo | Foreground Service + WifiLock + WakeLock | **IMPLEMENTADO (app)**: `PARTIAL_WAKE_LOCK` + foreground (`EsferaAgentService.kt:204-211`); `deviceidle whitelist`/WifiLock = PROPOSTA de hardening |
| Barramento de Comandos | Spawn de adb.exe por clique | Pool de sockets TCP / libusb em Rust/C++ | **LEGADO AINDA ATIVO**: todo acesso é CLI `adb` (`adb_manager.rs:466-491`); cliente nativo = PROPOSTA (P3) |
| Concorrência SQLite | Rollback Journal (trava exclusiva) | WAL + busy_timeout + fila MPSC | **WAL OK** (`db.rs:340-349`); fila MPSC = PROPOSTA (P1) |
| Interação HCI | `input tap` coordenada fixa | Bézier cúbica + delays Gaussianos | **IMPLEMENTADO**: `generate_bezier_points` (`esfera_hpc.cpp:286`), `calculate_gaussian_delay` (`esfera_hpc.cpp:215`), `type_text_human_hpc` (`adb_manager.rs:1062`) |
| Gestão de Memória UI | Ponteiros locais de pilha → LVITEM::pszText (Win32) | (rascunho citava Virtual ListView + std::shared_ptr — **NÃO APLICA ao Esfera v3**) | **React 19 + Tauri Events** (`app.emit` em `checkin_server.rs:85,132`); UI em `src/` sem Win32; ver `docs/Legado_Win32_ListView_DanglingPointer.md` |
| Personalização por IA | API cloud paga (OpenAI/Anthropic) | Spintax C++ + LLM local (Ollama) | **IMPLEMENTADO**: Ollama (`ai_engine.rs:50-82`) + Spintax frontend (`CampaignsTab.tsx:658`); "motor C++ Spintax" inexistente |

**Impacto resumido (do rascunho, validado onde aplicável):**
- Identificação por UUID → zero perda de conexão em renovação DHCP (P0 pendente).
- Handshake UDP event-driven → redução de CPU host vs polling (implementado).
- Flush de socket zumbi → elimina "already connected" (P0 pendente no handshake).
- WakeLock/foreground → imunidade parcial ao Doze (implementado no app).
- Pool TCP/libusb → latência 350ms→35ms (proposta P3).
- WAL → leitores≠escreventes, sem SQLITE_BUSY (implementado).
- Bézier+Gauss → mitigação de banimento por padrão robótico (implementado).
- Spintax+Ollama → custo zero de API + LGPD (implementado).

---

## 8. Plano de Ação Múltiplo para Implementação

Dividido em duas frentes, priorizando baixo nível primeiro. Itens marcados [REAL] já existem; [P0]–[P4] seguem o roteiro da Seção 8 original.

### Frente 1: Backend Rust, Banco de Dados e Gerenciamento ADB (Baixo Nível)
- [P0] **Schema SQLite (`db.rs`) — reestruturação**:
  - **Alterar a PK de `ESF_Device` de `AdbDeviceId` (IP) para `HardwareUUID`**. Hoje `AdbDeviceId TEXT PRIMARY KEY` (`db.rs:399`) = `ip:porta`; o `hardware_uuid` chega no handshake (`checkin_server.rs:18-23`, campo `esfera_device_id` no `Device`/`process_checkin`). A mudança exige: (a) nova coluna `HardwareUUID TEXT PRIMARY KEY` (ou promover `EsferaDeviceId` a PK); (b) reescrever `process_checkin`/`insert_unknown_device` (`db.rs:1000-1041`) para upsert por UUID; (c) tratar `AdbDeviceId`/`CurrentAdbAddress` como atributo de endereço corrente (já existe `CurrentAdbAddress` em `db.rs:59`); (d) atualizar os JOINs/FKs que usam `AdbDeviceId` (ex.: `db.rs:1832,2035,2056`). Obs: o backend não lê `ro.serialno` direto — quem envia o UUID é o agente Kotlin (`EsferaAgentService.kt` → `esferaDeviceId` em `/api/devices/check-in`).
  - Pragmas de inicialização **JÁ APLICADOS** (`db.rs:340-349`): `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=10000` (o rascunho citava 5000 — código usa 10000), `foreign_keys=ON`, `cache_size=-64000`, `temp_store=MEMORY`, `mmap_size=268435456`, `page_size=8192`. Ver Seção 4.
  - Fila MPSC assíncrona → ver [P1].
- [P0] **Handshake (`checkin_server.rs`)**: `adb disconnect <alvo>` preventivo antes de `adb connect` implementado em **ambas** as rotas (listener UDP `checkin_server.rs:77-80` e HTTP `handle_checkin` `checkin_server.rs:129-134`). Elimina socket zumbi / "already connected".
- [P0] **Schema SQLite (`db.rs`) — reestruturação**:
  - **Identidade por `EsferaDeviceId` (UUID) no check-in**: `process_checkin` (`db.rs:1172-1193`) agora atualiza `AdbDeviceId = ?1` junto com `CurrentAdbAddress`, fazendo o registro "seguir" o endereço corrente quando encontrado por `EsferaDeviceId` — ou seja, a identidade canônica é o UUID e o endereço (IP/DHCP) é atributo mutável. Isso entrega o objetivo "zero perda em renovação DHCP" sem reescrever a PK do schema (que quebraria os JOINs em `EFS_Chip`/`EFS_DeviceAssignment`/`EFS_DevicePermissionRequest`). **Validação de build pendente**: o ambiente não tem toolchain C++ completo (headers CRT/Windows SDK ausentes em `D:\Programs\Visual Studio`), então `cargo build` falha no `build.rs` que compila `esfera_hpc.cpp`/`hpc_device_router.cpp` — bloqueio de ambiente, não das edições. Requer VS com Windows SDK instalado para compilar e validar.
- [P1] **Fila de escrita MPSC (`db.rs`)**: `tokio::mpsc` + 1 writer thread com batch `BEGIN/COMMIT`; expor `enqueue_write(...)`. (Hoje: conexão única sob `Mutex`, `db.rs:359-365`.)
- [REAL] **Listener UDP 7778 (`checkin_server.rs:48-96`)**: já implementado como listener passivo `UdpSocket` event-driven (zero polling de descoberta no host). O agente Kotlin é quem faz polling de 30s (`EsferaAgentService.kt:56,161`) — não o backend. Pendências: (i) [P0] `adb disconnect` preventivo no handshake (flush de socket zumbi); (ii) [P3] cliente ADB nativo substituindo `Command::new("adb")` em `adb_manager.rs:466` (o "remover polling/spawn de adb.exe" do rascunho é esse item P3, não o handshake).
- [REAL] **Bézier/Gauss HPC (`esfera_hpc.cpp:215,286`, `adb_manager.rs:1062,2740`)**: gerador de Curvas de Bézier cúbicas (trajetória de clique/arraste) e delays Gaussianos (cadência inter-caractere) **já implementados**. Expor via comandos Tauri.
- [P2] **Túnel reverso (outbound)**: celular abre socket TCP para porta estática do host como fallback ao inbound.
- [P3] **Cliente ADB nativo**: socket TCP 5555 / libusb substituindo `spawn adb.exe` (`adb_manager.rs:466`), com pool de conexões (<35ms).

### Frente 2: Frontend React 19, Estado e Experiência do Usuário (UI/UX)
> O rascunho original intitulava esta frente "Interface Win32" e pedia "Corrigir a alocação de ponteiros na notificação LVN_GETDISPINFO com std::shared_ptr". **Isso não se aplica ao Esfera v3** (React 19 + Tauri; zero código Win32/ListView no repo). O bloco foi descartado do relatório e arquivado em `docs/Legado_Win32_ListView_DanglingPointer.md`. Abaixo, a frente real do projeto.

- [REAL] **Sincronização de estado em tempo real**: backend→frontend via **Tauri Events** (não WebSocket — o Tauri já fornece `emit`/`listen` push nativo, sem servidor WS extra). Backend emite `device-updated` (`checkin_server.rs:85,132`); frontend escuta com `listen("device-updated", …)` em `src/pages/DevicesTab.tsx:167`. Manter e expandir para todos os eventos do device farm.
- [P4] **Spintax no backend**: mover `resolveSpintax` (`CampaignsTab.tsx:658`) para Rust, gravando variante por contato em `ESF_Contact.CustomMessage` (evita repetição e garante determinismo).
- [REAL] **Preview de Spintax** (`CampaignsTab.tsx:657-683`, botão "Simular Spintax"): resolve no frontend via `resolveSpintax` e agora gera até 5 variações distintas em lista (`spintaxPreview: string[]`), permitindo ao operador avaliar a diversidade em tempo real. Build validado (`npm run build` ✅). Funcional.
- [REAL] **Interface de configuração de LLM local**: criada em `SettingsTab.tsx` (seção "IA & Spintax Local" no menu lateral, ícone Sparkles). Formulário ligado aos comandos `get_ai_config`/`save_ai_config` (`commands.rs:1193,1205`) e tabela `ESF_AiConfig` (`db.rs:556`): provedor (ollama/openai/anthropic/custom), modelo (sugestão Q4_K_M), endpoint, temperatura, system prompt e API key. Build validado (`npm run build` ✅). Resolvido.
- [REAL] **Polimento de layout** (`src/pages/*.tsx`, Tailwind): `shrink-0` (ex.: `AutomationsTab.tsx:259`, `DashboardTab.tsx:168`, ícones Lucide em `DevicesTab.tsx:1120,1232,1320`) e `whitespace-nowrap` (badges e filtros: o componente `Badge` já aplica `whitespace-nowrap shrink-0` em `src/components/ui/Badge.tsx:46`; filtros em `CampaignsTab.tsx:279,423`, `DashboardTab.tsx:112`). Breakpoints `md:/lg:` (`CampaignsTab.tsx:292`, `CompaniesTab.tsx:186`) e anéis de foco já aplicados. **Resolvido**: o limite rígido `h-[340px]` citado no rascunho foi substituído por `min-h-[340px]` em `CampaignsTab.tsx:473`. Verificar se há outros `h-[...]` fixos em cards de dispositivos.

---

## Anexo — Índice de Evidências (arquivo:linha)

- `src-tauri/src/db.rs:340-349` — pragmas WAL
- `src-tauri/src/db.rs:397-412` — `ESF_Device` PK por IP
- `src-tauri/src/db.rs:359-365` — conexão única cacheada (sem fila MPSC)
- `src-tauri/src/checkin_server.rs:11-23,48-96,70,77-82` — handshake UDP inbound + adb connect sem disconnect
- `src-tauri/src/adb_manager.rs:466-491` — spawn de `adb.exe`
- `src-tauri/src/adb_manager.rs:891,2928` — detecção "already connected"
- `src-tauri/src/adb_manager.rs:933` — `adb disconnect`
- `src-tauri/src/adb_manager.rs:1019,1062-1094,2740` — tap/discreto, Gauss, Bézier+swipe
- `src-tauri/src/native_hpc/esfera_hpc.cpp:215,286` — `calculate_gaussian_delay`, `generate_bezier_points`
- `src-tauri/src/ai_engine.rs:38,50-82` — Ollama local + OpenAI/Anthropic
- `src-agent/app/src/main/kotlin/com/esfera/agent/EsferaAgentService.kt` — agente Kotlin foreground
- `src-agent/app/src/main/kotlin/com/esfera/agent/BootReceiver.kt` — boot receiver
- `src/pages/CampaignsTab.tsx:658` — `resolveSpintax` (frontend)
