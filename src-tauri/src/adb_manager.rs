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

pub struct AdbManager;

impl AdbManager {
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
            if line.is_empty() || line.starts_with("List of devices") {
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

        Err("Não foi possível detectar o IP Wi-Fi do dispositivo".to_string())
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

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        if result.contains("connected to") || result.contains("already connected") {
            Ok(format!("Dispositivo {} conectado com sucesso!", target))
        } else {
            Err(format!("Falha na conexão ADB: {}", result))
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

    /// Captura a tela do dispositivo via `adb -s <serial> exec-out screencap -p` e retorna Base64 PNG
    pub fn capture_screen(serial: &str) -> Result<String, String> {
        let output = Command::new("adb")
            .args(["-s", serial, "exec-out", "screencap", "-p"])
            .output()
            .map_err(|e| format!("Falha ao executar screencap ADB: {}", e))?;

        if output.status.success() && !output.stdout.is_empty() {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
            Ok(format!("data:image/png;base64,{}", b64))
        } else {
            Err("Não foi possível capturar o frame da tela do celular".to_string())
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
}
