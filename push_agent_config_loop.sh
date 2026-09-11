#!/usr/bin/env bash
# Loop robusto: a cada 15s, pega os celulares vivos no adb e garante que
# cada um tenha o esfera_config.json (host fixo da VPS) + agente reiniciado.
# Nao depende de IP estavel: reconecta e re-tenta enquanto o celular aparecer.
set -u
ADB="./distributable/binaries/adb.exe"
CFG="esfera_config.json"
PKG="com.esfera.agent"
MAX_ROUNDS=40   # ~10 min
for ((r=1; r<=MAX_ROUNDS; r++)); do
  echo "[round $r] $(date +%H:%M:%S)"
  # Reconecta IPs conhecidos caso tenham caido
  for ip in 192.168.1.100 192.168.1.41 192.168.1.64 192.168.1.82 192.168.1.83 \
           192.168.1.151 192.168.1.56 192.168.1.42 192.168.1.65 192.168.1.58 192.168.1.63; do
    "$ADB" connect "$ip:5555" >/dev/null 2>&1
  done
  sleep 2
  # Pega so os vivos (device)
  mapfile -t DEVS < <("$ADB" devices 2>/dev/null | awk '$2=="device"{print $1}')
  if [ ${#DEVS[@]} -eq 0 ]; then
    echo "  nenhum device vivo agora"
  fi
  for d in "${DEVS[@]}"; do
    echo "  -> $d: push config + restart agent"
    "$ADB" -s "$d" push "$CFG" /sdcard/esfera_config.json >/dev/null 2>&1 \
      && "$ADB" -s "$d" shell am force-stop "$PKG" >/dev/null 2>&1 \
      && "$ADB" -s "$d" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 \
      && echo "     OK" || echo "     falhou"
  done
  sleep 13
done
echo "FIM loop"
