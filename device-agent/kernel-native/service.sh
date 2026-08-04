#!/system/bin/sh
# ============================================================
# Esfera v3 — Script de Inicialização de Kernel (service.sh)
# Executado automaticamente pelo Magisk / init.d durante o boot do Linux.
# ============================================================

# Aguarda a pilha de rede do Kernel estar pronta
until [ $(getprop sys.boot_completed) -eq 1 ]; do
    sleep 2
done

# Permite acesso total e prioridade máxima de processo no Kernel Linux
MODDIR=${0%/*}
DAEMON_BIN="$MODDIR/esfera_kernel_daemon"

if [ -f "$DAEMON_BIN" ]; then
    chmod 755 "$DAEMON_BIN"
    # Executa o daemon nativo em C++ como ROOT (UID 0) com niceness -20 (Prioridade Máxima do Kernel)
    nice -n -20 "$DAEMON_BIN" "192.168.1.15" 8888 > /dev/null 2>&1 &
fi
