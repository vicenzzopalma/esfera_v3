#!/system/bin/sh
# ============================================================
# Esfera v3 — Instalador do daemon kernel-level (root/Magisk)
# Uso: sh /data/local/tmp/earlypoint/install.sh <server> <port> <hardwareUuid>
# 1) Copia binário + scripts para /data/adb/earlypoint
# 2) Config.json com o servidor do túnel inverso
# 3) SELinux permissivo p/ o daemon, imortalidade ADB
# ============================================================

SRC="/data/local/tmp/earlypoint"
DEST="/data/adb/earlypoint"
LOG_TAG="EsferaInstall"

log() { log -t "$LOG_TAG" "$1"; }

SERVER="$1"
PORT="${2:-8888}"
HWID="$3"

[ -z "$SERVER" ] && log "ERRO: servidor do túnel não informado" && exit 1

# 1. Diretório de destino
mkdir -p "$DEST"
chmod 0755 "$DEST"

# 2. Binário + scripts
if [ -f "$SRC/esfera-agent" ]; then
  cp "$SRC/esfera-agent" "$DEST/esfera-agent"
  chmod 0755 "$DEST/esfera-agent"
  chcon u:r:magisk:s0 "$DEST/esfera-agent" 2>/dev/null || true
else
  log "ERRO: esfera-agent ausente em $SRC"
  exit 2
fi

if [ -f "$SRC/00_earlypoint_daemon.sh" ]; then
  cp "$SRC/00_earlypoint_daemon.sh" "$DEST/00_earlypoint_daemon.sh"
  chmod 0755 "$DEST/00_earlypoint_daemon.sh"
fi

# 3. Config do túnel
cat > "$DEST/config.json" <<EOF
{
  "server": "$SERVER",
  "port": $PORT,
  "hardwareUuid": "$HWID"
}
EOF
chmod 0644 "$DEST/config.json"

# 4. Persistência do servidor (fallback do daemon via getprop)
setprop persist.esfera.hub "$SERVER"

# 5. SELinux: libera o daemon
magiskpolicy --live "allow untrusted_app * * *" 2>/dev/null || true

# 6. ADB Wi-Fi imortal
setprop service.adb.tcp.port 5555
stop adbd 2>/dev/null
start adbd 2>/dev/null

# 7. Imunidade a sono/suspensão (root)
dumpsys deviceidle whitelist +com.esfera.agent 2>/dev/null || true
dumpsys deviceidle disable 2>/dev/null || true
echo "earlypoint_daemon" > /sys/power/wake_lock 2>/dev/null || true

# 8. Boot persistente (Magisk)
if [ -d "/data/adb/service.d" ]; then
  cp "$DEST/00_earlypoint_daemon.sh" "/data/adb/service.d/00_earlypoint_daemon.sh"
  chmod 0755 "/data/adb/service.d/00_earlypoint_daemon.sh"
fi

# 9. Sobe agora
if [ -x "$DEST/esfera-agent" ]; then
  pkill -f esfera-agent 2>/dev/null
  nohup "$DEST/esfera-agent" >/dev/null 2>&1 &
fi

log "daemon instalado em $DEST (servidor $SERVER:$PORT)"
exit 0
