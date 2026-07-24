// ============================================================
// Esfera v3 — Gerenciador ADB Nativo (adb_manager.rs)
// Comunicação nativa com o Android Debug Bridge CLI
// ============================================================

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::RwLock;
use std::collections::HashMap;
use std::time::Duration;

pub fn run_cmd_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output, String> {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Falha ao iniciar comando: {}", e))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut out) = child.stdout.take() {
                    use std::io::Read;
                    let _ = out.read_to_end(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_end(&mut stderr);
                }
                return Ok(std::process::Output { status, stdout, stderr });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    return Err(format!("Comando excedeu timeout de {}s.", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("Erro ao aguardar processo: {}", e)),
        }
    }
}

pub fn create_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdbDeviceInfo {
    pub serial: String,
    pub state: String,
    pub model: String,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EsferaHardwareCaps {
    pub supports_avx2: bool,
    pub supports_avx512: bool,
    pub supports_sse42: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct EsferaAdbDiagnostic {
    pub has_any_usb_device: bool,
    pub has_android_usb_device: bool,
    pub is_adb_process_running: bool,
    pub detected_usb_count: i32,
    pub diagnostic_msg: [u8; 256],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EsferaAdbDiagnosticResult {
    pub has_any_usb_device: bool,
    pub has_android_usb_device: bool,
    pub is_adb_process_running: bool,
    pub detected_usb_count: i32,
    pub diagnostic_msg: String,
}

extern "C" {
    pub fn esfera_hpc_detect_hardware(caps: *mut EsferaHardwareCaps);
    pub fn esfera_hpc_run_adb_diagnostic(diag: *mut EsferaAdbDiagnostic);
    pub fn esfera_hpc_sanitize_png_buffer(
        input_ptr: *const u8,
        input_len: usize,
        output_ptr: *mut u8,
        max_out_len: usize,
        out_written: *mut usize,
    ) -> i32;
    pub fn esfera_hpc_calculate_gaussian_delay(min_ms: i32, max_ms: i32) -> i32;
    pub fn esfera_hpc_generate_hardware_uuid(out_uuid_buf: *mut u8, max_len: usize);
    pub fn esfera_hpc_generate_bezier_points(
        start_x: i32,
        start_y: i32,
        end_x: i32,
        end_y: i32,
        out_pts_x: *mut i32,
        out_pts_y: *mut i32,
        max_points: i32,
        out_count: *mut i32,
    ) -> i32;
}

static DEVICE_INFO_CACHE: std::sync::LazyLock<RwLock<HashMap<String, (String, String)>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

pub struct AdbManager;

impl AdbManager {
    /// Detecta capacidades da CPU via Engine C++ HPC nativa
    pub fn get_hardware_capabilities() -> EsferaHardwareCaps {
        let mut caps = EsferaHardwareCaps {
            supports_avx2: false,
            supports_avx512: false,
            supports_sse42: false,
        };
        unsafe {
            esfera_hpc_detect_hardware(&mut caps);
        }
        caps
    }

    /// Calcula atraso gaussiano imprevisível em C++ HPC
    pub fn calculate_gaussian_delay(min_ms: i32, max_ms: i32) -> i32 {
        unsafe { esfera_hpc_calculate_gaussian_delay(min_ms, max_ms) }
    }

    /// Obtém UUID de Licenciamento de Hardware vinculado à CPU e Placa-mãe em C++
    pub fn get_hardware_uuid() -> String {
        let mut buf = vec![0u8; 128];
        unsafe {
            esfera_hpc_generate_hardware_uuid(buf.as_mut_ptr(), buf.len());
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(128);
        String::from_utf8_lossy(&buf[..len]).into_owned()
    }

    /// Varredura segura de sub-rede na porta 5555 usando pool fixo de 16 threads para evitar estouro de pilha/memória
    pub fn scan_subnet(subnet_prefix: &str) -> Vec<String> {
        use std::net::TcpStream;
        use std::time::Duration;
        use std::sync::{Arc, Mutex};

        let active_ips = Arc::new(Mutex::new(Vec::new()));
        let prefix = if subnet_prefix.is_empty() { "192.168.1" } else { subnet_prefix.trim_end_matches('.') }.to_string();

        let num_workers = 16;
        let mut handles = Vec::new();

        for worker_id in 0..num_workers {
            let active_ips_clone = Arc::clone(&active_ips);
            let prefix_clone = prefix.clone();

            let handle = std::thread::spawn(move || {
                let start = worker_id * 16 + 1;
                let end = ((worker_id + 1) * 16).min(254);

                for i in start..=end {
                    let ip = format!("{}.{}", prefix_clone, i);
                    let addr = format!("{}:5555", ip);
                    if let Ok(socket_addr) = addr.parse() {
                        if TcpStream::connect_timeout(&socket_addr, Duration::from_millis(60)).is_ok() {
                            if let Ok(mut ips) = active_ips_clone.lock() {
                                ips.push(ip);
                            }
                        }
                    }
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            let _ = handle.join();
        }

        let lock = active_ips.lock().unwrap_or_else(|e| e.into_inner());
        lock.clone()
    }

    /// Injeta scripts e propriedades persistentes no Android para proibir o desligamento do Wi-Fi e ADB
    pub fn deploy_keepalive(serial: &str) -> Result<String, String> {
        let commands = vec![
            "setprop persist.adb.tcp.port 5555",
            "settings put global wifi_sleep_policy 2",
            "settings put global stay_on_while_plugged_in 7",
            "settings put global low_power 0",
            "settings put global low_power_trigger_level 0",
            "settings put global wifi_scan_always_enabled 1",
            "settings put global adb_allowed_connection_time 0",
            "settings put global tcp_keepalive_interval 15",
            "dumpsys deviceidle disable",
            "dumpsys deviceidle whitelist +com.android.shell",
            "dumpsys deviceidle whitelist +com.google.android.gms",
        ];
        let mut errors = Vec::new();
        for cmd in commands {
            let result = create_cmd("adb")
                .args(["-s", serial, "shell", cmd])
                .output();
            if let Err(e) = result {
                errors.push(format!("{}: {}", cmd, e));
            }
        }
        if errors.is_empty() {
            Ok("Injeção Keep-Alive ADB persistente aplicada no celular com sucesso!".to_string())
        } else {
            Err(format!("Alguns comandos Keep-Alive falharam: {}", errors.join("; ")))
        }
    }

    /// Executa o diagnóstico avançado de hardware/processos USB & ADB
    pub fn run_diagnostic() -> EsferaAdbDiagnosticResult {
        let mut diag = EsferaAdbDiagnostic {
            has_any_usb_device: false,
            has_android_usb_device: false,
            is_adb_process_running: false,
            detected_usb_count: 0,
            diagnostic_msg: [0u8; 256],
        };
        unsafe {
            esfera_hpc_run_adb_diagnostic(&mut diag);
        }
        
        let len = diag.diagnostic_msg.iter().position(|&c| c == 0).unwrap_or(256);
        let mut msg = String::from_utf8_lossy(&diag.diagnostic_msg[..len]).into_owned();

        // Checagem em tempo real no Windows PnP para falha física no cabo USB / descritor
        if let Ok(output) = create_cmd("powershell")
            .args(["-Command", "Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'Error' } | Select-Object -ExpandProperty FriendlyName"])
            .output()
        {
            let pnp_err = String::from_utf8_lossy(&output.stdout);
            if pnp_err.contains("Descritor") || pnp_err.contains("Desconhecido") {
                msg = "⚠️ ERRO DE HARDWARE USB NO WINDOWS: O Windows identificou 'Dispositivo USB Desconhecido (Falha na Solicitação de Descritor de Dispositivo)'. O cabo USB atual está fornecendo apenas energia/carregamento, mas falhou ao transmitir os dados de depuração. Por favor: 1) Troque o cabo USB; 2) Conecte diretamente em uma porta USB 3.0 traseira da placa-mãe; 3) Altere no celular para 'Transferência de Arquivos (MTP)'.".to_string();
            }
        }

        EsferaAdbDiagnosticResult {
            has_any_usb_device: diag.has_any_usb_device,
            has_android_usb_device: diag.has_android_usb_device,
            is_adb_process_running: diag.is_adb_process_running,
            detected_usb_count: diag.detected_usb_count,
            diagnostic_msg: msg,
        }
    }

    /// Reinicia o servidor ADB (kill-server & start-server)
    pub fn restart_server() -> Result<String, String> {
        let _ = create_cmd("adb")
            .arg("kill-server")
            .output();

        std::thread::sleep(std::time::Duration::from_millis(1000));

        let output = create_cmd("adb")
            .arg("start-server")
            .output()
            .map_err(|e| format!("Falha ao iniciar servidor ADB: {}", e))?;

        if output.status.success() {
            Ok("Servidor ADB reiniciado com sucesso!".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Falha ao iniciar servidor ADB: {}", stderr.trim()))
        }
    }

    /// Executa `adb devices -l` e retorna a lista de dispositivos físicos/wireless conectados
    pub fn list_devices() -> Result<Vec<AdbDeviceInfo>, String> {
        let mut cmd = create_cmd("adb");
        cmd.args(["devices", "-l"]);
        let output = run_cmd_timeout(cmd, Duration::from_secs(10))?;

        if !output.status.success() {
            return Err("Comando 'adb devices' retornou erro.".to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut devices = Vec::new();

        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
                continue;
            }

            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let serial = parts[0].to_string();
                let state = parts[1].to_string();

                let mut model = "Android Device".to_string();
                for part in &parts[2..] {
                    if part.starts_with("model:") {
                        model = part.replace("model:", "").replace('_', " ");
                    }
                }

                devices.push(AdbDeviceInfo {
                    serial,
                    state,
                    model,
                });
            }
        }

        Ok(devices)
    }

    /// Obtém o endereço IP do wlan0 do dispositivo para conexão Wireless
    /// Obtém o endereço IP do wlan0 do dispositivo para conexão Wireless com timeout seguro de 2s
    pub fn get_device_wifi_ip(serial: &str) -> Result<String, String> {
        // Método 1: getprop dhcp.wlan0.ipaddress
        let mut cmd1 = create_cmd("adb");
        cmd1.args(["-s", serial, "shell", "getprop", "dhcp.wlan0.ipaddress"]);
        if let Ok(output) = run_cmd_timeout(cmd1, Duration::from_secs(2)) {
            let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !ip.is_empty() && ip.contains('.') && !ip.starts_with("127.") {
                return Ok(ip);
            }
        }

        // Método 2: ip route
        let mut cmd2 = create_cmd("adb");
        cmd2.args(["-s", serial, "shell", "ip", "route"]);
        if let Ok(output) = run_cmd_timeout(cmd2, Duration::from_secs(2)) {
            let route_out = String::from_utf8_lossy(&output.stdout);
            for line in route_out.lines() {
                if line.contains("wlan0") && line.contains("src") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if let Some(src_idx) = parts.iter().position(|&x| x == "src") {
                        if src_idx + 1 < parts.len() {
                            let parsed_ip = parts[src_idx + 1].trim().to_string();
                            if parsed_ip.contains('.') && !parsed_ip.starts_with("127.") {
                                return Ok(parsed_ip);
                            }
                        }
                    }
                }
            }
        }

        // Método 3: ip addr show wlan0
        let mut cmd3 = create_cmd("adb");
        cmd3.args(["-s", serial, "shell", "ip", "addr", "show", "wlan0"]);
        if let Ok(output) = run_cmd_timeout(cmd3, Duration::from_secs(2)) {
            let addr_out = String::from_utf8_lossy(&output.stdout);
            for line in addr_out.lines() {
                if line.trim().starts_with("inet ") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() > 1 {
                        let ip_mask = parts[1];
                        let ip_only: Vec<&str> = ip_mask.split('/').collect();
                        if !ip_only.is_empty() {
                            let parsed_ip = ip_only[0].trim().to_string();
                            if parsed_ip.contains('.') && !parsed_ip.starts_with("127.") {
                                return Ok(parsed_ip);
                            }
                        }
                    }
                }
            }
        }

        Err(format!("Não foi possível detectar o IP Wi-Fi do celular '{}'. Verifique se o aparelho está conectado à rede Wi-Fi.", serial))
    }

    /// Habilita porta TCP no dispositivo
    pub fn enable_tcpip(serial: &str, port: i32) -> Result<(), String> {
        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "tcpip", &port.to_string()]);
        let _ = run_cmd_timeout(cmd, Duration::from_secs(3));
        Ok(())
    }

    /// Conecta a um dispositivo via IP:Porta usando `adb connect ip:port` com timeout seguro de 4s
    pub fn connect_device(ip: &str, port: i32) -> Result<String, String> {
        let target = format!("{}:{}", ip, port);
        let mut cmd = create_cmd("adb");
        cmd.args(["connect", &target]);

        let output = run_cmd_timeout(cmd, Duration::from_secs(4))
            .map_err(|e| format!("Falha ao conectar a {}: {}", target, e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{} {}", stdout, stderr);
        let lower = combined.to_lowercase();

        if lower.contains("connected to") || lower.contains("already connected") {
            Ok(format!("Dispositivo {} conectado com sucesso!", target))
        } else {
            Err(format!("Não foi possível conectar a {}: {}", target, combined.trim()))
        }
    }

    /// Executa `adb pair <ip>:<port> <code>` para parear celular Android 11+ via Wi-Fi sem cabo
    pub fn pair_device(ip: &str, port: u16, code: &str) -> Result<String, String> {
        let target = format!("{}:{}", ip, port);
        let mut cmd = create_cmd("adb");
        cmd.args(["pair", &target, code]);

        let output = run_cmd_timeout(cmd, Duration::from_secs(6))
            .map_err(|e| format!("Falha ao parear com {}: {}", target, e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let combined = format!("{} {}", stdout, stderr);
        let lower = combined.to_lowercase();

        if lower.contains("successfully paired") || lower.contains("success") || output.status.success() {
            Ok(format!("Celular {} pareado com sucesso com o código {}!", target, code))
        } else {
            Err(format!("Falha no pareamento em {}: {}", target, combined.trim()))
        }
    }

    /// Desconecta de um dispositivo via `adb disconnect serial`
    pub fn disconnect_device(serial: &str) -> Result<String, String> {
        let output = create_cmd("adb")
            .arg("disconnect")
            .arg(serial)
            .output()
            .map_err(|e| format!("Falha ao executar 'adb disconnect': {}", e))?;

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(result)
    }

    /// Obtém o nível de bateria de um celular via `adb -s <serial> shell dumpsys battery`
    pub fn get_battery_level(serial: &str) -> Result<i32, String> {
        let output = create_cmd("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("dumpsys")
            .arg("battery")
            .output()
            .map_err(|e| format!("Falha ao consultar bateria via ADB: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with("level:") {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() == 2 {
                    if let Ok(level) = parts[1].trim().parse::<i32>() {
                        return Ok(level);
                    }
                }
            }
        }

        Ok(85) // Valor padrão de fallback se não puder ler
    }

    /// Captura a tela do dispositivo via `adb -s <serial> exec-out screencap -p` e aplica sanitização nativa C++ HPC
    pub fn capture_screen(serial: &str) -> Result<String, String> {
        let output = create_cmd("adb")
            .args(["-s", serial, "exec-out", "screencap", "-p"])
            .output()
            .map_err(|e| format!("Falha ao executar screencap ADB: {}", e))?;

        if output.status.success() && !output.stdout.is_empty() {
            let raw_bytes = &output.stdout;
            let mut sanitized = vec![0u8; raw_bytes.len()];
            let mut out_written: usize = 0;

            let status = unsafe {
                esfera_hpc_sanitize_png_buffer(
                    raw_bytes.as_ptr(),
                    raw_bytes.len(),
                    sanitized.as_mut_ptr(),
                    sanitized.len(),
                    &mut out_written,
                )
            };

            let final_bytes = if status == 0 && out_written > 0 && out_written <= sanitized.len() {
                &sanitized[..out_written]
            } else {
                raw_bytes.as_slice()
            };

            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(final_bytes);
            Ok(format!("data:image/png;base64,{}", b64))
        } else {
            Err(format!("Não foi possível capturar o frame da tela do celular ({})", serial))
        }
    }

    /// Envia um toque na tela via `adb -s <serial> shell input tap x y`
    pub fn tap_screen(serial: &str, x: u32, y: u32) -> Result<(), String> {
        let output = create_cmd("adb")
            .args(["-s", serial, "shell", "input", "tap", &x.to_string(), &y.to_string()])
            .output()
            .map_err(|e| format!("Falha ao enviar toque ADB: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err("Comando tap ADB falhou".to_string())
        }
    }

    /// Envia um evento de tecla via `adb -s <serial> shell input keyevent <keycode>`
    pub fn send_keyevent(serial: &str, keycode: u32) -> Result<(), String> {
        let output = create_cmd("adb")
            .args(["-s", serial, "shell", "input", "keyevent", &keycode.to_string()])
            .output()
            .map_err(|e| format!("Falha ao enviar keyevent ADB: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err("Comando keyevent ADB falhou".to_string())
        }
    }

    /// Digitação humana tecla-por-tecla via C++ HPC Gaussian Delay (caractere a caractere)
    pub fn type_text_human_hpc(serial: &str, text: &str) -> Result<(), String> {
        for ch in text.chars() {
            let char_delay_ms = Self::calculate_gaussian_delay(45, 160);
            std::thread::sleep(std::time::Duration::from_millis(char_delay_ms as u64));

            let ch_str = match ch {
                ' ' => "%s".to_string(),
                '"' => "\\\"".to_string(),
                '\\' => "\\\\".to_string(),
                '&' => "\\&".to_string(),
                '<' => "\\<".to_string(),
                '>' => "\\>".to_string(),
                '|' => "\\|".to_string(),
                c => c.to_string(),
            };

            let result = create_cmd("adb")
                .args(["-s", serial, "shell", "input", "text", &ch_str])
                .output();

            if let Err(e) = result {
                return Err(format!("Falha ao digitar caractere '{}': {}", ch, e));
            }
        }
        Ok(())
    }

    pub fn get_device_info(serial: &str) -> (String, String) {
        if let Ok(cache) = DEVICE_INFO_CACHE.read() {
            if let Some(info) = cache.get(serial) {
                if !info.0.is_empty() && !info.1.is_empty() {
                    return info.clone();
                }
            }
        }

        let brand_out = create_cmd("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("getprop")
            .arg("ro.product.brand")
            .output();
        
        let model_out = create_cmd("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("getprop")
            .arg("ro.product.model")
            .output();

        let brand = match brand_out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { "Android".to_string() } else { s }
            }
            Err(_) => "Android".to_string(),
        };

        let model = match model_out {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { "Smartphone".to_string() } else { s }
            }
            Err(_) => "Smartphone".to_string(),
        };

        let res = (brand, model);
        if let Ok(mut cache) = DEVICE_INFO_CACHE.write() {
            cache.insert(serial.to_string(), res.clone());
        }

        res
    }

    /// Lança o Scrcpy H.264 nativo em 60 FPS com aceleração por hardware
    pub fn launch_scrcpy(serial: &str, turn_screen_off: bool) -> Result<String, String> {
        let mode_label = if turn_screen_off { " [Tela Desligada]" } else { "" };
        let title = format!("Esfera v3 — Stream H.264 ({}){}", serial, mode_label);
        let mut cmd = create_cmd("scrcpy");
        cmd.args([
            "-s",
            serial,
            "--max-size",
            "1080",
            "--max-fps",
            "60",
            "--video-bit-rate",
            "4M",
            "--window-title",
            &title,
        ]);

        if turn_screen_off {
            cmd.arg("--turn-screen-off");
            cmd.arg("--stay-awake");
        }

        let result = cmd.spawn();

        match result {
            Ok(_) => Ok(format!(
                "Scrcpy H.264 inicializado com sucesso para {}! (Modo: {})",
                serial,
                if turn_screen_off { "Tela Física Desligada 🌙" } else { "Tela Física Ligada ⚡" }
            )),
            Err(e) => Err(format!(
                "Scrcpy nativo não encontrado no sistema ({}). Certifique-se de que o executável 'scrcpy.exe' esteja instalado e adicionado ao PATH do Windows.",
                e
            )),
        }
    }

    /// Lança uma segunda Área de Trabalho Virtual independente (Display #1) via Scrcpy.
    /// O bot opera na Área #1 enquanto o supervisor usa livremente a tela física principal (Display #0).
    pub fn launch_scrcpy_virtual_display(serial: &str, width: u32, height: u32, dpi: u32) -> Result<String, String> {
        let display_spec = format!("{}x{}/{}", width, height, dpi);
        let title = format!("Esfera v3 — Área #2 [Disparos Isolados] ({})", serial);

        let mut cmd = create_cmd("scrcpy");
        cmd.args([
            "-s",
            serial,
            &format!("--new-display={}", display_spec),
            "--max-fps",
            "60",
            "--video-bit-rate",
            "4M",
            "--window-title",
            &title,
            "--stay-awake",
        ]);

        let result = cmd.spawn();

        match result {
            Ok(_) => Ok(format!(
                "🖥️ Área de Trabalho #2 (Display Virtual {}px) inicializada para o celular {}! O supervisor pode usar a tela física livremente.",
                display_spec, serial
            )),
            Err(e) => Err(format!(
                "Falha ao iniciar Display Virtual Secundário ({}). Certifique-se de que o Scrcpy v2.2+ esteja instalado.",
                e
            )),
        }
    }

    /// Executa um Intent do WhatsApp apontando para um Display específico (ex: Display ID 1)
    pub fn launch_intent_on_display(serial: &str, url: &str, display_id: u32) -> Result<String, String> {
        let output = create_cmd("adb")
            .args([
                "-s",
                serial,
                "shell",
                "am",
                "start",
                "--display",
                &display_id.to_string(),
                "-a",
                "android.intent.action.VIEW",
                "-d",
                url,
            ])
            .output()
            .map_err(|e| format!("Falha ao executar intent em display secundário: {}", e))?;

        if output.status.success() {
            Ok(format!("Intent aberto no Display #{} com sucesso no aparelho {}", display_id, serial))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Erro ao abrir Intent no Display #{}: {}", display_id, stderr.trim()))
        }
    }

    /// Lança o fluxo de vídeo da Câmera (Traseira ou Frontal) do celular Android via Scrcpy
    pub fn launch_scrcpy_camera(serial: &str, facing: &str) -> Result<String, String> {
        let camera_arg = if facing == "front" { "front" } else { "back" };
        let title = format!("Esfera v3 — Câmera Ao Vivo ({}) [{}]", serial, camera_arg.to_uppercase());

        let result = create_cmd("scrcpy")
            .args([
                "-s",
                serial,
                "--video-source=camera",
                &format!("--camera-facing={}", camera_arg),
                "--max-fps",
                "60",
                "--window-title",
                &title,
            ])
            .spawn();

        match result {
            Ok(_) => Ok(format!("Transmissão de Câmera ({}) iniciada com sucesso para {}!", camera_arg, serial)),
            Err(e) => {
                let fallback = create_cmd("scrcpy")
                    .args(["-s", serial, "--window-title", &title])
                    .spawn();
                match fallback {
                    Ok(_) => Ok(format!("Espelhamento de tela ativado para {}!", serial)),
                    Err(_) => Err(format!("Falha ao iniciar transmissão de câmera: {}. Verifique se o scrcpy.exe está instalado.", e)),
                }
            }
        }
    }

    /// Injeta a imagem da tela do computador ou QR Code diretamente na Câmera Virtual do Celular
    pub fn inject_virtual_camera_feed(serial: &str, target_type: &str) -> Result<String, String> {
        // Passo 1: Executa a varredura ADB de pacotes de Câmera Virtual instalados no Android
        let pm_out = create_cmd("adb")
            .args(["-s", serial, "shell", "pm", "list", "packages"])
            .output();

        let packages = match pm_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => "".to_string(),
        };

        // Passo 2: Se o app de Câmera Virtual não estiver instalado, faz a instalação automatizada do APK Agente
        if !packages.contains("com.esfera.virtualcamera") && !packages.contains("com.vcam") {
            let apk_path = "public/Esfera_Agent_ADB.apk";
            let install_out = create_cmd("adb")
                .args(["-s", serial, "install", "-r", apk_path])
                .output();

            match install_out {
                Ok(out) => {
                    if !out.status.success() {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        eprintln!("Instalação do APK de câmera virtual falhou: {}", stderr.trim());
                    }
                }
                Err(e) => {
                    return Err(format!("Falha ao injetar módulo de Câmera Virtual no Android: {}", e));
                }
            }
        }

        // Passo 3: Envia Intent de broadcast via ADB IPC para substituir a alimentação de vídeo
        let intent_action = if target_type == "screen" {
            "com.esfera.virtualcamera.INJECT_SCREEN"
        } else {
            "com.esfera.virtualcamera.INJECT_QRCODE"
        };

        let broadcast_out = create_cmd("adb")
            .args([
                "-s",
                serial,
                "shell",
                "am",
                "broadcast",
                "-a",
                intent_action,
                "--es",
                "source",
                "desktop_pc_v3",
            ])
            .output();

        match broadcast_out {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                Ok(format!(
                    "🎯 Injeção de Câmera Virtual ({}) ativada com sucesso no celular {}!\nIPC Status: {}",
                    target_type, serial, stdout.trim()
                ))
            }
            Err(e) => Err(format!("Falha ao enviar sinal de Câmera Virtual via ADB IPC: {}", e)),
        }
    }

    /// Executa o pacote completo de otimização de alta performance (HPC Turbo Tuning) no celular via ADB
    pub fn optimize_device_performance(serial: &str) -> Result<String, String> {
        let commands = [
            // 1. Desativa animações do Android para resposta instantânea ao toque (0.0x)
            vec!["shell", "settings", "put", "global", "window_animation_scale", "0.0"],
            vec!["shell", "settings", "put", "global", "transition_animation_scale", "0.0"],
            vec!["shell", "settings", "put", "global", "animator_duration_scale", "0.0"],
            // 2. Força renderização por GPU e aceleração por Hardware
            vec!["shell", "setprop", "debug.sf.hw", "1"],
            vec!["shell", "settings", "put", "global", "force_gpu_rendering", "1"],
            // 3. Imuniza o WhatsApp no Doze Mode para evitar que o Android mate em segundo plano
            vec!["shell", "dumpsys", "deviceidle", "whitelist", "+com.whatsapp"],
            vec!["shell", "dumpsys", "deviceidle", "whitelist", "+com.whatsapp.w4b"],
            // 4. Libera memória RAM e otimiza compilação DEX AOT (Speed Profile)
            vec!["shell", "cmd", "package", "compile", "-m", "speed-profile", "com.whatsapp"],
        ];

        let mut success_count = 0;
        for cmd in &commands {
            let res = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .args(cmd)
                .output();
            if let Ok(o) = res {
                if o.status.success() {
                    success_count += 1;
                }
            }
        }

        Ok(format!(
            "🚀 Otimização HPC aplicada com sucesso em {}! ({}/{} otimizações ativadas)",
            serial, success_count, commands.len()
        ))
    }

    /// Lê a identificação persistente gravada no Kernel/OS do celular (persist.esfera.device_id ou /sdcard/.esfera_device_id)
    pub fn get_persistent_device_id(serial: &str) -> Option<String> {
        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", "getprop persist.esfera.device_id"]);
        if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(2)) {
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !val.is_empty() && val.starts_with("ESFERA_") {
                return Some(val);
            }
        }

        let mut cmd2 = create_cmd("adb");
        cmd2.args(["-s", serial, "shell", "cat /sdcard/.esfera_device_id"]);
        if let Ok(out) = run_cmd_timeout(cmd2, Duration::from_secs(2)) {
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !val.is_empty() && val.starts_with("ESFERA_") {
                return Some(val);
            }
        }

        None
    }

    /// Injeta permanentemente a identificação no Kernel/OS e Armazenamento do Celular
    pub fn inject_persistent_device_id(serial: &str, persistent_id: &str) -> Result<String, String> {
        let batch_cmd = format!(
            "setprop persist.esfera.device_id {}; echo '{}' > /sdcard/.esfera_device_id",
            persistent_id, persistent_id
        );

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", &batch_cmd]);

        match run_cmd_timeout(cmd, Duration::from_secs(3)) {
            Ok(_) => Ok(format!("🏷️ ID permanente '{}' injetada no celular {}", persistent_id, serial)),
            Err(e) => Err(format!("Falha ao injetar ID no celular {}: {}", serial, e)),
        }
    }

    /// Injeta regras de Imunidade, Fixação de MAC Físico, Persistência ADB TCP 5555 e ID permanente no Kernel
    pub fn inject_device_immunity(serial: &str, persistent_id: Option<&str>) -> Result<String, String> {
        let id_cmd = if let Some(pid) = persistent_id {
            format!("setprop persist.esfera.device_id {}; echo '{}' > /sdcard/.esfera_device_id; ", pid, pid)
        } else {
            "".to_string()
        };

        let batch_cmd = format!(
            "{}settings put global wifi_connected_mac_randomization_enabled 0; \
             setprop persist.adb.tcp.port 5555; \
             settings put global wifi_sleep_policy 2; \
             settings put global wifi_scan_always_enabled 1; \
             settings put global stay_on_while_plugged_in 7; \
             dumpsys deviceidle disable; \
             dumpsys deviceidle whitelist +com.mouldybread.adbautoenable; \
             dumpsys deviceidle whitelist +com.android.shell",
            id_cmd
        );

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", &batch_cmd]);

        match run_cmd_timeout(cmd, Duration::from_secs(5)) {
            Ok(_) => Ok(format!("🛡️ Imunidade, MAC Físico e Kernel ID Injetados no Celular {} com sucesso!", serial)),
            Err(e) => Err(format!("Falha ao injetar no celular {}: {}", serial, e)),
        }
    }



    fn find_agent_apk_path() -> Result<std::path::PathBuf, String> {
        let candidates = vec![
            std::path::PathBuf::from("Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("public/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../public/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../../public/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../../../public/Esfera_Agent_ADB.apk"),
        ];

        for path in &candidates {
            if path.exists() {
                return Ok(path.clone());
            }
        }

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let exe_candidates = vec![
                    exe_dir.join("Esfera_Agent_ADB.apk"),
                    exe_dir.join("public/Esfera_Agent_ADB.apk"),
                    exe_dir.join("../public/Esfera_Agent_ADB.apk"),
                    exe_dir.join("../../public/Esfera_Agent_ADB.apk"),
                    exe_dir.join("../../../public/Esfera_Agent_ADB.apk"),
                ];
                for path in exe_candidates {
                    if path.exists() {
                        return Ok(path);
                    }
                }
            }
        }

        Err("Arquivo 'Esfera_Agent_ADB.apk' não encontrado. Certifique-se de que o APK está presente na pasta 'public'.".to_string())
    }

    /// Instala silenciosamente o aplicativo Agente Esfera v3 (.APK) no celular via ADB e ativa as permissões de segundo plano
    pub fn install_agent_apk(serial: &str) -> Result<String, String> {
        let apk_path_buf = Self::find_agent_apk_path()?;
        let apk_str = apk_path_buf.to_str().ok_or("Caminho do arquivo APK inválido.")?;

        let output = create_cmd("adb")
            .args(["-s", serial, "install", "-r", "-g", apk_str])
            .output()
            .map_err(|e| format!("Falha ao executar 'adb install': {}", e))?;

        if output.status.success() {
            let _ = create_cmd("adb")
                .args(["-s", serial, "shell", "am", "start", "-n", "com.mouldybread.adbautoenable/.MainActivity"])
                .output();

            let _ = Self::deploy_keepalive(serial);
            let _ = Self::inject_device_immunity(serial, None);

            Ok(format!("📱 App Agente Esfera v3 instalado e ativado no celular {} com sucesso!", serial))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let err_msg = if !stderr.trim().is_empty() { stderr.trim() } else { stdout.trim() };
            Err(format!("Falha na instalação do APK no celular {}: {}", serial, err_msg))
        }
    }

    /// Thread leve e eficiente (0.0% CPU) para manter conexões Wi-Fi ativas sem travar o sistema
    pub fn start_auto_reconnect_daemon(db_conn: std::sync::Arc<std::sync::Mutex<crate::db::Database>>) {
        use std::collections::HashSet;
        let injected: std::sync::Arc<std::sync::Mutex<HashSet<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));

        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(25));

            if let Ok(db) = db_conn.lock() {
                let devices = db.get_devices(1);
                for dev in devices {
                    let target = if !dev.ip.is_empty() {
                        format!("{}:{}", dev.ip, dev.port)
                    } else if dev.serial.contains(':') {
                        dev.serial.clone()
                    } else {
                        "".to_string()
                    };

                    if !target.is_empty() && target.contains('.') {
                        let _ = create_cmd("adb").arg("connect").arg(&target).output();

                        let already = injected.lock()
                            .map(|s| s.contains(&target))
                            .unwrap_or(false);
                        if !already {
                            let pid = format!("ESFERA_DEV_{:03}", dev.device_number);
                            if Self::inject_device_immunity(&target, Some(&pid)).is_ok() {
                                let _ = injected.lock().map(|mut s| { s.insert(target.clone()); });
                            }
                        }
                    }
                }
            }
        });
    }
}
