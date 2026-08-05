# HERMES CONTEXT — ESFERA V3

## Objetivo

Este documento preserva o contexto técnico descoberto pelo Hermes durante
a auditoria da arquitetura de comunicação dos dispositivos.

NÃO considerar este documento como código executável.
Ele representa o diagnóstico e as decisões arquiteturais já descobertas.

---

# 1. PROBLEMA ORIGINAL

O sistema possui celulares físicos conectados por rede/ADB.

Problema observado:

- ao conectar/ligar um novo celular, dispositivos existentes podem perder conexão;
- o Master precisa conseguir enxergar/controlar dispositivos;
- o hub local não deve ser requisito para manter a presença do dispositivo;
- a identidade do dispositivo deve sobreviver a desconexões/reconexões.

---

# 2. ARQUITETURA ATUAL DESCOBERTA

Existem dois agentes no Android:

## device-agent

Localização:

`/data/adb/earlypoint/`

Tecnologia:

Rust / daemon nativo.

Funções descobertas:

- túnel reverso;
- handshake UDP 7778;
- proxy ADB.

Lê:

`persist.esfera.hub`

ou:

`/data/adb/earlypoint/config.json`

---

## EsferaAgentService

Tecnologia:

Kotlin.

Configuração:

`/sdcard/esfera_config.json`

Funções:

- check-in HTTP;
- presença WebSocket;
- túnel.

---

# 3. TOPOLOGIA DESCOBERTA

O VPS:

`34.29.70.113`

recebe:

`:8080` → check-in HTTP

Porém o hub-standalone atualmente NÃO possui:

`:8888` → tunnel server

`:7779` → presence WebSocket

O hub local possui esses serviços.

Consequência:

O dispositivo aponta para o VPS, mas os canais necessários para túnel/presença não estão implementados no VPS.

---

# 4. CAUSA RAIZ IDENTIFICADA

A topologia está inconsistente.

O fluxo atual é aproximadamente:

CELULAR
  |
  +--> VPS:8080  check-in       OK
  |
  +--> VPS:8888  túnel          FALHA
  |
  +--> VPS:7779  presença       FALHA

Enquanto:

HUB LOCAL
  |
  +--> :8888 tunnel server
  +--> :7779 presence server

mas o celular não está apontando para o hub local.

---

# 5. CONSEQUÊNCIA

O celular consegue realizar check-in no VPS.

Porém:

- túnel reverso cai;
- presença não funciona corretamente;
- hub local não recebe os canais que espera;
- Master não possui controle remoto completo;
- dispositivos podem parecer desconectados/desvinculados.

---

# 6. OPÇÃO ARQUITETURAL ESCOLHIDA

OPÇÃO A.

O VPS deve ser a fonte de verdade e ponto de presença permanente.

Arquitetura desejada:

MASTER
  |
  v
VPS
  |
  +--> Empresa A --> Celular A
  +--> Empresa B --> Celular B
  +--> Empresa C --> Celular C

O hub local passa a ser cache/proxy/fallback,
não requisito para manter o dispositivo conectado.

---

# 7. CORREÇÕES NECESSÁRIAS

1. Portar/adaptar `tunnel_server.rs` para `hub-standalone`.

2. Portar/adaptar `presence_server.rs` para `hub-standalone`.

3. Integrar os dois servidores ao `hub-standalone`.

4. Garantir:
   - :8080 check-in
   - :8888 tunnel
   - :7779 presence

5. Expandir `EmpresaServer` para permitir comandos de controle,
   não somente leitura.

6. Garantir roteamento:

COMPANY_ID
+
DEVICE_ID
+
SESSION_ID

7. Não usar IP, posição da lista ou sessão temporária como identidade
permanente do dispositivo.

---

# 8. IDENTIDADE DO DISPOSITIVO

Conceito desejado:

DEVICE_ID
COMPANY_ID
AGENT_ID
SESSION_ID
LAST_SEEN
CONNECTION_STATUS

A sessão pode morrer.

O DEVICE_ID não.

Após reconexão:

mesmo DEVICE_ID
+
nova SESSION_ID
+
mesma COMPANY_ID

---

# 9. REQUISITO DE ISOLAMENTO

Empresa A nunca pode receber:

- dispositivo da Empresa B;
- sessão da Empresa B;
- eventos da Empresa B;
- comandos da Empresa B.

---

# 10. TESTES OBRIGATÓRIOS

Testar pelo menos:

A online
B online
C online

Conectar C:

A online
B online
C online

Desconectar B:

A online
B offline
C online

Reconectar B:

A online
B online
C online

Desconectar A:

B online
C online

Reconectar A:

A online
B online
C online

Nenhum dispositivo diferente do afetado pode perder conexão.

---

# 11. TESTES DE INFRAESTRUTURA

Também testar:

- queda de internet;
- reconexão;
- reinício do agente;
- reinício do hub;
- VPS permanece online;
- hub local desligado;
- Master continua enxergando dispositivos;
- isolamento entre empresas.

---

# 12. REGRA PARA FUTURAS IAs

NÃO assumir que:

"auto reconnect = problema resolvido"

NÃO assumir que:

"keepalive = identidade persistente"

NÃO assumir que:

"build passou = sistema funciona"

A arquitetura deve ser validada por testes de múltiplos dispositivos e
sessões concorrentes.

---

# 13. ARQUIVOS IMPORTANTES DESCOBERTOS

`adb_manager.rs`

`src/device-agent/src/main.rs`

`EsferaAgentService`

`hub-standalone/src/checkin_server.rs`

`hub-standalone/src/hub.rs`

`hub-standalone/src/db.rs`

`hub-standalone/src/protocol.rs`

`src-tauri/src/tunnel_server.rs`

`src-tauri/src/presence_server.rs`

`empresa_server.rs`

---

# 14. DECISÃO ARQUITETURAL

A arquitetura escolhida é:

OPÇÃO A — VPS como fonte de verdade completa.

Não voltar para a Opção B ou C sem uma decisão explícita.

---

# 15. ESTADO DO DIAGNÓSTICO

Diagnóstico de topologia:
CONFIRMADO

Correção:
AINDA NÃO CONCLUÍDA

Testes físicos com múltiplos dispositivos:
NÃO CONFIRMADOS

Não declarar o problema como resolvido até os testes passarem.

---

# 16. ATUALIZAÇÃO — CORREÇÕES APLICADAS (auditoria code-vs-code)

As seções 3, 4 e 7 acima estão DESATUALIZADAS. Estado verificado no código:

## 16.1 JÁ ESTAVA FEITO (antes desta rodada)

- `hub-standalone/src/main.rs:56-88` sobe os TRÊS canais no VPS:
  :8080 check-in, :8888 tunnel, :7779 presence (env HTTP_PORT/TUNNEL_PORT/PRESENCE_PORT).
- `hub-standalone/src/session_manager.rs` implementa o item 8 (identidade):
  chave (COMPANY_ID, DEVICE_ID), SESSION_ID novo por reconexão, canais
  exclusivos túnel(rust)/presença(kotlin), status Online/Degraded/Offline.

## 16.2 CORRIGIDO AGORA

1. COMPANY_ID ponta-a-ponta (o isolamento do item 9 era ilusório: todos os
   agentes omitiam companyId e caíam na empresa 0):
   - `device-agent/src/main.rs`: `AgentConfig.company_id`, lido de
     `persist.esfera.company` ou `companyId` em `/data/adb/earlypoint/config.json`;
     enviado no handshake TCP e no handshake UDP.
   - `src-agent/.../EsferaAgentService.kt`: `EsferaConfig.companyId`,
     propagado para `CheckInRequest`, `TunnelHandshake` e `PresenceClient`.
   - `src-agent/.../PresenceClient.kt`: `companyId` no `HeartbeatPayload`.
   - Servidores agora RECUSAM sessão sem companyId válido:
     `tunnel_server.rs` (erro + close), `presence_server.rs` (erro + close),
     `checkin_server.rs` (HTTP 400; antes respondia "ok" silenciosamente).

2. Fonte de verdade única RAM -> DB (havia DUAS em conflito: o sweeper de
   check-in marcava offline device com túnel vivo):
   - `session_manager::live_snapshot()` projeta o estado vivo;
   - `db::sync_live_state()` persiste status/bateria e faz o stale sweep
     PROTEGENDO quem tem canal vivo;
   - `main.rs` substituiu `mark_stale_devices_offline` por essa reconciliação.

3. Canal de CONTROLE real (item 5/6). Antes o hub só respondia `proxy-ack`,
   nunca PEDIA proxy — não existia caminho Master -> VPS -> adbd:
   - `tunnel_server.rs`: registry CONTROL (company_id, device_id) -> canal de
     escrita da sessão; `request_proxy()` e `send_control()`.
   - `hub.rs::handle_vps_command`: comandos resolvidos PELO VPS, sem depender
     do hub local — `get_live_devices`, `request_device_proxy`,
     `send_device_control`. Todos exigem companyId e são company-scoped.

4. `EmpresaServer` deixou de ser somente leitura (item 7.5):
   `src-tauri/src/empresa_server.rs` ganhou `device_tap`, `device_keyevent`,
   `device_type_text`, `device_capture_screen`. O alvo é resolvido por
   (companyId, esferaDeviceId) e o serial vem do DB — o cliente nunca envia
   serial/IP, então não alcança aparelho de outra empresa.

5. Provisionamento grava a empresa no aparelho (sem isso os agentes novos
   seriam corretamente RECUSADOS pelo VPS):
   - `adb_manager::inject_server_config(..., company_id)` faz
     `setprop persist.esfera.company`, `setprop persist.esfera.hub <host>` e
     grava `companyId` em `/sdcard/esfera_config.json`;
   - `provision_device` / `provision_all_devices` exigem company_id > 0;
   - nos comandos Tauri o company_id vem da SESSÃO (token), nunca do cliente,
     para ninguém provisionar aparelho para dentro de outra empresa.

## 16.3 VERIFICAÇÃO EXECUTADA

- `cargo check` hub-standalone: 0 erros.
- `cargo check` src-tauri: 0 erros.
- `cargo check` device-agent: 0 erros.
- `cargo test --test sim`: 1/1 (ciclo de vida A/B/C + isolamento).
- `cargo test --test isolation`: 4/4 (NOVO) — handshake sem companyId recusado,
  check-in sem companyId = HTTP 400, proxy respeita isolamento por empresa,
  reconciliação RAM->DB protege device com canal vivo.
- `npm run build`: OK.
- `gradle assembleRelease` (Kotlin): BUILD SUCCESSFUL; APK assinado e
  `apksigner verify` OK em `public/Esfera_Agent_ADB.apk`.

## 16.4 AINDA EM ABERTO

- Testes FÍSICOS com celulares reais (itens 10 e 11): NÃO EXECUTADOS.
  Os testes acima são de protocolo/integração, não substituem hardware.
- Provisionamento do companyId nos aparelhos: RESOLVIDO no fluxo de
  `provision_device` (ver 16.2 item 5). Aparelhos JÁ provisionados antes desta
  mudança precisam ser reprovisionados (ou receber os setprops manualmente),
  senão serão recusados pelo VPS.
- `device-agent` ainda cai para `127.0.0.1` quando `persist.esfera.hub` está
  vazio; o provisionamento agora grava essa prop, mas aparelhos antigos não a têm.
- `src-tauri/src/{tunnel,presence,session_manager}.rs` (hub LOCAL) continuam
  no modelo antigo de identidade por UUID puro, sem company_id. É fallback,
  mas diverge do VPS — alinhar quando o hub local virar cache/proxy de fato.

---

# 17. GAP DE SEGURANÇA DO HUB LOCAL — CORRIGIDO (2026-08-05)

A seção 16 trata do hub-standalone (VPS). O hub LOCAL (binário `esfera-hub`
em `src-tauri/src/bin/hub.rs`, que usa `crate::hub::Hub`) tinha a vuln idêntica
à que o hub-standalone já eliminou. FOI CORRIGIDO nesta rodada:

## 17.1 O que ESTAVA ERRADO (removido)
- `HubMessage::Auth { username, password, role }` aceitava empresa com a MESMA
  credencial global `master`/`admin123` (consts hardcoded).
- Definição local de `HubMessage` em vez de `crate::protocol::HubMessage`.
- `Register` não amarrado à sessão.

## 17.2 O QUE FOI FEITO
- `src-tauri/src/hub.rs` REESCRITO: usa `crate::protocol::HubMessage`
  (`Auth { token, role }`), valida por `db.validate_token`, `Register` amarrado
  à sessão (empresa só registra a própria company_id; master qualquer uma), e
  `Command` só encaminha se master OU dono da empresa alvo.
- `src-tauri/src/db.rs`: adicionados `validate_token` + `upsert_company_token` e
  tabela `ESF_CompanyToken`; seed do token master via env `HUB_MASTER_TOKEN` no init.
- `src-tauri/src/bin/hub.rs`: `Hub::new(port, db)` recebe o `Arc<Database>`.
- `src-tauri/src/commands.rs`: `generate_company_token` (master-only, retorna
  token forte de 64 hex) e `rotate_master_token`; registrados no invoke_handler.
- `device-agent/src/main.rs`: fallback de `127.0.0.1` → `34.29.70.113` (não cai
  mais no localhost onde nunca acha o hub).
- `cargo check --lib`, `--bin esfera-hub`, `--bin esfera_v3` e `device-agent`:
  TODOS 0 erros.

ATENÇÃO: o PENDENTE.md dizia que este `hub.rs` era "arquivo morto / NÃO
instanciado". ISSO ESTAVA ERRADO — é o binário `esfera-hub` ativo. A vuln estava
ATIVA em runtime, não só em compilação. Agora corrigida.

---

# 18. DEPLOY NA VPS — PROVADO: NÃO FOI FEITO (binário VELHO ainda no ar)

A VPS (34.29.70.113) tem as 4 portas ABERTAS no firewall
(varredura 2026-08-05: :8080/:8888/:7779/:8555 todas abertas), MAS o serviço de
pé é o BINÁRIO ANTIGO. Prova por sonda HTTP no check-in (path real
`/api/devices/check-in`):

- PROBE A — POST sem `companyId` (default 0):
  - Binário NOVO esperado: `400 companyId ausente ou invalido`
  - VPS retornou: `HTTP/1.1 200 OK` body `erro`  ← comportamento do binário VELHO
- PROBE B — POST com `companyId:1`:
  - VPS retornou: `HTTP/1.1 200 OK` body `ok`  (igual novo, não distingue)

Conclusão: o `cargo build --release` do hub-standalone NOVO NÃO foi publicado na
VPS. O isolamento por companyId no check-in (item 16.2.1) NÃO está ativo em
produção. O USUÁRIO ESTÁ DENTRO DA VPS — após o commit, executar:

    cd ~/esfera_v3 && git pull
    cd hub-standalone && cargo build --release -j 1
    sudo systemctl restart esfera-hub
    # conferir: systemctl status esfera-hub
    # re-sondar: POST /api/devices/check-in sem companyId DEVE dar 400

Unit systemd presente: `hub-standalone/esfera-hub.service`.
Só marcar "Correção CONCLUÍDA em produção" após a sonda retornar 400 no PROBE A.

---

# 19. AUDITORIA CODE-VS-DOC (inverdades e imprecisões encontradas 2026-08-05)

## 19.1 INVERDADES / divergências corrigidas neste doc
- Seção 15 dizia "Correção: AINDA NÃO CONCLUÍDA" — correto, mas OMITIA que em
  PRODUÇÃO roda o binário velho. Explicitado na seção 18 (provado por sonda).
- PENDENTE.md dizia que `src-tauri/src/hub.rs` era "arquivo morto / NÃO
  instanciado". ERRADO — é o binário `esfera-hub` ativo (lib.rs:16 + bin/hub.rs:14).
  Corrigido e o gap FECHADO na seção 17.

## 19.2 IMPRECISÕES (não quebram, mas ajustar linguagem)
- 16.2.2: "main.rs substituiu `mark_stale_devices_offline`". Na verdade a função
  AINDA EXISTE em db.rs mas ficou ÓRFÃ (não é chamada). main.rs usa
  `session_manager::live_snapshot()` + `db_mark.sync_live_state(...)`. Ponto central OK.
- 16.2.1: o check-in velho na VPS responde `200 erro` (não `ok`), mas o ponto
  central — NÃO recusava companyId — está correto e comprovado na seção 18.

## 19.3 CLAIMS DA SEÇÃO 16 CONFIRMADAS NO CÓDIGO (todas batem)
- 16.2.1 device-agent envia companyId no handshake TCP/UDP: CONFIRMADO.
- 16.2.1 tunnel_server/presence_server recusam company_id<=0: CONFIRMADO.
- 16.2.2 live_snapshot + sync_live_state protegem canal vivo: CONFIRMADO.
- 16.2.3 handle_vps_command company-scoped: CONFIRMADO.
- 16.2.4 empresa_server com 4 comandos: CONFIRMADO.
- 16.2.5 adb_manager grava company + exige company_id>0: CONFIRMADO.
- Testes hub-standalone: `cargo test` → 5/5 PASSARAM (4 isolation + 1 sim).
- NOVO: hub local reescrito com auth por token + Register amarrado: CONFIRMADO
  (cargo check --bin esfera-hub OK).

---

# 20. O QUE FALTA DE FATO (priorizado)

P0 — CRÍTICO / bloqueia produção:
1. [CONCLUÍDO E VALIDADO EM PRODUÇÃO] Deploy do hub-standalone NOVO na VPS (seção 18).
   - Binário novo publicado e executado via systemd na VPS (34.29.70.113).
   - Probe A (sem companyId) -> HTTP 400 Bad Request ("companyId ausente ou invalido") CONFIRMADO.
   - Probe B (com companyId = 1) -> HTTP 200 OK ("ok") CONFIRMADO.
2. [CONCLUÍDO] hub LOCAL com credencial hardcode — CORRIGIDO (seção 17).

P1 — correção de código:
3. [CONCLUÍDO] device-agent fallback 127.0.0.1 → 34.29.70.113
   (device-agent/src/main.rs).

P2 — validação / operacional:
4. Testes FÍSICOS multi-dispositivo (itens 10/11 do doc). Não executados.
5. [CONCLUÍDO] Geração/distribuição de token por empresa: agora há
   `generate_company_token` (master) + seed master via `HUB_MASTER_TOKEN`.
   Falta expor no frontend (botão de gerar token por empresa) se desejado.
6. Alinhar hub local (tunnel/presence/session_manager) ao modelo VPS quando virar
   cache/proxy de fato (menor prioridade — hub local é fallback).

Regra (seção 12) mantida: build passou ≠ sistema funciona. O deploy (P0-1) foi totalmente verificado via HTTP probe. Os testes físicos com hardware real (P2-4) fecham o ciclo completo de validação.