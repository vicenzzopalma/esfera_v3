// "WhatsApp retorno": o devedor respondeu ao disparo -> aviso ao negociador -> Konfiansa.
//
// A cada minuto (só com `retorno_negociador_enabled`):
// 1. Junta as respostas dos disparos das campanhas com retorno ligado: notificação do WhatsApp
//    no aparelho que enviou (ESF_ReplyInbound, com o texto) e mensagens da Evolution (ESF_WaMessage).
//    O retorno é da campanha: só conta se o número foi ENVIADO por ela (ver Database::return_replies).
// 2. Depois de 3 minutos sem resposta nova, acha o devedor e o processo no Konfiansa (credor da
//    campanha) e o cobrador responsável.
// 3. Negociador com nome e número em uso no CRM do VERITAS: recebe o aviso direto.
//    Carteira sem negociador (MARCELA, REGINA, vazio...): vai ao grupo da equipe, em rodízio,
//    citando de quem é a vez — SÓ para o credor da equipe (Tecnoponto). Outro credor sem
//    negociador não vai a ninguém (fica "sem_destino").
// 4. Grava no Konfiansa o histórico interno (quem recebeu + conversa) e o externo, escrito
//    pelo Qwen do Groq.
// Nada vai ao devedor. SAIR segue no descadastro. Um caso por devedor e campanha, marcado
// "enviando" antes do envio: envio interrompido vira "incerto" e nunca é repetido sozinho.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::config::AppConfig;
use crate::db::{Database, ReturnCase, ReturnReply};
use crate::konfiansa_history::{fmt_phone, sem_emoji};
use crate::veritas_crm::{normalizar, CrmChip};

/// Espera a pessoa terminar de escrever antes de encaminhar.
pub const QUIET_SECS: i64 = 180;
const POLL_SECS: u64 = 60;

// ------------------------------------------------------------------
// Regras (puras, testadas)
// ------------------------------------------------------------------

/// Horário UTC "AAAA-MM-DD HH:MM:SS" no horário de Brasília (sem horário de verão desde 2019).
pub fn brasilia(utc: &str) -> Option<chrono::NaiveDateTime> {
    let t = chrono::NaiveDateTime::parse_from_str(utc.get(..19)?, "%Y-%m-%d %H:%M:%S").ok()?;
    Some(t - chrono::Duration::hours(3))
}

/// Linhas da conversa "[09:27] texto", sem emoji e sem linha vazia.
pub fn conversa_linhas(conversa: &[(String, String)]) -> Vec<String> {
    conversa.iter().filter_map(|(em, texto)| {
        let t = sem_emoji(texto).split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() { return None; }
        let hora = brasilia(em).map(|d| d.format("%H:%M").to_string()).unwrap_or_default();
        Some(format!("[{}] {}", hora, t))
    }).collect()
}

/// CNPJ/CPF formatado com o rótulo; outro tamanho volta como veio.
pub fn documento(doc: &str) -> (String, String) {
    let d: String = doc.chars().filter(|c| c.is_ascii_digit()).collect();
    match d.len() {
        14 => ("CNPJ".into(), format!("{}.{}.{}/{}-{}", &d[..2], &d[2..5], &d[5..8], &d[8..12], &d[12..])),
        11 => ("CPF".into(), format!("{}.{}.{}-{}", &d[..3], &d[3..6], &d[6..9], &d[9..])),
        _ => ("documento".into(), doc.trim().to_string()),
    }
}

/// "TECNOPONTO TECNOLOGIA AVANCADA..." -> "Tecnoponto".
pub fn credor_curto(nome: &str) -> String {
    let w = nome.split_whitespace().next().unwrap_or("").to_lowercase();
    let mut c = w.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Uma linha da consulta do Konfiansa (processo do devedor no credor da campanha).
#[derive(Debug, Clone, PartialEq)]
pub struct KProc {
    pub processo: i64,
    pub credor: i32,
    pub credor_nome: String,
    pub devedor: i64,
    pub nome: String,
    pub doc: String,
    /// Login do cobrador (Usuario.Usuario); vazio = sem cobrador.
    pub cobrador: String,
    pub situacao: String,
    pub encerrado: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Escolha {
    /// Processos abertos de um único devedor.
    Unico(Vec<KProc>),
    Nenhum,
    /// O telefone é de mais de um devedor e o nome da campanha não desempata.
    Ambiguo(Vec<String>),
}

fn palavras(nome: &str) -> Vec<String> {
    const FORA: [&str; 14] = ["ltda", "me", "epp", "eireli", "sa", "s/a", "de", "da", "do", "das", "dos", "e", "servicos", "comercio"];
    normalizar(nome).split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() >= 3 && !FORA.contains(w)).map(str::to_string).collect()
}

/// Devedor do telefone: só processos abertos (não encerrados nem quitados). Se o telefone é de
/// mais de um devedor, vence o que divide mais palavras com o nome importado na campanha.
pub fn escolher_devedor(rows: &[KProc], contato: &str) -> Escolha {
    let abertos: Vec<&KProc> = rows.iter().filter(|p| !p.encerrado && !p.situacao.eq_ignore_ascii_case("Quitado")).collect();
    let mut por_devedor: BTreeMap<i64, Vec<KProc>> = BTreeMap::new();
    for p in abertos { por_devedor.entry(p.devedor).or_default().push(p.clone()); }
    if por_devedor.is_empty() { return Escolha::Nenhum; }
    if por_devedor.len() == 1 { return Escolha::Unico(por_devedor.into_values().next().unwrap_or_default()); }
    let alvo = palavras(contato);
    let mut notas: Vec<(usize, i64)> = por_devedor.iter()
        .map(|(d, ps)| (palavras(&ps[0].nome).iter().filter(|w| alvo.contains(w)).count(), *d)).collect();
    notas.sort_by(|a, b| b.0.cmp(&a.0));
    if notas[0].0 > 0 && notas[0].0 > notas[1].0 {
        return Escolha::Unico(por_devedor.remove(&notas[0].1).unwrap_or_default());
    }
    Escolha::Ambiguo(por_devedor.values().map(|ps| ps[0].nome.clone()).collect())
}

/// Primeiro nome do login ("ANA.SOUZA" -> "ana").
fn primeiro_nome(s: &str) -> String {
    normalizar(s).split(|c: char| c == '.' || c.is_whitespace()).next().unwrap_or("").to_string()
}

/// Números em uso no VERITAS (CRM) do negociador: chip "Em Uso" ou conectado, cujo titular
/// (ou nome, se não for RESERVA) tem o mesmo primeiro nome do login.
pub fn numeros_do_negociador(login: &str, chips: &[CrmChip]) -> Vec<String> {
    let alvo = primeiro_nome(login);
    if alvo.len() < 2 { return vec![]; }
    let mut out: Vec<String> = chips.iter().filter(|c| {
        let em_uso = normalizar(&c.status) == "em uso" || c.whatsapp_status.eq_ignore_ascii_case("CONNECTED");
        let nome = if normalizar(&c.name).starts_with("reserva") { String::new() } else { primeiro_nome(&c.name) };
        em_uso && (primeiro_nome(&c.holder) == alvo || nome == alvo)
    }).filter_map(|c| {
        let d: String = c.phone.chars().filter(|x| x.is_ascii_digit()).collect();
        let d = if matches!(d.len(), 10 | 11) { format!("55{}", d) } else { d };
        matches!(d.len(), 12 | 13).then_some(d)
    }).collect();
    out.sort();
    out.dedup();
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum Destino {
    Negociador { login: String, numeros: Vec<String> },
    Equipe,
    SemDestino(String),
}

/// Para quem vai. Negociador com nome (não está nas carteiras da equipe) e com número em uso no
/// VERITAS recebe direto. O resto vai ao grupo da equipe só se o credor for o da equipe.
pub fn decidir_destino(cobrador: &str, credor: i32, carteiras_equipe: &[String], credor_equipe: i32, chips: &[CrmChip]) -> Destino {
    let login = cobrador.trim();
    let da_equipe = login.is_empty() || carteiras_equipe.iter().any(|c| primeiro_nome(c) == primeiro_nome(login));
    if !da_equipe {
        let numeros = numeros_do_negociador(login, chips);
        if !numeros.is_empty() { return Destino::Negociador { login: login.to_string(), numeros }; }
    }
    if credor == credor_equipe { return Destino::Equipe; }
    let motivo = if login.is_empty() { "sem negociador".to_string() }
        else if da_equipe { format!("carteira {}", login) }
        else { format!("negociador {} sem número em uso no VERITAS", login) };
    Destino::SemDestino(format!("{}; credor {} não é atendido pelo grupo da equipe", motivo, credor))
}

/// Dados do caso para as mensagens.
#[derive(Debug, Clone, PartialEq)]
pub struct Aviso {
    pub empresa: String,
    pub doc: String,
    pub telefone: String,
    pub credor: String,
    pub processos: Vec<i64>,
    pub carteira: String,
    pub chip: String,
    pub conversa: Vec<String>,
    pub primeira: String,
}

/// Aviso interno (negociador ou grupo). Nada aqui vai ao devedor.
pub fn mensagem(a: &Aviso, pessoa_da_vez: Option<&str>) -> String {
    let (rot, doc) = documento(&a.doc);
    let processos = a.processos.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ");
    let carteira = if a.carteira.trim().is_empty() { "sem negociador".to_string() } else { a.carteira.trim().to_string() };
    let corpo = format!("{} ({} {}) do número {} respondeu ao disparo do {} pedindo contato. Processo {}, carteira: {}. Chip do disparo: {}. Conversa: {}",
        a.empresa.trim(), rot, doc, fmt_phone(&a.telefone), a.credor, processos, carteira, fmt_phone(&a.chip), a.conversa.join(" "));
    match pessoa_da_vez {
        Some(p) => format!("Vez de {} (rodízio da equipe). {}", p, corpo),
        None => corpo,
    }
}

/// Histórico interno: quem recebeu e a conversa.
pub fn texto_interno(a: &Aviso, para: &str) -> String {
    let quando = brasilia(&a.primeira);
    let dia = quando.map(|d| d.format("%d/%m").to_string()).unwrap_or_default();
    let hora = quando.map(|d| d.format("%H:%M").to_string()).unwrap_or_default();
    format!("Cliente respondeu ao disparo pelo número {} em {} às {}; encaminhado {}.\nConversa:\n{}",
        fmt_phone(&a.chip), dia, hora, para, a.conversa.join("\n"))
}

/// Fatos do histórico externo (o credor vê): sem nomes de funcionários, sem valores.
pub fn fatos_externo(a: &Aviso) -> String {
    let dia = brasilia(&a.primeira).map(|d| d.format("%d/%m/%Y").to_string()).unwrap_or_default();
    format!("Canal WhatsApp; data do contato {}; número de origem {}; telefone do devedor {}; o devedor respondeu ao contato de cobrança \
        feito em nome do credor {}; a solicitação foi direcionada ao negociador responsável, que dará o retorno ao devedor.",
        dia, fmt_phone(&a.chip), fmt_phone(&a.telefone), a.credor)
}

const EXTERNO_SISTEMA: &str = "Você escreve histórico externo de cobrança em português do Brasil, lido pelo credor: formal, \
terceira pessoa do plural (ex.: realizamos), um único parágrafo de duas ou três frases. Inclua exatamente a data, os números de \
telefone e o canal WhatsApp, e diga que a solicitação foi direcionada ao negociador responsável. Nunca cite valores, nunca use a \
palavra robô, não use emoji, não cite nomes de pessoas, não acrescente fatos, prazos ou promessas. Responda só com o texto.";

/// Resposta da IA serve? Regras do histórico externo + nada de "robô".
pub fn externo_ok(base: &str, texto: &str) -> bool {
    let t = normalizar(texto);
    crate::konfiansa_history::external_ok(base, crate::konfiansa_history::TIPO_CONTATO_EFETIVO, texto)
        && !t.contains("robo") && !t.contains("<think")
}

/// Tira o raciocínio que o Qwen às vezes devolve antes do texto.
pub fn sem_raciocinio(s: &str) -> String {
    let mut out = s.to_string();
    while let (Some(i), Some(j)) = (out.find("<think>"), out.find("</think>")) {
        if j < i { break; }
        out = format!("{}{}", &out[..i], &out[j + "</think>".len()..]);
    }
    sem_emoji(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------------
// Konfiansa, CRM, IA e envio (efeitos)
// ------------------------------------------------------------------

fn konfiansa_processos(phone: &str, credor: i32) -> Result<Vec<KProc>, String> {
    let nums: Vec<String> = crate::konfiansa_history::phone_variants(phone).into_iter()
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).collect();
    if nums.is_empty() { return Ok(vec![]); }
    let l = nums.iter().map(|n| format!("'{}'", n)).collect::<Vec<_>>().join(",");
    // Do Usuario só a coluna de ligação e o login (a tabela tem senhas).
    let rows = crate::konfiansa_history::konfiansa_query(&format!(
        "SELECT p.CodProcesso AS Processo, p.CodCliente AS Credor, cr.NomCliente AS CredorNome, p.CodDevedor AS Devedor, \
         dv.NomCliente AS Nome, dv.NumCpfCnpj AS Doc, ISNULL(u.Usuario,'') AS Cobrador, ISNULL(s.DesProcessoSituacao,'') AS Situacao, \
         CASE WHEN p.DtaEncerrado IS NULL THEN 0 ELSE 1 END AS Encerrado \
         FROM ClienteTelefone t JOIN Processo p ON p.CodDevedor=t.CodCliente JOIN Cliente dv ON dv.CodCliente=p.CodDevedor \
         JOIN Cliente cr ON cr.CodCliente=p.CodCliente LEFT JOIN ProcessoSituacao s ON s.CodProcessoSituacao=p.CodProcessoSituacao \
         LEFT JOIN Usuario u ON u.CodUsuario=p.CodCobrador \
         WHERE p.CodCliente={} AND (t.NumTelefoneExporta IN ({l}) OR ISNULL(t.NumDDD,'')+ISNULL(t.NumTelefone,'') IN ({l}))",
        credor, l = l))?;
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let mut out: Vec<KProc> = rows.iter().filter_map(|r| Some(KProc {
        processo: r.get("Processo")?.as_i64()?, credor: r.get("Credor")?.as_i64()? as i32, credor_nome: s(r, "CredorNome"),
        devedor: r.get("Devedor")?.as_i64()?, nome: s(r, "Nome"), doc: s(r, "Doc"), cobrador: s(r, "Cobrador"),
        situacao: s(r, "Situacao"), encerrado: r.get("Encerrado").and_then(Value::as_i64).unwrap_or(1) != 0,
    })).collect();
    out.sort_by_key(|p| p.processo);
    out.dedup_by_key(|p| p.processo);
    Ok(out)
}

async fn externo_por_ia(db: &Arc<Database>, company: i32, modelo: &str, base: &str) -> Result<String, String> {
    let db2 = db.clone();
    let (key, endpoint) = tokio::task::spawn_blocking(move || db2.get_ai_provider_key(company, "groq").or_else(|| db2.get_ai_provider_key(1, "groq")))
        .await.map_err(|e| e.to_string())?
        .map(|(k, ep, _)| (k, ep)).filter(|(k, _)| !k.trim().is_empty())
        .ok_or("Chave do Groq não configurada (Configurações > IA).")?;
    let endpoint = if endpoint.contains("groq.com") { endpoint } else { "https://api.groq.com/openai/v1/chat/completions".to_string() };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().map_err(|e| e.to_string())?;
    let corpo = serde_json::json!({"model": modelo, "temperature": 0.3, "max_tokens": 700, "messages": [
        {"role": "system", "content": EXTERNO_SISTEMA},
        {"role": "user", "content": format!("Fatos: {}\nEscreva o histórico externo para o credor.", base)}]});
    let resp = client.post(&endpoint).bearer_auth(key.trim()).json(&corpo).send().await.map_err(|_| "Groq não respondeu.".to_string())?;
    if !resp.status().is_success() { return Err(format!("Groq respondeu HTTP {}", resp.status().as_u16())); }
    let v: Value = resp.json().await.map_err(|_| "Resposta do Groq ilegível.".to_string())?;
    let texto = sem_raciocinio(v.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or(""));
    if externo_ok(base, &texto) { Ok(texto) } else { Err("texto do Groq fora do padrão do histórico externo".into()) }
}

/// Envia o aviso pela Evolution do hub (instância que está no grupo). Devolve o id da mensagem.
async fn enviar(cfg: &AppConfig, numero: &str, texto: &str) -> Result<String, String> {
    if cfg.hub_token.trim().is_empty() { return Err("Token do hub não configurado.".into()); }
    let addr: std::net::SocketAddr = cfg.hub_address.trim().parse().map_err(|_| "Endereço do hub deve ser IP:porta.".to_string())?;
    let client = crate::hub_client::client_vps(Duration::from_secs(60))?;
    let url = format!("https://{}:8443/api/desktop/retorno/enviar", addr.ip());
    let resp = client.post(&url).bearer_auth(cfg.hub_token.trim())
        .json(&serde_json::json!({"instancia": cfg.retorno_instancia.trim(), "numero": numero, "texto": texto}))
        .send().await.map_err(|_| "hub não respondeu ao envio".to_string())?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("hub respondeu HTTP {}: {}", status.as_u16(), v.get("erro").and_then(Value::as_str).unwrap_or("")));
    }
    Ok(v.get("id").and_then(Value::as_str).unwrap_or("").to_string())
}

// ------------------------------------------------------------------
// Serviço
// ------------------------------------------------------------------

/// Junta as respostas por caso (empresa, campanha, telefone) e grava/atualiza os casos.
fn coletar(db: &Database, desde: &str) -> Result<(), String> {
    let mut grupos: BTreeMap<(i32, i32, String), Vec<ReturnReply>> = BTreeMap::new();
    for r in db.return_replies(desde)? {
        grupos.entry((r.company_id, r.campaign_id, r.phone_key.clone())).or_default().push(r);
    }
    for (_, mut rs) in grupos {
        rs.sort_by(|a, b| a.received_at.cmp(&b.received_at));
        let conversa: Vec<(String, String)> = rs.iter().map(|r| (r.received_at.clone(), r.text.clone())).collect();
        let json = serde_json::to_string(&conversa).map_err(|e| e.to_string())?;
        let last = rs.last().map(|r| r.received_at.clone()).unwrap_or_default();
        db.return_case_upsert(&rs[0], &last, &json)?;
    }
    Ok(())
}

/// Decide e encaminha um caso que está aguardando.
async fn encaminhar(db: &Arc<Database>, cfg: &AppConfig, c: &ReturnCase) -> Result<(), String> {
    let conversa: Vec<(String, String)> = serde_json::from_str(&c.conversa).unwrap_or_default();
    // SAIR (ou já descadastrado): segue no descadastro, nada ao negociador.
    let primeira_ts = brasilia(&c.first_reply_at).map(|d| (d + chrono::Duration::hours(3)).and_utc().timestamp()).unwrap_or(0);
    if conversa.iter().any(|(_, t)| crate::dispatcher::local_opt_out(t)) || db.opted_out_since(&c.phone_key, primeira_ts - 86_400 * 30) {
        return db.return_case_finish(c.case_id, "sair", "");
    }
    let linhas = conversa_linhas(&conversa);
    if linhas.is_empty() { return db.return_case_finish(c.case_id, "revisar", "Resposta sem texto (mídia?): confira no aparelho."); }

    let (db2, campanha, fone) = (db.clone(), c.campaign_id, c.phone.clone());
    let (credor, rows, contato) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let credor = crate::konfiansa_history::campaign_credor(&db2, campanha)?;
        let rows = konfiansa_processos(&fone, credor)?;
        Ok((credor, rows, db2.campaign_contact_name(campanha, &Database::opt_out_key(&fone))))
    }).await.map_err(|e| e.to_string())??;
    let procs = match escolher_devedor(&rows, &contato) {
        Escolha::Unico(p) => p,
        Escolha::Nenhum => return db.return_case_finish(c.case_id, "sem_processo", &format!("Telefone sem processo aberto no credor {}.", credor)),
        Escolha::Ambiguo(nomes) => return db.return_case_finish(c.case_id, "revisar", &format!("Telefone de mais de um devedor: {}.", nomes.join(" / "))),
    };
    let cobrador = procs.iter().map(|p| p.cobrador.clone()).find(|x| !x.is_empty()).unwrap_or_default();
    let chips = crate::veritas_crm::fetch_chips(&cfg.crm_base_url, false).await?;
    let destino = decidir_destino(&cobrador, credor, &cfg.retorno_carteiras_equipe, cfg.retorno_credor_equipe, &chips);
    let aviso = Aviso {
        empresa: procs[0].nome.clone(), doc: procs[0].doc.clone(), telefone: c.phone.clone(), credor: credor_curto(&procs[0].credor_nome),
        processos: procs.iter().map(|p| p.processo).collect(), carteira: cobrador.clone(), chip: c.source.clone(),
        conversa: linhas, primeira: c.first_reply_at.clone(),
    };
    let processos = aviso.processos.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let (rotulo, pessoa, numeros, texto, para) = match destino {
        Destino::SemDestino(m) => return db.return_case_finish(c.case_id, "sem_destino", &m),
        Destino::Negociador { login, numeros } => {
            let para = format!("ao negociador {}", login);
            ("negociador", login, numeros, mensagem(&aviso, None), para)
        }
        Destino::Equipe => {
            if cfg.retorno_grupo.trim().is_empty() || cfg.retorno_rodizio.is_empty() {
                return Err("Grupo da equipe ou rodízio não configurado (retorno_grupo, retorno_rodizio).".into());
            }
            let n = cfg.retorno_rodizio.len();
            let pos = db.return_rotation_next(&credor.to_string(), n)?;
            let pessoa = cfg.retorno_rodizio[pos].trim().to_string();
            let para = format!("ao {} (vez de {})", cfg.retorno_grupo_nome.trim(), pessoa);
            ("equipe", pessoa.clone(), vec![cfg.retorno_grupo.trim().to_string()], mensagem(&aviso, Some(&pessoa)), para)
        }
    };
    if cfg.retorno_instancia.trim().is_empty() { return Err("Instância de envio não configurada (retorno_instancia).".into()); }
    if !db.return_case_claim(c.case_id, rotulo, &pessoa, &numeros.join(","), &processos, &texto)? { return Ok(()); }
    let mut ids = Vec::new();
    for n in &numeros {
        match enviar(cfg, n, &texto).await {
            Ok(id) => ids.push(id),
            Err(e) => {
                // Pode ter saído (timeout) ou ter ido a parte dos números: o operador confere.
                return db.return_case_finish(c.case_id, "incerto", &format!("Envio para {} falhou ({}); {} de {} enviados.", n, e, ids.len(), numeros.len()));
            }
        }
    }
    println!("[RETORNO] {} -> {} ({}).", fmt_phone(&c.phone), rotulo, pessoa);
    db.return_case_sent(c.case_id, &ids.join(","), &texto_interno(&aviso, &para))
}

/// Grava o interno e o externo nos processos do caso encaminhado (uma vez cada).
async fn gravar_historicos(db: &Arc<Database>, cfg: &AppConfig, c: &ReturnCase) -> Result<(), String> {
    let processos: Vec<i64> = c.processos.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    if processos.is_empty() { return db.return_case_finish(c.case_id, "gravado", "Sem processo para o histórico."); }
    let externo = if c.externo.trim().is_empty() {
        let conversa: Vec<(String, String)> = serde_json::from_str(&c.conversa).unwrap_or_default();
        let aviso = Aviso { empresa: String::new(), doc: String::new(), telefone: c.phone.clone(), credor: credor_do_texto(&c.mensagem),
            processos: processos.clone(), carteira: String::new(), chip: c.source.clone(), conversa: conversa_linhas(&conversa),
            primeira: c.first_reply_at.clone() };
        externo_por_ia(db, c.company_id, &cfg.retorno_ia_modelo, &fatos_externo(&aviso)).await?
    } else { c.externo.clone() };
    let (interno, ext, gravados) = (c.interno.clone(), externo.clone(), c.gravados.clone());
    let feitos = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let usuario: String = crate::config::load_config().konfiansa_logon.trim().to_uppercase().chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
        let usuario = if usuario.is_empty() { "AUTOMACAO".to_string() } else { usuario };
        let mut feitos: Vec<String> = gravados.split(';').filter(|x| !x.is_empty()).map(str::to_string).collect();
        for p in processos {
            if feitos.iter().any(|f| f.starts_with(&format!("{}#", p))) { continue; }
            let i = crate::konfiansa_history::insert_once(p, crate::konfiansa_history::HISTORICO_TIPO, false,
                &crate::konfiansa_history::sql_text(&sem_emoji(&interno)), &usuario)?;
            let e = crate::konfiansa_history::insert_once(p, crate::konfiansa_history::TIPO_CONTATO_EFETIVO, true,
                &crate::konfiansa_history::sql_text(&sem_emoji(&ext)), &usuario)?;
            feitos.push(format!("{}#{}+ext{}", p, i, e));
        }
        Ok(feitos.join(";"))
    }).await.map_err(|e| e.to_string())?;
    match feitos {
        Ok(g) => db.return_case_history(c.case_id, &externo, &g, "gravado"),
        Err(e) => { db.return_case_history(c.case_id, &externo, &c.gravados, "encaminhado")?; Err(e) }
    }
}

/// O credor curto já está no aviso enviado ("... respondeu ao disparo do Tecnoponto pedindo ...").
fn credor_do_texto(msg: &str) -> String {
    msg.split("respondeu ao disparo do ").nth(1).and_then(|r| r.split(" pedindo contato").next()).unwrap_or("").trim().to_string()
}

async fn tick(db: &Arc<Database>) -> Result<(), String> {
    let mut cfg = crate::config::load_config();
    if !cfg.retorno_negociador_enabled { return Ok(()); }
    if cfg.retorno_desde.trim().is_empty() {
        // Primeira vez ligado: só o que chegar daqui em diante (o que veio antes já foi tratado à mão).
        cfg.retorno_desde = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        crate::config::save_config(&cfg)?;
    }
    let (db2, desde) = (db.clone(), cfg.retorno_desde.clone());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        db2.return_cases_mark_uncertain()?;
        coletar(&db2, &desde)
    }).await.map_err(|e| e.to_string())??;
    for c in db.return_cases_due(QUIET_SECS)? {
        let r = if c.status == "aguardando" { encaminhar(db, &cfg, &c).await } else { gravar_historicos(db, &cfg, &c).await };
        if let Err(e) = r {
            eprintln!("[RETORNO] Caso {} ({}): {}", c.case_id, fmt_phone(&c.phone), e);
            db.return_case_retry(c.case_id, &e)?;
        }
    }
    Ok(())
}

pub fn start(db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if let Err(e) = tick(&db).await { eprintln!("[RETORNO] {}", e); }
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chip(phone: &str, name: &str, holder: &str, status: &str, wa: &str) -> CrmChip {
        CrmChip { id: 1, phone: phone.into(), name: name.into(), status: status.into(), holder: holder.into(), device_name: "7".into(),
            sector: "Junior".into(), restricted_until: String::new(), alarm_active: false, whatsapp_status: wa.into(),
            whatsapp_name: String::new(), whatsapp_last_seen: String::new() }
    }

    fn kp(processo: i64, credor: i32, devedor: i64, nome: &str, cobrador: &str, encerrado: bool) -> KProc {
        KProc { processo, credor, credor_nome: "TECNOPONTO TECNOLOGIA AVANCADA EM CONTROLE DE PONTO E ACESSO LTDA".into(), devedor,
            nome: nome.into(), doc: "11222333000181".into(), cobrador: cobrador.into(), situacao: "EM COBRANÇA".into(), encerrado }
    }

    fn equipe() -> Vec<String> { vec!["MARCELA".into(), "REGINA".into()] }

    /// Caso real de 11/11 (devedor e números trocados por fictícios): chip RESERVA 0366, aparelho 22, 09:27.
    fn caso_real() -> (Vec<(String, String)>, Vec<KProc>) {
        let conversa = vec![("2026-11-11 12:27:23".to_string(), "De onde".to_string()),
                            ("2026-11-11 12:27:36".to_string(), "Qual empresa vcs representam".to_string())];
        // O mesmo telefone está em dois devedores do Tecnoponto; a campanha importou "ALFA CAES DE SEGURANCA".
        let rows = vec![kp(2400000001, 598, 23690, "ALFA SERVICOS LTDA", "REGINA", false),
                        kp(2400000002, 598, 43797, "BETA SERVICOS LTDA", "", false),
                        kp(2400000003, 595, 43797, "BETA SERVICOS LTDA", "", true)];
        (conversa, rows)
    }

    #[test]
    fn caso_real_carteira_regina_vai_ao_grupo_na_vez_da_pessoa() {
        let (conversa, rows) = caso_real();
        let Escolha::Unico(procs) = escolher_devedor(&rows, "ALFA CAES DE SEGURANCA") else { panic!("devedor") };
        assert_eq!(procs.iter().map(|p| p.processo).collect::<Vec<_>>(), vec![2400000001]);
        assert_eq!(decidir_destino(&procs[0].cobrador, 598, &equipe(), 598, &[]), Destino::Equipe);
        let aviso = Aviso { empresa: procs[0].nome.clone(), doc: procs[0].doc.clone(), telefone: "5527999990001".into(),
            credor: credor_curto(&procs[0].credor_nome), processos: vec![2400000001], carteira: "REGINA".into(),
            chip: "554799990366".into(), conversa: conversa_linhas(&conversa), primeira: conversa[0].0.clone() };
        assert_eq!(mensagem(&aviso, Some("Pessoa A")),
            "Vez de Pessoa A (rodízio da equipe). ALFA SERVICOS LTDA (CNPJ 11.222.333/0001-81) do número (27) 99999-0001 \
respondeu ao disparo do Tecnoponto pedindo contato. Processo 2400000001, carteira: REGINA. Chip do disparo: (47) 99999-0366. \
Conversa: [09:27] De onde [09:27] Qual empresa vcs representam");
        assert_eq!(texto_interno(&aviso, "ao grupo da equipe (vez de Pessoa A)"),
            "Cliente respondeu ao disparo pelo número (47) 99999-0366 em 11/11 às 09:27; encaminhado ao grupo da equipe (vez de Pessoa A).\n\
Conversa:\n[09:27] De onde\n[09:27] Qual empresa vcs representam");
        let fatos = fatos_externo(&aviso);
        assert!(fatos.contains("11/11/2026") && fatos.contains("(27) 99999-0001") && fatos.contains("(47) 99999-0366") && fatos.contains("Tecnoponto"), "{}", fatos);
        assert!(!fatos.contains("REGINA") && !fatos.contains("Pessoa"));
        assert_eq!(credor_do_texto(&mensagem(&aviso, None)), "Tecnoponto");
    }

    #[test]
    fn outro_credor_sem_negociador_nunca_vai_ao_grupo_da_equipe() {
        // OUTRO CREDOR (credor que não é o Tecnoponto): carteira vazia ou da equipe -> ninguém.
        assert!(matches!(decidir_destino("", 132754, &equipe(), 598, &[]), Destino::SemDestino(_)));
        assert!(matches!(decidir_destino("MARCELA", 132754, &equipe(), 598, &[]), Destino::SemDestino(_)));
        assert!(matches!(decidir_destino("IA REALESS", 132754, &equipe(), 598, &[]), Destino::SemDestino(_)));
        // Tecnoponto sem negociador vai ao grupo.
        assert_eq!(decidir_destino("", 598, &equipe(), 598, &[]), Destino::Equipe);
    }

    #[test]
    fn negociador_com_nome_recebe_nos_numeros_em_uso_no_veritas() {
        let chips = vec![
            chip("47999990101", "RESERVA", "Ana Souza", "Em Uso", ""),
            chip("47999990102", "Ana", "", "Livre", "CONNECTED"),
            chip("47999990103", "Ana", "", "Livre", "DISCONNECTED"),
            chip("47999990104", "RESERVA", "Bia Lima", "Em Uso", ""),
        ];
        assert_eq!(decidir_destino("ANA.SOUZA", 598, &equipe(), 598, &chips),
            Destino::Negociador { login: "ANA.SOUZA".into(), numeros: vec!["5547999990101".into(), "5547999990102".into()] });
        // Vale para outro credor também: o negociador nomeado atende a carteira dele.
        assert!(matches!(decidir_destino("ANA.SOUZA", 132754, &equipe(), 598, &chips), Destino::Negociador { .. }));
        // Negociador sem número em uso: Tecnoponto vai ao grupo; outro credor, a ninguém.
        assert_eq!(decidir_destino("JOAO.SILVA", 598, &equipe(), 598, &chips), Destino::Equipe);
        assert!(matches!(decidir_destino("JOAO.SILVA", 132754, &equipe(), 598, &chips), Destino::SemDestino(_)));
        // Carteira da equipe nunca é tratada como negociador, mesmo com chip no nome.
        let regina = vec![chip("47999990105", "Regina", "Regina", "Em Uso", "CONNECTED")];
        assert_eq!(decidir_destino("REGINA", 598, &equipe(), 598, &regina), Destino::Equipe);
    }

    #[test]
    fn devedor_ambiguo_ou_sem_processo_aberto_nao_encaminha() {
        let (_, rows) = caso_real();
        assert!(matches!(escolher_devedor(&rows, "FULANO"), Escolha::Ambiguo(_)));
        assert!(matches!(escolher_devedor(&rows, ""), Escolha::Ambiguo(_)));
        assert_eq!(escolher_devedor(&[kp(1, 598, 1, "X LTDA", "", true)], "X"), Escolha::Nenhum);
        let mut quitado = kp(2, 598, 1, "X LTDA", "", false);
        quitado.situacao = "Quitado".into();
        assert_eq!(escolher_devedor(&[quitado], "X"), Escolha::Nenhum);
        assert!(matches!(escolher_devedor(&rows[1..], "QUALQUER"), Escolha::Unico(_)), "um devedor só não precisa do nome");
    }

    #[test]
    fn documento_horario_e_ia() {
        assert_eq!(documento("43625143844"), ("CPF".to_string(), "436.251.438-44".to_string()));
        assert_eq!(brasilia("2026-11-11 12:27:23").unwrap().format("%d/%m %H:%M").to_string(), "11/11 09:27");
        assert_eq!(brasilia("2026-11-11 01:00:00").unwrap().format("%d/%m %H:%M").to_string(), "10/11 22:00");
        assert_eq!(sem_raciocinio("<think>pensando</think> Em 11/11/2026 realizamos 😀 contato."), "Em 11/11/2026 realizamos contato.");
        let base = "Canal WhatsApp; data do contato 11/11/2026; número de origem (47) 99999-0366; telefone do devedor (27) 99999-0001; ...";
        let bom = "Em 11/11/2026, o devedor respondeu pelo WhatsApp, do telefone (27) 99999-0001 ao número (47) 99999-0366; a solicitação foi direcionada ao negociador responsável.";
        assert!(externo_ok(base, bom));
        assert!(!externo_ok(base, &bom.replace("negociador responsável", "robô")));
        assert!(!externo_ok(base, "O devedor respondeu e foi ao negociador."), "sem data e telefones não serve");
        assert!(crate::dispatcher::local_opt_out("SAIR") && !crate::dispatcher::local_opt_out("Qual empresa vcs representam"));
    }
}
