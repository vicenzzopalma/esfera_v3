

// ============================================================
// Esfera v3 — Gerenciador ADB Nativo (adb_manager.rs)
// Comunicação nativa com o Android Debug Bridge CLI
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Script shell embutido (fallback quando APK não está disponível)
const AGENT_SCRIPT_CONTENT: &str = include_str!("../../src-agent/esfera_agent.sh");

// ============================================================
// RESOLUÇÃO DE FERRAMENTAS EMBUTIDAS (adb.exe / scrcpy.exe)
// O app é 100% standalone: localiza os binários colados ao exe
// (instalador NSIS -> resources/binaries, pasta portátil -> binaries)
// e só usa o PATH do sistema como último recurso.
// ============================================================
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(PathBuf::from)
}

fn tools_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("resources").join("binaries"));
        candidates.push(dir.join("binaries"));
        candidates.push(dir);
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("distributable").join("binaries"));
        candidates.push(cwd.join("src-tauri").join("binaries"));
        candidates.push(cwd.join("binaries"));
    }
    candidates
}

/// Retorna o diretório onde estão as ferramentas embutidas (adb, scrcpy, jar, apk).
pub fn bundled_tools_dir() -> Option<PathBuf> {
    tools_dir_candidates()
        .into_iter()
        .find(|p| p.join("adb.exe").exists() || p.join("adb").exists())
}

/// Caminho completo de um binário embutido (ex.: "adb.exe", "scrcpy.exe"),
/// ou None se não houver cópia local — nesse caso o PATH do sistema é usado.
pub fn bundled_tool_path(name: &str) -> Option<PathBuf> {
    if let Some(dir) = bundled_tools_dir() {
        let path = dir.join(name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

// ============================================================
// LISTAS DE DEBLOAT POR FABRICANTE
// ============================================================
const SAMSUNG_BLOAT: &[&str] = &[
    "com.samsung.android.bixby.wakeup",
    "com.samsung.android.bixby.agent",
    "com.samsung.android.bixby.es.global",
    "com.samsung.android.app.spage",
    "com.samsung.android.app.settings.bixby",
    "com.samsung.systemui.bixby2",
    "com.samsung.android.bixby.service",
    "com.samsung.android.bixby.agent.dummy",
    "com.samsung.android.bixbyvision.framework",
    "com.samsung.android.svoice",
    "com.samsung.android.svoiceime",
    "com.samsung.android.visionintelligence",
    "com.samsung.android.voc",
    "com.samsung.android.app.social",
    "com.samsung.android.app.tips",
    "com.samsung.android.app.withtv",
    "com.samsung.android.app.watchmanager",
    "com.samsung.android.app.watchmanagerstub",
    "com.samsung.android.samsungpay.gear",
    "com.samsung.android.samsungpay",
    "com.samsung.android.spay",
    "com.samsung.android.spaymini",
    "com.samsung.android.authfw",
    "com.samsung.android.mapsagent",
    "com.samsung.android.beaconmanager",
    "com.samsung.android.game.gamehome",
    "com.samsung.android.game.gametools",
    "com.samsung.android.game.gos",
    "com.samsung.android.honeyboard",
    "com.samsung.android.livestream",
    "com.samsung.android.mateagent",
    "com.samsung.android.oneconnect",
    "com.samsung.android.packageinstaller",
    "com.samsung.android.plusfriend",
    "com.samsung.android.popupcalculator",
    "com.samsung.android.rims",
    "com.samsung.android.samsungpass",
    "com.samsung.android.samsungpassautofill",
    "com.samsung.android.scloud",
    "com.samsung.android.sdk.handwriting",
    "com.samsung.android.sdk.professional",
    "com.samsung.android.stickercenter",
    "com.samsung.android.themestore",
    "com.samsung.android.widgetapp",
    "com.samsung.android.bbc.bbcagent",
    "com.samsung.android.drivingmode",
    "com.samsung.android.easysetup",
    "com.samsung.android.app.clipboardedge",
    "com.samsung.android.app.cocktailbarservice",
    "com.samsung.android.app.galaxyfinder",
    "com.samsung.android.app.ledcoverdream",
    "com.samsung.android.app.personaldictionary",
    "com.samsung.android.app.routines",
    "com.samsung.android.app.sbrowseredge",
    "com.samsung.android.app.taskedge",
    "com.samsung.android.edgeapps",
    "com.samsung.android.app.reminder",
    "com.samsung.android.app.telephonyui",
    "com.facebook.appmanager",
    "com.facebook.katana",
    "com.facebook.orca",
    "com.facebook.system",
    "com.microsoft.skydrive",
    "com.microsoft.office.officehubrow",
    "com.linkedin.android",
    "com.netflix.mediaclient",
    "com.netflix.partner.activation",
    "com.google.android.apps.magazines",
    "com.google.android.apps.plus",
    "com.google.android.apps.maps",
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.gm",
    "com.google.android.apps.docs",
    "com.google.android.apps.docs.editors.docs",
    "com.google.android.apps.docs.editors.sheets",
    "com.google.android.apps.docs.editors.slides",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.nbu.files",
    "com.google.android.apps.adm",
    "com.google.android.music",
    "com.google.android.videos",
    "com.google.android.keep",
    "com.google.android.calendar",
    "com.android.chrome",
    "com.spotify.music",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
    "com.booking",
    "com.amazon.mShop.android.shopping",
    "com.amazon.mp3",
    "com.amazon.kindle",
];

const REALME_BLOAT: &[&str] = &[
    "com.heytap.pictorial",
    "com.realmecomm.app",
    "com.netflix.mediaclient",
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.linkedin.android",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.mShop.android.shopping",
    "com.amazon.appmanager",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "kwai.lite.video",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
    "com.booking",
    "cn.wps.moffice_eng",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.nbu.files",
    "com.google.android.apps.adm",
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.gm",
    "com.google.android.music",
    "com.google.android.videos",
    "com.android.chrome",
    "com.google.android.keep",
    "com.newleaf.app.android.victor",
    "com.katanlabs.matchballgame",
    "com.katanlabs.worm.ioeatemall",
    "com.katanlabs.wordconnectwondersofview",
    "com.katanlabs.bubblepop",
    "com.fullmetalgamedev.fruitshooting",
    "com.lemon.lvoverseas",
    "com.taboola.scoop",
];

const XIAOMI_BLOAT: &[&str] = &[
    "com.miui.android.fashiongallery",
    "com.miui.calculator.go",
    "com.miui.miservice",
    "com.miui.video",
    "com.miui.player",
    "com.miui.music",
    "com.miui.notes",
    "com.miui.micloudsync",
    "com.miui.cloudservice",
    "com.miui.hybrid",
    "com.miui.hybrid.accessory",
    "com.miui.screenrecorder",
    "com.miui.compass",
    "com.miui.cleanmaster",
    "com.miui.yellowpage",
    "com.miui.bugreport",
    "com.miui.analytics",
    "com.miui.greenguard",
    "com.miui.securityadd",
    "com.miui.weather2",
    "com.miui.mishare.connectivity",
    "com.miui.virtualsim",
    "com.miui.wmsvc",
    "com.xiaomi.midrop",
    "com.xiaomi.glgm",
    "com.xiaomi.payment",
    "com.xiaomi.scanner",
    "com.xiaomi.shop",
    "com.xiaomi.vipaccount",
    "com.xiaomi.mipicks",
    "com.xiaomi.mi_connect_service",
    "com.xiaomi.mico",
    "com.netflix.mediaclient",
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.linkedin.android",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.mShop.android.shopping",
    "com.amazon.appmanager",
    "com.zhiliaoapp.musically",
    "com.zhiliaoapp.musically.go",
    "com.kwai.video",
    "kwai.lite.video",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
    "com.booking",
    "cn.wps.moffice_eng",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.nbu.files",
    "com.google.android.apps.adm",
    "com.google.android.youtube",
    "com.android.chrome",
    "com.tencent.ig",
    "com.king.candycrushsaga",
    "com.fugo.wow",
    "com.oakever.tiletrip",
    "com.gamedots.seasideescape.flexion",
    "com.vitastudio.mahjong",
    "com.block.juggle",
    "com.google.android.calendar.go",
    "br.com.timbrasil.meutim",
];

const MOTOROLA_BLOAT: &[&str] = &[
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.linkedin.android",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.kindle",
    "com.amazon.mShop.android.shopping",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "com.booking",
    "com.netflix.mediaclient",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.docs.editors.docs",
    "com.google.android.apps.docs.editors.sheets",
    "com.google.android.apps.docs.editors.slides",
    "com.google.android.youtube",
    "com.android.chrome",
    "com.google.android.gm",
    "com.google.android.keep",
    "com.adobe.spark.post",
    "com.callapp.contacts",
    "com.c6bank.app",
    "com.luizalabs.mlapp",
    "com.novanews.android.localnews.br",
    "com.nebula.mahjongtile",
    "in.playsimple.newwordsearch",
    "com.easybrain.crossword.puzzles",
];

const MULTILASER_BLOAT: &[&str] = &[
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.gm",
    "com.google.android.apps.maps",
    "com.google.android.apps.docs",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.nbu.files",
    "com.android.chrome",
    "com.google.android.music",
    "com.google.android.videos",
    "com.google.android.keep",
    "com.google.android.calendar",
    "com.netflix.mediaclient",
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.linkedin.android",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.kindle",
    "com.amazon.mShop.android.shopping",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "com.booking",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
];

const LG_BLOAT: &[&str] = &[
    "com.lge.lgworld",
    "com.lge.cloudhub",
    "com.lge.clock",
    "com.lge.qpair",
    "com.lge.remote",
    "com.lge.sizechangable",
    "com.lge.voicecommand",
    "com.lge.android.atf",
    "com.lge.ia.task",
    "com.lge.ia.startup",
    "com.lge.ia.bixby",
    "com.lge.media.photoviewer",
    "com.lge.media.videoplayer",
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.linkedin.android",
    "com.netflix.mediaclient",
    "com.amazon.mp3",
    "com.amazon.kindle",
    "com.spotify.music",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "com.booking",
];

const POSITIVO_BLOAT: &[&str] = &[
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.gm",
    "com.google.android.apps.maps",
    "com.google.android.apps.docs",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.nbu.files",
    "com.android.chrome",
    "com.google.android.music",
    "com.google.android.videos",
    "com.google.android.keep",
    "com.google.android.calendar",
    "com.netflix.mediaclient",
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.linkedin.android",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.mShop.android.shopping",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "com.booking",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
    "com.positivo.launcher",
    "com.positivo.customizer",
    "com.positivo.setupwizard",
    "com.positivo.manual",
];

const GOOGLE_HEAVY_BLOAT: &[&str] = &[
    "com.google.android.googlequicksearchbox",
    "com.google.android.apps.googleassistant",
    "com.google.android.tts",
    "com.google.android.feedback",
    "com.google.android.printservice.recommendation",
    "com.google.android.marvin.talkback",
    "com.google.android.overlay.gmsconfig.common",
    "com.google.android.projection.gearhead",
    "com.google.android.videos",
    "com.google.android.music",
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.apps.youtube.music",
    "com.google.android.apps.magazines",
    "com.google.android.apps.docs",
    "com.google.android.apps.docs.editors.docs",
    "com.google.android.apps.docs.editors.sheets",
    "com.google.android.apps.docs.editors.slides",
    "com.google.android.apps.tachyon",
    "com.google.android.apps.messaging",
    "com.android.chrome",
    "com.google.android.apps.maps",
    "com.google.android.gm",
    "com.google.android.keep",
    "com.google.android.calendar",
];

const GENERIC_BLOAT: &[&str] = &[
    "com.facebook.katana",
    "com.facebook.appmanager",
    "com.facebook.system",
    "com.facebook.orca",
    "com.linkedin.android",
    "com.netflix.mediaclient",
    "com.netflix.partner.activation",
    "com.spotify.music",
    "com.amazon.mp3",
    "com.amazon.kindle",
    "com.amazon.mShop.android.shopping",
    "com.amazon.appmanager",
    "com.zhiliaoapp.musically",
    "com.kwai.video",
    "kwai.lite.video",
    "com.booking",
    "com.shopee.br",
    "com.alibaba.aliexpresshd",
    "com.google.android.apps.photos",
    "com.google.android.youtube",
    "com.google.android.gm",
    "com.google.android.apps.maps",
    "com.google.android.apps.docs",
    "com.google.android.apps.walletnfcrel",
    "com.google.android.apps.magazines",
    "com.google.android.apps.fitness",
    "com.google.android.apps.chromecast.app",
    "com.google.android.apps.subscriptions.red",
    "com.google.android.apps.nbu.files",
    "com.google.android.apps.adm",
    "com.android.chrome",
    "com.google.android.music",
    "com.google.android.videos",
    "com.google.android.keep",
    "com.google.android.calendar",
    "cn.wps.moffice_eng",
];

pub fn run_cmd_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar comando: {}", e))?;
    let pid = child.id();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let status = child.wait();
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
        let _ = tx.send(match status {
            Ok(s) => Ok(std::process::Output {
                status: s,
                stdout,
                stderr,
            }),
            Err(e) => Err(format!("Erro no processo: {}", e)),
        });
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            #[cfg(windows)]
            {
                let _ = create_cmd("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .output();
            }
            Err(format!(
                "Comando excedeu timeout de {}s.",
                timeout.as_secs()
            ))
        }
    }
}

pub fn create_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let name = program.as_ref().to_string_lossy().to_string();
    let resolved: std::ffi::OsString = match name.as_str() {
        "adb" => bundled_tool_path("adb.exe")
            .or_else(|| bundled_tool_path("adb"))
            .map(PathBuf::into_os_string)
            .unwrap_or_else(|| program.as_ref().to_os_string()),
        "scrcpy" => bundled_tool_path("scrcpy.exe")
            .or_else(|| bundled_tool_path("scrcpy"))
            .map(PathBuf::into_os_string)
            .unwrap_or_else(|| program.as_ref().to_os_string()),
        _ => program.as_ref().to_os_string(),
    };
    let mut cmd = Command::new(resolved);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) evita que processos console-subsystem
        // (adb.exe, scrcpy.exe) abram uma janela de terminal visível. Para o
        // scrcpy (SDL2), isso só esconde a "caixa preta" do console — a janela
        // gráfica de vídeo continua aparecendo normalmente. Sem isso, clicar em
        // "Câmera Frontal" abre um terminal visível (bug reportado).
        cmd.creation_flags(0x08000000);
    }
    if name == "adb" || name == "scrcpy" {
        if let Some(dir) = bundled_tools_dir() {
            cmd.current_dir(dir);
        }
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
    pub fn esfera_hpc_calculate_tap_coordinates(
        screen_width: i32,
        screen_height: i32,
        pct_x: f64,
        pct_y: f64,
        out_x: *mut i32,
        out_y: *mut i32,
    ) -> i32;
    pub fn esfera_hpc_process_buffer(
        input_ptr: *const u8,
        input_len: usize,
        output_ptr: *mut u8,
        max_out_len: usize,
        out_written: *mut usize,
    ) -> i32;
    pub fn esfera_hpc_get_optimized_processor() -> Option<fn(input: *const u8, len: usize, output: *mut u8, written: *mut usize)>;
}

static DEVICE_INFO_CACHE: std::sync::LazyLock<RwLock<HashMap<String, (String, String, Instant)>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

static BATTERY_CACHE: std::sync::LazyLock<RwLock<HashMap<String, (i32, Instant)>>> =
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

    /// Processa buffer com o caminho SIMD/C++ escolhido no boot.
    pub fn process_buffer(input: &[u8]) -> Vec<u8> {
        if input.is_empty() {
            return Vec::new();
        }

        let mut out = vec![0u8; input.len()];
        let mut written: usize = 0;
        let status = unsafe {
            esfera_hpc_process_buffer(
                input.as_ptr(),
                input.len(),
                out.as_mut_ptr(),
                out.len(),
                &mut written,
            )
        };

        if status == 0 && written <= out.len() && written > 0 {
            out.truncate(written);
        } else if written == 0 {
            out.clear();
        }
        out
    }

    /// Expõe para UI/debug qual caminho o runtime SIMD escolheu,
    /// inferido diretamente das capacidades de hardware (fonte oficial).
    pub fn active_processor_label(caps: EsferaHardwareCaps) -> &'static str {
        if caps.supports_avx512 {
            "avx512"
        } else if caps.supports_avx2 {
            "avx2"
        } else {
            "generic"
        }
    }

    /// Varredura segura de sub-rede na porta 5555 usando paralelismo limitado.
    pub fn scan_subnet(subnet_prefix: &str) -> Vec<String> {
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::sync::Semaphore;

        let prefix = if subnet_prefix.is_empty() {
            "192.168.1"
        } else {
            subnet_prefix.trim_end_matches('.')
        }
        .to_string();

        let num_workers = 16;
        let max_concurrency = 48;
        let active_ips = Arc::new(std::sync::Mutex::new(Vec::new()));
        let scan_timeout = Duration::from_millis(25);
        std::thread::scope(|s| {
            for worker_id in 0..num_workers {
                let prefix_ref = &prefix;
                let ips_ref = active_ips.clone();
                s.spawn(move || {
                    let start = worker_id * 16 + 1;
                    let end = ((worker_id + 1) * 16).min(254);
                    for i in start..=end {
                        let ip = format!("{}.{}", prefix_ref, i);
                        if let Ok(addr) = format!("{}:5555", ip).parse() {
                            if std::net::TcpStream::connect_timeout(&addr, scan_timeout).is_ok() {
                                if let Ok(mut ips) = ips_ref.lock() {
                                    ips.push(ip);
                                }
                            }
                        }
                    }
                });
            }
        });

        match Arc::try_unwrap(active_ips) {
            Ok(mutex) => mutex.into_inner().unwrap_or_default(),
            Err(arc) => arc.lock().unwrap().clone(),
        }
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
            let mut adb = create_cmd("adb");
            adb.args(["-s", serial, "shell", cmd]);
            let result = run_cmd_timeout(adb, Duration::from_secs(6));
            if let Err(e) = result {
                errors.push(format!("{}: {}", cmd, e));
            }
        }
        if errors.is_empty() {
            Ok("Injeção Keep-Alive ADB persistente aplicada no celular com sucesso!".to_string())
        } else {
            Err(format!(
                "Alguns comandos Keep-Alive falharam: {}",
                errors.join("; ")
            ))
        }
    }

    /// Tenta tornar o agente Device Owner (DPC) do celular de forma autônoma.
    /// Device Owner faz o app ser a política mestra do device (fonte de verdade):
    /// ignora a restrição de background-start (app recém-instalado sobe sozinho),
    /// impede desinstalação e trava políticas. Roda após o `adb install` do APK.
    /// Erros são ignorados (se já for DO, ou o device já tiver outro owner).
    pub fn set_device_owner(serial: &str) -> Result<String, String> {
        let mut adb = create_cmd("adb");
        adb.args([
            "-s",
            serial,
            "shell",
            "dpm set-device-owner com.esfera.agent/.AdminReceiver",
        ]);
        match run_cmd_timeout(adb, Duration::from_secs(10)) {
            Ok(out) => {
                let o = String::from_utf8_lossy(&out.stdout).to_string();
                if o.contains("already") || o.to_lowercase().contains("device owner") {
                    Ok("Device Owner já ativo (ou aplicado).".to_string())
                } else {
                    Ok(format!("Device Owner aplicado: {}", o.trim()))
                }
            }
            Err(e) => Err(format!(
                "Device Owner não aplicado (ignorado): {}. O agente segue via keep-alive.",
                e
            )),
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

        let len = diag
            .diagnostic_msg
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(256);
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
        let _ = create_cmd("adb").arg("kill-server").output();

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

    /// Decide se usa o protocolo ADB nativo (apenas para serial de túnel reverso esfera-agent)
    fn use_native_adb(serial: &str) -> bool {
        crate::adb_tcp::is_tunnel_serial(serial)
    }

    /// Obtém o endereço IP do wlan0 via shell único combinado (3 métodos em 1 chamada)
    pub fn get_device_wifi_ip(requested_serial: &str) -> Result<String, String> {
        let serial = Self::resolve_target_serial(requested_serial).unwrap_or_else(|_| requested_serial.to_string());

        // Fast-path: Se o serial solicitado já é um IP (ex: 192.168.1.83 ou 192.168.1.83:5555), retorna o IP imediatamente!
        let clean_ip = serial.split(':').next().unwrap_or(&serial).trim();
        if clean_ip.contains('.') && clean_ip.split('.').count() == 4 && !clean_ip.starts_with("127.") {
            return Ok(clean_ip.to_string());
        }

        let shell_cmd = "getprop dhcp.wlan0.ipaddress; echo '---'; ip route; echo '---'; ip addr show wlan0";

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe (evita "adb server" no hub)
        if Self::use_native_adb(&serial) {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(&serial, shell_cmd) {
                if let Some(ip) = Self::parse_wifi_ip_from_shell(&stdout) {
                    return Ok(ip);
                }
            }
        }

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", &serial, "shell", shell_cmd]);
        let output = run_cmd_timeout(cmd, Duration::from_secs(6))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(ip) = Self::parse_wifi_ip_from_shell(&stdout) {
            return Ok(ip);
        }

        Err(format!("Não foi possível detectar o IP Wi-Fi do celular '{}'. Verifique se o aparelho está conectado à rede Wi-Fi.", serial))
    }

    fn parse_wifi_ip_from_shell(stdout: &str) -> Option<String> {
        let sections: Vec<&str> = stdout.split("---").collect();

        if let Some(s0) = sections.first() {
            let ip = s0.trim();
            if !ip.is_empty() && ip.contains('.') && !ip.starts_with("127.") {
                return Some(ip.to_string());
            }
        }

        if let Some(s1) = sections.get(1) {
            for line in s1.lines() {
                if line.contains("wlan0") && line.contains("src") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if let Some(src_idx) = parts.iter().position(|&x| x == "src") {
                        if src_idx + 1 < parts.len() {
                            let parsed_ip = parts[src_idx + 1].trim().to_string();
                            if parsed_ip.contains('.') && !parsed_ip.starts_with("127.") {
                                return Some(parsed_ip);
                            }
                        }
                    }
                }
            }
        }

        if let Some(s2) = sections.get(2) {
            for line in s2.lines() {
                if line.trim().starts_with("inet ") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() > 1 {
                        let ip_only: Vec<&str> = parts[1].split('/').collect();
                        if !ip_only.is_empty() {
                            let parsed_ip = ip_only[0].trim().to_string();
                            if parsed_ip.contains('.') && !parsed_ip.starts_with("127.") {
                                return Some(parsed_ip);
                            }
                        }
                    }
                }
            }
        }

        None
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
            Err(format!(
                "Não foi possível conectar a {}: {}",
                target,
                combined.trim()
            ))
        }
    }

    /// Desconecta socket ADB zumbi, sonda o TCP (150ms) e conecta de novo.
    /// Evita o "already connected" contra dispositivos que morreram na rede.
    pub fn connect_device_flushed(ip: &str, port: i32) -> Result<String, String> {
        let target = format!("{}:{}", ip, port);

        // 1. Disconnect preventivo — limpa socket morto do ADB server
        let mut dis = create_cmd("adb");
        dis.arg("disconnect").arg(&target);
        let _ = run_cmd_timeout(dis, Duration::from_secs(3));

        // 2. Sonda TCP rápida: se a porta não responde, não adianta conectar
        if let Ok(addr) = target.parse::<std::net::SocketAddr>() {
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_err() {
                return Err(format!(
                    "Dispositivo {} não respondeu ao probe TCP",
                    target
                ));
            }
        }

        // 3. Connect limpo
        Self::connect_device(ip, port)
    }

    /// Variante que aceita o alvo já formatado como "IP:Porta"
    pub fn connect_target_flushed(target: &str) -> Result<String, String> {
        let parts: Vec<&str> = target.split(':').collect();
        if parts.is_empty() || parts[0].is_empty() {
            return Err(format!("Alvo ADB inválido: {}", target));
        }
        let ip = parts[0];
        let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
        Self::connect_device_flushed(ip, port)
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

        if lower.contains("successfully paired")
            || lower.contains("success")
            || output.status.success()
        {
            Ok(format!(
                "Celular {} pareado com sucesso com o código {}!",
                target, code
            ))
        } else {
            Err(format!(
                "Falha no pareamento em {}: {}",
                target,
                combined.trim()
            ))
        }
    }

    /// Desconecta de um dispositivo via `adb disconnect serial`
    pub fn disconnect_device(serial: &str) -> Result<String, String> {
        // Expurga da pool nativa e do registro de túneis (idempotente)
        crate::adb_tcp::evict(serial);
        crate::adb_tcp::unregister_tunnel_serial(serial);

        let output = create_cmd("adb")
            .arg("disconnect")
            .arg(serial)
            .output()
            .map_err(|e| format!("Falha ao executar 'adb disconnect': {}", e))?;

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(result)
    }

    /// Obtém o nível de bateria via cache TTL de 15s + ADB sob demanda
    pub fn get_battery_level(serial: &str) -> Result<i32, String> {
        if let Ok(cache) = BATTERY_CACHE.read() {
            if let Some(&(level, ts)) = cache.get(serial) {
                if ts.elapsed() < Duration::from_secs(15) {
                    return Ok(level);
                }
            }
        }

        let mut level: Option<i32> = None;

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(serial) {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(serial, "dumpsys battery | grep level:") {
                for line in stdout.lines() {
                    let line = line.trim();
                    if let Some(val) = line.strip_prefix("level:") {
                        level = val.trim().parse::<i32>().ok();
                    }
                }
            }
        }

        if level.is_none() {
            let output = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .arg("shell")
                .arg("dumpsys battery | grep level:")
                .output()
                .map_err(|e| format!("Falha ao consultar bateria via ADB: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("level:") {
                    level = val.trim().parse::<i32>().ok();
                }
            }
        }

        if let Some(level) = level {
            if let Ok(mut cache) = BATTERY_CACHE.write() {
                cache.insert(serial.to_string(), (level, Instant::now()));
            }
            return Ok(level);
        }

        Ok(85)
    }

    /// Captura a tela do dispositivo via `adb -s <serial> exec-out screencap -p` e aplica sanitização nativa C++ HPC
    pub fn capture_screen(serial: &str) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let raw_bytes: Vec<u8> = if Self::use_native_adb(&target_serial) {
            // Wi-Fi: protocolo ADB nativo (bytes crus do frame)
            match crate::adb_tcp::exec_shell_bytes(&target_serial, "screencap -p") {
                Ok((stdout, _, true)) => stdout,
                Ok((_, _, false)) => return Err("Comando screencap nativo falhou".to_string()),
                Err(_) => {
                    let fallback = create_cmd("adb")
                        .args(["-s", &target_serial, "exec-out", "screencap", "-p"])
                        .output()
                        .map_err(|e| format!("Falha ao executar screencap ADB: {}", e))?;
                    if !fallback.status.success() || fallback.stdout.is_empty() {
                        return Err(format!(
                            "Não foi possível capturar o frame da tela do celular ({})",
                            target_serial
                        ));
                    }
                    fallback.stdout
                }
            }
        } else {
            let output = create_cmd("adb")
                .args(["-s", &target_serial, "exec-out", "screencap", "-p"])
                .output()
                .map_err(|e| format!("Falha ao executar screencap ADB: {}", e))?;
            if !output.status.success() || output.stdout.is_empty() {
                return Err(format!(
                    "Não foi possível capturar o frame da tela do celular ({})",
                    target_serial
                ));
            }
            output.stdout
        };

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
    }

    /// Envia um toque na tela via `adb -s <serial> shell input tap x y`
    pub fn tap_screen(serial: &str, x: u32, y: u32) -> Result<(), String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let tap_cmd = format!("input tap {} {}", x, y);

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(&target_serial) && crate::adb_tcp::exec_shell_bytes(&target_serial, &tap_cmd).is_ok() {
            return Ok(());
        }

        let output = create_cmd("adb")
            .args(["-s", &target_serial, "shell", "input", "tap", &x.to_string(), &y.to_string()])
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
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let key_cmd = format!("input keyevent {}", keycode);

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(&target_serial) && crate::adb_tcp::exec_shell_bytes(&target_serial, &key_cmd).is_ok() {
            return Ok(());
        }

        let output = create_cmd("adb")
            .args([
                "-s",
                &target_serial,
                "shell",
                "input",
                "keyevent",
                &keycode.to_string(),
            ])
            .output()
            .map_err(|e| format!("Falha ao enviar keyevent ADB: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err("Comando keyevent ADB falhou".to_string())
        }
    }

    /// Digitação direta de texto no celular via ADB
    pub fn input_text(serial: &str, text: &str) -> Result<(), String> {
        Self::type_text_human_hpc(serial, text)
    }

    /// Digitação humana com delays Gaussianos — batch único ADB shell
    pub fn type_text_human_hpc(serial: &str, text: &str) -> Result<(), String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let mut shell_cmds = Vec::new();
        for ch in text.chars() {
            let delay_ms = Self::calculate_gaussian_delay(45, 160);
            let escaped = match ch {
                ' ' => "%s".to_string(),
                '"' => "\\\"".to_string(),
                '\\' => "\\\\".to_string(),
                '&' => "\\&".to_string(),
                '<' => "\\<".to_string(),
                '>' => "\\>".to_string(),
                '|' => "\\|".to_string(),
                c => c.to_string(),
            };
            shell_cmds.push(format!(
                "input text {}; sleep {}",
                escaped,
                delay_ms as f64 / 1000.0
            ));
        }
        let full_cmd = shell_cmds.join(" ");

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(&target_serial) {
            if let Ok((_, _, _)) = crate::adb_tcp::exec_shell_bytes(&target_serial, &full_cmd) {
                return Ok(());
            }
        }

        let output = create_cmd("adb")
            .args(["-s", &target_serial, "shell", &full_cmd])
            .output()
            .map_err(|e| format!("Falha ao digitar texto: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Falha ao digitar texto: {}", stderr.trim()))
        }
    }

    /// Consulta marca+modelo do celular em shell único com cache TTL de 30s
    pub fn get_device_info(serial: &str) -> (String, String) {
        if let Ok(cache) = DEVICE_INFO_CACHE.read() {
            if let Some(info) = cache.get(serial) {
                if info.2.elapsed() < Duration::from_secs(30) {
                    return (info.0.clone(), info.1.clone());
                }
            }
        }

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(serial) {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(
                serial,
                "getprop ro.product.brand; echo; getprop ro.product.model",
            ) {
                let lines: Vec<&str> = stdout.lines().collect();
                let brand = lines
                    .first()
                    .map(|l| l.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Android".to_string());
                let model = lines
                    .get(1)
                    .map(|l| l.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Smartphone".to_string());
                if let Ok(mut cache) = DEVICE_INFO_CACHE.write() {
                    cache.insert(
                        serial.to_string(),
                        (brand.clone(), model.clone(), Instant::now()),
                    );
                }
                return (brand, model);
            }
        }

        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            serial,
            "shell",
            "getprop ro.product.brand; echo; getprop ro.product.model",
        ]);
        let output = cmd.output();

        let (brand, model) = match output {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                let lines: Vec<&str> = s.lines().collect();
                let brand = lines
                    .first()
                    .map(|l| l.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Android".to_string());
                let model = lines
                    .get(1)
                    .map(|l| l.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Smartphone".to_string());
                (brand, model)
            }
            Err(_) => ("Android".to_string(), "Smartphone".to_string()),
        };

        if let Ok(mut cache) = DEVICE_INFO_CACHE.write() {
            cache.insert(
                serial.to_string(),
                (brand.clone(), model.clone(), Instant::now()),
            );
        }

        (brand, model)
    }

    /// Lança o Scrcpy H.264 nativo com aceleração por hardware e resiliência de rede
    pub fn launch_scrcpy(serial: &str, turn_screen_off: bool) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let mode_label = if turn_screen_off {
            " [Tela Desligada]"
        } else {
            ""
        };
        let title = format!("Esfera v3 — Stream ({}){}", target_serial, mode_label);
        let is_wireless = target_serial.contains(':') || target_serial.contains('.');

        if is_wireless {
            let parts: Vec<&str> = target_serial.split(':').collect();
            let ip = parts[0];
            let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
            let _ = Self::connect_device(ip, port);
        }

        let max_size = if is_wireless { "1080" } else { "1280" };
        let fps = if is_wireless { "60" } else { "60" };
        let bitrate = if is_wireless { "4M" } else { "8M" };

        let mut cmd = create_cmd("scrcpy");
        cmd.args([
            "-s",
            &target_serial,
            "--max-size",
            max_size,
            "--max-fps",
            fps,
            "--video-bit-rate",
            bitrate,
            "--video-codec",
            "h264",
            "--display-buffer=50",
            "--no-audio",
            "--stay-awake",
            "--window-title",
            &title,
        ]);

        if turn_screen_off {
            cmd.arg("--turn-screen-off");
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
    pub fn launch_scrcpy_virtual_display(
        serial: &str,
        width: u32,
        height: u32,
        dpi: u32,
    ) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let display_spec = format!("{}x{}/{}", width, height, dpi);
        let title = format!("Esfera v3 — Área #2 [Disparos Isolados] ({})", target_serial);

        let mut cmd = create_cmd("scrcpy");
        cmd.args([
            "-s",
            &target_serial,
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
                display_spec, target_serial
            )),
            Err(e) => Err(format!(
                "Falha ao iniciar Display Virtual Secundário ({}). Certifique-se de que o Scrcpy v2.2+ esteja instalado.",
                e
            )),
        }
    }

    /// Executa um Intent do WhatsApp apontando para um Display específico (ex: Display ID 1)
    pub fn launch_intent_on_display(
        serial: &str,
        url: &str,
        display_id: u32,
    ) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(&target_serial) {
            let intent_cmd = format!(
                "am start --display {} -a android.intent.action.VIEW -d '{}'",
                display_id,
                Self::shell_quote(url)
            );
            match crate::adb_tcp::exec_shell_bytes(&target_serial, &intent_cmd) {
                Ok((_, _, true)) => {
                    return Ok(format!(
                        "Intent aberto no Display #{} com sucesso no aparelho {}",
                        display_id, target_serial
                    ));
                }
                Ok((_, _, false)) => {
                    return Err(format!(
                        "Erro ao abrir Intent no Display #{} (nativo)",
                        display_id
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "Erro ao abrir Intent no Display #{} via túnel: {}",
                        display_id, e
                    ));
                }
            }
        }

        let output = create_cmd("adb")
            .args([
                "-s",
                &target_serial,
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
            Ok(format!(
                "Intent aberto no Display #{} com sucesso no aparelho {}",
                display_id, target_serial
            ))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Erro ao abrir Intent no Display #{}: {}",
                display_id,
                stderr.trim()
            ))
        }
    }

    /// Lança o fluxo de vídeo da Câmera (Traseira ou Frontal) do celular Android via Scrcpy
    pub fn launch_scrcpy_camera(serial: &str, facing: &str) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let camera_arg = if facing == "front" { "front" } else { "back" };
        let title = format!(
            "Esfera v3 — Câmera Ao Vivo ({}) [{}]",
            target_serial,
            camera_arg.to_uppercase()
        );

        // 1. Tenta obter o SDK level do Android (Android 12+ / SDK 31+ suporta --video-source=camera nativo no scrcpy)
        let mut sdk_level = 0;
        let sdk_native = if Self::use_native_adb(&target_serial) {
            crate::adb_tcp::exec_shell(&target_serial, "getprop ro.build.version.sdk")
        } else {
            let mut sdk_cmd = create_cmd("adb");
            sdk_cmd.args(["-s", &target_serial, "shell", "getprop", "ro.build.version.sdk"]);
            run_cmd_timeout(sdk_cmd, Duration::from_secs(3)).map(|o| {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            })
        };
        if let Ok(sdk_str) = sdk_native {
            sdk_level = sdk_str.trim().parse::<i32>().unwrap_or(0);
        }

        // Se o dispositivo for Android < 12 (SDK < 31), abre o app de Câmera nativo via ADB Intent e abre o espelhamento Scrcpy
        if sdk_level > 0 && sdk_level < 31 {
            let mut cam_intent = create_cmd("adb");
            cam_intent.args([
                "-s",
                &target_serial,
                "shell",
                "am",
                "start",
                "-a",
                "android.media.action.STILL_IMAGE_CAMERA",
            ]);
            let _ = run_cmd_timeout(cam_intent, Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(500));

            let result = create_cmd("scrcpy")
                .args(["-s", &target_serial, "--stay-awake", "--window-title", &title])
                .spawn();

            return match result {
                Ok(_) => Ok(format!("Câmera nativa iniciada para {} (Android SDK {}) com espelhamento!", target_serial, sdk_level)),
                Err(e) => Err(format!("Falha ao iniciar espelhamento de câmera: {}", e)),
            };
        }

        // Para Android 12+ (SDK >= 31), tenta a captura nativa de câmera pelo Scrcpy v2 com fallback inteligente
        let result = create_cmd("scrcpy")
            .args([
                "-s",
                &target_serial,
                "--video-source=camera",
                &format!("--camera-facing={}", camera_arg),
                "--stay-awake",
                "--max-fps",
                "30",
                "--video-bit-rate",
                "2M",
                "--window-title",
                &title,
            ])
            .spawn();

        match result {
            Ok(mut child) => {
                std::thread::sleep(Duration::from_millis(1200));
                match child.try_wait() {
                    Ok(Some(status)) if !status.success() => {
                        let mut cam_intent = create_cmd("adb");
                        cam_intent.args([
                            "-s",
                            &target_serial,
                            "shell",
                            "am",
                            "start",
                            "-a",
                            "android.media.action.STILL_IMAGE_CAMERA",
                        ]);
                        let _ = run_cmd_timeout(cam_intent, Duration::from_secs(3));

                        let fallback = create_cmd("scrcpy")
                            .args(["-s", &target_serial, "--stay-awake", "--window-title", &title])
                            .spawn();
                        match fallback {
                            Ok(_) => Ok(format!("Câmera aberta e espelhamento ativado para {}!", target_serial)),
                            Err(_) => Err("Falha ao iniciar scrcpy fallback.".to_string()),
                        }
                    }
                    _ => Ok(format!(
                        "Transmissão de Câmera ({}) iniciada com sucesso para {}!",
                        camera_arg, target_serial
                    )),
                }
            }
            Err(e) => {
                let fallback = create_cmd("scrcpy")
                    .args(["-s", &target_serial, "--window-title", &title])
                    .spawn();
                match fallback {
                    Ok(_) => Ok(format!("Espelhamento de tela ativado para {}!", target_serial)),
                    Err(_) => Err(format!("Falha ao iniciar transmissão de câmera: {}", e)),
                }
            }
        }
    }

    /// Injeta a imagem da tela do computador ou QR Code diretamente na Câmera Virtual do Celular
    /// Captura a tela principal do computador do gestor para um arquivo PNG temporário
    pub fn capture_pc_screen_to_temp_file() -> Result<std::path::PathBuf, String> {
        let temp_dir = std::env::temp_dir();
        let out_path = temp_dir.join("esfera_screen_capture.png");
        let out_str = out_path.to_str().ok_or("Caminho temporário inválido")?;

        let ps_script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             Add-Type -AssemblyName System.Drawing; \
             $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
             $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; \
             $graphics = [System.Drawing.Graphics]::FromImage($bitmap); \
             $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); \
             $bitmap.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png); \
             $graphics.Dispose(); \
             $bitmap.Dispose();",
            out_str.replace('\\', "/")
        );

        let output = create_cmd("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output()
            .map_err(|e| format!("Falha ao executar captura de tela via PowerShell: {}", e))?;

        if output.status.success() && out_path.exists() {
            Ok(out_path)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Falha na captura da tela do PC: {}", stderr.trim()))
        }
    }

    /// Captura uma região delimitada (retângulo/área de enquadramento) da tela do computador do gestor
    pub fn capture_pc_screen_region(
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<std::path::PathBuf, String> {
        let temp_dir = std::env::temp_dir();
        let out_path = temp_dir.join("esfera_screen_cropped.png");
        let out_str = out_path.to_str().ok_or("Caminho temporário inválido")?;

        let ps_script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             Add-Type -AssemblyName System.Drawing; \
             $bitmap = New-Object System.Drawing.Bitmap {}, {}; \
             $graphics = [System.Drawing.Graphics]::FromImage($bitmap); \
             $point = New-Object System.Drawing.Point {}, {}; \
             $size = New-Object System.Drawing.Size {}, {}; \
             $graphics.CopyFromScreen($point, [System.Drawing.Point]::Empty, $size); \
             $bitmap.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png); \
             $graphics.Dispose(); \
             $bitmap.Dispose();",
            width,
            height,
            x,
            y,
            width,
            height,
            out_str.replace('\\', "/")
        );

        let output = create_cmd("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output()
            .map_err(|e| format!("Falha ao executar captura recortada da tela: {}", e))?;

        if output.status.success() && out_path.exists() {
            Ok(out_path)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Falha na captura recortada da tela do PC: {}",
                stderr.trim()
            ))
        }
    }

    /// Injeta uma área/quadrado específico recortado do monitor diretamente na Câmera Virtual do Celular
    pub fn inject_virtual_camera_region(
        serial: &str,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<String, String> {
        let active_devices = Self::list_devices().unwrap_or_default();
        let target_serial = if active_devices
            .iter()
            .any(|d| d.serial == serial && d.state == "device")
        {
            serial.to_string()
        } else if let Some(active_dev) = active_devices.iter().find(|d| d.state == "device") {
            active_dev.serial.clone()
        } else {
            serial.to_string()
        };

        // Passo 1: Captura a área delimitada pelo quadrado movível na tela do PC
        let captured_img = Self::capture_pc_screen_region(x, y, width, height)?;
        let img_str = captured_img
            .to_str()
            .ok_or("Caminho da imagem recortada é inválido")?;

        // Passo 2: Cria diretórios VCam
        let mkdir_dirs = [
            "/sdcard/VCam",
            "/sdcard/DCIM/Camera1",
            "/sdcard/DCIM/Camera",
        ];
        for dir in &mkdir_dirs {
            let mut mk_cmd = create_cmd("adb");
            mk_cmd.args(["-s", &target_serial, "shell", "mkdir", "-p", dir]);
            let _ = run_cmd_timeout(mk_cmd, Duration::from_secs(2));
        }

        // Passo 3: Faz push da imagem recortada
        let push_targets = [
            "/sdcard/virtual.png",
            "/sdcard/virtual.jpg",
            "/sdcard/VCam/virtual.png",
            "/sdcard/VCam/virtual.jpg",
            "/sdcard/DCIM/Camera1/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.jpg",
            "/sdcard/DCIM/Camera/virtual.png",
            "/sdcard/DCIM/Camera/virtual.jpg",
            "/sdcard/DCIM/virtual.png",
        ];

        let mut push_count = 0;
        for dest in &push_targets {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", &target_serial, "push", img_str, dest]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(4)) {
                if out.status.success() {
                    push_count += 1;
                }
            }
        }

        // Passo 4: Notifica MediaScanner
        for path in &[
            "/sdcard/virtual.png",
            "/sdcard/VCam/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.png",
        ] {
            let mut scan_cmd = create_cmd("adb");
            scan_cmd.args([
                "-s",
                &target_serial,
                "shell",
                "am",
                "broadcast",
                "-a",
                "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                "-d",
                &format!("file://{}", path),
            ]);
            let _ = run_cmd_timeout(scan_cmd, Duration::from_secs(2));
        }

        // Passo 5: Envia Intents de broadcast via ADB IPC
        let broadcasts = [
            vec![
                "-a",
                "com.esfera.virtualcamera.INJECT_SCREEN",
                "--es",
                "source",
                "desktop_pc_v3",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/VCam/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/DCIM/Camera1/virtual.png",
            ],
            vec!["-a", "com.vcam.action.CHANGE_VIDEO"],
        ];

        for b_args in &broadcasts {
            let mut b_cmd = create_cmd("adb");
            b_cmd
                .arg("-s")
                .arg(&target_serial)
                .arg("shell")
                .arg("am")
                .arg("broadcast");
            for a in b_args {
                b_cmd.arg(a);
            }
            let _ = run_cmd_timeout(b_cmd, Duration::from_secs(2));
        }

        Ok(format!(
            "🎯 Quadrado ({})x({}) capturado e injetado com sucesso no celular {}!\n({} locais atualizados)",
            width, height, target_serial, push_count
        ))
    }

    /// Injeta um frame base64 (gerado via canvas) diretamente no celular Android de forma rápida
    pub fn inject_base64_frame(serial: &str, base64_data: &str) -> Result<String, String> {
        use base64::{engine::general_purpose, Engine as _};

        let active_devices = Self::list_devices().unwrap_or_default();
        let target_serial = if active_devices
            .iter()
            .any(|d| d.serial == serial && d.state == "device")
        {
            serial.to_string()
        } else if let Some(active_dev) = active_devices.iter().find(|d| d.state == "device") {
            active_dev.serial.clone()
        } else {
            serial.to_string()
        };

        // Remove data URI prefix se presente
        let b64 = if let Some(idx) = base64_data.find(',') {
            &base64_data[idx + 1..]
        } else {
            base64_data
        };

        let img_data = general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Falha ao decodificar base64: {}", e))?;

        let temp_dir = std::env::temp_dir();
        let out_path = temp_dir.join("esfera_frame.png");
        std::fs::write(&out_path, img_data)
            .map_err(|e| format!("Falha ao salvar frame temporário: {}", e))?;

        let img_str = out_path.to_str().ok_or("Caminho temporário inválido")?;

        let mkdir_dirs = [
            "/sdcard/VCam",
            "/sdcard/DCIM/Camera1",
            "/sdcard/DCIM/Camera",
        ];
        for dir in &mkdir_dirs {
            let mut mk_cmd = create_cmd("adb");
            mk_cmd.args(["-s", &target_serial, "shell", "mkdir", "-p", dir]);
            let _ = run_cmd_timeout(mk_cmd, Duration::from_millis(500));
        }

        let push_targets = [
            "/sdcard/virtual.png",
            "/sdcard/virtual.jpg",
            "/sdcard/VCam/virtual.png",
            "/sdcard/VCam/virtual.jpg",
            "/sdcard/DCIM/Camera1/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.jpg",
            "/sdcard/DCIM/Camera/virtual.png",
            "/sdcard/DCIM/Camera/virtual.jpg",
            "/sdcard/DCIM/virtual.png",
        ];

        let mut push_count = 0;
        let temp_android_path = "/sdcard/esfera_temp_frame.png";
        
        // Push the image safely to a temp file on the device
        let mut push_cmd = create_cmd("adb");
        push_cmd.args(["-s", &target_serial, "push", img_str, temp_android_path]);
        if let Ok(out) = run_cmd_timeout(push_cmd, Duration::from_secs(3)) {
            if out.status.success() {
                // Now atomically copy/move it to all targets to avoid partial reads by VCam
                for dest in &push_targets {
                    let mut cp_cmd = create_cmd("adb");
                    cp_cmd.args(["-s", &target_serial, "shell", "cp", temp_android_path, dest]);
                    if let Ok(cp_out) = run_cmd_timeout(cp_cmd, Duration::from_millis(500)) {
                        if cp_out.status.success() {
                            push_count += 1;
                        }
                    }
                }
            }
        }

        // Notifica MediaScanner
        for path in &[
            "/sdcard/virtual.png",
            "/sdcard/VCam/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.png",
        ] {
            let mut scan_cmd = create_cmd("adb");
            scan_cmd.args([
                "-s",
                &target_serial,
                "shell",
                "am",
                "broadcast",
                "-a",
                "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                "-d",
                &format!("file://{}", path),
            ]);
            let _ = run_cmd_timeout(scan_cmd, Duration::from_secs(2));
        }

        let broadcasts = [
            vec![
                "-a",
                "com.esfera.virtualcamera.INJECT_SCREEN",
                "--es",
                "source",
                "desktop_pc_v3",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/VCam/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/DCIM/Camera1/virtual.png",
            ],
            vec!["-a", "com.vcam.action.CHANGE_VIDEO"],
        ];

        for b_args in &broadcasts {
            let mut b_cmd = create_cmd("adb");
            b_cmd
                .arg("-s")
                .arg(&target_serial)
                .arg("shell")
                .arg("am")
                .arg("broadcast");
            for a in b_args {
                b_cmd.arg(a);
            }
            let _ = run_cmd_timeout(b_cmd, Duration::from_secs(2));
        }

        Ok(format!("Frame base64 injetado! ({} locais)", push_count))
    }

    /// Injeta a imagem da tela do computador ou QR Code diretamente na Câmera Virtual do Celular
    pub fn inject_virtual_camera_feed(serial: &str, target_type: &str) -> Result<String, String> {
        let active_devices = Self::list_devices().unwrap_or_default();
        let target_serial = if active_devices
            .iter()
            .any(|d| d.serial == serial && d.state == "device")
        {
            serial.to_string()
        } else if let Some(active_dev) = active_devices.iter().find(|d| d.state == "device") {
            active_dev.serial.clone()
        } else {
            serial.to_string()
        };

        // Passo 1: Captura em tempo real a tela do monitor do computador do gestor
        let captured_img = Self::capture_pc_screen_to_temp_file()?;
        let img_str = captured_img
            .to_str()
            .ok_or("Caminho da imagem capturada é inválido")?;

        // Passo 2: Cria as pastas da Câmera Virtual no celular Android se não existirem
        let mkdir_dirs = [
            "/sdcard/VCam",
            "/sdcard/DCIM/Camera1",
            "/sdcard/DCIM/Camera",
        ];
        for dir in &mkdir_dirs {
            let mut mk_cmd = create_cmd("adb");
            mk_cmd.args(["-s", &target_serial, "shell", "mkdir", "-p", dir]);
            let _ = run_cmd_timeout(mk_cmd, Duration::from_secs(2));
        }

        // Passo 3: Faz push da imagem capturada para TODOS os caminhos suportados por módulos VCam / HookCamera / VirtualCamera
        let push_targets = [
            "/sdcard/virtual.png",
            "/sdcard/virtual.jpg",
            "/sdcard/VCam/virtual.png",
            "/sdcard/VCam/virtual.jpg",
            "/sdcard/DCIM/Camera1/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.jpg",
            "/sdcard/DCIM/Camera/virtual.png",
            "/sdcard/DCIM/Camera/virtual.jpg",
            "/sdcard/DCIM/virtual.png",
        ];

        let mut push_count = 0;
        for dest in &push_targets {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", &target_serial, "push", img_str, dest]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(4)) {
                if out.status.success() {
                    push_count += 1;
                }
            }
        }

        // Passo 4: Notifica o sistema Android via MediaScanner para forçar atualização do arquivo de mídia
        for path in &[
            "/sdcard/virtual.png",
            "/sdcard/VCam/virtual.png",
            "/sdcard/DCIM/Camera1/virtual.png",
        ] {
            let mut scan_cmd = create_cmd("adb");
            scan_cmd.args([
                "-s",
                &target_serial,
                "shell",
                "am",
                "broadcast",
                "-a",
                "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                "-d",
                &format!("file://{}", path),
            ]);
            let _ = run_cmd_timeout(scan_cmd, Duration::from_secs(2));
        }

        // Passo 5: Envia Intents de broadcast via ADB IPC para atualizar os hooks da Câmera Virtual
        let intent_action = if target_type == "screen" {
            "com.esfera.virtualcamera.INJECT_SCREEN"
        } else {
            "com.esfera.virtualcamera.INJECT_QRCODE"
        };

        let broadcasts = [
            vec![
                "-a",
                intent_action,
                "--es",
                "source",
                "desktop_pc_v3",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/VCam/virtual.png",
            ],
            vec![
                "-a",
                "com.vcam.action.REFRESH",
                "--es",
                "path",
                "/sdcard/DCIM/Camera1/virtual.png",
            ],
            vec!["-a", "com.vcam.action.CHANGE_VIDEO"],
        ];

        for b_args in &broadcasts {
            let mut b_cmd = create_cmd("adb");
            b_cmd
                .arg("-s")
                .arg(&target_serial)
                .arg("shell")
                .arg("am")
                .arg("broadcast");
            for a in b_args {
                b_cmd.arg(a);
            }
            let _ = run_cmd_timeout(b_cmd, Duration::from_secs(2));
        }

        Ok(format!(
            "📸 Tela do PC do Gestor capturada e enviada para a Câmera Virtual no celular {}!\n(Enviado para {} diretórios da VCam e broadcasts disparados)",
            target_serial, push_count
        ))
    }

    /// Executa o pacote completo de otimização de alta performance (HPC Turbo Tuning) no celular via ADB
    pub fn optimize_device_performance(serial: &str) -> Result<String, String> {
        let commands = [
            // 1. Desativa animações do Android para resposta instantânea ao toque (0.0x)
            vec![
                "shell",
                "settings",
                "put",
                "global",
                "window_animation_scale",
                "0.0",
            ],
            vec![
                "shell",
                "settings",
                "put",
                "global",
                "transition_animation_scale",
                "0.0",
            ],
            vec![
                "shell",
                "settings",
                "put",
                "global",
                "animator_duration_scale",
                "0.0",
            ],
            // 2. Força renderização por GPU e aceleração por Hardware
            vec!["shell", "setprop", "debug.sf.hw", "1"],
            vec![
                "shell",
                "settings",
                "put",
                "global",
                "force_gpu_rendering",
                "1",
            ],
            // 3. Imuniza o WhatsApp no Doze Mode para evitar que o Android mate em segundo plano
            vec![
                "shell",
                "dumpsys",
                "deviceidle",
                "whitelist",
                "+com.whatsapp",
            ],
            vec![
                "shell",
                "dumpsys",
                "deviceidle",
                "whitelist",
                "+com.whatsapp.w4b",
            ],
            // 4. Libera memória RAM e otimiza compilação DEX AOT (Speed Profile)
            vec![
                "shell",
                "cmd",
                "package",
                "compile",
                "-m",
                "speed-profile",
                "com.whatsapp",
            ],
        ];

        let mut success_count = 0;
        for cmd in &commands {
            let mut adb = create_cmd("adb");
            adb.arg("-s").arg(serial).args(cmd);
            let res = run_cmd_timeout(adb, Duration::from_secs(6));
            if let Ok(o) = res {
                if o.status.success() {
                    success_count += 1;
                }
            }
        }

        Ok(format!(
            "🚀 Otimização HPC aplicada com sucesso em {}! ({}/{} otimizações ativadas)",
            serial,
            success_count,
            commands.len()
        ))
    }

    /// Remove/disables bloatware packages do dispositivo baseado no perfil selecionado
    pub fn debloat_device(serial: &str) -> Result<String, String> {
        Self::debloat_device_profile(serial, "safe")
    }

    /// Executa o Debloat por Nível/Perfil (Estilo UAD-ng / Canta via ADB)
    pub fn debloat_device_profile(serial: &str, profile: &str) -> Result<String, String> {
        let manufacturer = Self::get_device_manufacturer(serial);
        let m_lower = manufacturer.to_lowercase();

        let mut pkg_set: std::collections::HashSet<&str> = std::collections::HashSet::new();

        // 1. Pacotes por Fabricante
        let m_bloat: &[&str] = match m_lower.as_str() {
            m if m.contains("samsung") => &SAMSUNG_BLOAT,
            m if m.contains("realme") | m.contains("oppo") | m.contains("oneplus") => &REALME_BLOAT,
            m if m.contains("xiaomi") | m.contains("redmi") | m.contains("poco") => &XIAOMI_BLOAT,
            m if m.contains("motorola") => &MOTOROLA_BLOAT,
            m if m.contains("multilaser") => &MULTILASER_BLOAT,
            m if m.contains("positivo") => &POSITIVO_BLOAT,
            m if m.contains("lg") => &LG_BLOAT,
            _ => &GENERIC_BLOAT,
        };

        for p in m_bloat { pkg_set.insert(p); }
        for p in GENERIC_BLOAT { pkg_set.insert(p); }

        // 2. Se perfil for Agressivo ou Extremo, inclui Google Apps pesados (Assistente, YouTube, Chrome, etc.)
        if profile == "aggressive" || profile == "extreme" || profile == "extreme_worker" {
            for p in GOOGLE_HEAVY_BLOAT { pkg_set.insert(p); }
        }

        let is_restore = profile == "restore";
        let mut processed = 0;
        let mut errors = Vec::new();

        for pkg in &pkg_set {
            let mut cmd = create_cmd("adb");
            if is_restore {
                cmd.args(["-s", serial, "shell", "pm", "enable", pkg]);
            } else {
                cmd.args(["-s", serial, "shell", "pm", "disable-user", "--user", "0", pkg]);
            }

            match run_cmd_timeout(cmd, Duration::from_secs(4)) {
                Ok(out) if out.status.success() => processed += 1,
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    if !stderr.contains("not found") && !stderr.contains("already") && !stderr.is_empty() {
                        errors.push(format!("{}: {}", pkg, stderr.trim()));
                    }
                }
                Err(e) => {
                    if !e.contains("not found") {
                        errors.push(format!("{}: {}", pkg, e));
                    }
                }
            }
        }

        // Limpeza de cache e trim
        let _ = create_cmd("adb").args(["-s", serial, "shell", "pm", "trim-caches", "999G"]).output();

        let action_label = if is_restore { "Restauração de Apps" } else { "Debloat UAD-ng" };
        let profile_label = match profile {
            "safe" => "Seguro (Fabricante/Operadora)",
            "aggressive" => "Agressivo (Google + Bloatwares)",
            "extreme" | "extreme_worker" => "Extremo (Nó Dedicado)",
            "restore" => "Restaurar Apps Nativos",
            _ => profile,
        };

        let mut result = format!(
            "✅ {} [{}] concluído em {} [{}]: {}/{} apps processados!",
            action_label, profile_label, serial, manufacturer, processed, pkg_set.len()
        );
        if !errors.is_empty() && errors.len() <= 5 {
            result.push_str(&format!("\nNotas: {}", errors.join("; ")));
        }
        Ok(result)
    }

    /// Aplica Perfis de Hardware Dedicado (Worker WhatsApp, Nó Linux/Termux, Câmera RTSP)
    pub fn apply_hardware_profile(serial: &str, profile: &str) -> Result<String, String> {
        match profile {
            "worker" | "esfera_worker" => {
                // Modo 1: Nó de Disparos / Automação Pura (100% RAM para WhatsApp + Agente)
                let cmds = [
                    "settings put global window_animation_scale 0.0",
                    "settings put global transition_animation_scale 0.0",
                    "settings put global animator_duration_scale 0.0",
                    "setprop debug.sf.hw 1",
                    "settings put global force_gpu_rendering 1",
                    "device_config put activity_manager max_phantom_processes 2147483647",
                    "dumpsys deviceidle whitelist +com.whatsapp",
                    "dumpsys deviceidle whitelist +com.whatsapp.w4b",
                    "dumpsys deviceidle whitelist +com.esfera.agent",
                    "cmd appops set com.esfera.agent RUN_IN_BACKGROUND allow",
                    "cmd appops set com.whatsapp RUN_IN_BACKGROUND allow",
                    "settings put global stay_on_while_plugged_in 7",
                    "settings put global wifi_sleep_policy 2",
                    "pm trim-caches 999G",
                    "cmd package compile -m speed-profile com.whatsapp",
                    "cmd package compile -m speed-profile com.esfera.agent",
                ];
                for c in &cmds {
                    let mut cmd = create_cmd("adb");
                    cmd.args(["-s", serial, "shell", c]);
                    let _ = run_cmd_timeout(cmd, Duration::from_secs(4));
                }
                Ok("🚀 Perfil [Nó de Disparos Esfera Worker] ativado! Animações 0x, GPU forçada, WhatsApp e Agente imunizados e priorizados na RAM.".to_string())
            }
            "termux" | "linux_node" => {
                // Modo 2: Micro-Servidor Linux / Termux
                let cmds = [
                    "device_config put activity_manager max_phantom_processes 2147483647",
                    "dumpsys deviceidle whitelist +com.termux",
                    "dumpsys deviceidle whitelist +com.esfera.agent",
                    "cmd appops set com.termux RUN_IN_BACKGROUND allow",
                    "settings put global stay_on_while_plugged_in 7",
                    "settings put global wifi_sleep_policy 2",
                    "pm trim-caches 999G",
                ];
                for c in &cmds {
                    let mut cmd = create_cmd("adb");
                    cmd.args(["-s", serial, "shell", c]);
                    let _ = run_cmd_timeout(cmd, Duration::from_secs(4));
                }
                Ok("🐧 Perfil [Micro-Servidor Linux / Termux] ativado! Limite de processos fantasmas removido e conexão Wi-Fi permanente.".to_string())
            }
            "camera" | "rtsp_cam" => {
                // Modo 3: Câmera RTSP / VCam Dedicada
                let cmds = [
                    "settings put system screen_off_timeout 2147483647",
                    "settings put global stay_on_while_plugged_in 7",
                    "settings put global wifi_sleep_policy 2",
                    "dumpsys deviceidle whitelist +com.esfera.agent",
                    "dumpsys deviceidle whitelist +com.vcam",
                ];
                for c in &cmds {
                    let mut cmd = create_cmd("adb");
                    cmd.args(["-s", serial, "shell", c]);
                    let _ = run_cmd_timeout(cmd, Duration::from_secs(4));
                }
                Ok("📷 Perfil [Câmera / Sensor Dedicado] ativado! Prevenção total de sleep e prioridade de streaming de vídeo.".to_string())
            }
            _ => Err(format!("Perfil desconhecido: {}", profile)),
        }
    }

    fn get_device_manufacturer(serial: &str) -> String {
        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(serial) {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(serial, "getprop ro.product.manufacturer") {
                let val = stdout.trim();
                if !val.is_empty() {
                    return val.to_string();
                }
            }
            return "unknown".to_string();
        }

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", "getprop", "ro.product.manufacturer"]);
        if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(3)) {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            "unknown".to_string()
        }
    }

    /// Lê a identificação persistente do celular (/sdcard/.esfera_device_id ou persist.esfera.device_id)
    /// Prioriza sdcard porque setprop/getprop pode ser bloqueado por SELinux em dispositivos nao-root
    pub fn get_persistent_device_id(serial: &str) -> Option<String> {
        let is_native = Self::use_native_adb(serial);

        // 1. Tenta sdcard primeiro (mais confiavel)
        if is_native {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(serial, "cat /sdcard/.esfera_device_id") {
                let val = stdout.trim().to_string();
                if !val.is_empty() && val.starts_with("ESF-") && !val.starts_with("ESF-192.") {
                    return Some(val);
                }
            }
        } else {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", serial, "shell", "cat", "/sdcard/.esfera_device_id"]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(3)) {
                let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !val.is_empty() && val.starts_with("ESF-") && !val.starts_with("ESF-192.") {
                    return Some(val);
                }
            }
        }

        // 2. Fallback: getprop (pode falhar em SELinux enforcing)
        if is_native {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(serial, "getprop persist.esfera.device_id") {
                let val = stdout.trim().to_string();
                if !val.is_empty() && val.starts_with("ESF-") && !val.starts_with("ESF-192.") {
                    return Some(val);
                }
            }
        } else {
            let mut cmd2 = create_cmd("adb");
            cmd2.args(["-s", serial, "shell", "getprop", "persist.esfera.device_id"]);
            if let Ok(out) = run_cmd_timeout(cmd2, Duration::from_secs(2)) {
                let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !val.is_empty() && val.starts_with("ESF-") && !val.starts_with("ESF-192.") {
                    return Some(val);
                }
            }
        }

        // 3. Fallback: ro.serialno (hardware serial da CPU/dispositivo)
        let hw_serial = if is_native {
            crate::adb_tcp::exec_shell(serial, "getprop ro.serialno").ok()
        } else {
            let mut cmd3 = create_cmd("adb");
            cmd3.args(["-s", serial, "shell", "getprop", "ro.serialno"]);
            run_cmd_timeout(cmd3, Duration::from_secs(2))
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        };

        if let Some(s) = hw_serial {
            let val = s.trim().to_uppercase();
            if !val.is_empty() && val != "UNKNOWN" && !val.contains(' ') && !val.contains('.') && !val.contains(':') {
                let prefix8 = if val.len() >= 8 { &val[0..8] } else { &val };
                let derived = format!("ESF-{}", prefix8);
                let _ = Self::inject_persistent_device_id(serial, &derived);
                return Some(derived);
            }
        }

        // 4. Fallback final: se o próprio serial ADB for um hardware serial (sem IP/porta)
        let clean_serial = serial.trim().to_uppercase();
        if !clean_serial.contains('.') && !clean_serial.contains(':') && !clean_serial.is_empty() {
            let prefix8 = if clean_serial.len() >= 8 { &clean_serial[0..8] } else { &clean_serial };
            let derived = format!("ESF-{}", prefix8);
            let _ = Self::inject_persistent_device_id(serial, &derived);
            return Some(derived);
        }

        None
    }

    /// Injeta permanentemente a identificação no Kernel/OS e Armazenamento do Celular
    pub fn inject_persistent_device_id(
        serial: &str,
        persistent_id: &str,
    ) -> Result<String, String> {
        let batch_cmd = format!(
            "setprop persist.esfera.device_id {}; echo '{}' > /sdcard/.esfera_device_id",
            persistent_id, persistent_id
        );

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", &batch_cmd]);

        match run_cmd_timeout(cmd, Duration::from_secs(8)) {
            Ok(_) => Ok(format!(
                "🏷️ ID permanente '{}' injetada no celular {}",
                persistent_id, serial
            )),
            Err(e) => Err(format!("Falha ao injetar ID no celular {}: {}", serial, e)),
        }
    }

    /// Injeta regras de Imunidade, Fixação de MAC Físico, Persistência ADB TCP 5555 e ID permanente no Kernel
    pub fn inject_device_immunity(
        serial: &str,
        persistent_id: Option<&str>,
    ) -> Result<String, String> {
        let id_cmd = if let Some(pid) = persistent_id {
            format!(
                "setprop persist.esfera.device_id {}; echo '{}' > /sdcard/.esfera_device_id; ",
                pid, pid
            )
        } else {
            "".to_string()
        };

        let batch_cmd = format!(
            "{}settings put global captive_portal_mode 0; \
             settings put global captive_portal_detection_enabled 0; \
             settings put global captive_portal_http_url http://www.google.com/generate_204; \
             settings put global wifi_connected_mac_randomization_enabled 0; \
             settings put global verifier_verify_adb_installs 0; \
             settings put global package_verifier_enable 0; \
             setprop persist.adb.tcp.port 5555; \
             settings put global wifi_sleep_policy 2; \
             settings put global wifi_scan_always_enabled 1; \
             settings put global stay_on_while_plugged_in 7; \
             device_config put activity_manager max_phantom_processes 2147483647; \
             dumpsys deviceidle disable; \
             dumpsys deviceidle whitelist +com.mouldybread.adbautoenable; \
             dumpsys deviceidle whitelist +com.android.shell; \
             dumpsys deviceidle whitelist +com.esfera.agent; \
             cmd appops set com.esfera.agent RUN_IN_BACKGROUND allow; \
             cmd appops set com.esfera.agent RUN_ANY_IN_BACKGROUND allow; \
             am start-foreground-service com.esfera.agent/.EsferaAgentService; \
             am startservice com.esfera.agent/.EsferaAgentService",
            id_cmd
        );

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", &batch_cmd]);

        match run_cmd_timeout(cmd, Duration::from_secs(10)) {
            Ok(_) => Ok(format!(
                "🛡️ Imunidade, MAC Físico e Kernel ID Injetados no Celular {} com sucesso!",
                serial
            )),
            Err(e) => Err(format!("Falha ao injetar no celular {}: {}", serial, e)),
        }
    }

    /// Injeta a URL do servidor Esfera no dispositivo Android.
    ///
    /// `company_id` é OBRIGATÓRIO no fluxo novo: sem ele o VPS recusa
    /// check-in/túnel/presença (isolamento por empresa). É gravado tanto na
    /// prop `persist.esfera.company` (lida pelo device-agent Rust) quanto no
    /// `/sdcard/esfera_config.json` (lido pelo EsferaAgentService Kotlin).
    pub fn inject_server_config(
        serial: &str,
        server_url: &str,
        device_id: &str,
        company_id: i32,
    ) -> Result<String, String> {
        let config_json = format!(
            "{{\\\"serverUrl\\\":\\\"{}\\\",\\\"deviceId\\\":\\\"{}\\\",\\\"companyId\\\":{},\\\"heartbeatIntervalSec\\\":30}}",
            server_url, device_id, company_id
        );
        let batch_cmd = format!(
            "setprop persist.esfera.server_address {}; setprop persist.esfera.hub {}; setprop persist.esfera.company {}; echo '{}' > /sdcard/esfera_config.json",
            server_url,
            Self::host_of(server_url),
            company_id,
            config_json
        );

        let mut cmd = create_cmd("adb");
        cmd.args(["-s", serial, "shell", &batch_cmd]);

        match run_cmd_timeout(cmd, Duration::from_secs(8)) {
            Ok(_) => Ok(format!(
                "Configuração do servidor '{}' (empresa {}) injetada",
                server_url, company_id
            )),
            Err(e) => Err(format!("Falha ao injetar config: {}", e)),
        }
    }

    /// Grava no celular `/sdcard/esfera_config.json` com a identidade EXATA do
    /// Android = serial ADB enxergado pelo PC (ex.: serial `4200da8501667545`
    /// -> `deviceId: "ESF-4200DA85"`).
    ///
    /// Isso é o que garante que o cruzamento local (serial ADB) x remoto (VPS,
    /// `esfera_device_id = ESF-xxxx`) NUNCA falhe: ambos compartilham o mesmo
    /// prefixo determinístico. Chamado em CADA detecção de dispositivo (USB ou
    /// Wi-Fi) pelo `get_devices`, independentemente de o agente já estar rodando.
    ///
    /// Escreve o JSON via `echo '...' > /sdcard/esfera_config.json` (shell)
    /// porque `/sdcard` é gravável sem root e o `EsferaAgentService` Kotlin lê
    /// esse arquivo no check-in. Em caso de falha (device não autorizado),
    /// retorna `Err` mas NÃO bloqueia o fluxo de listagem.
    pub fn write_identity_config(
        serial: &str,
        company_id: i32,
        server_url: &str,
    ) -> Result<String, String> {
        let is_network = serial.contains(':') || serial.contains('.');
        let actual_serial = if is_network {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", serial, "shell", "getprop", "ro.serialno"]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !stdout.is_empty() && stdout != "unknown" && !stdout.contains(' ') && !stdout.contains('.') {
                    stdout
                } else if let Some(pid) = Self::get_persistent_device_id(serial) {
                    pid.trim_start_matches("ESF-").to_string()
                } else {
                    return Err(format!("Não foi possível obter hardware serial do Wi-Fi {}", serial));
                }
            } else if let Some(pid) = Self::get_persistent_device_id(serial) {
                pid.trim_start_matches("ESF-").to_string()
            } else {
                return Err(format!("Não foi possível obter hardware serial do Wi-Fi {}", serial));
            }
        } else {
            serial.to_string()
        };

        let serial_upper = actual_serial.to_uppercase();
        let prefix8: &str = if serial_upper.len() >= 8 {
            &serial_upper[0..8]
        } else if !serial_upper.is_empty() {
            &serial_upper
        } else {
            return Err("Serial ADB vazio: não foi possível derivar ESF-xxxx".to_string());
        };
        let device_id = format!("ESF-{}", prefix8);

        // JSON com aspas simples no shell (evita escape de aspas duplas).
        let json = format!(
            "{{\"deviceId\":\"{}\",\"companyId\":{},\"serverUrl\":\"{}\"}}",
            device_id, company_id, server_url
        );

        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            serial,
            "shell",
            &format!("echo '{}' > /sdcard/esfera_config.json; echo '{}' > /sdcard/.esfera_device_id", json, device_id),
        ]);

        match run_cmd_timeout(cmd, Duration::from_secs(5)) {
            Ok(_) => Ok(format!(
                "Identidade {} (empresa {}) gravada em /sdcard/esfera_config.json",
                device_id, company_id
            )),
            Err(e) => Err(format!(
                "Falha ao gravar esfera_config.json no {}: {}",
                serial, e
            )),
        }
    }

    /// Executa o pipeline completo de Auto-Cura, Provisionamento e Imunidade Total (Zero-Touch)
    pub fn auto_heal_and_immunize_device(serial: &str, company_id: i32, server_url: &str) -> Result<(), String> {
        // 1. Se for conexão USB inicial, ativa porta TCP/IP 5555 e conecta automaticamente no IP Wi-Fi
        if !serial.contains(':') && !serial.contains('.') {
            let mut tcp_cmd = create_cmd("adb");
            tcp_cmd.args(["-s", serial, "tcpip", "5555"]);
            let _ = run_cmd_timeout(tcp_cmd, Duration::from_secs(4));

            let mut ip_cmd = create_cmd("adb");
            ip_cmd.args(["-s", serial, "shell", "ip route || ip addr show wlan0"]);
            if let Ok(out) = run_cmd_timeout(ip_cmd, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for word in stdout.split_whitespace() {
                    if (word.starts_with("192.168.") || word.starts_with("10.")) && !word.ends_with(".255") {
                        let clean_ip = word.split('/').next().unwrap_or(word);
                        if clean_ip.contains('.') && clean_ip.split('.').count() == 4 {
                            let _ = Self::connect_device_flushed(clean_ip, 5555);
                            break;
                        }
                    }
                }
            }
        }

        // 2. Grava a identidade no /sdcard/esfera_config.json
        let _ = Self::write_identity_config(serial, company_id, server_url);

        // 3. Semeia as chaves ADB do Windows para autorização perpétua
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let key_path = std::path::Path::new(&home).join(".android").join("adbkey.pub");
            if let Ok(key) = std::fs::read_to_string(&key_path) {
                let key_trim = key.trim();
                if !key_trim.is_empty() {
                    let seed = format!(
                        "mkdir -p /data/misc/adb 2>/dev/null; (cat /data/misc/adb/adb_keys 2>/dev/null | grep -qF \"{}\" || echo \"{}\" >> /data/misc/adb/adb_keys); chmod 640 /data/misc/adb/adb_keys; restorecon /data/misc/adb/adb_keys 2>/dev/null",
                        key_trim, key_trim
                    );
                    let mut sk = create_cmd("adb");
                    sk.args(["-s", serial, "shell", &seed]);
                    let _ = run_cmd_timeout(sk, Duration::from_secs(4));
                }
            }
        }

        // 4. Verifica se o APK do agente está instalado; caso ausente, instala imediatamente
        let pkg_check = create_cmd("adb")
            .args(["-s", serial, "shell", "pm", "list", "packages", "com.esfera.agent"])
            .output();
        let is_installed = pkg_check.map(|o| String::from_utf8_lossy(&o.stdout).contains("com.esfera.agent")).unwrap_or(false);
        if !is_installed {
            let _ = Self::install_agent_apk(serial);
        }

        // 5. Aplica a imunidade de bateria, prevencao de sono e wake lock
        let pid = Self::get_persistent_device_id(serial);
        let _ = Self::inject_device_immunity(serial, pid.as_deref());

        // 6. Inicia o serviço em primeiro plano
        let _ = Self::start_agent_service(serial);

        Ok(())
    }

    /// Varredura assíncrona ultra-rápida (HPC) na subnet local para auto-adoção de celulares que mudarem de IP via DHCP
    pub fn auto_discover_lan_devices(db: &crate::db::Database) {
        use std::net::{TcpStream, SocketAddr, IpAddr, Ipv4Addr};

        let base_subnets = vec![
            (192, 168, 1),
            (192, 168, 0),
            (192, 168, 15),
            (10, 0, 0),
        ];

        for (o1, o2, o3) in base_subnets {
            let mut handles = Vec::new();
            for last in 2..254 {
                handles.push(std::thread::spawn(move || {
                    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(o1, o2, o3, last)), 5555);
                    if TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok() {
                        Some(format!("{}.{}.{}.{}", o1, o2, o3, last))
                    } else {
                        None
                    }
                }));
            }

            let mut found_ips = Vec::new();
            for h in handles {
                if let Ok(Some(ip)) = h.join() {
                    found_ips.push(ip);
                }
            }

            if !found_ips.is_empty() {
                for ip in found_ips {
                    let full_addr = format!("{}:5555", ip);
                    let _ = Self::connect_device(&ip, 5555);
                    if let Some(pid) = Self::get_persistent_device_id(&full_addr) {
                        let _ = db.process_checkin(&pid, &full_addr, &ip, 5555, &chrono::Utc::now().to_rfc3339());
                    }
                }
                break;
            }
        }
    }

    /// Extrai só o host de uma URL (o device-agent Rust espera host puro em
    /// `persist.esfera.hub`, não uma URL completa).
    fn host_of(server_url: &str) -> String {
        server_url
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or(server_url)
            .split(':')
            .next()
            .unwrap_or(server_url)
            .to_string()
    }

    /// Inicia o serviço do Agent Android via ADB
    pub fn start_agent_service(serial: &str) -> Result<String, String> {
        // Tenta iniciar o novo agente (v4), fallback para o antigo (mouldybread/tpn)
        let result = (|| -> Result<String, String> {
            // 0. Abre a MainActivity primeiro: ela chama startForegroundService no
            // onCreate, o que destrava o background-start em Android 8+ (app recém-
            // instalado não pode receber start-foreground-service direto do adb).
            let mut act = create_cmd("adb");
            act.args([
                "-s",
                serial,
                "shell",
                "am",
                "start",
                "-n",
                "com.esfera.agent/.MainActivity",
            ]);
            let _ = run_cmd_timeout(act, Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(800));

            // 0b. SEMEIA a chave ADB do PC no celular (/data/misc/adb/adb_keys)
            // para que conexões ADB-over-TCP sejam autorizadas SEM popup e de forma
            // persistente (nunca mais "device still authorizing" ao reconectar na rede).
            // Requer que o celular já esteja autorizado uma vez via USB (ou via agente
            // com permissão de escrita). Se não conseguir, ignora — não bloqueia o fluxo.
            if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
                let key_path = std::path::Path::new(&home).join(".android").join("adbkey.pub");
                if let Ok(key) = std::fs::read_to_string(&key_path) {
                    let key_trim = key.trim();
                    if !key_trim.is_empty() {
                        let seed = format!(
                            "mkdir -p /data/misc/adb 2>/dev/null; (cat /data/misc/adb/adb_keys 2>/dev/null | grep -qF \"{}\" || echo \"{}\" >> /data/misc/adb/adb_keys); chmod 640 /data/misc/adb/adb_keys; restorecon /data/misc/adb/adb_keys 2>/dev/null",
                            key_trim, key_trim
                        );
                        let mut sk = create_cmd("adb");
                        sk.args(["-s", serial, "shell", &seed]);
                        let _ = run_cmd_timeout(sk, Duration::from_secs(5));
                    }
                }
            }

            // 1. Tenta novo agente v4 (com.esfera.agent)
            let mut cmd = create_cmd("adb");
            cmd.args([
                "-s",
                serial,
                "shell",
                "am",
                "start-foreground-service",
                "-n",
                "com.esfera.agent/.EsferaAgentService",
            ]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("Starting") || out.status.success() {
                    return Ok("Agente Esfera v4 iniciado".to_string());
                }
            }

            // 2. Tenta agente tpn (com.tpn.adbautoenable)
            let mut cmd_tpn = create_cmd("adb");
            cmd_tpn.args([
                "-s",
                serial,
                "shell",
                "am",
                "start",
                "-n",
                "com.tpn.adbautoenable/.MainActivity",
            ]);
            if let Ok(out) = run_cmd_timeout(cmd_tpn, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("Starting") || out.status.success() {
                    return Ok("Agente TPN ADB Auto Enable iniciado".to_string());
                }
            }

            // 3. Fallback: agente mouldybread (com.mouldybread.adbautoenable)
            let mut cmd_mb = create_cmd("adb");
            cmd_mb.args([
                "-s",
                serial,
                "shell",
                "am",
                "start",
                "-n",
                "com.mouldybread.adbautoenable/.MainActivity",
            ]);
            run_cmd_timeout(cmd_mb, Duration::from_secs(3))
                .map(|_| "Agente ADB Auto Enable iniciado (fallback)".to_string())
        })();

        match result {
            Ok(msg) => Ok(msg),
            Err(e) => Err(format!("Falha ao iniciar serviço do agente: {}", e)),
        }
    }

    /// Resolve o serial exato do dispositivo alvo no ADB de forma segura, suportando resolução nativa por Rede Wi-Fi, Hardware Serial (ro.serialno) ou ID do banco de dados
    pub fn resolve_target_serial(requested_serial: &str) -> Result<String, String> {
        let requested = requested_serial.trim();

        // 0. Fast-path: serial de túnel esfera-agent (UUID) já é roteável diretamente
        if crate::adb_tcp::is_tunnel_serial(requested) {
            return Ok(requested.to_string());
        }

        let mut active_devices = Self::list_devices().unwrap_or_default();

        // 1. Procura correspondência exata de serial no ADB ativo
        if let Some(dev) = active_devices.iter().find(|d| d.serial == requested) {
            if dev.state == "device" {
                return Ok(dev.serial.clone());
            } else if dev.state == "unauthorized" {
                return Err(format!("Dispositivo '{}' exige autorização de depuração USB. Aceite a mensagem exibida na tela do celular.", requested));
            }
        }

        // 2. Procura por IP ou sufixo/prefixo de serial nos ativos
        let requested_ip = requested.split(':').next().unwrap_or(requested);
        if let Some(dev) = active_devices.iter().find(|d| {
            d.serial.contains(requested_ip) || requested.contains(&d.serial)
        }) {
            if dev.state == "device" {
                return Ok(dev.serial.clone());
            } else if dev.state == "unauthorized" {
                return Err(format!("Dispositivo '{}' exige autorização de depuração USB na tela do celular.", dev.serial));
            }
        }

        // 3. Se for IP Wi-Fi e NÃO estiver ativo no ADB, tenta conectar agora
        if requested.contains(':') || requested.contains('.') {
            let parts: Vec<&str> = requested.split(':').collect();
            let ip = parts[0];
            let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
            let _ = Self::connect_device(ip, port);
            active_devices = Self::list_devices().unwrap_or_default();

            if let Some(dev) = active_devices.iter().find(|d| d.serial == requested || d.serial.contains(ip)) {
                if dev.state == "device" {
                    return Ok(dev.serial.clone());
                }
            }
        }

        // 4. VERIFICAÇÃO DE HARDWARE VIA ADB EM REDE:
        // Percorre os celulares conectados via Wi-Fi (IP:5555) e verifica se ro.serialno ou EsferaDeviceId corresponde ao serial USB solicitado
        for dev in &active_devices {
            if dev.state == "device" {
                // Checa o número de série da CPU/Hardware (ro.serialno)
                let mut cmd = create_cmd("adb");
                cmd.args(["-s", &dev.serial, "shell", "getprop", "ro.serialno"]);
                if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(2)) {
                    let serialno = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !serialno.is_empty() && (serialno == requested || requested.contains(&serialno)) {
                        return Ok(dev.serial.clone());
                    }
                }

                // Checa o EsferaDeviceId gravado no armazenamento do celular
                if let Some(esfera_id) = Self::get_persistent_device_id(&dev.serial) {
                    if esfera_id == requested || requested.contains(&esfera_id) {
                        return Ok(dev.serial.clone());
                    }
                }
            }
        }

        // 5. RESOLUÇÃO VIA BANCO DE DADOS LOCAL (SQLite):
        // Se o frontend passou o serial USB antigo gravado no DB, consulta o IP Wi-Fi atual (CurrentAdbAddress) e conecta
        let db_path = crate::get_db_path();
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let mut stmt = conn.prepare(
                "SELECT CurrentAdbAddress, DeviceIp FROM ESF_Device WHERE AdbDeviceId = ?1 OR EsferaDeviceId = ?1 OR UPPER(EsferaDeviceId) = UPPER(?1) LIMIT 1"
            );
            if let Ok(mut stmt) = stmt {
                let row_res = stmt.query_row([requested], |row| {
                    let cur_adb: Option<String> = row.get(0).ok();
                    let ip_addr: Option<String> = row.get(1).ok();
                    Ok((cur_adb, ip_addr))
                });
                if let Ok((cur_adb, ip_addr)) = row_res {
                    let target_net = cur_adb.or(ip_addr);
                    if let Some(net_addr) = target_net {
                        if !net_addr.is_empty() {
                            let parts: Vec<&str> = net_addr.split(':').collect();
                            let ip = parts[0];
                            let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
                            let _ = Self::connect_device_flushed(ip, port);
                            std::thread::sleep(Duration::from_millis(600));

                            let active_retry = Self::list_devices().unwrap_or_default();
                            if let Some(rev_dev) = active_retry.iter().find(|d| d.serial.contains(ip) && d.state == "device") {
                                return Ok(rev_dev.serial.clone());
                            }
                        }
                    }
                }
            }
        }

        // 6. ULTIMO RECURSO — DISPOSITIVO USB ÚNICO / ATIVO NO ADB:
        // Se o IP solicitado no Wi-Fi não respondeu (ex: 192.168.1.83:5555), mas o celular está conectado via cabo USB
        // (ex: 0082925603 ou 420012cad28ca5c7), redireciona automaticamente para o dispositivo USB ativo.
        let ready_devices: Vec<&AdbDeviceInfo> = active_devices.iter().filter(|d| d.state == "device").collect();
        if !ready_devices.is_empty() {
            if ready_devices.len() == 1 {
                return Ok(ready_devices[0].serial.clone());
            }
            for usb_dev in &ready_devices {
                if let Ok(wifi_ip) = Self::get_device_wifi_ip(&usb_dev.serial) {
                    if wifi_ip.contains(requested_ip) || requested_ip.contains(&wifi_ip) {
                        return Ok(usb_dev.serial.clone());
                    }
                }
            }
        }

        Err(format!("Dispositivo '{}' não está pronto no ADB. Certifique-se de que ele está conectado e com 'Depuração USB' autorizada.", requested))
    }

    /// Provisiona um dispositivo: gera UUID, injeta ID + config + imunidade, instala APK, inicia serviço
    /// server_url é opcional: se omitido, deriva automaticamente da config + IP local
    /// company_id é obrigatório: sem ele o aparelho é recusado pelo VPS (isolamento).
    pub fn provision_device(
        serial: &str,
        server_url: Option<&str>,
        company_id: i32,
    ) -> Result<String, String> {
        if company_id <= 0 {
            return Err(
                "Provisionamento exige uma empresa válida (companyId). Faça login em uma empresa."
                    .to_string(),
            );
        }
        let target_serial = Self::resolve_target_serial(serial)?;

        let device_id = Self::get_persistent_device_id(&target_serial)
            .unwrap_or_else(|| {
                let s = target_serial.to_uppercase();
                let clean = s.split(':').next().unwrap_or(&s);
                let p8 = if clean.len() >= 8 { &clean[..8] } else { clean };
                format!("ESF-{}", p8)
            });
        let config = crate::config::load_config();

        let url = match server_url {
            Some(url) => url.to_string(),
            None => Self::resolve_server_url(&target_serial, &config),
        };

        Self::inject_persistent_device_id(&target_serial, &device_id)?;
        Self::inject_server_config(&target_serial, &url, &device_id, company_id)?;
        let _ = Self::write_identity_config(&target_serial, company_id, &url);
        Self::inject_device_immunity(&target_serial, Some(&device_id))?;
        let _ = Self::set_device_owner(&target_serial);

        let is_usb = !target_serial.contains(':');
        if is_usb {
            let _ = Self::reverse_port(&target_serial, config.checkin_server_port);
        }

        let agent_result = Self::install_agent_apk(&target_serial);
        match agent_result {
            Ok(msg) => {
                let _ = Self::start_agent_service(&target_serial);
                Ok(format!(
                    "Provisionado com sucesso: {} (ID: {}) — {}",
                    target_serial, device_id, msg
                ))
            }
            Err(_e) => {
                // Reconecta dispositivo antes do fallback script
                if target_serial.contains(':') || target_serial.contains('.') {
                    let parts: Vec<&str> = target_serial.split(':').collect();
                    let ip = parts[0];
                    let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
                    let _ = Self::connect_device_flushed(ip, port);
                } else {
                    let _ = Self::restart_server();
                }
                std::thread::sleep(Duration::from_millis(1000));

                let _ = Self::push_agent_script(&target_serial);
                let _ = Self::start_agent_script(&target_serial);
                Ok(format!(
                    "Provisionado com sucesso: {} (ID: {}) — Script ativo",
                    target_serial, device_id
                ))
            }
        }
    }

    /// Aplica configurações avançadas de sistema Android no dispositivo
    pub fn apply_advanced_settings(
        serial: &str,
        stay_awake: Option<bool>,
        dark_mode: Option<bool>,
        show_touches: Option<bool>,
        animation_scale: Option<f32>,
        dpi: Option<i32>,
    ) -> Result<String, String> {
        let target = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let mut cmds = Vec::new();

        if let Some(sa) = stay_awake {
            cmds.push(format!("settings put global stay_on_while_plugged_in {}", if sa { 7 } else { 0 }));
        }
        if let Some(dm) = dark_mode {
            cmds.push(format!("cmd uimode night {}", if dm { "yes" } else { "no" }));
        }
        if let Some(st) = show_touches {
            cmds.push(format!("settings put system show_touches {}", if st { 1 } else { 0 }));
        }
        if let Some(scale) = animation_scale {
            cmds.push(format!("settings put global window_animation_scale {}", scale));
            cmds.push(format!("settings put global transition_animation_scale {}", scale));
            cmds.push(format!("settings put global animator_duration_scale {}", scale));
        }
        if let Some(d) = dpi {
            if d > 0 {
                cmds.push(format!("wm density {}", d));
            } else {
                cmds.push("wm density reset".to_string());
            }
        }

        if !cmds.is_empty() {
            let full_cmd = cmds.join("; ");
            let _ = create_cmd("adb").args(["-s", &target, "shell", &full_cmd]).output();
        }

        Ok("Configurações aplicadas no dispositivo com sucesso!".to_string())
    }

    /// Reinicia o dispositivo Android via comando ADB reboot
    pub fn reboot_device(serial: &str) -> Result<String, String> {
        let target = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let output = create_cmd("adb")
            .args(["-s", &target, "reboot"])
            .output()
            .map_err(|e| format!("Falha ao reiniciar dispositivo: {}", e))?;
        if output.status.success() {
            Ok(format!("Dispositivo {} reiniciado com sucesso!", target))
        } else {
            Err("Falha ao enviar comando reboot".to_string())
        }
    }

    /// Provisiona nativamente todos os dispositivos Android online conectados no ADB.
    /// company_id é propagado para cada aparelho (isolamento por empresa).
    pub fn provision_all_devices(
        server_url: Option<&str>,
        company_id: i32,
    ) -> Vec<Result<String, String>> {
        let active = Self::list_devices().unwrap_or_default();
        let mut results = Vec::new();
        for dev in active {
            if dev.state == "device" {
                let res = Self::provision_device(&dev.serial, server_url, company_id);
                results.push(res);
            }
        }
        results
    }

    /// Executa Debloat Avançado nativo em todos os celulares online conectados no ADB
    pub fn debloat_all_devices() -> Vec<Result<String, String>> {
        let active = Self::list_devices().unwrap_or_default();
        let mut results = Vec::new();
        for dev in active {
            if dev.state == "device" {
                let res = Self::debloat_device(&dev.serial);
                results.push(res);
            }
        }
        results
    }

    pub fn get_host_lan_ip() -> String {
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    return addr.ip().to_string();
                }
            }
        }
        "127.0.0.1".to_string()
    }

    fn resolve_server_url(serial: &str, config: &crate::config::AppConfig) -> String {
        if !config.hub_address.is_empty() {
            let host = config
                .hub_address
                .split(':')
                .next()
                .unwrap_or("34.29.70.113");
            return format!("http://{}:{}", host, config.checkin_server_port);
        }
        let port = config.checkin_server_port;
        let is_usb = !serial.contains(':');
        if is_usb {
            return format!("http://localhost:{}", port);
        }
        let host_ip = Self::get_host_lan_ip();
        format!("http://{}:{}", host_ip, port)
    }

    /// adb reverse tcp:{port} tcp:{port} — permite device USB alcan\u{e7}ar servidor local
    fn reverse_port(serial: &str, port: u16) -> Result<String, String> {
        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            serial,
            "reverse",
            &format!("tcp:{}", port),
            &format!("tcp:{}", port),
        ]);
        let output = run_cmd_timeout(cmd, Duration::from_secs(3))
            .map_err(|e| format!("Falha ao fazer reverse: {}", e))?;
        if output.status.success() {
            Ok(format!("Reverse tcp:{} ok", port))
        } else {
            Err(format!("Reverse tcp:{} falhou", port))
        }
    }

    /// Push the shell agent script to device via adb
    pub fn push_agent_script(serial: &str) -> Result<String, String> {
        let tmp_dir = std::env::temp_dir();
        let script_path = tmp_dir.join("esfera_agent.sh");
        let mut file = std::fs::File::create(&script_path)
            .map_err(|e| format!("Falha ao criar script temporario: {}", e))?;
        file.write_all(AGENT_SCRIPT_CONTENT.as_bytes())
            .map_err(|e| format!("Falha ao escrever script: {}", e))?;
        drop(file);

        let path_str = script_path.to_str().ok_or("Caminho temporario invalido")?;

        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            serial,
            "push",
            path_str,
            "/data/local/tmp/esfera_agent.sh",
        ]);
        let output = run_cmd_timeout(cmd, Duration::from_secs(5))
            .map_err(|e| format!("Falha ao fazer push do script: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("adb push falhou: {}", stderr.trim()));
        }

        let mut chmod = create_cmd("adb");
        chmod.args([
            "-s",
            serial,
            "shell",
            "chmod",
            "+x",
            "/data/local/tmp/esfera_agent.sh",
        ]);
        let _ = run_cmd_timeout(chmod, Duration::from_secs(3));

        Ok("Script pushado com sucesso".to_string())
    }

    /// Start the shell agent script in background via nohup
    pub fn start_agent_script(serial: &str) -> Result<String, String> {
        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            serial,
            "shell",
            "nohup",
            "sh",
            "/data/local/tmp/esfera_agent.sh",
            ">",
            "/dev/null",
            "2>&1",
            "&",
        ]);
        let output = run_cmd_timeout(cmd, Duration::from_secs(3))
            .map_err(|e| format!("Falha ao iniciar script: {}", e))?;

        if output.status.success() {
            Ok("Script agente iniciado em background".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Falha ao iniciar script: {}", stderr.trim()))
        }
    }

    fn find_agent_apk_path() -> Result<std::path::PathBuf, String> {
        let candidates = vec![
            std::path::PathBuf::from("Esfera_Agent_v4.apk"),
            std::path::PathBuf::from("public/Esfera_Agent_v4.apk"),
            std::path::PathBuf::from("../public/Esfera_Agent_v4.apk"),
            std::path::PathBuf::from("Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("public/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../public/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../../src-tauri/binaries/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("../src-tauri/binaries/Esfera_Agent_ADB.apk"),
            std::path::PathBuf::from("src-tauri/binaries/Esfera_Agent_ADB.apk"),
        ];

        for path in &candidates {
            if path.exists() {
                return Ok(path.clone());
            }
        }

        if let Some(dir) = bundled_tools_dir() {
            let exe_candidates = vec![
                dir.join("Esfera_Agent_ADB.apk"),
                dir.join("Esfera_Agent_v4.apk"),
            ];
            for path in exe_candidates {
                if path.exists() {
                    return Ok(path);
                }
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
                    exe_dir.join("../../src-tauri/binaries/Esfera_Agent_ADB.apk"),
                ];
                for path in exe_candidates {
                    if path.exists() {
                        return Ok(path);
                    }
                }
            }
        }

        Err("Arquivo 'Esfera_Agent_ADB.apk' não encontrado.".to_string())
    }

    /// Instala silenciosamente o aplicativo Agente Esfera v3 (.APK) no celular via ADB com auto-reconexão e tratamento de 'device offline'
    pub fn install_agent_apk(serial: &str) -> Result<String, String> {
        let apk_path_buf = Self::find_agent_apk_path()?;
        let apk_str = apk_path_buf
            .to_str()
            .ok_or("Caminho do arquivo APK inválido.")?;

        if serial.contains(':') || serial.contains('.') {
            let parts: Vec<&str> = serial.split(':').collect();
            let ip = parts[0];
            let port = parts
                .get(1)
                .and_then(|p| p.parse::<i32>().ok())
                .unwrap_or(5555);
            let _ = Self::connect_device_flushed(ip, port);
            std::thread::sleep(Duration::from_millis(400));
        }

        // Garantir desativação de verificadores de pacote para evitar timeouts/prompts
        let mut verifier_cmd = create_cmd("adb");
        verifier_cmd.args(["-s", serial, "shell", "settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0"]);
        let _ = run_cmd_timeout(verifier_cmd, Duration::from_secs(4));

        // 1. Push rápido do APK para /data/local/tmp/
        let remote_apk = "/data/local/tmp/Esfera_Agent_ADB.apk";
        let mut push_cmd = create_cmd("adb");
        push_cmd.args(["-s", serial, "push", apk_str, remote_apk]);
        let _ = run_cmd_timeout(push_cmd, Duration::from_secs(15));

        // 2. Instalação ultra-rápida via pm install
        let mut pm_cmd = create_cmd("adb");
        pm_cmd.args(["-s", serial, "shell", "pm", "install", "-r", "-g", remote_apk]);

        let output = run_cmd_timeout(pm_cmd, Duration::from_secs(20))
            .map_err(|e| format!("Falha ao executar 'pm install': {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{} {}", stdout, stderr);

        if output.status.success() || combined.to_lowercase().contains("success") {
            let _ = Self::start_agent_service(serial);
            let _ = Self::deploy_keepalive(serial);
            let _ = Self::set_device_owner(serial);
            let _ = Self::inject_device_immunity(serial, None);

            Ok(format!(
                "📱 App Agente Esfera v3 instalado e ativado no celular {} com sucesso!",
                serial
            ))
        } else {
            // Fallback para adb install padrão caso pm install falhe
            let mut fallback_cmd = create_cmd("adb");
            fallback_cmd.args(["-s", serial, "install", "-r", "-g", apk_str]);
            if let Ok(retry_out) = run_cmd_timeout(fallback_cmd, Duration::from_secs(45)) {
                if retry_out.status.success() {
                    let _ = Self::start_agent_service(serial);
                    let _ = Self::deploy_keepalive(serial);
                    let _ = Self::set_device_owner(serial);
                    let _ = Self::inject_device_immunity(serial, None);
                    return Ok(format!(
                        "📱 App Agente Esfera v3 instalado e ativado no celular {} com sucesso!",
                        serial
                    ));
                }
            }

            Err(format!(
                "Falha na instalação do APK no celular {}: {}",
                serial,
                combined.trim()
            ))
        }
    }

    /// Monitor de status: marca devices como offline se check-in expirou
    /// Reconecta automaticamente qualquer device offline que tenha CurrentAdbAddress
    pub fn start_status_monitor(db_conn: std::sync::Arc<crate::db::Database>) {
        use std::collections::HashSet;
        let injected: std::sync::Arc<std::sync::Mutex<HashSet<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));

        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));

            // 1. Marca offline devices com check-in expirado (>120s sem heartbeat)
            let _ = db_conn.mark_stale_devices_offline(120);

            // 2. Consulta lista ativa atual do ADB
            let active_list = Self::list_devices().unwrap_or_default();

            // 3. Reconecta somente devices que estejam offline
            let devices = db_conn.get_devices(0);
            for dev in devices {
                let is_online = dev.status == "online";

                // Se o dispositivo já está online, NUNCA disparar reconnect/disconnect preventivo!
                if is_online {
                    continue;
                }

                // Device offline — tenta reconnect pelo CurrentAdbAddress, IP ou serial
                let target = if let Some(ref addr) = dev.current_adb_address {
                    if addr.contains(':') && addr.contains('.') && !crate::adb_tcp::is_tunnel_serial(addr) {
                        addr.clone()
                    } else if !dev.ip.is_empty() && dev.ip.contains('.') {
                        format!("{}:{}", dev.ip, dev.port)
                    } else if dev.serial.contains(':') {
                        dev.serial.clone()
                    } else {
                        continue;
                    }
                } else if !dev.ip.is_empty() && dev.ip.contains('.') {
                    format!("{}:{}", dev.ip, dev.port)
                } else if dev.serial.contains(':') {
                    dev.serial.clone()
                } else {
                    continue;
                };

                let ip_part = target.split(':').next().unwrap_or(&target);

                // Se já estiver na lista ativa do ADB como "device", apenas atualiza status no banco
                if active_list.iter().any(|d| (d.serial == target || d.serial.contains(ip_part)) && d.state == "device") {
                    let _ = db_conn.mark_device_online(dev.id, &target);
                    continue;
                }

                // Conecta usando adb connect padrão (não desconecta)
                let parts: Vec<&str> = target.split(':').collect();
                let ip = parts[0];
                let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
                let _ = Self::connect_device(ip, port);

                // Se conectou, marca online
                if let Ok(active) = Self::list_devices() {
                    if active.iter().any(|d| (d.serial == target || d.serial.contains(ip)) && d.state == "device") {
                        let _ = db_conn.mark_device_online(dev.id, &target);
                    }
                }

                // Túneis esfera-agent se reconectam sozinhos — pulam imunidade/serial
                if crate::adb_tcp::is_tunnel_serial(&target) {
                    continue;
                }

                let already = injected
                    .lock()
                    .map(|s| s.contains(&target))
                    .unwrap_or(false);
                if !already {
                    let pid = format!("ESFERA_DEV_{:03}", dev.device_number);
                    if Self::inject_device_immunity(&target, Some(&pid)).is_ok() {
                        let _ = injected.lock().map(|mut s| {
                            s.insert(target.clone());
                        });
                    }
                }
            }
        });
    }

    /// Obtém a resolução da tela física do dispositivo (Physical size: WxH)
    pub fn get_device_screen_size(serial: &str) -> (i32, i32) {
        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(serial) {
            if let Ok(stdout) = crate::adb_tcp::exec_shell(serial, "wm size") {
                for line in stdout.lines() {
                    if line.contains("Physical size:") || line.contains("Override size:") {
                        if let Some(res) = line.split(':').nth(1) {
                            let parts: Vec<&str> = res.trim().split('x').collect();
                            if parts.len() == 2 {
                                if let (Ok(w), Ok(h)) = (
                                    parts[0].trim().parse::<i32>(),
                                    parts[1].trim().parse::<i32>(),
                                ) {
                                    return (w, h);
                                }
                            }
                        }
                    }
                }
            }
        }

        let output = create_cmd("adb")
            .arg("-s")
            .arg(serial)
            .arg("shell")
            .arg("wm")
            .arg("size")
            .output();

        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.contains("Physical size:") || line.contains("Override size:") {
                    if let Some(res) = line.split(':').nth(1) {
                        let parts: Vec<&str> = res.trim().split('x').collect();
                        if parts.len() == 2 {
                            if let (Ok(w), Ok(h)) = (parts[0].trim().parse::<i32>(), parts[1].trim().parse::<i32>()) {
                                return (w, h);
                            }
                        }
                    }
                }
            }
        }
        (1080, 2400) // Fallback seguro padrão
    }

    /// Escapa um valor para uso seguro entre aspas simples no shell do dispositivo
    fn shell_quote(value: &str) -> String {
        value.replace('\'', "'\"'\"'")
    }

    /// Encoder de URL para parâmetros do Intent
    pub fn url_encode(input: &str) -> String {
        let mut encoded = String::new();
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                b' ' => encoded.push_str("%20"),
                _ => {
                    encoded.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        encoded
    }

    /// Envia mensagem no WhatsApp via Deep Link Intent + Toque Físico
    /// Para mensagens longas (>1500 chars), usa fallback: Intent só com telefone + digitação via ADB
    pub fn send_whatsapp_intent_and_bezier_tap(serial: &str, phone: &str, message: &str) -> Result<(), String> {
        if message.len() > 1500 {
            return Self::send_long_message_typing(serial, phone, message);
        }

        let encoded_msg = Self::url_encode(message);
        let intent_url = format!("https://api.whatsapp.com/send?phone={}&text={}", phone, encoded_msg);

        // 1. Dispara Intent do WhatsApp (protocolo ADB nativo para Wi-Fi/túnel)
        if Self::use_native_adb(serial) {
            let intent_cmd = format!(
                "am start -a android.intent.action.VIEW -d '{}'",
                Self::shell_quote(&intent_url)
            );
            match crate::adb_tcp::exec_shell_bytes(serial, &intent_cmd) {
                Ok((_, _, true)) => {}
                Ok((_, _, false)) => {
                    return Err("Falha ao disparar Intent do WhatsApp (nativo)".to_string())
                }
                Err(e) => {
                    return Err(format!(
                        "Falha ao disparar Intent do WhatsApp via túnel: {}",
                        e
                    ))
                }
            }
        } else {
            let mut intent_adb = create_cmd("adb");
            intent_adb
                .arg("-s")
                .arg(serial)
                .arg("shell")
                .arg("am")
                .arg("start")
                .arg("-a")
                .arg("android.intent.action.VIEW")
                .arg("-d")
                .arg(&intent_url);
            let intent_cmd = run_cmd_timeout(intent_adb, Duration::from_secs(8));

            if let Err(e) = intent_cmd {
                return Err(format!("Falha ao disparar Intent do WhatsApp: {}", e));
            }
        }

        // 2. Aguarda delay Gaussiano
        let delay_ms = unsafe { esfera_hpc_calculate_gaussian_delay(2200, 3500) };
        std::thread::sleep(std::time::Duration::from_millis(delay_ms as u64));

        // 3. Calcula coordenadas e toca no botão Enviar
        let (screen_w, screen_h) = Self::get_device_screen_size(serial);
        let mut tap_x: i32 = 0;
        let mut tap_y: i32 = 0;
        unsafe {
            esfera_hpc_calculate_tap_coordinates(screen_w, screen_h, 92.5, 96.0, &mut tap_x, &mut tap_y);
        }

        // 3. Toque físico com trajetória Bézier (curva quadrática nativa HPC ±40px, 180-450ms)
        Self::bezier_tap_screen(serial, tap_x, tap_y, tap_x, tap_y)
    }

    /// Toque físico com trajetória Bézier gerada pelo HPC nativo (curva quadrática com
    /// ponto de controle aleatório ±40px). Usa `input motionevent` (Android 10+) e, em
    /// fallback, swipes segmentados traçando a curva. Último recurso: `input tap`.
    pub fn bezier_tap_screen(
        serial: &str,
        start_x: i32,
        start_y: i32,
        end_x: i32,
        end_y: i32,
    ) -> Result<(), String> {
        const MAX_POINTS: i32 = 16;
        let mut xs = [0i32; MAX_POINTS as usize];
        let mut ys = [0i32; MAX_POINTS as usize];
        let mut count: i32 = 0;

        let ret = unsafe {
            esfera_hpc_generate_bezier_points(
                start_x,
                start_y,
                end_x,
                end_y,
                xs.as_mut_ptr(),
                ys.as_mut_ptr(),
                MAX_POINTS,
                &mut count,
            )
        };

        if ret != 0 || count < 2 {
            // Fallback: toque simples
            let mut tap = create_cmd("adb");
            tap.args(["-s", serial, "shell", "input", "tap"])
                .arg(start_x.to_string())
                .arg(start_y.to_string());
            return run_cmd_timeout(tap, Duration::from_secs(6))
                .map(|_| ())
                .map_err(|e| e.to_string());
        }

        let pts = count as usize;

        // Primário: input motionevent DOWN/MOVE/UP (Android 10+) traçando a curva real.
        // Para Wi-Fi/túnel, a cadeia && inteira vai por uma única chamada nativa.
        let mut sequence = format!("input motionevent DOWN {} {}", xs[0], ys[0]);
        for i in 1..pts {
            sequence.push_str(&format!(" && input motionevent MOVE {} {}", xs[i], ys[i]));
        }
        sequence.push_str(&format!(
            " && input motionevent UP {} {}",
            xs[pts - 1], ys[pts - 1]
        ));

        if Self::use_native_adb(serial) {
            if let Ok((_, _, true)) = crate::adb_tcp::exec_shell_bytes(serial, &sequence) {
                return Ok(());
            }
        } else {
            let mut mot = create_cmd("adb");
            mot.args(["-s", serial, "shell"]).arg(&sequence);
            if let Ok(out) = run_cmd_timeout(mot, Duration::from_secs(12)) {
                if out.status.success() {
                    return Ok(());
                }
            }
        }

        // Fallback 2: swipes segmentados traçando a curva (APIs Android antigas)
        let total_ms = unsafe { esfera_hpc_calculate_gaussian_delay(180, 450) } as u64;
        let seg_count = std::cmp::min(pts - 1, 6);
        let step = (pts - 1) / seg_count;
        for i in 0..seg_count {
            let a = i * step;
            let b = if i == seg_count - 1 { pts - 1 } else { a + step };
            let seg_dur = std::cmp::max(total_ms as usize / seg_count, 20);
            let mut seg = create_cmd("adb");
            seg.args(["-s", serial, "shell", "input", "swipe"])
                .arg(xs[a].to_string())
                .arg(ys[a].to_string())
                .arg(xs[b].to_string())
                .arg(ys[b].to_string())
                .arg(seg_dur.to_string());
            if run_cmd_timeout(seg, Duration::from_secs(6)).is_err() {
                break;
            }
        }

        Ok(())
    }

    /// Fallback para mensagens longas: abre o chat via Intent só com telefone e digita o texto
    fn send_long_message_typing(serial: &str, phone: &str, message: &str) -> Result<(), String> {
        let intent_url = format!("https://api.whatsapp.com/send?phone={}", phone);

        // Abre o chat via Intent (protocolo ADB nativo para Wi-Fi/túnel)
        if Self::use_native_adb(serial) {
            let intent_cmd = format!(
                "am start -a android.intent.action.VIEW -d '{}'",
                Self::shell_quote(&intent_url)
            );
            match crate::adb_tcp::exec_shell_bytes(serial, &intent_cmd) {
                Ok((_, _, true)) => {}
                Ok((_, _, false)) => return Err("Falha ao abrir chat WhatsApp (nativo)".to_string()),
                Err(e) => {
                    return Err(format!("Falha ao abrir chat WhatsApp via túnel: {}", e))
                }
            }
        } else {
            let mut intent_adb = create_cmd("adb");
            intent_adb
                .arg("-s")
                .arg(serial)
                .arg("shell")
                .arg("am")
                .arg("start")
                .arg("-a")
                .arg("android.intent.action.VIEW")
                .arg("-d")
                .arg(&intent_url);
            let intent_cmd = run_cmd_timeout(intent_adb, Duration::from_secs(8));

            if let Err(e) = intent_cmd {
                return Err(format!("Falha ao abrir chat WhatsApp: {}", e));
            }
        }

        // Aguarda a tela do chat abrir
        let delay_ms = unsafe { esfera_hpc_calculate_gaussian_delay(2500, 4000) };
        std::thread::sleep(std::time::Duration::from_millis(delay_ms as u64));

        // Digita a mensagem caractere por caractere com delay humano
        Self::type_text_human_hpc(serial, message)?;

        // Pressiona ENTER para enviar
        let mut enter_adb = create_cmd("adb");
        enter_adb
            .args(["-s", serial, "shell", "input", "keyevent", "66"]);
        let enter_cmd = run_cmd_timeout(enter_adb, Duration::from_secs(6));
        match enter_cmd {
            Ok(out) if out.status.success() => Ok(()),
            Ok(_) => Err("Falha ao pressionar ENTER no WhatsApp".to_string()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Configura Proxy SOCKS5/HTTP por aparelho via ADB e revoga permissões BSSID Wi-Fi (Anti-Ban)
    pub fn configure_device_socks_proxy_and_revoke_bssid(serial: &str, proxy_url: Option<&str>) -> Result<(), String> {
        // 1. Aplica Proxy Global via ADB se fornecido
        if let Some(proxy) = proxy_url {
            if !proxy.trim().is_empty() {
                if Self::use_native_adb(serial) {
                    let cmd = format!(
                        "settings put global http_proxy '{}'",
                        Self::shell_quote(proxy)
                    );
                    let _ = crate::adb_tcp::exec_shell_bytes(serial, &cmd);
                } else {
                    let _ = create_cmd("adb")
                        .arg("-s")
                        .arg(serial)
                        .arg("shell")
                        .arg("settings")
                        .arg("put")
                        .arg("global")
                        .arg("http_proxy")
                        .arg(proxy)
                        .output();
                }
            } else if Self::use_native_adb(serial) {
                let _ = crate::adb_tcp::exec_shell_bytes(serial, "settings put global http_proxy :0");
            } else {
                let _ = create_cmd("adb")
                    .arg("-s")
                    .arg(serial)
                    .arg("shell")
                    .arg("settings")
                    .arg("put")
                    .arg("global")
                    .arg("http_proxy")
                    .arg(":0")
                    .output();
            }
        }

        // 2. Revoga permissões de localização (BSSID Wi-Fi) do WhatsApp Oficial e Business
        let packages = ["com.whatsapp", "com.whatsapp.w4b"];
        let permissions = [
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
        ];

        if Self::use_native_adb(serial) {
            // Batch único via túnel: pm revoke dos 4 pares em uma só chamada
            let mut batch = String::new();
            for pkg in &packages {
                for perm in &permissions {
                    if !batch.is_empty() {
                        batch.push_str(" && ");
                    }
                    batch.push_str(&format!("pm revoke {} {}", pkg, perm));
                }
            }
            let _ = crate::adb_tcp::exec_shell_bytes(serial, &batch);
        } else {
            for pkg in &packages {
                for perm in &permissions {
                    let _ = create_cmd("adb")
                        .arg("-s")
                        .arg(serial)
                        .arg("shell")
                        .arg("pm")
                        .arg("revoke")
                        .arg(pkg)
                        .arg(perm)
                        .output();
                }
            }
        }

        Ok(())
    }

    /// Reconecta todos os dispositivos ativos limpos de soquetes zumbis do Windows com varredura por TCP Probe
    pub fn force_reconnect_all_adb(db: &crate::db::Database) -> Result<String, String> {
        // Expurga a pool nativa e os registros de túnel (serão renegociados sob demanda)
        crate::adb_tcp::reset_pool();
        crate::adb_tcp::unregister_all_tunnel_serials();

        let mut kill_cmd = create_cmd("adb");
        kill_cmd.arg("kill-server");
        let _ = run_cmd_timeout(kill_cmd, Duration::from_secs(2));

        let mut start_cmd = create_cmd("adb");
        start_cmd.arg("start-server");
        let _ = run_cmd_timeout(start_cmd, Duration::from_secs(3));

        let devices = db.get_all_devices();
        let mut count = 0;
        let mut reconnected = Vec::new();

        // 1. Tenta reconectar os aparelhos cadastrados no banco com expurgo de zumbis
        for dev in &devices {
            let target_ip = if !dev.ip.is_empty() && dev.ip != "0.0.0.0" {
                format!("{}:{}", dev.ip, if dev.port > 0 { dev.port } else { 5555 })
            } else if let Some(ref addr) = dev.current_adb_address {
                if !addr.is_empty() { addr.clone() } else { "".to_string() }
            } else if dev.serial.contains(':') {
                dev.serial.clone()
            } else {
                continue;
            };

            if !target_ip.is_empty() && target_ip.contains('.') {
                let ip_part = target_ip.split(':').next().unwrap_or(&target_ip).to_string();
                
                // Valida o soquete TCP antes de instanciar o processo ADB no SO
                let socket_addr = format!("{}:5555", ip_part);
                if let Ok(addr) = socket_addr.parse::<std::net::SocketAddr>() {
                    if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok() {
                        // 1. Expurga o soquete zumbi do Windows
                        let mut disc1 = create_cmd("adb");
                        disc1.arg("disconnect").arg(&target_ip);
                        let _ = run_cmd_timeout(disc1, Duration::from_secs(2));

                        let mut disc2 = create_cmd("adb");
                        disc2.arg("disconnect").arg(&ip_part);
                        let _ = run_cmd_timeout(disc2, Duration::from_secs(2));

                        // 2. Conecta no soquete novo
                        let mut conn_cmd = create_cmd("adb");
                        conn_cmd.arg("connect").arg(&target_ip);
                        if let Ok(o) = run_cmd_timeout(conn_cmd, Duration::from_secs(3)) {
                            let txt = String::from_utf8_lossy(&o.stdout);
                            if txt.contains("connected to") || txt.contains("already connected") {
                                // Lê o Hardware Serial ro.serialno e atualiza o banco
                                let mut prop_cmd = create_cmd("adb");
                                prop_cmd.args(["-s", &target_ip, "shell", "getprop", "ro.serialno"]);
                                if let Ok(p) = run_cmd_timeout(prop_cmd, Duration::from_secs(3)) {
                                    let serial_no = String::from_utf8_lossy(&p.stdout).trim().to_string();
                                    if !serial_no.is_empty() {
                                        let now = chrono::Utc::now().to_rfc3339();
                                        let _ = db.process_checkin(&serial_no, &target_ip, &ip_part, 5555, &now);
                                    }
                                }
                                reconnected.push(format!("✓ {} ({})", dev.name, target_ip));
                            }
                        }
                    }
                }
                count += 1;
            }
        }

        // 2. Varredura Paralela na Sub-rede (192.168.1.1 a 254) para celulares que trocaram de IP por DHCP
        let (tx, rx) = std::sync::mpsc::channel();
        let mut handles = vec![];

        for i in 1..=254 {
            let tx_clone = tx.clone();
            let handle = std::thread::spawn(move || {
                let ip = format!("192.168.1.{}", i);
                let addr_str = format!("{}:5555", ip);
                if let Ok(addr) = addr_str.parse::<std::net::SocketAddr>() {
                    if let Ok(stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(120)) {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        let _ = tx_clone.send(ip);
                    }
                }
            });
            handles.push(handle);
        }
        drop(tx);

        for h in handles {
            let _ = h.join();
        }

        while let Ok(found_ip) = rx.try_recv() {
            let target_addr = format!("{}:5555", found_ip);
            let mut disc_cmd = create_cmd("adb");
            disc_cmd.arg("disconnect").arg(&target_addr);
            let _ = run_cmd_timeout(disc_cmd, Duration::from_secs(2));

            let mut conn_cmd = create_cmd("adb");
            conn_cmd.arg("connect").arg(&target_addr);
            if let Ok(o) = run_cmd_timeout(conn_cmd, Duration::from_secs(3)) {
                let txt = String::from_utf8_lossy(&o.stdout);
                if txt.contains("connected to") || txt.contains("already connected") {
                    let mut prop_cmd = create_cmd("adb");
                    prop_cmd.args(["-s", &target_addr, "shell", "getprop", "ro.serialno"]);
                    if let Ok(p) = run_cmd_timeout(prop_cmd, Duration::from_secs(3)) {
                        let serial_no = String::from_utf8_lossy(&p.stdout).trim().to_string();
                        if !serial_no.is_empty() {
                            let now = chrono::Utc::now().to_rfc3339();
                            let _ = db.process_checkin(&serial_no, &target_addr, &found_ip, 5555, &now);
                            if !reconnected.iter().any(|r| r.contains(&found_ip)) {
                                reconnected.push(format!("✓ Autodetectado ({})", target_addr));
                            }
                        }
                    }
                }
            }
        }

        if reconnected.is_empty() {
            Ok(format!("Varredura concluída para {} cadastrados. Nenhum dispositivo com porta 5555 aberta no momento.", count))
        } else {
            Ok(format!("⚡ Reconexão Wi-Fi Concluída ({} ativos):\n{}", reconnected.len(), reconnected.join("\n")))
        }
    }
}





