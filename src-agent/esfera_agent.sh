#!/system/bin/sh
# Esfera Agent — Script fallback (toybox wget)
# Usado quando o APK não está disponível ou a instalação falha.
# Envia check-in HTTP a cada 30s para o servidor Esfera v3.

CONFIG_FILE="/sdcard/esfera_config.json"
PID_FILE="/data/local/tmp/esfera_agent.pid"
SLEEP=30

echo "$$" > "$PID_FILE"

get_ip() {
  ip -4 addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d'/' -f1
}

get_cfg() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" 2>/dev/null | sed 's/.*:"//;s/"//'
}

SERVER_URL=$(get_cfg "serverUrl")
DEVICE_ID=$(get_cfg "deviceId")

if [ -z "$SERVER_URL" ] || [ -z "$DEVICE_ID" ]; then
  log -t EsferaAgent "ERRO: Config invalida em $CONFIG_FILE"
  exit 1
fi

log -t EsferaAgent "Iniciando agente script: ID=$DEVICE_ID URL=$SERVER_URL"

while true; do
  IP=$(get_ip)
  if [ -n "$IP" ]; then
    PAYLOAD="{\"esferaDeviceId\":\"$DEVICE_ID\",\"currentAdbAddress\":\"$IP\"}"
    toybox wget -q -O /dev/null \
      --post-data="$PAYLOAD" \
      --header="Content-Type: application/json" \
      "${SERVER_URL}/api/devices/check-in" 2>/dev/null
    log -t EsferaAgent "Check-in: $DEVICE_ID @ $IP"
  else
    log -t EsferaAgent "Sem conexao WiFi (wlan0)"
  fi
  sleep "$SLEEP"
done
