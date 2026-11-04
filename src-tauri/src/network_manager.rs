// ============================================================
// Esfera v3 — Isolamento e auditoria de rede por aparelho (network_manager.rs)
// Gerenciador central: portão de envio por aparelho, lotes auditáveis de
// envios CONFIRMADOS e verificação da rota de saída (egresso).
//
// Regra de ouro: configurar uma rota no programa NÃO prova que o tráfego do
// Android passou por ela. A única prova é o IP público observado quando a
// consulta é feita DE DENTRO do aparelho, contra uma fonte externa.
//
// O que este módulo NÃO faz, por decisão de projeto: rotação compulsória de IP.
// Um IP por aparelho exige endereços públicos distintos (links ou IPs extras),
// que não existem de graça; e trocar de origem a cada punhado de mensagens é,
// por si, um sinal anômalo para a plataforma. Aqui se verifica e se pausa.
// ============================================================

use crate::adb_manager::AdbManager;
use crate::db::{Database, NetworkProfile};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::spawn_blocking;
use tauri::{AppHandle, Emitter};

/// Uma verificação de rota vale por este tempo; passado isso, o lote seguinte
/// só começa depois de uma verificação nova.
pub const CHECK_FRESHNESS_SECS: i64 = 900;

// Um aparelho com rota isolada não divide a fila conservadora com os demais;
// aparelhos em modo 'direto' continuam no portão global do dispatcher.
static DEVICE_NETWORK_GATES: LazyLock<Mutex<HashMap<i32, &'static AsyncMutex<Option<(i32, Instant)>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn dedicated_gate(device_id: i32) -> &'static AsyncMutex<Option<(i32, Instant)>> {
    let mut map = DEVICE_NETWORK_GATES.lock().unwrap_or_else(|e| e.into_inner());
    *map.entry(device_id).or_insert_with(|| Box::leak(Box::new(AsyncMutex::new(None))))
}

/// Portão que o aparelho deve usar no próximo envio, conforme o perfil dele.
pub fn gate_for(db: &Database, device_id: i32) -> &'static AsyncMutex<Option<(i32, Instant)>> {
    if db.get_network_profile(device_id).is_isolated() {
        dedicated_gate(device_id)
    } else {
        &crate::dispatcher::NETWORK_SEND_GATE
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum EgressVerdict {
    /// Rota conferida (ou, sem lista de IPs autorizados, apenas registrada).
    Ok,
    /// Divergência: o aparelho saiu por onde não devia, ou a rota exigida não está aplicada.
    Leak,
    /// Não foi possível provar nada: sem resposta da sonda.
    Unreachable,
}

impl EgressVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            EgressVerdict::Ok => "ok",
            EgressVerdict::Leak => "vazamento",
            EgressVerdict::Unreachable => "falha_probe",
        }
    }
}

/// Fases em que a verificação roda; vai gravada em ESF_EgressCheck.
pub const PHASE_PRE: &str = "pre_lote";
pub const PHASE_CLOSE: &str = "fim_lote";
pub const PHASE_MANUAL: &str = "manual";

pub(crate) fn looks_like_ip(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty()
        && (s.contains('.') || s.contains(':'))
        && s.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')
}

/// Listas aceitas no perfil: IPs permitidos separados por vírgula, ponto-e-vírgula ou linha.
pub fn parse_list(raw: &str) -> Vec<String> {
    raw.split([',', ';', '\n', '\r'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// O que está realmente aplicado no aparelho agora — a disponibilidade da rota.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RouteState {
    /// App de VPN always-on configurado no Android (vazio = nenhum).
    pub vpn_app: String,
    /// Bloqueio de conexões fora da VPN (lockdown) ligado.
    pub lockdown: bool,
    /// Proxy HTTP gravado no aparelho (só informativo: o WhatsApp o ignora).
    pub http_proxy: String,
}

/// Decisão da verificação — pura, para testar sem aparelho conectado.
///
/// Ordem das travas: sem IP não há prova nenhuma; depois a rota exigida tem de
/// estar aplicada (integridade/disponibilidade); por último o IP observado tem
/// de estar entre os autorizados (divergência).
pub fn classify_egress(
    observed: Option<&str>,
    profile: &NetworkProfile,
    state: &RouteState,
) -> (EgressVerdict, String) {
    let Some(ip) = observed.map(|s| s.trim()).filter(|s| looks_like_ip(s)) else {
        return (EgressVerdict::Unreachable, "não foi possível ler o IP público de dentro do aparelho".to_string());
    };

    if profile.captures_all_traffic() {
        if state.vpn_app != profile.vpn_package {
            return (EgressVerdict::Leak, format!(
                "a VPN exigida ({}) não está aplicada como always-on no aparelho{}",
                profile.vpn_package,
                if state.vpn_app.is_empty() { String::new() } else { format!(" (encontrado: {})", state.vpn_app) }));
        }
        if profile.lockdown && !state.lockdown {
            return (EgressVerdict::Leak,
                "bloqueio de conexões fora da VPN (lockdown) está desligado no aparelho".to_string());
        }
    }

    let allowed = parse_list(&profile.allowed_egress_ips);
    if allowed.is_empty() {
        let detail = if profile.is_isolated() {
            format!("IP {} registrado; sem lista de IPs autorizados não há o que conferir", ip)
        } else {
            String::new()
        };
        return (EgressVerdict::Ok, detail);
    }
    if !allowed.iter().any(|a| a == ip) {
        return (EgressVerdict::Leak, format!("IP {} fora da lista autorizada ({})", ip, allowed.join(", ")));
    }
    (EgressVerdict::Ok, String::new())
}

/// Aparelho que declara rota própria precisa provar a rota: sem prova, para.
/// Em modo 'direto' não há rota declarada, então falta de internet só é registrada.
pub fn should_pause(profile: &NetworkProfile, verdict: EgressVerdict) -> bool {
    match verdict {
        EgressVerdict::Leak => true,
        EgressVerdict::Unreachable => profile.is_isolated(),
        EgressVerdict::Ok => false,
    }
}

/// Como tocar a rota do aparelho e medir o resultado. Injetável para testes:
/// a lógica de decisão nunca depende de ADB real.
pub trait RouteProbe: Send + Sync {
    /// IP público observado por consulta feita DENTRO do aparelho, contra fonte externa.
    fn probe_ip(&self, serial: &str) -> Result<String, String>;
    /// O que está aplicado no aparelho agora (VPN always-on, lockdown, proxy).
    fn route_state(&self, serial: &str) -> RouteState;
    /// Aplica no aparelho a rota que o perfil pede.
    fn apply_route(&self, serial: &str, profile: &NetworkProfile) -> Result<(), String>;
}

pub struct AdbRouteProbe;

impl RouteProbe for AdbRouteProbe {
    fn probe_ip(&self, serial: &str) -> Result<String, String> {
        AdbManager::probe_device_egress_ip(serial)
    }
    fn route_state(&self, serial: &str) -> RouteState {
        AdbManager::read_device_route_state(serial)
    }
    fn apply_route(&self, serial: &str, profile: &NetworkProfile) -> Result<(), String> {
        AdbManager::apply_device_route(serial, profile)
    }
}

/// Resultado de uma verificação já registrada em ESF_EgressCheck.
#[derive(Debug, Clone)]
pub struct VerifyOutcome {
    pub verdict: EgressVerdict,
    pub observed_ip: String,
    pub detail: String,
    pub paused: bool,
}

/// Roda a verificação de rota do aparelho, grava a auditoria e, em divergência
/// ou falta de prova, pausa SOMENTE este aparelho.
pub fn verify_route(db: &Database, device_id: i32, serial: &str, phase: &str, probe: &dyn RouteProbe) -> VerifyOutcome {
    let profile = db.get_network_profile(device_id);
    let observed = probe.probe_ip(serial).ok();
    let state = probe.route_state(serial);
    let (verdict, detail) = classify_egress(observed.as_deref(), &profile, &state);
    let observed_ip = observed.unwrap_or_default();
    let applied = if profile.captures_all_traffic() {
        format!("vpn={} lockdown={}", state.vpn_app, if state.lockdown { "on" } else { "off" })
    } else {
        state.http_proxy.clone()
    };
    db.record_egress_check(device_id, &observed_ip, &profile.allowed_egress_ips, &profile.mode, &applied, phase, verdict.as_str(), &detail);

    let failures = if verdict == EgressVerdict::Ok { 0 } else { profile.consecutive_failures + 1 };
    let _ = db.set_profile_egress_result(device_id, &observed_ip, verdict.as_str(), failures);

    let paused = should_pause(&profile, verdict);
    if paused {
        let reason = if detail.is_empty() {
            format!("Verificação de rota ({}) sem prova de saída", phase)
        } else {
            detail.clone()
        };
        let _ = db.set_network_profile_status(device_id, "pausado_vazamento", &reason);
        db.queue_add_log(0, "network_leak", "rede",
            &format!("Aparelho {} pausado na verificação de rede ({}): {}", device_id, phase, reason));
    }
    VerifyOutcome { verdict, observed_ip, detail, paused }
}

/// Portão antes de cada envio, e quem ABRE o lote.
///
/// O lote tem de nascer antes do primeiro envio dele: se nascesse na borda, depois
/// de um envio confirmado, a marca de corte já incluiria esse envio e ele ficaria
/// fora do próprio lote — o primeiro lote pediria 11 confirmações em vez de 10.
///
/// Em lote novo, a rota do aparelho isolado é verificada aqui (IP público,
/// integridade e disponibilidade) e só então o lote abre. Modo 'direto' não tem
/// rota declarada: abre o lote sem sonda, para seguir auditado sem travar nada.
/// `true` = pode enviar.
pub fn ensure_route_before_batch(db: &Database, device_id: i32, serial: &str, company_id: i32, probe: &dyn RouteProbe) -> bool {
    if db.network_send_block_reason(device_id).is_some() {
        return false;
    }
    let profile = db.get_network_profile(device_id);
    match db.peek_open_send_batch(device_id) {
        None => {
            if profile.is_isolated() && verify_route(db, device_id, serial, PHASE_PRE, probe).paused {
                return false;
            }
            db.open_send_batch(device_id, company_id);
            true
        }
        Some(_) => {
            // Lote em andamento: só repete a sonda se a última prova venceu.
            if !profile.is_isolated() {
                return true;
            }
            let fresh = profile.last_egress_result == "ok"
                && db.seconds_since(&profile.last_egress_at).map(|s| s < CHECK_FRESHNESS_SECS).unwrap_or(false);
            if fresh {
                return true;
            }
            !verify_route(db, device_id, serial, PHASE_PRE, probe).paused
        }
    }
}

#[derive(Debug, Clone)]
pub struct BoundaryOutcome {
    pub batch_id: i64,
    pub closed: bool,
    pub verdict: EgressVerdict,
    pub observed_ip: String,
    pub detail: String,
    pub paused: bool,
}

impl BoundaryOutcome {
    fn no_boundary() -> Self {
        Self { batch_id: 0, closed: false, verdict: EgressVerdict::Ok, observed_ip: String::new(),
            detail: String::new(), paused: false }
    }
}

/// Borda de lote: ao atingir `BatchSize` envios CONFIRMADOS, fecha o lote com o
/// balanço das tentativas persistidas e verifica a rota de saída. A contagem vem
/// dos ESF_ChipAttempt já gravados — reiniciar o programa não duplica nem perde
/// envios.
///
/// Aqui o lote nunca é criado, apenas fechado: quem abre é `ensure_route_before_batch`,
/// antes do primeiro envio. Sem lote aberto não há borda.
pub fn run_batch_boundary(
    db: &Database,
    device_id: i32,
    serial: &str,
    _company_id: i32,
    probe: &dyn RouteProbe,
) -> BoundaryOutcome {
    let Some((batch_id, start_attempt)) = db.peek_open_send_batch(device_id) else {
        return BoundaryOutcome::no_boundary();
    };
    let batch_size = db.get_network_profile(device_id).batch_size as i64;
    let (confirmed, _failed, _uncertain) = db.batch_progress(device_id, start_attempt);
    if confirmed < batch_size {
        return BoundaryOutcome::no_boundary();
    }

    let out = verify_route(db, device_id, serial, PHASE_CLOSE, probe);
    let _ = db.close_send_batch(batch_id, &out.observed_ip, out.verdict.as_str());
    BoundaryOutcome {
        batch_id, closed: true, verdict: out.verdict,
        observed_ip: out.observed_ip, detail: out.detail, paused: out.paused,
    }
}

/// Chamado pelo dispatcher a cada envio confirmado. Fecha o lote na borda,
/// verifica a rota, pausa o aparelho em divergência e registra a auditoria.
/// Falha aqui nunca derruba o envio já concluído nem a fila dos outros aparelhos.
pub async fn on_confirmed_send(db: Arc<Database>, device_id: i32, serial: String, company_id: i32, app_handle: Option<AppHandle>) {
    let db2 = db.clone();
    let serial2 = serial.clone();
    let outcome = spawn_blocking(move || {
        let probe = AdbRouteProbe;
        run_batch_boundary(&db2, device_id, &serial2, company_id, &probe)
    })
    .await
    .unwrap_or_else(|_| BoundaryOutcome::no_boundary());

    if !outcome.closed {
        return;
    }

    let message = format!(
        "Lote {} encerrado no aparelho {}: egresso {} — verificação {}",
        outcome.batch_id, device_id,
        if outcome.observed_ip.is_empty() { "desconhecido" } else { &outcome.observed_ip },
        outcome.verdict.as_str()
    );
    db.queue_add_log(company_id, if outcome.paused { "network_leak" } else { "network" }, "rede", &message);
    report_pending_checks_to_hub(db.clone()).await;

    if let Some(app) = app_handle {
        let kind = if outcome.paused {
            match outcome.verdict { EgressVerdict::Leak => "leak", _ => "unreachable" }
        } else { "verified" };
        let _ = app.emit("network-alert", json!({
            "deviceId": device_id,
            "serial": serial,
            "batchId": outcome.batch_id,
            "kind": kind,
            "observedIp": outcome.observed_ip,
            "paused": outcome.paused,
            "message": if outcome.detail.is_empty() { message } else { outcome.detail },
        }));
    }
}

/// Verificação manual (botão "Verificar agora" na tela).
pub async fn check_device_now(db: Arc<Database>, device_id: i32, serial: String) -> Result<crate::db::EgressCheckRow, String> {
    let db2 = db.clone();
    spawn_blocking(move || {
        let probe = AdbRouteProbe;
        verify_route(&db2, device_id, &serial, PHASE_MANUAL, &probe)
    })
    .await
    .map_err(|e| format!("Falha na verificação: {}", e))?;
    report_pending_checks_to_hub(db.clone()).await;
    db.last_egress_check(device_id)
        .ok_or_else(|| "Verificação executada, mas não foi possível ler o registro.".to_string())
}

/// Aplica no aparelho a rota que o perfil pede (VPN always-on com lockdown, ou proxy)
/// e verifica em seguida. Melhor esforço na aplicação; a verdade vem da verificação.
pub async fn apply_and_verify(db: Arc<Database>, device_id: i32, serial: String) -> Result<crate::db::EgressCheckRow, String> {
    let db2 = db.clone();
    let applied = spawn_blocking(move || {
        let profile = db2.get_network_profile(device_id);
        let probe = AdbRouteProbe;
        probe.apply_route(&serial, &profile).map(|_| serial)
    })
    .await
    .map_err(|e| format!("Falha ao aplicar a rota: {}", e))?;
    let serial = applied?;
    check_device_now(db, device_id, serial).await
}

/// Envia ao hub VPS as verificações ainda não reportadas — o hub é o registro
/// central da auditoria. Vai só aparelho, IP de saída, modo, fase e veredito:
/// nada de telefone, contato ou credencial.
pub async fn report_pending_checks_to_hub(db: Arc<Database>) {
    let cfg = crate::config::load_config();
    if !cfg.hub_enabled || cfg.hub_address.trim().is_empty() {
        return;
    }
    let pending = {
        let db2 = db.clone();
        match spawn_blocking(move || db2.unreported_egress_checks(50)).await {
            Ok(rows) => rows,
            Err(_) => return,
        }
    };
    if pending.is_empty() {
        return;
    }
    let endpoint = crate::hub_client::endpoint_vps_https(&format!("http://{}/api/egress/report", cfg.hub_address.trim()));
    let client = match crate::hub_client::client_vps(std::time::Duration::from_secs(12)) {
        Ok(c) => c,
        Err(_) => return,
    };
    for (check_id, device_id, row) in pending {
        let body = json!({
            "deviceId": device_id,
            "checkedAt": row.checked_at,
            "observedIp": row.observed_ip,
            "mode": row.mode,
            "phase": row.phase,
            "result": row.result,
            "detail": row.detail,
        });
        let sent = client.post(&endpoint)
            .header("X-Hub-Token", cfg.hub_token.clone())
            .json(&body)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if sent {
            let db2 = db.clone();
            let _ = spawn_blocking(move || db2.mark_egress_check_reported(check_id)).await;
        } else {
            break; // hub fora do ar: as pendentes ficam para a próxima rodada
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DEFAULT_VPN_PACKAGE;

    fn wg_profile(allowed: &str) -> NetworkProfile {
        NetworkProfile {
            mode: "wireguard".into(), allowed_egress_ips: allowed.into(),
            vpn_package: DEFAULT_VPN_PACKAGE.into(), lockdown: true,
            ..NetworkProfile::default_for(1)
        }
    }
    fn direct_profile() -> NetworkProfile {
        NetworkProfile::default_for(2)
    }
    fn vpn_on() -> RouteState {
        RouteState { vpn_app: DEFAULT_VPN_PACKAGE.into(), lockdown: true, http_proxy: String::new() }
    }

    #[test]
    fn ip_valido_e_lido_do_output_da_sonda() {
        assert!(looks_like_ip("203.0.113.7"));
        assert!(looks_like_ip("2001:db8::1"));
        assert!(!looks_like_ip(""));
        assert!(!looks_like_ip("404: Not Found"));
        assert!(!looks_like_ip("<html>"));
    }

    #[test]
    fn lista_de_ips_aceita_virgula_ponto_e_linha() {
        assert_eq!(parse_list("1.1.1.1, 2.2.2.2;\n3.3.3.3\r\n"), vec!["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
        assert_eq!(parse_list(""), Vec::<String>::new());
    }

    #[test]
    fn lote_padrao_e_de_dez_confirmados() {
        assert_eq!(crate::db::DEFAULT_BATCH_SIZE, 10);
        assert_eq!(NetworkProfile::default_for(1).batch_size, 10);
    }

    #[test]
    fn modo_direto_sem_lista_apenas_registra() {
        let (v, d) = classify_egress(Some("10.0.0.5"), &direct_profile(), &RouteState::default());
        assert_eq!(v, EgressVerdict::Ok);
        assert!(d.is_empty());
    }

    #[test]
    fn divergencia_de_ip_e_vazamento() {
        let (v, d) = classify_egress(Some("198.51.100.9"), &wg_profile("203.0.113.7"), &vpn_on());
        assert_eq!(v, EgressVerdict::Leak);
        assert!(d.contains("198.51.100.9"));
    }

    #[test]
    fn ip_dentro_da_lista_autorizada_aprova() {
        let (v, _) = classify_egress(Some("203.0.113.8"), &wg_profile("203.0.113.7, 203.0.113.8"), &vpn_on());
        assert_eq!(v, EgressVerdict::Ok);
    }

    #[test]
    fn perda_de_conexao_e_prova_inexistente() {
        let p = wg_profile("203.0.113.7");
        assert_eq!(classify_egress(None, &p, &vpn_on()).0, EgressVerdict::Unreachable);
        assert_eq!(classify_egress(Some(""), &p, &vpn_on()).0, EgressVerdict::Unreachable);
        assert!(should_pause(&p, EgressVerdict::Unreachable), "isolado sem prova: falha fechada");
        assert!(!should_pause(&direct_profile(), EgressVerdict::Unreachable), "direto só registra");
    }

    #[test]
    fn vpn_exigida_ausente_e_rota_indisponivel() {
        let p = wg_profile("203.0.113.7");
        let sem_vpn = RouteState { vpn_app: String::new(), lockdown: false, http_proxy: String::new() };
        let (v, d) = classify_egress(Some("203.0.113.7"), &p, &sem_vpn);
        assert_eq!(v, EgressVerdict::Leak, "IP certo não basta: a rota exigida tem de estar aplicada");
        assert!(d.contains("always-on"));
    }

    #[test]
    fn lockdown_desligado_e_rota_sem_integridade() {
        let p = wg_profile("203.0.113.7");
        let sem_lockdown = RouteState { vpn_app: DEFAULT_VPN_PACKAGE.into(), lockdown: false, http_proxy: String::new() };
        let (v, d) = classify_egress(Some("203.0.113.7"), &p, &sem_lockdown);
        assert_eq!(v, EgressVerdict::Leak);
        assert!(d.contains("lockdown"));
    }

    #[test]
    fn socks5_nunca_e_tratado_como_prova_de_rota() {
        let mut p = wg_profile("203.0.113.7");
        p.mode = "socks5".into();
        assert!(p.is_isolated(), "socks5 ganha portão próprio");
        assert!(!p.captures_all_traffic(), "socks5 não captura todo o tráfego do Android");
        // Sem VPN aplicada, o veredito do socks5 depende só do IP observado.
        let (v, _) = classify_egress(Some("203.0.113.7"), &p, &RouteState::default());
        assert_eq!(v, EgressVerdict::Ok);
    }

    // ============================================================
    // Lote + verificação: banco temporário e sonda falsa.
    // ============================================================

    use rusqlite::params;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    struct FakeProbe {
        answers: StdMutex<VecDeque<Option<String>>>,
        state: StdMutex<RouteState>,
        applied: StdMutex<u32>,
        apply_fails: bool,
    }

    impl FakeProbe {
        fn new(ips: &[Option<&str>]) -> Self {
            Self {
                answers: StdMutex::new(ips.iter().map(|s| s.map(|v| v.to_string())).collect()),
                state: StdMutex::new(RouteState { vpn_app: DEFAULT_VPN_PACKAGE.into(), lockdown: true, http_proxy: String::new() }),
                applied: StdMutex::new(0),
                apply_fails: false,
            }
        }
        fn with_state(ips: &[Option<&str>], state: RouteState) -> Self {
            let p = Self::new(ips);
            *p.state.lock().unwrap() = state;
            p
        }
    }

    impl RouteProbe for FakeProbe {
        fn probe_ip(&self, _serial: &str) -> Result<String, String> {
            match self.answers.lock().unwrap().pop_front() {
                Some(Some(ip)) => Ok(ip),
                Some(None) => Err("aparelho sem conexão".to_string()),
                None => Err("sonda sem respostas programadas".to_string()),
            }
        }
        fn route_state(&self, _serial: &str) -> RouteState {
            self.state.lock().unwrap().clone()
        }
        fn apply_route(&self, _serial: &str, _profile: &NetworkProfile) -> Result<(), String> {
            if self.apply_fails { return Err("adb offline".to_string()); }
            *self.applied.lock().unwrap() += 1;
            Ok(())
        }
    }

    fn test_db(tag: &str) -> (Database, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("esfera_net_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::init(path.to_string_lossy().as_ref()).expect("banco de teste");
        (db, path)
    }

    fn seed_device(db: &Database, name: &str) -> i32 {
        let c = db.pooled_conn().unwrap();
        c.execute("INSERT INTO ESF_Device(AdbDeviceId,DeviceName,CompanyId) VALUES(?1,'Aparelho',1)", [name]).unwrap();
        let id: i32 = c.query_row("SELECT rowid FROM ESF_Device WHERE AdbDeviceId=?1", [name], |r| r.get(0)).unwrap();
        c.execute("INSERT INTO ESF_Chip(DeviceId,PhoneNumber) VALUES(?1,'11999990000')", [id]).unwrap();
        id
    }

    /// Registra `n` envios CONFIRMADOS como tentativas persistidas do chip do aparelho.
    fn confirmed_sends(db: &Database, device_id: i32, n: i64) {
        let c = db.pooled_conn().unwrap();
        let chip: i32 = c.query_row("SELECT ChipId FROM ESF_Chip WHERE DeviceId=?1", [device_id], |r| r.get(0)).unwrap();
        for i in 0..n {
            c.execute("INSERT INTO ESF_ChipAttempt(ChipId,CompanyId,CampaignId,PhoneDigits,Outcome) VALUES(?1,1,0,?2,'enviado')",
                params![chip, format!("119999900{}", i)]).unwrap();
        }
    }

    fn set_wireguard(db: &Database, device_id: i32, allowed: &str, batch: i32) {
        db.upsert_network_profile(device_id, "wireguard", "", allowed, batch, DEFAULT_VPN_PACKAGE, "esfera", true).unwrap();
    }

    /// Abre o lote como o dispatcher abre: portão pré-lote com a rota aprovada.
    fn abrir_lote(db: &Database, device_id: i32, ip: &str) {
        assert!(ensure_route_before_batch(db, device_id, "serial", 1, &FakeProbe::new(&[Some(ip)])),
            "o portão pré-lote deveria liberar com a rota provada");
    }

    #[test]
    fn lote_fecha_na_contagem_exata_e_divergencia_pausa_so_este_aparelho() {
        let (db, path) = test_db("leak");
        let d1 = seed_device(&db, "d1");
        let d2 = seed_device(&db, "d2");
        set_wireguard(&db, d1, "9.9.9.9", 3);
        db.upsert_network_profile(d2, "direto", "", "", 10, "", "", false).unwrap();

        abrir_lote(&db, d1, "9.9.9.9");
        confirmed_sends(&db, d1, 2);
        let out = run_batch_boundary(&db, d1, "serial", 1, &FakeProbe::new(&[]));
        assert!(!out.closed, "2 de 3 ainda não fecha o lote");

        confirmed_sends(&db, d1, 1);
        let out = run_batch_boundary(&db, d1, "serial", 1, &FakeProbe::new(&[Some("1.2.3.4")]));
        assert!(out.closed && out.paused);
        assert_eq!(out.verdict, EgressVerdict::Leak);
        assert!(db.network_send_block_reason(d1).is_some(), "aparelho que divergiu fica bloqueado");
        assert!(db.network_send_block_reason(d2).is_none(), "os demais aparelhos seguem livres");
        assert!(db.peek_open_send_batch(d1).is_none(), "o lote divergente fechou");

        let check = db.last_egress_check(d1).unwrap();
        assert_eq!(check.observed_ip, "1.2.3.4");
        assert_eq!(check.result, "vazamento");
        assert_eq!(check.phase, PHASE_CLOSE);
        let closed = &db.recent_send_batches(d1, 10)[0];
        assert_eq!(closed.confirmed, 3);
        assert_eq!(closed.verification, "vazamento");
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn perda_de_conexao_pausa_isolado_mas_apenas_registra_direto() {
        let (db, path) = test_db("offline");
        let iso = seed_device(&db, "o1");
        let dire = seed_device(&db, "o2");
        set_wireguard(&db, iso, "9.9.9.9", 1);
        db.upsert_network_profile(dire, "direto", "", "", 1, "", "", false).unwrap();
        abrir_lote(&db, iso, "9.9.9.9");
        abrir_lote(&db, dire, "9.9.9.9");
        confirmed_sends(&db, iso, 1);
        confirmed_sends(&db, dire, 1);

        let out_iso = run_batch_boundary(&db, iso, "serial", 1, &FakeProbe::new(&[None]));
        assert!(out_iso.closed && out_iso.paused, "isolado sem prova de rota: falha fechada, pausa");
        assert_eq!(out_iso.verdict, EgressVerdict::Unreachable);

        let out_dir = run_batch_boundary(&db, dire, "serial", 1, &FakeProbe::new(&[None]));
        assert!(out_dir.closed && !out_dir.paused, "modo direto sem internet só registra, não pausa");
        assert!(db.network_send_block_reason(dire).is_none());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rota_exigida_fora_do_ar_pausa_mesmo_com_ip_autorizado() {
        let (db, path) = test_db("noroute");
        let d1 = seed_device(&db, "nr1");
        set_wireguard(&db, d1, "7.7.7.7", 1);
        abrir_lote(&db, d1, "7.7.7.7");
        confirmed_sends(&db, d1, 1);
        let probe = FakeProbe::with_state(&[Some("7.7.7.7")],
            RouteState { vpn_app: String::new(), lockdown: false, http_proxy: String::new() });
        let out = run_batch_boundary(&db, d1, "serial", 1, &probe);
        assert!(out.paused, "sem a VPN aplicada o aparelho não pode continuar enviando");
        assert_eq!(out.verdict, EgressVerdict::Leak);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restart_recompoe_o_lote_sem_contar_de_novo() {
        let (db, path) = test_db("restart");
        let d1 = seed_device(&db, "x1");
        set_wireguard(&db, d1, "5.5.5.5", 3);
        abrir_lote(&db, d1, "5.5.5.5");
        let (b1, start) = db.peek_open_send_batch(d1).expect("lote aberto pelo portão");
        confirmed_sends(&db, d1, 2);
        assert_eq!(db.batch_progress(d1, start).0, 2);

        // Reinício do programa: mesmo arquivo, instância nova do banco.
        drop(db);
        let db = Database::init(path.to_string_lossy().as_ref()).expect("reabrir banco");
        let (b2, start2) = db.peek_open_send_batch(d1).expect("o lote aberto sobrevive ao restart");
        assert_eq!(b2, b1, "restart não abre um lote novo");
        assert_eq!(db.get_network_profile(d1).batch_size, 3);
        assert_eq!(db.batch_progress(d1, start2).0, 2, "restart não perde nem duplica a contagem");

        let out = run_batch_boundary(&db, d1, "serial", 1, &FakeProbe::new(&[]));
        assert!(!out.closed, "2 de 3 depois do restart ainda não fecha");

        confirmed_sends(&db, d1, 1);
        let out = run_batch_boundary(&db, d1, "serial", 1, &FakeProbe::new(&[Some("5.5.5.5")]));
        assert!(out.closed && !out.paused);
        let batch = db.recent_send_batches(d1, 10).into_iter().find(|x| x.batch_id == b2).unwrap();
        assert_eq!(batch.confirmed, 3);
        assert_eq!(batch.verification, "ok");

        // Próxima borda não refecha o mesmo lote.
        assert!(!run_batch_boundary(&db, d1, "serial", 1, &FakeProbe::new(&[])).closed);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn portao_pre_lote_barra_aparelho_sem_rota_e_libera_o_bom() {
        let (db, path) = test_db("pregate");
        let bom = seed_device(&db, "g1");
        let ruim = seed_device(&db, "g2");
        set_wireguard(&db, bom, "4.4.4.4", 10);
        set_wireguard(&db, ruim, "4.4.4.4", 10);

        assert!(ensure_route_before_batch(&db, bom, "serial", 1, &FakeProbe::new(&[Some("4.4.4.4")])), "rota provada libera");
        assert!(!ensure_route_before_batch(&db, ruim, "serial", 1, &FakeProbe::new(&[Some("8.8.8.8")])), "IP divergente barra o lote");
        assert!(db.network_send_block_reason(ruim).is_some());
        assert!(db.network_send_block_reason(bom).is_none());
        assert_eq!(db.last_egress_check(bom).unwrap().phase, PHASE_PRE);
        assert!(db.peek_open_send_batch(bom).is_some(), "o portão abre o lote do aparelho liberado");
        assert!(db.peek_open_send_batch(ruim).is_none(), "aparelho barrado não abre lote");
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn modo_direto_nao_precisa_de_verificacao_previa() {
        let (db, path) = test_db("predirect");
        let d = seed_device(&db, "pd1");
        db.upsert_network_profile(d, "direto", "", "", 10, "", "", false).unwrap();
        // Sonda sem respostas: se fosse consultada, falharia.
        assert!(ensure_route_before_batch(&db, d, "serial", 1, &FakeProbe::new(&[])));
        assert!(db.peek_open_send_batch(d).is_some(), "modo direto segue auditado em lotes");
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn portoes_isolado_e_compartilhado_sao_distintos() {
        let (db, path) = test_db("gates");
        let iso = seed_device(&db, "p1");
        let dire = seed_device(&db, "p2");
        set_wireguard(&db, iso, "", 10);
        db.upsert_network_profile(dire, "direto", "", "", 10, "", "", false).unwrap();
        assert!(std::ptr::eq(gate_for(&db, dire), &*crate::dispatcher::NETWORK_SEND_GATE), "direto permanece no portão compartilhado");
        let dedicated = gate_for(&db, iso);
        assert!(!std::ptr::eq(dedicated, &*crate::dispatcher::NETWORK_SEND_GATE), "isolado tem portão próprio");
        assert!(std::ptr::eq(dedicated, dedicated_gate(iso)), "o portão dedicado é estável por aparelho");
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
