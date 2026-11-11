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
pub(crate) const HISTORICO_TIPO: i32 = 41;
/// Tipos do histórico externo, por resultado (os mesmos que a equipe usa).
pub const TIPO_SEM_INTERESSE: i32 = 85;
pub const TIPO_EM_COBRANCA: i32 = 99;
pub const TIPO_CONTATO_EFETIVO: i32 = 100;
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
    // Pontuação tipográfica (comum em texto de IA) vira a equivalente simples, que o campo aceita.
    let s: String = s.chars().map(|c| match c {
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2007}' | '\u{202F}' | '\u{2009}' => ' ',
        '\u{201C}' | '\u{201D}' | '\u{201E}' => '"',
        '\u{2018}' | '\u{2019}' | '\u{201A}' => '\'',
        '\u{2026}' => '.',
        other => other,
    }).collect();
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
    // O WhatsApp guarda celular antigo sem o 9 (47 9683-4632): mostra como se disca (47) 99683-4632.
    let d = if d.len() == 10 && matches!(d.as_bytes()[2], b'6'..=b'9') { format!("{}9{}", &d[..2], &d[2..]) } else { d };
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

/// Fatos do histórico externo (o credor vê) e o tipo dele. A IA redige o registro a partir
/// destes fatos. Recusa (pediu SAIR) -> SEM INTERESSE; devedor respondeu -> CONTATO EFETIVO,
/// direcionado ao negociador; sem resposta -> EM COBRANÇA.
pub fn build_external(origem: &str, motivo: &str, msgs: &[WaMessageRow]) -> (String, i32) {
    let destino = msgs.first().map(|m| m.phone.as_str()).unwrap_or("");
    let quando = msgs.first().map(|m| chrono::DateTime::from_timestamp(m.ts, 0).unwrap_or_default()
        .with_timezone(&chrono::Local).format("%d/%m/%Y").to_string()).unwrap_or_default();
    let respondeu = msgs.iter().any(|m| !m.from_me);
    // SAIR escrito na conversa também é recusa (o descadastro pode chegar depois ao Esfera).
    let pediu_sair = msgs.iter().any(|m| !m.from_me && {
        let t = m.text.trim().to_lowercase();
        t == "sair" || t.starts_with("sair ") || t.contains("descadastr") || t.contains("não quero receber")
    });
    let (resultado, tipo) = if motivo == "recusa" || pediu_sair {
        ("o devedor recusou prosseguir com a tratativa por este canal e pediu para não receber novas mensagens", TIPO_SEM_INTERESSE)
    } else if respondeu {
        ("o devedor respondeu e o atendimento foi direcionado ao negociador responsável para continuidade das tratativas", TIPO_CONTATO_EFETIVO)
    } else {
        ("o devedor não respondeu até o momento; aguardamos o retorno para dar continuidade ao atendimento", TIPO_EM_COBRANCA)
    };
    let origem = if origem.trim().is_empty() { String::new() } else { format!("número de origem {}; ", fmt_phone(origem)) };
    (format!("Canal WhatsApp; data do contato {}; {}telefone do devedor {}; finalidade: dar andamento à regularização do débito; resultado: {}.",
        quando, origem, fmt_phone(destino), resultado), tipo)
}

/// Instrução para a IA escrever o histórico externo (vai como instrução da empresa).
const EXTERNO_PROMPT: &str = "O texto recebido NÃO é mensagem para o cliente: é uma lista de fatos de um contato de \
cobrança. Com esses fatos, redija o registro formal para o histórico do processo, lido pelo credor: português formal, \
terceira pessoa do plural (ex.: realizamos, permanecemos), um único parágrafo de duas ou três frases, sem saudação, \
sem emoji, sem nomes de pessoas e sem a palavra fatos. Inclua exatamente a data, os números de telefone, o canal \
WhatsApp e o resultado. Não acrescente fatos, valores, prazos ou promessas.";

/// Resposta da IA serve para o histórico externo? Mantém data, telefones e o resultado.
pub fn external_ok(base: &str, tipo: i32, texto: &str) -> bool {
    let t = texto.to_lowercase();
    let numeros_da_base: Vec<&str> = base.split(|c: char| !(c.is_ascii_digit() || matches!(c, '(' | ')' | '-' | '/' | ' ')))
        .map(str::trim).filter(|x| x.chars().filter(|c| c.is_ascii_digit()).count() >= 8).collect();
    let so_digitos = |x: &str| x.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    let texto_digitos = so_digitos(texto);
    let dados_ok = numeros_da_base.iter().all(|n| texto_digitos.contains(&so_digitos(n)));
    let resultado_ok = match tipo {
        TIPO_SEM_INTERESSE => t.contains("recus") || t.contains("não deseja") || t.contains("sem interesse"),
        TIPO_CONTATO_EFETIVO => t.contains("negociador"),
        _ => t.contains("retorno") || t.contains("resposta"),
    };
    let sem_rotulo = !t.contains("fatos") && !t.contains("resultado:") && !t.contains("finalidade:");
    dados_ok && resultado_ok && sem_rotulo && !t.contains("r$") && texto.chars().count() <= 900
}

/// Escreve o histórico externo com IA, um provedor depois do outro até um acertar.
async fn external_by_ai(db: &Arc<Database>, campaign_id: i32, base: &str, tipo: i32) -> Result<String, String> {
    let db2 = db.clone();
    let chain = tokio::task::spawn_blocking(move || {
        let company = db2.get_campaign_company_id(campaign_id).unwrap_or(1);
        let mut cfg = db2.get_ai_config(company).or_else(|| db2.get_ai_config(1)).ok_or("IA não configurada")?;
        cfg.system_prompt = EXTERNO_PROMPT.to_string();
        Ok::<_, String>(crate::dispatcher::build_ai_fallback_chain(&db2, company, &cfg))
    }).await.map_err(|e| e.to_string())??;
    let mut erros = Vec::new();
    for cfg in &chain {
        match crate::ai_engine::AiEngine::generate_message_chain(std::slice::from_ref(cfg), base, "").await {
            Ok(texto) => {
                let texto = sem_emoji(texto.split_whitespace().collect::<Vec<_>>().join(" ").trim());
                if external_ok(base, tipo, &texto) { return Ok(texto); }
                erros.push(format!("{}: texto fora do padrão", cfg.provider));
            }
            Err(e) => erros.push(e),
        }
    }
    Err(format!("Nenhuma IA escreveu o histórico externo: {}", erros.join(" | ")))
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
pub(crate) fn campaign_credor(db: &Database, campaign_id: i32) -> Result<i32, String> {
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

/// Grava um histórico no processo, uma vez só: o mesmo texto e tipo já gravados (tentativa anterior
/// que caiu no meio) só devolvem o número existente. Interno fica bloqueado; externo aparece ao credor.
pub(crate) fn insert_once(processo: i64, tipo: i32, externo: bool, texto: &str, usuario: &str) -> Result<i64, String> {
    let ext = if externo { 1 } else { 0 };
    let existente = konfiansa_query(&format!(
        "SELECT TOP 1 CodProcessoHistorico AS n FROM ProcessoHistorico WHERE CodProcesso={} AND CodProcessoHistoricoTipo={} AND HisExterno={} \
         AND CAST(DesHistorico AS varchar(max)) = CAST({} AS varchar(max))", processo, tipo, ext, texto))?;
    if let Some(n) = existente.first().and_then(|x| x.get("n")).and_then(Value::as_i64) { return Ok(n); }
    let log = format!("{} - {}", chrono::Local::now().format("%d/%m/%Y %H:%M:%S"), usuario);
    let r = konfiansa_query(&format!(
        "INSERT INTO ProcessoHistorico (CodProcesso, CodProcessoHistorico, CodProcessoHistoricoTipo, HisExterno, BloHistorico, \
         DtaHistorico, DesHistorico, UsuHistorico, LogAtualiza) \
         SELECT {p}, ISNULL(MAX(CodProcessoHistorico),0)+1, {t}, {ext}, {blo}, GETDATE(), {texto}, '{u}', '{log}' \
         FROM ProcessoHistorico WITH (UPDLOCK, HOLDLOCK) WHERE CodProcesso={p}; \
         SELECT TOP 1 CodProcessoHistorico AS n FROM ProcessoHistorico WHERE CodProcesso={p} ORDER BY CodProcessoHistorico DESC",
        p = processo, t = tipo, ext = ext, blo = 1 - ext, texto = texto, u = usuario, log = log))?;
    r.first().and_then(|x| x.get("n")).and_then(Value::as_i64)
        .ok_or_else(|| format!("Konfiansa não confirmou o histórico no processo {}.", processo))
}

/// Grava os históricos (interno e externo) nos processos do devedor. Devolve (status, processos, erro).
fn write_history(db: &Database, h: &KonfiansaHistoryRow) -> (String, String, String) {
    let credor = match campaign_credor(db, h.campaign_id) { Ok(c) => c, Err(e) => return ("erro".into(), h.processos.clone(), e) };
    let rows = match processes_for(&[h.phone.clone()], Some(credor)) { Ok(r) => r, Err(e) => return ("erro".into(), h.processos.clone(), e) };
    let alvo = pick_processes(&rows.into_iter().map(|(_, _, p)| p).collect::<Vec<_>>());
    if alvo.is_empty() {
        return ("sem_processo".into(), String::new(), format!("Telefone {} sem processo do credor {} no Konfiansa.", fmt_phone(&h.phone), credor));
    }
    let cfg = crate::config::load_config();
    // Tudo no usuário do operador no Konfiansa (o mesmo do login da ponte).
    let usuario: String = cfg.konfiansa_logon.trim().to_uppercase().chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    let usuario = if usuario.is_empty() { "AUTOMACAO".to_string() } else { usuario };
    let interno = sql_text(&sem_emoji(&h.texto));
    let externo = (!h.texto_externo.trim().is_empty() && h.tipo_externo > 0)
        .then(|| sql_text(&sem_emoji(&h.texto_externo)));
    let mut feitos: Vec<String> = Vec::new();
    for p in alvo {
        let n = match insert_once(p.processo, HISTORICO_TIPO, false, &interno, &usuario) {
            Ok(n) => n,
            Err(e) => return ("erro".into(), feitos.join(";"), e),
        };
        let mut item = format!("{}#{}", p.processo, n);
        if let Some(ext) = &externo {
            match insert_once(p.processo, h.tipo_externo, true, ext, &usuario) {
                Ok(e) => item.push_str(&format!("+ext{}", e)),
                Err(e) => return ("erro".into(), feitos.join(";"), e),
            }
        }
        feitos.push(item);
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
    #[serde(default)]
    owner: String,
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
            push_name: m.push_name, text: m.text, campaign_id: c.campaign_id, owner: m.owner,
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
            let numero = conversation_origin(&conversa, &origem);
            let (base, tipo) = build_external(&numero, motivo, &conversa);
            // Resposta já encaminhada pelo "WhatsApp retorno": ele grava o externo; aqui só a conversa.
            let ja_no_retorno = tipo == TIPO_CONTATO_EFETIVO && crate::config::load_config().retorno_negociador_enabled
                && db.return_case_exists(&key);
            // O externo é sempre escrito por IA; se nenhuma responder, tenta de novo no próximo minuto.
            let (externo, tipo) = if ja_no_retorno { (String::new(), 0) } else {
                match external_by_ai(db, conversa[0].campaign_id, &base, tipo).await {
                    Ok(t) => (t, tipo),
                    Err(e) => { eprintln!("[KONFIANSA] {}: {}", fmt_phone(&key), e); continue; }
                }
            };
            let id = db.create_konfiansa_history_full(&conversa, motivo, &build_text(&numero, &conversa), &externo, tipo)?;
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

/// Número que fez o disparo desta conversa: o da última mensagem enviada por nós; sem ele,
/// o de qualquer mensagem da conversa; por fim, o número informado pelo hub.
pub fn conversation_origin(msgs: &[WaMessageRow], fallback: &str) -> String {
    let pick = |only_mine: bool| msgs.iter().rev()
        .find(|m| (!only_mine || m.from_me) && !m.owner.trim().is_empty())
        .map(|m| m.owner.trim().to_string());
    pick(true).or_else(|| pick(false)).unwrap_or_else(|| fallback.to_string())
}

/// Telefones disparados, só dígitos com 55, sem repetição e ordenados (a lista que o robô usa).
pub fn dispatched_phone_list<'a>(phones: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = phones.filter_map(|p| {
        let d: String = p.chars().filter(|c| c.is_ascii_digit()).collect();
        let d = if (10..=11).contains(&d.len()) { format!("55{}", d) } else { d };
        ((12..=13).contains(&d.len()) && d.starts_with("55")).then_some(d)
    }).collect();
    out.sort();
    out.dedup();
    out
}

/// A impressão inclui a lista antiga, a seleção das campanhas e os vínculos; renova a cada minuto.
static DEVEDORES_PUBLICADOS: std::sync::Mutex<(u64, i64)> = std::sync::Mutex::new((0, 0));

/// Publica no hub a lista de quem o Esfera disparou. O robô da VPS só repassa à negociadora
/// respostas desses números: contato normal do celular de disparo nunca vai para ela.
async fn publish_dispatched(db: &Arc<Database>) {
    let db2 = db.clone();
    let Ok(Ok((snapshot, selection))) = tokio::task::spawn_blocking(move || {
        let mut snapshot = db2.veritas_dispatch_snapshot()?;
        let contacts = db2.dispatched_contacts()?;
        snapshot.telefones = dispatched_phone_list(contacts.values().map(|c| c.phone.as_str()));
        let selection: Vec<_> = snapshot.empresas.iter().flat_map(|id| db2.get_campaigns(*id))
            .map(|c| (c.company_id,c.id,c.return_number,c.device_ids,c.status)).collect();
        Ok::<_,String>((snapshot,selection))
    }).await else { return };
    let impressao = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let Ok(bytes) = serde_json::to_vec(&(&snapshot.empresas,&snapshot.telefones,&snapshot.vinculos,&selection)) else { return };
        bytes.hash(&mut h);
        h.finish()
    };
    let agora = chrono::Utc::now().timestamp();
    if DEVEDORES_PUBLICADOS.lock().map(|s| s.0 == impressao && agora - s.1 < 60).unwrap_or(false) {
        return;
    }
    let cfg = crate::config::load_config();
    if cfg.hub_token.trim().is_empty() { return; }
    let Ok(addr) = cfg.hub_address.trim().parse::<std::net::SocketAddr>() else { return };
    let Ok(client) = crate::hub_client::client_vps(Duration::from_secs(30)) else { return };
    let url = format!("https://{}:8443/api/desktop/evolution/devedores", addr.ip());
    match client.post(&url).bearer_auth(cfg.hub_token.trim()).json(&snapshot).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(mut s) = DEVEDORES_PUBLICADOS.lock() { *s = (impressao, agora); }
        }
        Ok(r) => {
            let status = r.status();
            let erro = r.json::<serde_json::Value>().await.ok()
                .and_then(|body| body.get("erro").and_then(|v| v.as_str()).map(|v| v.chars().take(200).collect::<String>()))
                .unwrap_or_default();
            eprintln!("[DEVEDORES] hub respondeu HTTP {} ao publicar a lista. Erro: {}", status, erro);
        }
        Err(_) => eprintln!("[DEVEDORES] Falha de comunicação ao publicar autorizações de retorno."),
    }
}

pub fn start(db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            // Vale mesmo com o histórico do Konfiansa desligado: o repasse à negociadora depende dela.
            publish_dispatched(&db).await;
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
            push_name: push.into(), text: text.into(), campaign_id: 16, owner: String::new() }
    }

    #[test]
    fn externo_fatos_por_resultado() {
        let enviada = m(1793820390, true, "Realess", "Oi");
        let resposta = m(1793820478, false, "Mel", "Quem fala?");
        let (sem, t1) = build_external("554796834632", "silencio", &[enviada.clone()]);
        assert_eq!(t1, TIPO_EM_COBRANCA);
        assert!(sem.contains("número de origem (47) 99683-4632; telefone do devedor (11) 99170-3561"), "{}", sem);
        assert!(sem.contains("não respondeu"));
        let (ret, t2) = build_external("554796834632", "silencio", &[enviada.clone(), resposta.clone()]);
        assert_eq!(t2, TIPO_CONTATO_EFETIVO);
        assert!(ret.contains("negociador responsável") && !ret.contains("Marcela"));
        let (rec, t3) = build_external("554796834632", "recusa", &[enviada, resposta]);
        assert_eq!(t3, TIPO_SEM_INTERESSE);
        assert!(rec.contains("recusou") && !rec.contains("R$"));
        let (sair, t4) = build_external("554796834632", "silencio", &[m(1, true, "R", "Oi"), m(2, false, "D", "Sair")]);
        assert_eq!(t4, TIPO_SEM_INTERESSE, "{}", sair);
    }

    #[test]
    fn resposta_da_ia_mantem_dados_e_resultado() {
        let enviada = m(1793820390, true, "Realess", "Oi");
        let (base, tipo) = build_external("554796834632", "silencio", &[enviada.clone(), m(1793820478, false, "Mel", "ok")]);
        let data = base.split("data do contato ").nth(1).unwrap().split(';').next().unwrap();
        let boa = format!("Em {}, realizamos contato com o devedor via WhatsApp, do número (47) 99683-4632 para o telefone (11) 99170-3561. O devedor retornou e o atendimento foi direcionado ao negociador responsável.", data);
        assert!(external_ok(&base, tipo, &boa), "{}", boa);
        assert!(!external_ok(&base, tipo, &base), "os fatos crus não servem");
        assert!(!external_ok(&base, tipo, "Contato por WhatsApp; houve retorno e foi ao negociador."));
        assert!(!external_ok(&base, TIPO_SEM_INTERESSE, &boa));
    }

    #[test]
    fn titulo_usa_o_numero_que_fez_o_disparo() {
        let mut a = m(1, true, "Realess", "oi");
        a.owner = "5547996271722".into();
        let mut b = m(2, false, "Mel", "ok");
        b.owner = "5547996271722".into();
        assert_eq!(conversation_origin(&[a.clone(), b], "5547999254497"), "5547996271722");
        assert_eq!(conversation_origin(&[m(1, true, "R", "oi")], "5547996834632"), "5547996834632");
        let t = build_text(&conversation_origin(&[a.clone()], ""), &[a]);
        assert!(t.starts_with("ENVIO IA REALESS de (47) 99627-1722 para"), "{}", t);
        assert_eq!(fmt_phone("554796834632"), "(47) 99683-4632");
        assert_eq!(fmt_phone("554733054406"), "(47) 3305-4406");
    }

    #[test]
    fn lista_de_disparados_so_digitos_com_55_sem_repetir() {
        let l = dispatched_phone_list(["(47) 99627-1722", "5547996271722", "4733054406", "123", "lid:999"].into_iter());
        assert_eq!(l, vec!["554733054406".to_string(), "5547996271722".to_string()]);
    }

    #[test]
    fn pontuacao_da_ia_vira_simples() {
        assert_eq!(sem_emoji("(47)\u{a0}99683\u{2011}4632 \u{201c}ok\u{201d}"), "(47) 99683-4632 \"ok\"");
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
