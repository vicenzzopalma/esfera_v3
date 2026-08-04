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