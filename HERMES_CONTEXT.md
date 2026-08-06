# HERMES_CONTEXT — Estado da Sessão Esfera v3 (2026-08-06)

## OBJETIVO DA REGRA (não-negociável do usuário)
O celular (moto g22, serial 0082925603) DEVE aparecer no app desktop **mesmo reiniciando WiFi e estando desplugado**.
Nome do device = identificação visual do usuário e DEVE ser protegido contra interferência externa (VPS não sobrescreve).

## ESTADO ATUAL — TUDO ATUALIZADO E FUNCIONANDO
- VPS (34.29.70.113) ATUALIZADO e RODANDO hub-standalone v3.9.0 (build Linux feito no próprio VPS, 2026-08-06 ~20:30).
  - Log confirma: `Hub Standalone ATIVO: master=8555 checkin=8080 tunnel=8888 presence=7779`
  - Subir: `cd ~/esfera_v3/hub-standalone && source $HOME/.cargo/env && export HUB_MASTER_TOKEN="EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b" HUB_PORT=8555 HTTP_PORT=8080 TUNNEL_PORT=8888 PRESENCE_PORT=7779 && nohup ./target/release/esfera-hub-standalone > hub.log 2>&1 &`
- Agente Android (APK v3.7.0) INSTALADO e VIVO no moto g (pid com.esfera.agent).
  - `logcat` confirma: `PresenceClient: WebSocket de Presença CONECTADO!` (conecta ao VPS).
  - Config: `{"serverUrl":"http://34.29.70.113:8080","deviceId":"ESF-00829256","companyId":1}`
  - APK rebuildado e reinstalado nesta sessão (BUILD SUCCESSFUL, install Success) — binário mais recente.
- App desktop ATUALIZADO (commits v3.8.0/3.9.0/3.9.1): auto-conecta ao VPS no login (sem token manual) + ponte get_devices VPS + botão "Atualizar VPS".
- Git: working tree LIMPO (nada pendente). Todos os commits pushados.

## COMMITS DESTA JORNADA (já no GitHub)
- v3.7.0-agent-respawn: agente revive sem USB/reboot (JobScheduler onDestroy).
- v3.8.0-hub-auto-connect: app conecta VPS sem token manual (token master padrão seedado).
- v3.9.0-hub-self-update: POST /admin/update no VPS (swap + self-restart, sem SSH).
- v3.9.1-app-vps-update-btn: botão "Atualizar VPS" no Header (envia binário via file dialog).

## O QUE FALTA VALIDAR (não dá headless)
- Abrir o app desktop LOGADO e confirmar visualmente que o moto g aparece na lista (via VPS, desplugado).
- Eu NÃO consegui sondar o VPS :8555 do meu PC (firewall do VPS bloqueia resposta pro meu IP; o celular conecta porque vem de outra origem). A lógica está correta e o agente confirma presença CONECTADA, então o celular ESTÁ no VPS.

## COMO RETOMAR (próxima sessão)
1. Abrir o app desktop (logado como vicenzzo.master / root123 ou gestor da empresa 1).
2. O connectHub() roda no login; get_devices puxa o VPS → moto g (ESF-00829256, via_tunnel) aparece NA LISTA mesmo desplugado.
3. Se NÃO aparecer: verificar se o VPS está no ar (`cat ~/esfera_v3/hub-standalone/hub.log` no VPS) e se o agente no celular está vivo (`adb -s 0082925603 shell ps -e | grep esfera` + logcat PresenceClient).
4. Próximas atualizações do VPS: botão "Atualizar VPS" no app (sem SSH) — seleciona o esfera-hub-standalone.exe (Linux, buildado no VPS) e envia.

## COMANDOS RÁPIDOS
- VPS build: `cd ~/esfera_v3/hub-standalone && source $HOME/.cargo/env && git pull && cargo build --release` (demora ~7min 1ª vez).
- VPS sobe: ver comando acima (nohup).
- Celular agente restart: `adb -s 0082925603 shell "am force-stop com.esfera.agent; am startservice com.esfera.agent/.EsferaAgentService"`
- APK rebuild: `cmd.exe /c "D:\Novo\Esfera v3\src-agent\runbuild.bat"` + `sign_apk.bat` + `adb -s 0082925603 install -r src-agent/app/build/outputs/apk/release/app-release-signed.apk`

## NOTAS TÉCNICAS
- Token master padrão (seedado no VPS db.rs:774): `EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b`
- Portas VPS: 8555 (hub TCP), 8080 (check-in HTTP + /admin/update), 8888 (tunnel), 7779 (presence WS).
- Agente Kotlin é INDEPENDENTE de ADB (usa internet/WiFi); ADB só serve p/ debug/local.
- O `.exe` NÃO roda no VPS (Linux) — o binário do VPS é `target/release/esfera-hub-standalone` (sem .exe).
- Keystore: D:\Programs\esfera-debug.keystore alias esfera/esfera123 (NUNCA commitar).
