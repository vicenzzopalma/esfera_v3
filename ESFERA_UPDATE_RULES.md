# ESFERA v3 — Regras de Atualização (de fora pra dentro, sem SSH)

Documento canônico para qualquer IA/operador que for atualizar o sistema em
produção. O princípio é: **o VPS é a fonte de verdade**; o desktop é cliente;
o agente no celular é "fonte de verdade" do hardware. Ninguém atualiza celular
por SSH/adbal manual na operação.

## 1. Atualizar o AGENTE do celular (APK) — 100% remoto, sem SSH

Canal: `remote_update_agent(esfera_device_id, apk_url, company_id)` no desktop
→ VPS (`send_device_command`) → túnel → agente Kotlin (`self_update <url>`).

O agente baixa de `http://<VPS>:8080/download/agent.apk` e instala com
`pm install -r` (assinado com o mesmo keystore).

### Passo a passo (você faz na VPS):
1. Buildar o APK no PC de dev:
   ```
   cd src-agent && cmd.exe /c runbuild.bat && cmd.exe /c sign_apk.bat
   ```
   Resultado: `src-agent/app/build/outputs/apk/release/app-release-signed.apk`
2. Subir o APK pra VPS (o endpoint serve de `~/esfera_v3/agent_release/`):
   ```
   # No PC de dev, copia pro VPS (ex: scp / rsync / drag no terminal):
   scp src-agent/app/build/outputs/apk/release/app-release-signed.apk \
       usuario@34.29.70.113:~/esfera_v3/agent_release/esfera_agent.apk
   # (ou define AGENT_APK_PATH no env da VPS para outro caminho)
   ```
3. No app desktop (operador): botão/Comando `remote_update_agent` com
   `apk_url = http://34.29.70.113:8080/download/agent.apk` e o
   `esfera_device_id` do celular (ex: `ESF-00829256`).
   → O celular baixa e instala sozinho. Sem cabo, sem SSH.

## 2. Atualizar o DESKTOP (exe) — distribuição para operação

1. Build correto (NUNCA `cargo build` solto — não empacota o frontend):
   ```
   npm run tauri build
   ```
   Resultado: `src-tauri/target/release/esfera_v3.exe` + `resources/dist/`.
   (Portable sem UAC: `tauri.conf.json` `bundle.targets: []`.)
2. Distribui o `esfera_v3.exe` + pasta `resources/` para os PCs da operação.

## 3. Atualizar o VPS (hub-standalone)

1. Editar `hub-standalone/src/*.rs`.
2. `cd hub-standalone && cargo build --release`.
3. Na VPS: parar o hub atual, substituir o binário, relançar com o
   `HUB_MASTER_TOKEN` correto (o default é REJEITADO). Ex:
   ```
   HUB_MASTER_TOKEN=<token_real> ./hub-standalone
   ```
4. Endpoint de APK já existe: `GET /download/agent.apk` (serve
   `~/esfera_v3/agent_release/esfera_agent.apk`). Para trocar a versão do
   agente, só substituir esse arquivo (passo 2 da seção 1).

## 4. REGRAS DE OURO (não violar)

- **Servidor = fonte de verdade.** PC local do operador NUNCA grava "verdade"
  (foi removido o `get_devices_dump.json` de `%APPDATA%`). `esfera_device_id`
  vem do VPS/agente, NUNCA gerado localmente (`ESF-<uuid>` proibido em
  devices ADB-locais — eles usam `esfera_device_id: None`).
- **Build desktop = `npm run tauri build`** sempre. `cargo build` solto gera
  exe que falha com `ERR_CONNECTION_REFUSED` (sem frontend).
- **Token do hub:** o app desktop usa `config.hub_token` (Configurações → Hub).
  Se vazio, cai no default que a VPS REJEITA. Sempre preencher o token real.
- **Device IDs fixos:** moto g22 = `ESF-00829256`; Samsung = `ESF-4200DA85`.
  Nunca dois celulares no mesmo `esferaDeviceId`.
- **Imunidade de background** já está em `adb_manager.rs start_agent_service`
  e no agente (JobScheduler/KeepAlive/START_STICKY). Não reimplementar.
- **Não apagar código existente** — estender com consistência.

## 5. Diagnóstico rápido (PC de dev, ADB)

- Celular some / agente morreu → `scripts/setup_esfera_device.bat <serial>`
  (imunidade + chave ADB + captive + agente).
- Agente vivo? `adb -s <serial> shell ps -A | grep esfera.agent`.
- VPS live devices (precisa do token certo): socket `34.29.70.113:8555`
  com auth master + `get_live_devices`.
- Skill de referência: `esfera-device-setup`.

## 6. Fluxo "de fora pra dentro" resumido

```
Dev PC ─build─> APK assinado ─upload─> VPS:~/esfera_v3/agent_release/
                                               │
App desktop ─remote_update_agent─> VPS ─túnel─> Celular:self_update ─pm install─> atualizado
```
Nenhum passo exige SSH ou cabo no celular da operação.
