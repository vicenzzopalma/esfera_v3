import os
import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT_DIR / "monstro.txt"

# Lista explícita de arquivos essenciais para o problema de Conexão dos Celulares,
# Túnel Reverso, ADB, Identidade, VPS Hub e Agentes Android/Kernel.
CONNECTION_FILES = [
    # 1. Regras e Diretrizes
    "diretrizes.md",
    ".agents/AGENTS.md",
    ".agents/rules/id-name.md",

    # 2. Agente Android Kotlin (src-agent)
    "src-agent/app/src/main/AndroidManifest.xml",
    "src-agent/app/src/main/kotlin/com/esfera/agent/EsferaAgentService.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/PresenceClient.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/AdbTunnelManager.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/BootJobService.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/BootReceiver.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/KeepAliveReceiver.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/AdminReceiver.kt",
    "src-agent/app/src/main/kotlin/com/esfera/agent/MainActivity.kt",
    "src-agent/esfera_agent.sh",

    # 3. Agente Kernel / Rust / C++ (device-agent)
    "device-agent/Cargo.toml",
    "device-agent/src/main.rs",
    "device-agent/kernel-native/esfera_kernel_daemon.cpp",
    "device-agent/kernel-native/service.sh",

    # 4. Servidor VPS Standalone Rust (hub-standalone)
    "hub-standalone/Cargo.toml",
    "hub-standalone/src/main.rs",
    "hub-standalone/src/hub.rs",
    "hub-standalone/src/tunnel_server.rs",
    "hub-standalone/src/presence_server.rs",
    "hub-standalone/src/checkin_server.rs",
    "hub-standalone/src/session_manager.rs",
    "hub-standalone/src/router.rs",
    "hub-standalone/src/protocol.rs",
    "hub-standalone/src/db.rs",
    "hub-standalone/src/tls_server.rs",
    "hub-standalone/src/mqtt_fallback_server.rs",

    # 5. Backend Desktop Tauri (src-tauri) - Módulos de Conexão, ADB e Identidade
    "src-tauri/Cargo.toml",
    "src-tauri/src/adb_manager.rs",
    "src-tauri/src/adb_tcp.rs",
    "src-tauri/src/commands.rs",
    "src-tauri/src/checkin_server.rs",
    "src-tauri/src/session_manager.rs",
    "src-tauri/src/tunnel_server.rs",
    "src-tauri/src/presence_server.rs",
    "src-tauri/src/hub_client.rs",
    "src-tauri/src/hub.rs",
    "src-tauri/src/db.rs",
    "src-tauri/src/empresa_server.rs",
    "src-tauri/src/hpc_device_router.cpp",
    "src-tauri/src/hpc_device_router.hpp",
    "src-tauri/src/native_hpc/esfera_hpc.cpp",
    "src-tauri/src/native_hpc/esfera_hpc.h",

    # 6. Scripts de Rede, ADB e Auto-Recovery
    "Ativar_Esfera_WiFi_ADB.bat",
    "Iniciar_Esfera_v3.bat",
    "build-agent.ps1",
    "deploy_vps_tls.sh",
    "push_agent_config_loop.sh",
    "scripts/setup_device_11.py",
    "scripts/fleet_deploy_all.py",
    "scripts/audit_and_fix_identities.py",
    "scripts/fix_device_ips.py",
    "scripts/setup_esfera_device.bat",

    # 7. Frontend UI de Dispositivos e Conexão
    "src/pages/DevicesTab.tsx",
    "src/components/devices/DeviceCard.tsx",
    "src/components/devices/DeviceIdentityModal.tsx",
    "src/components/devices/ConnectDeviceModal.tsx",
    "src/components/devices/DeviceConfigModal.tsx",
    "src/components/devices/DiagnosticModal.tsx",
    "src/components/devices/MirrorModal.tsx",
]

def read_file_safely(file_path: Path) -> str:
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            with open(file_path, "r", encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    return "[ERRO DE LEITURA DO ARQUIVO]"

def main():
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    sections = [
        ("1. REGRAS E DIRETRIZES DE IDENTIDADE E CONEXÃO", [
            "diretrizes.md",
            ".agents/AGENTS.md",
            ".agents/rules/id-name.md",
        ]),
        ("2. AGENTE ANDROID KOTLIN (src-agent)", [
            "src-agent/app/src/main/AndroidManifest.xml",
            "src-agent/app/src/main/kotlin/com/esfera/agent/EsferaAgentService.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/PresenceClient.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/AdbTunnelManager.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/BootJobService.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/BootReceiver.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/KeepAliveReceiver.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/AdminReceiver.kt",
            "src-agent/app/src/main/kotlin/com/esfera/agent/MainActivity.kt",
            "src-agent/esfera_agent.sh",
        ]),
        ("3. AGENTE KERNEL / NATIVO RUST E C++ (device-agent)", [
            "device-agent/Cargo.toml",
            "device-agent/src/main.rs",
            "device-agent/kernel-native/esfera_kernel_daemon.cpp",
            "device-agent/kernel-native/service.sh",
        ]),
        ("4. SERVIDOR VPS STANDALONE EM RUST (hub-standalone)", [
            "hub-standalone/Cargo.toml",
            "hub-standalone/src/main.rs",
            "hub-standalone/src/hub.rs",
            "hub-standalone/src/tunnel_server.rs",
            "hub-standalone/src/presence_server.rs",
            "hub-standalone/src/checkin_server.rs",
            "hub-standalone/src/session_manager.rs",
            "hub-standalone/src/router.rs",
            "hub-standalone/src/protocol.rs",
            "hub-standalone/src/db.rs",
            "hub-standalone/src/tls_server.rs",
            "hub-standalone/src/mqtt_fallback_server.rs",
        ]),
        ("5. BACKEND DESKTOP TAURI (src-tauri - ADB, Túnel, Sessões e Identidade)", [
            "src-tauri/Cargo.toml",
            "src-tauri/src/adb_manager.rs",
            "src-tauri/src/adb_tcp.rs",
            "src-tauri/src/commands.rs",
            "src-tauri/src/checkin_server.rs",
            "src-tauri/src/session_manager.rs",
            "src-tauri/src/tunnel_server.rs",
            "src-tauri/src/presence_server.rs",
            "src-tauri/src/hub_client.rs",
            "src-tauri/src/hub.rs",
            "src-tauri/src/db.rs",
            "src-tauri/src/empresa_server.rs",
            "src-tauri/src/hpc_device_router.cpp",
            "src-tauri/src/hpc_device_router.hpp",
            "src-tauri/src/native_hpc/esfera_hpc.cpp",
            "src-tauri/src/native_hpc/esfera_hpc.h",
        ]),
        ("6. SCRIPTS DE PROVISIONAMENTO, REDE E ADB", [
            "Ativar_Esfera_WiFi_ADB.bat",
            "Iniciar_Esfera_v3.bat",
            "build-agent.ps1",
            "deploy_vps_tls.sh",
            "push_agent_config_loop.sh",
            "scripts/setup_device_11.py",
            "scripts/fleet_deploy_all.py",
            "scripts/audit_and_fix_identities.py",
            "scripts/fix_device_ips.py",
            "scripts/setup_esfera_device.bat",
        ]),
        ("7. FRONTEND - UI DE DISPOSITIVOS E CONEXÃO", [
            "src/pages/DevicesTab.tsx",
            "src/components/devices/DeviceCard.tsx",
            "src/components/devices/DeviceIdentityModal.tsx",
            "src/components/devices/ConnectDeviceModal.tsx",
            "src/components/devices/DeviceConfigModal.tsx",
            "src/components/devices/DiagnosticModal.tsx",
            "src/components/devices/MirrorModal.tsx",
        ])
    ]

    count = 0
    with open(OUTPUT_FILE, "w", encoding="utf-8") as out:
        out.write("================================================================================\n")
        out.write(" ESFERA V3 - NÚCLEO DE CONEXÃO PERSISTENTE ANDROID ↔ VPS ↔ DESKTOP\n")
        out.write(" (monstro.txt — Filtrado com foco exclusivo em Conexão, ADB, Túnel e Identidade)\n")
        out.write("================================================================================\n\n")
        out.write(f"// Gerado em {now_str}\n")
        out.write("//================================================================================\n\n")

        for sec_title, rel_paths in sections:
            out.write("================================================================================\n")
            out.write(f" {sec_title}\n")
            out.write("================================================================================\n\n")

            for rp in rel_paths:
                fp = ROOT_DIR / Path(rp)
                if fp.exists():
                    count += 1
                    content = read_file_safely(fp)
                    out.write("//================================================================================\n")
                    out.write(f"// FILE: {rp}\n")
                    out.write("//================================================================================\n")
                    out.write(content.rstrip() + "\n\n\n")
                else:
                    print(f"Aviso: arquivo não encontrado: {rp}")

    size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    print(f"monstro.txt filtrado com sucesso! Total de arquivos incluídos: {count}, Tamanho: {size_mb:.2f} MB")

if __name__ == "__main__":
    main()
