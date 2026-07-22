// ============================================================
// Esfera v3 — Gerenciador ADB Nativo (adb_manager.rs)
// Comunicação nativa com o Android Debug Bridge CLI
// ============================================================

use serde::{Deserialize, Serialize};
use std::process::Command;

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

    /// Varredura multithread de sub-rede na porta 5555
    pub fn scan_subnet(subnet_prefix: &str) -> Vec<String> {
        use std::net::TcpStream;
        use std::time::Duration;
        use std::sync::Mutex;
        use std::sync::Arc;

        let active_ips = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        let prefix = if subnet_prefix.is_empty() { "192.168.1" } else { subnet_prefix.trim_end_matches('.') };

        for i in 1..=254 {
            let ip = format!("{}.{}", prefix, i);
            let active_ips_clone = Arc::clone(&active_ips);
            let handle = std::thread::spawn(move || {
                let addr = format!("{}:5555", ip);
                if let Ok(socket_addr) = addr.parse() {
                    if TcpStream::connect_timeout(&socket_addr, Duration::from_millis(150)).is_ok() {
                        if let Ok(mut ips) = active_ips_clone.lock() {
                            ips.push(ip);
                        }
                    }
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            let _ = handle.join();
        }

        let lock = active_ips.lock().unwrap();
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
        for cmd in commands {
            let _ = Command::new("adb")
                .args(["-s", serial, "shell", cmd])
                .output();
        }
        Ok("Injeção Keep-Alive ADB persistente aplicada no celular com sucesso!".to_string())
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
        if let Ok(output) = Command::new("powershell")
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
        let _ = Command::new("adb")
            .arg("kill-server")
            .output();

        std::thread::sleep(std::time::Duration::from_millis(1000));

        let output = Command::new("adb")
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
        let output = Command::new("adb")
            .arg("devices")
            .arg("-l")
            .output()
            .map_err(|e| format!("Falha ao executar comando adb: {}", e))?;

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
    pub fn get_device_wifi_ip(serial: &str) -> Result<String, String> {
        // Método 1: getprop dhcp.wlan0.ipaddress
        let output = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("getprop")
            .arg("dhcp.wlan0.ipaddress")
            .output()
            .map_err(|e| e.to_string())?;
        
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !ip.is_empty() && ip.contains('.') {
            return Ok(ip);
        }

        // Método 2: ip route
        let output = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("ip")
            .arg("route")
            .output()
            .map_err(|e| e.to_string())?;

        let route_out = String::from_utf8_lossy(&output.stdout);
        for line in route_out.lines() {
            if line.contains("wlan0") && line.contains("src") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(src_idx) = parts.iter().position(|&x| x == "src") {
                    if src_idx + 1 < parts.len() {
                        let parsed_ip = parts[src_idx + 1].trim().to_string();
                        if parsed_ip.contains('.') {
                            return Ok(parsed_ip);
                        }
                    }
                }
            }
        }

        // Método 3: ip addr show wlan0
        let output = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("ip")
            .arg("addr")
            .arg("show")
            .arg("wlan0")
            .output()
            .map_err(|e| e.to_string())?;

        let addr_out = String::from_utf8_lossy(&output.stdout);
        for line in addr_out.lines() {
            if line.trim().starts_with("inet ") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() > 1 {
                    let ip_mask = parts[1];
                    let ip_only: Vec<&str> = ip_mask.split('/').collect();
                    if !ip_only.is_empty() {
                        let parsed_ip = ip_only[0].trim().to_string();
                        if parsed_ip.contains('.') {
                            return Ok(parsed_ip);
                        }
                    }
                }
            }
        }

        // Método 4: ifconfig wlan0
        if let Ok(output) = Command::new("adb").args(["-s", serial, "shell", "ifconfig", "wlan0"]).output() {
            let out = String::from_utf8_lossy(&output.stdout);
            for line in out.lines() {
                if line.contains("inet addr:") {
                    let parts: Vec<&str> = line.split("inet addr:").collect();
                    if parts.len() > 1 {
                        let ip = parts[1].split_whitespace().next().unwrap_or("").trim().to_string();
                        if ip.contains('.') {
                            return Ok(ip);
                        }
                    }
                }
            }
        }

        // Método 5: dumpsys wifi
        if let Ok(output) = Command::new("adb").args(["-s", serial, "shell", "dumpsys", "wifi"]).output() {
            let out = String::from_utf8_lossy(&output.stdout);
            for line in out.lines() {
                if line.contains("ip_address=") {
                    let parts: Vec<&str> = line.split("ip_address=").collect();
                    if parts.len() > 1 {
                        let ip = parts[1].split_whitespace().next().unwrap_or("").trim().to_string();
                        if ip.contains('.') && !ip.starts_with("0.0.0.0") {
                            return Ok(ip);
                        }
                    }
                }
            }
        }

        Err(format!("Não foi possível detectar o IP Wi-Fi do celular '{}'. Verifique se o aparelho está conectado à rede Wi-Fi.", serial))
    }

    /// Habilita porta TCP no dispositivo
    pub fn enable_tcpip(serial: &str, port: i32) -> Result<(), String> {
        let _ = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("tcpip")
            .arg(port.to_string())
            .output()
            .map_err(|e| format!("Falha ao colocar em modo TCP/IP: {}", e))?;
        Ok(())
    }

    /// Conecta a um dispositivo via IP:Porta usando `adb connect ip:port`
    pub fn connect_device(ip: &str, port: i32) -> Result<String, String> {
        let target = format!("{}:{}", ip, port);
        let output = Command::new("adb")
            .arg("connect")
            .arg(&target)
            .output()
            .map_err(|e| format!("Falha ao executar 'adb connect': {}", e))?;

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
        let output = Command::new("adb")
            .arg("pair")
            .arg(&target)
            .arg(code)
            .output()
            .map_err(|e| format!("Falha ao executar 'adb pair': {}", e))?;

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
        let output = Command::new("adb")
            .arg("disconnect")
            .arg(serial)
            .output()
            .map_err(|e| format!("Falha ao executar 'adb disconnect': {}", e))?;

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(result)
    }

    /// Obtém o nível de bateria de um celular via `adb -s <serial> shell dumpsys battery`
    pub fn get_battery_level(serial: &str) -> Result<i32, String> {
        let output = Command::new("adb")
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
        let output = Command::new("adb")
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

            let final_bytes = if status == 0 && out_written > 0 {
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
        let output = Command::new("adb")
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
        let output = Command::new("adb")
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

            let _ = Command::new("adb")
                .args(["-s", serial, "shell", "input", "text", &ch_str])
                .output();
        }
        Ok(())
    }

    pub fn get_device_info(serial: &str) -> (String, String) {
        let brand_out = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("getprop")
            .arg("ro.product.brand")
            .output();
        
        let model_out = Command::new("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("getprop")
            .arg("ro.product.model")
            .output();

        let brand = match brand_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(_) => "Android".to_string(),
        };

        let model = match model_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(_) => "Generic Device".to_string(),
        };

        (brand, model)
    }

    /// Lança o Scrcpy H.264 nativo em 60 FPS com aceleração por hardware
    pub fn launch_scrcpy(serial: &str) -> Result<String, String> {
        let title = format!("Esfera v3 — Stream H.264 ({})", serial);
        let result = Command::new("scrcpy")
            .args([
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
            ])
            .spawn();

        match result {
            Ok(_) => Ok(format!("Scrcpy H.264 inicializado com sucesso para {}!", serial)),
            Err(e) => Err(format!(
                "Scrcpy nativo não encontrado no sistema ({}). Certifique-se de que o executável 'scrcpy.exe' esteja instalado e adicionado ao PATH do Windows.",
                e
            )),
        }
    }

    /// Lança o fluxo de vídeo da Câmera (Traseira ou Frontal) do celular Android via Scrcpy
    pub fn launch_scrcpy_camera(serial: &str, facing: &str) -> Result<String, String> {
        let camera_arg = if facing == "front" { "front" } else { "back" };
        let title = format!("Esfera v3 — Câmera Ao Vivo ({}) [{}]", serial, camera_arg.to_uppercase());

        let result = Command::new("scrcpy")
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
                let fallback = Command::new("scrcpy")
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
        let pm_out = Command::new("adb")
            .args(["-s", serial, "shell", "pm", "list", "packages"])
            .output();

        let packages = match pm_out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => "".to_string(),
        };

        // Passo 2: Se o app de Câmera Virtual não estiver instalado, faz a instalação automatizada do APK Agente
        if !packages.contains("com.esfera.virtualcamera") && !packages.contains("com.vcam") {
            let apk_path = "public/Esfera_Agent_ADB.apk";
            let install_out = Command::new("adb")
                .args(["-s", serial, "install", "-r", apk_path])
                .output();

            if let Err(e) = install_out {
                return Err(format!("Falha ao injetar módulo de Câmera Virtual no Android: {}", e));
            }
        }

        // Passo 3: Envia Intent de broadcast via ADB IPC para substituir a alimentação de vídeo
        let intent_action = if target_type == "screen" {
            "com.esfera.virtualcamera.INJECT_SCREEN"
        } else {
            "com.esfera.virtualcamera.INJECT_QRCODE"
        };

        let broadcast_out = Command::new("adb")
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
            let res = Command::new("adb")
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



    /// Instala silenciosamente o aplicativo Agente Esfera v3 (.APK) no celular via ADB e ativa as permissões de segundo plano
    pub fn install_agent_apk(serial: &str) -> Result<String, String> {
        let apk_path = if std::path::Path::new("Esfera_Agent_ADB.apk").exists() {
            "Esfera_Agent_ADB.apk"
        } else {
            "public/Esfera_Agent_ADB.apk"
        };

        let output = Command::new("adb")
            .args(["-s", serial, "install", "-r", "-g", apk_path])
            .output()
            .map_err(|e| format!("Falha ao executar 'adb install': {}", e))?;

        if output.status.success() {
            let _ = Command::new("adb")
                .args(["-s", serial, "shell", "am", "start", "-n", "com.mouldybread.adbautoenable/.MainActivity"])
                .output();

            let _ = Self::deploy_keepalive(serial);

            Ok(format!("📱 App Agente Esfera v3 instalado e ativado no celular {} com sucesso!", serial))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Falha na instalação do APK no celular: {}", stderr.trim()))
        }
    }

    /// Inicializa a Thread de Reconexão Automática Contínua para que NENHUM celular seja perdido após reinício do servidor
    pub fn start_auto_reconnect_daemon(db_conn: std::sync::Arc<std::sync::Mutex<crate::db::Database>>) {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(12));
            if let Ok(db) = db_conn.lock() {
                let devices = db.get_devices(1);
                for dev in devices {
                    if dev.serial.contains(':') {
                        let _ = Command::new("adb")
                            .arg("connect")
                            .arg(&dev.serial)
                            .output();
                    } else if !dev.ip.is_empty() {
                        let target = format!("{}:{}", dev.ip, dev.port);
                        let _ = Command::new("adb")
                            .arg("connect")
                            .arg(&target)
                            .output();
                    }
                }
            }
        });
    }
}
