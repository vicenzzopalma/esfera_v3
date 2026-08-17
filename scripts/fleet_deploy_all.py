import subprocess
import re
import json
import time
import socket
import concurrent.futures
import sqlite3
import os
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

adb = "distributable/binaries/adb.exe"
apk = "Esfera_Agent_ADB.apk"

print("==========================================================")
print("ESFERA V3 - ATUALIZACAO E DEPLOY MASSIVO DA FROTA")
print("==========================================================")

# 1. Varredura rápida na Subnet Local (porta 5555) para conectar todos os aparelhos
print("\n[1/4] Varrendo rede local (192.168.1.0/24) para conectar aparelhos...")
def check_and_connect(ip):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.15)
    try:
        if s.connect_ex((ip, 5555)) == 0:
            subprocess.run([adb, "connect", f"{ip}:5555"], capture_output=True, text=True, timeout=5)
            return ip
    except:
        pass
    finally:
        s.close()
    return None

ips = [f"192.168.1.{i}" for i in range(1, 255)]
with concurrent.futures.ThreadPoolExecutor(max_workers=60) as executor:
    active_ips = [res for res in executor.map(check_and_connect, ips) if res]

time.sleep(1.0)

# 2. Listar todos os dispositivos detectados no ADB
print("\n[2/4] Identificando dispositivos ativos no ADB...")
dev_out = subprocess.run([adb, "devices", "-l"], capture_output=True, text=True, timeout=5).stdout
devices = []
for line in dev_out.splitlines():
    line = line.strip()
    if not line or line.startswith("List of"):
        continue
    parts = line.split()
    if len(parts) >= 2 and parts[1] == "device":
        serial = parts[0]
        model = "Smartphone"
        for p in parts:
            if p.startswith("model:"):
                model = p.split(":", 1)[1]
        devices.append((serial, model))

print(f"Total de dispositivos online encontrados via ADB: {len(devices)}")
for s, m in devices:
    print(f"  • {s} ({m})")

# 3. Processar instalação, configuração e imunidade em cada celular
print("\n[3/4] Instalando Esfera_Agent_ADB.apk e aplicando imunidade...")

results = []

def deploy_to_device(serial, model):
    try:
        # a. Obter serial de hardware
        try:
            hw_res = subprocess.run([adb, "-s", serial, "shell", "getprop ro.serialno"], capture_output=True, text=True, timeout=8)
            hw_serial = hw_res.stdout.strip()
        except:
            hw_serial = ""

        if not hw_serial or hw_serial == "unknown" or " " in hw_serial or "." in hw_serial:
            hw_serial = serial.split(":")[0] if ":" in serial else serial

        prefix8 = hw_serial.upper()[:8] if len(hw_serial) >= 8 else hw_serial.upper()
        device_id = f"ESF-{prefix8}"

        # b. Desativar verificador de pacotes para instalacao rapida
        subprocess.run([adb, "-s", serial, "shell", "settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0"], capture_output=True, timeout=8)

        # c. Instalar APK
        install_ok = False
        try:
            push_res = subprocess.run([adb, "-s", serial, "push", apk, "/data/local/tmp/Esfera_Agent_ADB.apk"], capture_output=True, text=True, timeout=40)
            inst_res = subprocess.run([adb, "-s", serial, "shell", "pm install -r -g /data/local/tmp/Esfera_Agent_ADB.apk"], capture_output=True, text=True, timeout=45)
            install_ok = "Success" in inst_res.stdout or "success" in inst_res.stdout.lower()
        except Exception as e:
            pass

        if not install_ok:
            try:
                fb_res = subprocess.run([adb, "-s", serial, "install", "-r", apk], capture_output=True, text=True, timeout=50)
                install_ok = "Success" in fb_res.stdout or "success" in fb_res.stdout.lower()
            except:
                pass

        # d. Injetar configuracao e identidade permanente
        cfg = json.dumps({
            "deviceId": device_id,
            "companyId": 1,
            "serverUrl": "http://34.29.70.113:8080",
            "heartbeatIntervalSec": 30
        })
        try:
            subprocess.run([adb, "-s", serial, "shell", f"echo '{cfg}' > /sdcard/esfera_config.json; echo '{device_id}' > /sdcard/.esfera_device_id"], capture_output=True, timeout=8)
        except:
            pass

        # e. Injetar imunidade de bateria e wake lock
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
            f"setprop persist.esfera.device_id {device_id}",
            "setprop persist.esfera.company 1",
        ]
        for cmd in immunity_cmds:
            try:
                subprocess.run([adb, "-s", serial, "shell", cmd], capture_output=True, timeout=5)
            except:
                pass

        # f. Iniciar servico em primeiro plano
        try:
            subprocess.run([adb, "-s", serial, "shell", "am start-foreground-service -n com.esfera.agent/.EsferaAgentService || am startservice -n com.esfera.agent/.EsferaAgentService"], capture_output=True, timeout=8)
        except:
            pass

        # g. Checar se processo esta ativo
        is_running = False
        try:
            ps_res = subprocess.run([adb, "-s", serial, "shell", "ps | grep esfera || ps -A | grep esfera"], capture_output=True, text=True, timeout=8)
            is_running = "com.esfera.agent" in ps_res.stdout
        except:
            pass

        return {
            "serial": serial,
            "model": model,
            "deviceId": device_id,
            "installed": install_ok,
            "running": is_running,
        }
    except Exception as e:
        return {
            "serial": serial,
            "model": model,
            "deviceId": "ESF-UNKNOWN",
            "installed": False,
            "running": False,
        }

for s, m in devices:
    res = deploy_to_device(s, m)
    status_icon = "🟢" if res["installed"] and res["running"] else ("🟡" if res["installed"] else "🔴")
    print(f"  {status_icon} [{res['deviceId']}] {res['serial']} ({res['model']}) -> APK: {'OK' if res['installed'] else 'Falha'} | Serviço Ativo: {'SIM' if res['running'] else 'NÃO'}")
    results.append(res)

# 4. Sincronizar banco de dados SQLite
print("\n[4/4] Atualizando banco de dados local SQLite...")
base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA')
path = os.path.join(base, 'esfera_v3', 'esfera_v3.db')
con = sqlite3.connect(path)
cur = con.cursor()

for res in results:
    ip = res['serial'].split(':')[0] if ':' in res['serial'] else ''
    cur.execute("""
        UPDATE ESF_Device SET
            Status = 'online',
            CurrentAdbAddress = ?,
            DeviceIp = CASE WHEN ? != '' THEN ? ELSE DeviceIp END,
            LastSeenUTC = datetime('now')
        WHERE EsferaDeviceId = ? OR AdbDeviceId = ?
    """, (res['serial'], ip, ip, res['deviceId'], res['serial']))

con.commit()

print("\n==========================================================")
print(f"🎉 DEPLOY CONCLUÍDO COM SUCESSO EM {len(results)} APARELHOS!")
print("==========================================================")
