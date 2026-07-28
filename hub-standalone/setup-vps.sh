#!/bin/bash
set -e

echo "=== Configurando Esfera Hub Standalone na VPS Linux ==="

# 1. Configurar SWAP se não existir (evita travar a compilação por falta de RAM)
if [ ! -f /swapfile ]; then
    echo "Configurando 2GB de Swap para evitar travamento na compilação..."
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap configurado com sucesso!"
else
    echo "Swap já existente."
fi

# 2. Compilar o projeto em modo --release usando 1 job para não estressar a memória
echo "Compilando esfera-hub-standalone..."
cargo build --release -j 1

echo "=== Compilação Concluída com Sucesso! ==="
echo "O binário foi gerado em: ./target/release/esfera-hub-standalone"

# 3. Informar opção de execução 24/7
echo ""
echo "Para executar em background 24h:"
echo "  nohup ./target/release/esfera-hub-standalone > hub.log 2>&1 &"
echo ""
echo "Ou para instalar como Serviço do Sistema (Recomendado - Inicia no boot):"
echo "  sudo cp esfera-hub.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now esfera-hub"
