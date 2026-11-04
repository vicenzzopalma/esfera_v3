// Histórico do WhatsApp do disparo -> Konfiansa.
//
// A cada minuto busca no hub (VPS) as mensagens novas da instância de disparo da Evolution,
// guarda só as dos contatos que o Esfera disparou e, quando a conversa fica 1 hora sem
// mensagens (ou logo após o devedor pedir SAIR), grava a conversa no "Histórico interno"
// do processo do devedor no Konfiansa (tipo AUTOMÁTICO). Tudo passa pelo registro de prova
// ESF_KonfiansaHistory: pendente -> gravado (processo#histórico) | sem_processo | erro (com
// nova tentativa). Nunca grava duas vezes o mesmo texto no mesmo processo.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::db::{Database, KonfiansaHistoryRow, WaMessageRow};

/// Conversa parada por este tempo vai para o Konfiansa.
pub const SILENCE_SECS: i64 = 3600;
/// Depois do SAIR, espera só a confirmação sair.
pub const OPT_OUT_GRACE_SECS: i64 = 120;
const POLL_SECS: u64 = 60;
/// Tipo de histórico "AUTOMÁTICO" no Konfiansa.
const HISTORICO_TIPO: i32 = 41;
const BRIDGE_SOURCE: &str = include_str!("konfiansa_bridge.cs");

// ------------------------------------------------------------------
// Regras (puras, testadas)
// ------------------------------------------------------------------

/// Número real da conversa: `remoteJidAlt` quando ela está por LID.
pub fn phone_of(jid: &str, alt: &str) -> Option<String> {
    let pick = if alt.ends_with("@s.whatsapp.net") { alt } else if jid.ends_with("@s.whatsapp.net") { jid } else { return None };
    let digits: String = pick.split('@').next().unwrap_or("").chars().filter(|c| c.is_ascii_digit()).collect();
    (digits.len() >= 10).then_some(digits)
}

/// O histórico do Konfiansa é texto não unicode: emoji e símbolos fora do Latin-1 não cabem.
pub fn sem_emoji(s: &str) -> String {
    let limpo: String = s.chars()
        .filter(|c| {
            let n = *c as u32;
            n <= 0xFFFF && !(0x2600..=0x27BF).contains(&n) && !(0xFE00..=0xFE0F).contains(&n) && n != 0x200D && !(0x2B00..=0x2BFF).contains(&n)
        })
        .collect();
    limpo.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n")
}

pub fn fmt_phone(raw: &str) -> String {
    let d: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    let d = if (d.len() == 12 || d.len() == 13) && d.starts_with("55") { d[2..].to_string() } else { d };
    match d.len() {
        11 => format!("({}) {}-{}", &d[..2], &d[2..7], &d[7..]),
        10 => format!("({}) {}-{}", &d[..2], &d[2..6], &d[6..]),
        _ => d,
    }
}

/// Texto do histórico, no formato da exportação de conversa do WhatsApp.
pub fn build_text(origem: &str, msgs: &[WaMessageRow]) -> String {
    let destino = msgs.first().map(|m| m.phone.as_str()).unwrap_or("");
    let devedor = msgs.iter().find(|m| !m.from_me && !m.push_name.trim().is_empty())
        .map(|m| sem_emoji(m.push_name.trim())).unwrap_or_else(|| "Devedor".into());
    let titulo = if origem.trim().is_empty() {
        format!("ENVIO IA REALESS para {} (devedor)", fmt_phone(destino))
    } else {
        format!("ENVIO IA REALESS de {} para {} (devedor)", fmt_phone(origem), fmt_phone(destino))
    };
    let mut linhas = vec![titulo, String::new()];
    for m in msgs {
        let quando = chrono::DateTime::from_timestamp(m.ts, 0).unwrap_or_default().with_timezone(&chrono::Local);
        let quem = if m.from_me { "REALESS".to_string() } else { devedor.clone() };
        linhas.push(format!("[{}] {}: {}", quando.format("%H:%M, %d/%m/%Y"), quem, sem_emoji(&m.text)));
    }
    linhas.join("\n")
}

/// Hora de fechar a conversa? "recusa" logo após o SAIR; "silencio" após 1 hora parada.
pub fn closing_reason(now: i64, last_ts: i64, opted_out: bool) -> Option<&'static str> {
    let idle = now - last_ts;
    if opted_out && idle >= OPT_OUT_GRACE_SECS { Some("recusa") } else if idle >= SILENCE_SECS { Some("silencio") } else { None }
}

/// Literal SQL só com ASCII (acentos viram NCHAR, quebras CHAR(13)+CHAR(10)): o texto passa
/// intacto pelo sp_sqlexec do Konfiansa. Recebe o texto já sem emoji.
pub fn sql_text(s: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut buf = String::new();
    let flush = |buf: &mut String, parts: &mut Vec<String>| {
        if !buf.is_empty() { parts.push(format!("'{}'", buf.replace('\'', "''"))); buf.clear(); }
    };
    for ch in s.replace("\r\n", "\n").chars() {
        if ch == '\n' { flush(&mut buf, &mut parts); parts.push("CHAR(13)+CHAR(10)".into()); }
        else if (ch as u32) < 128 { buf.push(ch); }
        else { flush(&mut buf, &mut parts); parts.push(format!("NCHAR({})", ch as u32)); }
    }
    flush(&mut buf, &mut parts);
    if parts.is_empty() { "''".into() } else { parts.join("+") }
}

/// Processo de um devedor no Konfiansa (linha da consulta por telefone).
#[derive(Debug, Clone, PartialEq)]
pub struct Processo {
    pub processo: i64,
    pub devedor: i64,
    pub situacao: String,
}

/// Processo atual (maior código) de cada devedor com o telefone; grava nos não quitados. Se
/// todos estiverem quitados, só no mais recente. Cadastros antigos que dividem o número ficam de fora.
pub fn pick_processes(rows: &[Processo]) -> Vec<Processo> {
    let mut atual: HashMap<i64, Processo> = HashMap::new();
    for r in rows {
        let e = atual.entry(r.devedor).or_insert_with(|| r.clone());
        if r.processo > e.processo { *e = r.clone(); }
    }
    let mut atuais: Vec<Processo> = atual.into_values().collect();
    atuais.sort_by_key(|p| p.processo);
    let abertos: Vec<Processo> = atuais.iter().filter(|p| !p.situacao.eq_ignore_ascii_case("Quitado")).cloned().collect();
    if !abertos.is_empty() { abertos } else { atuais.last().cloned().into_iter().collect() }
}

/// Variações do número como o Konfiansa pode guardar: DDD + número, com e sem o nono dígito.
pub fn phone_variants(phone: &str) -> Vec<String> {
    let d: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    let d = if (d.len() == 12 || d.len() == 13) && d.starts_with("55") { d[2..].to_string() } else { d };
    let mut v = vec![d.clone()];
    if d.len() == 11 && d.as_bytes()[2] == b'9' { v.push(format!("{}{}", &d[..2], &d[3..])); }
    if d.len() == 10 { v.push(format!("{}9{}", &d[..2], &d[2..])); }
    v
}

// ------------------------------------------------------------------
// Ponte com o Konfiansa (compilada na 1ª vez com o csc do .NET Framework)
// ------------------------------------------------------------------

fn bridge_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join("esfera_v3").join("konfiansa")
}

fn ensure_bridge() -> Result<PathBuf, String> {
    let dir = bridge_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("pasta da ponte do Konfiansa: {}", e))?;
    let src = dir.join("KonfiansaBridge.cs");
    let exe = dir.join("KonfiansaBridge.exe");
    let current = std::fs::read_to_string(&src).unwrap_or_default();
    if current == BRIDGE_SOURCE && exe.exists() {
        return Ok(exe);
    }
    std::fs::write(&src, BRIDGE_SOURCE).map_err(|e| format!("fonte da ponte do Konfiansa: {}", e))?;
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
    let csc = ["Framework64", "Framework"].iter()
        .map(|f| PathBuf::from(&windir).join("Microsoft.NET").join(f).join("v4.0.30319").join("csc.exe"))
        .find(|p| p.exists())
        .ok_or("Compilador do .NET Framework 4 (csc.exe) não encontrado.")?;
    let out = crate::adb_manager::create_cmd(&csc)
        .arg("-nologo").arg(format!("-out:{}", exe.display()))
        .args(["-r:System.ServiceModel.dll", "-r:Microsoft.CSharp.dll", "-r:System.Data.dll", "-r:System.Core.dll"])
        .arg(&src)
        .output().map_err(|e| format!("csc: {}", e))?;
    if !out.status.success() || !exe.exists() {
        let _ = std::fs::remove_file(&src);
        return Err(format!("Falha ao compilar a ponte do Konfiansa: {}", String::from_utf8_lossy(&out.stdout).trim()));
    }
    Ok(exe)
}

/// Roda uma consulta no Konfiansa e devolve as linhas.
pub fn konfiansa_query(sql: &str) -> Result<Vec<Value>, String> {
    let cfg = crate::config::load_config();
    if cfg.konfiansa_win_user.trim().is_empty() || cfg.konfiansa_win_pass.is_empty() || cfg.konfiansa_logon.trim().is_empty() {
        return Err("Credenciais do Konfiansa não configuradas (konfiansa_win_user, konfiansa_win_pass, konfiansa_logon).".into());
    }
    let exe = ensure_bridge()?;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let file = bridge_dir().join(format!("q_{}_{}.sql", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::write(&file, sql).map_err(|e| format!("arquivo da consulta: {}", e))?;
    let out = crate::adb_manager::create_cmd(&exe)
        .arg("--query-file").arg(&file)
        .env("KONFIANSA_WIN_USER", cfg.konfiansa_win_user.trim())
        .env("KONFIANSA_WIN_PASS", &cfg.konfiansa_win_pass)
        .env("KONFIANSA_LOGON", cfg.konfiansa_logon.trim())
        .output();
    let _ = std::fs::remove_file(&file);
    let out = out.map_err(|e| format!("ponte do Konfiansa: {}", e))?;
    if !out.status.success() {
        return Err(format!("Konfiansa: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<Vec<Value>>(text.trim()).map_err(|_| format!("Resposta inválida do Konfiansa: {}", text.chars().take(200).collect::<String>()))
}

fn processes_for(phones: &[String], credor: Option<i32>) -> Result<Vec<(String, i32, Processo)>, String> {
    let nums: Vec<String> = phones.iter().flat_map(|p| phone_variants(p)).filter(|n| n.chars().all(|c| c.is_ascii_digit())).collect();
    if nums.is_empty() { return Ok(vec![]); }
    let lista = nums.iter().map(|n| format!("'{}'", n)).collect::<Vec<_>>().join(",");
    let filtro_credor = credor.map(|c| format!("p.CodCliente={} AND ", c)).unwrap_or_default();
    let rows = konfiansa_query(&format!(
        "SELECT ISNULL(t.NumTelefoneExporta, ISNULL(t.NumDDD,'')+ISNULL(t.NumTelefone,'')) AS Fone, p.CodCliente AS Credor, \
         p.CodDevedor AS Devedor, p.CodProcesso AS Processo, ISNULL(s.DesProcessoSituacao,'') AS Situacao \
         FROM ClienteTelefone t JOIN Processo p ON p.CodDevedor=t.CodCliente \
         LEFT JOIN ProcessoSituacao s ON s.CodProcessoSituacao=p.CodProcessoSituacao \
         WHERE {}(t.NumTelefoneExporta IN ({l}) OR ISNULL(t.NumDDD,'')+ISNULL(t.NumTelefone,'') IN ({l}))",
        filtro_credor, l = lista))?;
    Ok(rows.iter().filter_map(|r| Some((
        r.get("Fone")?.as_str().unwrap_or("").to_string(),
        r.get("Credor")?.as_i64()? as i32,
        Processo { processo: r.get("Processo")?.as_i64()?, devedor: r.get("Devedor")?.as_i64()?, situacao: r.get("Situacao")?.as_str().unwrap_or("").to_string() },
    ))).collect())
}

/// Credor da campanha no Konfiansa: o mais comum entre os processos dos contatos já enviados.
fn campaign_credor(db: &Database, campaign_id: i32) -> Result<i32, String> {
    let salvo = db.campaign_konfiansa_credor(campaign_id);
    if salvo > 0 { return Ok(salvo); }
    let phones = db.campaign_sent_phones(campaign_id, 30);
    let rows = processes_for(&phones, None)?;
    let mut por_credor: HashMap<i32, std::collections::HashSet<String>> = HashMap::new();
    for (fone, credor, _) in rows {
        por_credor.entry(credor).or_default().insert(Database::opt_out_key(&fone));
    }
    let achados: std::collections::HashSet<String> = por_credor.values().flatten().cloned().collect();
    let Some((credor, fones)) = por_credor.into_iter().max_by_key(|(_, f)| f.len()) else {
        return Err("Credor da campanha não identificado no Konfiansa (nenhum telefone enviado encontrado).".into());
    };
    if fones.len() < 3.min(achados.len()).max(1) || fones.len() * 2 < achados.len() {
        return Err("Credor da campanha não identificado no Konfiansa (telefones em credores diferentes).".into());
    }
    db.set_campaign_konfiansa_credor(campaign_id, credor)?;
    println!("[KONFIANSA] Campanha {} usa o credor {} ({} de {} telefones).", campaign_id, credor, fones.len(), achados.len());
    Ok(credor)
}

/// Grava um histórico nos processos do devedor. Devolve (status, processos, erro).
fn write_history(db: &Database, h: &KonfiansaHistoryRow) -> (String, String, String) {
    let credor = match campaign_credor(db, h.campaign_id) { Ok(c) => c, Err(e) => return ("erro".into(), h.processos.clone(), e) };
    let rows = match processes_for(&[h.phone.clone()], Some(credor)) { Ok(r) => r, Err(e) => return ("erro".into(), h.processos.clone(), e) };
    let alvo = pick_processes(&rows.into_iter().map(|(_, _, p)| p).collect::<Vec<_>>());
    if alvo.is_empty() {
        return ("sem_processo".into(), String::new(), format!("Telefone {} sem processo do credor {} no Konfiansa.", fmt_phone(&h.phone), credor));
    }
    let texto = sql_text(&sem_emoji(&h.texto));
    let mut feitos: Vec<String> = Vec::new();
    for p in alvo {
        // Mesmo texto já gravado neste processo (tentativa anterior que caiu no meio): só registra.
        let existente = konfiansa_query(&format!(
            "SELECT TOP 1 CodProcessoHistorico AS n FROM ProcessoHistorico WHERE CodProcesso={} AND CodProcessoHistoricoTipo={} \
             AND CAST(DesHistorico AS varchar(max)) = CAST({} AS varchar(max))", p.processo, HISTORICO_TIPO, texto));
        let numero = match existente {
            Ok(r) if !r.is_empty() => r[0].get("n").and_then(Value::as_i64),
            Ok(_) => {
                let log = format!("{} - AUTOMACAO", chrono::Local::now().format("%d/%m/%Y %H:%M:%S"));
                match konfiansa_query(&format!(
                    "INSERT INTO ProcessoHistorico (CodProcesso, CodProcessoHistorico, CodProcessoHistoricoTipo, HisExterno, BloHistorico, \
                     DtaHistorico, DesHistorico, UsuHistorico, LogAtualiza) \
                     SELECT {p}, ISNULL(MAX(CodProcessoHistorico),0)+1, {t}, 0, 1, GETDATE(), {texto}, 'AUTOMACAO', '{log}' \
                     FROM ProcessoHistorico WITH (UPDLOCK, HOLDLOCK) WHERE CodProcesso={p}; \
                     SELECT TOP 1 CodProcessoHistorico AS n FROM ProcessoHistorico WHERE CodProcesso={p} ORDER BY CodProcessoHistorico DESC",
                    p = p.processo, t = HISTORICO_TIPO, texto = texto, log = log)) {
                    Ok(r) => r.first().and_then(|x| x.get("n")).and_then(Value::as_i64),
                    Err(e) => return ("erro".into(), feitos.join(";"), e),
                }
            }
            Err(e) => return ("erro".into(), feitos.join(";"), e),
        };
        match numero {
            Some(n) => feitos.push(format!("{}#{}", p.processo, n)),
            None => return ("erro".into(), feitos.join(";"), format!("Konfiansa não confirmou o histórico no processo {}.", p.processo)),
        }
    }
    ("gravado".into(), feitos.join(";"), String::new())
}

// ------------------------------------------------------------------
// Serviço em segundo plano
// ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubMessage {
    id: String,
    ts: i64,
    jid: String,
    #[serde(default)]
    alt: String,
    from_me: bool,
    #[serde(default)]
    push_name: String,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Deserialize)]
struct HubPage {
    pages: u64,
    #[serde(default)]
    owner: String,
    messages: Vec<HubMessage>,
}

static ORIGEM: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

async fn fetch_messages(since: i64, until: i64) -> Result<Vec<HubMessage>, String> {
    let cfg = crate::config::load_config();
    if cfg.hub_token.trim().is_empty() { return Err("Token do hub não configurado.".into()); }
    let addr: std::net::SocketAddr = cfg.hub_address.trim().parse().map_err(|_| "Endereço do hub deve ser IP:porta.".to_string())?;
    let client = crate::hub_client::client_vps(Duration::from_secs(30))?;
    let mut out = Vec::new();
    let mut page = 1u64;
    loop {
        let url = format!("https://{}:8443/api/desktop/evolution/messages?since={}&until={}&page={}", addr.ip(), since, until, page);
        let resp = client.get(&url).bearer_auth(cfg.hub_token.trim()).send().await.map_err(|e| format!("hub: {}", e))?;
        if !resp.status().is_success() { return Err(format!("hub respondeu HTTP {}", resp.status())); }
        let body: HubPage = resp.json().await.map_err(|e| format!("resposta do hub: {}", e))?;
        if !body.owner.trim().is_empty() {
            if let Ok(mut o) = ORIGEM.lock() { *o = body.owner.trim().to_string(); }
        }
        out.extend(body.messages);
        if page >= body.pages || page >= 50 { break; }
        page += 1;
    }
    Ok(out)
}

/// Uma rodada: lê as mensagens novas, fecha as conversas prontas e grava as pendentes.
async fn tick(db: &Arc<Database>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    let cursor = db.evo_cursor().unwrap_or(now - 600);
    // Sobreposição de 5 min: mensagem que chegou atrasada não se perde (a repetida é ignorada).
    let since = (cursor - 300).max(now - 6 * 86_400);
    let msgs = fetch_messages(since, now).await?;
    let dispatched = db.dispatched_contacts()?;
    let rows: Vec<WaMessageRow> = msgs.into_iter().filter_map(|m| {
        let phone = phone_of(&m.jid, &m.alt)?;
        let key = Database::opt_out_key(&phone);
        let c = dispatched.get(&key)?;
        // Só a conversa a partir do disparo (com folga para o relógio).
        (m.ts >= c.first_sent_ts - 300).then(|| WaMessageRow {
            msg_id: m.id, ts: m.ts, phone_key: key, phone, from_me: m.from_me,
            push_name: m.push_name, text: m.text, campaign_id: c.campaign_id,
        })
    }).collect();
    let novas = db.store_wa_messages(&rows)?;
    db.set_evo_cursor(now)?;
    if novas > 0 { println!("[KONFIANSA] {} mensagens novas de devedores disparados.", novas); }

    let origem = ORIGEM.lock().map(|o| o.clone()).unwrap_or_default();
    for (key, _, _, first, last, _) in db.open_wa_conversations()? {
        let opted = db.opted_out_since(&key, first - 300);
        if let Some(motivo) = closing_reason(now, last, opted) {
            let conversa = db.open_wa_messages(&key)?;
            if conversa.is_empty() { continue; }
            let id = db.create_konfiansa_history(&conversa, motivo, &build_text(&origem, &conversa))?;
            println!("[KONFIANSA] Conversa de {} fechada ({}): histórico {} pendente.", fmt_phone(&key), motivo, id);
        }
    }

    for h in db.konfiansa_histories_due()? {
        let db2 = db.clone();
        let h2 = h.clone();
        let (status, processos, erro) = tokio::task::spawn_blocking(move || write_history(&db2, &h2)).await
            .unwrap_or_else(|e| ("erro".into(), h.processos.clone(), e.to_string()));
        db.finish_konfiansa_history(h.history_id, &status, &processos, &erro)?;
        println!("[KONFIANSA] Histórico {} ({}): {} {}{}", h.history_id, fmt_phone(&h.phone), status, processos, if erro.is_empty() { String::new() } else { format!(" — {}", erro) });
    }
    Ok(())
}

pub fn start(db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if crate::config::load_config().konfiansa_history_enabled {
                if let Err(e) = tick(&db).await {
                    eprintln!("[KONFIANSA] {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(ts: i64, from_me: bool, push: &str, text: &str) -> WaMessageRow {
        WaMessageRow { msg_id: ts.to_string(), ts, phone_key: "1191703561".into(), phone: "5511991703561".into(), from_me,
            push_name: push.into(), text: text.into(), campaign_id: 16 }
    }

    #[test]
    fn numero_real_da_conversa_por_lid() {
        assert_eq!(phone_of("171979701268517@lid", "5511991703561@s.whatsapp.net").as_deref(), Some("5511991703561"));
        assert_eq!(phone_of("5511991703561@s.whatsapp.net", "").as_deref(), Some("5511991703561"));
        assert_eq!(phone_of("171979701268517@lid", ""), None);
        assert_eq!(phone_of("120363@g.us", ""), None);
    }

    #[test]
    fn fecha_na_recusa_logo_e_no_silencio_de_uma_hora() {
        assert_eq!(closing_reason(1000, 900, true), None);
        assert_eq!(closing_reason(1000, 1000 - OPT_OUT_GRACE_SECS, true), Some("recusa"));
        assert_eq!(closing_reason(5000, 5000 - 3599, false), None);
        assert_eq!(closing_reason(5000, 5000 - SILENCE_SECS, false), Some("silencio"));
    }

    #[test]
    fn texto_no_formato_do_whatsapp_sem_emoji() {
        let msgs = [m(1793820390, true, "Realess", "Oi Rf Gravacoes LTDA, tudo certo? ✅"), m(1793820478, false, "Mel Silva", "Favor descadastrar 📲")];
        let t = build_text("5547999254497", &msgs);
        let linhas: Vec<&str> = t.lines().collect();
        assert_eq!(linhas[0], "ENVIO IA REALESS de (47) 99925-4497 para (11) 99170-3561 (devedor)");
        assert_eq!(linhas[1], "");
        assert!(linhas[2].starts_with('[') && linhas[2].ends_with("] REALESS: Oi Rf Gravacoes LTDA, tudo certo?"), "{}", linhas[2]);
        assert!(linhas[3].ends_with("] Mel Silva: Favor descadastrar"), "{}", linhas[3]);
        assert!(!t.chars().any(|c| c as u32 > 0xFFFF));
    }

    #[test]
    fn sql_so_ascii_com_acentos_e_quebras() {
        assert_eq!(sql_text("Olá 'x'\nfim"), "'Ol'+NCHAR(225)+' ''x'''+CHAR(13)+CHAR(10)+'fim'");
        assert!(sql_text(&sem_emoji("a 😀 b")).is_ascii());
    }

    #[test]
    fn processo_atual_nao_quitado_de_cada_devedor() {
        let p = |processo, devedor, s: &str| Processo { processo, devedor, situacao: s.into() };
        // Telefone em 3 cadastros: dois antigos quitados e o atual em cobrança.
        let r = pick_processes(&[p(2600038544, 1, "Quitado"), p(2600037387, 2, "Quitado"), p(2600064562, 3, "EM COBRANÇA"), p(2600037310, 3, "Quitado")]);
        assert_eq!(r.iter().map(|x| x.processo).collect::<Vec<_>>(), vec![2600064562]);
        // Tudo quitado: só o mais recente.
        let r = pick_processes(&[p(10, 1, "Quitado"), p(20, 2, "Quitado")]);
        assert_eq!(r.iter().map(|x| x.processo).collect::<Vec<_>>(), vec![20]);
        assert!(pick_processes(&[]).is_empty());
    }

    #[test]
    fn variacoes_do_numero_com_e_sem_nono_digito() {
        assert_eq!(phone_variants("+5511991703561"), vec!["11991703561", "1191703561"]);
        assert_eq!(phone_variants("1191703561"), vec!["1191703561", "11991703561"]);
    }
}
