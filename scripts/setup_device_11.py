import subprocess
import json
import re
import os
import sqlite3

serial = "0N14619I241030D7"
adb = "distributable/binaries/adb.exe"

print(f"=== Configurando e Imunizando Aparelho 11 ({serial}) ===")

# 1. Ativar modo TCP/IP 5555
print("1. Ativando porta ADB TCP/IP 5555...")
subprocess.run([adb, "-s", serial, "tcpip", "5555"])

# 2. Descobrir IP Wi-Fi do aparelho
print("2. Obtendo IP da interface Wi-Fi...")
ip_res = subprocess.run([adb, "-s", serial, "shell", "ip route | grep wlan0 || ip addr show wlan0"], capture_output=True, text=True)
match = re.search(r"(\d+\.\d+\.\d+\.\d+)", ip_res.stdout)
device_ip = match.group(1) if match else "192.168.1.100"
print(f"IP detectado: {device_ip}")

# 3. Instalar o APK do Agente
print("3. Instalando Esfera_Agent_ADB.apk...")
subprocess.run([adb, "-s", serial, "shell", "settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0"])
inst_res = subprocess.run([adb, "-s", serial, "install", "-r", "Esfera_Agent_ADB.apk"], capture_output=True, text=True)
print(f"Resultado da instalacao: {inst_res.stdout.strip()}")

# 4. Gravar arquivo de configuracao imutavel
print("4. Gravando identidade no /sdcard/esfera_config.json...")
cfg = json.dumps({"deviceId": "ESF-0N14619I", "companyId": 1, "serverUrl": "http://34.29.70.113:31000"})
subprocess.run([adb, "-s", serial, "shell", f"echo '{cfg}' > /sdcard/esfera_config.json"])
subprocess.run([adb, "-s", serial, "shell", "echo 'ESF-0N14619I' > /sdcard/.esfera_device_id"])

# 5. Injetar imunidade total de bateria e persistencia
print("5. Injetando imunidade de bateria e prevencao de sono...")
immunity_cmds = [
    "dumpsys deviceidle whitelist +com.esfera.agent",
    "cmd appops set com.esfera.agent RUN_IN_BACKGROUND allow",
    "cmd appops set com.esfera.agent RUN_ANY_IN_BACKGROUND allow",
    "settings put global captive_portal_mode 0",
    "settings put global captive_portal_detection_enabled 0",
    "settings put global stay_on_while_plugged_in 7",
    "settings put global wifi_sleep_policy 2",
    "settings put global wifi_scan_always_enabled 1",
    "device_config put activity_manager max_phantom_processes 2147483647",
    "setprop persist.adb.tcp.port 5555",
    "setprop persist.esfera.device_id ESF-0N14619I",
    "setprop persist.esfera.company 1",
]
for cmd in immunity_cmds:
    subprocess.run([adb, "-s", serial, "shell", cmd])

# 6. Iniciar o Servico em Primeiro Plano
print("6. Iniciando servico do Agente...")
subprocess.run([adb, "-s", serial, "shell", "am start-foreground-service -n com.esfera.agent/.EsferaAgentService || am startservice -n com.esfera.agent/.EsferaAgentService"])

# 7. Conectar via Wi-Fi no ADB
print(f"7. Conectando ADB ao IP Wi-Fi {device_ip}:5555...")
conn_res = subprocess.run([adb, "connect", f"{device_ip}:5555"], capture_output=True, text=True)
print(f"Conexao Wi-Fi: {conn_res.stdout.strip()}")

# 8. Atualizar banco SQLite local
base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
db_path = os.path.join(base, "esfera_v3", "esfera_v3.db")
con = sqlite3.connect(db_path)
cur = con.cursor()
cur.execute(
    "UPDATE ESF_Device SET CurrentAdbAddress=?, DeviceIp=?, Status='online', LastSeenUTC=datetime('now') WHERE EsferaDeviceId='ESF-0N14619I'",
    (f"{device_ip}:5555", device_ip)
)
con.commit()
print("8. Banco SQLite atualizado!")

# 9. Verificar processo ativo
ps_res = subprocess.run([adb, "-s", serial, "shell", "ps | grep esfera || ps -A | grep esfera"], capture_output=True, text=True)
print(f"Processo em execucao: {ps_res.stdout.strip()}")
print("=== Finalizado com Sucesso ===")
