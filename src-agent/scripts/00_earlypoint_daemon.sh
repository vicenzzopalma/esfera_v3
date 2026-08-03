#!/system/bin/sh
# ============================================================
# Esfera v3 — Daemon de boot (Magisk service.d / earlymount)
# 1) Mantém o ADB Wi-Fi (5555) sempre ativo
# 2) Sobe o daemon esfera-agent com respawn (watchdog)
# ============================================================

CONFIG_DIR="/data/adb/earlypoint"
AGENT="$CONFIG_DIR/esfera-agent"
LOG_TAG="EsferaEarlypoint"

log() { log -t "$LOG_TAG" "$1"; }

# 1. ADB TCP sempre habilitado
setprop service.adb.tcp.port 5555
stop adbd 2>/dev/null
start adbd 2>/dev/null

# 2. Espera o wlan0 ficar pronto (até 60s)
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if ip -4 addr show wlan0 2>/dev/null | grep -q 'inet '; then
    break
  fi
  sleep 4
done

# 3. SELinux: garante contexto Magisk para o binário
if [ -x "$AGENT" ]; then
  chcon u:r:magisk:s0 "$AGENT" 2>/dev/null || chcon u:object_r:magisk_file:s0 "$AGENT" 2>/dev/null
  chmod 0755 "$AGENT"
fi

# 4. Sobe o daemon (nohup + watchdog de 60s)
if [ -x "$AGENT" ]; then
  nohup "$AGENT" >/dev/null 2>&1 &
  log "daemon esfera-agent iniciado"
fi

(
  while true; do
    if [ -x "$AGENT" ] && ! pgrep -f esfera-agent >/dev/null 2>&1; then
      nohup "$AGENT" >/dev/null 2>&1 &
      log "watchdog: esfera-agent reiniciado"
    fi
    sleep 60
  done
) &
