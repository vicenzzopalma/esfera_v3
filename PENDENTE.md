# PENDENTE.md — Esfera v3 (correções de auditoria de segurança/isolamento)

Documento para outras IAs/subagentes continuarem o trabalho de correção iniciado em
2026-08-04, após a auditoria "reprovado para produção".

## STATUS (2026-08-04, validado por `cargo build` + `cargo test` localmente)
- hub-standalone COMPILA (bin + lib) e `cargo test` PASSA (teste determinístico de
  isolamento A/B/C, reconexão e queda — 1 passed, 0 failed).
- Toolchain usado para validar: Rust stable-x86_64-pc-windows-gnu + MinGW-w64 gcc 13.2
  (em `$HOME/.cargo/bin` e `$HOME/mingw64/bin`).

## O que JÁ FOI FEITO (não repetir)

### hub-standalone (servidor VPS — alvo principal da auditoria)
- `src/db.rs`: `process_checkin`/`insert_unknown_device` AGORA travam `company_id`
  (nunca sobrescrevem via UPSERT; first-seen-wins + validação de empresa existente;
  recusam `company_id <= 0`). `verify_password` NÃO aceita mais plaintext==hash.
  Seeds fracos removidos (admin/gestor/colab). Adicionada tabela `ESF_CompanyToken`,
  `validate_token`, `upsert_company_token`, e seed do token master (CompanyId=0) via
  env `HUB_MASTER_TOKEN` (fallback token forte, trocar em produção).
- `src/protocol.rs`: `HubMessage::Auth` agora é `{ token, role }` (sem credencial global).
- `src/hub.rs`: auth company-scoped por token; `Register` amarrado à sessão autenticada
  (empresa não pode registrar company_id alheio); só master despacha comandos.
- `src/main.rs`: usa a lib; `Hub::new(port, db)`.
- `src/lib.rs`: criado (pub mod para todos os módulos) para testes de integração.
- `tests/sim.rs`: REESCRITO determinístico — portas únicas por execução, espera ACK
  real, desconecta via drop de socket real (sem `forget` interno), polling de convergência.

### src-tauri (desktop)
- `src/protocol.rs`: `Auth { token, role }` (sem consts de credencial).
- `src/master_client.rs`: envia token de env `ESFERA_HUB_TOKEN`/`HUB_MASTER_TOKEN`.
- `src/hub_client.rs`: (empresa) envia token de env.
- `src/db.rs`: `verify_password` sem fallback; seeds fracos removidos; adicionado
  `user_company_id`.
- `src/commands.rs`: `validate_session` NÃO tem mais fallback que vira master/gestor;
  `get/update_user_permission` e `get/update_sector_permission` checam isolamento por
  `company_id` do caller vs alvo.

### Frontend (src/)
- `pages/AutomationsTab.tsx`: `toggleActive` não engole erro (reverte em falha, propaga);
  usa valor do servidor (`currentActive`), não o optimistic.
- `pages/CampaignsTab.tsx`: `sanitizePhoneNumber` corrigido — não inventa DDD 11;
  prefixa +55 apenas quando há DDD (10-11 dígitos); respeita DDI já presente.

## PENDENTE (delegável / grande)

### 1b. src-tauri/src/hub.rs (HUB LOCAL LEGADO) — PENDENTE (delegável)
Arquivo morto (NÃO é instanciado em lib.rs; só `empresa_server`, `master_client`,
`hub_client` são usados). Ainda define seu PRÓPRIO `HubMessage` (linha ~219) com
`Auth { username, password, role }` e usa `const AUTH_MASTER_USER="master"` /
`const AUTH_MASTER_PASS="admin123"` (linhas ~239-240). O `Auth` aceita master OU empresa
com a MESMA credencial global (vulnerabilidade igual à do hub-standalone).
CORRIGIR: remover a definição local de `HubMessage` e usar `crate::protocol::HubMessage`;
remover as consts; validar por token (precisa receber `Arc<Database>` em `Hub::new`/
`start` para chamar `db.validate_token` — adicionar `validate_token` ao db.rs do src-tauri
se ainda não existir, espelando o do hub-standalone); `Register` amarrado à sessão.
ATENÇÃO: o `HubMessage` local usa `Command { to_company: i32 }` enquanto o protocol.rs usa
`Option<i32>` — ajustar o match. Como não é instanciado, o risco é baixo, mas deve compilar.

### 2. COMPILAR E RODAR TESTES DO hub-standalone — CONCLUÍDO (2026-08-04)
`cargo build` e `cargo test` passam localmente (toolchain gnu + MinGW em `$HOME/.cargo`
e `$HOME/mingw64`). Também corrigido `presence_server.rs`: removido `ConnectInfo`
(quebrava o upgrade WS sem `into_make_service_with_connect_info` — bug citado na
auditoria). Build de produção na VPS: `cargo build --release -j 1` (ver item 5).

### 3. COMPILAR src-tauri (desktop) — NÃO roda neste ambiente (precisa GUI/webview)
Não é possível compilar o binário Tauri aqui (exige toolkit de GUI). Rodar no ambiente
desktop do dono:
  npm install && npm run tauri build   (ou cargo build na pasta src-tauri)
Validar que as mudanças de protocolo (Auth{token}) não quebraram o build do desktop.
O `MasterClient` e `HubClient` agora exigem `ESFERA_HUB_TOKEN` no ambiente para conectar
ao hub-standalone. Documentar isso para o dono configurar.

### 4. device-agent (Rust /data/adb/earlypoint) — NÃO lido ainda
Auditoria apontou que o handshake do device-agent envia `companyId`. Verificar se:
- o `companyId` vem de config confiável (não do celular arbitrariamente);
- o agente respeita isolamento (não aceita company_id de outro);
- o handshake bate com `tunnel_server.rs` do hub-standalone (que espera
  `hardwareUuid`, `companyId`, etc.).
Repositório: `src-agent/` ou `device-agent/` — localizar e auditar.

### 5. Deploy na VPS + atualizar HERMES_CONTEXT.md — MÉDIO
A VPS (34.29.70.113) roda binário ANTIGO (portas :8080 e :8888 abertas; :7779 e :8555
fechadas — verificado por varredura em 2026-08-04). Após `cargo build --release` do
hub-standalone, fazer deploy:
  ssh vicenzzoconstantine@34.29.70.113
  cd ~/esfera_v3 && git pull
  cd hub-standalone && cargo build --release -j 1
  sudo systemctl restart esfera-hub
Conferir `systemctl status esfera-hub` e varredura de portas (:8080/:8888/:7779/:8555
todas abertas). Depois atualizar HERMES_CONTEXT.md: marcar "Correção" como CONCLUÍDA no
código; manter "Testes físicos multi-dispositivo: NÃO CONFIRMADOS" até validar com celulares.

### 6. Tokens de empresa na prática
O hub-standalone valida token de empresa contra `ESF_CompanyToken`. Falta um fluxo para
GERAR/distribuir o token de cada empresa (o master cria via `upsert_company_token`).
Adicionar um comando/endpoint protegido por master para gerar token de empresa, e o
`hub_client`/`device-agent` da empresa consumirem esse token (hoje lê de env).

## Decisões de segurança já tomadas (não reverter sem autorização)
- Auth do hub: token por empresa no DB; master = CompanyId 0; SEM credencial global em código.
- Senhas: apenas hash SHA-256 (salt fixo em código); sem fallback plaintext==hash; seeds
  fracos removidos.
- Isolamento: company_id fixo no check-in (first-seen-wins); Register amarrado à sessão;
  permissões checam company_id do caller.
- Frontend: erros de rede NÃO são engolidos (reverte optimistic + propaga).
