

// ============================================================
// Esfera v3 — Gerenciador ADB Nativo (adb_manager.rs)
// Comunicação nativa com o Android Debug Bridge CLI
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Aparelhos em que a leitura de tela pelo agente falhou recentemente (usa uiautomator).
static UI_DUMP_AGENT_DOWN: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Sequência das digitações pedidas ao agente (compõe o id de cada pedido).
static TYPING_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

const ESFERA_IME: &str = "com.esfera.agent/.EsferaKeyboardService";
const INPUT_METHOD_SETTING: &str = "settings get secure default_input_method";

// ID do banco: continua o mesmo ao trocar entre USB e Wi-Fi.
static CAMPAIGN_KEYBOARDS: std::sync::LazyLock<std::sync::Mutex<HashMap<i32, String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn parse_input_method_setting(output: &str) -> Option<String> {
    let value = output.trim();
    let (package, class) = value.split_once('/')?;
    let valid = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._".contains(&b));
    if valid(package) && valid(class) { Some(value.to_string()) } else { None }
}

fn is_esfera_keyboard(component: &str) -> bool {
    component == ESFERA_IME || component == "com.esfera.agent/com.esfera.agent.EsferaKeyboardService"
}

fn ime_command(action: &str, component: &str) -> Option<String> {
    if !matches!(action, "enable" | "set") { return None; }
    Some(format!("ime {} {}", action, parse_input_method_setting(component)?))
}

fn keyboard_to_restore(previous: &str, current: &str) -> Option<String> {
    let previous = parse_input_method_setting(previous)?;
    if is_esfera_keyboard(current) && !is_esfera_keyboard(&previous) { Some(previous) } else { None }
}

fn ensure_campaign_keyboard_with(
    previous: &mut Option<String>,
    shell: &mut dyn FnMut(&str) -> Result<String, String>,
) -> Result<bool, String> {
    let current = parse_input_method_setting(&shell(INPUT_METHOD_SETTING)?)
        .ok_or("Teclado atual desconhecido; usando acessibilidade")?;
    if is_esfera_keyboard(&current) { return Ok(true); }
    if previous.is_none() { *previous = Some(current); }
    shell(&ime_command("enable", ESFERA_IME).unwrap())?;
    shell(&ime_command("set", ESFERA_IME).unwrap())?;
    Ok(parse_input_method_setting(&shell(INPUT_METHOD_SETTING)?).as_deref().map(is_esfera_keyboard).unwrap_or(false))
}

fn restore_campaign_keyboard_with(
    previous: &str,
    shell: &mut dyn FnMut(&str) -> Result<String, String>,
) -> Result<bool, String> {
    let current = parse_input_method_setting(&shell(INPUT_METHOD_SETTING)?)
        .ok_or("Não foi possível ler o teclado atual")?;
    let Some(target) = keyboard_to_restore(previous, &current) else { return Ok(false); };
    shell(&ime_command("set", &target).unwrap())?;
    let restored = parse_input_method_setting(&shell(INPUT_METHOD_SETTING)?)
        .ok_or("Não foi possível confirmar o teclado restaurado")?;
    // Android pode expandir a classe abreviada na resposta.
    let expand = |s: &str| {
        let (package, class) = s.split_once('/').unwrap_or((s, ""));
        if class.starts_with('.') { format!("{}/{}{}", package, package, class) } else { s.to_string() }
    };
    if expand(&restored) != expand(&target) { return Err("Teclado anterior ainda não foi restaurado".into()); }
    Ok(true)
}

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
        candidates.push(dir.clone());
        // Build de desenvolvimento: exe em <repo>/src-tauri/target/<profile>/.
        // Sobe até src-tauri/binaries sem depender do cwd de lançamento.
        if let Some(src_tauri) = dir.parent().and_then(|p| p.parent()) {
            candidates.push(src_tauri.join("binaries"));
        }
    }
    // Caminho absoluto de src-tauri gravado em compile-time (CARGO_MANIFEST_DIR).
    // Robusto para builds locais; inexistente (e ignorado) em máquinas de produção.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("distributable").join("binaries"));
        candidates.push(cwd.join("src-tauri").join("binaries"));
        candidates.push(cwd.join("binaries"));
    }
    candidates
}

/// Um `adb.exe` só é utilizável no Windows com AdbWinApi.dll ao lado (platform-tools
/// sempre embarca). Um adb.exe avulso sem as DLLs morre com STATUS_DLL_NOT_FOUND
/// (0xC0000135), e aí TODO comando adb falha silenciosamente e a lista de
/// dispositivos fica vazia/offline. Por isso o candidato precisa ser completo.
fn has_usable_adb(dir: &std::path::Path) -> bool {
    if dir.join("adb.exe").exists() {
        if cfg!(target_os = "windows") {
            return dir.join("AdbWinApi.dll").exists();
        }
        return true;
    }
    dir.join("adb").exists()
}

/// Retorna o diretório onde estão as ferramentas embutidas (adb, scrcpy, jar, apk).
pub fn bundled_tools_dir() -> Option<PathBuf> {
    tools_dir_candidates().into_iter().find(|p| has_usable_adb(p))
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
    run_cmd_timeout_ref(&mut cmd, timeout)
}

fn run_cmd_timeout_ref(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output, String> {
    if timeout.is_zero() { return Err("O aparelho não respondeu dentro do prazo".into()); }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar comando: {}", e))?;
    let pid = child.id();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // wait_with_output drena stdout/stderr enquanto espera. Esperar o processo
        // primeiro pode bloquear quando o buffer de saída do ADB fica cheio.
        let _ = tx.send(match child.wait_with_output() {
            Ok(output) => Ok(output),
            Err(e) => Err(format!("Erro no processo: {}", e)),
        });
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            #[cfg(windows)]
            {
                // O processo de limpeza não deve prender o próprio caminho de timeout.
                let _ = create_cmd("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .spawn();
            }
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .spawn();
            }
            Err(format!(
                "Comando excedeu timeout de {}s.",
                timeout.as_secs()
            ))
        }
    }
}

pub trait CommandDeadline {
    fn output_timeout(&mut self, timeout: Duration) -> std::io::Result<std::process::Output>;
}
impl CommandDeadline for Command {
    fn output_timeout(&mut self, timeout: Duration) -> std::io::Result<std::process::Output> {
        run_cmd_timeout_ref(self, timeout).map_err(std::io::Error::other)
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
            cmd.current_dir(&dir);
            let adb_path = dir.join("adb.exe");
            if adb_path.exists() {
                cmd.env("ADB", &adb_path);
            }
            let server_path = dir.join("scrcpy-server");
            let server_jar = dir.join("scrcpy-server.jar");
            if server_path.exists() {
                cmd.env("SCRCPY_SERVER_PATH", &server_path);
            } else if server_jar.exists() {
                cmd.env("SCRCPY_SERVER_PATH", &server_jar);
            }
            if let Ok(current_path) = std::env::var("PATH") {
                cmd.env("PATH", format!("{};{}", dir.display(), current_path));
            } else {
                cmd.env("PATH", dir.display().to_string());
            }
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

#[allow(dead_code, improper_ctypes)]
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
    pub fn esfera_hpc_keystroke_delay_ms(prev_cp: i32, cur_cp: i32) -> i32;
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
static SHELL_TARGET_CACHE: std::sync::LazyLock<RwLock<HashMap<String, (String, Instant)>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));
#[allow(dead_code)]
static CONTACT_PREPARED: std::sync::LazyLock<RwLock<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Bloqueio de instalação que só se resolve no próprio celular (Xiaomi/Redmi/POCO).
pub fn install_block_hint(output: &str) -> Option<String> {
    if output.contains("INSTALL_FAILED_USER_RESTRICTED") {
        return Some("O celular bloqueou a instalação do Agente. Em Xiaomi/Redmi/POCO: Configurações > Configurações adicionais >             Opções do desenvolvedor > ligue \"Instalar via USB\" e \"Depuração USB (configurações de segurança)\"             (pode pedir chip e conta Mi). Depois clique em Reinstalar e aceite o aviso que aparecer na tela do celular.".into());
    }
    None
}

pub struct AdbManager;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityProbe {
    pub file: Option<String>,
    pub prop: String,
    pub hw_serial: String,
}

/// O que o Android responde sobre o serviço de acessibilidade do agente.
///
/// A lista de configuração (`enabled_accessibility_services`) não serve para saber
/// se o agente consegue digitar: quando o sistema derruba o serviço — o MIUI mata o
/// agente na limpeza de memória — o componente CONTINUA listado e o Android o guarda
/// em "Crashed services", de onde ele só sai se a configuração mudar. O aparelho fica
/// online, com a configuração correta, e mudo. Só o `dumpsys accessibility` conta a
/// verdade, e é dele que estes estados saem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessibilityState {
    /// Ligado de verdade: o Android está entregando eventos ao agente.
    Bound,
    /// O Android derrubou o serviço e não vai religar sozinho.
    Crashed,
    /// Listado, mas ainda não ligado (subindo, ou recusado pelo sistema).
    Listed,
    /// Nem está na lista de habilitados.
    Off,
    /// Não deu para ler o `dumpsys`; não dá para afirmar nada.
    Unknown,
}

impl AccessibilityState {
    /// Só `Bound` autoriza um disparo: nos outros casos o agente não digita.
    pub fn can_type(self) -> bool {
        matches!(self, AccessibilityState::Bound)
    }

    /// Rótulo curto para a tela de aparelhos e para o log de auditoria.
    pub fn label(self) -> &'static str {
        match self {
            AccessibilityState::Bound => "ok",
            AccessibilityState::Crashed => "caido",
            AccessibilityState::Listed => "ligando",
            AccessibilityState::Off => "missing",
            AccessibilityState::Unknown => "unknown",
        }
    }
}

impl AdbManager {
    pub const DEFAULT_WHATSAPP_PACKAGE: &'static str = "com.whatsapp";
    pub const BUSINESS_WHATSAPP_PACKAGE: &'static str = "com.whatsapp.w4b";
    /// Apps por onde o disparo pode sair: o envio segue o que estiver aberto no aparelho.
    pub const WHATSAPP_PACKAGES: [&'static str; 2] = [Self::DEFAULT_WHATSAPP_PACKAGE, Self::BUSINESS_WHATSAPP_PACKAGE];
    #[allow(dead_code)]
    pub const ESFERA_TEMP_CONTACT_ACCOUNT_NAME: &'static str = "esfera_temp";
    #[allow(dead_code)]
    pub const ESFERA_TEMP_CONTACT_ACCOUNT_TYPE: &'static str = "com.esfera";

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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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

        let prefix = if subnet_prefix.is_empty() {
            "192.168.1"
        } else {
            subnet_prefix.trim_end_matches('.')
        }
        .to_string();

        let num_workers = 16;
        let _max_concurrency = 48;
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
            "settings put global adb_allowed_connection_time 0",
            "settings put global tcp_keepalive_interval 15",
            "dumpsys deviceidle whitelist +com.esfera.agent",
            "dumpsys deviceidle whitelist +com.whatsapp",
            "dumpsys deviceidle whitelist +com.android.shell",
            "dumpsys deviceidle whitelist +com.google.android.gms",
            "cmd appops set com.esfera.agent RUN_IN_BACKGROUND allow",
            "cmd appops set com.esfera.agent RUN_ANY_IN_BACKGROUND allow",
            "cmd appops set com.esfera.agent REQUEST_IGNORE_BATTERY_OPTIMIZATIONS allow",
            "cmd appops set com.whatsapp RUN_IN_BACKGROUND allow",
            "cmd appops set com.whatsapp RUN_ANY_IN_BACKGROUND allow",
            "cmd appops set com.whatsapp REQUEST_IGNORE_BATTERY_OPTIMIZATIONS allow",
            "am set-standby-bucket com.esfera.agent active",
            "am set-standby-bucket com.whatsapp active",
            "am start-foreground-service com.esfera.agent/.EsferaAgentService",
        ];
        let mut errors: Vec<String> = Vec::new();
        for cmd in commands {
            let mut adb = create_cmd("adb");
            adb.args(["-s", serial, "shell", cmd]);
            let result = run_cmd_timeout(adb, Duration::from_secs(6));
            match result {
                Ok(out) if out.status.success() => {},
                _ => errors.push("Não foi possível aplicar uma das configurações de energia".into()),
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
            .output_timeout(Duration::from_secs(8))
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
        let _ = create_cmd("adb").arg("kill-server").output_timeout(Duration::from_secs(8));

        std::thread::sleep(std::time::Duration::from_millis(1000));

        let output = create_cmd("adb")
            .arg("start-server")
            .output_timeout(Duration::from_secs(8))
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
    #[allow(dead_code)]
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
        crate::adb_tcp::unregister_tunnel_serial(serial);

        let output = create_cmd("adb")
            .arg("disconnect")
            .arg(serial)
            .output_timeout(Duration::from_secs(8))
            .map_err(|e| format!("Falha ao executar 'adb disconnect': {}", e))?;

        let result = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(result)
    }

    /// Obtém o nível de bateria real em tempo real (0 a 100%) com dupla checagem (dumpsys + sysfs)
    pub fn get_battery_level(serial: &str) -> Result<i32, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        
        // Cache rápido de 3 segundos para evitar sobrecarga de chamadas repetidas
        if let Ok(cache) = BATTERY_CACHE.read() {
            if let Some(&(level, ts)) = cache.get(&target_serial) {
                if ts.elapsed() < Duration::from_secs(3) {
                    return Ok(level);
                }
            }
        }

        let mut level: Option<i32> = None;

        // 1. Tenta dumpsys battery sem pipe (funciona em 100% dos Androids)
        let out_text = if Self::use_native_adb(&target_serial) {
            crate::adb_tcp::exec_shell(&target_serial, "dumpsys battery").ok()
        } else {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", &target_serial, "shell", "dumpsys battery"]);
            run_cmd_timeout(cmd, Duration::from_secs(3)).ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        };

        if let Some(text) = out_text {
            let mut raw_level = None;
            let mut raw_scale = 100;
            for line in text.lines() {
                let l = line.trim();
                let lower = l.to_lowercase();
                if lower.starts_with("level:") {
                    if let Some(val_str) = l.split(':').nth(1) {
                        raw_level = val_str.trim().parse::<i32>().ok();
                    }
                } else if lower.starts_with("scale:") {
                    if let Some(val_str) = l.split(':').nth(1) {
                        if let Ok(sc) = val_str.trim().parse::<i32>() {
                            if sc > 0 {
                                raw_scale = sc;
                            }
                        }
                    }
                }
            }
            if let Some(lvl) = raw_level {
                let pct = (lvl * 100) / raw_scale;
                level = Some(pct.clamp(0, 100));
            }
        }

        // 2. Fallback via sysfs Linux (/sys/class/power_supply/*/capacity)
        if level.is_none() {
            let sysfs_out = if Self::use_native_adb(&target_serial) {
                crate::adb_tcp::exec_shell(&target_serial, "cat /sys/class/power_supply/battery/capacity 2>/dev/null || cat /sys/class/power_supply/*/capacity 2>/dev/null").ok()
            } else {
                let mut cmd = create_cmd("adb");
                cmd.args(["-s", &target_serial, "shell", "cat /sys/class/power_supply/battery/capacity 2>/dev/null || cat /sys/class/power_supply/*/capacity 2>/dev/null"]);
                run_cmd_timeout(cmd, Duration::from_secs(3)).ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            };
            if let Some(st) = sysfs_out {
                for word in st.split_whitespace() {
                    if let Ok(val) = word.trim().parse::<i32>() {
                        if (0..=100).contains(&val) {
                            level = Some(val);
                            break;
                        }
                    }
                }
            }
        }

        if let Some(final_level) = level {
            if let Ok(mut cache) = BATTERY_CACHE.write() {
                cache.insert(target_serial.clone(), (final_level, Instant::now()));
            }
            return Ok(final_level);
        }

        Err(format!("Não foi possível obter nível de bateria para {}", target_serial))
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
                        .output_timeout(Duration::from_secs(8))
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
                .output_timeout(Duration::from_secs(8))
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
        Self::execute_shell(serial, &format!("input tap {} {}", x, y), 6).map(|_| ())
    }

    /// Envia um evento de tecla com limite de tempo e sem trocar o aparelho.
    pub fn send_keyevent(serial: &str, keycode: u32) -> Result<(), String> {
        Self::execute_shell(serial, &format!("input keyevent {}", keycode), 6).map(|_| ())
    }

    /// Digitação direta de texto no celular (tecla a tecla, modelo psicomotor humano)
    pub fn input_text(serial: &str, text: &str) -> Result<(), String> {
        Self::type_text_human_hpc(serial, text)
    }

    /// Intervalo humano entre a tecla anterior e a atual (modelo psicomotor do motor C++,
    /// README seção 5: normal truncada 110±35 ms, penalidades de Shift/número/símbolo/acento,
    /// pausa reflexiva log-normal entre palavras).
    pub fn keystroke_delay_ms(prev: Option<char>, cur: char) -> u32 {
        let d = unsafe { esfera_hpc_keystroke_delay_ms(prev.map(|c| c as i32).unwrap_or(0), cur as i32) };
        d.max(0) as u32
    }

    /// Cronograma tecla a tecla: um intervalo em ms por code point de `text`, na ordem.
    pub fn keystroke_schedule(text: &str) -> Vec<u32> {
        let mut prev: Option<char> = None;
        text.chars()
            .map(|c| {
                let d = Self::keystroke_delay_ms(prev, c);
                prev = Some(c);
                d
            })
            .collect()
    }

    const TYPE_TEXT_ACTION: &'static str = "com.esfera.agent.TYPE_TEXT";
    const TYPE_TEXT_RECEIVER: &'static str = "com.esfera.agent/.TypeTextReceiver";
    const AGENT_ACCESSIBILITY_COMPONENT: &'static str =
        "com.esfera.agent/com.esfera.agent.accessibility.EsferaAccessibilityService";

    /// Chamado com a trava do aparelho. Falhar aqui mantém a acessibilidade disponível.
    pub fn ensure_campaign_keyboard(serial: &str, device_id: i32) -> bool {
        let mut previous = CAMPAIGN_KEYBOARDS.lock().unwrap_or_else(|e| e.into_inner()).get(&device_id).cloned();
        let result = ensure_campaign_keyboard_with(&mut previous, &mut |cmd| Self::execute_shell(serial, cmd, 3));
        if let Some(previous) = previous {
            CAMPAIGN_KEYBOARDS.lock().unwrap_or_else(|e| e.into_inner()).entry(device_id).or_insert(previous);
        }
        match result {
            Ok(true) => true,
            other => {
                eprintln!("[TECLADO] IME indisponível em {} ({:?}); seguindo com acessibilidade", serial, other);
                false
            }
        }
    }

    pub fn campaign_keyboard_device_ids() -> Vec<i32> {
        CAMPAIGN_KEYBOARDS.lock().unwrap_or_else(|e| e.into_inner()).keys().copied().collect()
    }

    /// Não sobrescreve uma troca manual do operador. Falhas ficam para a próxima limpeza.
    pub fn restore_campaign_keyboard(serial: &str, device_id: i32) -> Result<(), String> {
        let previous = CAMPAIGN_KEYBOARDS.lock().unwrap_or_else(|e| e.into_inner()).get(&device_id).cloned();
        let Some(previous) = previous else { return Ok(()); };
        if restore_campaign_keyboard_with(&previous, &mut |cmd| Self::execute_shell(serial, cmd, 3))? {
            println!("[TECLADO] Teclado anterior restaurado em {}", serial);
        }
        CAMPAIGN_KEYBOARDS.lock().unwrap_or_else(|e| e.into_inner()).remove(&device_id);
        Ok(())
    }

    /// Pede ao agente (serviço de acessibilidade do Esfera Agent) que digite `text` no campo
    /// focado, tecla a tecla, respeitando `delays`. O agente responde na hora pelo código de
    /// resultado do broadcast: 1 aceito, 2 acessibilidade inativa, 3 sem campo de texto,
    /// 4 argumentos inválidos, 5 ocupado. Ok(false) = agente indisponível (usar fallback).
    fn agent_type_text_request(serial: &str, id: &str, text: &str, delays: &[u32], clear: bool) -> Result<bool, String> {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let csv = delays.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
        let cmd = format!(
            "am broadcast -a {} -n {} --es id {} --es b64 {} --es delays {} --ez clear {}",
            Self::TYPE_TEXT_ACTION,
            Self::TYPE_TEXT_RECEIVER,
            id,
            b64,
            csv,
            clear
        );
        let out = match Self::execute_shell(serial, &cmd, 15) {
            Ok(o) => o,
            Err(e) => {
                println!("[DIGITACAO] Broadcast ao agente falhou em {}: {}", serial, e.trim());
                return Ok(false);
            }
        };
        let code = out
            .lines()
            .find_map(|l| l.trim().strip_prefix("Broadcast completed: result="))
            .and_then(|r| r.trim().split(|c: char| !c.is_ascii_digit() && c != '-').next()?.parse::<i32>().ok())
            .unwrap_or(-1);
        match code {
            1 => Ok(true),
            2 => {
                println!("[DIGITACAO] Serviço de acessibilidade do agente inativo em {}", serial);
                Ok(false)
            }
            3 => Err("Nenhum campo de texto focado na tela para digitar".to_string()),
            4 => Err("O agente recusou os argumentos da digitação".to_string()),
            5 => Err("O agente ainda está digitando outra mensagem neste aparelho".to_string()),
            _ => {
                println!(
                    "[DIGITACAO] Agente sem receptor de digitação em {} (APK antigo?): {}",
                    serial,
                    out.lines().last().unwrap_or("").trim()
                );
                Ok(false)
            }
        }
    }

    /// Lê o estado real do serviço no texto do `dumpsys accessibility`.
    ///
    /// É a única leitura confiável: a lista de configuração continua com o componente
    /// mesmo depois que o Android derruba o serviço, então quem pergunta só para ela
    /// recebe "está tudo certo" de um aparelho mudo.
    fn accessibility_state_from_dumpsys(dump: &str, component: &str) -> AccessibilityState {
        // As seções vêm indentadas, uma por linha: "Bound services:{...}".
        let secao = |nome: &str| {
            dump.lines()
                .map(str::trim)
                .find_map(|linha| linha.strip_prefix(nome))
        };
        let pacote = component.split('/').next().unwrap_or(component);
        let ligados = secao("Bound services:");
        let derrubados = secao("Crashed services:");
        let habilitados = secao("Enabled services:");

        // Sem nenhuma das seções o texto não é um dumpsys de acessibilidade
        // (aparelho offline, serviço inexistente): não dá para afirmar nada.
        if ligados.is_none() && derrubados.is_none() && habilitados.is_none() {
            return AccessibilityState::Unknown;
        }
        // A linha de "Bound services" traz o RÓTULO do serviço, truncado com reticências,
        // e não o nome do componente — por isso aqui a busca é pelo pacote.
        if ligados.is_some_and(|s| s.contains(pacote)) {
            return AccessibilityState::Bound;
        }
        if derrubados.is_some_and(|s| s.contains(component)) {
            return AccessibilityState::Crashed;
        }
        if habilitados.is_some_and(|s| s.contains(component)) {
            return AccessibilityState::Listed;
        }
        AccessibilityState::Off
    }

    /// Religa o serviço de acessibilidade do agente sobre um shell qualquer.
    ///
    /// Tirar o componente da lista e devolver é o ponto da função: o Android só
    /// reavalia os serviços quando esse valor MUDA. Enquanto ele fica parado, um
    /// serviço em "Crashed services" continua lá para sempre — foi o que deixou o
    /// aparelho SUPER mudo em 05/11/2026, depois que a limpeza do MIUI matou o agente.
    fn rebind_accessibility_with(
        shell: &mut dyn FnMut(&str) -> Result<String, String>,
    ) -> Result<(), String> {
        const CHAVE: &str = "enabled_accessibility_services";
        let atual = shell(&format!("settings get secure {}", CHAVE)).unwrap_or_default();
        // Os outros serviços de acessibilidade do aparelho (um leitor de tela, por
        // exemplo) não podem ser desligados no caminho.
        let outros: Vec<&str> = atual
            .trim()
            .split(':')
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "null" && !s.contains("EsferaAccessibilityService"))
            .collect();
        let sem_agente = outros.join(":");
        let com_agente = if sem_agente.is_empty() {
            Self::AGENT_ACCESSIBILITY_COMPONENT.to_string()
        } else {
            format!("{}:{}", sem_agente, Self::AGENT_ACCESSIBILITY_COMPONENT)
        };

        for valor in [&sem_agente, &com_agente] {
            shell(&format!(
                "settings put secure {} '{}'",
                CHAVE,
                Self::shell_quote(valor)
            ))
            .map_err(|e| format!("Não foi possível reescrever a acessibilidade: {}", e))?;
        }
        shell("settings put secure accessibility_enabled 1")
            .map_err(|e| format!("Não foi possível ligar a acessibilidade: {}", e))?;
        Ok(())
    }

    /// Despejo do estado da acessibilidade, filtrado no aparelho (o despejo inteiro
    /// tem dezenas de milhares de caracteres e nada mais nos interessa).
    const ACCESSIBILITY_DUMP: &'static str =
        "dumpsys accessibility | grep -E 'Bound services:|Enabled services:|Crashed services:'";

    /// Estado do serviço de acessibilidade do agente, lido do aparelho.
    /// `Unknown` quando o `dumpsys` não pôde ser lido — nunca um palpite otimista.
    pub fn accessibility_state(serial: &str) -> AccessibilityState {
        match Self::execute_shell(serial, Self::ACCESSIBILITY_DUMP, 8) {
            Ok(out) => {
                Self::accessibility_state_from_dumpsys(&out, Self::AGENT_ACCESSIBILITY_COMPONENT)
            }
            Err(_) => AccessibilityState::Unknown,
        }
    }

    /// Religa o serviço de acessibilidade do agente e devolve o que o aparelho passou
    /// a responder. Chamada no meio do disparo, quando o agente recusa uma digitação.
    fn ensure_agent_accessibility(serial: &str) -> AccessibilityState {
        let mut shell = |cmd: &str| Self::execute_shell(serial, cmd, 6);
        if let Err(e) = Self::rebind_accessibility_with(&mut shell) {
            println!(
                "[DIGITACAO] Não foi possível religar a acessibilidade em {}: {}",
                serial, e
            );
        }
        let _ = shell(
            "am start-foreground-service -n com.esfera.agent/.EsferaAgentService 2>/dev/null || am startservice -n com.esfera.agent/.EsferaAgentService 2>/dev/null",
        );
        // Esperar pela CONDIÇÃO, não por um tempo fixo: medido em 1,1 s num Redmi
        // Note 12, mas um aparelho carregado demora mais, e um prazo fixo curto
        // daria "não ligou" para um religamento que deu certo.
        let limite = Instant::now() + Duration::from_secs(8);
        loop {
            let estado = Self::accessibility_state(serial);
            if estado.can_type() || Instant::now() >= limite {
                println!(
                    "[DIGITACAO] Acessibilidade em {} depois de religar: {}",
                    serial,
                    estado.label()
                );
                return estado;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    }

    /// Espera o agente terminar a digitação `id` (ele registra `TYPED <id> OK|FAIL ...` no logcat).
    fn wait_agent_typing(serial: &str, id: &str, total_ms: u64) -> Result<(), String> {
        std::thread::sleep(Duration::from_millis(total_ms + 400));
        let ok_marker = format!("TYPED {} OK", id);
        let fail_marker = format!("TYPED {} FAIL", id);
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let out = Self::execute_shell(serial, "logcat -d -b main -v raw -s EsferaTyping:I", 8).unwrap_or_default();
            for line in out.lines() {
                let line = line.trim();
                if line.starts_with(&ok_marker) {
                    return Ok(());
                }
                if let Some(rest) = line.strip_prefix(&fail_marker) {
                    return Err(format!("O agente não concluiu a digitação: {}", rest.trim()));
                }
            }
            if Instant::now() >= deadline {
                // Nada foi enviado (o Enviar nem foi tocado): falha comum, o contato volta para a fila.
                return Err("O agente não confirmou o fim da digitação a tempo; nada foi enviado".to_string());
            }
            std::thread::sleep(Duration::from_millis(600));
        }
    }

    /// Fallback sem agente: `input text` do ADB, uma tecla por comando, com o mesmo cronograma.
    /// Só serve para ASCII (o `input text` do Android não digita acento, ç nem emoji).
    fn adb_type_ascii_per_key(serial: &str, text: &str, delays: &[u32]) -> Result<(), String> {
        let mut chunk: Vec<String> = Vec::new();
        let mut chunk_ms: u64 = 0;
        let flush = |chunk: &mut Vec<String>, chunk_ms: &mut u64| -> Result<(), String> {
            if chunk.is_empty() {
                return Ok(());
            }
            let batch = chunk.join("; ");
            Self::execute_shell(serial, &batch, *chunk_ms / 1000 + 15).map_err(|e| format!("Falha ao digitar texto: {}", e))?;
            chunk.clear();
            *chunk_ms = 0;
            Ok(())
        };
        for (ch, d) in text.chars().zip(delays.iter()) {
            let key = match ch {
                ' ' => "input text %s".to_string(),
                '\n' => "input keyevent 66".to_string(),
                '\'' => "input text \"'\"".to_string(),
                c => format!("input text '{}'", c),
            };
            chunk.push(format!("sleep {:.3}; {}", *d as f64 / 1000.0, key));
            chunk_ms += *d as u64;
            // Lotes curtos: o shell nativo por Wi-Fi tem leitura com timeout de 5 s.
            if chunk_ms >= 3000 {
                flush(&mut chunk, &mut chunk_ms)?;
            }
        }
        flush(&mut chunk, &mut chunk_ms)
    }

    /// Digitação humana tecla a tecla (modelo psicomotor C++). Caminho principal: serviço de
    /// acessibilidade do Esfera Agent (aceita acento, ç e emoji). Sem agente, cai para o
    /// `input text` do ADB tecla a tecla, só para texto ASCII. Nunca cola o texto inteiro.
    pub fn type_text_human_hpc(serial: &str, text: &str) -> Result<(), String> {
        Self::type_text_human_hpc_opts(serial, text, false, true)
    }

    /// Igual a `type_text_human_hpc`. `clear`: o agente esvazia o campo antes de digitar (o campo
    /// termina com exatamente `text`). `field_empty`: o campo já está vazio, então o fallback por
    /// ADB (que não sabe limpar) pode ser usado se o agente estiver indisponível.
    pub fn type_text_human_hpc_opts(serial: &str, text: &str, clear: bool, field_empty: bool) -> Result<(), String> {
        if text.trim().is_empty() {
            return Ok(());
        }
        let delays = Self::keystroke_schedule(text);
        let total_ms: u64 = delays.iter().map(|d| *d as u64).sum();
        let seq = TYPING_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let id = format!("t{:x}{:x}", nanos & 0xffff_ffff_ffff, seq);

        let mut accepted = Self::agent_type_text_request(serial, &id, text, &delays, clear)?;
        let mut estado = AccessibilityState::Unknown;
        if !accepted {
            estado = Self::ensure_agent_accessibility(serial);
            accepted = Self::agent_type_text_request(serial, &id, text, &delays, clear)?;
        }
        if accepted {
            println!(
                "[DIGITACAO] {} teclas em ~{:.1} s via agente (IME ou acessibilidade) ({})",
                delays.len(),
                total_ms as f64 / 1000.0,
                serial
            );
            return Self::wait_agent_typing(serial, &id, total_ms);
        }

        if !field_empty {
            return Err("Há rascunho no campo e o agente de acessibilidade está indisponível para limpá-lo".to_string());
        }
        if !text.is_ascii() {
            // Erro nomeando a causa: é ele que chega ao operador na campanha e no
            // cartão do aparelho. "Indisponível" sozinho não dizia o que fazer.
            let motivo = match estado {
                AccessibilityState::Crashed => "o sistema derrubou o serviço de acessibilidade do agente e ele não voltou (limpeza de memória do aparelho)",
                AccessibilityState::Off => "o serviço de acessibilidade do agente não está habilitado neste aparelho",
                _ => "o agente de acessibilidade está indisponível",
            };
            return Err(format!(
                "Digitação parada: {}, e o ADB não digita acento nem emoji. Ative o Esfera Agent em Acessibilidade no aparelho.",
                motivo
            ));
        }
        println!(
            "[DIGITACAO] Agente indisponível em {}: digitando {} teclas em ~{:.1} s via ADB (fallback ASCII)",
            serial,
            delays.len(),
            total_ms as f64 / 1000.0
        );
        Self::adb_type_ascii_per_key(serial, text, &delays)
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
        let output = cmd.output_timeout(Duration::from_secs(8));

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

    /// Lança o Scrcpy H.264 nativo com inicialização ultra-rápida, tratamento de falha prematura e resiliência de rede
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

        // Limpa instâncias prévias do scrcpy-server travadas no aparelho antes de abrir
        let _ = create_cmd("adb")
            .args(["-s", &target_serial, "shell", "pkill -f scrcpy"])
            .output_timeout(Duration::from_secs(8));

        // Parâmetros de Inicialização Ultra-Rápida e Baixa Latência
        let max_size = if is_wireless { "1024" } else { "1280" };
        let fps = "60";
        let bitrate = if is_wireless { "3M" } else { "8M" };

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
            "--force-adb-forward",
            "--no-audio",
            "--stay-awake",
            "--window-title",
            &title,
        ]);

        if turn_screen_off {
            cmd.arg("--turn-screen-off");
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!(
                "Scrcpy nativo não encontrado no sistema ({}). Certifique-se de que o executável 'scrcpy.exe' esteja instalado e adicionado ao PATH do Windows.",
                e
            )),
        };

        // VALIDAÇÃO EM TEMPO REAL: Aguarda 500ms para confirmar se o processo realmente permaneceu ativo.
        // Se o scrcpy falhar ao conectar (porta bloqueada, dispositivo não autorizado, etc.), ele encerra em < 500ms.
        std::thread::sleep(Duration::from_millis(500));
        match child.try_wait() {
            Ok(Some(status)) => {
                Err(format!(
                    "O Scrcpy tentou iniciar no dispositivo {}, mas encerrou prematuramente (código: {}). Verifique se o aparelho está desbloqueado, autorizado via USB/Wi-Fi ou se a rede está estável.",
                    target_serial, status
                ))
            }
            Ok(None) => {
                crate::scrcpy_manager::GLOBAL_SCRCPY_MANAGER.register_process(&target_serial, 0, "interactive", child)?;
                // O processo permanece rodando em execução ativa na janela!
                Ok(format!(
                    "Scrcpy H.264 inicializado com sucesso e ativo para {}! (Modo: {})",
                    serial,
                    if turn_screen_off { "Tela Física Desligada 🌙" } else { "Tela Física Ligada ⚡" }
                ))
            }
            Err(e) => {
                Err(format!("Erro ao validar processo do Scrcpy: {}", e))
            }
        }
    }

    /// Lança uma segunda Área de Trabalho Virtual independente (Display #1) via Scrcpy.
    /// O bot opera na Área #1 enquanto o supervisor usa livremente a tela física principal (Display #0).
    pub fn launch_scrcpy_virtual_display(
        _serial: &str,
        _width: u32,
        _height: u32,
        _dpi: u32,
    ) -> Result<String, String> {
        Err("Display virtual indisponível: o Scrcpy 2.4 empacotado não oferece esse recurso. É necessário atualizar e validar o Scrcpy e seu servidor antes de habilitá-lo.".to_string())
    }

    /// Executa um Intent do WhatsApp apontando para um Display específico (ex: Display ID 1)
    pub fn launch_intent_on_display(
        serial: &str,
        url: &str,
        display_id: u32,
    ) -> Result<String, String> {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let is_whatsapp = url.contains("whatsapp") || url.contains("wa.me");
        let pkg_flag = if is_whatsapp { "-p com.whatsapp " } else { "" };

        // Wi-Fi: protocolo ADB nativo em vez de adb.exe
        if Self::use_native_adb(&target_serial) {
            let intent_cmd = format!(
                "am start --display {} -a android.intent.action.VIEW {}-d '{}'",
                display_id,
                pkg_flag,
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

        let mut cmd = create_cmd("adb");
        cmd.args([
            "-s",
            &target_serial,
            "shell",
            "am",
            "start",
            "--display",
            &display_id.to_string(),
            "-a",
            "android.intent.action.VIEW",
        ]);
        if is_whatsapp {
            cmd.args(["-p", "com.whatsapp"]);
        }
        cmd.args(["-d", url]);

        let output = cmd
            .output_timeout(Duration::from_secs(8))
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
        let camera_arg = match facing {
            "front" => "front",
            "back" => "back",
            _ => return Err("Câmera inválida: selecione frontal ou traseira.".to_string()),
        };
        let title = format!(
            "Esfera v3 — Câmera Ao Vivo ({}) [{}]",
            target_serial,
            camera_arg.to_uppercase()
        );

        // Captura direta da câmera pelo scrcpy exige Android 12 ou superior.
        let sdk_native = if Self::use_native_adb(&target_serial) {
            crate::adb_tcp::exec_shell(&target_serial, "getprop ro.build.version.sdk")
        } else {
            let mut sdk_cmd = create_cmd("adb");
            sdk_cmd.args(["-s", &target_serial, "shell", "getprop", "ro.build.version.sdk"]);
            run_cmd_timeout(sdk_cmd, Duration::from_secs(3)).map(|o| {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            })
        };
        let sdk_level = sdk_native.ok().and_then(|s| s.trim().parse::<i32>().ok())
            .ok_or_else(|| format!("Não foi possível verificar a versão Android de {}.", target_serial))?;
        if sdk_level < 31 {
            return Err(format!("A captura direta de câmera exige Android 12 ou superior (SDK do aparelho: {}).", sdk_level));
        }

        // O modo câmera desativa o controle: --stay-awake exige controle e faz o scrcpy falhar.
        // Não selecionamos áudio: o modo câmera usaria o microfone por padrão.
        let mut child = create_cmd("scrcpy")
            .args([
                "-s",
                &target_serial,
                "--video-source=camera",
                &format!("--camera-facing={}", camera_arg),
                "--no-audio",
                "--max-size",
                "1280",
                "--max-fps",
                "30",
                "--video-bit-rate",
                "2M",
                "--window-title",
                &title,
            ])
            .spawn()
            .map_err(|e| format!("Falha ao iniciar transmissão direta de câmera: {}", e))?;

        std::thread::sleep(Duration::from_millis(2000));
        match child.try_wait() {
            Ok(Some(status)) => Err(format!("A transmissão direta da câmera {} encerrou prematuramente em {} ({}). Verifique a conexão ADB e a disponibilidade da câmera.", camera_arg, target_serial, status)),
            Ok(None) => Ok(format!("Transmissão direta da câmera {} iniciada em janela externa para {}.", camera_arg, target_serial)),
            Err(e) => Err(format!("Erro ao verificar a transmissão de câmera: {}", e)),
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
            .output_timeout(Duration::from_secs(8))
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
            .output_timeout(Duration::from_secs(8))
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
            // 3. Imuniza o WhatsApp e o Agente Esfera no Doze Mode
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
            vec![
                "shell",
                "dumpsys",
                "deviceidle",
                "whitelist",
                "+com.esfera.agent",
            ],
            // 4. Regras de permanência ativa e Wi-Fi sem sono
            vec!["shell", "settings", "put", "global", "wifi_sleep_policy", "2"],
            vec!["shell", "settings", "put", "global", "stay_on_while_plugged_in", "7"],
            vec!["shell", "dumpsys", "deviceidle", "disable"],
            // 5. Desativação do RAM Plus / Swap lento na memória Flash (Samsung)
            vec!["shell", "settings", "put", "global", "ram_expand_size", "0"],
            // 6. Fix de Phantom Processes (impede o Android de matar ADB/Agente em background)
            vec!["shell", "device_config", "put", "activity_manager", "max_phantom_processes", "2147483647"],
            // 7. Compilação AOT (Ahead-Of-Time Speed) para execução sem compilação JIT em CPUs fracas
            vec![
                "shell",
                "cmd",
                "package",
                "compile",
                "-m",
                "speed",
                "-f",
                "com.whatsapp",
            ],
            vec![
                "shell",
                "cmd",
                "package",
                "compile",
                "-m",
                "speed",
                "-f",
                "com.whatsapp.w4b",
            ],
            vec![
                "shell",
                "cmd",
                "package",
                "compile",
                "-m",
                "speed",
                "-f",
                "com.esfera.agent",
            ],
            // 8. Limpeza de caches residuais e trim de armazenamento flash
            vec!["shell", "pm", "trim-caches", "999G"],
        ];

        let mut success_count = 0;
        for cmd in &commands {
            let mut adb = create_cmd("adb");
            adb.arg("-s").arg(serial).args(cmd);
            let res = run_cmd_timeout(adb, Duration::from_secs(12));
            if let Ok(o) = res {
                if o.status.success() {
                    success_count += 1;
                }
            }
        }

        // Executa debloat de fábrica seguro (desativa telemetrias inúteis e apps de operadora)
        let debloat_msg = Self::debloat_device_profile(serial, "safe")
            .unwrap_or_else(|e| format!("Debloat parcial: {}", e));

        Ok(format!(
            "🚀 Otimização HPC XDA aplicada em {}!\n✓ {}/{} regras ativadas (AOT Speed, Zero Animação, RAM Fix, Doze Immunity)\n✓ {}",
            serial,
            success_count,
            commands.len(),
            debloat_msg
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
        let _ = create_cmd("adb").args(["-s", serial, "shell", "pm", "trim-caches", "999G"]).output_timeout(Duration::from_secs(8));

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

    /// Lê a identidade persistente do celular (/sdcard/.esfera_device_id; reserva: persist.esfera.device_id).
    /// Sem efeitos colaterais no aparelho: erro, ausência confirmada e identidade são estados distintos.
    /// Valor antigo ilegível (ex.: "ESFERA_DEV_001" gravado pelo monitor anterior) só vira a identidade
    /// legada "ESF-<serial>" quando o banco já conhece ESTE aparelho por ela; senão é erro, nunca ID novo.
    pub fn read_persistent_device_id(serial: &str) -> Result<Option<String>, String> {
        let probe = Self::probe_identity(serial)?;
        Self::resolve_identity(&probe, |candidate| Self::db_knows_identity(serial, &probe.hw_serial, candidate))
    }

    /// Uma leitura só: arquivo (ou ausência), propriedade e serial de hardware. `ESFERA_END` prova que a
    /// saída chegou inteira; saída cortada ou estranha é erro de leitura, nunca "sem identidade".
    const IDENTITY_PROBE: &'static str = "ls /sdcard >/dev/null 2>&1 || exit 1; if [ -e /sdcard/.esfera_device_id ]; then f=$(cat /sdcard/.esfera_device_id) || exit 1; printf 'ESFERA_FILE:%s\\n' \"$f\"; else echo ESFERA_FILE_ABSENT; fi; printf 'ESFERA_PROP:%s\\n' \"$(getprop persist.esfera.device_id)\"; printf 'ESFERA_HW:%s\\n' \"$(getprop ro.serialno)\"; echo ESFERA_END";

    fn probe_identity(serial: &str) -> Result<IdentityProbe, String> {
        Self::parse_identity_probe(&Self::execute_shell(serial, Self::IDENTITY_PROBE, 6)?)
    }

    fn parse_identity_probe(output: &str) -> Result<IdentityProbe, String> {
        let fail = || "Não foi possível ler a identidade do aparelho; tente de novo".to_string();
        let lines: Vec<&str> = output.lines().map(|l| l.trim_end_matches('\r')).collect();
        if lines.last().map(|l| l.trim()) != Some("ESFERA_END") { return Err(fail()); }
        let single = |prefix: &str| -> Result<Option<String>, String> {
            let found: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix(prefix)).collect();
            match found.as_slice() {
                [] => Ok(None),
                [value] => Ok(Some(value.trim().to_string())),
                _ => Err(fail()),
            }
        };
        let absent = lines.iter().filter(|l| l.trim() == "ESFERA_FILE_ABSENT").count();
        let file = match (single("ESFERA_FILE:")?, absent) {
            (Some(value), 0) => Some(value),
            (None, 1) => None,
            _ => return Err(fail()),
        };
        Ok(IdentityProbe {
            file,
            prop: single("ESFERA_PROP:")?.ok_or_else(fail)?,
            hw_serial: single("ESFERA_HW:")?.ok_or_else(fail)?,
        })
    }

    #[cfg(test)]
    pub fn parse_identity_read(output: &str) -> Result<Option<String>, String> {
        let lines: Vec<&str> = output.lines().map(|l| l.trim_end_matches('\r').trim()).filter(|l| !l.is_empty()).collect();
        let present: Vec<&str> = lines.iter().filter_map(|l| l.strip_prefix("ESFERA_ID_PRESENT:")).collect();
        let absent = lines.iter().any(|l| *l == "ESFERA_ID_ABSENT");
        match (present.as_slice(), absent) {
            ([val], false) if !val.trim().is_empty() => Ok(Some(val.trim().to_string())),
            ([], true) => Ok(None),
            _ => Err("Não foi possível ler a identidade do aparelho".into()),
        }
    }

    /// "ESF-…" com caracteres simples. "ESF-192.168.0.10" (derivada do IP por versão antiga) não vale.
    fn valid_identity(value: &str) -> bool {
        match value.strip_prefix("ESF-") {
            Some(rest) => !rest.is_empty()
                && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                && !(rest.contains('.') && rest.chars().all(|c| c.is_ascii_digit() || c == '.')),
            None => false,
        }
    }

    /// Identidade que versões antigas derivavam do serial de hardware ("ESF-" + 8 primeiros caracteres).
    fn legacy_identity(hw_serial: &str) -> Option<String> {
        let value = hw_serial.trim().to_uppercase();
        if value.is_empty() || value == "UNKNOWN" || value.contains(|c: char| c == ' ' || c == '.' || c == ':') {
            return None;
        }
        Some(format!("ESF-{}", value.chars().take(8).collect::<String>()))
    }

    /// Arquivo válido > propriedade válida > identidade legada confirmada pelo banco > ausência confirmada.
    /// Sobra ilegível sem confirmação do banco é erro: manter o vínculo atual e tentar de novo.
    fn resolve_identity(probe: &IdentityProbe, known: impl FnOnce(&str) -> Result<bool, String>) -> Result<Option<String>, String> {
        if let Some(file) = probe.file.as_deref().filter(|f| Self::valid_identity(f)) {
            return Ok(Some(file.to_string()));
        }
        if Self::valid_identity(&probe.prop) { return Ok(Some(probe.prop.clone())); }
        if let Some(legacy) = Self::legacy_identity(&probe.hw_serial) {
            if known(&legacy)? { return Ok(Some(legacy)); }
        }
        if probe.file.as_deref().is_some_and(|f| !f.is_empty()) || !probe.prop.is_empty() {
            return Err("A identidade gravada no aparelho está ilegível; nada foi alterado. Confira o cadastro do aparelho".into());
        }
        Ok(None)
    }

    /// O banco já conhece ESTE aparelho (mesmo endereço ou mesmo serial de hardware) por essa identidade?
    fn db_knows_identity(serial: &str, hw_serial: &str, identity: &str) -> Result<bool, String> {
        let fail = |_: rusqlite::Error| "Não foi possível conferir o vínculo atual do aparelho; tente de novo".to_string();
        let connection = rusqlite::Connection::open_with_flags(crate::get_db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(fail)?;
        let _ = connection.busy_timeout(Duration::from_secs(2));
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM ESF_Device WHERE UPPER(EsferaDeviceId)=UPPER(?1) AND (AdbDeviceId=?2 OR CurrentAdbAddress=?2 OR (?3 <> '' AND UPPER(AdbDeviceId)=UPPER(?3))))",
            rusqlite::params![identity, serial, hw_serial.trim()], |row| row.get(0)).map_err(fail)
    }

    /// Algum cadastro já usa este endereço ou este serial de hardware?
    fn db_has_device(serial: &str, hw_serial: &str) -> Result<bool, String> {
        let fail = |_: rusqlite::Error| "Não foi possível conferir o vínculo atual do aparelho; tente de novo".to_string();
        let connection = rusqlite::Connection::open_with_flags(crate::get_db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(fail)?;
        let _ = connection.busy_timeout(Duration::from_secs(2));
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM ESF_Device WHERE AdbDeviceId=?1 OR CurrentAdbAddress=?1 OR EsferaDeviceId=?1 OR (?2 <> '' AND UPPER(AdbDeviceId)=UPPER(?2)))",
            rusqlite::params![serial, hw_serial.trim()], |row| row.get(0)).map_err(fail)
    }

    /// Primeira adoção: só cria "ESF-<uuid>" quando a leitura CONFIRMA ausência e nenhum cadastro usa este
    /// aparelho. Leitura falha ou aparelho já cadastrado: erro, mantém o vínculo atual (nome soberano).
    pub fn identity_for_first_adoption(serial: &str) -> Result<String, String> {
        let probe = Self::probe_identity(serial)?;
        let read = Self::resolve_identity(&probe, |candidate| Self::db_knows_identity(serial, &probe.hw_serial, candidate));
        Self::decide_first_adoption(read, || Self::db_has_device(serial, &probe.hw_serial))
    }

    fn decide_first_adoption(read: Result<Option<String>, String>, registered: impl FnOnce() -> Result<bool, String>) -> Result<String, String> {
        if let Some(identity) = read? { return Ok(identity); }
        if registered()? {
            return Err("Não foi possível ler a identidade de um aparelho já cadastrado; nada foi alterado. Tente de novo".into());
        }
        Ok(format!("ESF-{}", uuid::Uuid::new_v4()))
    }

    pub fn require_persistent_device_id(serial: &str) -> Result<String, String> {
        Self::read_persistent_device_id(serial)?.ok_or_else(|| "Não foi possível ler a identidade do aparelho; tente de novo ou faça o primeiro provisionamento".into())
    }

    pub fn get_persistent_device_id(serial: &str) -> Option<String> {
        Self::read_persistent_device_id(serial).ok().flatten()
    }

    /// A identidade é a chave do nome dado pelo operador: trocá-la faria o aparelho voltar como
    /// "Celular XXXX". Só grava quando o aparelho não tem OUTRA identidade válida (reparar valor
    /// antigo ilegível é permitido).
    fn identity_write_allowed(probe: &IdentityProbe, identity: &str) -> Result<(), String> {
        if !Self::valid_identity(identity) { return Err("Identidade inválida; nada foi gravado no aparelho".into()); }
        let current = probe.file.as_deref().filter(|f| Self::valid_identity(f))
            .or_else(|| Some(probe.prop.as_str()).filter(|p| Self::valid_identity(p)));
        match current {
            Some(current) if current != identity => Err(format!(
                "O aparelho já tem a identidade {}; nada foi alterado, para preservar o nome do aparelho", current)),
            _ => Ok(()),
        }
    }

    /// Grava a identidade no aparelho (arquivo e propriedade), nunca por cima de outra identidade válida.
    pub fn inject_persistent_device_id(
        serial: &str,
        persistent_id: &str,
    ) -> Result<String, String> {
        let probe = Self::probe_identity(serial)?;
        Self::identity_write_allowed(&probe, persistent_id)?;
        let batch_cmd = format!(
            "setprop persist.esfera.device_id '{0}' 2>/dev/null; echo '{0}' > /sdcard/.esfera_device_id",
            persistent_id
        );
        Self::execute_shell(serial, &batch_cmd, 8)
            .map(|_| format!("🏷️ ID permanente '{}' injetada no celular {}", persistent_id, serial))
            .map_err(|e| format!("Falha ao injetar ID no celular {}: {}", serial, e))
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
            "{}settings put global wifi_sleep_policy 2; \
             settings put global verifier_verify_adb_installs 0; \
             settings put global package_verifier_enable 0; \
             setprop persist.adb.tcp.port 5555; \
             settings put global wifi_sleep_policy 2; \
             settings put global stay_on_while_plugged_in 7; \
             settings put global low_power 0; \
             settings put global low_power_trigger_level 0; \
             settings put global adb_allowed_connection_time 0; \
             settings put global tcp_keepalive_interval 15; \
             device_config put activity_manager max_phantom_processes 2147483647; \
             dumpsys deviceidle whitelist +com.android.shell; \
             dumpsys deviceidle whitelist +com.google.android.gms; \
             dumpsys deviceidle whitelist +com.esfera.agent; \
             dumpsys deviceidle whitelist +com.whatsapp; \
             cmd appops set com.esfera.agent RUN_IN_BACKGROUND allow; \
             cmd appops set com.esfera.agent RUN_ANY_IN_BACKGROUND allow; \
             cmd appops set com.esfera.agent REQUEST_IGNORE_BATTERY_OPTIMIZATIONS allow; \
             cmd appops set com.whatsapp RUN_IN_BACKGROUND allow; \
             cmd appops set com.whatsapp RUN_ANY_IN_BACKGROUND allow; \
             cmd appops set com.whatsapp REQUEST_IGNORE_BATTERY_OPTIMIZATIONS allow; \
             am set-standby-bucket com.esfera.agent active; \
             am set-standby-bucket com.whatsapp active; \
             am start-foreground-service -n com.esfera.agent/.EsferaAgentService 2>/dev/null || am startservice -n com.esfera.agent/.EsferaAgentService 2>/dev/null",
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
        // Primário = programa desktop atual (127.0.0.1 via adb reverse); VPS/host
        // recebido vira fallback. tunnelPort alinhado ao túnel do desktop.
        let cfg = crate::config::load_config();
        let primary_url = format!("http://127.0.0.1:{}", cfg.checkin_server_port);
        let tunnel_port = cfg.tunnel_server_port;
        let config_json = format!(
            "{{\\\"serverUrl\\\":\\\"{}\\\",\\\"fallbackServerUrl\\\":\\\"{}\\\",\\\"deviceId\\\":\\\"{}\\\",\\\"companyId\\\":{},\\\"tunnelPort\\\":{},\\\"heartbeatIntervalSec\\\":30}}",
            primary_url, server_url, device_id, company_id, tunnel_port
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
        let device_id = Self::require_persistent_device_id(serial)?;

        // PROGRAMA DESKTOP ATUAL É O PRIMÁRIO: o agente aponta para 127.0.0.1
        // (presença 7779 e túnel via `adb reverse`) e usa a VPS/host recebido
        // apenas como fallback. O IP do PC/celular deixa de importar.
        let cfg = crate::config::load_config();
        let primary_url = format!("http://127.0.0.1:{}", cfg.checkin_server_port);
        let fallback_url = server_url;
        let tunnel_port = cfg.tunnel_server_port;

        // JSON com aspas simples no shell (evita escape de aspas duplas).
        let json = format!(
            "{{\"deviceId\":\"{}\",\"companyId\":{},\"serverUrl\":\"{}\",\"fallbackServerUrl\":\"{}\",\"tunnelPort\":{}}}",
            device_id, company_id, primary_url, fallback_url, tunnel_port
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

    /// Pega a trava do aparelho (a mesma do envio) esperando no máximo `wait`. Nunca fica presa
    /// atrás de um envio: devolve "aparelho ocupado" quando o prazo acaba.
    fn lock_device_within(serial: &str, wait: Duration) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        let lock = crate::dispatcher::device_operation_lock(serial)?;
        let deadline = Instant::now() + wait;
        loop {
            match lock.clone().try_lock_owned() {
                Ok(guard) => return Ok(guard),
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
                Err(_) => return Err("O aparelho está ocupado com um envio ou outra operação agora; tente de novo em instantes".into()),
            }
        }
    }

    /// Executa o pipeline completo de Auto-Cura, Provisionamento e Imunidade Total (Zero-Touch)
    pub fn auto_heal_and_immunize_device(serial: &str, company_id: i32, server_url: &str) -> Result<(), String> {
        let _guard = match Self::lock_device_within(serial, Duration::from_secs(10)) {
            Ok(guard) => guard,
            Err(e) => {
                // Aparelho enviando: nada que mexa no adbd, na tela ou no agente. Só o `adb reverse`
                // (não interrompe o envio) para o agente continuar falando com o desktop.
                if let Err(re) = Self::setup_reverse_ports(serial, &crate::config::load_config()) {
                    eprintln!("[AUTO-CURA] Encaminhamento de portas falhou em {}: {}", serial, re);
                }
                return Err(format!("Auto-cura adiada em {}: {}", serial, e));
            }
        };
        // 1. Se for conexão USB inicial, ativa porta TCP/IP 5555 apenas se service.adb.tcp.port ainda não for 5555.
        // IMPORTANTE: Rodar `adb tcpip 5555` quando já está em 5555 reinicia o gadget USB FunctionFS do adbd,
        // causando som de desconexão/reconexão USB no Windows!
        if !serial.contains(':') && !serial.contains('.') {
            let mut tcp_port_cmd = create_cmd("adb");
            tcp_port_cmd.args(["-s", serial, "shell", "getprop service.adb.tcp.port; getprop persist.adb.tcp.port"]);
            let port_stdout = run_cmd_timeout(tcp_port_cmd, Duration::from_secs(3))
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            let port_already_5555 = port_stdout.lines().any(|l| l.trim() == "5555");

            let mut ip_cmd = create_cmd("adb");
            ip_cmd.args(["-s", serial, "shell", "ip route || ip addr show wlan0"]);
            let mut detected_ip: Option<String> = None;
            if let Ok(out) = run_cmd_timeout(ip_cmd, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for word in stdout.split_whitespace() {
                    if (word.starts_with("192.168.") || word.starts_with("10.")) && !word.ends_with(".255") {
                        let clean_ip = word.split('/').next().unwrap_or(word);
                        if clean_ip.contains('.') && clean_ip.split('.').count() == 4 {
                            detected_ip = Some(clean_ip.to_string());
                            break;
                        }
                    }
                }
            }

            let tcp_already_open = port_already_5555
                || detected_ip
                    .as_ref()
                    .and_then(|ip| format!("{}:5555", ip).parse::<std::net::SocketAddr>().ok())
                    .map(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok())
                    .unwrap_or(false);

            if !tcp_already_open {
                let mut tcp_cmd = create_cmd("adb");
                tcp_cmd.args(["-s", serial, "tcpip", "5555"]);
                let _ = run_cmd_timeout(tcp_cmd, Duration::from_secs(4));
            }

            if let Some(clean_ip) = detected_ip {
                let target_endpoint = format!("{}:5555", clean_ip);
                let already_connected = Self::list_devices()
                    .unwrap_or_default()
                    .iter()
                    .any(|d| d.serial == target_endpoint && d.state == "device");
                if !already_connected {
                    let _ = Self::connect_device(&clean_ip, 5555);
                }
            }
        }

        // 2. Grava a identidade no /sdcard/esfera_config.json
        let _ = Self::write_identity_config(serial, company_id, server_url);

        // 2.5. Encaminha as portas do programa desktop ATUAL (presença/túnel/check-in)
        // para dentro do aparelho via `adb reverse`. Assim o agente reporta ao
        // desktop ligado agora (127.0.0.1), sem depender de IP. Reaplicado em cada
        // auto-cura e, como o cache de cura é limpo quando o aparelho sai do ADB,
        // em cada reconexão. Vale para USB e Wi-Fi (reverse segue o transporte ADB).
        // A falha fica registrada e volta no fim: os passos seguintes (agente, imunidade, ouvinte do
        // SAIR) rodam mesmo assim.
        let reverse = Self::setup_reverse_ports(serial, &crate::config::load_config());
        if let Err(ref e) = reverse { eprintln!("[AUTO-CURA] Encaminhamento de portas falhou em {}: {}", serial, e); }

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

        // 4. Remove pacotes legados (com.tpn.adbautoenable / com.mouldybread.adbautoenable) que abrem tela no celular
        // e verifica se o APK do agente oficial (com.esfera.agent) está instalado
        let pkg_check = create_cmd("adb")
            .args(["-s", serial, "shell", "pm", "list", "packages"])
            .output_timeout(Duration::from_secs(8));
        let pkg_stdout = pkg_check
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        if pkg_stdout.contains("com.tpn.adbautoenable") {
            let mut u_cmd = create_cmd("adb");
            u_cmd.args(["-s", serial, "uninstall", "com.tpn.adbautoenable"]);
            let _ = run_cmd_timeout(u_cmd, Duration::from_secs(5));
        }
        if pkg_stdout.contains("com.mouldybread.adbautoenable") {
            let mut u_cmd = create_cmd("adb");
            u_cmd.args(["-s", serial, "uninstall", "com.mouldybread.adbautoenable"]);
            let _ = run_cmd_timeout(u_cmd, Duration::from_secs(5));
        }

        let is_installed = pkg_stdout.contains("com.esfera.agent");
        if !is_installed {
            let _ = Self::install_agent_apk_unlocked(serial);
        }

        // 5. Aplica a imunidade de bateria, prevencao de sono e wake lock
        let pid = Self::get_persistent_device_id(serial);
        let _ = Self::inject_device_immunity(serial, pid.as_deref());

        // 5b. Captura do "SAIR": libera o ouvinte de notificações do agente e o acesso ao arquivo
        //     /sdcard/esfera_optout.jsonl. Sem isso o pedido de descadastro não é registrado.
        let _ = Self::execute_shell(
            serial,
            "cmd notification allow_listener com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener; appops set --uid com.esfera.agent MANAGE_EXTERNAL_STORAGE allow",
            8,
        );

        // 6. Inicia o serviço em primeiro plano (silencioso, sem abrir Activity)
        let _ = Self::start_agent_service(serial);

        reverse.map_err(|e| format!("Auto-cura concluída, mas o encaminhamento de portas falhou: {}", e))
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
                        let _ = db.process_checkin(&pid, &full_addr, &ip, 5555, &chrono::Utc::now().to_rfc3339(), "");
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

    /// Inicia o serviço do Agent Android via ADB (100% em background, NUNCA abre MainActivity na tela)
    pub fn start_agent_service(serial: &str) -> Result<String, String> {
        let result = (|| -> Result<String, String> {
            // 0. Semeia a chave ADB do PC no celular (/data/misc/adb/adb_keys)
            // para que conexões ADB-over-TCP sejam autorizadas SEM popup e de forma
            // persistente (nunca mais "device still authorizing" ao reconectar na rede).
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

            // 1. Inicia o servico com.esfera.agent silenciosamente em background (NUNCA inicia MainActivity)
            let mut cmd = create_cmd("adb");
            cmd.args([
                "-s",
                serial,
                "shell",
                "am start-foreground-service -n com.esfera.agent/.EsferaAgentService 2>/dev/null || am startservice -n com.esfera.agent/.EsferaAgentService 2>/dev/null || am broadcast -a com.esfera.agent.KEEP_ALIVE -n com.esfera.agent/.BootReceiver 2>/dev/null",
            ]);
            if let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(3)) {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("Starting") || stdout.contains("Broadcast") || out.status.success() {
                    return Ok("Agente Esfera v4 iniciado em segundo plano".to_string());
                }
            }

            Err("Serviço com.esfera.agent não pôde ser iniciado em segundo plano".to_string())
        })();

        match result {
            Ok(msg) => Ok(msg),
            Err(e) => Err(format!("Falha ao iniciar serviço do agente: {}", e)),
        }
    }

    /// Resolve o serial exato do dispositivo alvo no ADB de forma segura, suportando resolução nativa por Rede Wi-Fi, Hardware Serial (ro.serialno) ou ID do banco de dados
    pub fn resolve_target_serial(requested: &str) -> Result<String, String> {
        Self::resolve_target_until(requested, Instant::now() + Duration::from_secs(12))
    }

    fn resolve_target_until(requested: &str, deadline: Instant) -> Result<String, String> {
        let requested = requested.trim();
        if requested.is_empty() { return Err("Informe o aparelho desejado".into()); }
        if crate::adb_tcp::is_tunnel_serial(requested) || requested.parse::<std::net::SocketAddr>().is_ok() { return Ok(requested.into()); }
        if let Ok(ip) = requested.parse::<std::net::IpAddr>() { return Ok(std::net::SocketAddr::new(ip,5555).to_string()); }
        let mut list = create_cmd("adb"); list.args(["devices"]);
        let out = run_cmd_timeout(list, deadline.saturating_duration_since(Instant::now()))?;
        let devices: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| {
            let mut fields = line.split_whitespace(); let id = fields.next()?;
            (fields.next()? == "device").then(|| id.to_string())
        }).collect();
        if devices.iter().any(|id| id == requested) { return Ok(requested.into()); }
        let mut matches = Vec::new();
        for candidate in devices {
            if Instant::now() >= deadline { break; }
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", &candidate, "shell", "getprop ro.serialno; cat /sdcard/.esfera_device_id 2>/dev/null || true"]);
            let budget = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(2));
            if let Ok(out) = run_cmd_timeout(cmd, budget) {
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                if out.status.success() && text.lines().any(|id| id.trim() == requested) {
                    let hardware = text.lines().next().unwrap_or("").trim().to_string();
                    matches.push((candidate, hardware));
                }
            }
        }
        Self::pick_matched_target(matches)
    }

    /// Escolhe o transporte entre os que apresentam a identidade pedida. O mesmo celular ligado por
    /// USB e por Wi-Fi aparece duas vezes com o mesmo `ro.serialno`: vale um só, USB primeiro.
    /// Aparelhos físicos diferentes com a mesma identidade continuam recusados.
    fn pick_matched_target(matches: Vec<(String, String)>) -> Result<String, String> {
        match matches.len() {
            0 => return Err("O aparelho solicitado não está disponível; confira a conexão e a autorização".into()),
            1 => return Ok(matches.into_iter().next().map(|(target, _)| target).unwrap_or_default()),
            _ => {}
        }
        let hardware = &matches[0].1;
        if hardware.is_empty() || matches.iter().any(|(_, hw)| hw != hardware) {
            return Err("Mais de um aparelho apresenta essa identidade; confira o cadastro antes de continuar".into());
        }
        let usb = matches.iter().find(|(target, _)| !target.contains(':') && !target.contains('.'));
        Ok(usb.unwrap_or(&matches[0]).0.clone())
    }

    /// Confere o endereço exato do aparelho e reconecta apenas aquele alvo de rede.
    pub fn ensure_dispatch_target(serial: &str) -> Result<(), String> {
        let addr: std::net::SocketAddr = match serial.parse() { Ok(a) => a, Err(_) => return Ok(()) };
        let ready = |devices: &[AdbDeviceInfo]| devices.iter().any(|d| d.serial == serial && d.state == "device");
        if ready(&Self::list_devices().unwrap_or_default()) { return Ok(()); }
        Self::connect_device(&addr.ip().to_string(), i32::from(addr.port()))
            .map_err(|e| format!("Aparelho Wi-Fi {} indisponível: {}", serial, e))?;
        if !ready(&Self::list_devices().unwrap_or_default()) { return Err(format!("Aparelho Wi-Fi {} não ficou disponível no ADB.", serial)); }
        // O envio usa o shell do ADB, não o encaminhamento de portas: a falha dele só é registrada
        // (a auto-cura reaplica) e nunca tira o aparelho do envio.
        if let Err(e) = Self::setup_reverse_ports(serial, &crate::config::load_config()) {
            eprintln!("[ADB] Encaminhamento de portas falhou em {} após reconectar: {}", serial, e);
        }
        Ok(())
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
        let _guard = Self::lock_device_within(&target_serial, Duration::from_secs(3))?;

        let device_id = Self::identity_for_first_adoption(&target_serial)?;
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

        // A falha do encaminhamento de portas não interrompe a instalação do agente; vira aviso no
        // fim (um erro aqui impediria o cadastro do ESF-ID, que o comando só grava com sucesso).
        let reverse_warning = match Self::setup_reverse_ports(&target_serial, &config) {
            Ok(()) => String::new(),
            Err(e) => {
                eprintln!("[PROVISIONAMENTO] Encaminhamento de portas falhou em {}: {}", target_serial, e);
                format!(" — atenção: o encaminhamento de portas falhou ({}); a auto-cura tenta de novo", e)
            }
        };

        let agent_result = Self::install_agent_apk_unlocked(&target_serial);
        match agent_result {
            Ok(msg) => {
                let _ = Self::start_agent_service(&target_serial);
                Ok(format!(
                    "Provisionado com sucesso: {} (ID: {}) — {}{}",
                    target_serial, device_id, msg, reverse_warning
                ))
            }
            Err(_e) => {
                // Reconecta dispositivo antes do fallback script
                if target_serial.contains(':') || target_serial.contains('.') {
                    let parts: Vec<&str> = target_serial.split(':').collect();
                    let ip = parts[0];
                    let port = parts.get(1).and_then(|p| p.parse::<i32>().ok()).unwrap_or(5555);
                    let _ = Self::connect_device_flushed(ip, port);
                }
                std::thread::sleep(Duration::from_millis(1000));

                let _ = Self::push_agent_script(&target_serial);
                let _ = Self::start_agent_script(&target_serial);
                Ok(format!(
                    "Provisionado com sucesso: {} (ID: {}) — Script ativo{}",
                    target_serial, device_id, reverse_warning
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
        let target = Self::resolve_target_serial(serial)?;
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
            let full_cmd = cmds.join(" && ");
            Self::execute_shell(&target, &full_cmd, 8)?;
        }

        Ok("Configurações aplicadas no dispositivo com sucesso!".to_string())
    }

    /// Reinicia o dispositivo Android via comando ADB reboot
    pub fn reboot_device(serial: &str) -> Result<String, String> {
        let target = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let output = create_cmd("adb")
            .args(["-s", &target, "reboot"])
            .output_timeout(Duration::from_secs(8))
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

    pub fn resolve_server_url(serial: &str, config: &crate::config::AppConfig) -> String {
        let port = config.checkin_server_port;
        if config.hub_enabled && config.mode != "standalone" && !config.hub_address.is_empty() {
            let host = config
                .hub_address
                .split(':')
                .next()
                .unwrap_or("127.0.0.1");
            return format!("http://{}:{}", host, port);
        }
        let is_usb = !serial.contains(':') && !serial.contains('.');
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

    /// Porta do servidor de Presença WebSocket (presence_server.rs). Fixa, igual
    /// à hardcoded em lib.rs. O agente conecta em ws://127.0.0.1:7779 e o `adb
    /// reverse` encaminha ao programa desktop atual, independente de IP.
    pub const PRESENCE_WS_PORT: u16 = 7779;

    /// Encaminha, via `adb reverse`, as portas do PROGRAMA DESKTOP ATUAL para
    /// dentro do aparelho (loopback 127.0.0.1): Presença (7779), Túnel reverso
    /// (config.tunnel_server_port) e, se habilitado, Check-in (checkin_server_port).
    ///
    /// Com isso o agente sempre alcança o desktop que está rodando AGORA, sem
    /// depender do IP do PC nem do celular — o IP é volátil, o `adb reverse`
    /// segue o transporte ADB (USB ou Wi-Fi). Reaplicado a cada auto-cura e a
    /// cada reconexão do aparelho. A VPS continua como fallback (no agente).
    pub fn setup_reverse_ports(serial: &str, config: &crate::config::AppConfig) -> Result<(), String> {
        if crate::adb_tcp::is_tunnel_serial(serial) { return Ok(()); }
        // Uma porta que falha não impede as outras; os erros voltam juntos no fim.
        let mut ports = vec![Self::PRESENCE_WS_PORT];
        if config.tunnel_server_enabled { ports.push(config.tunnel_server_port); }
        if config.checkin_server_enabled { ports.push(config.checkin_server_port); }
        let errors: Vec<String> = ports.into_iter().filter_map(|port| Self::reverse_port(serial, port).err()).collect();
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
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
        let _guard = Self::lock_device_within(serial, Duration::from_secs(3))?;
        Self::install_agent_apk_unlocked(serial)
    }

    fn install_agent_apk_unlocked(serial: &str) -> Result<String, String> {
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

        // 2. pm install com permissões concedidas; Xiaomi sem "Depuração USB (configurações de
        //    segurança)" recusa o -g, então tenta sem ele; por fim, adb install.
        let mut attempts: Vec<String> = Vec::new();
        let mut installed = false;
        for args in [
            vec!["-s", serial, "shell", "pm", "install", "-r", "-g", remote_apk],
            vec!["-s", serial, "shell", "pm", "install", "-r", remote_apk],
            vec!["-s", serial, "install", "-r", apk_str],
        ] {
            let mut cmd = create_cmd("adb");
            cmd.args(&args);
            let Ok(out) = run_cmd_timeout(cmd, Duration::from_secs(45)) else { continue };
            let text = format!("{} {}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if text.contains("Success") && !text.contains("Failure") {
                installed = true;
                break;
            }
            attempts.push(text);
        }
        let combined = attempts.join(" ");

        if installed {
            let _ = Self::execute_shell(serial, &ime_command("enable", ESFERA_IME).unwrap(), 3);
            let _ = Self::start_agent_service(serial);
            let _ = Self::deploy_keepalive(serial);
            let _ = Self::set_device_owner(serial);
            let _ = Self::inject_device_immunity(serial, None);
            Ok(format!(
                "📱 App Agente Esfera v3 instalado e ativado no celular {} com sucesso!",
                serial
            ))
        } else {
            if let Some(hint) = install_block_hint(&combined) {
                return Err(hint);
            }
            Err(format!(
                "Falha na instalação do APK no celular {}: {}",
                serial,
                combined.trim()
            ))
        }
    }

    /// Versão instalada consultada no aparelho; erro de ADB nunca significa "não instalado".
    pub fn agent_capabilities(serial: &str) -> Result<(String, String, bool), String> {
        let out = Self::execute_shell(serial, Self::CAPABILITIES_PROBE, 8)?;
        Ok(Self::parse_agent_capabilities(&out))
    }

    /// Sonda de capacidades. O `dumpsys` entra filtrado no aparelho (o despejo inteiro
    /// é enorme) e por último, porque é a única parte com várias linhas.
    const CAPABILITIES_PROBE: &'static str = "printf 'GO='; getprop ro.config.low_ram; printf 'ACCESS='; settings get secure enabled_accessibility_services; printf 'ENABLED='; settings get secure accessibility_enabled; printf 'LISTENER='; settings get secure enabled_notification_listeners; echo 'DUMP='; dumpsys accessibility | grep -E 'Bound services:|Enabled services:|Crashed services:'";

    fn parse_agent_capabilities(out: &str) -> (String, String, bool) {
        let field = |key: &str| out.lines().find_map(|line| line.strip_prefix(key));
        let low_ram = field("GO=").map(|v| v.trim() == "true").unwrap_or(false);

        // O `dumpsys` vem por último e ocupa o resto do texto.
        let estado = match out.find("DUMP=") {
            Some(i) => Self::accessibility_state_from_dumpsys(
                &out[i + "DUMP=".len()..],
                Self::AGENT_ACCESSIBILITY_COMPONENT,
            ),
            None => AccessibilityState::Unknown,
        };
        let accessibility = match estado {
            // Sem o `dumpsys` não dá para afirmar que está tudo certo: a lista de
            // configuração continua correta num aparelho que não digita mais nada.
            // O máximo honesto aqui é "não sei" — dizer "ok" foi o que escondeu do
            // operador, por sete minutos, um SUPER mudo em 05/11/2026.
            AccessibilityState::Unknown => match (field("ACCESS="), field("ENABLED=")) {
                (Some(services), Some(enabled))
                    if services.contains(Self::AGENT_ACCESSIBILITY_COMPONENT)
                        && enabled.trim() == "1" =>
                {
                    "unknown"
                }
                (Some(_), Some(_)) => "missing",
                _ => "unknown",
            },
            estado => estado.label(),
        };
        let notifications = match field("LISTENER=") {
            Some(value) if value.contains("com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener") => "ok",
            _ if low_ram => "unsupported",
            Some(_) => "denied",
            None => "unknown",
        };
        (notifications.into(), accessibility.into(), low_ram)
    }

    /// Decide se vale religar os serviços do agente.
    ///
    /// Estado desconhecido NÃO dispara restauração: num aparelho onde o `dumpsys`
    /// não pode ser lido isso viraria um laço de restaurações sem fim.
    fn agent_services_need_restore(accessibility: AccessibilityState, listeners: &str) -> bool {
        matches!(
            accessibility,
            AccessibilityState::Crashed | AccessibilityState::Listed | AccessibilityState::Off
        ) || !listeners.contains("com.esfera.agent/")
    }

    pub fn installed_agent_version(serial: &str) -> Result<Option<(u32,String)>, String> {
        let out = Self::execute_shell(serial, "result=$(pm list packages com.esfera.agent) || exit 1; if echo \"$result\" | grep -qx 'package:com.esfera.agent'; then dumpsys package com.esfera.agent; else echo ESFERA_AGENT_NOT_INSTALLED; fi", 8)?;
        parse_installed_agent_version(&out)
    }

    /// A chamada deve segurar o bloqueio do aparelho antes de instalar.
    pub fn auto_update_agent_unlocked(serial: &str, expected: u32) -> Result<(u32,String), String> {
        if crate::adb_tcp::is_tunnel_serial(serial) { return Err("Atualização automática por túnel reverso não está disponível; use USB ou Wi-Fi ADB.".into()); }
        let apk = find_matching_agent_apk(expected)?;
        Self::ensure_dispatch_target(serial)?;
        let path = apk.to_str().ok_or("Caminho do APK inválido")?;
        let mut cmd = create_cmd("adb");
        cmd.args(["-s",serial,"install","-r","-g",path]);
        let result = run_cmd_timeout(cmd,Duration::from_secs(90)).map_err(|e| format!("Falha ao atualizar o agente: {}",e))?;
        let text = format!("{} {}",String::from_utf8_lossy(&result.stdout),String::from_utf8_lossy(&result.stderr));
        if !result.status.success() || !text.to_lowercase().contains("success") { return Err(format!("Falha ao instalar o agente: {}",text.trim())); }
        let installed = Self::installed_agent_version(serial)?.ok_or("Agente não encontrado após a instalação")?;
        if installed.0 < expected { return Err("A versão instalada não corresponde ao APK esperado.".into()); }
        let _ = Self::execute_shell(serial, &ime_command("enable", ESFERA_IME).unwrap(), 3);
        Self::restore_agent_services_after_update(serial)?;
        Ok(installed)
    }

    pub fn ensure_agent_services(serial: &str) -> Result<(), String> {
        let listeners=Self::execute_shell(serial, "settings get secure enabled_notification_listeners", 6)?;
        // O estado vem do `dumpsys`, não da lista de configuração: ela continua
        // correta num aparelho cujo serviço o sistema derrubou.
        let estado = Self::accessibility_state(serial);
        let precisa = if estado == AccessibilityState::Unknown {
            // Aparelho que não respondeu ao `dumpsys`: resta a conferência antiga.
            let lista=Self::execute_shell(serial, "settings get secure enabled_accessibility_services", 6)?;
            let ligado=Self::execute_shell(serial, "settings get secure accessibility_enabled", 6)?;
            !(lista.contains(Self::AGENT_ACCESSIBILITY_COMPONENT) && ligado.trim() == "1")
                || !listeners.contains("com.esfera.agent/")
        } else {
            Self::agent_services_need_restore(estado, &listeners)
        };
        if !precisa { return Ok(()); }
        Self::restore_agent_services_after_update(serial)
    }

    fn restore_agent_services_after_update(serial: &str) -> Result<(), String> {
        // O encaminhamento de portas é tentado, mas a falha dele não impede religar a acessibilidade
        // e o ouvinte do SAIR (sem eles o descadastro deixa de ser capturado).
        let reverse = Self::setup_reverse_ports(serial, &crate::config::load_config());
        Self::restore_agent_services_with(&mut |cmd| Self::execute_shell(serial, cmd, 6), reverse)
    }

    /// Passos da restauração sobre um shell qualquer (o aparelho, ou um simulado nos testes).
    /// `reverse`: resultado do `adb reverse`, devolvido só no fim, depois de todos os passos.
    fn restore_agent_services_with(shell: &mut dyn FnMut(&str) -> Result<String, String>, reverse: Result<(), String>) -> Result<(), String> {
        if let Err(ref e) = reverse { eprintln!("[AGENTE] Encaminhamento de portas falhou ({}); seguindo com a restauração.", e); }
        // Acesso a todos os arquivos (gravação do SAIR em /sdcard) só existe no Android 11+ (SDK 30);
        // no Android 8–10 o agente grava com a permissão comum de armazenamento. Falha aqui não
        // interrompe a restauração, como na auto-cura.
        let sdk = shell("getprop ro.build.version.sdk").ok().and_then(|v| v.trim().parse::<u32>().ok());
        if sdk.map_or(true, |v| v >= 30) {
            if let Err(e) = shell("appops set --uid com.esfera.agent MANAGE_EXTERNAL_STORAGE allow") {
                eprintln!("[AGENTE] Acesso a todos os arquivos não aplicado (Android {:?}): {}", sdk, e);
            }
        }
        // Apagar e regravar, sempre. Conferir se o componente está na lista não basta:
        // depois que o sistema derruba o serviço ele continua listado, e só uma MUDANÇA
        // nesse valor faz o Android reavaliar e religar.
        Self::rebind_accessibility_with(shell)
            .map_err(|e| format!("Agente instalado, mas não foi possível ativar acessibilidade: {}", e))?;
        let accessibility = shell("settings get secure enabled_accessibility_services")
            .map_err(|e| format!("Não foi possível confirmar acessibilidade: {}",e))?;
        if !accessibility.contains(Self::AGENT_ACCESSIBILITY_COMPONENT) { return Err("Agente instalado, mas a acessibilidade não foi confirmada.".into()); }
        const LISTENER: &str = "com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener";
        // Android 8 (ex.: Samsung) não tem "cmd notification": o erro é ignorado e cai na gravação direta abaixo.
        let _ = shell(&format!("cmd notification allow_listener {}", LISTENER));
        let mut listeners = shell("settings get secure enabled_notification_listeners")
            .map_err(|e| format!("Não foi possível confirmar notificações: {}",e))?;
        if !listeners.contains("com.esfera.agent/") {
            let current = listeners.trim();
            let updated = if current.is_empty() || current == "null" { LISTENER.to_string() } else { format!("{}:{}", current, LISTENER) };
            let _ = shell(&format!("settings put secure enabled_notification_listeners '{}'", Self::shell_quote(&updated)));
            listeners = shell("settings get secure enabled_notification_listeners")
                .map_err(|e| format!("Não foi possível confirmar notificações: {}",e))?;
        }
        if !listeners.contains("com.esfera.agent/") { return Err("Agente instalado, mas o acesso às notificações não foi confirmado.".into()); }
        shell("am start-foreground-service -n com.esfera.agent/.EsferaAgentService 2>/dev/null || am startservice -n com.esfera.agent/.EsferaAgentService")
            .map_err(|e| format!("Agente instalado, mas o serviço não iniciou: {}",e))?;
        reverse.map_err(|e| format!("Agente restaurado, mas o encaminhamento de portas falhou: {}", e))
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

            // 1b. NÍVEL 3 (watchdog self-healing): se o ADB server travar ou a
            // lista de devices sumir repentinamente, reinicia o server e re-conecta
            // os IPs conhecidos do banco. Evita que um `adb kill-server`/travamento
            // deixe a frota inteira offline sem recovery (Gemini: "USB reset / aparelho
            // desapareceu" -> restart de transporte).
            let active_list = match Self::list_devices() {
                Ok(list) => list,
                Err(_) => {
                    // ADB server indisponível: reinicia e tenta recuperar.
                    let _ = Self::restart_server();
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let known = db_conn.get_devices(0);
                    for dev in &known {
                        let ip = if let Some(ref a) = dev.current_adb_address {
                            a.split(':').next().unwrap_or("").to_string()
                        } else { dev.ip.clone() };
                        if !ip.is_empty() && ip.contains('.') {
                            let _ = Self::connect_device(&ip, 5555);
                        }
                    }
                    Self::list_devices().unwrap_or_default()
                }
            };

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
                    let Some(pid) = Self::get_persistent_device_id(&target) else { continue; };
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
        if let Ok(stdout) = Self::execute_shell(serial, "wm size", 5) {
            for line in stdout.lines() {
                if line.contains("Physical size:") || line.contains("Override size:") {
                    if let Some(res) = line.split(':').nth(1) {
                        let parts: Vec<&str> = res.trim().split('x').collect();
                        if parts.len() == 2 {
                            if let (Ok(w), Ok(h)) = (parts[0].trim().parse::<i32>(), parts[1].trim().parse::<i32>()) { return (w,h); }
                        }
                    }
                }
            }
        }
        (1080, 2400)
    }

    /// Escapa um valor para uso seguro entre aspas simples no shell do dispositivo
    fn shell_quote(value: &str) -> String {
        value.replace('\'', "'\"'\"'")
    }

    /// Encoder de URL para parâmetros do Intent
    #[allow(dead_code)]
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

    /// Executa comando shell no dispositivo (suporta protocolo ADB nativo TCP e adb.exe USB)
    pub fn execute_shell(serial: &str, shell_cmd: &str, timeout_secs: u64) -> Result<String, String> {
        Self::execute_shell_for(serial, shell_cmd, Duration::from_secs(timeout_secs))
    }

    fn execute_shell_for(serial: &str, shell_cmd: &str, budget: Duration) -> Result<String, String> {
        if budget.is_zero() { return Err("O aparelho não respondeu dentro do prazo".into()); }
        let deadline = Instant::now() + budget;
        let cached = SHELL_TARGET_CACHE.read().ok().and_then(|cache| cache.get(serial).and_then(|(target, at)| {
            (at.elapsed() < Duration::from_secs(10)).then(|| target.clone())
        }));
        let target = match cached {
            Some(target) => target,
            None => {
                let target = Self::resolve_target_until(serial, deadline)?;
                if let Ok(mut cache) = SHELL_TARGET_CACHE.write() { cache.insert(serial.into(), (target.clone(), Instant::now())); }
                target
            }
        };
        if Self::use_native_adb(&target) {
            crate::adb_tcp::exec_shell_with_timeout(&target, shell_cmd, deadline.saturating_duration_since(Instant::now()))
        } else {
            let mut cmd = create_cmd("adb");
            cmd.args(["-s", &target, "shell", shell_cmd]);
            let output = run_cmd_timeout(cmd, deadline.saturating_duration_since(Instant::now()))?;
            if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).to_string()) }
            else { Err("Não foi possível executar a operação no aparelho; confira a conexão e as permissões".into()) }
        }
    }

    /// Faz o parse do ID numérico de um contato a partir do retorno de `content query`
    /// Retorna o maior ID numérico para garantir a seleção da linha recém-inserida
    #[allow(dead_code)]
    pub fn parse_contact_id_from_query(output: &str) -> Option<i64> {
        let mut max_id: Option<i64> = None;
        for line in output.lines() {
            let line = line.trim();
            if let Some(idx) = line.find("_id=") {
                let rest = &line[idx + 4..];
                let id_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(id) = id_str.parse::<i64>() {
                    max_id = Some(max_id.map_or(id, |curr| curr.max(id)));
                }
            }
        }
        max_id
    }

    /// Faz o parse do ID numérico de um contato a partir do retorno direto de `content insert`
    /// Exemplos: "Row inserted: content://com.android.contacts/raw_contacts/1234"
    #[allow(dead_code)]
    pub fn parse_inserted_raw_contact_id(output: &str) -> Option<i64> {
        for line in output.lines() {
            let line = line.trim();
            if let Some(idx) = line.find("raw_contacts/") {
                let rest = &line[idx + "raw_contacts/".len()..];
                let id_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(id) = id_str.parse::<i64>() {
                    return Some(id);
                }
            }
        }
        None
    }

    /// Sanitiza o número de telefone extraindo apenas os dígitos
    pub fn extract_phone_digits(phone: &str) -> String {
        phone.chars().filter(|c| c.is_ascii_digit()).collect()
    }

    /// Normaliza número de telefone garantindo prefixo DDI (55 para Brasil quando ausente)
    #[allow(dead_code)]
    pub fn normalize_target_phone(raw_phone: &str) -> String {
        let trimmed = raw_phone.trim();
        let starts_with_plus = trimmed.starts_with('+');
        let mut digits = Self::extract_phone_digits(trimmed);

        // Remove zeros à esquerda (ex: 011987654321 -> 11987654321)
        while digits.starts_with('0') {
            digits.remove(0);
        }

        if digits.is_empty() {
            return String::new();
        }

        // Se não possui prefixo '+' internacional explícito e é número brasileiro padrão (10 ou 11 dígitos com DDD)
        if !starts_with_plus && (digits.len() == 10 || digits.len() == 11) {
            digits = format!("55{}", digits);
        }

        digits
    }

    /// Assegura permissões essenciais de contatos para o pacote WhatsApp
    #[allow(dead_code)]
    pub fn grant_whatsapp_contact_permissions(serial: &str, package: &str) {
        let target_serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        if Self::use_native_adb(&target_serial) {
            let cmd = format!(
                "pm grant {} android.permission.READ_CONTACTS 2>/dev/null && pm grant {} android.permission.WRITE_CONTACTS 2>/dev/null",
                package, package
            );
            let _ = crate::adb_tcp::exec_shell_bytes(&target_serial, &cmd);
        } else {
            let _ = create_cmd("adb")
                .args(["-s", &target_serial, "shell", "pm", "grant", package, "android.permission.READ_CONTACTS"])
                .output_timeout(Duration::from_secs(8));
            let _ = create_cmd("adb")
                .args(["-s", &target_serial, "shell", "pm", "grant", package, "android.permission.WRITE_CONTACTS"])
                .output_timeout(Duration::from_secs(8));
        }
    }

    /// Todos os valores `<chave>=<número>` das linhas de um `content query` (uma por linha).
    fn parse_query_ids(output: &str, key: &str) -> Vec<i64> {
        let needle = format!("{}=", key);
        output.lines().filter_map(|line| {
            // Casa a coluna exata: "_id=" não pode casar dentro de "raw_contact_id=".
            let at = line.match_indices(&needle).map(|(i, _)| i)
                .find(|i| *i == 0 || !line[..*i].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))?;
            line[at + needle.len()..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
        }).collect()
    }

    /// Marcador único gravado no `sourceid` do raw_contact: é por ele que o id do contato
    /// recém-criado é achado, porque o `content insert` do Android padrão não imprime nada.
    fn temp_contact_marker(digits: &str) -> String {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let seq = TYPING_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("esf-{}-{:x}{:x}", digits, nanos & 0xffff_ffff_ffff, seq)
    }

    /// Insere um contato provisório na agenda do Android (via content provider nativo)
    /// Retorna o raw_contact_id para rastreamento e exclusão. Idempotente pelo número canônico:
    /// se a conta `esfera_temp` já tem esse número, devolve o contato que existe.
    #[allow(dead_code)]
    pub fn insert_temporary_contact(serial: &str, _contact_name: &str, phone: &str) -> Result<Option<i64>, String> {
        static CONTACT_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = CONTACT_WRITES.lock().unwrap_or_else(|e| e.into_inner());
        let marker = Self::temp_contact_marker(&Self::normalize_target_phone(phone));
        let result = Self::insert_temporary_contact_with(phone, &marker, &mut |cmd| Self::execute_shell(serial, cmd, 6));
        if let Err(ref e) = result { eprintln!("[CONTATOS TEMP] {} em {}: {}", phone, serial, e); }
        result
    }

    /// Lógica do contato temporário sobre um shell qualquer (o aparelho, ou um simulado nos testes).
    fn insert_temporary_contact_with(phone: &str, marker: &str, shell: &mut dyn FnMut(&str) -> Result<String, String>) -> Result<Option<i64>, String> {
        let digits = Self::normalize_target_phone(phone);
        if digits.len() < 10 { return Err("Número de telefone não contém dígitos válidos".into()); }
        let query = format!("content query --uri content://com.android.contacts/data --projection raw_contact_id --where \"account_name='{}' AND account_type='{}' AND mimetype='vnd.android.cursor.item/phone_v2' AND (data1='+{}' OR data4='+{}')\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, Self::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE, digits, digits);
        let existing = shell(&query)?;
        let ids = Self::parse_query_ids(&existing, "raw_contact_id");
        if let Some(id) = ids.iter().min().copied() {
            // Contatos repetidos do mesmo número (sobra de versões antigas) não impedem o envio:
            // todos levam à mesma conversa no WhatsApp.
            if ids.len() > 1 { println!("[CONTATOS TEMP] {} contatos temporários para {}; usando o {}.", ids.len(), digits, id); }
            return Ok(Some(id));
        }
        if !existing.contains("No result") { return Err("Não foi possível conferir o contato temporário na agenda".into()); }

        // Apaga o raw_contact (e os dados dele) criado com o marcador; usado em qualquer falha.
        let delete_marked = format!(
            "content delete --uri \"content://com.android.contacts/raw_contacts?caller_is_syncadapter=true\" --where \"account_name='{}' AND sourceid='{}'\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, marker);
        let inserted = shell(&format!(
            "content insert --uri content://com.android.contacts/raw_contacts --bind account_name:s:{} --bind account_type:s:{} --bind sourceid:s:{}",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, Self::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE, marker));
        // O `content insert` não imprime o endereço criado no Android padrão: o id vem da consulta
        // pelo marcador (também quando o comando falhou depois de gravar).
        let by_marker = format!("content query --uri content://com.android.contacts/raw_contacts --projection _id --where \"sourceid='{}'\"", marker);
        let id = match shell(&by_marker).map(|out| Self::parse_query_ids(&out, "_id")) {
            Ok(found) if found.len() == 1 => found[0],
            _ => {
                let _ = shell(&delete_marked);
                return Err(match inserted {
                    Err(e) => format!("Não foi possível criar o contato temporário: {}", e),
                    Ok(_) => "O aparelho não confirmou a criação do contato temporário".into(),
                });
            }
        };
        let mut fill = || -> Result<(), String> {
            for command in [
                format!("content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:{} --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'Esfera {}' --bind data2:s:'Esfera {}'", id, digits, digits),
                format!("content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:{} --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:'+{}' --bind data2:i:2 --bind data4:s:'+{}'", id, digits, digits),
            ] {
                // Sem conferir a saída: o Android padrão não imprime nada; a prova é a consulta abaixo.
                shell(&command)?;
            }
            let saved = shell(&query)?;
            if !Self::parse_query_ids(&saved, "raw_contact_id").contains(&id) {
                return Err("O número do contato temporário não foi confirmado na agenda".into());
            }
            Ok(())
        };
        if let Err(error) = fill() {
            let _ = shell(&delete_marked);
            let _ = shell(&format!("content delete --uri content://com.android.contacts/data --where raw_contact_id={}; content delete --uri content://com.android.contacts/raw_contacts --where _id={}", id, id));
            return Err(error);
        }
        Ok(Some(id))
    }

    /// Exclui um contato temporário específico, só se ele for da conta do Esfera e ainda tiver o
    /// nome exato "Esfera <número>". Nunca apaga por id solto (o id pode ser de um contato do operador).
    #[allow(dead_code)]
    pub fn delete_temporary_contact(serial: &str, contact_id: Option<i64>) -> Result<(), String> {
        let Some(id) = contact_id else { return Ok(()) };
        let lista = Self::execute_shell(serial, &Self::temp_contacts_query(), 8)?;
        if Self::deletable_temp_contact_ids(&lista).contains(&id) {
            Self::execute_shell(serial, &Self::delete_temp_ids_command(&[id]), 8)?;
        }
        Ok(())
    }

    /// Apaga só os contatos temporários do Esfera: conta `esfera_temp` E nome exato "Esfera <número>".
    /// Contato salvo ou renomeado pelo operador, mesmo que tenha ficado dentro da conta do Esfera, fica.
    pub fn cleanup_all_temporary_contacts(serial: &str) -> Result<(), String> {
        let apagados = Self::cleanup_temporary_contacts_with(&mut |cmd| Self::execute_shell(serial, cmd, 10))?;
        if apagados > 0 { println!("[CONTATOS TEMP] {} contatos \"Esfera <número>\" apagados de {}.", apagados, serial); }
        Ok(())
    }

    fn cleanup_temporary_contacts_with(shell: &mut dyn FnMut(&str) -> Result<String, String>) -> Result<usize, String> {
        let lista = shell(&Self::temp_contacts_query())?;
        let ids = Self::deletable_temp_contact_ids(&lista);
        for lote in ids.chunks(40) {
            shell(&Self::delete_temp_ids_command(lote))?;
        }
        Ok(ids.len())
    }

    fn temp_contacts_query() -> String {
        format!(
            "content query --uri content://com.android.contacts/raw_contacts --projection _id:display_name --where \"account_name='{}' AND account_type='{}'\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, Self::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE
        )
    }

    fn delete_temp_ids_command(ids: &[i64]) -> String {
        let lista = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        format!(
            "content delete --uri \"content://com.android.contacts/raw_contacts?caller_is_syncadapter=true\" --where \"account_name='{}' AND account_type='{}' AND _id IN ({})\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, Self::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE, lista
        )
    }

    /// Ids que podem ser apagados: nome exatamente "Esfera " + 10 a 13 dígitos.
    pub fn deletable_temp_contact_ids(output: &str) -> Vec<i64> {
        output.lines().filter_map(|linha| {
            let id = Self::parse_query_ids(linha, "_id").into_iter().next()?;
            let nome = linha.split("display_name=").nth(1)?.trim();
            let digitos = nome.strip_prefix("Esfera ")?;
            ((10..=13).contains(&digitos.len()) && digitos.chars().all(|c| c.is_ascii_digit())).then_some(id)
        }).collect()
    }

    /// Extrai os nomes de contatos temporários ("Esfera <número>") da saída do `content query`.
    pub fn parse_temporary_contact_names_from_query(output: &str) -> Vec<String> {
        let mut names = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("No result") {
                continue;
            }
            for key in ["data1=", "display_name="] {
                if let Some(pos) = trimmed.find(key) {
                    let rest = &trimmed[pos + key.len()..];
                    let val = rest.split(", ").next().unwrap_or(rest).trim();
                    if !val.is_empty() && val != "NULL" {
                        names.push(val.to_string());
                    }
                }
            }
        }
        names
    }

    /// Consulta uma única vez os nomes dos contatos já existentes na conta isolada `esfera_temp` do aparelho.
    pub fn list_temporary_contact_names(serial: &str) -> Result<Vec<String>, String> {
        let query_data = format!(
            "content query --uri content://com.android.contacts/data --projection data1 --where \"account_name='{}' AND mimetype='vnd.android.cursor.item/name'\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME
        );
        if let Ok(out) = Self::execute_shell(serial, &query_data, 8) {
            let names = Self::parse_temporary_contact_names_from_query(&out);
            if !names.is_empty() || out.contains("No result found") || out.contains("Row:") {
                return Ok(names);
            }
        }
        let query_raw = format!(
            "content query --uri content://com.android.contacts/raw_contacts --projection display_name --where \"account_name='{}' AND (deleted IS NULL OR deleted=0)\"",
            Self::ESFERA_TEMP_CONTACT_ACCOUNT_NAME
        );
        let out = Self::execute_shell(serial, &query_raw, 8)?;
        Ok(Self::parse_temporary_contact_names_from_query(&out))
    }

    /// Alias histórico: digitação tecla a tecla (modelo psicomotor). Antes injetava palavras
    /// inteiras com `input text`, o que parecia colagem; agora delega à digitação humana.
    #[allow(dead_code)]
    pub fn type_text_fluid_hci(serial: &str, text: &str) -> Result<(), String> {
        Self::type_text_human_hpc(serial, text)
    }

    /// Alias para compatibilidade com type_text_fluid_hci
    #[allow(dead_code)]
    pub fn type_message_native_fast(serial: &str, text: &str) -> Result<(), String> {
        Self::type_text_human_hpc(serial, text)
    }

    /// Envia mensagem no WhatsApp via NAVEGAÇÃO 100% NATIVA interna in-app (sem sair do app).
    /// Mantém a sessão do WhatsApp aberta e desbloqueada sem jamais disparar intents externos
    /// que acionariam a tela de senha/biometria (AppAuthenticationActivity).
    /// Se já estiver na conversa do contato, apenas digita/cola e envia.
    /// Se estiver na lista de conversas, clica na busca, digita o número, seleciona o contato,
    /// digita e clica em enviar via toque Bézier.
    /// Toque curto e firme (sem arrasto), com leve variação de posição e de tempo de pressão.
    /// O toque "em curva" é lido como rolagem em listas (a conversa não abria pela busca).
    fn soft_tap(serial: &str, x: i32, y: i32) -> Result<(), String> {
        let jx = Self::calculate_gaussian_delay(0, 4) - 2;
        let jy = Self::calculate_gaussian_delay(0, 4) - 2;
        let dwell = Self::calculate_gaussian_delay(60, 110) as f64 / 1000.0;
        let (tx, ty) = (x + jx, y + jy);
        let seq = format!(
            "input motionevent DOWN {} {} && sleep {:.3} && input motionevent UP {} {}",
            tx, ty, dwell, tx, ty
        );
        if Self::execute_shell(serial, &seq, 6).is_ok() {
            return Ok(());
        }
        Self::execute_shell(serial, &format!("input tap {} {}", tx, ty), 6).map(|_| ())
    }

    pub fn send_whatsapp_native_navigation(
        serial: &str,
        phone: &str,
        message: &str,
        _contact_name: Option<&str>,
        package: Option<&str>,
    ) -> Result<(), String> {
        let parts = Self::split_human_parts(message);
        Self::send_whatsapp_parts(serial, phone, &parts, package, &|| true)
    }

    /// Divide o texto em mensagens separadas (blocos separados por linha em branco), como uma
    /// pessoa mandaria no WhatsApp: saudação / assunto / despedida. Quebras simples viram espaço.
    pub fn split_human_parts(message: &str) -> Vec<String> {
        let parts: Vec<String> = message
            .replace("\r\n", "\n")
            .split("\n\n")
            .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|p| !p.is_empty())
            .collect();
        match parts.len() {
            0 => vec![message.trim().to_string()],
            // Veio num bloco só (a IA nem sempre separa): divide aqui, sem depender dela.
            1 => Self::split_single_block(&parts[0]),
            _ => parts,
        }
    }

    /// Divide um bloco único em saudação / assunto / despedida, como uma pessoa digitaria.
    fn split_single_block(text: &str) -> Vec<String> {
        // Frases: termina em . ? ! — tokens só de emoji/símbolo logo depois ficam na mesma frase.
        let mut sentences: Vec<String> = Vec::new();
        let mut cur: Vec<&str> = Vec::new();
        for w in text.split_whitespace() {
            let symbol_only = !w.chars().any(|c| c.is_alphanumeric());
            let prev_closed = cur
                .last()
                .map(|p| p.ends_with('.') || p.ends_with('?') || p.ends_with('!') || !p.chars().any(|c| c.is_alphanumeric()))
                .unwrap_or(false);
            if prev_closed && !symbol_only && !cur.is_empty() {
                sentences.push(cur.join(" "));
                cur.clear();
            }
            cur.push(w);
        }
        if !cur.is_empty() {
            sentences.push(cur.join(" "));
        }
        if sentences.len() < 3 {
            return vec![text.to_string()];
        }

        let mut parts: Vec<String> = Vec::new();
        // Saudação: primeira frase curta ("Olá Teste, tudo bem? 😊")
        let first_is_greeting = sentences[0].chars().count() <= 70;
        let start = if first_is_greeting {
            parts.push(sentences[0].clone());
            1
        } else {
            0
        };
        // Despedida: últimas frases que começam com palavras de encerramento
        const SIGN_OFF: [&str; 9] = ["abraço", "abs", "atenciosamente", "att", "equipe", "obrigad", "até ", "cordialmente", "um abraço"];
        let mut end = sentences.len();
        while end > start + 1 {
            let l = sentences[end - 1].to_lowercase();
            if SIGN_OFF.iter().any(|s| l.starts_with(s)) && sentences[end - 1].chars().count() <= 80 {
                end -= 1;
            } else {
                break;
            }
        }
        let middle = &sentences[start..end];
        let middle_text = middle.join(" ");
        if middle_text.chars().count() > 280 && middle.len() >= 2 {
            let half = middle.len() / 2;
            parts.push(middle[..half].join(" "));
            parts.push(middle[half..].join(" "));
        } else if !middle_text.is_empty() {
            parts.push(middle_text);
        }
        if end < sentences.len() {
            parts.push(sentences[end..].join(" "));
        }
        parts
    }

    /// Abre a conversa uma única vez e envia cada parte como mensagem própria, com pausa humana
    /// entre elas. Cada parte é conferida na tela (texto no campo e campo vazio após Enviar).
    pub fn send_whatsapp_parts(
        serial: &str,
        phone: &str,
        parts: &[String],
        package: Option<&str>,
        should_continue: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        // Pacote explícito só pode ser um dos WhatsApp; sem pacote, segue o que estiver aberto.
        if let Some(p) = package {
            if !Self::WHATSAPP_PACKAGES.contains(&p) {
                return Err("Envio permitido somente no WhatsApp (com.whatsapp ou com.whatsapp.w4b)".into());
            }
        }
        let digits = Self::normalize_target_phone(phone);
        if digits.len() < 8 {
            return Err("Número de telefone não contém dígitos válidos".to_string());
        }
        if parts.is_empty() {
            return Err("Mensagem vazia".to_string());
        }
        let tail = digits[digits.len() - 8..].to_string();
        let pkg = package.unwrap_or_else(|| Self::active_whatsapp(serial));

        let (screen_w, screen_h) = {
            let (w, h) = Self::get_device_screen_size(serial);
            if w > 0 && h > 0 { (w, h) } else { (720, 1600) }
        };

        // 1. Coloca o WhatsApp alvo em primeiro plano, na lista de conversas. Volta até confirmar a
        //    lista (o 1º "voltar" às vezes só fecha o teclado); nunca sai do WhatsApp.
        for _ in 0..4 {
            let focus_raw = Self::wa_focus(serial);
            let in_app = Self::focus_in(&focus_raw, pkg);
            if in_app && Self::shows_restricted_account(&Self::ui_dump(serial)) {
                return Err("CONTA_RESTRITA: WhatsApp indica conta restrita ou banida".to_string());
            }
            if in_app && focus_raw.contains("HomeActivity") {
                break;
            }
            if !in_app {
                let bring_fg = format!("monkey -p {} -c android.intent.category.LAUNCHER 1", pkg);
                let _ = Self::execute_shell(serial, &bring_fg, 3);
                let d = Self::calculate_gaussian_delay(500, 800);
                std::thread::sleep(Duration::from_millis(d as u64));
            } else {
                let _ = Self::send_keyevent(serial, 4);
                let d = Self::calculate_gaussian_delay(350, 500);
                std::thread::sleep(Duration::from_millis(d as u64));
            }
        }

        // 2. Abre a conversa pela busca: acha o contato salvo pela campanha (conta esfera_temp,
        //    nome "Esfera <número>") e só toca na linha que mostra o próprio número.
        //    Em internet lenta, o link api.whatsapp.com/send depende de consulta online ao servidor
        //    do WhatsApp; por isso, se a 1ª busca não achar, garante o contato temporário local na
        //    agenda e tenta novamente pela busca local antes de recorrer ao link.
        let mut opened_via_search = Self::wa_open_chat_via_search(serial, pkg, &digits, &tail, screen_w, screen_h)?;
        if !opened_via_search {
            // Falha ao preparar o contato nunca derruba o envio: segue para o link, como antes.
            match Self::insert_temporary_contact(serial, &format!("Esfera {}", digits), &digits) {
                Ok(_) => {
                    std::thread::sleep(Duration::from_millis(700));
                    opened_via_search = Self::wa_open_chat_via_search(serial, pkg, &digits, &tail, screen_w, screen_h)?;
                }
                Err(e) => eprintln!("[CONTATOS TEMP] Contato de {} não ficou pronto em {} ({}); abrindo pelo link.", digits, serial, e),
            }
        }
        if !opened_via_search {
            // Abre a conversa vazia: o texto é sempre digitado, nunca pré-preenchido pelo link.
            Self::wa_open_link(serial, pkg, &digits)?;
        }

        // 3. Envia cada parte como uma mensagem. Antes de cada parte confere de novo se pode seguir
        //    (descadastro, campanha parada). Erro depois da 1ª parte vira "PARCIAL:" para o dispatcher
        //    não reenviar tudo (duplicaria as mensagens já entregues).
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                // Pausa de quem lê o que mandou e começa a próxima mensagem
                let d = Self::calculate_gaussian_delay(1800, 4200);
                std::thread::sleep(Duration::from_millis(d as u64));
            }
            if !should_continue() {
                return Err(if i == 0 {
                    "CANCELADO: descadastro ou campanha parada antes do envio".to_string()
                } else {
                    format!("PARCIAL: {}/{} partes enviadas; interrompido (descadastro ou campanha parada)", i, parts.len())
                });
            }
            if let Err(e) = Self::wa_fill_and_send(serial, pkg, &digits, phone, part, screen_w, screen_h, should_continue) {
                let _ = Self::send_keyevent(serial, 111);
                return Err(if i > 0 && !e.starts_with("INCERTO:") {
                    format!("PARCIAL: {}/{} partes enviadas; parte {} falhou: {}", i, parts.len(), i + 1, e)
                } else if i > 0 {
                    format!("PARCIAL: {}/{} partes enviadas; {}", i, parts.len(), e)
                } else {
                    e
                });
            }
        }
        // Fecha o teclado como uma pessoa faria (ESC esconde o teclado sem sair da conversa).
        let _ = Self::send_keyevent(serial, 111);
        Ok(())
    }

    /// Abre somente o número no pacote autorizado; o texto sempre é digitado.
    fn wa_open_link(serial: &str, pkg: &str, digits: &str) -> Result<(), String> {
        if !Self::WHATSAPP_PACKAGES.contains(&pkg) { return Err("Use somente o WhatsApp (normal ou Business) para o envio".into()); }
        let url = format!("https://api.whatsapp.com/send?phone={}", digits);
        let cmd = format!(
            "am start -a android.intent.action.VIEW -p {} -d '{}'",
            pkg,
            Self::shell_quote(&url)
        );
        Self::execute_shell(serial, &cmd, 8).map_err(|e| format!("Falha ao abrir conversa por link: {}", e))?;
        let d = Self::calculate_gaussian_delay(2200, 3200);
        std::thread::sleep(Duration::from_millis(d as u64));
        Ok(())
    }

    /// Lê o campo de mensagem da conversa aberta. Em internet lenta, se o WhatsApp ainda estiver
    /// exibindo diálogo de carregamento ("Buscando..." / "Iniciando conversa..." / "Conectando..."),
    /// estende a espera para não cancelar a abertura da conversa prematuramente.
    fn wa_entry(serial: &str, pkg: &str) -> Option<UiNode> {
        let started = Instant::now();
        let mut deadline = started + Duration::from_secs(8);
        // Teto absoluto: carregamento lento estende a espera, mas nunca sem fim.
        let cap = started + Duration::from_secs(30);
        let mut reads = 0;
        loop {
            // Cada leitura tem fôlego próprio: com o agente fora (uiautomator ~5 s) ainda cabem
            // várias leituras completas, em vez de uma só e um "a conversa não abriu" falso.
            let xml = Self::ui_dump_until(serial, Self::read_deadline(deadline, cap));
            reads += 1;
            if Self::shows_no_whatsapp(&xml) || Self::shows_restricted_account(&xml) { return None; }
            if let Some(n) = Self::ui_nodes(&xml).into_iter()
                .find(|n| Self::whatsapp_node(n) && n.rid == format!("{}:id/entry", pkg)) { return Some(n); }
            if Self::shows_loading_or_connecting(&xml) { deadline = deadline.max(started + Duration::from_secs(20)); }
            let now = Instant::now();
            if now >= cap || (now >= deadline && reads >= 3) { return None; }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// Conteúdo de conversa ou texto digitado: bolhas, prévias e resultados (tudo dentro de lista)
    /// e os campos de mensagem e de busca. Nunca serve para classificar a tela.
    fn conversation_content(n: &UiNode) -> bool {
        let id = n.rid.rsplit('/').next().unwrap_or("");
        Self::is_list(n)
            || ["entry", "search_input", "search_src_text", "message_text", "caption", "quoted_text",
                "single_msg_tv", "conversations_row_message"].contains(&id)
    }

    /// Texto de aviso/status do WhatsApp por EXCLUSÃO: todo texto de nó do pacote autorizado
    /// (diálogos, faixas, telas de bloqueio, barra de título), menos o conteúdo de conversa e os
    /// campos digitados. Não depende de ids de diálogo, que mudam entre versões do WhatsApp.
    fn whatsapp_status_text(xml: &str) -> String {
        let nodes = Self::ui_nodes(xml);
        let excluded = |index: usize| {
            let mut cursor = Some(index);
            while let Some(i) = cursor {
                if Self::conversation_content(&nodes[i]) { return true; }
                cursor = nodes[i].parent;
            }
            false
        };
        let text = nodes.iter().enumerate()
            .filter(|(i, n)| Self::whatsapp_node(n) && !excluded(*i))
            .flat_map(|(_, n)| [n.text.as_str(), n.description.as_str()])
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>().join(" ");
        Self::strip_format_chars(&Self::decode_xml_numeric(&text)).to_lowercase().replace('’', "'")
            .split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// Detecta se o WhatsApp está aguardando resposta da rede ("Buscando...", "Iniciando conversa...", "Conectando...").
    fn shows_loading_or_connecting(xml: &str) -> bool {
        let lower = Self::whatsapp_status_text(xml);
        [
            "buscando",
            "iniciando conversa",
            "verificando",
            "conectando",
            "aguarde",
            "carregando",
            "searching",
            "starting chat",
            "connecting",
            "loading",
            "please wait",
            "cargando",
            "conectando",
            "iniciando chat",
            "por favor espera",
        ]
        .iter()
        .any(|p| lower.contains(p))
    }

    /// Detecta aviso de bloqueio por rede lenta/indisponível do WhatsApp ao abrir link.
    fn shows_network_error(xml: &str) -> bool {
        let lower = Self::whatsapp_status_text(xml);
        [
            "não foi possível conectar",
            "nao foi possivel conectar",
            "verifique sua conexão",
            "verifique sua conexao",
            "sem conexão com a internet",
            "sem conexao com a internet",
            "couldn't connect",
            "could not connect",
            "check your internet connection",
            "no internet connection",
            "no se pudo conectar",
            "sin conexión a internet",
            "comprueba tu conexión",
        ]
        .iter()
        .any(|p| lower.contains(p))
    }

    /// Tela com o aviso do WhatsApp de que o número não tem conta (pt, en, es).
    fn shows_restricted_account(xml: &str) -> bool {
        let text = Self::whatsapp_status_text(xml);
        ["esta conta não pode mais usar o whatsapp", "esta conta não pode usar o whatsapp",
         "sua conta está impedida de usar o whatsapp", "conta temporariamente banida",
         "this account can no longer use whatsapp", "this account is not allowed to use whatsapp",
         "your account is banned", "temporarily banned from whatsapp",
         "esta cuenta no puede usar whatsapp", "esta cuenta ya no puede usar whatsapp", "cuenta suspendida temporalmente"]
            .iter().any(|s| text.contains(s))
    }

    fn shows_no_whatsapp(xml: &str) -> bool {
        let lower = Self::whatsapp_status_text(xml);
        [
            "não está no whatsapp",
            "nao esta no whatsapp",
            "não tem whatsapp",
            "isn't on whatsapp",
            "is not on whatsapp",
            "no está en whatsapp",
            "no esta en whatsapp",
        ]
        .iter()
        .any(|p| lower.contains(p))
    }

    /// Coloca `text` no campo da conversa aberta e envia, conferindo antes e depois.
    fn wa_fill_and_send(
        serial: &str,
        pkg: &str,
        digits: &str,
        phone: &str,
        text: &str,
        screen_w: i32,
        screen_h: i32,
        should_continue: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        let entry = match Self::wa_entry(serial, pkg) {
            Some(e) => e,
            None => {
                let dump = Self::ui_dump(serial);
                // Avisos com prova positiva vêm antes de qualquer contorno: conta restrita pausa a
                // campanha e marca o chip; número sem WhatsApp vai para a lista "não disparar".
                if Self::shows_restricted_account(&dump) {
                    return Err("CONTA_RESTRITA: WhatsApp indica conta restrita ou banida".to_string());
                }
                if Self::shows_no_whatsapp(&dump) {
                    let _ = Self::send_keyevent(serial, 4); // fecha o aviso sem sair do WhatsApp
                    return Err(format!("SEM_WHATSAPP: o número {} não está no WhatsApp", phone));
                }
                // Se o WhatsApp bloqueou o link por detecção de rede lenta ("Não foi possível conectar"),
                // fecha o alerta e abre a conversa via contato local na agenda (que não exige validação online).
                if Self::shows_network_error(&dump) && digits.len() >= 8 {
                    let _ = Self::send_keyevent(serial, 4);
                    std::thread::sleep(Duration::from_millis(400));
                    let tail = &digits[digits.len() - 8..];
                    // Sem o contato a busca ainda pode achar o da preparação; a falha não é fatal.
                    if let Err(e) = Self::insert_temporary_contact(serial, &format!("Esfera {}", digits), digits) {
                        eprintln!("[CONTATOS TEMP] Contato de {} não ficou pronto em {} ({}); tentando a busca mesmo assim.", digits, serial, e);
                    }
                    std::thread::sleep(Duration::from_millis(700));
                    if Self::wa_open_chat_via_search(serial, pkg, digits, tail, screen_w, screen_h).unwrap_or(false) {
                        if let Some(e2) = Self::wa_entry(serial, pkg) {
                            e2
                        } else {
                            return Err(format!("A conversa com {} não abriu após contornar alerta de rede lenta", phone));
                        }
                    } else {
                        return Err(format!("A conversa com {} não abriu (alerta de rede lenta no WhatsApp)", phone));
                    }
                } else {
                    let focus = Self::wa_focus(serial);
                    let _ = Self::send_keyevent(serial, 4); // fecha diálogo/aviso sem sair do WhatsApp
                    if focus.contains("AppAuthentication") {
                        return Err("WhatsApp bloqueado por senha/biometria: a conversa não abriu".to_string());
                    }
                    return Err(format!("A conversa com {} não abriu (o número pode não ter WhatsApp)", phone));
                }
            }
        };

        let initial = Self::ui_dump(serial);
        Self::verify_chat_identity(&initial, digits)?;
        if text.trim().is_empty() || text.chars().count() > 1500 {
            return Err("A mensagem deve conter entre 1 e 1500 caracteres".into());
        }
        let empty = Self::entry_empty(&entry.text);
        Self::soft_tap(serial, entry.cx, entry.cy)?;
        Self::type_text_human_hpc_opts(serial, text, true, empty)?;

        // A mesma árvore confere destinatário, conteúdo e botão imediatamente antes do envio.
        // Se a leitura veio sem o campo ou sem o botão (tela em transição), relê uma vez.
        let ready = |xml: &str| {
            let nodes = Self::ui_nodes(xml);
            nodes.iter().any(|n| Self::whatsapp_node(n) && Self::wa_rid(n, "entry"))
                && nodes.iter().any(|n| Self::whatsapp_node(n) && Self::wa_rid(n, "send") && n.enabled && n.cx > 0 && n.cy > 0)
        };
        let mut before = Self::ui_dump(serial);
        if !ready(&before) {
            std::thread::sleep(Duration::from_millis(400));
            let again = Self::ui_dump_uiautomator(serial);
            if ready(&again) { before = again; }
        }
        Self::verify_chat_identity(&before, digits)?;
        let nodes = Self::ui_nodes(&before);
        let draft = nodes.iter().find(|n| Self::whatsapp_node(n) && Self::wa_rid(n, "entry"))
            .ok_or("O campo da mensagem não está disponível; envio cancelado")?;
        let confirmation = text == crate::dispatcher::OPT_OUT_CONFIRMATION_TEXT;
        if (confirmation && Self::decode_xml_numeric(&draft.text) != text)
            || (!confirmation && !Self::same_text(&draft.text, text)) {
            return Err("O texto no campo não confere com a mensagem; envio cancelado".into());
        }
        let button = nodes.iter().find(|n| Self::whatsapp_node(n) && Self::wa_rid(n, "send")
            && n.enabled && n.cx > 0 && n.cy > 0)
            .ok_or("O botão Enviar não está disponível; envio cancelado")?;
        if !should_continue() { return Err("CANCELADO: descadastro ou campanha interrompida antes de enviar".into()); }
        // O segundo toque de proteção do soft_tap é preservado por decisão explícita do dono.
        Self::soft_tap(serial, button.cx, button.cy)
            .map_err(|_| "INCERTO: não foi possível confirmar o toque em Enviar; confira a conversa antes de tentar novamente".to_string())?;
        Self::confirm_sent(serial, &before, digits, text)
    }

    /// Depois do toque em Enviar, separa os casos pela tela:
    /// - bolha nova com tique: enviada;
    /// - texto ainda no campo e nenhuma bolha nova: nada saiu, falha comum (o contato volta à fila);
    /// - relógio na bolha nova: pendente de rede, reconfere até o prazo; continua no WhatsApp, que
    ///   entrega sozinho quando a rede voltar, então conta como enviada (reenviar duplicaria);
    /// - campo vazio sem bolha conferida (ids/estrutura desconhecidos): enviada, como antes;
    /// - INCERTO só com indício de problema: bolha marcada como não enviada, outra conversa na tela,
    ///   campo com outro texto ou tela ilegível até o fim do prazo. INCERTO nunca é reenviado.
    fn confirm_sent(serial: &str, before: &str, digits: &str, text: &str) -> Result<(), String> {
        let tapped = Instant::now();
        let deadline = tapped + Duration::from_secs(20);
        let cap = tapped + Duration::from_secs(32);
        let mut reads = 0;
        let mut state = SendCheck::Unreadable;
        let mut since = tapped;
        loop {
            let after = Self::ui_dump_until(serial, Self::read_deadline(deadline, cap));
            reads += 1;
            let seen = Self::send_check(before, &after, digits, text);
            // Uma leitura ruim no meio não apaga o que já foi visto (campo vazio, relógio...).
            let ignore = seen == SendCheck::Unreadable && state != SendCheck::Unreadable;
            if !ignore && seen != state { state = seen; since = Instant::now(); }
            if matches!(state, SendCheck::Confirmed | SendCheck::Failed | SendCheck::WrongChat) { break; }
            let now = Instant::now();
            // Campo cheio, campo vazio sem bolha e campo com outro texto não mudam sozinhos: 5 s
            // estáveis bastam. Relógio e tela ilegível esperam o prazo inteiro.
            let steady = reads >= 2 && now.duration_since(since) >= Duration::from_secs(5);
            if steady && matches!(state, SendCheck::StillInField | SendCheck::Emptied | SendCheck::OtherText) { break; }
            if now >= cap || (now >= deadline && reads >= 2) { break; }
            std::thread::sleep(Duration::from_millis(400));
        }
        match state {
            SendCheck::Pending => println!("[ENVIO] Mensagem registrada no WhatsApp de {} e ainda aguardando a rede (relógio); o WhatsApp entrega sozinho.", serial),
            SendCheck::Emptied => println!("[ENVIO] Campo esvaziou após Enviar em {}; bolha não conferida na tela, contada como enviada.", serial),
            _ => {}
        }
        Self::send_outcome(state)
    }

    /// Resultado do envio pelo último estado visto (ver `confirm_sent`).
    fn send_outcome(state: SendCheck) -> Result<(), String> {
        match state {
            SendCheck::Confirmed | SendCheck::Pending | SendCheck::Emptied => Ok(()),
            SendCheck::StillInField => Err("O botão Enviar não respondeu: a mensagem continua no campo".into()),
            SendCheck::Failed => Err("INCERTO: o WhatsApp marcou a mensagem como não enviada; confira a conversa no aparelho antes de tentar novamente".into()),
            SendCheck::WrongChat => Err("INCERTO: outra conversa apareceu na tela depois do toque em Enviar; confira no aparelho antes de tentar novamente".into()),
            SendCheck::OtherText => Err("INCERTO: o campo de mensagem mudou depois do toque em Enviar; confira no aparelho antes de tentar novamente".into()),
            SendCheck::Unreadable => Err("INCERTO: não foi possível confirmar o envio na tela; confira no aparelho antes de tentar novamente".into()),
        }
    }

    /// Abre a conversa pela busca interna do WhatsApp. Só toca num resultado cuja linha
    /// mostre o próprio número (nunca abre conversa de outra pessoa). Retorna false se não achou.
    /// Linha do resultado da busca que é o próprio número: o número puro (sem contato salvo) ou o
    /// contato temporário "Esfera <número>". Confere DDD + 8 dígitos (sem DDI e sem o 9º), não só o
    /// final: "(11) 8805-2539" e "(75) 8805-2539" são pessoas diferentes. Vale para a seção
    /// "Conversas" e para "Pessoas" (contato sem conversa ainda, caso de todo primeiro disparo).
    fn search_hit<'a>(results: &'a [UiNode], digits: &str, tail: &str) -> Option<&'a UiNode> {
        let want = crate::db::Database::opt_out_key(digits);
        results.iter().find(|n| {
            if !n.rid.contains("contact_name") {
                return false;
            }
            // Um nome qualquer que só contenha os dígitos não serve: só o número puro ou
            // "Esfera <número>", sem as marcas invisíveis que o WhatsApp põe em volta do número.
            Self::header_number(&n.text).map_or(false, |row| {
                row.len() >= 10 && row.ends_with(tail) && crate::db::Database::opt_out_key(&row) == want
            })
        })
    }

    /// Fecha teclado e busca, voltando à lista de conversas.
    fn wa_close_search(serial: &str, pkg: &str) {
        let search_id = format!("{}:id/search_input", pkg);
        for _ in 0..2 {
            if !Self::ui_dump(serial).contains(&search_id) {
                break;
            }
            let _ = Self::send_keyevent(serial, 4);
            std::thread::sleep(Duration::from_millis(350));
        }
    }

    /// Abre a conversa pela busca interna do WhatsApp. Só toca num resultado cuja linha
    /// mostre o próprio número (nunca abre conversa de outra pessoa). Retorna false se não achou.
    fn wa_open_chat_via_search(
        serial: &str,
        pkg: &str,
        digits: &str,
        tail: &str,
        screen_w: i32,
        screen_h: i32,
    ) -> Result<bool, String> {
        let _ = (screen_w, screen_h);
        let search_id = format!("{}:id/search_input", pkg);
        let is_bar = |n: &UiNode| n.rid == format!("{}:id/search_text", pkg) || n.rid == format!("{}:id/my_search_bar", pkg);
        let mut nodes = Self::ui_nodes(&Self::ui_dump(serial));
        if !nodes.iter().any(|n| is_bar(n) || n.rid == search_id) {
            nodes = Self::ui_nodes(&Self::ui_dump_uiautomator(serial));
        }
        // A busca pode já estar aberta: ao voltar da conversa anterior, o WhatsApp mostra os
        // resultados da última busca (com o número antigo no campo). Reaproveita o campo em vez
        // de desistir e abrir pelo link.
        let field_empty = match nodes.iter().find(|n| n.rid == search_id) {
            Some(field) => {
                // Toca no campo para garantir o foco (o teclado pode ter sido fechado).
                Self::soft_tap(serial, field.cx, field.cy)?;
                let d = Self::calculate_gaussian_delay(250, 400);
                std::thread::sleep(Duration::from_millis(d as u64));
                field.text.trim_matches(|c: char| c == '\u{200b}' || c.is_whitespace()).is_empty()
            }
            None => {
                // Sem a barra de busca na tela (não está na lista de conversas): não toca nem digita às cegas.
                let (bx, by) = match nodes.iter().find(|n| is_bar(n)) {
                    Some(b) => (b.cx, b.cy),
                    None => return Ok(false),
                };
                Self::soft_tap(serial, bx, by)?;
                let d = Self::calculate_gaussian_delay(400, 600);
                std::thread::sleep(Duration::from_millis(d as u64));
                // Só digita se o campo de busca abriu de fato.
                if !Self::ui_dump(serial).contains(&search_id) && !Self::ui_dump_uiautomator(serial).contains(&search_id) {
                    let _ = Self::send_keyevent(serial, 4);
                    return Ok(false);
                }
                true
            }
        };
        // O agente esvazia o campo antes (número anterior ou a dica "Pesquisar") e digita tecla a tecla.
        if let Err(e) = Self::type_text_human_hpc_opts(serial, digits, true, field_empty) {
            eprintln!("[BUSCA] Não foi possível digitar o número na busca ({}); abrindo pelo link.", e);
            Self::wa_close_search(serial, pkg);
            return Ok(false);
        }
        // Espera os resultados: o WhatsApp pode levar alguns segundos para listar o contato.
        let d = Self::calculate_gaussian_delay(900, 1200);
        std::thread::sleep(Duration::from_millis(d as u64));
        let deadline = Instant::now() + Duration::from_secs(8);
        let cap = deadline + Duration::from_secs(10);
        let mut reads = 0;
        let hit = loop {
            let results = Self::ui_nodes(&Self::ui_dump_until(serial, Self::read_deadline(deadline, cap)));
            reads += 1;
            if let Some(n) = Self::search_hit(&results, digits, tail) {
                break Some((n.cx, n.cy));
            }
            let now = Instant::now();
            if now >= cap || (now >= deadline && reads >= 2) {
                break None;
            }
            std::thread::sleep(Duration::from_millis(600));
        };
        match hit {
            Some((x, y)) => {
                Self::soft_tap(serial, x, y)?;
                let d = Self::calculate_gaussian_delay(1100, 1600);
                std::thread::sleep(Duration::from_millis(d as u64));
                Ok(true)
            }
            None => {
                println!("[BUSCA] {} não apareceu na busca do WhatsApp em 8 s; abrindo pelo link.", digits);
                Self::wa_close_search(serial, pkg);
                Ok(false)
            }
        }
    }

    fn wa_focus(serial: &str) -> String {
        Self::execute_shell(serial, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", 3).unwrap_or_default()
    }

    /// O app está em primeiro plano. Compara "pacote/" porque "com.whatsapp" é prefixo de
    /// "com.whatsapp.w4b" (as atividades do Business também se chamam com.whatsapp.*).
    fn focus_in(focus: &str, pkg: &str) -> bool {
        focus.contains(&format!("{}/", pkg))
    }

    /// Qual WhatsApp (normal ou Business) está em primeiro plano, se algum.
    fn whatsapp_in_focus(focus: &str) -> Option<&'static str> {
        [Self::BUSINESS_WHATSAPP_PACKAGE, Self::DEFAULT_WHATSAPP_PACKAGE].into_iter().find(|p| Self::focus_in(focus, p))
    }

    /// WhatsApp do disparo neste aparelho: o que está aberto agora; sem nenhum na tela, o último
    /// visto aberto nele; sem histórico, o normal. Na primeira vez que o Business aparece, garante
    /// que ele leia a agenda (os contatos temporários "Esfera <número>" são achados pela busca).
    pub fn active_whatsapp(serial: &str) -> &'static str {
        static LAST: std::sync::LazyLock<std::sync::Mutex<HashMap<String, &'static str>>> =
            std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
        let seen = Self::whatsapp_in_focus(&Self::wa_focus(serial));
        let Some(pkg) = seen else {
            return LAST.lock().unwrap_or_else(|e| e.into_inner()).get(serial).copied().unwrap_or(Self::DEFAULT_WHATSAPP_PACKAGE);
        };
        let changed = LAST.lock().unwrap_or_else(|e| e.into_inner()).insert(serial.to_string(), pkg) != Some(pkg);
        if changed {
            println!("[ENVIO] {} usa o {} (aberto na tela)", serial, pkg);
            Self::grant_whatsapp_contact_permissions(serial, pkg);
        }
        pkg
    }

    /// Lê a árvore de UI da tela atual. Caminho rápido: serviço de acessibilidade do agente
    /// (mesmo XML do uiautomator, em fração de segundo). Reserva: `uiautomator dump`, que leva
    /// ~5 s em aparelhos fracos. Se o agente falhar, fica 60 s sem tentá-lo naquele aparelho.
    fn ui_dump(serial: &str) -> String {
        // Mesmo fôlego de antes: o agente tem o prazo dele e o uiautomator, o seu.
        Self::ui_dump_until(serial, Instant::now() + Self::AGENT_DUMP_BUDGET + Duration::from_secs(12))
    }

    /// Prazo da leitura pelo agente: suficiente para aparelho lento responder (o prazo de quem
    /// chamou nunca encurta abaixo disso a ponto de declarar o agente fora sem culpa dele).
    const AGENT_DUMP_BUDGET: Duration = Duration::from_secs(6);
    /// Prazo mínimo de cada leitura nos laços de espera (cabe uma leitura completa do uiautomator).
    const UI_READ_FLOOR: Duration = Duration::from_secs(7);

    /// Prazo de uma leitura dentro de um laço: nunca menor que `UI_READ_FLOOR`, nem além de `cap`.
    fn read_deadline(deadline: Instant, cap: Instant) -> Instant {
        deadline.max(Instant::now() + Self::UI_READ_FLOOR).min(cap)
    }

    /// Interpreta a resposta do `DUMP_UI`: `Ok(xml)`, `Err(true)` = o agente respondeu e não serve
    /// (inativo, sem receptor, dados quebrados), `Err(false)` = passageiro (sem janela ativa ou
    /// tela sem nenhum nó visível, como numa transição).
    fn agent_dump_reply(out: &str) -> Result<String, bool> {
        use base64::Engine as _;
        let Some(line) = out.lines().find(|l| l.contains("Broadcast completed: result=")) else { return Err(true); };
        let code = line.split("result=").nth(1).and_then(|r| r.split(|c: char| !c.is_ascii_digit() && c != '-').next())
            .and_then(|c| c.parse::<i32>().ok());
        if code == Some(3) { return Err(false); }
        if code != Some(1) { return Err(true); }
        let xml = line.split("data=\"").nth(1).and_then(|rest| rest.split('"').next())
            .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok());
        match xml {
            None => Err(true),
            Some(xml) if Self::ui_nodes(&xml).is_empty() => Err(!xml.contains("<hierarchy")),
            Some(xml) => Ok(xml),
        }
    }

    /// `Ok(xml)` ou `Err(marcar o agente como fora por 60 s)`. Só por culpa do agente: resposta
    /// inválida, ou silêncio com o prazo cheio. Prazo curto de quem chamou (sobravam décimos de
    /// segundo) não marca nada, senão o resto da operação ficaria preso ao uiautomator lento.
    fn agent_dump_outcome(result: Result<&str, &str>, budget: Duration) -> Result<String, bool> {
        match result.map(Self::agent_dump_reply) {
            Ok(Ok(xml)) => Ok(xml),
            Ok(Err(invalid)) => Err(invalid),
            Err(_) => Err(budget >= Self::AGENT_DUMP_BUDGET),
        }
    }

    fn ui_dump_until(serial: &str, deadline: Instant) -> String {
        let skip = UI_DUMP_AGENT_DOWN.lock().ok().and_then(|m| m.get(serial).copied())
            .map(|t| t.elapsed() < Duration::from_secs(60)).unwrap_or(false);
        if !skip {
            let budget = deadline.saturating_duration_since(Instant::now()).min(Self::AGENT_DUMP_BUDGET);
            if !budget.is_zero() {
                let result = Self::execute_shell_for(serial,
                    "am broadcast -a com.esfera.agent.DUMP_UI -n com.esfera.agent/.TypeTextReceiver", budget);
                let agent_down = match Self::agent_dump_outcome(result.as_deref().map_err(String::as_str), budget) {
                    Ok(xml) => return xml,
                    Err(down) => down,
                };
                if agent_down {
                    if let Ok(mut cache) = UI_DUMP_AGENT_DOWN.lock() { cache.insert(serial.to_string(), Instant::now()); }
                    println!("[TELA] Leitura pelo agente indisponível em {}; usando uiautomator por 60 s", serial);
                }
            }
        }
        Self::ui_dump_uiautomator_until(serial, deadline)
    }

    fn ui_dump_uiautomator_until(serial: &str, deadline: Instant) -> String {
        let budget = deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(12));
        if budget.is_zero() { return String::new(); }
        Self::execute_shell_for(serial,
            "rm -f /sdcard/esf_ui.xml; uiautomator dump /sdcard/esf_ui.xml >/dev/null 2>&1; cat /sdcard/esf_ui.xml 2>/dev/null", budget).unwrap_or_default()
    }

    fn ui_dump_uiautomator(serial: &str) -> String {
        Self::ui_dump_uiautomator_until(serial, Instant::now() + Duration::from_secs(12))
    }

    fn ui_nodes(xml: &str) -> Vec<UiNode> {
        fn attr(seg: &str, name: &str) -> String {
            let key = format!(" {}=\"", name);
            match seg.find(&key) {
                Some(i) => {
                    let rest = &seg[i + key.len()..];
                    let raw = &rest[..rest.find('"').unwrap_or(rest.len())];
                    raw.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&#10;", "\n").replace("&amp;", "&")
                }
                None => String::new(),
            }
        }
        let mut nodes = Vec::new();
        let mut parents = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find('<') {
            rest = &rest[start + 1..];
            let Some(end) = rest.find('>') else { return Vec::new(); };
            let seg = &rest[..end];
            rest = &rest[end + 1..];
            if seg.starts_with("/node") {
                if parents.pop().is_none() { return Vec::new(); }
            } else if seg.starts_with("node ") {
                let b = attr(seg, "bounds");
                let nums: Vec<i32> = b
                    .split(|c: char| !c.is_ascii_digit() && c != '-')
                    .filter(|s| !s.is_empty())
                    .filter_map(|s| s.parse().ok())
                    .collect();
                let bounds = if nums.len() == 4 { [nums[0], nums[1], nums[2], nums[3]] } else { [0; 4] };
                nodes.push(UiNode {
                    rid: attr(seg, "resource-id"),
                    text: attr(seg, "text"),
                    description: attr(seg, "content-desc"),
                    package: attr(seg, "package"),
                    class: attr(seg, "class"),
                    parent: parents.last().copied(),
                    enabled: attr(seg, "enabled") != "false",
                    visible: attr(seg, "visible-to-user") != "false",
                    cx: (bounds[0] + bounds[2]) / 2,
                    cy: (bounds[1] + bounds[3]) / 2,
                });
                if !seg.trim_end().ends_with('/') { parents.push(nodes.len() - 1); }
            }
        }
        if !parents.is_empty() { return Vec::new(); }
        nodes
    }

    /// Nó visível do WhatsApp normal ou do Business (só um deles está na tela por vez).
    fn whatsapp_node(n: &UiNode) -> bool {
        n.visible && Self::WHATSAPP_PACKAGES.iter().any(|p| n.package == *p
            || (n.package.is_empty() && n.rid.starts_with(&format!("{}:id/", p))))
    }

    /// O nó tem o id `<pacote>:id/<id>` de um dos WhatsApp.
    fn wa_rid(n: &UiNode, id: &str) -> bool {
        Self::WHATSAPP_PACKAGES.iter().any(|p| n.rid.strip_prefix(p).and_then(|r| r.strip_prefix(":id/")) == Some(id))
    }

    /// Tira os caracteres invisíveis de formatação (Unicode Cf: marcas de direção U+200E/U+202A/
    /// U+202C, espaço de largura zero U+200B, BOM...). O WhatsApp cerca números com essas marcas.
    fn strip_format_chars(s: &str) -> String {
        s.chars().filter(|c| !matches!(*c as u32,
            0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x180E
            | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
            | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)).collect()
    }

    /// Número que o cabeçalho da conversa prova: o número puro ou o contato temporário
    /// "Esfera <número>" (com qualquer formatação dos dígitos). Nome comum não prova número.
    fn header_number(label: &str) -> Option<String> {
        let label = Self::strip_format_chars(&Self::decode_xml_numeric(label));
        let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
        let number = label.strip_prefix("Esfera ").unwrap_or(&label);
        let digits = Self::extract_phone_digits(number);
        (digits.len() >= 8 && number.chars().all(|c| c.is_ascii_digit() || " +-().".contains(c))).then_some(digits)
    }

    /// Recusa só com PROVA de destinatário errado: grupo ou número diferente no cabeçalho. Contato
    /// salvo com nome, cabeçalho sem número ou leitura ilegível não provam nada (a busca e o link já
    /// casaram o número); nesses casos o envio segue, como antes da conferência existir.
    fn verify_chat_identity(xml: &str, phone: &str) -> Result<(), String> {
        let nodes = Self::ui_nodes(xml);
        if nodes.iter().any(|n| Self::whatsapp_node(n) &&
            (n.rid.ends_with("/group_participants") || n.rid.ends_with("/group_info") ||
             ["group info", "dados do grupo", "info. del grupo", "información del grupo"]
                .contains(&n.description.to_lowercase().as_str()))) {
            return Err("Envio cancelado: a conversa é um grupo".into());
        }
        // Mesma equivalência da busca: DDD + 8 dígitos, com ou sem DDI e nono dígito.
        let wanted = crate::db::Database::opt_out_key(phone);
        let other = nodes.iter()
            .filter(|n| Self::whatsapp_node(n) &&
                (Self::wa_rid(n, "conversation_contact_name") || Self::wa_rid(n, "conversation_name")))
            .filter_map(|n| Self::header_number(&n.text))
            .any(|digits| crate::db::Database::opt_out_key(&digits) != wanted);
        if other { return Err("Envio cancelado: o número da conversa não confere com o destinatário".into()); }
        Ok(())
    }

    /// Campo de mensagem vazio: sem texto (só espaços/marcas invisíveis) ou mostrando a dica.
    fn entry_empty(text: &str) -> bool {
        let t = Self::strip_format_chars(&Self::decode_xml_numeric(text)).trim().to_lowercase();
        t.is_empty() || ["mensagem", "message", "mensaje", "digite uma mensagem", "escreva uma mensagem",
            "type a message", "escribe un mensaje"].contains(&t.as_str())
    }

    /// Texto como a bolha mostra: sem os marcadores de formatação do WhatsApp (* _ ~ `), que viram
    /// negrito/itálico na bolha, sem caracteres invisíveis e com espaços normalizados.
    fn bubble_norm(s: &str) -> String {
        Self::strip_format_chars(&Self::decode_xml_numeric(s)).chars()
            .filter(|c| !matches!(c, '*' | '_' | '~' | '`' | '\u{FE0E}' | '\u{FE0F}'))
            .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// A bolha mostra `text`: inteiro, ou o começo dele antes de "Ler mais" (mensagem longa).
    fn bubble_matches(bubble: &str, text: &str) -> bool {
        let (shown, wanted) = (Self::bubble_norm(bubble), Self::bubble_norm(text));
        if wanted.is_empty() { return false; }
        if shown == wanted { return true; }
        let chars: Vec<char> = shown.chars().collect();
        ["ler mais", "read more", "leer más", "leer mas"].iter().any(|suffix| {
            let n = suffix.chars().count();
            if chars.len() <= n || chars[chars.len() - n..].iter().collect::<String>().to_lowercase() != *suffix { return false; }
            let head: String = chars[..chars.len() - n].iter().collect();
            let head = head.trim_end().trim_end_matches(|c| c == '…' || c == '.').trim_end();
            // Começo visível de uma mensagem longa: trecho relevante, não uma palavra solta.
            head.chars().count() >= 20 && wanted.starts_with(head)
        })
    }

    /// Lista/rolagem que reúne várias linhas (conversa, lista de conversas, resultados).
    fn is_list(n: &UiNode) -> bool {
        n.rid == "android:id/list" || n.class.contains("ListView") || n.class.contains("RecyclerView")
    }

    /// Status (relógio/tique) da MESMA bolha, sem depender do id da linha: procura em cada ancestral
    /// do texto, do mais próximo ao maior que ainda contém só esta bolha (nunca a lista inteira).
    fn bubble_status(nodes: &[UiNode], index: usize) -> BubbleStatus {
        let inside = |mut i: usize, ancestor: usize| loop {
            match nodes[i].parent { Some(p) if p == ancestor => return true, Some(p) => i = p, None => return false }
        };
        let mut cursor = nodes[index].parent;
        while let Some(a) = cursor {
            if Self::is_list(&nodes[a]) { break; }
            let bubbles = nodes.iter().enumerate().filter(|(i, n)| Self::wa_rid(n, "message_text") && inside(*i, a)).count();
            if bubbles > 1 { break; }
            if let Some((_, status)) = nodes.iter().enumerate()
                .find(|(i, n)| Self::whatsapp_node(n) && n.rid.ends_with("/status") && inside(*i, a)) {
                return Self::status_kind(&status.description);
            }
            cursor = nodes[a].parent;
        }
        BubbleStatus::Unknown
    }

    fn status_kind(description: &str) -> BubbleStatus {
        let value = Self::strip_format_chars(description).to_lowercase();
        let words: Vec<&str> = value.split(|c: char| !c.is_alphabetic()).filter(|w| !w.is_empty()).collect();
        let has = |list: &[&str]| words.iter().any(|w| list.contains(w));
        let sent = has(&["enviada", "enviado", "entregue", "entregada", "entregado", "lida", "lido", "visualizada",
            "sent", "delivered", "read", "seen", "leído", "leída", "leido", "leida", "visto", "vista"]);
        if has(&["falha", "falhou", "failed", "erro", "error", "fallido", "falló"]) || (sent && has(&["não", "nao", "not", "no"])) {
            return BubbleStatus::Failed;
        }
        if has(&["pendente", "pending", "pendiente", "aguardando", "waiting", "enviando", "sending"]) { return BubbleStatus::Pending; }
        if sent { BubbleStatus::Confirmed } else { BubbleStatus::Unknown }
    }

    /// Bolhas de texto da conversa, de cima para baixo (a última é a mais recente).
    fn message_bubbles(nodes: &[UiNode]) -> Vec<usize> {
        let mut list: Vec<usize> = nodes.iter().enumerate()
            .filter(|(_, n)| Self::whatsapp_node(n) && Self::wa_rid(n, "message_text")).map(|(i, _)| i).collect();
        list.sort_by_key(|i| nodes[*i].cy);
        list
    }

    /// Status da bolha NOVA com `text`: a mais recente da tela é a nossa e não era antes, ou há
    /// mais bolhas com o texto do que antes. `None` = nenhuma bolha nova reconhecida.
    fn new_bubble_status(before: &str, after: &str, text: &str) -> Option<BubbleStatus> {
        let (old, new) = (Self::ui_nodes(before), Self::ui_nodes(after));
        let (old_list, new_list) = (Self::message_bubbles(&old), Self::message_bubbles(&new));
        let last = *new_list.last()?;
        if !Self::bubble_matches(&new[last].text, text) { return None; }
        let count = |nodes: &[UiNode], list: &[usize]| list.iter().filter(|i| Self::bubble_matches(&nodes[**i].text, text)).count();
        let was_last = old_list.last().map_or(false, |i| Self::bubble_matches(&old[*i].text, text));
        (!was_last || count(&new, &new_list) > count(&old, &old_list)).then(|| Self::bubble_status(&new, last))
    }

    /// Classifica a tela depois do toque em Enviar (`before` = tela com o texto no campo).
    fn send_check(before: &str, after: &str, phone: &str, text: &str) -> SendCheck {
        let nodes = Self::ui_nodes(after);
        if nodes.is_empty() { return SendCheck::Unreadable; }
        if Self::verify_chat_identity(after, phone).is_err() { return SendCheck::WrongChat; }
        let Some(entry) = nodes.iter().find(|n| Self::whatsapp_node(n) && Self::wa_rid(n, "entry")) else {
            return SendCheck::Unreadable;
        };
        let bubble = Self::new_bubble_status(before, after, text);
        if bubble == Some(BubbleStatus::Failed) { return SendCheck::Failed; }
        if !Self::entry_empty(&entry.text) && Self::same_text(&entry.text, text) { return SendCheck::StillInField; }
        match bubble {
            Some(BubbleStatus::Confirmed) => SendCheck::Confirmed,
            Some(BubbleStatus::Pending) => SendCheck::Pending,
            // Bolha nova sem status legível: estrutura desconhecida, a mensagem saiu do campo.
            Some(_) => SendCheck::Emptied,
            None if Self::entry_empty(&entry.text) => SendCheck::Emptied,
            None => SendCheck::OtherText,
        }
    }

    /// Envio confirmado com prova: bolha nova com tique e o texto fora do campo.
    #[cfg(test)]
    fn sent_on_screen(before: &str, after: &str, phone: &str, text: &str) -> bool {
        Self::send_check(before, after, phone, text) == SendCheck::Confirmed
    }

    /// Compara textos ignorando diferenças de espaço/quebra de linha e caracteres invisíveis
    /// (marcas de direção, seletor de variação de emoji). A pontuação continua valendo.
    fn same_text(a: &str, b: &str) -> bool {
        let norm = |s: &str| Self::strip_format_chars(&Self::decode_xml_numeric(s)).chars()
            .filter(|c| !matches!(c, '\u{FE0E}' | '\u{FE0F}'))
            .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        let nb = norm(b);
        !nb.is_empty() && norm(a) == nb
    }

    /// Decodifica entidades numéricas do XML do uiautomator (&#NNN; e &#xHH;, inclusive pares surrogate).
    fn decode_xml_numeric(s: &str) -> String {
        let mut out = String::new();
        let mut units: Vec<u16> = Vec::new();
        let mut rest = s;
        macro_rules! flush {
            () => {
                if !units.is_empty() {
                    out.push_str(&String::from_utf16_lossy(&units));
                    units.clear();
                }
            };
        }
        loop {
            match rest.find("&#") {
                Some(0) => {
                    let after = &rest[2..];
                    if let Some(end) = after.find(';') {
                        let code = &after[..end];
                        let val = match code.strip_prefix('x').or_else(|| code.strip_prefix('X')) {
                            Some(h) => u32::from_str_radix(h, 16).ok(),
                            None => code.parse::<u32>().ok(),
                        };
                        if let Some(v) = val {
                            if v <= 0xFFFF {
                                units.push(v as u16);
                            } else {
                                flush!();
                                if let Some(c) = char::from_u32(v) {
                                    out.push(c);
                                }
                            }
                            rest = &after[end + 1..];
                            continue;
                        }
                    }
                    flush!();
                    out.push_str("&#");
                    rest = after;
                }
                Some(i) => {
                    flush!();
                    out.push_str(&rest[..i]);
                    rest = &rest[i..];
                }
                None => {
                    flush!();
                    out.push_str(rest);
                    break;
                }
            }
        }
        out
    }

    /// Envia mensagem no WhatsApp com navegação nativa fluida dentro do WhatsApp
    /// (busca interna, sem salvar contato na agenda, sem acionar deep link externo nem bloquear por senha)
    #[allow(dead_code)]
    pub fn send_whatsapp_with_contact(
        serial: &str,
        phone: &str,
        message: &str,
        contact_name: Option<&str>,
        package: Option<&str>,
    ) -> Result<(), String> {
        Self::send_whatsapp_native_navigation(serial, phone, message, contact_name, package)
    }

    /// Envia mensagem no WhatsApp via navegação nativa e toque Bézier
    #[allow(dead_code)]
    pub fn send_whatsapp_intent_and_bezier_tap(serial: &str, phone: &str, message: &str) -> Result<(), String> {
        Self::send_whatsapp_native_navigation(serial, phone, message, None, Some(Self::DEFAULT_WHATSAPP_PACKAGE))
    }

    /// Envia mensagem no WhatsApp com pacote alvo explícito (`com.whatsapp` ou `com.whatsapp.w4b`)
    #[allow(dead_code)]
    pub fn send_whatsapp_intent_and_bezier_tap_pkg(
        serial: &str,
        phone: &str,
        message: &str,
        target_pkg: Option<&str>,
    ) -> Result<(), String> {
        Self::send_whatsapp_native_navigation(serial, phone, message, None, target_pkg)
    }

    /// Método legado via Intent URL mantido para diagnósticos pontuais
    #[allow(dead_code)]
    pub fn send_whatsapp_via_intent_legacy(
        serial: &str,
        phone: &str,
        message: &str,
        package: Option<&str>,
    ) -> Result<(), String> {
        Self::send_whatsapp_native_navigation(serial, phone, message, None, package)
    }

    /// Toque físico com trajetória Bézier gerada pelo HPC nativo (curva quadrática com
    /// ponto de controle aleatório ±40px). Usa `input motionevent` (Android 10+) e, em
    /// fallback, swipes segmentados traçando a curva. Último recurso: `input tap`.
    #[allow(dead_code)]
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
        // Dwell time biológico humano: simula a permanência do polegar na tela (~80ms)
        sequence.push_str(&format!(
            " && sleep 0.08 && input motionevent UP {} {}",
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
    #[allow(dead_code)]
    fn send_long_message_typing(serial: &str, phone: &str, message: &str) -> Result<(), String> {
        Self::send_long_message_typing_pkg(serial, phone, message, Some("com.whatsapp"))
    }

    /// Fallback para mensagens longas com pacote alvo explícito
    /// Fallback para mensagens longas com pacote alvo explícito: utiliza navegação nativa fluida
    fn send_long_message_typing_pkg(
        serial: &str,
        phone: &str,
        message: &str,
        target_pkg: Option<&str>,
    ) -> Result<(), String> {
        Self::send_whatsapp_native_navigation(serial, phone, message, None, target_pkg)
    }

    /// Limpa em lote TODOS os contatos temporários gerados pelo Esfera v3 ('esfera_temp')
    pub fn clear_all_temporary_contacts(serial: &str) -> Result<(), String> {
        Self::cleanup_all_temporary_contacts(serial)
    }

    /// Executa um comando shell no aparelho e devolve a saída padrão como texto.
    /// Usa o túnel nativo para seriais esfera-agent e o adb binário nos demais.
    fn run_device_shell(serial: &str, cmd: &str) -> Result<String, String> {
        if Self::use_native_adb(serial) {
            let (out, _err, ok) = crate::adb_tcp::exec_shell_bytes(serial, cmd)?;
            if !ok { return Err("comando shell falhou no aparelho".to_string()); }
            Ok(String::from_utf8_lossy(&out).to_string())
        } else {
            let mut c = create_cmd("adb");
            c.args(["-s", serial, "shell"]).arg(cmd);
            let o = run_cmd_timeout(c, Duration::from_secs(15))?;
            if !o.status.success() {
                return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&o.stdout).to_string())
        }
    }

    /// Fontes EXTERNAS e independentes de consulta de IP público. Independentes de
    /// propósito: o hub da própria rota não serve como fonte, porque atrás da VPN ele
    /// veria o endereço interno do túnel, não a saída real. O servidor local
    /// (127.0.0.1 via adb reverse) veria só o IP de LAN.
    ///
    /// Nenhum dado do negócio vai nessas consultas: é um GET sem parâmetros, sem
    /// telefone, sem contato e sem credencial.
    pub fn egress_target_urls() -> Vec<String> {
        vec![
            "https://api.ipify.org".to_string(),
            "https://ifconfig.me/ip".to_string(),
            "https://icanhazip.com".to_string(),
        ]
    }

    /// Lê o IP público de DENTRO do aparelho — a única prova da rota real.
    /// toybox wget cobre os Android recentes; curl é o fallback. Um alvo por vez:
    /// o primeiro que responder um IP vale.
    pub fn probe_device_egress_ip(serial: &str) -> Result<String, String> {
        let serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let mut last_err = String::from("nenhum endpoint de egresso respondeu");
        for url in Self::egress_target_urls() {
            let cmd = format!(
                "toybox wget -T 8 -q -O - {q} 2>/dev/null || curl -s -m 8 {q}",
                q = Self::shell_quote(&url)
            );
            match Self::run_device_shell(&serial, &cmd) {
                Ok(out) => {
                    let ip = out.lines().map(str::trim).find(|l| crate::network_manager::looks_like_ip(l)).unwrap_or("").to_string();
                    if !ip.is_empty() { return Ok(ip); }
                    last_err = format!("{} respondeu algo que não é um IP", url);
                }
                Err(e) => last_err = format!("{}: {}", url, e),
            }
        }
        Err(last_err)
    }

    /// Lê um ajuste global do Android, tratando o literal "null" como vazio.
    fn read_global_setting(serial: &str, key: &str) -> String {
        let raw = Self::run_device_shell(serial, &format!("settings get global {}", key))
            .unwrap_or_default()
            .trim()
            .to_string();
        if raw == "null" { String::new() } else { raw }
    }

    /// Estado real da rota no aparelho: qual app de VPN está como always-on, se o
    /// bloqueio fora da VPN (lockdown) está ligado e qual proxy HTTP está gravado.
    /// É o que permite afirmar que a rota exigida está de fato aplicada.
    pub fn read_device_route_state(serial: &str) -> crate::network_manager::RouteState {
        let serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        let vpn_app = Self::read_global_setting(&serial, "always_on_vpn_app");
        let lockdown = Self::read_global_setting(&serial, "always_on_vpn_lockdown") == "1";
        let http_proxy = {
            let p = Self::read_global_setting(&serial, "http_proxy");
            if p == ":0" { String::new() } else { p }
        };
        crate::network_manager::RouteState { vpn_app, lockdown, http_proxy }
    }

    /// Aplica no aparelho a rota que o perfil pede.
    ///
    /// - `wireguard`: liga a VPN always-on do app WireGuard (open source) com lockdown,
    ///   que é o único arranjo que captura TODO o tráfego do Android, WhatsApp incluído,
    ///   e tenta subir o túnel pelo intent de controle remoto do app. Confere a gravação
    ///   lendo de volta: se o Android não aceitou o ajuste, devolve erro em vez de fingir.
    /// - `socks5`: grava o proxy global e nada mais. O WhatsApp não honra proxy de
    ///   sistema, então isso NUNCA é tratado como controle do tráfego.
    /// - `direto`: limpa a VPN always-on e o proxy, devolvendo o aparelho ao portão
    ///   compartilhado.
    pub fn apply_device_route(serial: &str, profile: &crate::db::NetworkProfile) -> Result<(), String> {
        let serial = Self::resolve_target_serial(serial).unwrap_or_else(|_| serial.to_string());
        match profile.mode.as_str() {
            "wireguard" => {
                let pkg = profile.vpn_package.trim();
                if pkg.is_empty() { return Err("perfil sem pacote de VPN definido".into()); }
                let installed = Self::run_device_shell(&serial, &format!("pm path {}", pkg))
                    .map(|o| o.contains("package:"))
                    .unwrap_or(false);
                if !installed {
                    return Err(format!("o app de VPN {} não está instalado no aparelho", pkg));
                }
                let lockdown = if profile.lockdown { "1" } else { "0" };
                let _ = Self::run_device_shell(&serial, &format!(
                    "settings put global always_on_vpn_app {} ; settings put global always_on_vpn_lockdown {}",
                    pkg, lockdown));
                // Sobe o túnel pelo controle remoto do app WireGuard (exige a opção
                // "Allow remote control apps" ligada no app). Melhor esforço.
                let tunnel = profile.vpn_tunnel.trim();
                if !tunnel.is_empty() {
                    let _ = Self::run_device_shell(&serial, &format!(
                        "am broadcast -a com.wireguard.android.action.SET_TUNNEL_UP -p {} --es tunnel {}",
                        pkg, Self::shell_quote(tunnel)));
                }
                // A verdade é o que o aparelho devolve, não o que mandamos.
                let state = Self::read_device_route_state(&serial);
                if state.vpn_app != pkg {
                    return Err(format!(
                        "o Android não aceitou {} como VPN always-on (requer consentimento da VPN no aparelho, ou device owner)", pkg));
                }
                if profile.lockdown && !state.lockdown {
                    return Err("o Android não aceitou o bloqueio de conexões fora da VPN (lockdown)".into());
                }
                Ok(())
            }
            "socks5" => {
                let proxy = profile.proxy_url.trim();
                if proxy.is_empty() { return Err("perfil socks5 sem endereço de proxy".into()); }
                Self::configure_device_socks_proxy_and_revoke_bssid(&serial, Some(proxy))
            }
            _ => {
                let _ = Self::run_device_shell(&serial,
                    "settings put global always_on_vpn_app '' ; settings put global always_on_vpn_lockdown 0");
                Self::configure_device_socks_proxy_and_revoke_bssid(&serial, Some(""))
            }
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
            // Garante permissões de leitura/escrita de contatos para o WhatsApp padrão
            batch.push_str(" && pm grant com.whatsapp android.permission.READ_CONTACTS 2>/dev/null && pm grant com.whatsapp android.permission.WRITE_CONTACTS 2>/dev/null");
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
            let _ = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .arg("shell")
                .arg("pm")
                .arg("grant")
                .arg("com.whatsapp")
                .arg("android.permission.READ_CONTACTS")
                .output();
            let _ = create_cmd("adb")
                .arg("-s")
                .arg(serial)
                .arg("shell")
                .arg("pm")
                .arg("grant")
                .arg("com.whatsapp")
                .arg("android.permission.WRITE_CONTACTS")
                .output();
        }

        Ok(())
    }

    /// Reconecta todos os dispositivos ativos limpos de soquetes zumbis do Windows com varredura por TCP Probe
    pub fn force_reconnect_all_adb(db: &crate::db::Database) -> Result<String, String> {
        // Expurga a pool nativa e os registros de túnel (serão renegociados sob demanda)
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
                                        let _ = db.process_checkin(&serial_no, &target_ip, &ip_part, 5555, &now, "");
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
                            let _ = db.process_checkin(&serial_no, &target_addr, &found_ip, 5555, &now, "");
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

    /// Alvos válidos para `adb connect`, em ordem de preferência e sem repetição.
    /// Só entra endereço IP:porta real: serial de cabo e id de túnel (ESF-...) não
    /// servem para `adb connect` e gastariam processo do ADB para nada.
    pub fn connect_targets(dev: &crate::db::Device) -> Vec<String> {
        fn aceitar(out: &mut Vec<String>, cand: &str) {
            let alvo = cand.trim();
            let Some((host, porta)) = alvo.rsplit_once(':') else { return };
            if host.parse::<std::net::Ipv4Addr>().is_err() { return; }
            if host == "0.0.0.0" || host == "127.0.0.1" { return; }
            if !matches!(porta.parse::<u16>(), Ok(p) if p > 0) { return; }
            let alvo = alvo.to_string();
            if !out.contains(&alvo) { out.push(alvo); }
        }

        let mut out = Vec::new();
        if let Some(addr) = dev.current_adb_address.as_deref() { aceitar(&mut out, addr); }
        if !dev.ip.is_empty() {
            let porta = if dev.port > 0 { dev.port } else { 5555 };
            aceitar(&mut out, &format!("{}:{}", dev.ip, porta));
            aceitar(&mut out, &format!("{}:5555", dev.ip));
        }
        aceitar(&mut out, &dev.serial);
        out
    }

    /// Força a conexão ADB de UM aparelho, na ordem: túnel reverso, cabo USB,
    /// endereços IP conhecidos. Nunca reinicia o servidor ADB — isso derrubaria os
    /// outros aparelhos — e devolve o motivo exato de cada rota que não respondeu.
    pub fn force_connect_device(db: &crate::db::Database, dev: &crate::db::Device) -> Result<String, String> {
        let nome = if dev.name.trim().is_empty() { dev.serial.clone() } else { dev.name.clone() };
        let mut tentativas: Vec<String> = Vec::new();

        // 1. Túnel reverso: quem abre a conexão é o aparelho, então aqui só se
        //    confirma que ele responde de verdade; `adb connect` não se aplica.
        if let Some(eid) = dev.esfera_device_id.as_deref().filter(|e| !e.trim().is_empty()) {
            if crate::tunnel_server::is_tunnel_active(eid) {
                match crate::adb_tcp::exec_shell_with_timeout(eid, "echo esfera_ok", Duration::from_secs(6)) {
                    Ok(saida) if saida.contains("esfera_ok") => {
                        let _ = db.mark_device_online(dev.id, eid);
                        return Ok(format!("{} já responde pelo túnel reverso.", nome));
                    }
                    Ok(_) => tentativas.push(format!("túnel {}: sessão registrada, mas o aparelho não respondeu ao teste", eid)),
                    Err(e) => tentativas.push(format!("túnel {}: {}", eid, e)),
                }
            } else {
                tentativas.push(format!("túnel {}: sem sessão ativa (quem inicia é o aparelho)", eid));
            }
        }

        // 2. Cabo USB presente: liga a porta TCP e já conecta pelo IP de Wi-Fi.
        let no_cabo = Self::list_devices()
            .unwrap_or_default()
            .into_iter()
            .any(|d| d.serial == dev.serial && d.state == "device");
        if no_cabo {
            let mut prop = create_cmd("adb");
            prop.args(["-s", &dev.serial, "shell", "setprop", "persist.adb.tcp.port", "5555"]);
            let _ = run_cmd_timeout(prop, Duration::from_secs(4));
            let _ = Self::enable_tcpip(&dev.serial, 5555);
            std::thread::sleep(Duration::from_millis(400));
            if let Ok(ip) = Self::get_device_wifi_ip(&dev.serial) {
                if ip.contains('.') && ip != "0.0.0.0" && ip != "127.0.0.1" {
                    if let Ok(msg) = Self::connect_device(&ip, 5555) {
                        let alvo = format!("{}:5555", ip);
                        let id_checkin = dev.esfera_device_id.clone().unwrap_or_else(|| dev.serial.clone());
                        let agora = chrono::Utc::now().to_rfc3339();
                        let _ = db.process_checkin(&id_checkin, &alvo, &ip, 5555, &agora, &dev.serial);
                        return Ok(format!("{}: {}", nome, msg));
                    }
                }
            }
            return Ok(format!("{} está no cabo USB e a porta 5555 foi ligada; o Wi-Fi ainda não respondeu.", nome));
        }

        // 3. Endereços conhecidos: só gasta processo de ADB quando o soquete abre.
        let alvos = Self::connect_targets(dev);
        if alvos.is_empty() {
            let extra = if tentativas.is_empty() { String::new() } else { format!("\n{}", tentativas.join("\n")) };
            return Err(format!(
                "{} não tem endereço IP conhecido e não está no cabo. Conecte uma vez por IP ou pareamento.{}",
                nome, extra
            ));
        }

        for alvo in &alvos {
            let Ok(sock) = alvo.parse::<std::net::SocketAddr>() else {
                tentativas.push(format!("{}: endereço inválido", alvo));
                continue;
            };
            let host = sock.ip().to_string();
            if std::net::TcpStream::connect_timeout(&sock, Duration::from_millis(700)).is_err() {
                tentativas.push(format!("{}: porta fechada, aparelho fora da rede ou depuração Wi-Fi desligada", alvo));
                continue;
            }
            // Expurga o soquete zumbi que o Windows guarda antes de reconectar.
            for forma in [alvo.clone(), host.clone()] {
                let mut disc = create_cmd("adb");
                disc.arg("disconnect").arg(&forma);
                let _ = run_cmd_timeout(disc, Duration::from_secs(2));
            }
            match Self::connect_device(&host, sock.port() as i32) {
                Ok(msg) => {
                    // Confirma no `adb devices` antes de gravar: "connected to" não
                    // garante autorização — a chave RSA pode estar pendente no aparelho.
                    let estado = Self::list_devices()
                        .unwrap_or_default()
                        .into_iter()
                        .find(|d| d.serial == *alvo)
                        .map(|d| d.state)
                        .unwrap_or_default();
                    if estado != "device" {
                        let visto = if estado.is_empty() { "sem transporte".to_string() } else { estado };
                        tentativas.push(format!(
                            "{}: {} — mas o ADB mostra \"{}\". Desbloqueie o aparelho e toque em Permitir na janela de depuração.",
                            alvo, msg.trim(), visto
                        ));
                        continue;
                    }
                    let mut serial_hw = String::new();
                    let mut prop = create_cmd("adb");
                    prop.args(["-s", alvo, "shell", "getprop", "ro.serialno"]);
                    if let Ok(o) = run_cmd_timeout(prop, Duration::from_secs(4)) {
                        serial_hw = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    }
                    let id_checkin = dev
                        .esfera_device_id
                        .clone()
                        .filter(|e| !e.trim().is_empty())
                        .unwrap_or_else(|| if serial_hw.is_empty() { dev.serial.clone() } else { serial_hw.clone() });
                    let agora = chrono::Utc::now().to_rfc3339();
                    let _ = db.process_checkin(&id_checkin, alvo, &host, sock.port(), &agora, &serial_hw);
                    let _ = db.mark_device_online(dev.id, alvo);
                    return Ok(format!("{} conectado em {}.", nome, alvo));
                }
                Err(e) => tentativas.push(format!("{}: {}", alvo, e)),
            }
        }

        Err(format!("Não foi possível conectar {}:\n{}", nome, tentativas.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aparelho_teste() -> crate::db::Device {
        crate::db::Device {
            id: 1,
            serial: "R58M30ABCDE".into(),
            name: "Celular 3".into(),
            brand: "Samsung".into(),
            model: "A15".into(),
            ip: String::new(),
            port: 0,
            status: "offline".into(),
            battery: 80,
            company_id: 1,
            device_number: 3,
            sector: "junior".into(),
            esfera_device_id: None,
            current_adb_address: None,
            last_seen_utc: None,
            via_tunnel: false,
        }
    }

    #[test]
    fn alvos_de_conexao_ignoram_serial_de_cabo_e_id_de_tunel() {
        let mut dev = aparelho_teste();
        dev.esfera_device_id = Some("ESF-R58M30ABCDE".into());
        dev.current_adb_address = Some("ESF-R58M30ABCDE".into());
        assert!(AdbManager::connect_targets(&dev).is_empty());
    }

    #[test]
    fn alvos_de_conexao_preferem_o_endereco_atual_e_nao_repetem() {
        let mut dev = aparelho_teste();
        dev.current_adb_address = Some("192.168.1.20:5555".into());
        dev.ip = "192.168.1.20".into();
        dev.port = 5555;
        assert_eq!(AdbManager::connect_targets(&dev), vec!["192.168.1.20:5555".to_string()]);
    }

    #[test]
    fn alvos_de_conexao_tentam_porta_do_banco_e_depois_a_5555() {
        let mut dev = aparelho_teste();
        dev.ip = "192.168.1.31".into();
        dev.port = 5037;
        assert_eq!(
            AdbManager::connect_targets(&dev),
            vec!["192.168.1.31:5037".to_string(), "192.168.1.31:5555".to_string()]
        );
    }

    #[test]
    fn alvos_de_conexao_recusam_enderecos_que_nao_levam_a_nada() {
        let mut dev = aparelho_teste();
        dev.ip = "0.0.0.0".into();
        dev.current_adb_address = Some("127.0.0.1:5555".into());
        dev.serial = "192.168.1.40:0".into();
        assert!(AdbManager::connect_targets(&dev).is_empty());
    }

    #[test]
    fn alvos_de_conexao_aceitam_serial_sem_fio() {
        let mut dev = aparelho_teste();
        dev.serial = "192.168.1.77:5555".into();
        assert_eq!(AdbManager::connect_targets(&dev), vec!["192.168.1.77:5555".to_string()]);
    }

    #[test]
    fn test_whatsapp_package_defaults() {
        assert_eq!(AdbManager::DEFAULT_WHATSAPP_PACKAGE, "com.whatsapp");
    }

    #[test]
    fn test_esfera_temp_account_constants() {
        assert_eq!(AdbManager::ESFERA_TEMP_CONTACT_ACCOUNT_NAME, "esfera_temp");
        assert_eq!(AdbManager::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE, "com.esfera");
    }

    #[test]
    fn test_parse_contact_id_from_standard_query() {
        let output = "Row: 0 _id=1234\n";
        assert_eq!(AdbManager::parse_contact_id_from_query(output), Some(1234));
    }

    #[test]
    fn test_parse_contact_id_with_multiple_rows_and_columns() {
        let output = "Row: 0 _id=987, account_name=esfera_temp, account_type=com.esfera\nRow: 1 _id=654, account_name=esfera_temp\n";
        assert_eq!(AdbManager::parse_contact_id_from_query(output), Some(987));
    }

    #[test]
    fn test_parse_contact_id_no_results() {
        assert_eq!(AdbManager::parse_contact_id_from_query("No result found.\n"), None);
        assert_eq!(AdbManager::parse_contact_id_from_query(""), None);
        assert_eq!(AdbManager::parse_contact_id_from_query("Error: unknown provider\n"), None);
    }

    #[test]
    fn test_extract_phone_digits() {
        assert_eq!(AdbManager::extract_phone_digits("+55 (11) 98765-4321"), "5511987654321");
        assert_eq!(AdbManager::extract_phone_digits("5511999998888"), "5511999998888");
        assert_eq!(AdbManager::extract_phone_digits("+1-800-555-0199"), "18005550199");
        assert_eq!(AdbManager::extract_phone_digits("invalid-no-numbers!"), "");
    }

    #[test]
    fn test_url_encode() {
        let msg = "Olá, tudo bem? Mensagem de teste & confirmação!";
        let encoded = AdbManager::url_encode(msg);
        assert!(!encoded.contains(' '));
        assert!(encoded.contains("%20"));
        assert!(encoded.contains("%26")); // &
    }

    #[test]
    fn test_shell_quote() {
        let raw = "João d'Ávila";
        let quoted = AdbManager::shell_quote(raw);
        assert_eq!(quoted, "João d'\"'\"'Ávila");
    }

    #[test]
    fn test_parse_contact_id_from_reversed_query() {
        // Garante que mesmo quando retornado em ordem não decrescente, o maior ID (mais novo) é sempre selecionado
        let output = "Row: 0 _id=102, account_name=esfera_temp\nRow: 1 _id=405, account_name=esfera_temp\nRow: 2 _id=203, account_name=esfera_temp\n";
        assert_eq!(AdbManager::parse_contact_id_from_query(output), Some(405));
    }

    #[test]
    fn test_parse_inserted_raw_contact_id() {
        let out_aosp = "Row inserted: content://com.android.contacts/raw_contacts/4321\n";
        assert_eq!(AdbManager::parse_inserted_raw_contact_id(out_aosp), Some(4321));

        let out_plain = "content://com.android.contacts/raw_contacts/987\n";
        assert_eq!(AdbManager::parse_inserted_raw_contact_id(out_plain), Some(987));

        let out_err = "Error: unable to insert into table\n";
        assert_eq!(AdbManager::parse_inserted_raw_contact_id(out_err), None);
    }

    #[test]
    fn test_normalize_target_phone() {
        assert_eq!(AdbManager::normalize_target_phone("(55) 99999-8888"), "5555999998888");
        assert_eq!(AdbManager::normalize_target_phone("0055 55 99999-8888"), "5555999998888");
        // Celular Brasil com DDD sem 55 -> adiciona 55
        assert_eq!(AdbManager::normalize_target_phone("(11) 98765-4321"), "5511987654321");
        assert_eq!(AdbManager::normalize_target_phone("11987654321"), "5511987654321");
        assert_eq!(AdbManager::normalize_target_phone("011987654321"), "5511987654321");

        // Fixo Brasil 10 dígitos -> adiciona 55
        assert_eq!(AdbManager::normalize_target_phone("1133334444"), "551133334444");

        // Já possui 55
        assert_eq!(AdbManager::normalize_target_phone("5511999998888"), "5511999998888");
        assert_eq!(AdbManager::normalize_target_phone("+55 (11) 98765-4321"), "5511987654321");

        // Internacional explícito com '+' preserva código original
        assert_eq!(AdbManager::normalize_target_phone("+1-800-555-0199"), "18005550199");
        assert_eq!(AdbManager::normalize_target_phone("+351 912 345 678"), "351912345678");

        // Inválido
        assert_eq!(AdbManager::normalize_target_phone(""), "");
        assert_eq!(AdbManager::normalize_target_phone("abc"), "");
    }

    #[test]
    fn test_type_text_fluid_hci_empty() {
        // Texto vazio não deve disparar comandos shell nem falhar
        let res = AdbManager::type_text_fluid_hci("invalid_serial", "");
        assert!(res.is_ok());
        let res_whitespace = AdbManager::type_text_fluid_hci("invalid_serial", "   ");
        assert!(res_whitespace.is_ok());
    }

    #[test]
    fn test_native_navigation_empty_phone() {
        // Telefone vazio ou inválido deve retornar erro imediato sem alterar a tela
        let res = AdbManager::send_whatsapp_native_navigation("invalid_serial", "", "msg", None, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("não contém dígitos"));

        let res_alpha = AdbManager::send_whatsapp_native_navigation("invalid_serial", "abc", "msg", None, None);
        assert!(res_alpha.is_err());
    }

    #[test]
    fn test_type_message_native_fast_empty() {
        assert!(AdbManager::type_message_native_fast("invalid_serial", "").is_ok());
        assert!(AdbManager::type_message_native_fast("invalid_serial", "   ").is_ok());
    }

    #[test]
    fn test_keystroke_schedule_model() {
        let text = "Olá João, tudo bem? Segue 2 opções! 😊";
        let d = AdbManager::keystroke_schedule(text);
        assert_eq!(d.len(), text.chars().count());
        assert!(d.iter().all(|ms| *ms <= 2500));
        // Letra comum: normal truncada em [45, 250]
        for _ in 0..200 {
            let plain = AdbManager::keystroke_delay_ms(Some('a'), 'b');
            assert!((45..=250).contains(&plain), "tecla comum fora da faixa: {}", plain);
        }
        // Espaço após fim de frase: base + pausa reflexiva (>= 150)
        let after = AdbManager::keystroke_delay_ms(Some('?'), ' ');
        assert!(after >= 195, "pausa após frase curta demais: {}", after);
        // Shift: maiúscula depois de minúscula ganha penalidade de 80..180
        let shift = AdbManager::keystroke_delay_ms(Some('a'), 'B');
        assert!((125..=430).contains(&shift), "shift fora da faixa: {}", shift);
        // Acento: penalidade também
        let accent = AdbManager::keystroke_delay_ms(Some('a'), 'ç');
        assert!(accent >= 125, "acento sem penalidade: {}", accent);
        // Média de teclas comuns próxima de 110 ms
        let n = 4000u64;
        let sum: u64 = (0..n).map(|_| AdbManager::keystroke_delay_ms(Some('a'), 'b') as u64).sum();
        let mean = sum as f64 / n as f64;
        assert!((98.0..=122.0).contains(&mean), "media fora do modelo: {}", mean);
    }
}

/// Telas do WhatsApp montadas como o agente as devolve (`DUMP_UI`: mesmos atributos e ordem do
/// EsferaAccessibilityService), com a estrutura real da conversa: barra com cabeçalho, lista
/// `android:id/list` com linhas sem id, `main_layout`, texto, hora e status, e o rodapé com o campo.
#[cfg(test)]
mod wa_screens {
    pub fn node(id: &str, class: &str, text: &str, desc: &str, b: [i32; 4], children: &str) -> String {
        format!(r#"<node index="0" text="{}" resource-id="{}" class="{}" package="com.whatsapp" content-desc="{}" clickable="false" enabled="true" focused="false" editable="false" bounds="[{},{}][{},{}]">{}</node>"#,
            text, id, class, desc, b[0], b[1], b[2], b[3], children)
    }

    pub fn hierarchy(root: &str) -> String {
        format!("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">{}</hierarchy>", root)
    }

    /// Uma linha da conversa; `status` None = mensagem recebida (sem tique/relógio).
    pub fn row(i: usize, text: &str, status: Option<&str>, text_id: &str) -> String {
        let top = 180 + i as i32 * 130;
        let status = status.map(|d| node("com.whatsapp:id/status", "android.widget.ImageView", "", d, [650, top + 92, 676, top + 114], "")).unwrap_or_default();
        let meta = node("com.whatsapp:id/date_wrapper", "android.widget.LinearLayout", "", "", [570, top + 90, 690, top + 116],
            &format!("{}{}", node("com.whatsapp:id/date", "android.widget.TextView", "14:32", "", [570, top + 92, 640, top + 114], ""), status));
        let body = node(text_id, "android.widget.TextView", text, "", [120, top + 10, 690, top + 86], "");
        node("", "android.view.ViewGroup", "", "", [0, top, 720, top + 124],
            &node("com.whatsapp:id/main_layout", "android.widget.LinearLayout", "", "", [100, top, 710, top + 124], &format!("{}{}", body, meta)))
    }

    pub fn chat_with(header: &str, rows: &[(&str, Option<&str>)], entry: &str, text_id: &str) -> String {
        let title = node("com.whatsapp:id/conversation_contact", "android.widget.LinearLayout", "", "", [150, 60, 560, 150], &format!("{}{}",
            node("com.whatsapp:id/conversation_contact_name", "android.widget.TextView", header, "", [150, 62, 560, 108], ""),
            node("com.whatsapp:id/conversation_contact_status", "android.widget.TextView", "online", "", [150, 110, 420, 148], "")));
        let toolbar = node("com.whatsapp:id/toolbar", "android.view.ViewGroup", "", "", [0, 48, 720, 160], &format!("{}{}{}",
            node("com.whatsapp:id/back", "android.widget.ImageButton", "", "Voltar", [0, 60, 90, 150], ""), title,
            node("com.whatsapp:id/menuitem_overflow", "android.widget.ImageView", "", "Mais opções", [650, 60, 720, 150], "")));
        let list = node("android:id/list", "android.widget.ListView", "", "", [0, 160, 720, 1380],
            &rows.iter().enumerate().map(|(i, (t, s))| row(i, t, *s, text_id)).collect::<String>());
        let button = if super::AdbManager::entry_empty(entry) {
            node("com.whatsapp:id/voice_note_btn", "android.widget.ImageButton", "", "Mensagem de voz", [620, 1400, 710, 1490], "")
        } else {
            node("com.whatsapp:id/send", "android.widget.ImageButton", "", "Enviar", [620, 1400, 710, 1490], "")
        };
        let footer = node("com.whatsapp:id/footer", "android.widget.LinearLayout", "", "", [0, 1390, 720, 1500], &format!("{}{}",
            node("com.whatsapp:id/entry", "android.widget.EditText", entry, "", [20, 1400, 600, 1490], ""), button));
        hierarchy(&node("", "android.widget.FrameLayout", "", "", [0, 0, 720, 1600], &format!("{}{}{}", toolbar, list, footer)))
    }

    pub fn chat(header: &str, rows: &[(&str, Option<&str>)], entry: &str) -> String {
        chat_with(header, rows, entry, "com.whatsapp:id/message_text")
    }

    /// Diálogo do WhatsApp sem ids conhecidos (versões novas usam layouts próprios).
    pub fn dialog(message: &str) -> String {
        hierarchy(&node("", "android.widget.FrameLayout", "", "", [40, 600, 680, 1000],
            &node("", "android.widget.LinearLayout", "", "", [40, 600, 680, 1000], &format!("{}{}",
                node("", "android.widget.TextView", message, "", [80, 640, 640, 860], ""),
                node("android:id/button1", "android.widget.Button", "OK", "", [500, 880, 640, 960], "")))))
    }
}

#[cfg(test)]
mod send_safety_tests {
    use super::wa_screens::*;
    use super::{AdbManager, SendCheck};

    const PHONE: &str = "5575988052539";
    /// Como o WhatsApp mostra um número sem contato salvo: cercado de marcas de direção.
    const HEADER: &str = "\u{202A}+55 75 98805-2539\u{202C}";
    const HISTORY: [(&str, Option<&str>); 2] = [("Bom dia, quem fala?", None), ("Olá! Aqui é da REALESS.", Some("Lida"))];

    fn with(rows: &[(&'static str, Option<&'static str>)]) -> Vec<(&'static str, Option<&'static str>)> {
        HISTORY.iter().copied().chain(rows.iter().copied()).collect()
    }

    /// A mesma tela no WhatsApp Business: outro pacote e ids com prefixo `com.whatsapp.w4b:id/`.
    fn business(xml: &str) -> String {
        xml.replace("package=\"com.whatsapp\"", "package=\"com.whatsapp.w4b\"").replace("com.whatsapp:id/", "com.whatsapp.w4b:id/")
    }

    #[test]
    fn business_confere_destinatario_e_envio_como_o_normal() {
        let typed = "Olá, tudo bem? Podemos conversar sobre a sua situação?";
        let before = business(&chat(HEADER, &HISTORY, typed));
        let after = business(&chat(HEADER, &with(&[(typed, Some("Enviada"))]), "Mensagem"));
        assert!(AdbManager::sent_on_screen(&before, &after, PHONE, typed));
        assert_eq!(AdbManager::send_check(&before, &before, PHONE, typed), SendCheck::StillInField);
        let other = business(&chat("\u{202A}+55 11 98805-2539\u{202C}", &HISTORY, "Mensagem"));
        assert!(AdbManager::verify_chat_identity(&other, PHONE).is_err());
    }

    #[test]
    fn destinatario_certo_nunca_e_recusado() {
        let screen = |header: &str| chat(header, &HISTORY, "Mensagem");
        // Marcas invisíveis em volta do número (U+202A/U+202C, U+200E).
        assert!(AdbManager::verify_chat_identity(&screen(HEADER), PHONE).is_ok());
        assert!(AdbManager::verify_chat_identity(&screen("\u{200E}+55 75 8805-2539\u{200E}"), PHONE).is_ok());
        // Contato antigo com os dígitos crus da planilha e o canônico.
        assert!(AdbManager::verify_chat_identity(&screen("Esfera 75988052539"), PHONE).is_ok());
        assert!(AdbManager::verify_chat_identity(&screen("Esfera 5575988052539"), PHONE).is_ok());
        // Número salvo com nome na agenda: a busca/link já casou o número.
        assert!(AdbManager::verify_chat_identity(&screen("João Silva"), PHONE).is_ok());
        // Cabeçalho com id desconhecido ou leitura vazia: nada prova outro número.
        assert!(AdbManager::verify_chat_identity(&screen(HEADER).replace("conversation_contact_name", "contact_title"), PHONE).is_ok());
        assert!(AdbManager::verify_chat_identity("", PHONE).is_ok());
        // DDD 55 (Santa Maria/RS) e DDI 55 juntos.
        assert!(AdbManager::verify_chat_identity(&screen("\u{202A}+55 55 99999-8888\u{202C}"), "55999998888").is_ok());
        assert!(AdbManager::verify_chat_identity(&screen("Esfera 5555999998888"), "55999998888").is_ok());
    }

    #[test]
    fn destinatario_errado_so_com_prova_positiva() {
        let screen = |header: &str| chat(header, &HISTORY, "Mensagem");
        assert!(AdbManager::verify_chat_identity(&screen("\u{202A}+55 11 98805-2539\u{202C}"), PHONE).is_err());
        assert!(AdbManager::verify_chat_identity(&screen("Esfera 5511988052539"), PHONE).is_err());
        assert!(AdbManager::verify_chat_identity(&screen("\u{202A}+55 55 99999-8888\u{202C}"), "5511999998888").is_err());
        let group = screen("Família").replace(r#"content-desc="Voltar""#, r#"content-desc="Dados do grupo""#);
        assert!(AdbManager::verify_chat_identity(&group, PHONE).is_err());
    }

    #[test]
    fn bolha_nova_com_tique_confirma_mesmo_com_negrito_e_marcas() {
        // A IA usa negrito com asteriscos; a bolha mostra o texto sem eles (e com marca invisível).
        let typed = "*Olá Maria*, tudo bem? 😊";
        let before = chat(HEADER, &HISTORY, typed);
        let after = chat(HEADER, &with(&[("Olá\u{200E} Maria, tudo bem? 😊", Some("Enviada"))]), "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &after, PHONE, typed), SendCheck::Confirmed);
        assert!(AdbManager::sent_on_screen(&before, &after, PHONE, typed));
        let entregue = after.replace("Enviada", "Entregue às 14:32");
        assert_eq!(AdbManager::send_check(&before, &entregue, PHONE, typed), SendCheck::Confirmed);
    }

    #[test]
    fn mensagem_longa_com_ler_mais_confirma_pelo_comeco() {
        let typed = "A REALESS preparou uma condição especial para regularizar a sua pendência com descontos exclusivos nesta semana. Para conhecer as opções, responda esta mensagem e um atendente vai te explicar tudo com calma, sem compromisso. Caso já tenha resolvido, desconsidere este aviso. Se não quiser mais receber nossos contatos, responda SAIR.";
        let shown = "A REALESS preparou uma condição especial para regularizar a sua pendência com descontos exclusivos nesta semana. Para conhecer as opções, responda esta… Ler mais";
        let before = chat(HEADER, &HISTORY, typed);
        let after = chat(HEADER, &with(&[(shown, Some("Enviada"))]), "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &after, PHONE, typed), SendCheck::Confirmed);
        // Trecho curto demais antes de "Ler mais" não basta.
        let tiny = chat(HEADER, &with(&[("A REALESS… Ler mais", Some("Enviada"))]), "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &tiny, PHONE, typed), SendCheck::Emptied);
    }

    #[test]
    fn campo_cheio_sem_bolha_nova_e_falha_comum() {
        let typed = "Olá Maria, tudo bem?";
        let before = chat(HEADER, &HISTORY, typed);
        assert_eq!(AdbManager::send_check(&before, &before, PHONE, typed), SendCheck::StillInField);
        // Mensagem igual antiga que rolou para a tela (no alto) não conta como enviada.
        let old_on_top: Vec<_> = [("Olá Maria, tudo bem?", Some("Lida"))].into_iter().chain(HISTORY).collect();
        let scrolled = chat(HEADER, &old_on_top, typed);
        assert_eq!(AdbManager::send_check(&before, &scrolled, PHONE, typed), SendCheck::StillInField);
    }

    #[test]
    fn relogio_e_pendente_e_falha_explicita_e_incerta() {
        let typed = "Olá Maria, tudo bem?";
        let before = chat(HEADER, &HISTORY, typed);
        let clock = chat(HEADER, &with(&[(typed, Some("Pendente"))]), "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &clock, PHONE, typed), SendCheck::Pending);
        let failed = clock.replace("Pendente", "Não enviada");
        assert_eq!(AdbManager::send_check(&before, &failed, PHONE, typed), SendCheck::Failed);
        assert!(!AdbManager::sent_on_screen(&before, &clock, PHONE, typed));
    }

    #[test]
    fn campo_vazio_com_estrutura_desconhecida_conta_como_enviado() {
        let typed = "Olá Maria, tudo bem?";
        let before = chat_with(HEADER, &HISTORY, typed, "com.whatsapp:id/conversation_text_row");
        // Ids da bolha mudaram nesta versão do WhatsApp: só o campo vazio fala.
        let after = chat_with(HEADER, &with(&[(typed, Some("Enviada"))]), "Mensagem", "com.whatsapp:id/conversation_text_row");
        assert_eq!(AdbManager::send_check(&before, &after, PHONE, typed), SendCheck::Emptied);
        // Bolha reconhecida mas status sem id conhecido.
        let before = chat(HEADER, &HISTORY, typed);
        let no_status = chat(HEADER, &with(&[(typed, Some("Enviada"))]), "Mensagem").replace("com.whatsapp:id/status", "com.whatsapp:id/msg_state");
        assert_eq!(AdbManager::send_check(&before, &no_status, PHONE, typed), SendCheck::Emptied);
        // Campo vazio e nenhuma bolha nova legível.
        let empty = chat(HEADER, &HISTORY, "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &empty, PHONE, typed), SendCheck::Emptied);
    }

    #[test]
    fn indicio_de_problema_vira_incerto() {
        let typed = "Olá Maria, tudo bem?";
        let before = chat(HEADER, &HISTORY, typed);
        let other_text = chat(HEADER, &HISTORY, "rascunho do operador");
        assert_eq!(AdbManager::send_check(&before, &other_text, PHONE, typed), SendCheck::OtherText);
        let other_chat = chat("\u{202A}+55 11 98805-2539\u{202C}", &with(&[(typed, Some("Enviada"))]), "Mensagem");
        assert_eq!(AdbManager::send_check(&before, &other_chat, PHONE, typed), SendCheck::WrongChat);
        assert_eq!(AdbManager::send_check(&before, "", PHONE, typed), SendCheck::Unreadable);
        let home = hierarchy(&node("com.whatsapp:id/conversations_list", "androidx.recyclerview.widget.RecyclerView", "", "", [0, 160, 720, 1500], ""));
        assert_eq!(AdbManager::send_check(&before, &home, PHONE, typed), SendCheck::Unreadable);
        // Com a bolha nova confirmada, texto alheio no campo não desfaz o envio.
        let sent_and_draft = chat(HEADER, &with(&[(typed, Some("Enviada"))]), "rascunho do operador");
        assert_eq!(AdbManager::send_check(&before, &sent_and_draft, PHONE, typed), SendCheck::Confirmed);
    }

    #[test]
    fn leitura_do_uiautomator_com_emoji_em_entidades() {
        // uiautomator: folhas auto-fechadas, visible-to-user e emoji como par surrogate numérico.
        let typed = "Olá Maria 😊";
        let before = chat(HEADER, &HISTORY, typed);
        let after = format!(concat!(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">",
            "<node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.FrameLayout\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[0,0][720,1600]\">",
            "<node index=\"0\" text=\"{}\" resource-id=\"com.whatsapp:id/conversation_contact_name\" class=\"android.widget.TextView\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[150,62][560,108]\" />",
            "<node index=\"1\" text=\"\" resource-id=\"android:id/list\" class=\"android.widget.ListView\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[0,160][720,1380]\">",
            "<node index=\"0\" text=\"\" resource-id=\"\" class=\"android.view.ViewGroup\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[0,1200][720,1320]\">",
            "<node index=\"0\" text=\"Olá Maria &#55357;&#56842;\" resource-id=\"com.whatsapp:id/message_text\" class=\"android.widget.TextView\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[120,1210][690,1280]\" />",
            "<node index=\"1\" text=\"\" resource-id=\"com.whatsapp:id/status\" class=\"android.widget.ImageView\" package=\"com.whatsapp\" content-desc=\"Entregue\" visible-to-user=\"true\" bounds=\"[650,1290][676,1312]\" />",
            "</node></node>",
            "<node index=\"2\" text=\"Mensagem\" resource-id=\"com.whatsapp:id/entry\" class=\"android.widget.EditText\" package=\"com.whatsapp\" content-desc=\"\" visible-to-user=\"true\" bounds=\"[20,1400][600,1490]\" />",
            "</node></hierarchy>"), HEADER);
        assert_eq!(AdbManager::send_check(&before, &after, PHONE, typed), SendCheck::Confirmed);
    }

    #[test]
    fn so_campo_cheio_e_reenviado_e_incerto_exige_indicio() {
        for ok in [SendCheck::Confirmed, SendCheck::Pending, SendCheck::Emptied] {
            assert_eq!(AdbManager::send_outcome(ok), Ok(()), "{:?}", ok);
        }
        // Nada saiu: falha comum, sem o prefixo INCERTO (o dispatcher tenta de novo).
        let full = AdbManager::send_outcome(SendCheck::StillInField).unwrap_err();
        assert!(!full.starts_with("INCERTO:"), "{}", full);
        for doubtful in [SendCheck::Failed, SendCheck::WrongChat, SendCheck::OtherText, SendCheck::Unreadable] {
            assert!(AdbManager::send_outcome(doubtful).unwrap_err().starts_with("INCERTO:"), "{:?}", doubtful);
        }
    }

    #[test]
    fn texto_preserva_pontuacao_e_decodifica_emoji() {
        assert!(!AdbManager::same_text("Aceita?", "Aceita!"));
        assert!(AdbManager::same_text("Olá  mundo &#55357;&#56842;", "Olá mundo 😊"));
        // Marcas invisíveis e seletor de variação não mudam a mensagem.
        assert!(AdbManager::same_text("\u{200E}Olá ❤\u{FE0F} mundo\u{200B}", "Olá ❤ mundo"));
        assert!(AdbManager::entry_empty("\u{200B}"));
        assert!(AdbManager::entry_empty("Mensagem"));
        assert!(!AdbManager::entry_empty("Olá"));
    }

    #[test]
    fn pacote_fora_do_whatsapp_e_recusado_antes_de_acessar_aparelho() {
        let result = AdbManager::send_whatsapp_parts("nao_acessar", "5511999998888", &["Olá".into()], Some("com.outro.app"), &|| true);
        assert!(result.unwrap_err().contains("WhatsApp"));
    }

    #[test]
    fn bloqueio_da_xiaomi_explica_o_que_ligar() {
        let msg = crate::adb_manager::install_block_hint("Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]").unwrap();
        assert!(msg.contains("Instalar via USB") && msg.contains("configurações de segurança"));
        assert_eq!(crate::adb_manager::install_block_hint("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"), None);
    }

    #[test]
    fn foco_identifica_whatsapp_normal_e_business() {
        let normal = "  mCurrentFocus=Window{1a u0 com.whatsapp/com.whatsapp.HomeActivity}\n  mFocusedApp=ActivityRecord{2b u0 com.whatsapp/com.whatsapp.HomeActivity t9}";
        let business = "  mCurrentFocus=Window{1a u0 com.whatsapp.w4b/com.whatsapp.HomeActivity}\n  mFocusedApp=ActivityRecord{2b u0 com.whatsapp.w4b/com.whatsapp.HomeActivity t9}";
        let launcher = "  mCurrentFocus=Window{1a u0 com.android.launcher3/com.android.launcher3.Launcher}";
        assert_eq!(AdbManager::whatsapp_in_focus(normal), Some(AdbManager::DEFAULT_WHATSAPP_PACKAGE));
        assert_eq!(AdbManager::whatsapp_in_focus(business), Some(AdbManager::BUSINESS_WHATSAPP_PACKAGE));
        assert_eq!(AdbManager::whatsapp_in_focus(launcher), None);
        // "com.whatsapp" é prefixo de "com.whatsapp.w4b": o Business nunca passa pelo normal.
        assert!(!AdbManager::focus_in(business, AdbManager::DEFAULT_WHATSAPP_PACKAGE));
        assert!(AdbManager::focus_in(business, AdbManager::BUSINESS_WHATSAPP_PACKAGE));
        assert!(!AdbManager::focus_in(normal, AdbManager::BUSINESS_WHATSAPP_PACKAGE));
    }
}

#[cfg(test)]
mod limpeza_contatos_tests {
    use super::AdbManager;

    // Saída real do `content query` de raw_contacts da conta do Esfera (moto g22, 05/11/2026),
    // com nomes trocados: contatos renomeados pelo operador ficaram dentro da conta do Esfera.
    const CONTA_ESFERA: &str = "Row: 0 _id=101, display_name=Esfera 5569993600492\n\
        Row: 1 _id=102, display_name=Marcela Backoffice\n\
        Row: 2 _id=103, display_name=Esfera 5547997547956 escritório\n\
        Row: 3 _id=104, display_name=Esfera 554733054406\n\
        Row: 4 _id=105, display_name=Esfera 123\n\
        Row: 5 _id=106, display_name=NULL\n";

    #[test]
    fn so_o_nome_exato_esfera_numero_pode_ser_apagado() {
        assert_eq!(AdbManager::deletable_temp_contact_ids(CONTA_ESFERA), vec![101, 104]);
        assert!(AdbManager::deletable_temp_contact_ids("No result found.").is_empty());
    }

    #[test]
    fn limpeza_apaga_por_id_dentro_da_conta_e_preserva_os_renomeados() {
        let mut comandos: Vec<String> = Vec::new();
        let apagados = AdbManager::cleanup_temporary_contacts_with(&mut |cmd| {
            comandos.push(cmd.to_string());
            Ok(if cmd.starts_with("content query") { CONTA_ESFERA.to_string() } else { String::new() })
        }).unwrap();
        assert_eq!(apagados, 2);
        let deletes: Vec<&String> = comandos.iter().filter(|c| c.starts_with("content delete")).collect();
        assert_eq!(deletes.len(), 1);
        assert!(deletes[0].contains("account_name='esfera_temp'") && deletes[0].contains("_id IN (101,104)"), "{}", deletes[0]);
        // Nunca um delete da conta inteira (era isso que apagava os contatos do operador).
        assert!(!comandos.iter().any(|c| c.starts_with("content delete") && !c.contains("_id IN (")));
    }

    #[test]
    fn sem_contato_temporario_nao_apaga_nada() {
        let mut comandos: Vec<String> = Vec::new();
        let apagados = AdbManager::cleanup_temporary_contacts_with(&mut |cmd| {
            comandos.push(cmd.to_string());
            Ok("Row: 0 _id=102, display_name=Marcela Backoffice\n".to_string())
        }).unwrap();
        assert_eq!(apagados, 0);
        assert!(!comandos.iter().any(|c| c.starts_with("content delete")));
    }
}

#[cfg(test)]
mod temp_contact_tests {
    use super::AdbManager;

    /// Provedor de contatos simulado com o comportamento do Android padrão: `content insert`
    /// não imprime nada; só as consultas devolvem linhas.
    #[derive(Default)]
    struct Contacts {
        next_id: i64,
        rows: Vec<(i64, String, Vec<(String, String)>)>,
        log: Vec<String>,
        ignore_insert: bool,
        drop_phone: bool,
    }

    fn between<'a>(text: &'a str, start: &str, end: char) -> Option<&'a str> {
        text.split(start).nth(1).and_then(|rest| rest.split(end).next())
    }

    impl Contacts {
        fn found(&self, ids: Vec<i64>, column: &str) -> Result<String, String> {
            Ok(if ids.is_empty() { "No result found.\n".into() }
               else { ids.iter().enumerate().map(|(i, id)| format!("Row: {} {}={}\n", i, column, id)).collect() })
        }

        fn run(&mut self, cmd: &str) -> Result<String, String> {
            self.log.push(cmd.to_string());
            if cmd.starts_with("content insert --uri content://com.android.contacts/raw_contacts") {
                if !self.ignore_insert {
                    self.next_id += 1;
                    let marker = between(cmd, "sourceid:s:", ' ').unwrap_or(cmd.rsplit(':').next().unwrap()).to_string();
                    self.rows.push((self.next_id + 40, marker, Vec::new()));
                }
                return Ok(String::new());
            }
            if cmd.starts_with("content query --uri content://com.android.contacts/raw_contacts") {
                let marker = between(cmd, "sourceid='", '\'').unwrap();
                let ids = self.rows.iter().filter(|r| r.1 == marker).map(|r| r.0).collect();
                return self.found(ids, "_id");
            }
            if cmd.starts_with("content insert --uri content://com.android.contacts/data") {
                let id: i64 = between(cmd, "raw_contact_id:i:", ' ').unwrap().parse().unwrap();
                let mime = between(cmd, "mimetype:s:", ' ').unwrap().to_string();
                let data1 = between(cmd, "data1:s:'", '\'').unwrap().to_string();
                if !(self.drop_phone && mime.ends_with("phone_v2")) {
                    if let Some(row) = self.rows.iter_mut().find(|r| r.0 == id) { row.2.push((mime, data1)); }
                }
                return Ok(String::new());
            }
            if cmd.starts_with("content query --uri content://com.android.contacts/data") {
                let number = between(cmd, "data1='", '\'').unwrap();
                let ids = self.rows.iter().filter(|r| r.2.iter().any(|(m, d)| m.ends_with("phone_v2") && d == number)).map(|r| r.0).collect();
                return self.found(ids, "raw_contact_id");
            }
            if cmd.starts_with("content delete") {
                if let Some(marker) = between(cmd, "sourceid='", '\'') { self.rows.retain(|r| r.1 != marker); }
                if let Some(id) = between(cmd, "_id=", ';').and_then(|v| v.trim().parse::<i64>().ok()) { self.rows.retain(|r| r.0 != id); }
                return Ok(String::new());
            }
            Err(format!("comando inesperado: {}", cmd))
        }
    }

    fn existing(id: i64, number: &str) -> (i64, String, Vec<(String, String)>) {
        (id, String::new(), vec![("vnd.android.cursor.item/phone_v2".into(), number.into())])
    }

    #[test]
    fn cria_contato_no_android_padrao_que_nao_imprime_o_insert() {
        let mut agenda = Contacts::default();
        let id = AdbManager::insert_temporary_contact_with("(75) 98805-2539", "esf-5575988052539-a1", &mut |c| agenda.run(c)).unwrap();
        assert_eq!(id, Some(41));
        let row = agenda.rows.iter().find(|r| r.0 == 41).unwrap();
        assert_eq!(row.1, "esf-5575988052539-a1");
        assert!(row.2.contains(&("vnd.android.cursor.item/name".into(), "Esfera 5575988052539".into())));
        assert!(row.2.contains(&("vnd.android.cursor.item/phone_v2".into(), "+5575988052539".into())));
        assert!(agenda.log.iter().any(|c| c.contains("--bind sourceid:s:esf-5575988052539-a1")));
    }

    #[test]
    fn reaproveita_contato_existente_e_tolera_duplicados() {
        let mut agenda = Contacts { rows: vec![existing(7, "+5575988052539")], ..Default::default() };
        assert_eq!(AdbManager::insert_temporary_contact_with("75988052539", "esf-x", &mut |c| agenda.run(c)).unwrap(), Some(7));
        assert!(!agenda.log.iter().any(|c| c.starts_with("content insert")));
        let mut agenda = Contacts { rows: vec![existing(9, "+5575988052539"), existing(4, "+5575988052539")], ..Default::default() };
        assert_eq!(AdbManager::insert_temporary_contact_with("75988052539", "esf-x", &mut |c| agenda.run(c)).unwrap(), Some(4));
    }

    #[test]
    fn falha_apaga_o_orfao_pelo_marcador() {
        let mut agenda = Contacts { ignore_insert: true, ..Default::default() };
        assert!(AdbManager::insert_temporary_contact_with("75988052539", "esf-y", &mut |c| agenda.run(c)).is_err());
        assert!(agenda.log.iter().any(|c| c.starts_with("content delete") && c.contains("sourceid='esf-y'")));
        let mut agenda = Contacts { drop_phone: true, ..Default::default() };
        assert!(AdbManager::insert_temporary_contact_with("75988052539", "esf-z", &mut |c| agenda.run(c)).is_err());
        assert!(agenda.rows.is_empty(), "o raw_contact sem número não pode sobrar na agenda");
    }

    #[test]
    fn parse_de_colunas_nao_confunde_id_com_raw_contact_id() {
        assert_eq!(AdbManager::parse_query_ids("Row: 0 raw_contact_id=12\nRow: 1 raw_contact_id=15\n", "raw_contact_id"), vec![12, 15]);
        assert!(AdbManager::parse_query_ids("Row: 0 raw_contact_id=12\n", "_id").is_empty());
        assert_eq!(AdbManager::parse_query_ids("Row: 0 _id=33\n", "_id"), vec![33]);
        assert!(AdbManager::parse_query_ids("No result found.\n", "_id").is_empty());
    }
}

#[cfg(test)]
mod agent_dump_tests {
    use super::AdbManager;
    use std::time::Duration;

    #[test]
    fn agente_so_fica_fora_por_culpa_dele() {
        use base64::Engine as _;
        let xml = super::wa_screens::chat("Esfera 5575988052539", &[], "Mensagem");
        let ok = format!("Broadcasting: Intent {{ act=com.esfera.agent.DUMP_UI }}\nBroadcast completed: result=1, data=\"{}\"\n",
            base64::engine::general_purpose::STANDARD.encode(xml.as_bytes()));
        assert_eq!(AdbManager::agent_dump_outcome(Ok(ok.as_str()), Duration::from_millis(300)), Ok(xml));
        // Prazo curto de quem chamou: não marca o agente como fora.
        assert_eq!(AdbManager::agent_dump_outcome(Err("tempo esgotado"), Duration::from_millis(400)), Err(false));
        // Silêncio com o prazo cheio, acessibilidade inativa, sem receptor ou dados quebrados: fora.
        assert_eq!(AdbManager::agent_dump_outcome(Err("tempo esgotado"), AdbManager::AGENT_DUMP_BUDGET), Err(true));
        assert_eq!(AdbManager::agent_dump_outcome(Ok("Broadcast completed: result=2\n"), Duration::from_millis(300)), Err(true));
        assert_eq!(AdbManager::agent_dump_outcome(Ok("Broadcast completed: result=0\n"), Duration::from_millis(300)), Err(true));
        assert_eq!(AdbManager::agent_dump_outcome(Ok("Broadcast completed: result=1, data=\"@@@\"\n"), Duration::from_millis(300)), Err(true));
        // Sem janela ativa ou tela sem nó visível (transição de tela): passageiro.
        assert_eq!(AdbManager::agent_dump_outcome(Ok("Broadcast completed: result=3\n"), Duration::from_millis(300)), Err(false));
        let empty = format!("Broadcast completed: result=1, data=\"{}\"\n",
            base64::engine::general_purpose::STANDARD.encode(super::wa_screens::hierarchy("").as_bytes()));
        assert_eq!(AdbManager::agent_dump_outcome(Ok(&empty), Duration::from_millis(300)), Err(false));
    }

    #[test]
    fn cada_leitura_do_laco_tem_folego_minimo() {
        let now = std::time::Instant::now();
        let read = AdbManager::read_deadline(now, now + Duration::from_secs(30));
        assert!(read >= now + AdbManager::UI_READ_FLOOR - Duration::from_millis(50));
        assert_eq!(AdbManager::read_deadline(now, now + Duration::from_secs(2)), now + Duration::from_secs(2));
    }
}

#[cfg(test)]
mod restore_agent_tests {
    use super::AdbManager;
    use std::collections::HashMap;

    /// Shell simulado: Samsung com Android 8 não tem MANAGE_EXTERNAL_STORAGE nem `cmd notification`.
    struct Android { sdk: u32, settings: HashMap<String, String>, log: Vec<String> }

    impl Android {
        fn new(sdk: u32) -> Self { Android { sdk, settings: HashMap::new(), log: Vec::new() } }
        fn run(&mut self, cmd: &str) -> Result<String, String> {
            self.log.push(cmd.to_string());
            if cmd == "getprop ro.build.version.sdk" { return Ok(format!("{}\n", self.sdk)); }
            if cmd.starts_with("appops set") {
                return if self.sdk >= 30 { Ok(String::new()) } else { Err("Error: Unknown operation string: MANAGE_EXTERNAL_STORAGE".into()) };
            }
            if cmd.starts_with("cmd notification") { return Err("cmd: Can't find service: notification".into()); }
            if let Some(key) = cmd.strip_prefix("settings get secure ") {
                return Ok(format!("{}\n", self.settings.get(key).cloned().unwrap_or_else(|| "null".into())));
            }
            if let Some(rest) = cmd.strip_prefix("settings put secure ") {
                let (key, value) = rest.split_once(' ').unwrap();
                self.settings.insert(key.into(), value.trim_matches('\'').into());
                return Ok(String::new());
            }
            if cmd.starts_with("am start-foreground-service") { return Ok("Starting service: Intent { cmp=com.esfera.agent/.EsferaAgentService }\n".into()); }
            Err(format!("comando inesperado: {}", cmd))
        }
    }

    #[test]
    fn android_8_religa_acessibilidade_e_ouvinte_do_sair() {
        let mut phone = Android::new(26);
        assert_eq!(AdbManager::restore_agent_services_with(&mut |c| phone.run(c), Ok(())), Ok(()));
        assert!(phone.settings["enabled_accessibility_services"].contains(AdbManager::AGENT_ACCESSIBILITY_COMPONENT));
        assert_eq!(phone.settings["accessibility_enabled"], "1");
        assert!(phone.settings["enabled_notification_listeners"].contains("com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener"));
        assert!(!phone.log.iter().any(|c| c.contains("MANAGE_EXTERNAL_STORAGE")), "Android 8 não tem essa operação");
    }

    /// A restauração dos serviços tem que religar de verdade, não só conferir a lista.
    /// Com o serviço derrubado pelo sistema o componente CONTINUA listado, e a versão
    /// anterior pulava a escrita justamente aí — o aparelho ficava online e mudo.
    #[test]
    fn restaurar_religa_apagando_e_regravando_a_lista() {
        let mut phone = Android::new(30);
        phone.settings.insert(
            "enabled_accessibility_services".into(),
            AdbManager::AGENT_ACCESSIBILITY_COMPONENT.into(),
        );
        assert_eq!(AdbManager::restore_agent_services_with(&mut |c| phone.run(c), Ok(())), Ok(()));

        let escritas: Vec<&String> = phone
            .log
            .iter()
            .filter(|c| c.starts_with("settings put secure enabled_accessibility_services"))
            .collect();
        assert!(escritas.len() >= 2, "precisa apagar e regravar, escreveu {:?}", escritas);
        assert!(
            escritas.iter().any(|c| !c.contains("EsferaAccessibilityService")),
            "o agente tem que sair da lista em algum momento: {:?}",
            escritas
        );
        assert!(phone.settings["enabled_accessibility_services"].contains(AdbManager::AGENT_ACCESSIBILITY_COMPONENT));
    }

    #[test]
    fn falha_do_acesso_a_arquivos_ou_do_reverse_nao_interrompe() {
        let mut phone = Android::new(30);
        let mut failing = |c: &str| if c.starts_with("appops") { Err("falhou".to_string()) } else { phone.run(c) };
        assert_eq!(AdbManager::restore_agent_services_with(&mut failing, Ok(())), Ok(()));
        let mut phone = Android::new(26);
        let result = AdbManager::restore_agent_services_with(&mut |c| phone.run(c), Err("Reverse tcp:7779 falhou".into()));
        assert!(result.unwrap_err().contains("encaminhamento de portas"));
        assert!(phone.settings["enabled_notification_listeners"].contains("EsferaOptOutNotificationListener"));
        assert!(phone.log.iter().any(|c| c.starts_with("am start-foreground-service")));
    }
}

/// O MIUI mata o agente na limpeza de memória (`OneKeyClean`). O Android então guarda o
/// serviço de acessibilidade em "Crashed services" e NÃO religa sozinho, mas deixa o
/// componente na lista de habilitados. Os textos abaixo são `dumpsys accessibility`
/// reais, colhidos em 05/11/2026 no aparelho SUPER (quebrado) e no Moto G22 (sadio).
#[cfg(test)]
mod acessibilidade_tests {
    use super::{AccessibilityState, AdbManager};

    const COMPONENTE: &str = AdbManager::AGENT_ACCESSIBILITY_COMPONENT;

    /// SUPER às 14:42: o componente está listado, e mesmo assim o aparelho está mudo.
    const DERRUBADO: &str = "\
User state[
     attributes:{id=0, touchExplorationEnabled=false}
     Bound services:{}
     Enabled services:{{com.esfera.agent/com.esfera.agent.accessibility.EsferaAccessibilityService}}
     Binding services:{}
     Crashed services:{{com.esfera.agent/com.esfera.agent.accessibility.EsferaAccessibilityService}}
";

    /// Moto G22 no mesmo instante, digitando normalmente. Repare que a linha de
    /// "Bound services" traz o RÓTULO truncado, não o nome do componente.
    const LIGADO: &str = "\
User state[
     Bound services:{Service[label=com.esfera.agent.accessibility.EsferaAccessibilityS\u{2026}, feedbackType[FEEDBACK_GENERIC], capabilities=161, eventTypes=TYPES_ALL_MASK, notificationTimeout=100, requestA11yBtn=false]}
     Enabled services:{{com.esfera.agent/com.esfera.agent.accessibility.EsferaAccessibilityService}}
     Binding services:{}
     Crashed services:{}
";

    const SEM_O_AGENTE: &str = "\
User state[
     Bound services:{}
     Enabled services:{}
     Binding services:{}
     Crashed services:{}
";

    #[test]
    fn servico_derrubado_pelo_sistema_nao_passa_por_ligado() {
        let estado = AdbManager::accessibility_state_from_dumpsys(DERRUBADO, COMPONENTE);
        assert_eq!(estado, AccessibilityState::Crashed);
        assert!(!estado.can_type(), "aparelho derrubado não pode receber disparo");
    }

    #[test]
    fn servico_ligado_de_verdade_e_reconhecido_pelo_rotulo_truncado() {
        let estado = AdbManager::accessibility_state_from_dumpsys(LIGADO, COMPONENTE);
        assert_eq!(estado, AccessibilityState::Bound);
        assert!(estado.can_type());
    }

    #[test]
    fn servico_fora_da_lista_e_desligado() {
        assert_eq!(
            AdbManager::accessibility_state_from_dumpsys(SEM_O_AGENTE, COMPONENTE),
            AccessibilityState::Off
        );
    }

    #[test]
    fn dumpsys_ilegivel_nao_vira_diagnostico() {
        for texto in ["", "error: device offline", "cmd: Can't find service: accessibility"] {
            assert_eq!(
                AdbManager::accessibility_state_from_dumpsys(texto, COMPONENTE),
                AccessibilityState::Unknown,
                "não dá para afirmar nada a partir de {:?}",
                texto
            );
        }
    }

    /// Shell simulado que guarda tudo o que foi escrito, na ordem.
    struct Shell {
        lista: String,
        habilitado: String,
        log: Vec<String>,
    }

    impl Shell {
        fn com(lista: &str) -> Self {
            Shell { lista: lista.into(), habilitado: "0".into(), log: Vec::new() }
        }
        fn run(&mut self, cmd: &str) -> Result<String, String> {
            self.log.push(cmd.to_string());
            if cmd == "settings get secure enabled_accessibility_services" {
                return Ok(format!("{}\n", if self.lista.is_empty() { "null".into() } else { self.lista.clone() }));
            }
            if let Some(v) = cmd.strip_prefix("settings put secure enabled_accessibility_services ") {
                self.lista = v.trim().trim_matches('\'').to_string();
                return Ok(String::new());
            }
            if let Some(v) = cmd.strip_prefix("settings put secure accessibility_enabled ") {
                self.habilitado = v.trim().to_string();
                return Ok(String::new());
            }
            Err(format!("comando inesperado: {}", cmd))
        }
        /// Valores gravados na lista, na ordem.
        fn escritas(&self) -> Vec<String> {
            self.log
                .iter()
                .filter_map(|c| c.strip_prefix("settings put secure enabled_accessibility_services "))
                .map(|v| v.trim().trim_matches('\'').to_string())
                .collect()
        }
    }

    /// A REGRESSÃO que deixou o SUPER mudo: a versão anterior só escrevia a lista
    /// quando o componente faltava nela. Com o serviço derrubado o componente está
    /// lá, a escrita era pulada, e o Android nunca reavaliava nada.
    #[test]
    fn religar_apaga_e_regrava_mesmo_com_o_componente_ja_na_lista() {
        let mut shell = Shell::com(COMPONENTE);
        AdbManager::rebind_accessibility_with(&mut |c| shell.run(c)).unwrap();

        let escritas = shell.escritas();
        assert!(escritas.len() >= 2, "precisa apagar e regravar, escreveu {:?}", escritas);
        assert!(
            !escritas[0].contains("EsferaAccessibilityService"),
            "a primeira escrita tem que TIRAR o componente, veio {:?}",
            escritas[0]
        );
        assert!(
            escritas.last().unwrap().contains(COMPONENTE),
            "a última escrita tem que devolver o componente, veio {:?}",
            escritas.last()
        );
        assert_eq!(shell.lista, COMPONENTE);
        assert_eq!(shell.habilitado, "1");
    }

    #[test]
    fn religar_preserva_os_outros_servicos_de_acessibilidade() {
        let outro = "com.google.android.marvin.talkback/.TalkBackService";
        let mut shell = Shell::com(&format!("{}:{}", outro, COMPONENTE));
        AdbManager::rebind_accessibility_with(&mut |c| shell.run(c)).unwrap();

        let escritas = shell.escritas();
        assert!(escritas.len() >= 2, "precisa apagar e regravar, escreveu {:?}", escritas);
        assert!(
            escritas.iter().any(|e| !e.contains("EsferaAccessibilityService")),
            "o agente tem que sair da lista em algum momento, senão o Android não reavalia: {:?}",
            escritas
        );
        for escrita in &escritas {
            assert!(escrita.contains(outro), "o TalkBack não pode ser desligado: {:?}", escrita);
        }
        assert!(shell.lista.contains(outro));
        assert!(shell.lista.contains(COMPONENTE));
    }

    #[test]
    fn religar_liga_do_zero_quando_a_lista_esta_vazia() {
        let mut shell = Shell::com("");
        AdbManager::rebind_accessibility_with(&mut |c| shell.run(c)).unwrap();
        assert_eq!(shell.lista, COMPONENTE);
        assert_eq!(shell.habilitado, "1");
    }

    const OUVINTE: &str = "com.esfera.agent/com.esfera.agent.EsferaOptOutNotificationListener";

    /// Saída da sonda de capacidades, montada como o aparelho devolve.
    fn sonda(dump: &str) -> String {
        format!(
            "GO=false\nACCESS={}\nENABLED=1\nLISTENER={}\nDUMP=\n{}",
            COMPONENTE, OUVINTE, dump
        )
    }

    /// O relatório que o SUPER dava enquanto estava mudo: configuração perfeita.
    /// Dizer "ok" aqui é o que escondeu o problema do operador por sete minutos.
    #[test]
    fn capacidades_acusam_servico_caido_em_vez_de_dizer_ok() {
        let (_, acessibilidade, _) = AdbManager::parse_agent_capabilities(&sonda(DERRUBADO));
        assert_eq!(acessibilidade, "caido");
    }

    #[test]
    fn capacidades_dizem_ok_quando_o_servico_esta_mesmo_ligado() {
        let (ouvinte, acessibilidade, go) = AdbManager::parse_agent_capabilities(&sonda(LIGADO));
        assert_eq!(acessibilidade, "ok");
        assert_eq!(ouvinte, "ok");
        assert!(!go);
    }

    /// Aparelho que não respondeu ao `dumpsys`: a lista de configuração sozinha não
    /// autoriza dizer que está tudo certo.
    #[test]
    fn sem_dumpsys_as_capacidades_nao_afirmam_que_esta_ok() {
        let antiga = format!("GO=false\nACCESS={}\nENABLED=1\nLISTENER={}\n", COMPONENTE, OUVINTE);
        let (_, acessibilidade, _) = AdbManager::parse_agent_capabilities(&antiga);
        assert_eq!(acessibilidade, "unknown");
    }

    #[test]
    fn servico_caido_pede_restauracao_mesmo_com_a_lista_certa() {
        assert!(AdbManager::agent_services_need_restore(AccessibilityState::Crashed, OUVINTE));
    }

    #[test]
    fn servico_ligado_com_tudo_certo_nao_pede_restauracao() {
        assert!(!AdbManager::agent_services_need_restore(AccessibilityState::Bound, OUVINTE));
    }

    /// Num aparelho onde o `dumpsys` não pode ser lido, restaurar sempre viraria
    /// um laço de restaurações sem fim.
    #[test]
    fn estado_desconhecido_nao_dispara_restauracao_em_laco() {
        assert!(!AdbManager::agent_services_need_restore(AccessibilityState::Unknown, OUVINTE));
    }

    #[test]
    fn ouvinte_do_sair_desligado_pede_restauracao() {
        assert!(AdbManager::agent_services_need_restore(AccessibilityState::Bound, ""));
    }
}

#[cfg(test)]
mod target_pick_tests {
    use super::AdbManager;
    #[test]
    fn mesmo_celular_por_usb_e_wifi_escolhe_usb() {
        let m = |list: &[(&str, &str)]| list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(AdbManager::pick_matched_target(m(&[("192.168.1.50:5555", "R58M123ABC"), ("R58M123ABC", "R58M123ABC")])).unwrap(), "R58M123ABC");
        assert_eq!(AdbManager::pick_matched_target(m(&[("192.168.1.50:5555", "R58M123ABC"), ("adb-R58M123ABC._adb-tls-connect._tcp", "R58M123ABC")])).unwrap(), "192.168.1.50:5555");
        assert!(AdbManager::pick_matched_target(m(&[("192.168.1.50:5555", "AAA"), ("0082925603", "BBB")])).is_err());
        assert!(AdbManager::pick_matched_target(m(&[("192.168.1.50:5555", ""), ("0082925603", "")])).is_err());
        assert_eq!(AdbManager::pick_matched_target(m(&[("0082925603", "")])).unwrap(), "0082925603");
        assert!(AdbManager::pick_matched_target(Vec::new()).is_err());
    }
}

/// O que a tela mostra depois do toque em Enviar (ver `confirm_sent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendCheck { Confirmed, Pending, Failed, Emptied, StillInField, OtherText, WrongChat, Unreadable }

/// Status mostrado ao lado da bolha de saída.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BubbleStatus { Confirmed, Pending, Failed, Unknown }

/// Nó da árvore de UI (uiautomator) usado para conferir telas do WhatsApp.
struct UiNode {
    rid: String,
    text: String,
    description: String,
    package: String,
    class: String,
    parent: Option<usize>,
    enabled: bool,
    visible: bool,
    cx: i32,
    cy: i32,
}

#[cfg(test)]
mod no_whatsapp_tests {
    use super::AdbManager;

    fn dialog(text: &str) -> String {
        format!(r#"<node package="com.whatsapp" resource-id="com.whatsapp:id/alert_root"><node package="com.whatsapp" resource-id="android:id/message" text="{}" /></node>"#, text)
    }

    #[test]
    fn reconhece_aviso_de_numero_sem_whatsapp() {
        assert!(AdbManager::shows_no_whatsapp(
            &dialog("O número de telefone +55 11 91234-5678 compartilhado por link não está no WhatsApp.")
        ));
        assert!(AdbManager::shows_no_whatsapp(&dialog("Phone number +55 11 91234-5678 shared via url isn&apos;t on WhatsApp.")));
        assert!(!AdbManager::shows_no_whatsapp(r#"<node text="Mensagem" /><node text="Conversas" />"#));
    }

    #[test]
    fn reconhece_carregamento_e_erro_de_rede_lenta() {
        assert!(AdbManager::shows_loading_or_connecting(&dialog("Iniciando conversa...")));
        assert!(AdbManager::shows_loading_or_connecting(&dialog("Buscando...")));
        assert!(AdbManager::shows_loading_or_connecting(&dialog("Cargando...")));
        assert!(!AdbManager::shows_loading_or_connecting(r#"<node package="com.whatsapp" resource-id="com.whatsapp:id/message_text" text="Aguarde meu retorno, loading concluído"/>"#));
        assert!(!AdbManager::shows_loading_or_connecting(r#"<node text="Conversas" />"#));

        assert!(AdbManager::shows_network_error(
            &dialog("Não foi possível conectar. Verifique sua conexão com a internet e tente novamente.")
        ));
        assert!(AdbManager::shows_network_error(
            &dialog("Couldn&apos;t connect. Check your internet connection and try again.")
        ));
        assert!(!AdbManager::shows_network_error(r#"<node text="Mensagem" />"#));
    }

    #[test]
    fn avisos_com_ids_desconhecidos_sao_lidos_por_exclusao() {
        use super::wa_screens::{dialog, chat, hierarchy, node};
        // Diálogo sem nenhum id conhecido e com o número cercado de marcas de direção.
        assert!(AdbManager::shows_no_whatsapp(&dialog("O número de telefone \u{202A}+55 11 91234-5678\u{202C} compartilhado por link não está no WhatsApp.")));
        // Barra de título "Conectando…" na conversa.
        let connecting = chat("Esfera 5575988052539", &[], "Mensagem").replace("text=\"online\"", "text=\"Conectando…\"");
        assert!(AdbManager::shows_loading_or_connecting(&connecting));
        // Tela de conta banida com id próprio da versão.
        let banned = hierarchy(&node("com.whatsapp:id/ban_info_scroll", "android.widget.ScrollView", "", "", [0, 0, 720, 1600],
            &node("com.whatsapp:id/ban_info_title", "android.widget.TextView", "Esta conta não pode mais usar o WhatsApp", "", [40, 300, 680, 400], "")));
        assert!(AdbManager::shows_restricted_account(&banned));
    }

    #[test]
    fn texto_de_conversa_e_campos_digitados_nunca_classificam_a_tela() {
        use super::wa_screens::{chat, hierarchy, node};
        // Bolhas de clientes na conversa aberta.
        let bubbles = chat("Esfera 5575988052539", &[
            ("Meu pai não tem WhatsApp, só esse número", None),
            ("Esta conta não pode mais usar o WhatsApp?", None),
            ("Aguarde, verificando aqui", None),
        ], "Mensagem");
        assert!(!AdbManager::shows_no_whatsapp(&bubbles));
        assert!(!AdbManager::shows_restricted_account(&bubbles));
        assert!(!AdbManager::shows_loading_or_connecting(&bubbles));
        // Prévias na lista de conversas (RecyclerView, ids da linha desconhecidos).
        let home = hierarchy(&node("com.whatsapp:id/conversations_list", "androidx.recyclerview.widget.RecyclerView", "", "", [0, 160, 720, 1500],
            &node("", "android.view.ViewGroup", "", "", [0, 160, 720, 300], &format!("{}{}",
                node("com.whatsapp:id/conversations_row_contact_name", "android.widget.TextView", "Cliente 12", "", [140, 170, 500, 210], ""),
                node("com.whatsapp:id/row_preview", "android.widget.TextView", "Esse número não está no WhatsApp, chama no outro", "", [140, 220, 700, 260], "")))));
        assert!(!AdbManager::shows_no_whatsapp(&home));
        // Texto digitado no campo.
        let typed = chat("Esfera 5575988052539", &[], "Verifique sua conexão com o banco antes de pagar");
        assert!(!AdbManager::shows_network_error(&typed));
    }
}

#[cfg(test)]
mod search_hit_tests {
    use super::AdbManager;

    #[test]
    fn acha_contato_temporario_na_secao_pessoas_e_recusa_outro_numero() {
        // Tela capturada no moto g22 em 28/10: busca aberta, contato sem conversa em "Pessoas".
        let xml = r#"<node index="0" text="​5534991359303" resource-id="com.whatsapp:id/search_input" bounds="[105,90][468,146]"></node>
<node index="0" text="Pessoas" resource-id="com.whatsapp:id/title" bounds="[0,189][720,227]"></node>
<node index="0" text="Esfera 5534991359303" resource-id="com.whatsapp:id/conversations_row_contact_name" bounds="[140,286][442,324]"></node>
<node index="0" text="Nenhum resultado encontrado" resource-id="com.whatsapp:id/search_no_matches" bounds="[0,440][720,548]"></node>"#;
        let nodes = AdbManager::ui_nodes(xml);
        let hit = AdbManager::search_hit(&nodes, "5534991359303", "91359303").expect("deveria achar o contato");
        assert_eq!(hit.text, "Esfera 5534991359303");
        assert_eq!((hit.cx, hit.cy), (291, 305));
        // Mesmo final com outro DDD não é a mesma pessoa.
        assert!(AdbManager::search_hit(&nodes, "5511991359303", "91359303").is_none());
    }

    #[test]
    fn numero_com_marcas_invisiveis_e_contato_antigo_nao_canonico() {
        let row = |text: &str| format!(r#"<node index="0" text="{}" resource-id="com.whatsapp:id/conversations_row_contact_name" class="android.widget.TextView" package="com.whatsapp" content-desc="" bounds="[140,286][442,324]"></node>"#, text);
        let hit = |text: &str| AdbManager::search_hit(&AdbManager::ui_nodes(&row(text)), "5575988052539", "88052539").is_some();
        assert!(hit("\u{202A}+55 75 98805-2539\u{202C}"));
        assert!(hit("Esfera 75988052539"));
        assert!(hit("Esfera 5575988052539"));
        assert!(!hit("Maria 75988052539"));
        assert!(!hit("\u{202A}+55 11 98805-2539\u{202C}"));
    }
}

#[cfg(test)]
mod split_parts_tests {
    use super::AdbManager;
    #[test]
    fn divide_bloco_unico() {
        let t = "Olá Teste, tudo bem? 😊 A REALESS preparou uma condição especial para regularizar sua pendência. Basta responder a este WhatsApp para iniciar a negociação. Caso queira parar de receber nossos contatos, responda SAIR. Abraço, Equipe REALESS";
        let p = AdbManager::split_human_parts(t);
        assert_eq!(p[0], "Olá Teste, tudo bem? 😊");
        assert_eq!(p.last().unwrap(), "Abraço, Equipe REALESS");
        assert_eq!(p.len(), 3);
        assert_eq!(p.join(" "), t);
    }
    #[test]
    fn respeita_linhas_em_branco() {
        let p = AdbManager::split_human_parts("Oi\n\nTexto aqui.\n\nAtt");
        assert_eq!(p, vec!["Oi", "Texto aqui.", "Att"]);
    }
}

#[cfg(test)]
mod search_match_tests {
    use crate::db::Database;
    #[test]
    fn ddd_diferente_nao_casa() {
        let want = Database::opt_out_key("5575988052539");
        assert_eq!(Database::opt_out_key("557588052539"), want); // como o WhatsApp mostra
        assert_eq!(Database::opt_out_key("5575988052539"), want); // contato "Esfera 55759..."
        assert_ne!(Database::opt_out_key("551188052539"), want); // mesmo final, outro DDD
    }
}

#[cfg(test)]
mod antiban_screen_tests {
    use super::AdbManager;
    #[test]
    fn reconhece_restricao_em_portugues_e_ingles() {
        let screen = |text| format!(r#"<node package="com.whatsapp" resource-id="com.whatsapp:id/registration_ban_message" text="{}"/>"#, text);
        assert!(AdbManager::shows_restricted_account(&screen("Esta conta não pode mais usar o WhatsApp")));
        assert!(AdbManager::shows_restricted_account(&screen("This account can no longer use WhatsApp")));
        assert!(AdbManager::shows_restricted_account(&screen("Esta cuenta no puede usar WhatsApp")));
        assert!(!AdbManager::shows_restricted_account("Conversas do WhatsApp"));
    }
}

#[cfg(test)]
mod wifi_serial_tests {
    use super::AdbManager;
    #[test]
    fn endereco_wifi_explicito_nao_redireciona_para_outro_aparelho() {
        assert_eq!(AdbManager::resolve_target_serial("192.168.1.92:5555").unwrap(), "192.168.1.92:5555");
    }
}

/// A versão esperada vem do mesmo Gradle que gera o APK; não há número duplicado no Rust.
pub fn expected_agent_version() -> Result<u32, String> {
    include_str!("../../src-agent/app/build.gradle.kts").lines().find_map(|line| {
        line.trim().strip_prefix("versionCode = ").and_then(|v| v.trim().parse::<u32>().ok())
    }).filter(|v| *v > 0).ok_or_else(|| "Versão do agente não encontrada no Gradle.".into())
}

fn axml_u16(data: &[u8], at: usize) -> Result<u16, String> {
    let b = data.get(at..at+2).ok_or("Manifesto APK truncado")?;
    Ok(u16::from_le_bytes([b[0],b[1]]))
}
fn axml_u32(data: &[u8], at: usize) -> Result<u32, String> {
    let b = data.get(at..at+4).ok_or("Manifesto APK truncado")?;
    Ok(u32::from_le_bytes([b[0],b[1],b[2],b[3]]))
}
fn axml_len8(data: &[u8], pos: &mut usize) -> Result<usize, String> {
    let b = *data.get(*pos).ok_or("Manifesto APK truncado")?; *pos += 1;
    if b & 0x80 == 0 { return Ok(b as usize); }
    let second = *data.get(*pos).ok_or("Manifesto APK truncado")?; *pos += 1;
    Ok((((b & 0x7f) as usize) << 8) | second as usize)
}
fn axml_len16(data: &[u8], pos: &mut usize) -> Result<usize, String> {
    let first=axml_u16(data,*pos)?; *pos+=2;
    if first & 0x8000 == 0 { return Ok(first as usize); }
    let second=axml_u16(data,*pos)?; *pos+=2;
    Ok((((first & 0x7fff) as usize) << 16) | second as usize)
}

/// Lê o manifesto binário diretamente do APK, sem depender de SDK/aapt instalado no cliente.
fn apk_agent_version(path: &std::path::Path) -> Result<u32, String> {
    use std::io::Read;
    let file=std::fs::File::open(path).map_err(|e| format!("Não foi possível abrir o APK: {}",e))?;
    let mut zip=zip::ZipArchive::new(file).map_err(|_| "APK inválido".to_string())?;
    let manifest=zip.by_name("AndroidManifest.xml").map_err(|_| "APK sem manifesto".to_string())?;
    if manifest.size() > 1024*1024 { return Err("Manifesto APK grande demais".into()); }
    let mut data=Vec::new(); manifest.take(1024*1024+1).read_to_end(&mut data).map_err(|_| "Falha ao ler manifesto APK".to_string())?;
    if data.len() > 1024*1024 { return Err("Manifesto APK grande demais".into()); }
    if axml_u16(&data,0)? != 0x0003 { return Err("Manifesto APK inválido".into()); }
    let mut offset=axml_u16(&data,2)? as usize;
    let mut strings: Vec<String> = Vec::new();
    while offset + 8 <= data.len() {
        let kind=axml_u16(&data,offset)?; let header=axml_u16(&data,offset+2)? as usize; let size=axml_u32(&data,offset+4)? as usize;
        let end=offset.checked_add(size).filter(|e| *e<=data.len()).ok_or("Manifesto APK truncado")?;
        if size < header || header < 8 { return Err("Manifesto APK inválido".into()); }
        if kind == 0x0001 {
            let count=axml_u32(&data,offset+8)? as usize;
            if count > 100000 || 28usize.checked_add(count.saturating_mul(4)).filter(|n| *n<=size).is_none() { return Err("Tabela de texto inválida".into()); }
            let utf8=axml_u32(&data,offset+16)? & 0x100 != 0;
            let base=offset.checked_add(axml_u32(&data,offset+20)? as usize).ok_or("Manifesto inválido")?;
            strings.clear();
            for i in 0..count {
                let mut pos=base.checked_add(axml_u32(&data,offset+header+i*4)? as usize).filter(|x| *x<end).ok_or("Texto inválido")?;
                let value = if utf8 {
                    let _ = axml_len8(&data,&mut pos)?; let len=axml_len8(&data,&mut pos)?;
                    let bytes=data.get(pos..pos.checked_add(len).filter(|e| *e<=end).ok_or("Texto inválido")?).ok_or("Texto inválido")?;
                    String::from_utf8(bytes.to_vec()).map_err(|_| "Texto inválido no APK")?
                } else {
                    let len=axml_len16(&data,&mut pos)?;
                    if len > (end.saturating_sub(pos))/2 { return Err("Texto inválido".into()); }
                    let mut words=Vec::with_capacity(len); for n in 0..len { words.push(axml_u16(&data,pos+n*2)?); }
                    String::from_utf16(&words).map_err(|_| "Texto inválido no APK")?
                };
                strings.push(value);
            }
        } else if kind == 0x0102 && size >= 36 {
            let name=axml_u32(&data,offset+20)? as usize;
            if strings.get(name).map(String::as_str) == Some("manifest") {
                let attr_start=offset+16+axml_u16(&data,offset+24)? as usize;
                let attr_size=axml_u16(&data,offset+26)? as usize;
                let count=axml_u16(&data,offset+28)? as usize;
                if attr_size < 20 || attr_start.checked_add(count.saturating_mul(attr_size)).filter(|v| *v<=end).is_none() { return Err("Atributos inválidos no APK".into()); }
                let mut package=None; let mut version=None;
                for n in 0..count {
                    let a=attr_start+n*attr_size; let key=axml_u32(&data,a+4)? as usize;
                    let value=axml_u32(&data,a+16)?; let typ=*data.get(a+15).ok_or("Atributo inválido")?;
                    match strings.get(key).map(String::as_str) {
                        Some("package") if typ == 3 => package=strings.get(value as usize).cloned(),
                        Some("versionCode") if typ == 0x10 || typ == 0x11 => version=Some(value),
                        _ => (),
                    }
                }
                if package.as_deref()!=Some("com.esfera.agent") { return Err("O APK não é o agente Esfera.".into()); }
                return version.filter(|v| *v>0).ok_or_else(|| "APK sem versionCode válido".into());
            }
        }
        offset=end;
    }
    Err("Manifesto do agente não encontrado".into())
}

#[cfg(test)]
mod agent_apk_version_tests {
    use super::*;
    #[test]
    fn versao_esperada_vem_do_gradle_e_apk_tem_manifesto_valido() {
        assert_eq!(expected_agent_version().unwrap(), 3);
        let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/Esfera_Agent_ADB.apk");
        assert_eq!(apk_agent_version(&file).unwrap(), expected_agent_version().unwrap());
    }
    #[test]
    fn manifesto_truncado_e_rejeitado() { assert!(axml_u32(&[1,2],0).is_err()); }
}

#[cfg(test)]
mod campaign_keyboard_tests {
    use super::*;

    #[test]
    fn settings_aceita_so_um_componente_valido() {
        assert_eq!(parse_input_method_setting(" com.android.inputmethod.latin/.LatinIME\r\n"), Some("com.android.inputmethod.latin/.LatinIME".into()));
        for invalid in ["", "null", "undefined", "Error: denied", "foo/bar\nfoo/baz", "foo/bar;reboot", "foo/.Keyboard$evil", "foo/", "/bar"] {
            assert_eq!(parse_input_method_setting(invalid), None, "{}", invalid);
        }
    }

    #[test]
    fn comandos_ime_nao_aceitam_injecao() {
        assert_eq!(ime_command("enable", ESFERA_IME), Some("ime enable com.esfera.agent/.EsferaKeyboardService".into()));
        assert_eq!(ime_command("set", ESFERA_IME), Some("ime set com.esfera.agent/.EsferaKeyboardService".into()));
        assert_eq!(ime_command("reset", ESFERA_IME), None);
        assert_eq!(ime_command("set", "foo/bar; reboot"), None);
    }

    #[test]
    fn restaura_so_o_anterior_e_respeita_troca_manual() {
        let previous = "com.android.inputmethod.latin/.LatinIME";
        assert_eq!(keyboard_to_restore(previous, ESFERA_IME), Some(previous.into()));
        assert_eq!(keyboard_to_restore(previous, "com.esfera.agent/com.esfera.agent.EsferaKeyboardService"), Some(previous.into()));
        assert_eq!(keyboard_to_restore(previous, "com.other/.Keyboard"), None);
        assert_eq!(keyboard_to_restore(ESFERA_IME, ESFERA_IME), None);
        assert_eq!(keyboard_to_restore("null", ESFERA_IME), None);
    }

    #[test]
    fn ativacao_guarda_anterior_uma_vez_e_confere_settings() {
        let mut previous = None;
        let mut commands = Vec::new();
        let mut settings_reads = 0;
        assert!(ensure_campaign_keyboard_with(&mut previous, &mut |cmd| {
            commands.push(cmd.to_string());
            if cmd == INPUT_METHOD_SETTING {
                settings_reads += 1;
                Ok(if settings_reads == 1 { "com.old/.Keyboard" } else { ESFERA_IME }.into())
            } else { Ok(String::new()) }
        }).unwrap());
        assert_eq!(previous.as_deref(), Some("com.old/.Keyboard"));
        assert_eq!(commands, vec![INPUT_METHOD_SETTING.to_string(), ime_command("enable", ESFERA_IME).unwrap(), ime_command("set", ESFERA_IME).unwrap(), INPUT_METHOD_SETTING.to_string()]);
        assert!(ensure_campaign_keyboard_with(&mut previous, &mut |_| Ok(ESFERA_IME.into())).unwrap());
        assert_eq!(previous.as_deref(), Some("com.old/.Keyboard"));
        let mut reads = 0;
        assert!(ensure_campaign_keyboard_with(&mut previous, &mut |cmd| {
            if cmd == INPUT_METHOD_SETTING {
                reads += 1;
                Ok(if reads == 1 { "com.manual/.Keyboard" } else { ESFERA_IME }.into())
            } else { Ok(String::new()) }
        }).unwrap());
        assert_eq!(previous.as_deref(), Some("com.old/.Keyboard"));
    }

    #[test]
    fn falha_do_ime_preserva_anterior_e_permite_fallback() {
        let mut previous = None;
        assert!(!ensure_campaign_keyboard_with(&mut previous, &mut |_| Ok("com.old/.Keyboard".into())).unwrap());
        assert_eq!(previous.as_deref(), Some("com.old/.Keyboard"));
        assert!(ensure_campaign_keyboard_with(&mut previous, &mut |_| Err("offline".into())).is_err());
        assert_eq!(previous.as_deref(), Some("com.old/.Keyboard"));
        let mut unknown = None;
        assert!(ensure_campaign_keyboard_with(&mut unknown, &mut |_| Ok("null".into())).is_err());
        assert_eq!(unknown, None);
    }

    #[test]
    fn restauracao_confirma_classe_expandida_sem_mudar_teclado_manual() {
        let previous = "com.old/.Keyboard";
        let mut commands = Vec::new();
        let mut replies = vec![ESFERA_IME, "", "com.old/com.old.Keyboard"].into_iter();
        assert!(restore_campaign_keyboard_with(previous, &mut |cmd| {
            commands.push(cmd.to_string());
            Ok(replies.next().unwrap().into())
        }).unwrap());
        assert_eq!(commands, vec![INPUT_METHOD_SETTING.to_string(), "ime set com.old/.Keyboard".into(), INPUT_METHOD_SETTING.to_string()]);
        let mut reads = 0;
        assert!(!restore_campaign_keyboard_with(previous, &mut |cmd| {
            assert_eq!(cmd, INPUT_METHOD_SETTING);
            reads += 1;
            Ok("com.manual/.Keyboard".into())
        }).unwrap());
        assert_eq!(reads, 1);
    }

    #[test]
    fn restauracao_recusada_ou_desconhecida_fica_pendente() {
        assert!(restore_campaign_keyboard_with("com.old/.Keyboard", &mut |_| Ok(ESFERA_IME.into())).is_err());
        assert!(restore_campaign_keyboard_with("com.old/.Keyboard", &mut |_| Ok("null".into())).is_err());
        assert!(restore_campaign_keyboard_with("com.old/.Keyboard", &mut |_| Err("offline".into())).is_err());
    }
}

fn parse_installed_agent_version(output: &str) -> Result<Option<(u32,String)>, String> {
    if output.contains("ESFERA_AGENT_NOT_INSTALLED") || output.contains("Unable to find package") || output.contains("Unknown package") || output.contains("Package not found") { return Ok(None); }
    let code = output.lines().find_map(|line| line.split("versionCode=").nth(1).and_then(|x| x.split(|c:char| !c.is_ascii_digit()).next()).and_then(|x| x.parse::<u32>().ok()));
    let name = output.lines().find_map(|line| line.trim().strip_prefix("versionName=").map(|x| x.trim().to_string())).unwrap_or_default();
    code.filter(|v| *v>0).map(|v| Some((v,name))).ok_or_else(|| "Não foi possível ler a versão do agente no aparelho.".into())
}

fn find_matching_agent_apk(expected: u32) -> Result<PathBuf, String> {
    let mut paths=Vec::new();
    for dir in tools_dir_candidates() { paths.push(dir.join("Esfera_Agent_ADB.apk")); }
    paths.extend([PathBuf::from("src-tauri/binaries/Esfera_Agent_ADB.apk"), PathBuf::from("binaries/Esfera_Agent_ADB.apk"), PathBuf::from("../src-tauri/binaries/Esfera_Agent_ADB.apk")]);
    if let Ok(exe)=std::env::current_exe() { if let Some(dir)=exe.parent() { paths.push(dir.join("binaries/Esfera_Agent_ADB.apk")); paths.push(dir.join("Esfera_Agent_ADB.apk")); } }
    let mut found=false;
    for path in paths { if path.is_file() { found=true; if apk_agent_version(&path).ok()==Some(expected) { return Ok(path); } } }
    if found { Err(format!("O APK empacotado ainda não é a versão {}. Atualize o APK do agente.",expected)) }
    else { Err("APK do agente não encontrado no pacote do Esfera.".into()) }
}

#[cfg(test)]
mod agent_installed_version_tests {
    use super::parse_installed_agent_version;
    #[test]
    fn reconhece_versao_e_ausencia_sem_confundir_erro() {
        assert_eq!(parse_installed_agent_version("versionCode=2 minSdk=26\nversionName=1.0.1\n").unwrap(),Some((2,"1.0.1".into())));
        assert_eq!(parse_installed_agent_version("Unable to find package: com.esfera.agent").unwrap(),None);
        assert_eq!(parse_installed_agent_version("ESFERA_AGENT_NOT_INSTALLED").unwrap(),None);
        assert!(parse_installed_agent_version("dispositivo offline").is_err());
    }
}

#[cfg(test)]
mod identity_read_tests {
    use super::AdbManager;
    #[test]
    fn falha_de_leitura_nunca_vira_primeira_adocao() {
        for output in ["", "device offline", "Permission denied", "ESFERA_ID_PRESENT:", "ESFERA_ID_PRESENT:ESF-antigo\nESFERA_ID_ABSENT"] {
            assert!(AdbManager::parse_identity_read(output).is_err());
        }
        assert_eq!(AdbManager::parse_identity_read("ESFERA_ID_PRESENT:ESF-identidade-antiga\n").unwrap(), Some("ESF-identidade-antiga".into()));
        assert_eq!(AdbManager::parse_identity_read("ESFERA_ID_ABSENT\n").unwrap(), None);
    }
}
