// ============================================================
// Esfera v3 — Atendimento pelo Celular (Ponte ADB PA FIXA)
// Gerencia o processo externo `python -m bot.ponte_adb`,
// leitura do log (%LOCALAPPDATA%\pafixa_ponte_adb.log) e
// configuração local (%APPDATA%\esfera_v3\atendimento_celular.json).
// ============================================================

use crate::adb_manager::{bundled_tool_path, AdbDeviceInfo, AdbManager};
use crate::commands::AppState;
use crate::db::Device;
use chrono::{FixedOffset, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

pub const DEFAULT_ROBOT_DIR: &str = r"E:\PAFIXA-ATENDIMENTO";
pub const DEFAULT_PYTHON_PATH: &str =
    r"C:\Users\vicenzzo.palma\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe";
pub const DEFAULT_FALLBACK_ADB: &str = r"D:\Novo\Esfera v3\src-tauri\binaries\adb.exe";
pub const CREATE_NO_WINDOW_FLAG: u32 = 0x08000000;
/// Grupo de processos próprio: Ctrl+C/Ctrl+Break do console do Esfera não chega na ponte.
pub const CREATE_NEW_PROCESS_GROUP_FLAG: u32 = 0x00000200;
/// Sai do Job do Esfera (se houver), para a ponte não morrer quando o Esfera fechar.
pub const CREATE_BREAKAWAY_FROM_JOB_FLAG: u32 = 0x01000000;
const INACTIVE_ALERT_SECONDS: i64 = 600; // 10 minutos
const SAFE_STOP_WAIT_SECONDS: u64 = 60;
const MAX_LOG_READ_BYTES: u64 = 4 * 1024 * 1024; // 4 MB
/// A tela consulta o estado a cada 5 s; o PowerShell da detecção roda no máximo a cada 15 s.
const DETECT_CACHE_MAX_AGE: Duration = Duration::from_secs(15);
const DETECT_TIMEOUT: Duration = Duration::from_secs(25);
/// Quanto tempo depois de iniciar a ponte conferimos se ela não morreu logo de cara.
const START_CHECK_SECONDS: u64 = 5;

/// Ligar e desligar nunca rodam ao mesmo tempo (dois cliques não abrem duas pontes).
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
/// Última detecção de processo (momento, resultado). Também serializa as consultas ao Windows.
static DETECT_CACHE: Mutex<Option<(Instant, Vec<PonteProcessInfo>)>> = Mutex::new(None);

fn lock_lifecycle() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    match LIFECYCLE_LOCK.try_lock() {
        Ok(g) => Ok(g),
        Err(std::sync::TryLockError::Poisoned(p)) => Ok(p.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => Err(
            "Já existe uma operação de ligar/desligar o atendimento em andamento. Aguarde terminar."
                .to_string(),
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AtendimentoCelularConfig {
    #[serde(alias = "robot_dir")]
    pub robot_dir: String,
    #[serde(alias = "python_path")]
    pub python_path: String,
    pub serial: String,
}

impl Default for AtendimentoCelularConfig {
    fn default() -> Self {
        Self {
            robot_dir: DEFAULT_ROBOT_DIR.to_string(),
            python_path: DEFAULT_PYTHON_PATH.to_string(),
            serial: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PonteLaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: PathBuf,
    pub env: HashMap<String, String>,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub creation_flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PonteProcessInfo {
    pub pid: u32,
    pub created_at: String,
    pub name: String,
    pub command_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoLogLine {
    pub timestamp: Option<String>,
    pub kind: String, // "enviada" | "cancelada" | "recebida" | "lista" | "falha" | "sistema" | "info"
    pub text: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoLogSummary {
    pub sent_today: usize,
    pub cancelled_today: usize,
    pub received_today: usize,
    pub failed_today: usize,
    pub last_activity_at: Option<String>,
    pub last_activity_text: Option<String>,
    pub seconds_since_last_activity: Option<i64>,
    pub inactive_alert: bool,
    pub last_list_scan: Option<String>,
    pub last_started_serial: Option<String>,
    pub last_started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoAdbDevice {
    pub serial: String,
    pub name: String,
    pub model: String,
    pub state: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoCelularStatus {
    pub running: bool,
    /// Preenchido quando não foi possível consultar os processos do Windows
    /// (aí `running` não é confiável e ligar fica bloqueado).
    pub detection_error: Option<String>,
    pub pids: Vec<u32>,
    pub started_at: Option<String>,
    pub active_serial: Option<String>,
    pub active_device_name: Option<String>,
    pub config: AtendimentoCelularConfig,
    pub adb_path: String,
    pub summary: AtendimentoLogSummary,
    pub log_lines: Vec<AtendimentoLogLine>,
    pub devices: Vec<AtendimentoAdbDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoLogResponse {
    pub summary: AtendimentoLogSummary,
    pub log_lines: Vec<AtendimentoLogLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoStartResult {
    pub already_running: bool,
    pub status: AtendimentoCelularStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtendimentoStopResult {
    pub stopped: bool,
    pub waited_seconds: u64,
    pub stopped_on_safe_line: bool,
    pub warning: Option<String>,
    pub status: AtendimentoCelularStatus,
}

// ============================================================
// Caminhos e Configuração (%APPDATA%\esfera_v3\atendimento_celular.json)
// ============================================================

pub fn config_file_path() -> PathBuf {
    let mut dir = if let Some(appdata) = std::env::var_os("APPDATA") {
        let mut p = PathBuf::from(appdata);
        p.push("esfera_v3");
        p
    } else {
        PathBuf::from(".")
    };
    let _ = fs::create_dir_all(&dir);
    dir.push("atendimento_celular.json");
    dir
}

pub fn local_app_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn ponte_log_path() -> PathBuf {
    local_app_data_dir().join("pafixa_ponte_adb.log")
}

pub fn resolve_adb_exe_path() -> PathBuf {
    if let Some(p) = bundled_tool_path("adb.exe") {
        return p;
    }
    let fallback = PathBuf::from(DEFAULT_FALLBACK_ADB);
    if fallback.exists() {
        return fallback;
    }
    PathBuf::from("adb.exe")
}

pub fn load_config_from_path(path: &Path) -> AtendimentoCelularConfig {
    let mut cfg = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<AtendimentoCelularConfig>(&content).unwrap_or_default(),
        Err(_) => AtendimentoCelularConfig::default(),
    };
    if cfg.robot_dir.trim().is_empty() {
        cfg.robot_dir = DEFAULT_ROBOT_DIR.to_string();
    }
    if cfg.python_path.trim().is_empty() {
        cfg.python_path = DEFAULT_PYTHON_PATH.to_string();
    }
    cfg
}

pub fn save_config_to_path(path: &Path, config: &AtendimentoCelularConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let normalized = AtendimentoCelularConfig {
        robot_dir: if config.robot_dir.trim().is_empty() {
            DEFAULT_ROBOT_DIR.to_string()
        } else {
            config.robot_dir.trim().to_string()
        },
        python_path: if config.python_path.trim().is_empty() {
            DEFAULT_PYTHON_PATH.to_string()
        } else {
            config.python_path.trim().to_string()
        },
        serial: config.serial.trim().to_string(),
    };
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Falha ao salvar configuração: {}", e))
}

pub fn load_atendimento_config() -> AtendimentoCelularConfig {
    load_config_from_path(&config_file_path())
}

pub fn save_atendimento_config(config: &AtendimentoCelularConfig) -> Result<(), String> {
    save_config_to_path(&config_file_path(), config)
}

// ============================================================
// Regras puras (100% testáveis sem executar a ponte real)
// ============================================================

/// Monta o comando, diretório de trabalho, variáveis de ambiente e redirecionamentos da ponte.
pub fn build_launch_spec(
    config: &AtendimentoCelularConfig,
    serial: &str,
    adb_path: &Path,
    local_app_data: &Path,
) -> Result<PonteLaunchSpec, String> {
    let clean_serial = serial.trim();
    if clean_serial.is_empty() {
        return Err("Escolha um aparelho conectado no ADB antes de ligar o atendimento.".to_string());
    }
    if clean_serial.chars().any(|c| c.is_control() || c == ';' || c == '"' || c == '\'') {
        return Err("Serial do aparelho contém caracteres inválidos.".to_string());
    }

    let robot_dir_str = if config.robot_dir.trim().is_empty() {
        DEFAULT_ROBOT_DIR
    } else {
        config.robot_dir.trim()
    };
    let python_path_str = if config.python_path.trim().is_empty() {
        DEFAULT_PYTHON_PATH
    } else {
        config.python_path.trim()
    };
    // A detecção (e o "só uma ponte") procura processos python*; outro executável escaparia dela
    // e permitiria abrir uma segunda ponte.
    let exe_name = Path::new(python_path_str)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !(exe_name.starts_with("python") && exe_name.ends_with(".exe")) {
        return Err(format!(
            "O caminho do Python deve apontar para um python.exe (recebido: '{}').",
            python_path_str
        ));
    }

    let mut env = HashMap::new();
    env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    env.insert("PONTE_SERIAL".to_string(), clean_serial.to_string());
    env.insert(
        "PONTE_ADB".to_string(),
        adb_path.to_string_lossy().to_string(),
    );

    Ok(PonteLaunchSpec {
        program: PathBuf::from(python_path_str),
        args: vec!["-m".to_string(), "bot.ponte_adb".to_string()],
        current_dir: PathBuf::from(robot_dir_str),
        env,
        stdout_path: local_app_data.join("pafixa_ponte_adb.out.txt"),
        stderr_path: local_app_data.join("pafixa_ponte_adb.err.txt"),
        creation_flags: CREATE_NO_WINDOW_FLAG | CREATE_NEW_PROCESS_GROUP_FLAG,
    })
}

fn is_python_process_name(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    n.starts_with("python") || n == "py.exe" || n == "pyw.exe"
}

/// Analisa a saída do PowerShell (`pid|created_at|name|command_line`) e filtra apenas
/// processos Python (inclusive o lançador do venv) cuja linha de comando contenha `bot.ponte_adb`.
pub fn parse_process_query_output(stdout: &str) -> Vec<PonteProcessInfo> {
    let mut list = Vec::new();
    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, '|');
        let Some(pid_str) = parts.next() else { continue };
        let Some(created_at) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let Some(cmd_line) = parts.next() else { continue };

        let Ok(pid) = pid_str.trim().parse::<u32>() else { continue };
        if !is_python_process_name(name) {
            continue;
        }
        if !cmd_line.contains("bot.ponte_adb") {
            continue;
        }

        list.push(PonteProcessInfo {
            pid,
            created_at: created_at.trim().to_string(),
            name: name.trim().to_string(),
            command_line: cmd_line.trim().to_string(),
        });
    }
    list
}

/// Verifica se uma linha do log indica um ponto seguro para desligar a ponte sem cortar um envio no meio:
/// termina em "ENVIADA", "CANCELADA (...)" ou "adiada 30 min" ou "na fila".
pub fn is_safe_stop_log_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.ends_with("ENVIADA")
        || trimmed.ends_with("adiada 30 min")
        || trimmed.ends_with("na fila")
    {
        return true;
    }
    if let Some(idx) = trimmed.rfind("CANCELADA (") {
        let rest = &trimmed[idx..];
        if rest.ends_with(')') {
            return true;
        }
    }
    false
}

/// Separa uma linha `"AAAA-MM-DD HH:MM:SS mensagem"` em `(Some("AAAA-MM-DD HH:MM:SS"), "mensagem")`.
pub fn split_log_timestamp(line: &str) -> (Option<&str>, &str) {
    let b = line.as_bytes();
    if b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b' '
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b' '
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
        && b[11..13].iter().all(|c| c.is_ascii_digit())
        && b[14..16].iter().all(|c| c.is_ascii_digit())
        && b[17..19].iter().all(|c| c.is_ascii_digit())
    {
        (Some(&line[0..19]), line[20..].trim())
    } else {
        (None, line.trim())
    }
}

pub fn classify_log_message(msg: &str) -> &'static str {
    let trimmed = msg.trim();
    if trimmed.starts_with("fila ") && trimmed.ends_with("ENVIADA") {
        "enviada"
    } else if trimmed.starts_with("fila ") && trimmed.contains("CANCELADA (") && trimmed.ends_with(')') {
        "cancelada"
    } else if trimmed.starts_with("recebida de ") {
        "recebida"
    } else if trimmed.starts_with("lista:") {
        "lista"
    } else if (trimmed.starts_with("fila ") && trimmed.contains("FALHOU:"))
        || trimmed.starts_with("erro:")
        || trimmed.starts_with("AVISO:")
    {
        "falha"
    } else if trimmed.starts_with("ponte ligada no celular ")
        || trimmed.starts_with("ponte parada")
    {
        "sistema"
    } else {
        "info"
    }
}

/// Extrai o serial de uma linha `"ponte ligada no celular <SERIAL>; corte ..."`.
pub fn extract_started_serial(msg: &str) -> Option<String> {
    let prefix = "ponte ligada no celular ";
    let rest = msg.trim().strip_prefix(prefix)?;
    let serial = rest
        .split([';', ' '])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(serial.to_string())
}

/// Fuso horário usado pela ponte (`FUSO = timezone(timedelta(hours=-3))`).
fn brt_offset() -> FixedOffset {
    FixedOffset::west_opt(3 * 3600).unwrap()
}

pub fn parse_brt_timestamp(ts: &str) -> Option<chrono::DateTime<FixedOffset>> {
    let naive = NaiveDateTime::parse_from_str(ts.trim(), "%Y-%m-%d %H:%M:%S").ok()?;
    brt_offset().from_local_datetime(&naive).single()
}

/// Analisa o conteúdo do arquivo `pafixa_ponte_adb.log`, calculando o resumo do dia `today_ymd`
/// (`"AAAA-MM-DD"`) e retornando as últimas `tail_limit` linhas.
pub fn parse_log_content(
    content: &str,
    today_ymd: &str,
    now_brt: chrono::DateTime<FixedOffset>,
    running: bool,
    tail_limit: usize,
) -> (AtendimentoLogSummary, Vec<AtendimentoLogLine>) {
    let mut summary = AtendimentoLogSummary::default();
    let mut parsed_lines: Vec<AtendimentoLogLine> = Vec::new();

    for raw_line in content.lines() {
        let trimmed_raw = raw_line.trim();
        if trimmed_raw.is_empty() {
            continue;
        }
        let (ts_opt, msg) = split_log_timestamp(trimmed_raw);
        let kind = classify_log_message(msg);

        if let Some(ts) = ts_opt {
            summary.last_activity_at = Some(ts.to_string());
            summary.last_activity_text = Some(msg.to_string());

            if let Some(serial) = extract_started_serial(msg) {
                summary.last_started_serial = Some(serial);
                summary.last_started_at = Some(ts.to_string());
            }

            if ts.starts_with(today_ymd) {
                match kind {
                    "enviada" => summary.sent_today += 1,
                    "cancelada" => summary.cancelled_today += 1,
                    "recebida" => summary.received_today += 1,
                    "falha" => summary.failed_today += 1,
                    "lista" => summary.last_list_scan = Some(msg.to_string()),
                    _ => {}
                }
            }
        }

        parsed_lines.push(AtendimentoLogLine {
            timestamp: ts_opt.map(str::to_string),
            kind: kind.to_string(),
            text: msg.to_string(),
            raw: trimmed_raw.to_string(),
        });
    }

    if let Some(ref last_ts) = summary.last_activity_at {
        if let Some(last_dt) = parse_brt_timestamp(last_ts) {
            let diff = now_brt.signed_duration_since(last_dt).num_seconds().max(0);
            summary.seconds_since_last_activity = Some(diff);
            summary.inactive_alert = running && diff > INACTIVE_ALERT_SECONDS;
        }
    } else if running {
        summary.inactive_alert = true;
    }

    let limit = if tail_limit == 0 { 30 } else { tail_limit };
    let tail = if parsed_lines.len() > limit {
        parsed_lines.split_off(parsed_lines.len() - limit)
    } else {
        parsed_lines
    };

    (summary, tail)
}

// ============================================================
// Leitura de arquivo de log, detecção de processo e listagem ADB
// ============================================================

fn read_log_tail_string(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_LOG_READ_BYTES {
        let _ = file.seek(SeekFrom::End(-(MAX_LOG_READ_BYTES as i64)));
    }
    let mut buf = Vec::new();
    let _ = file.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    if len > MAX_LOG_READ_BYTES {
        // Descarta a primeira linha caso tenha sido cortada no meio pelo seek
        if let Some(idx) = text.find('\n') {
            return text[idx + 1..].to_string();
        }
    }
    text
}

/// Script da consulta de processos. Vai em -EncodedCommand (UTF-16LE em base64) para não
/// depender de aspas na linha de comando. A própria consulta não casa com o filtro porque a
/// linha de comando dela fica em base64.
const DETECT_PS_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; \
Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%bot.ponte_adb%'\" | ForEach-Object { \
$d = ''; if ($_.CreationDate) { $d = $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }; \
\"$($_.ProcessId)|$d|$($_.Name)|$($_.CommandLine)\" }";

fn encode_powershell_command(script: &str) -> String {
    use base64::Engine as _;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Consulta o Windows agora. Erro quando a consulta falha: quem chama NÃO pode tratar isso
/// como "desligado" (abriria uma segunda ponte).
fn query_running_ponte() -> Result<Vec<PonteProcessInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::adb_manager::CommandDeadline;
        use std::os::windows::process::CommandExt;

        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encode_powershell_command(DETECT_PS_SCRIPT),
        ]);
        cmd.stdin(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW_FLAG);

        let output = cmd
            .output_timeout(DETECT_TIMEOUT)
            .map_err(|e| format!("Não consegui consultar os processos do Windows: {}", e))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let first = err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            return Err(format!(
                "Não consegui consultar os processos do Windows (código {:?}). {}",
                output.status.code(),
                first
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_process_query_output(&stdout))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// Detecção com cache: `max_age` zero força consulta nova (ligar/desligar sempre usam zero).
pub fn detect_running_ponte(max_age: Duration) -> Result<Vec<PonteProcessInfo>, String> {
    let mut cache = DETECT_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if !max_age.is_zero() {
        if let Some((at, list)) = cache.as_ref() {
            if at.elapsed() < max_age {
                return Ok(list.clone());
            }
        }
    }
    match query_running_ponte() {
        Ok(list) => {
            *cache = Some((Instant::now(), list.clone()));
            Ok(list)
        }
        Err(e) => {
            *cache = None;
            Err(e)
        }
    }
}

/// Mata a ponte inteira: o lançador do venv, o python real e os filhos deles
/// (adb e o túnel ssh) — por isso o /T.
fn kill_ponte_processes(pids: &[u32]) {
    #[cfg(target_os = "windows")]
    {
        use crate::adb_manager::CommandDeadline;
        use std::os::windows::process::CommandExt;

        for pid in pids {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
            cmd.stdin(Stdio::null());
            cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
            let _ = cmd.output_timeout(Duration::from_secs(10));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pids;
    }
}

/// Lê o que foi acrescentado a um arquivo a partir de `offset` (para mostrar o erro da ponte).
fn read_file_from(path: &Path, offset: u64, max_chars: usize) -> String {
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = if len < offset { 0 } else { offset };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let text = text.trim();
    let count = text.chars().count();
    if count > max_chars {
        text.chars().skip(count - max_chars).collect()
    } else {
        text.to_string()
    }
}

/// Combina os aparelhos conectados no ADB (`AdbManager::list_devices()`) com os nomes soberanos
/// cadastrados no banco do Esfera (`ESF_Device`), sem alterar nenhum nome no banco.
pub fn merge_adb_and_esfera_devices(
    adb_list: &[AdbDeviceInfo],
    db_devices: &[Device],
) -> Vec<AtendimentoAdbDevice> {
    let mut out = Vec::new();
    let mut seen_serials = std::collections::HashSet::new();

    let find_db_device = |serial: &str| -> Option<&Device> {
        let s_clean = serial.trim();
        let ip_part = s_clean.split(':').next().unwrap_or("");
        db_devices.iter().find(|d| {
            d.serial.eq_ignore_ascii_case(s_clean)
                || d.current_adb_address
                    .as_deref()
                    .is_some_and(|a| a.eq_ignore_ascii_case(s_clean))
                || (!ip_part.is_empty()
                    && ip_part.contains('.')
                    && !d.ip.trim().is_empty()
                    && d.ip.trim().eq_ignore_ascii_case(ip_part))
        })
    };

    for adb in adb_list {
        let serial = adb.serial.trim();
        if serial.is_empty() || serial.starts_with('*') {
            continue;
        }
        seen_serials.insert(serial.to_ascii_lowercase());
        let matched = find_db_device(serial);
        let name = matched
            .map(|d| d.name.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                matched.and_then(|d| {
                    if d.device_number > 0 {
                        Some(format!("Aparelho {}", d.device_number))
                    } else {
                        None
                    }
                })
            })
            .unwrap_or_else(|| {
                if !adb.model.trim().is_empty() && adb.model != "Android Device" {
                    adb.model.trim().to_string()
                } else {
                    serial.to_string()
                }
            });

        let model = matched
            .map(|d| d.model.trim())
            .filter(|m| !m.is_empty() && *m != "Android Device")
            .map(str::to_string)
            .unwrap_or_else(|| adb.model.clone());

        out.push(AtendimentoAdbDevice {
            serial: serial.to_string(),
            name,
            model,
            state: adb.state.clone(),
            online: adb.state == "device",
        });
    }

    // Ordena: conectados ("device") primeiro, depois por nome
    out.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.serial.cmp(&b.serial))
    });

    out
}

fn authorize_manager(state: &AppState, token: &str) -> Result<crate::session::UserSession, String> {
    let sess = state.sessions.lock().map_err(|e| e.to_string())?;
    if !token.is_empty() {
        if let Some(session) = sess.validate_token(token) {
            if session.role == "master" || session.role == "gestor" {
                return Ok(session);
            }
            return Err(
                "Acesso negado: apenas usuários Master ou Gestor podem acessar o Atendimento pelo Celular."
                    .to_string(),
            );
        }
    }
    Err("Não autorizado: token de sessão inválido ou ausente.".to_string())
}

fn build_current_status(db: &crate::db::Database, detect_max_age: Duration) -> AtendimentoCelularStatus {
    let mut config = load_atendimento_config();
    let (processes, detection_error) = match detect_running_ponte(detect_max_age) {
        Ok(list) => (list, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let running = !processes.is_empty();
    let pids: Vec<u32> = processes.iter().map(|p| p.pid).collect();

    let now_brt = Utc::now().with_timezone(&brt_offset());
    let today_ymd = now_brt.format("%Y-%m-%d").to_string();

    let log_content = read_log_tail_string(&ponte_log_path());
    let (summary, log_lines) = parse_log_content(&log_content, &today_ymd, now_brt, running, 30);

    let adb_list = AdbManager::list_devices().unwrap_or_default();
    let db_devices = db.get_all_devices();
    let devices = merge_adb_and_esfera_devices(&adb_list, &db_devices);

    // Ponte ligada: o serial vem da última linha "ponte ligada no celular X" do log; sem ela, o salvo.
    // (Não chuta o primeiro aparelho da lista: mostraria o celular errado como "em atendimento".)
    let active_serial = if running {
        summary
            .last_started_serial
            .clone()
            .or_else(|| (!config.serial.trim().is_empty()).then(|| config.serial.trim().to_string()))
    } else {
        None
    };

    if config.serial.trim().is_empty() {
        if let Some(ref s) = active_serial.as_ref().or(summary.last_started_serial.as_ref()) {
            config.serial = (*s).clone();
        } else if let Some(first) = devices.iter().find(|d| d.online) {
            config.serial = first.serial.clone();
        }
    }

    let active_device_name = active_serial.as_ref().and_then(|serial| {
        devices
            .iter()
            .find(|d| d.serial.eq_ignore_ascii_case(serial))
            .map(|d| d.name.clone())
            .or_else(|| {
                db_devices
                    .iter()
                    .find(|d| {
                        d.serial.eq_ignore_ascii_case(serial)
                            || d.current_adb_address
                                .as_deref()
                                .is_some_and(|a| a.eq_ignore_ascii_case(serial))
                    })
                    .map(|d| d.name.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
    });

    let started_at = if running {
        processes
            .iter()
            .map(|p| p.created_at.as_str())
            .filter(|s| !s.is_empty())
            .min()
            .map(str::to_string)
            .or_else(|| summary.last_started_at.clone())
    } else {
        None
    };

    AtendimentoCelularStatus {
        running,
        detection_error,
        pids,
        started_at,
        active_serial,
        active_device_name,
        config,
        adb_path: resolve_adb_exe_path().to_string_lossy().to_string(),
        summary,
        log_lines,
        devices,
    }
}

// ============================================================
// Ligar / desligar (processo separado, sobrevive ao fechamento do Esfera)
// ============================================================

/// Abre a ponte como processo independente: sem janela, grupo de processos próprio e, se o
/// Esfera estiver dentro de um Job do Windows, fora dele (senão o Job a mataria junto).
fn spawn_ponte(spec: &PonteLaunchSpec) -> Result<std::process::Child, String> {
    fn try_spawn(spec: &PonteLaunchSpec, flags: u32) -> Result<std::process::Child, String> {
        let out_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spec.stdout_path)
            .map_err(|e| format!("Falha ao abrir arquivo de saída ({}): {}", spec.stdout_path.display(), e))?;
        let err_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spec.stderr_path)
            .map_err(|e| format!("Falha ao abrir arquivo de erros ({}): {}", spec.stderr_path.display(), e))?;

        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.current_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out_file))
            .stderr(Stdio::from(err_file));
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(flags);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = flags;
        }
        cmd.spawn()
            .map_err(|e| format!("Não foi possível iniciar a ponte ADB: {}", e))
    }

    // Sair do Job só é permitido se o Job deixar; se não deixar, o Windows recusa e tentamos sem.
    match try_spawn(spec, spec.creation_flags | CREATE_BREAKAWAY_FROM_JOB_FLAG) {
        Ok(child) => Ok(child),
        Err(_) => try_spawn(spec, spec.creation_flags),
    }
}

/// Recebe os bytes novos do log e devolve (bytes de linhas completas consumidos, achou ponto seguro).
/// Linha incompleta (sem '\n' ainda) fica para a próxima leitura.
pub fn scan_log_chunk(buf: &[u8]) -> (usize, bool) {
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        return (0, false);
    };
    let chunk = String::from_utf8_lossy(&buf[..=last_nl]);
    (last_nl + 1, chunk.lines().any(is_safe_stop_log_line))
}

/// Lê as linhas novas do log a partir de `offset` e diz se alguma marca fim de ação.
fn poll_log_for_safe_line(path: &Path, offset: &mut u64) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0; // log recriado: tudo nele é novo
    }
    if len == *offset || f.seek(SeekFrom::Start(*offset)).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return false;
    }
    let (consumed, found) = scan_log_chunk(&buf);
    *offset += consumed as u64;
    found
}

fn pids_of(list: &[PonteProcessInfo]) -> Vec<u32> {
    list.iter().map(|p| p.pid).collect()
}

// ============================================================
// Comandos Tauri IPC
// ============================================================

#[tauri::command]
pub async fn get_atendimento_celular_status(
    state: State<'_, AppState>,
    token: String,
) -> Result<AtendimentoCelularStatus, String> {
    authorize_manager(&state, &token)?;
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(build_current_status(&db, DETECT_CACHE_MAX_AGE)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_atendimento_celular_log(
    state: State<'_, AppState>,
    token: String,
    limit: Option<usize>,
) -> Result<AtendimentoLogResponse, String> {
    authorize_manager(&state, &token)?;
    tauri::async_runtime::spawn_blocking(move || {
        let running = detect_running_ponte(DETECT_CACHE_MAX_AGE)
            .map(|l| !l.is_empty())
            .unwrap_or(false);
        let now_brt = Utc::now().with_timezone(&brt_offset());
        let today_ymd = now_brt.format("%Y-%m-%d").to_string();
        let log_content = read_log_tail_string(&ponte_log_path());
        let (summary, log_lines) =
            parse_log_content(&log_content, &today_ymd, now_brt, running, limit.unwrap_or(30).min(500));
        Ok(AtendimentoLogResponse { summary, log_lines })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_atendimento_celular_config(
    state: State<'_, AppState>,
    token: String,
    robot_dir: String,
    python_path: String,
    serial: Option<String>,
) -> Result<AtendimentoCelularConfig, String> {
    authorize_manager(&state, &token)?;
    let mut cfg = load_atendimento_config();
    cfg.robot_dir = robot_dir;
    cfg.python_path = python_path;
    if let Some(s) = serial {
        cfg.serial = s;
    }
    save_atendimento_config(&cfg)?;
    Ok(load_atendimento_config())
}

#[tauri::command]
pub async fn start_atendimento_celular(
    state: State<'_, AppState>,
    token: String,
    serial: String,
    robot_dir: Option<String>,
    python_path: Option<String>,
) -> Result<AtendimentoStartResult, String> {
    authorize_manager(&state, &token)?;
    let db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_lifecycle()?;

        let mut cfg = load_atendimento_config();
        if !serial.trim().is_empty() {
            cfg.serial = serial.trim().to_string();
        }
        if let Some(r) = robot_dir {
            if !r.trim().is_empty() {
                cfg.robot_dir = r.trim().to_string();
            }
        }
        if let Some(p) = python_path {
            if !p.trim().is_empty() {
                cfg.python_path = p.trim().to_string();
            }
        }

        let adb_path = resolve_adb_exe_path();
        let local_app_data = local_app_data_dir();
        let spec = build_launch_spec(&cfg, &cfg.serial, &adb_path, &local_app_data)?;
        save_atendimento_config(&cfg)?;

        // Regra crítica: só pode haver UMA ponte. Se não der para consultar, não liga.
        let existing = detect_running_ponte(Duration::ZERO).map_err(|e| {
            format!(
                "{} Por segurança o atendimento não foi ligado (poderia abrir uma segunda ponte).",
                e
            )
        })?;
        if !existing.is_empty() {
            return Ok(AtendimentoStartResult {
                already_running: true,
                status: build_current_status(&db, DETECT_CACHE_MAX_AGE),
            });
        }

        if !spec.program.exists() {
            return Err(format!(
                "Executável do Python não encontrado em '{}'. Verifique o caminho configurado.",
                spec.program.display()
            ));
        }
        if !spec.current_dir.join("bot").join("ponte_adb.py").is_file() {
            return Err(format!(
                "Não achei bot\\ponte_adb.py dentro de '{}'. Verifique a pasta do robô.",
                spec.current_dir.display()
            ));
        }

        let err_offset = fs::metadata(&spec.stderr_path).map(|m| m.len()).unwrap_or(0);
        let mut child = spawn_ponte(&spec)?;

        // Confere se a ponte não fechou logo de cara (celular fora do ADB, erro de Python...).
        let check_until = Instant::now() + Duration::from_secs(START_CHECK_SECONDS);
        while Instant::now() < check_until {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    if let Ok(mut c) = DETECT_CACHE.lock() {
                        *c = None;
                    }
                    let err_text = read_file_from(&spec.stderr_path, err_offset, 600);
                    return Err(format!(
                        "A ponte fechou logo ao iniciar (código {}). {}",
                        exit.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                        if err_text.is_empty() {
                            "Veja %LOCALAPPDATA%\\pafixa_ponte_adb.err.txt.".to_string()
                        } else {
                            err_text
                        }
                    ));
                }
                Ok(None) => {}
                Err(_) => break,
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        // `child` é solto aqui sem matar: no Windows isso só fecha o handle e a ponte segue viva.
        drop(child);

        Ok(AtendimentoStartResult {
            already_running: false,
            status: build_current_status(&db, Duration::ZERO),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_atendimento_celular(
    state: State<'_, AppState>,
    token: String,
) -> Result<AtendimentoStopResult, String> {
    authorize_manager(&state, &token)?;
    let db = state.db.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_lifecycle()?;

        let initial = detect_running_ponte(Duration::ZERO)
            .map_err(|e| format!("{} Nada foi encerrado.", e))?;
        if initial.is_empty() {
            return Ok(AtendimentoStopResult {
                stopped: true,
                waited_seconds: 0,
                stopped_on_safe_line: true,
                warning: None,
                status: build_current_status(&db, DETECT_CACHE_MAX_AGE),
            });
        }
        let mut pids = pids_of(&initial);

        let log_path = ponte_log_path();
        let mut offset = fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
        let start_instant = Instant::now();
        let deadline = Duration::from_secs(SAFE_STOP_WAIT_SECONDS);
        let mut last_proc_check = Instant::now();
        let mut safe_line = false;
        let mut ended_alone = false;

        // Lê o log a cada 300 ms (reação rápida ao fim do envio); confere os processos a cada 5 s.
        while start_instant.elapsed() < deadline {
            if poll_log_for_safe_line(&log_path, &mut offset) {
                safe_line = true;
                break;
            }
            if last_proc_check.elapsed() >= Duration::from_secs(5) {
                last_proc_check = Instant::now();
                if let Ok(list) = detect_running_ponte(Duration::ZERO) {
                    if list.is_empty() {
                        ended_alone = true;
                        break;
                    }
                    for pid in pids_of(&list) {
                        if !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        let waited_seconds = start_instant.elapsed().as_secs().min(SAFE_STOP_WAIT_SECONDS);

        if !ended_alone {
            kill_ponte_processes(&pids);
        }

        // Confirma que morreu (lançador do venv + python real); se sobrou algo, tenta de novo.
        std::thread::sleep(Duration::from_millis(400));
        let mut remaining = detect_running_ponte(Duration::ZERO);
        if let Ok(list) = &remaining {
            if !list.is_empty() {
                kill_ponte_processes(&pids_of(list));
                std::thread::sleep(Duration::from_millis(800));
                remaining = detect_running_ponte(Duration::ZERO);
            }
        }

        let stopped = matches!(&remaining, Ok(list) if list.is_empty());
        let warning = match &remaining {
            Ok(list) if !list.is_empty() => Some(format!(
                "Mandei encerrar a ponte, mas ela ainda aparece rodando (PID {}). Feche pelo Gerenciador de Tarefas.",
                pids_of(list)
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            Err(e) => Some(format!(
                "Mandei encerrar a ponte, mas não consegui confirmar se ela fechou: {}",
                e
            )),
            _ if !safe_line && !ended_alone => Some(
                "A ponte não registrou fim de ação em 60 s e foi encerrada mesmo assim. Confira se a última mensagem foi enviada por completo."
                    .to_string(),
            ),
            _ => None,
        };

        Ok(AtendimentoStopResult {
            stopped,
            waited_seconds,
            stopped_on_safe_line: safe_line || ended_alone,
            warning,
            status: build_current_status(&db, DETECT_CACHE_MAX_AGE),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================
// Testes Unitários (Sem tocar na ponte em produção)
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_safe_stop_log_line() {
        assert!(is_safe_stop_log_line(
            "2026-11-06 13:20:01 fila 981 -> 5547999999999 COBRANCA: ENVIADA"
        ));
        assert!(is_safe_stop_log_line(
            "2026-11-06 13:20:05 fila 982 -> 5547999999999 PEDIR_DOCUMENTO: CANCELADA (devedor já mandou o CPF/CNPJ)"
        ));
        assert!(is_safe_stop_log_line(
            "2026-11-06 13:20:10 fila 983: só LID (123456@lid) — adiada 30 min"
        ));
        assert!(is_safe_stop_log_line(
            "2026-11-06 13:20:15 recebida de 5547999999999 (13:19): 'ok' -> robô 1 na fila"
        ));

        assert!(!is_safe_stop_log_line(
            "2026-11-06 13:20:20 lista: 42 conversas (fim da lista); 3 para ler agora; 39 já respondidas por nós"
        ));
        assert!(!is_safe_stop_log_line(
            "2026-11-06 13:20:25 ponte ligada no celular ZT322LCLQ6; corte 2026-11-03T00:00:00-03:00"
        ));
        assert!(!is_safe_stop_log_line(
            "2026-11-06 13:20:30 fila 984 -> 5547999999999 COBRANCA: FALHOU: conversa não abriu"
        ));
        assert!(!is_safe_stop_log_line(""));
    }

    #[test]
    fn test_parse_log_content_summary_and_tail() {
        let log_sample = "\
2026-11-05 18:00:00 fila 10 -> 5511999990000 M1: ENVIADA
2026-11-06 09:00:00 ponte ligada no celular ZT322LCLQ6; corte 2026-11-03T00:00:00-03:00
2026-11-06 09:01:10 lista: 18 conversas (chegou no corte); 2 para ler agora; 16 já respondidas por nós
2026-11-06 09:02:00 recebida de 5511988887777 (09:01): 'bom dia' -> robô 1 na fila
2026-11-06 09:03:00 recebida de 5511977776666 (09:02): '12345678909' -> robô 1 na fila
2026-11-06 09:04:15 fila 11 -> 5511988887777 PEDIR_DOCUMENTO: ENVIADA
2026-11-06 09:05:30 fila 12 -> 5511977776666 PEDIR_DOCUMENTO: CANCELADA (devedor já mandou o CPF/CNPJ)
2026-11-06 09:06:00 fila 13 -> 5511966665555 COBRANCA: ENVIADA
";
        // Simula 09:10:00 do dia 2026-11-06 (4 min desde a última linha -> sem alerta)
        let now_ok = parse_brt_timestamp("2026-11-06 09:10:00").unwrap();
        let (summary, lines) = parse_log_content(log_sample, "2026-11-06", now_ok, true, 30);

        assert_eq!(summary.sent_today, 2); // só as de 2026-11-06
        assert_eq!(summary.cancelled_today, 1);
        assert_eq!(summary.received_today, 2);
        assert_eq!(summary.failed_today, 0);
        assert_eq!(summary.last_started_serial.as_deref(), Some("ZT322LCLQ6"));
        assert_eq!(summary.last_started_at.as_deref(), Some("2026-11-06 09:00:00"));
        assert_eq!(summary.last_activity_at.as_deref(), Some("2026-11-06 09:06:00"));
        assert_eq!(summary.seconds_since_last_activity, Some(240));
        assert!(!summary.inactive_alert);
        assert_eq!(lines.len(), 8);

        // Simula 09:20:00 do mesmo dia (14 min sem linha nova com a ponte ligada -> alerta ativo)
        let now_stale = parse_brt_timestamp("2026-11-06 09:20:00").unwrap();
        let (summary_stale, tail_3) = parse_log_content(log_sample, "2026-11-06", now_stale, true, 3);
        assert!(summary_stale.inactive_alert);
        assert_eq!(tail_3.len(), 3);
    }

    #[test]
    fn test_build_launch_spec() {
        let cfg = AtendimentoCelularConfig::default();
        let adb = PathBuf::from(r"D:\Novo\Esfera v3\src-tauri\binaries\adb.exe");
        let local = PathBuf::from(r"C:\Users\vicenzzo.palma\AppData\Local");

        let spec = build_launch_spec(&cfg, "ZT322LCLQ6", &adb, &local).expect("spec válida");
        assert_eq!(spec.program, PathBuf::from(DEFAULT_PYTHON_PATH));
        assert_eq!(spec.args, vec!["-m", "bot.ponte_adb"]);
        assert_eq!(spec.current_dir, PathBuf::from(DEFAULT_ROBOT_DIR));
        assert_eq!(
            spec.env.get("PYTHONIOENCODING").map(String::as_str),
            Some("utf-8")
        );
        assert_eq!(
            spec.env.get("PONTE_SERIAL").map(String::as_str),
            Some("ZT322LCLQ6")
        );
        assert_eq!(
            spec.env.get("PONTE_ADB").map(String::as_str),
            Some(r"D:\Novo\Esfera v3\src-tauri\binaries\adb.exe")
        );
        assert_eq!(
            spec.stdout_path,
            local.join("pafixa_ponte_adb.out.txt")
        );
        assert_eq!(
            spec.stderr_path,
            local.join("pafixa_ponte_adb.err.txt")
        );
        assert_ne!(spec.creation_flags & CREATE_NO_WINDOW_FLAG, 0);
        assert_ne!(spec.creation_flags & CREATE_NEW_PROCESS_GROUP_FLAG, 0);
        // DETACHED_PROCESS anularia o CREATE_NO_WINDOW (o venv abriria console visível)
        assert_eq!(spec.creation_flags & 0x00000008, 0);

        // Serial vazio deve falhar
        assert!(build_launch_spec(&cfg, "   ", &adb, &local).is_err());

        // Executável que não é python escaparia da detecção ("só uma ponte")
        let mut cfg_ruim = AtendimentoCelularConfig::default();
        cfg_ruim.python_path = r"C:\Windows\System32\cmd.exe".to_string();
        assert!(build_launch_spec(&cfg_ruim, "ZT322LCLQ6", &adb, &local).is_err());
        cfg_ruim.python_path = r"C:\Python311\pythonw.exe".to_string();
        assert!(build_launch_spec(&cfg_ruim, "ZT322LCLQ6", &adb, &local).is_ok());
    }

    #[test]
    fn test_scan_log_chunk_espera_linha_completa() {
        // Linha segura ainda sem '\n': não conta e não é consumida
        let parcial = "2026-11-06 13:20:01 fila 9 -> 5547999999999 COBRANCA: ENVI".as_bytes();
        assert_eq!(scan_log_chunk(parcial), (0, false));

        let texto = "2026-11-06 13:20:00 lista: 3 conversas; 1 para ler agora\n\
2026-11-06 13:20:01 fila 9 -> 5547999999999 COBRANÇA: ENVIADA\n\
2026-11-06 13:20:02 recebida de 55479";
        let (consumido, achou) = scan_log_chunk(texto.as_bytes());
        assert!(achou);
        // Consome até o último '\n'; a linha "recebida de 55479" (incompleta) fica para depois
        assert_eq!(consumido, texto.rfind('\n').unwrap() + 1);

        let sem_ponto = "2026-11-06 13:20:00 lista: 3 conversas; 1 para ler agora\n";
        assert_eq!(scan_log_chunk(sem_ponto.as_bytes()), (sem_ponto.len(), false));
    }

    #[test]
    fn test_encoded_command_e_utf16le_base64() {
        use base64::Engine as _;
        let enc = encode_powershell_command("Get-Date");
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "Get-Date");
        // O script de detecção não pode conter o texto procurado fora do filtro LIKE
        assert_eq!(DETECT_PS_SCRIPT.matches("bot.ponte_adb").count(), 1);
    }

    #[test]
    fn test_parse_process_query_output() {
        let sample = "\
23664|2026-11-06 13:27:13|python.exe|\"C:\\Users\\vicenzzo.palma\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe\" -m bot.ponte_adb 
22372|2026-11-06 13:27:13|python.exe|\"C:\\Users\\vicenzzo.palma\\AppData\\Roaming\\uv\\python\\cpython-3.11-windows-x86_64-none\\python.exe\"  -m bot.ponte_adb 
21404|2026-11-06 13:27:15|powershell.exe|powershell -Command Get-CimInstance bot.ponte_adb
9999|2026-11-06 13:00:00|python.exe|python outro_script.py
8888||py.exe|py -m bot.ponte_adb
7777|2026-11-06 13:00:00|cmd.exe|cmd /c python -m bot.ponte_adb
";
        let procs = parse_process_query_output(sample);
        assert_eq!(procs.len(), 3);
        assert_eq!(procs[0].pid, 23664);
        assert_eq!(procs[0].created_at, "2026-11-06 13:27:13");
        assert_eq!(procs[1].pid, 22372);
        assert_eq!(procs[2].pid, 8888);
        assert_eq!(procs[2].created_at, "");
    }

    /// Só consulta processos (não inicia nem para nada). Rodar à mão:
    /// cargo test --lib -j 1 atendimento_celular -- --ignored
    #[test]
    #[ignore]
    fn consulta_real_de_processos_somente_leitura() {
        let list = query_running_ponte().expect("consulta ao Windows deve funcionar");
        for p in &list {
            assert!(is_python_process_name(&p.name));
            assert!(p.command_line.contains("bot.ponte_adb"));
        }
        eprintln!("pontes encontradas: {:?}", list.iter().map(|p| (p.pid, &p.name)).collect::<Vec<_>>());
    }

    #[test]
    fn test_merge_adb_and_esfera_devices_preserves_operator_name() {
        let adb_list = vec![
            AdbDeviceInfo {
                serial: "ZT322LCLQ6".to_string(),
                state: "device".to_string(),
                model: "moto g34 5G".to_string(),
            },
            AdbDeviceInfo {
                serial: "ABC999".to_string(),
                state: "device".to_string(),
                model: "SM A155M".to_string(),
            },
        ];
        let db_devices = vec![Device {
            id: 1,
            serial: "ZT322LCLQ6".to_string(),
            name: "PA Fixa Maiara".to_string(),
            brand: "motorola".to_string(),
            model: "moto g34 5G".to_string(),
            ip: String::new(),
            port: 5555,
            status: "online".to_string(),
            battery: 90,
            company_id: 1,
            device_number: 5,
            sector: "pa_fixa".to_string(),
            esfera_device_id: Some("HW1".to_string()),
            current_adb_address: Some("ZT322LCLQ6".to_string()),
            last_seen_utc: None,
            via_tunnel: false,
        }];

        let merged = merge_adb_and_esfera_devices(&adb_list, &db_devices);
        assert_eq!(merged.len(), 2);
        let maiara = merged.iter().find(|d| d.serial == "ZT322LCLQ6").unwrap();
        assert_eq!(maiara.name, "PA Fixa Maiara");
        assert!(maiara.online);
    }
}
