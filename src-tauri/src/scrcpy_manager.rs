// ============================================================
// Esfera v3 — Gerenciador de Espelhamento Scrcpy Server (scrcpy_manager.rs)
// Suporte a Perfis Dual: Modo Economia HPC (--turn-screen-off, 2Mbps, 30FPS) vs Alta Fidelidade
// 100% standalone: usa adb/scrcpy/scrcpy-server.jar embutidos ao lado do exe
// ============================================================

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use crate::adb_manager::{bundled_tools_dir, create_cmd};

pub struct ScrcpySession {
    pub serial: String,
    pub port: u16,
    pub mode: String, // "economy" ou "high_fidelity"
    pub process: Option<Child>,
}

pub struct ScrcpyManager {
    pub sessions: Arc<Mutex<HashMap<String, ScrcpySession>>>,
}

/// Localiza o scrcpy-server.jar embutido (ao lado do exe ou no dir de recursos).
fn local_jar_path() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = bundled_tools_dir() {
        candidates.push(dir.join("scrcpy-server.jar"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("resources").join("binaries").join("scrcpy-server.jar"));
            candidates.push(exe_dir.join("binaries").join("scrcpy-server.jar"));
            candidates.push(exe_dir.join("scrcpy-server.jar"));
        }
    }
    candidates.push(std::path::PathBuf::from("src-tauri/binaries/scrcpy-server.jar"));
    candidates.push(std::path::PathBuf::from("src-tauri/scrcpy-server.jar"));
    candidates.push(std::path::PathBuf::from("scrcpy-server.jar"));
    candidates.into_iter().find(|p| p.exists())
}

pub static GLOBAL_SCRCPY_MANAGER: std::sync::LazyLock<ScrcpyManager> = std::sync::LazyLock::new(ScrcpyManager::new);

impl ScrcpyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Garante que o arquivo scrcpy-server.jar esteja presente no dispositivo Android em /data/local/tmp/.
    /// Usa o jar empacotado no projeto quando disponível; caso contrário, faz fallback para scrcpy nativo do sistema.
    pub fn push_server_jar_if_needed(serial: &str) -> Result<(), String> {
        let check_cmd = create_cmd("adb")
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
            if let Some(local) = local_jar_path() {
                let push_cmd = create_cmd("adb")
                    .arg("-s")
                    .arg(serial)
                    .arg("push")
                    .arg(&local)
                    .arg("/data/local/tmp/scrcpy-server.jar")
                    .output();

                match push_cmd {
                    Ok(out) if out.status.success() => return Ok(()),
                    Ok(out) => return Err(format!("Falha ao enviar scrcpy-server.jar: {}", String::from_utf8_lossy(&out.stderr))),
                    Err(e) => return Err(format!("Erro no push do jar: {e}")),
                }
            }

            // Sem jar local: lançar scrcpy nativo diretamente.
            return Ok(());
        }

        Ok(())
    }

    /// Inicia o servidor Scrcpy no dispositivo Android com perfil explícito de interação.
    /// Mantém a tela ligada para interação e usa flags de performance em vez de modo econômico cego.
    pub fn launch_server(serial: &str, port: u16, mode: &str) -> Result<(), String> {
        let _ = Self::push_server_jar_if_needed(serial);

        // Redirecionamento de porta ADB necessário apenas quando jar local for usado.
        let has_local_jar = local_jar_path().is_some();

        if has_local_jar {
            let forward_cmd = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .arg("forward")
                .arg(format!("tcp:{port}"))
                .arg("localabstract:scrcpy")
                .output();

            if let Err(e) = forward_cmd {
                return Err(format!("Falha ao redirecionar porta ADB {}: {}", port, e));
            }
        }

        if has_local_jar {
            let mut server_args = vec![
                "-s", serial, "shell",
                "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
                "com.genymobile.scrcpy.Server", "2.4",
                "control=true", "raw_stream=true"
            ];

            if mode == "economy" {
                server_args.push("--turn-screen-off");
                server_args.push("-b");
                server_args.push("2M");
                server_args.push("--max-fps");
                server_args.push("30");
            } else {
                // Modo interativo: mantém tela ligada, toque físico real e FPS usável.
                server_args.push("--stay-awake");
                server_args.push("-b");
                server_args.push("4M");
                server_args.push("--max-fps");
                server_args.push("60");
            }

            let child = create_cmd("adb")
                .args(&server_args)
                .spawn();

            match child {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Erro ao iniciar processo scrcpy-server no aparelho: {}", e)),
            }
        } else {
            // Fallback direto ao executável scrcpy (embutido ou no PATH).
            let mut cmd = create_cmd("scrcpy");
            cmd.args(["-s", serial]);

            if mode == "economy" {
                cmd.args(["--turn-screen-off", "-b", "2M", "--max-fps", "30"]);
            } else {
                cmd.args(["--stay-awake", "-b", "4M", "--max-fps", "60"]);
            }

            match cmd.spawn() {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Erro ao iniciar scrcpy nativo: {}. Verifique se o scrcpy.exe está no PATH.", e)),
            }
        }
    }

    /// Encerra o scrcpy-server e remove o redirecionamento de porta ADB quando aplicável.
    pub fn stop_server(serial: &str, port: u16) -> Result<(), String> {
        if local_jar_path().is_some() {
            let _ = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .arg("forward")
                .arg("--remove")
                .arg(format!("tcp:{port}"))
                .output();
        }

        let _ = create_cmd("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("pkill -f scrcpy")
            .output();

        Ok(())
    }

    /// Retorna os PIDs de todos os processos Scrcpy ativamente gerenciados
    pub fn get_active_pids(&self) -> Vec<u32> {
        let mut pids = Vec::new();
        if let Ok(sessions) = self.sessions.lock() {
            for sess in sessions.values() {
                if let Some(ref child) = sess.process {
                    pids.push(child.id());
                }
            }
        }
        pids
    }
}

// ============================================================
// AGENTE ÓRFÃO OTTO (OrphanOtto)
// Monitor inteligente de processos órfãos (Scrcpy / ADB)
// Regra: Detecta e registra órfãos SEM MATÁ-LOS AUTOMATICAMENTE
// ============================================================

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct OrphanProcessInfo {
    pub pid: u32,
    pub name: String,
    pub detected_at: String,
    pub status: String,
    pub detail: String,
}

pub struct OrphanOtto;

impl OrphanOtto {
    /// Detecta processos scrcpy.exe / adb.exe órfãos no sistema sem matar automaticamente.
    pub fn scan_orphans(managed_pids: &[u32]) -> Vec<OrphanProcessInfo> {
        let mut orphans = Vec::new();

        #[cfg(target_os = "windows")]
        {
            let targets = ["scrcpy.exe", "adb.exe"];
            for target in targets {
                let output = Command::new("tasklist")
                    .args(["/FO", "CSV", "/NH", "/FI", &format!("IMAGENAME eq {target}")])
                    .output();

                if let Ok(out) = output {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    for line in stdout.lines() {
                        let parts: Vec<&str> = line.split(',').map(|s| s.trim_matches('"')).collect();
                        if parts.len() >= 2 {
                            if let Ok(pid) = parts[1].parse::<u32>() {
                                // Se for scrcpy.exe e não estiver na lista de PIDs gerenciados
                                if target == "scrcpy.exe" && !managed_pids.contains(&pid) {
                                    eprintln!("🔍 [Agente Órfão Otto] Processo órfão detectado sem gestão: {} (PID: {})", target, pid);
                                    orphans.push(OrphanProcessInfo {
                                        pid,
                                        name: target.to_string(),
                                        detected_at: chrono::Utc::now().to_rfc3339(),
                                        status: "ORPHAN_DETECTED".to_string(),
                                        detail: format!("Processo {} rodando fora do ScrcpySessionManager (PID: {})", target, pid),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        orphans
    }
}
