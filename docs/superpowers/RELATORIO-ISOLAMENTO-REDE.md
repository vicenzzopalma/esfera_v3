# Isolamento e auditoria de rede por aparelho — relatório

Data: 2026-11-03 · Esfera v3

## O que foi implementado

### 1. Isolamento por aparelho (WireGuard always-on prioritário)

- Três modos no perfil por aparelho: `direto` (fila compartilhada, comportamento
  antigo), `wireguard` (VPN always-on com lockdown) e `socks5` (alternativa).
- `wireguard` aplica via ADB `always_on_vpn_app` + `always_on_vpn_lockdown`, e
  tenta subir o túnel pelo intent de controle remoto do app WireGuard. Depois
  **lê de volta** os dois ajustes: se o Android não aceitou, devolve erro em vez
  de reportar sucesso (`adb_manager.rs: apply_device_route`).
- `socks5` grava só o proxy global e **nunca** é tratado como prova de rota:
  `NetworkProfile::captures_all_traffic()` é verdadeiro apenas no modo VPN.
- Perfil persistido em `ESF_NetworkProfile`, uma linha por aparelho, com
  `VpnPackage`, `VpnTunnel`, `Lockdown`, IPs autorizados e tamanho do lote.
  Colunas novas entram por `ALTER TABLE` idempotente: bancos existentes migram
  sem perder nada.
- Compatibilidade preservada: aparelho sem linha na tabela é `direto` e continua
  no portão global do dispatcher. O caminho ADB existente (túnel nativo para
  seriais `esfera-agent`, binário `adb` para os demais) é o mesmo.
- Aparelho isolado recebe portão de envio próprio (`network_manager::gate_for`),
  então não espera a fila conservadora dos outros.

### 2. Auditoria a cada 10 envios confirmados

- Lote padrão = **10** (`db::DEFAULT_BATCH_SIZE`). Não havia 30 no código: o
  valor já era 10 desde a primeira versão; o constante agora é explícito e
  coberto por teste.
- Conta **apenas** `ESF_ChipAttempt.Outcome='enviado'`, que é o estado gravado
  quando o envio foi confirmado pelo aparelho. Tentativas iniciadas e falhas
  entram no balanço do lote como `uncertain`/`failed`, nunca na contagem.
- A verificação cobre os três itens pedidos, nesta ordem (`classify_egress`):
  1. **IP público** lido de dentro do aparelho; sem IP, veredito `falha_probe`;
  2. **integridade da conexão/rota**: no modo VPN, o app always-on exigido tem de
     ser o do perfil e o lockdown tem de estar ligado;
  3. **disponibilidade/divergência**: o IP observado tem de estar na lista de
     autorizados.
- Roda em duas fases, ambas registradas em `ESF_EgressCheck.Phase`: `fim_lote`
  (fechamento) e `pre_lote` (antes de liberar o lote seguinte, no dispatcher).
  Verificação aprovada vale 15 min (`CHECK_FRESHNESS_SECS`), para não disparar
  uma sonda ADB a cada envio.
- Vazamento, divergência ou falta de prova pausam **somente o aparelho afetado**
  (`ESF_NetworkProfile.Status='pausado_vazamento'`). O dispatcher o tira da
  rodada; campanhas e os demais aparelhos seguem.
- **Rotação compulsória de IP foi removida**, conforme o spec. O código anterior
  trocava de proxy a cada lote e pausava se o IP não mudasse.

### 3. Endpoint e segurança

- Consulta de IP feita **do próprio aparelho** contra fontes externas e
  independentes: `api.ipify.org`, `ifconfig.me/ip`, `icanhazip.com`, via
  `toybox wget` com `curl` como reserva. GET sem parâmetros: nenhum telefone,
  contato, credencial ou dado de devedor sai nessas consultas.
- O hub VPS deixou de ser fonte de IP (atrás da VPN ele veria o endereço interno
  do túnel) e passou a ser o **registro central**: `POST /api/egress/report`
  (HTTP e TLS), autenticado por `X-Hub-Token`, grava em `ESF_EgressCheck` no hub
  apenas aparelho, instante, IP de saída, modo, fase, veredito e detalhe.
- O desktop enfileira e reenvia: `ESF_EgressCheck.Reported` marca o que já subiu;
  hub fora do ar não perde registro nem trava envio.
- `GET /api/egress` continua no hub, agora só como diagnóstico.
- Nada presume IPs distintos na mesma VPS — ver limitações.

### 4. Preservação e qualidade

- `ESF_SentHistory` e a anti-duplicação **não foram tocados**. A tabela é
  `(Phone, CampaignId)` e não tem aparelho, por isso não serve de contador de
  lote por dispositivo; a contagem vem de `ESF_ChipAttempt`, que tem o vínculo
  com o chip e o aparelho. O dedup segue exatamente como estava.
- Filas, tetos horários/diários (`ESF_NetworkLimits`), cooldown de chip, freio
  por respostas e opt-out continuam intactos: o gerenciador de rede só adiciona
  uma trava, nunca remove uma existente.
- Lotes persistidos em `ESF_SendBatch` com marca de corte (`StartAttemptId`). O
  progresso é derivado das tentativas já gravadas, então **restart não duplica
  nem perde contagem** — coberto por teste.
- Logs por aparelho em `queue_add_log` com categoria `network` / `network_leak`,
  além do histórico em `ESF_EgressCheck` visível na tela.

### Correção de bug crítico encontrada no caminho

`db.rs: open_send_batch` tinha **deadlock**: o `ConnGuard` do `if let` seguia
vivo no corpo e `get_network_profile` reentrava no mesmo `Mutex` não reentrante.
Dispararia no segundo envio confirmado de cada lote e **congelaria o acesso ao
banco de todo o programa**, não só o aparelho. O processo de teste pendurado por
1h45 era exatamente isso. Corrigido lendo o perfil antes da consulta.

## O que não é possível garantir

1. **IP distinto por aparelho não existe nesta arquitetura.** Com um hub VPS e um
   IP público, todos os aparelhos saem pelo mesmo endereço. Peer por aparelho dá
   rota verificável e pausa individual, não IP próprio. IP distinto exige IPs
   adicionais reais (SNAT por peer), links separados ou hosts separados — todos
   pagos. Nenhuma ferramenta open source cria endereço público.
2. **O always-on pode não ser aceito por ADB.** Em Android recente,
   `always_on_vpn_app` sem device owner costuma exigir consentimento da VPN no
   próprio aparelho. O código detecta isso lendo de volta e falha explicitamente;
   não há como garantir a aplicação 100% remota sem `dpm set-device-owner`.
3. **Subir o túnel depende do app.** O intent `SET_TUNNEL_UP` só funciona com
   "Allow remote control apps" ligado no WireGuard. Sem isso, o túnel precisa ser
   ligado uma vez no aparelho; o lockdown mantém depois.
4. **Modo `socks5` não controla o WhatsApp.** Ele ignora proxy de sistema. O modo
   existe como alternativa onde o app respeita o proxy, e a UI diz isso.
5. **A sonda prova a rota do aparelho, não a do WhatsApp em si.** `wget`/`curl`
   saem pela mesma interface que o resto do sistema quando a VPN está em lockdown
   — é por isso que o lockdown é exigido para o veredito valer. Sem lockdown, o
   veredito `ok` não garante que o tráfego do app seguiu o mesmo caminho.
6. **Fontes externas de IP são terceiros.** Se os três endpoints estiverem fora
   ou bloqueados, o veredito é `falha_probe` e o aparelho isolado para (falha
   fechada). É a escolha segura, mas significa que indisponibilidade de terceiro
   pode parar envio.
7. **Trocar IP não evita bloqueio de conta.** O WhatsApp avalia comportamento do
   número (ritmo, proporção de contatos novos, denúncias, respostas). Nada aqui
   foi construído para contornar antispam, e a auditoria não deve ser lida como
   proteção contra ban.

## Testes

Suíte em `network_manager.rs` (banco temporário + sonda injetada, sem ADB real):

- isolamento: portão dedicado vs. compartilhado; `socks5` nunca conta como prova
- divergência de IP: fecha lote, pausa só o aparelho afetado
- perda de conectividade: isolado pausa (falha fechada), `direto` só registra
- rota indisponível: VPN ausente ou lockdown desligado reprovam mesmo com IP certo
- restart: lote recomposto das tentativas persistidas, sem duplicar nem perder
- portão pré-lote: barra o aparelho sem rota, libera o verificado, abre o lote
- lote padrão de 10 confirmados

No hub: `report_exige_token_e_grava_o_veredito` — endpoint recusa token errado e
aparelho inválido, grava só o que foi autenticado; e o já existente
`egress_devolve_o_ip_da_conexao`.

### Resultado da execução (2026-11-03)

```
src-tauri : cargo test --lib          → 190 passed; 0 failed; 2 ignored
            (network_manager: 17/17)
hub       : cargo test                → 3 + 4 + 1 passed; 0 failed
frontend  : npx tsc --noEmit          → sem erros
```

Duas correções que a rodada obrigou:

1. **Erro de contagem no lote** (encontrado pelos 4 testes que falharam na
   primeira rodada): o lote era criado na borda, *depois* de um envio confirmado,
   com a marca de corte no maior `AttemptId` do momento — então o envio que
   abriu o lote ficava fora dele e o primeiro lote de cada aparelho exigiria 11
   confirmações em vez de 10. Agora quem abre o lote é o portão pré-lote, antes
   do envio; a borda apenas fecha (`run_batch_boundary` nunca cria).
2. **`hub-standalone/tests/isolation.rs` não compilava** desde um commit anterior
   (`process_checkin` ganhou um 7º parâmetro e `LiveDeviceState` o campo
   `assigned_vps_port`). Sem isso a suíte do hub não rodava. Corrigido com o
   parâmetro e o campo faltantes — nenhuma asserção foi alterada.

### Como rodar

O diretório de build padrão estava travado por um processo de teste pendurado
(consequência do deadlock acima). A suíte foi executada com diretório de saída
alternativo:

```
cd src-tauri
CARGO_TARGET_DIR=<dir temporário> cargo test --lib
```

Com o processo encerrado, `cargo test --lib` no diretório normal basta.
