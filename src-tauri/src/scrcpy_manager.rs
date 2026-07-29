// ============================================================
// Esfera v3 — Gerenciador de Espelhamento Scrcpy Server (scrcpy_manager.rs)
// Suporte a Perfis Dual: Modo Economia HPC (--turn-screen-off, 2Mbps, 30FPS) vs Alta Fidelidade
// ============================================================

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

pub struct ScrcpySession {
    pub serial: String,
    pub port: u16,
    pub mode: String, // "economy" ou "high_fidelity"
    pub process: Option<Child>,
}

pub struct ScrcpyManager {
    pub sessions: Arc<Mutex<HashMap<String, ScrcpySession>>>,
}

impl ScrcpyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Garante que o arquivo scrcpy-server.jar esteja presente no dispositivo Android em /data/local/tmp/
    pub fn push_server_jar_if_needed(serial: &str) -> Result<(), String> {
        let check_cmd = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("ls /data/local/tmp/scrcpy-server.jar")
            .output();

        let exists = match check_cmd {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains("scrcpy-server.jar"),
            Err(_) => false,
        };

        if !exists {
            // Tenta enviar o jar padrão se existir localmente
            let push_cmd = Command::new("adb")
                .arg("-s")
                .arg(serial)
                .arg("push")
                .arg("scrcpy-server.jar")
                .arg("/data/local/tmp/scrcpy-server.jar")
                .output();

            match push_cmd {
                Ok(out) if out.status.success() => Ok(()),
                Ok(out) => Err(String::from_utf8_lossy(&out.stderr).to_string()),
                Err(e) => Err(e.to_string()),
            }
        } else {
            Ok(())
        }
    }

    /// Inicia o scrcpy-server.jar no dispositivo Android com o perfil configurável (Economy vs High Fidelity)
    pub fn launch_server(serial: &str, port: u16, mode: &str) -> Result<(), String> {
        let _ = Self::push_server_jar_if_needed(serial);

        // Prepara o redirecionamento de porta ADB
        let forward_cmd = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("forward")
            .arg(format!("tcp:{}", port))
            .arg("localabstract:scrcpy")
            .output();

        if let Err(e) = forward_cmd {
            return Err(format!("Falha ao redirecionar porta ADB {}: {}", port, e));
        }

        // Constrói comando do servidor Android de acordo com o perfil
        let mut server_args = vec![
            "-s", serial, "shell",
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
            "com.genymobile.scrcpy.Server", "2.4",
            "control=true", "raw_stream=true"
        ];

        if mode == "economy" {
            // Modo Economia HPC: Tela desligada, 2 Mbps, 30 FPS para manter GPU/CPU < 15%
            server_args.push("--turn-screen-off");
            server_args.push("-b");
            server_args.push("2M");
            server_args.push("--max-fps");
            server_args.push("30");
        }

        let child = Command::new("adb")
            .args(&server_args)
            .spawn();

        match child {
            Ok(_proc) => Ok(()),
            Err(e) => Err(format!("Erro ao iniciar processo scrcpy-server no aparelho: {}", e)),
        }
    }
}
