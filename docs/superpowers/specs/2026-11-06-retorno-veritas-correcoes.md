# Retorno do disparo pelo VERITAS — correções e plano (06/11/2026)

Revisão da implementação do Codex ("hierarquia do retorno") e plano para publicar hoje.
Repositórios: `D:\Novo\Esfera v3` (Esfera + hub) e `E:\PAFIXA-ATENDIMENTO` (robô da VPS).

## Por quê

O dono quer que o retorno dos números de disparo (SAIR descadastra + confirma; demais respostas vão para a
Marcela) funcione pelo WhatsApp que já está conectado no VERITAS, sem QR na Evolution. E com hierarquia:
o VERITAS tem ~55 números conectados (atendentes e reservas); o fluxo só pode rodar nos números que fazem
disparo pelo Esfera, nunca nos números dos atendentes.

## Decisões do dono (06/11)

1. **SAIR vale sempre**; **repasse à Marcela vale até 30 dias** depois do envio.
2. **Seletor na campanha**: Desativado / **Todos os aparelhos da campanha** / **um número específico**.
3. **Envios antigos entram**, usando o número do chip do aparelho que fez o envio.
4. **Token do VERITAS**: o robô lê o "API Token" das configurações do VERITAS (só leitura); nenhum token de
   usuário fica no ambiente do robô. O API Token foi criado no VERITAS com backup (ver "Token do VERITAS").

## Achados da revisão (o que muda em relação ao Codex)

| # | Problema | Correção |
|---|----------|----------|
| 1 | Token configurado era de sessão de usuário; a rota `/api/messages/send` só aceita o `userApiToken` das configurações → envio recusado | Robô lê `userApiToken` do banco do VERITAS (modo leitura); `VERITAS_API_TOKEN` sai do ambiente |
| 2 | VERITAS guarda os números **sem o 9** (12 dígitos); comparação exata → número nunca encontrado | Comparar origem com e sem o 9 em todo lugar que casa número de disparo |
| 3 | Só 1 de 13 aparelhos tem número no chip; envios antigos não contam; hub novo apaga a lista atual | Regras de origem abaixo + hub guarda a lista antiga + ordem de publicação |
| 4 | Autorização começa no fim da digitação → resposta à saudação é descartada para sempre | `enviado_em` = início do envio; folga de 15 min no robô |
| 5 | Esfera novo + hub antigo → lista de devedores vazia | Esfera continua mandando `telefones` (lista antiga completa) junto do v2 |
| 6 | Janela de 48 h para tudo | SAIR sem prazo; repasse 30 dias (decisão 1) |
| 7 | Um número por campanha | Modos da decisão 2 |
| 8 | Compose monta `/opt/esfera-hub/devedores` (vazio fora do hub; o arquivo real é `/opt/pafixa/data/esfera/devedores.json`) | Desfazer a montagem; robô lê o padrão `/data/esfera/devedores.json` |
| 9 | Trava global `DISPARO_EMPRESA_ID` desliga o caminho da Evolution (o 9627 não está no VERITAS) | Tirar a trava do caminho da Evolution; ele segue como hoje |
| 10 | Hub recusa o snapshot inteiro se o relógio do PC estiver >2 min adiantado | Ajustar o horário para "agora" em vez de recusar |

Fica do Codex: colunas novas em `ESF_ChipAttempt`, contrato v2 com `vinculos`, isolamento por empresa no hub,
trava/escrita atômica, robô "na dúvida não age", testes já escritos (ajustados às regras novas).

## Regras

**Campanha** — `ESF_Campaign.ReturnNumber`: `''` desativado · `'*'` todos os aparelhos da campanha ·
`'55…'` número específico (número do chip de um aparelho selecionado; comparação com/sem 9).

**Vínculo** (contato autorizado) — para cada contato enviado (`ESF_Contact` com `SentAt` e status
`sent|replied|partial`) de campanha não excluída com retorno ligado:
- origem = `SourceNumber` da tentativa (`ESF_ChipAttempt`, mesma campanha e mesmo telefone, `Outcome='enviado'`)
  → senão o número atual do chip dessa tentativa → senão, se a campanha tem exatamente 1 aparelho
  selecionado, o número do chip dele → senão, sem vínculo (`ESF_Contact.DeviceId` está vazio, não serve);
- modo `'*'`: qualquer origem conhecida; modo número: só se origem = número escolhido (com/sem 9);
- `enviado_em` = `CreatedAt` da tentativa (início do envio) ou `SentAt` se não houver tentativa;
- sem prazo no Esfera; no máximo 50.000 vínculos (os mais recentes).

**Robô** (empresa `DISPARO_EMPRESA_ID`, caminho VERITAS):
- só lê conexões `CONNECTED` cujo número bate (com/sem 9) com a origem de algum vínculo;
- mensagem do telefone P no número N vale se houver vínculo (N, P) com `enviado_em ≤ quando + 15 min`;
- **SAIR**: qualquer idade do vínculo → registra, confirma 1x pela mesma conexão, avisa o Esfera;
- **repasse**: só se `quando − enviado_em ≤ 30 dias` (vínculo mais recente); senão status `FORA_DO_PRAZO`;
- token = `Settings.userApiToken` lido do banco do VERITAS a cada ciclo; sem token → não envia, deixa pendente;
- caminho da Evolution (9627) continua igual, sem trava por empresa.

**Hub** — aceita o formato antigo (`{"telefones":[…]}`: atualiza só a lista antiga) e o v2 (lista antiga +
`vinculos` mesclados por empresa, sem prazo); horário futuro vira "agora".

## Contrato (Esfera → hub → arquivo lido pelo robô)

```json
{"schema": 2, "empresas": [1], "atualizado_em": 1793990000,
 "telefones": ["5547999998888"],
 "vinculos": [{"empresa_id": 1, "campanha_id": 16, "numero_disparo": "5547996834632",
               "telefone": "5575988052539", "enviado_em": 1793980000}]}
```
`telefones` = lista antiga completa (todos os contatos já disparados, como antes de hoje), usada pelo caminho
da Evolution. `vinculos` = só campanhas com retorno ligado.

## Fora do escopo

Mudar código ou infraestrutura do VERITAS; desligar os fluxos da Evolution no n8n (fica para quando o 9627
estiver no VERITAS); confirmação em dobro (celular + robô) quando os dois pegam o mesmo SAIR (acompanhar).

## Abordagens consideradas

- **A (escolhida)**: corrigir o desenho do Codex (vínculo número + contato) com as decisões acima. Mantém o
  "número direcionado", que exige saber qual celular enviou.
- B: duas listas soltas (números de retorno + contatos disparados). Mais simples, mas não atende o modo
  "número específico".
- C: não enviar pelo VERITAS (confirmação pelo próprio celular via Esfera; repasse pela Evolution 9627). Não
  toca no VERITAS, mas mantém a dependência da Evolution. Fica como plano B se o token não puder ser criado.

## Token do VERITAS

O VERITAS não tinha `userApiToken` (a tela de Configurações só mostra; a API só atualiza o que existe). Para
enviar pelo VERITAS foi criada essa linha na tabela `Settings` — o mesmo que o seed oficial dele
(`20200904070006-create-apiToken-settings`) faz —, com backup do banco antes (aprovado pelo dono em 06/11).

## Plano

Trabalhadores: terminais do Codex, um por repositório/arquivo, sem dois no mesmo arquivo. Rust só com
`CARGO_BUILD_JOBS=1` e `-j 1`, **um cargo por vez na máquina** (conferir `cargo.exe`/`rustc.exe` antes). Sem
pastas novas, sem dividir arquivos, sem publicar, sem tocar no VERITAS. Commit em pt-BR com
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Tarefa 1 — Esfera (Codex A): `src-tauri/src/db.rs`, `src-tauri/src/konfiansa_history.rs`, `src/pages/CampaignsTab.tsx`
- `validate_campaign_return_number`: aceita `''`, `'*'` (exige ≥1 aparelho selecionado) e número
  (com/sem 9 contra os chips dos aparelhos selecionados da empresa).
- `veritas_dispatch_snapshot()`: regras de "Vínculo" acima; `telefones` vazio aqui.
- `publish_dispatched`: preenche `telefones` com `dispatched_phone_list(dispatched_contacts())` (lista antiga);
  em resposta não-2xx, registra o campo `erro` do hub (até 200 caracteres).
- Seletor: opções Desativado / "Todos os aparelhos desta campanha" / números; aviso listando aparelhos
  selecionados sem número de chip ("cadastre o número do chip para ter retorno"); revisão mostra o modo.
- Testes (em `db.rs`): `'*'` gera vínculo para os 2 aparelhos; número específico filtra (com/sem 9); origem por
  `SourceNumber`, pelo chip da tentativa e pela campanha de 1 aparelho; sem origem → sem vínculo; envio de 60
  dias continua exportado; `enviado_em` = `CreatedAt` da tentativa; campanha excluída/retorno desligado → nada.
- Verificar: `cargo test --lib -j 1` em `src-tauri` (todos verdes) e `npx tsc --noEmit`.

### Tarefa 2 — Hub (Codex B): `hub-standalone/src/evolution_relay.rs`
- Formato antigo aceito (só atualiza `telefones`, preserva `vinculos`/`empresas`); v2 guarda `telefones`
  normalizados do corpo (10–13 dígitos, como o `normalize_devedores` antigo) + `vinculos` mesclados.
- Remove `DEVEDORES_WINDOW`; `enviado_em > agora+120` vira `agora`.
- Testes: legado não apaga vínculos; v2 guarda lista antiga; vínculo de 60 dias preservado; horário futuro
  ajustado. Verificar: `cargo test --lib -j 1` em `hub-standalone`.

### Tarefa 3 — Robô (Codex C): `bot/optout.py`, `bot/servico.py`, `infra/vps/veritas_reconciliar_disparo.py`, `infra/vps/docker-compose.yml`, `test_veritas_reconciliar_disparo.py`, `bot/test_optout.py`
- `conexoes_disparo`: casa com `variantes()` (com/sem 9).
- `carregar_vinculos`: sem janela de 48 h; linha inválida é pulada (não zera tudo); horário futuro → agora.
- `vinculo_retorno(…, folga_s=900)`; repasse filtra `quando − enviado_em ≤ 30 dias` → senão `FORA_DO_PRAZO`.
- `processar_optout`: SAIR com vínculo de qualquer idade; tira a trava global do caminho não-VERITAS.
- `proximo_encaminhamento_disparo`: tira a trava global do caminho não-VERITAS.
- `enviar_veritas`: token = `Settings.userApiToken` lido de `VERITAS_DB` (modo leitura), nunca impresso.
- Compose: desfaz a montagem `/opt/esfera-hub/devedores:/esfera` e o `ESFERA_DEVEDORES_ARQUIVO` override.
- Não tocar em `bot/ponte_adb.py` nem `bot/test_ponte_adb.py` (outro trabalho em andamento).
- Verificar: a bateria completa do `RELATORIO_DISPARO_VERITAS.md` (todos os módulos), tudo verde.

### Tarefa 4 — Coordenação (Claude)
1. Revisar os 3 diffs contra este documento; rodar os testes de novo, um cargo por vez.
2. Hub na VPS: baixar `evolution_relay.rs`/`tls_server.rs` da VPS, aplicar só estas mudanças (fontes da VPS
   diferem do repositório), backup, compilar lá, trocar binário, reiniciar, conferir que o Esfera atual
   (formato antigo) continua gravando.
3. Esfera: `npm run tauri build` (oficial, sem `--target`); apagar o .exe antigo do Codex em
   `target/x86_64-pc-windows-msvc`; fechar e reabrir o Esfera (campanhas pausadas); conferir v2 no hub.
4. Dono: cadastrar o número do chip nos aparelhos que disparam e ligar o retorno nas campanhas.
5. Se aprovado: backup do banco do VERITAS e criar `userApiToken` (seed oficial).
6. Robô: backup, publicar arquivos da Tarefa 3, `.env` sem `VERITAS_API_TOKEN`, `docker compose up -d bot
   conferencia_veritas`, conferir logs.
7. Teste real só com 75988052539: SAIR → confirmação chega ao 75988052539 e o Esfera descadastra. Repasse:
   conferir a fila (sem mandar teste para a Marcela).
8. Commits (Esfera: sem BRIEF_*.md e logs; push do ramo) e commit local no PA FIXA; `subst Q: /d`.
