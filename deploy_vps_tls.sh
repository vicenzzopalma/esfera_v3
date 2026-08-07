#!/usr/bin/env bash
# Deploy do canal TLS no VPS Esfera (rodar no esfera-v3-hub como vicenzzoconstantine).
# Faz: git pull -> build hub release -> gera cert self-signed -> restart hub com TLS.
set -e
cd ~/esfera_v3
echo "[1/5] git pull"
git pull --ff-only
cd hub-standalone
source "$HOME/.cargo/env"
echo "[2/5] cargo build --release (pode demorar ~7min)"
cargo build --release
echo "[3/5] cert self-signed em tls/"
mkdir -p tls
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout tls/key.pem -out tls/cert.pem -days 365 \
  -subj "/CN=34.29.70.113"
echo "[4/5] restart hub"
pkill -f esfera-hub-standalone || true
sleep 2
export HUB_MASTER_TOKEN="EsferaHubMaster_9f2c4a7b8e1d6c3f5a0b"
export HUB_PORT=8555 HTTP_PORT=8080 TUNNEL_PORT=8888 PRESENCE_PORT=7779 TLS_PORT=8443
nohup ./target/release/esfera-hub-standalone > hub.log 2>&1 &
sleep 4
echo "[5/5] log do hub:"
grep -iE "TLS|🔐|ATIVO" hub.log || tail -5 hub.log
echo "Pronto. Se apareceu '🔐 Servidor TLS ... 8443', avise o Hermes para testar via celular."
