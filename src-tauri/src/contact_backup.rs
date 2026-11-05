// ============================================================
// Esfera v3 — Cópia de segurança dos contatos dos celulares
// Lê a agenda do aparelho pelo ADB, guarda no banco (nunca apaga)
// e recria no aparelho os contatos que sumiram. Os temporários
// "Esfera <número>" do disparo não entram na cópia.
// ============================================================

use crate::adb_manager::AdbManager;
use crate::db::{ContactBackupRow, ContactSnapshotSummary, Database, Device};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

const NAME_MIME: &str = "vnd.android.cursor.item/name";
const PHONE_MIME: &str = "vnd.android.cursor.item/phone_v2";
const GOOGLE_TYPE: &str = "com.google";
/// Cópia automática de cada aparelho online.
const SNAPSHOT_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Aparelho que reconecta toda hora não é copiado a cada volta.
const REAPPEAR_MIN_GAP: Duration = Duration::from_secs(30 * 60);
/// Nova tentativa depois de uma cópia que falhou.
const RETRY_AFTER: Duration = Duration::from_secs(15 * 60);
/// Agenda grande demora a sair pelo ADB.
const QUERY_TIMEOUT_SECS: u64 = 90;
const SHELL_TIMEOUT_SECS: u64 = 15;
/// Limite por pedido de restauração (cada contato leva alguns comandos no aparelho).
pub const MAX_RESTORE_PER_CALL: usize = 300;

/// Colunas lidas, nesta ordem. O nome fica por último: vírgula no nome não quebra a leitura.
const RAW_COLUMNS: [&str; 5] = ["_id", "deleted", "account_type", "account_name", "display_name"];
const DATA_COLUMNS: [&str; 3] = ["raw_contact_id", "mimetype", "data1"];

/// Uma cópia por vez (laço automático, botão e limpeza dividem a mesma vez).
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());
/// Uma restauração por vez.
static RESTORE_LOCK: Mutex<()> = Mutex::new(());

// ============================================================
// Contato lido do aparelho
// ============================================================

/// Um contato da agenda do aparelho (já sem os temporários "Esfera <número>").
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceContact {
    pub raw_contact_id: i64,
    pub display_name: String,
    /// Como estavam no aparelho.
    pub phones: Vec<String>,
    /// Os mesmos telefones, só dígitos.
    pub phone_digits: Vec<String>,
    pub account_name: String,
    pub account_type: String,
}

impl DeviceContact {
    /// Identidade do contato entre uma cópia e outra: nome + telefones. A conta não entra,
    /// para o contato restaurado em outra conta voltar a ser o mesmo da cópia.
    pub fn key(&self) -> String {
        let mut phones: Vec<String> = self.phone_digits.iter().map(|d| national_digits(d)).filter(|d| !d.is_empty()).collect();
        phones.sort();
        phones.dedup();
        format!("{}|{}", normalize_name(&self.display_name), phones.join(","))
    }
}

fn normalize_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn digits(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Só dígitos, sem zeros à esquerda e sem o 55 do Brasil:
/// "+55 (47) 3305-4406" e "4733054406" são o mesmo número.
pub fn national_digits(phone: &str) -> String {
    let all = digits(phone);
    let d = all.trim_start_matches('0');
    if (d.len() == 12 || d.len() == 13) && d.starts_with("55") { d[2..].to_string() } else { d.to_string() }
}

/// Quebra de linha e tabulação viram espaço (o valor vai numa linha de comando).
fn clean_value(value: &str) -> String {
    value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

/// "Esfera " + 10 a 13 dígitos: contato temporário do disparo (mesma regra da limpeza).
pub fn is_esfera_temp_name(name: &str) -> bool {
    name.trim().strip_prefix("Esfera ").is_some_and(|d| (10..=13).contains(&d.len()) && d.chars().all(|c| c.is_ascii_digit()))
}

/// Contas que os apps de mensagem mantêm sozinhos (cópias dos contatos de verdade).
fn is_app_synced_account(account_type: &str) -> bool {
    matches!(
        account_type,
        "com.whatsapp" | "com.whatsapp.w4b" | "org.telegram.messenger" | "org.telegram.messenger.web" | "com.viber.voip"
            | "org.thoughtcrime.securesms" | "com.google.android.apps.tachyon" | "com.skype.contacts.sync"
    )
}

fn is_esfera_account(account_name: &str, account_type: &str) -> bool {
    account_type == AdbManager::ESFERA_TEMP_CONTACT_ACCOUNT_TYPE || account_name == AdbManager::ESFERA_TEMP_CONTACT_ACCOUNT_NAME
}

/// Nome da conta de origem para o operador.
pub fn account_label(account_name: &str, account_type: &str) -> String {
    if account_type == GOOGLE_TYPE {
        return if account_name.is_empty() { "Google".into() } else { format!("Google ({})", account_name) };
    }
    if is_esfera_account(account_name, account_type) { return "Conta do Esfera (esfera_temp)".into(); }
    let t = account_type.to_lowercase();
    if t.contains("sim") || t.contains("icc") { return "Chip (SIM)".into(); }
    if t.is_empty() || t.contains("phone") || t.contains("local") || t.contains("device") { return "Aparelho (local)".into(); }
    if account_name.is_empty() { account_type.to_string() } else { format!("{} ({})", account_type, account_name) }
}

/// Qual conta vale mais quando o mesmo contato está em duas: Google, local, chip, outras, Esfera.
fn account_rank(account_name: &str, account_type: &str) -> u8 {
    if account_type == GOOGLE_TYPE { return 0; }
    if is_esfera_account(account_name, account_type) { return 4; }
    match account_label(account_name, account_type).as_str() {
        "Aparelho (local)" => 1,
        "Chip (SIM)" => 2,
        _ => 3,
    }
}

// ============================================================
// Leitura do `content query`
// ============================================================

/// Linhas "Row: N col=valor, col=valor" de um `content query` com projeção conhecida, na ordem da
/// projeção. O valor vai até ", <próxima coluna>="; a última coluna vai até o fim da linha. Linha
/// que não começa com "Row:" continua o valor anterior. Saída vazia ou de erro é erro: nunca vira
/// "agenda vazia" (senão todos os contatos seriam marcados como sumidos).
pub fn parse_query_rows(output: &str, columns: &[&str]) -> Result<Vec<Vec<String>>, String> {
    let text = output.replace("\r\n", "\n");
    let trimmed = text.trim();
    if trimmed.is_empty() { return Err("O aparelho não devolveu a agenda".into()); }
    let mut records: Vec<String> = Vec::new();
    let mut no_result = false;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("Row: ") {
            let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
            records.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        } else if let Some(last) = records.last_mut() {
            last.push('\n');
            last.push_str(line);
        } else if line.trim().is_empty() {
            continue;
        } else if line.trim() == "No result found." {
            no_result = true;
        } else {
            return Err(format!("Resposta inesperada do aparelho: {}", line.trim().chars().take(160).collect::<String>()));
        }
    }
    if records.is_empty() && !no_result { return Err("O aparelho não devolveu a agenda".into()); }
    records.iter().map(|r| split_row(r, columns)).collect()
}

fn split_row(record: &str, columns: &[&str]) -> Result<Vec<String>, String> {
    let bad = || format!("Linha da agenda fora do formato esperado: {}", record.chars().take(160).collect::<String>());
    let mut values = Vec::with_capacity(columns.len());
    let mut rest = record;
    for (i, col) in columns.iter().enumerate() {
        rest = rest.strip_prefix(format!("{}=", col).as_str()).ok_or_else(bad)?;
        let value = match columns.get(i + 1) {
            Some(next) => {
                let at = rest.find(format!(", {}=", next).as_str()).ok_or_else(bad)?;
                let v = &rest[..at];
                rest = &rest[at + 2..];
                v
            }
            None => std::mem::take(&mut rest),
        };
        let v = value.trim();
        values.push(if v == "NULL" { String::new() } else { v.to_string() });
    }
    Ok(values)
}

pub fn raw_contacts_query() -> String {
    format!("content query --uri content://com.android.contacts/raw_contacts --projection {}", RAW_COLUMNS.join(":"))
}

pub fn contact_data_query() -> String {
    format!(
        "content query --uri content://com.android.contacts/data --projection {} --where \"mimetype IN ('{}','{}')\"",
        DATA_COLUMNS.join(":"), NAME_MIME, PHONE_MIME
    )
}

/// Junta raw_contacts + data em contatos. Ficam de fora: apagados (aguardando sincronizar),
/// contas dos apps de mensagem, contatos sem telefone e os "Esfera <número>" do disparo.
/// O mesmo contato em duas contas vira um só (vale a conta Google, depois a local...).
pub fn build_contacts(raw_out: &str, data_out: &str) -> Result<Vec<DeviceContact>, String> {
    let raws = parse_query_rows(raw_out, &RAW_COLUMNS)?;
    let data = parse_query_rows(data_out, &DATA_COLUMNS)?;
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut phones: HashMap<i64, Vec<String>> = HashMap::new();
    for row in &data {
        let Ok(id) = row[0].parse::<i64>() else { continue };
        let value = clean_value(&row[2]);
        if value.is_empty() { continue; }
        match row[1].as_str() {
            NAME_MIME => { names.entry(id).or_insert(value); }
            PHONE_MIME => {
                let list = phones.entry(id).or_default();
                if !list.contains(&value) { list.push(value); }
            }
            _ => {}
        }
    }
    let mut by_key: HashMap<String, DeviceContact> = HashMap::new();
    for row in &raws {
        let Ok(id) = row[0].parse::<i64>() else { continue };
        if row[1] == "1" { continue; }
        let (account_type, account_name) = (row[2].clone(), row[3].clone());
        if is_app_synced_account(&account_type) { continue; }
        let Some(list) = phones.get(&id) else { continue };
        // Sem linha de nome, vale o nome exibido, a não ser que ele seja só o próprio telefone.
        let name = names.get(&id).cloned().unwrap_or_else(|| {
            let shown = clean_value(&row[4]);
            if !shown.is_empty() && list.iter().any(|p| digits(p) == digits(&shown)) { String::new() } else { shown }
        });
        if is_esfera_temp_name(&name) { continue; }
        let contact = DeviceContact {
            raw_contact_id: id,
            display_name: name,
            phones: list.clone(),
            phone_digits: list.iter().map(|p| digits(p)).collect(),
            account_name,
            account_type,
        };
        let key = contact.key();
        let keep_old = by_key.get(&key).is_some_and(|old| {
            account_rank(&old.account_name, &old.account_type) <= account_rank(&contact.account_name, &contact.account_type)
        });
        if !keep_old { by_key.insert(key, contact); }
    }
    let mut list: Vec<DeviceContact> = by_key.into_values().collect();
    list.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()).then(a.raw_contact_id.cmp(&b.raw_contact_id)));
    Ok(list)
}

/// Lê a agenda inteira por um shell qualquer (o aparelho, ou um simulado nos testes). Só leitura.
pub fn read_device_contacts(shell: &mut dyn FnMut(&str) -> Result<String, String>) -> Result<Vec<DeviceContact>, String> {
    let raw = shell(&raw_contacts_query())?;
    let data = shell(&contact_data_query())?;
    build_contacts(&raw, &data)
}

// ============================================================
// Cópia para o banco
// ============================================================

fn db_now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_online(status: &str) -> bool {
    status == "online" || status == "online_agent"
}

/// Chaves da cópia de um aparelho: a identidade do Esfera primeiro, depois a do serial.
pub fn device_keys(device: &Device) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = device.esfera_device_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        keys.push(id.to_string());
    }
    keys.push(format!("serial:{}", device.serial));
    keys
}

/// Endereço para falar com o aparelho agora (o ADB atual quando há, senão o serial).
pub fn device_serial(device: &Device) -> String {
    device.current_adb_address.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| device.serial.clone())
}

struct BackupTarget {
    key: String,
    legacy_key: String,
    company_id: i32,
    name: String,
}

fn resolve_backup_target(db: &Database, serial: &str) -> BackupTarget {
    let found = db.get_all_devices().into_iter().find(|d| {
        d.serial == serial || d.current_adb_address.as_deref() == Some(serial) || d.esfera_device_id.as_deref() == Some(serial)
    });
    match found {
        Some(d) => {
            let keys = device_keys(&d);
            BackupTarget {
                key: keys[0].clone(),
                legacy_key: keys[keys.len() - 1].clone(),
                company_id: d.company_id,
                name: if d.name.trim().is_empty() { d.serial.clone() } else { d.name.clone() },
            }
        }
        None => {
            // Aparelho fora do cadastro: a identidade gravada nele (só leitura), senão o serial.
            let legacy = format!("serial:{}", serial);
            let key = AdbManager::get_persistent_device_id(serial).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| legacy.clone());
            BackupTarget { key, legacy_key: legacy, company_id: 0, name: serial.to_string() }
        }
    }
}

/// Copia agora os contatos do aparelho para o banco. Chamar SEMPRE antes de limpar os contatos
/// temporários. Devolve quantos contatos o aparelho tem (sem os "Esfera <número>").
pub fn snapshot_device_contacts(db: &Database, serial: &str) -> Result<usize, String> {
    take_snapshot(db, serial, "antes da limpeza").map(|s| s.total)
}

/// Lê a agenda do aparelho e grava a cópia. Só lê o aparelho.
pub fn take_snapshot(db: &Database, serial: &str, reason: &str) -> Result<ContactSnapshotSummary, String> {
    let serial = serial.trim();
    if serial.is_empty() { return Err("Informe o aparelho".into()); }
    let _vez = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = resolve_backup_target(db, serial);
    let contacts = read_device_contacts(&mut |cmd| AdbManager::execute_shell(serial, cmd, QUERY_TIMEOUT_SECS))?;
    let summary = db.apply_contact_snapshot(&target.key, &target.legacy_key, target.company_id, serial, reason, &contacts, &db_now())?;
    println!(
        "[CONTATOS] Cópia de {} ({}): {} contatos, {} novos, {} sumiram, {} voltaram.",
        target.name, reason, summary.total, summary.added, summary.vanished, summary.returned
    );
    if summary.vanished > 0 {
        db.queue_add_log(
            target.company_id,
            "warning",
            "Contatos",
            &format!(
                "{} contato(s) sumiram do aparelho {} desde a última cópia. Eles continuam guardados na cópia de segurança (Configurações do aparelho > Contatos).",
                summary.vanished, target.name
            ),
        );
    }
    Ok(summary)
}

/// Hora de copiar? Nunca copiado: sim. Cópia boa: 6 horas depois, ou ao voltar a aparecer
/// online depois de 30 minutos. Cópia que falhou: 15 minutos depois, ou ao voltar a aparecer.
fn snapshot_due(last: Option<(Duration, bool)>, appeared: bool) -> bool {
    match last {
        None => true,
        Some((since, true)) => since >= SNAPSHOT_EVERY || (appeared && since >= REAPPEAR_MIN_GAP),
        Some((since, false)) => since >= RETRY_AFTER || (appeared && since >= Duration::from_secs(120)),
    }
}

/// Laço em segundo plano: copia cada aparelho ao aparecer online e a cada 6 horas.
/// Um aparelho por vez, numa thread própria (não trava o app nem o disparo).
pub fn start(db: Arc<Database>) {
    let spawned = std::thread::Builder::new().name("esfera-contatos".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(90));
        let mut last: HashMap<String, (Instant, bool)> = HashMap::new();
        let mut online_before: HashSet<String> = HashSet::new();
        loop {
            let mut online_now = HashSet::new();
            for device in db.get_all_devices().into_iter().filter(|d| is_online(&d.status)) {
                let key = device_keys(&device).remove(0);
                online_now.insert(key.clone());
                let appeared = !online_before.contains(&key);
                if !snapshot_due(last.get(&key).map(|(at, ok)| (at.elapsed(), *ok)), appeared) { continue; }
                let serial = device_serial(&device);
                let result = take_snapshot(&db, &serial, "automática");
                if let Err(ref e) = result { eprintln!("[CONTATOS] Cópia de {} falhou: {}", serial, e); }
                last.insert(key, (Instant::now(), result.is_ok()));
            }
            online_before = online_now;
            std::thread::sleep(Duration::from_secs(60));
        }
    });
    if let Err(e) = spawned { eprintln!("[CONTATOS] Não foi possível iniciar a cópia automática: {}", e); }
}

// ============================================================
// Tela: lista, totais e planilha
// ============================================================

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactBackupView {
    pub device_key: String,
    pub total: usize,
    pub present: usize,
    pub missing: usize,
    pub last_snapshot_at: Option<String>,
    pub last_snapshot_reason: Option<String>,
    pub contacts: Vec<ContactBackupRow>,
}

/// Final do número (8 dígitos) para achar o mesmo telefone salvo de outro jeito.
fn phone_tail(d: &str) -> String {
    let n = national_digits(d);
    if n.len() >= 8 { n[n.len() - 8..].to_string() } else { String::new() }
}

/// Para cada contato que sumiu, o nome de um contato ainda no aparelho com o mesmo número.
fn mark_same_phone(rows: &mut [ContactBackupRow]) {
    let mut present: HashMap<String, String> = HashMap::new();
    for r in rows.iter().filter(|r| r.vanished_at.is_none()) {
        for d in &r.phone_digits {
            let tail = phone_tail(d);
            if !tail.is_empty() { present.entry(tail).or_insert_with(|| r.display_name.clone()); }
        }
    }
    for r in rows.iter_mut().filter(|r| r.vanished_at.is_some()) {
        r.same_phone_on_device = r.phone_digits.iter().find_map(|d| present.get(&phone_tail(d)).cloned());
    }
}

pub fn backup_view(db: &Database, device: &Device, only_missing: bool) -> Result<ContactBackupView, String> {
    let keys = device_keys(device);
    let mut rows = db.list_contact_backup(&keys)?;
    mark_same_phone(&mut rows);
    let total = rows.len();
    let missing = rows.iter().filter(|r| r.vanished_at.is_some()).count();
    if only_missing { rows.retain(|r| r.vanished_at.is_some()); }
    let last = db.last_contact_snapshot(&keys);
    Ok(ContactBackupView {
        device_key: keys[0].clone(),
        total,
        present: total - missing,
        missing,
        last_snapshot_at: last.as_ref().map(|l| l.0.clone()),
        last_snapshot_reason: last.map(|l| l.1),
        contacts: rows,
    })
}

/// Data do banco (UTC) no horário daqui, para a planilha.
fn local_date(value: &str) -> String {
    use chrono::TimeZone;
    match chrono::NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%d %H:%M:%S") {
        Ok(n) => chrono::Utc.from_utc_datetime(&n).with_timezone(&chrono::Local).format("%d/%m/%Y %H:%M").to_string(),
        Err(_) => value.to_string(),
    }
}

/// Célula para o Excel brasileiro: entre aspas; começo = + - @ ganha apóstrofo (não vira fórmula).
fn csv_cell(value: &str) -> String {
    let v = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{}", value) } else { value.to_string() };
    format!("\"{}\"", v.replace('"', "\"\""))
}

/// Planilha (separador ";"): nome, telefones, conta, visto por último, sumiu em.
pub fn backup_csv(rows: &[ContactBackupRow]) -> String {
    let mut lines = vec![["Nome", "Telefones", "Conta", "Visto por último", "Sumiu do aparelho em"].map(csv_cell).join(";")];
    for r in rows {
        let cells = [
            r.display_name.clone(),
            r.phones.join(" / "),
            r.account_label.clone(),
            local_date(&r.last_seen_at),
            r.vanished_at.as_deref().map(local_date).unwrap_or_default(),
        ];
        lines.push(cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(";"));
    }
    lines.join("\r\n")
}

// ============================================================
// Restauração no aparelho (nunca apaga nada no aparelho)
// ============================================================

/// Conta onde recriar os contatos.
#[derive(Debug, Clone, PartialEq)]
pub enum TargetAccount {
    Google(String),
    Local,
}

impl TargetAccount {
    pub fn label(&self) -> String {
        match self {
            TargetAccount::Google(name) => format!("Google ({})", name),
            TargetAccount::Local => "Aparelho (local)".into(),
        }
    }
}

pub fn settings_query() -> String {
    "content query --uri content://com.android.contacts/settings --projection account_name:account_type".into()
}

/// A conta Google do aparelho (das configurações da agenda ou dos contatos já vistos nela);
/// sem Google, a agenda local. Nunca a conta esfera_temp.
pub fn pick_target_account(settings_out: &str, known_google: &[String]) -> TargetAccount {
    if let Ok(rows) = parse_query_rows(settings_out, &["account_name", "account_type"]) {
        if let Some(row) = rows.iter().find(|r| r[1] == GOOGLE_TYPE && !r[0].is_empty()) {
            return TargetAccount::Google(row[0].clone());
        }
    }
    known_google.iter().map(|n| n.trim()).find(|n| !n.is_empty()).map(|n| TargetAccount::Google(n.to_string())).unwrap_or(TargetAccount::Local)
}

/// Aspas simples do shell do Android: o valor vai literal (acentos, espaços, aspas, $).
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn insert_raw_contact_command(target: &TargetAccount) -> Result<String, String> {
    match target {
        TargetAccount::Google(name) => {
            if name.trim().is_empty() || is_esfera_account(name, GOOGLE_TYPE) {
                return Err("Conta de destino inválida; nada foi criado no aparelho".into());
            }
            Ok(format!(
                "content insert --uri content://com.android.contacts/raw_contacts --bind {} --bind account_type:s:{}",
                sh_quote(&format!("account_name:s:{}", name)), GOOGLE_TYPE
            ))
        }
        // Sem conta: o Android põe na agenda do próprio aparelho.
        TargetAccount::Local => Ok("content insert --uri content://com.android.contacts/raw_contacts --bind aggregation_mode:i:0".into()),
    }
}

pub fn max_raw_contact_id_query() -> String {
    "content query --uri content://com.android.contacts/raw_contacts --projection _id".into()
}

fn parse_max_id(output: &str) -> Result<i64, String> {
    Ok(parse_query_rows(output, &["_id"])?.iter().filter_map(|r| r[0].parse::<i64>().ok()).max().unwrap_or(0))
}

pub fn new_raw_contacts_query(after_id: i64) -> String {
    format!(
        "content query --uri content://com.android.contacts/raw_contacts --projection {} --where \"_id>{} AND sourceid IS NULL\"",
        RAW_COLUMNS.join(":"), after_id
    )
}

/// O contato recém-criado: novo, vazio (sem nome ainda), fora da conta do Esfera e na conta pedida.
pub fn pick_new_raw_contact(output: &str, target: &TargetAccount) -> Result<i64, String> {
    let rows = parse_query_rows(output, &RAW_COLUMNS)?;
    let found: Vec<i64> = rows
        .iter()
        .filter(|r| r[1] != "1" && r[4].is_empty() && !is_esfera_account(&r[3], &r[2]))
        .filter(|r| match target {
            TargetAccount::Google(name) => r[2] == GOOGLE_TYPE && &r[3] == name,
            TargetAccount::Local => r[2] != GOOGLE_TYPE,
        })
        .filter_map(|r| r[0].parse().ok())
        .collect();
    match found.as_slice() {
        [id] => Ok(*id),
        [] => Err("O aparelho não confirmou a criação do contato".into()),
        _ => Err("Mais de um contato novo apareceu ao mesmo tempo; confira no aparelho".into()),
    }
}

/// Tipo do telefone no Android: 2 = celular, 7 = outro.
fn phone_type(phone: &str) -> i32 {
    let n = national_digits(phone);
    if n.len() == 11 && n.as_bytes()[2] == b'9' { 2 } else { 7 }
}

/// Comandos que gravam o nome e os telefones no contato recém-criado.
pub fn restore_data_commands(raw_id: i64, name: &str, phones: &[String]) -> Vec<String> {
    let mut commands = Vec::new();
    let name = clean_value(name);
    if !name.is_empty() {
        commands.push(format!(
            "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:{} --bind mimetype:s:{} --bind {}",
            raw_id, NAME_MIME, sh_quote(&format!("data1:s:{}", name))
        ));
    }
    for phone in phones {
        let phone = clean_value(phone);
        if phone.is_empty() { continue; }
        commands.push(format!(
            "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:{} --bind mimetype:s:{} --bind {} --bind data2:i:{}",
            raw_id, PHONE_MIME, sh_quote(&format!("data1:s:{}", phone)), phone_type(&phone)
        ));
    }
    commands
}

pub fn raw_contact_data_query(raw_id: i64) -> String {
    format!(
        "content query --uri content://com.android.contacts/data --projection {} --where \"raw_contact_id={}\"",
        DATA_COLUMNS.join(":"), raw_id
    )
}

/// O contato recriado tem o nome e todos os telefones?
fn restored_ok(output: &str, name: &str, phones: &[String]) -> bool {
    let Ok(rows) = parse_query_rows(output, &DATA_COLUMNS) else { return false };
    let name = clean_value(name);
    let name_ok = name.is_empty() || rows.iter().any(|r| r[1] == NAME_MIME && r[2] == name);
    let have: HashSet<String> = rows.iter().filter(|r| r[1] == PHONE_MIME).map(|r| digits(&r[2])).collect();
    name_ok && phones.iter().map(|p| digits(p)).filter(|d| !d.is_empty()).all(|d| have.contains(&d))
}

/// Um contato a recriar.
#[derive(Debug, Clone)]
pub struct RestoreRequest {
    pub id: i64,
    pub name: String,
    pub phones: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreItem {
    pub id: i64,
    pub name: String,
    pub ok: bool,
    pub skipped: bool,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub account: String,
    pub restored: usize,
    pub skipped: usize,
    pub failed: usize,
    pub items: Vec<RestoreItem>,
}

fn restore_one(
    shell: &mut dyn FnMut(&str) -> Result<String, String>,
    insert: &str,
    target: &TargetAccount,
    item: &RestoreRequest,
    newest: &mut Option<i64>,
) -> Result<(), String> {
    if item.phones.iter().all(|p| digits(p).is_empty()) { return Err("Contato sem telefone".into()); }
    let base = match newest.take() {
        Some(id) => id,
        None => parse_max_id(&shell(&max_raw_contact_id_query())?)?,
    };
    shell(insert)?;
    let id = pick_new_raw_contact(&shell(&new_raw_contacts_query(base))?, target)?;
    *newest = Some(id);
    for command in restore_data_commands(id, &item.name, &item.phones) {
        shell(&command)?;
    }
    if !restored_ok(&shell(&raw_contact_data_query(id))?, &item.name, &item.phones) {
        return Err("O aparelho não confirmou o nome e os telefones do contato recriado".into());
    }
    Ok(())
}

/// Recria os contatos um a um e confere cada um. Nunca apaga nada no aparelho: se algo falha
/// no meio, o contato fica como está e o erro volta no relatório.
pub fn restore_contacts_with(
    shell: &mut dyn FnMut(&str) -> Result<String, String>,
    target: &TargetAccount,
    items: &[RestoreRequest],
) -> Vec<RestoreItem> {
    let result = |item: &RestoreRequest, ok: bool, detail: String| RestoreItem { id: item.id, name: item.name.clone(), ok, skipped: false, detail };
    let insert = match insert_raw_contact_command(target) {
        Ok(command) => command,
        Err(e) => return items.iter().map(|i| result(i, false, e.clone())).collect(),
    };
    let mut newest: Option<i64> = None;
    items
        .iter()
        .map(|item| match restore_one(&mut *shell, &insert, target, item, &mut newest) {
            Ok(()) => result(item, true, format!("Recriado em {}", target.label())),
            Err(e) => result(item, false, e),
        })
        .collect()
}

fn skipped(row: &ContactBackupRow, detail: String) -> RestoreItem {
    RestoreItem { id: row.id, name: row.display_name.clone(), ok: false, skipped: true, detail }
}

/// Recria no aparelho os contatos que sumiram (todos, com `ids` vazio, ou os escolhidos).
/// Copia a agenda antes e depois; nunca apaga nada no aparelho; nunca usa a conta esfera_temp.
pub fn restore_device_contacts(db: &Database, device: &Device, ids: &[i64]) -> Result<RestoreReport, String> {
    let _vez = match RESTORE_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(p)) => p.into_inner(),
        Err(TryLockError::WouldBlock) => return Err("Já existe uma restauração de contatos em andamento; espere ela terminar.".into()),
    };
    let serial = device_serial(device);
    // Cópia antes de mexer: a lista do que falta fica atual.
    take_snapshot(db, &serial, "antes de restaurar")?;
    let mut rows = db.list_contact_backup(&device_keys(device))?;
    mark_same_phone(&mut rows);
    let mut known_google: Vec<String> = rows
        .iter()
        .filter(|r| r.vanished_at.is_none() && r.account_type == GOOGLE_TYPE)
        .map(|r| r.account_name.clone())
        .collect();
    known_google.dedup();

    let wanted: HashSet<i64> = ids.iter().copied().collect();
    let mut items: Vec<RestoreItem> = Vec::new();
    let mut todo: Vec<RestoreRequest> = Vec::new();
    for row in &rows {
        let chosen = if wanted.is_empty() { row.vanished_at.is_some() } else { wanted.contains(&row.id) };
        if !chosen { continue; }
        if row.vanished_at.is_none() {
            items.push(skipped(row, "Ainda está no aparelho; nada foi feito.".into()));
        } else if wanted.is_empty() && row.same_phone_on_device.is_some() {
            let other = row.same_phone_on_device.clone().unwrap_or_default();
            items.push(skipped(row, format!("O mesmo número ainda está no aparelho como \"{}\"; escolha este contato se quiser recriar mesmo assim.", other)));
        } else {
            todo.push(RestoreRequest { id: row.id, name: row.display_name.clone(), phones: row.phones.clone() });
        }
    }
    let known_ids: HashSet<i64> = rows.iter().map(|r| r.id).collect();
    for id in wanted.iter().filter(|id| !known_ids.contains(*id)) {
        items.push(RestoreItem { id: *id, name: String::new(), ok: false, skipped: true, detail: "Não está na cópia deste aparelho.".into() });
    }
    if todo.len() > MAX_RESTORE_PER_CALL {
        return Err(format!("São {} contatos; restaure no máximo {} por vez.", todo.len(), MAX_RESTORE_PER_CALL));
    }

    let mut account = String::new();
    if !todo.is_empty() {
        let settings = AdbManager::execute_shell(&serial, &settings_query(), SHELL_TIMEOUT_SECS).unwrap_or_default();
        let target = pick_target_account(&settings, &known_google);
        account = target.label();
        let done = restore_contacts_with(&mut |cmd| AdbManager::execute_shell(&serial, cmd, SHELL_TIMEOUT_SECS), &target, &todo);
        let now = db_now();
        for item in done.iter().filter(|i| i.ok) {
            let _ = db.mark_contact_restored(item.id, &now);
        }
        items.extend(done);
        // Cópia nova: o contato recriado volta a contar como presente.
        if let Err(e) = take_snapshot(db, &serial, "depois de restaurar") {
            eprintln!("[CONTATOS] Cópia depois da restauração falhou em {}: {}", serial, e);
        }
    }
    let restored = items.iter().filter(|i| i.ok).count();
    let skipped_count = items.iter().filter(|i| i.skipped).count();
    let failed = items.iter().filter(|i| !i.ok && !i.skipped).count();
    if restored > 0 || failed > 0 {
        let name = if device.name.trim().is_empty() { device.serial.clone() } else { device.name.clone() };
        db.queue_add_log(
            device.company_id,
            if failed > 0 { "warning" } else { "info" },
            "Contatos",
            &format!("Restauração de contatos em {}: {} recriado(s) em {}, {} com falha.", name, restored, account, failed),
        );
    }
    Ok(RestoreReport { account, restored, skipped: skipped_count, failed, items })
}

// ============================================================
// Testes
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Saídas no formato real do `content query` (Android 10 a 14).
    const RAW_OUT: &str = "Row: 0 _id=1, deleted=0, account_type=com.google, account_name=operador@gmail.com, display_name=Marcela Negociadora
Row: 1 _id=2, deleted=0, account_type=com.esfera, account_name=esfera_temp, display_name=Esfera 5547988887777
Row: 2 _id=3, deleted=0, account_type=com.esfera, account_name=esfera_temp, display_name=Marcela, Konfiansa
Row: 3 _id=4, deleted=1, account_type=com.google, account_name=operador@gmail.com, display_name=Apagado
Row: 4 _id=5, deleted=0, account_type=NULL, account_name=NULL, display_name=João D'Ávila
Row: 5 _id=6, deleted=0, account_type=com.whatsapp, account_name=WhatsApp, display_name=Marcela Negociadora
Row: 6 _id=7, deleted=0, account_type=vnd.sec.contact.sim, account_name=SIM1, display_name=Sem telefone
Row: 7 _id=8, deleted=0, account_type=vnd.sec.contact.phone, account_name=vnd.sec.contact.phone, display_name=+55 75 98805-2539
";
    const DATA_OUT: &str = "Row: 0 raw_contact_id=1, mimetype=vnd.android.cursor.item/name, data1=Marcela Negociadora
Row: 1 raw_contact_id=1, mimetype=vnd.android.cursor.item/phone_v2, data1=(47) 3305-4406
Row: 2 raw_contact_id=2, mimetype=vnd.android.cursor.item/name, data1=Esfera 5547988887777
Row: 3 raw_contact_id=2, mimetype=vnd.android.cursor.item/phone_v2, data1=+5547988887777
Row: 4 raw_contact_id=3, mimetype=vnd.android.cursor.item/name, data1=Marcela, Konfiansa
Row: 5 raw_contact_id=3, mimetype=vnd.android.cursor.item/phone_v2, data1=+55 47 3305-4406
Row: 6 raw_contact_id=3, mimetype=vnd.android.cursor.item/phone_v2, data1=47 99999-8888
Row: 7 raw_contact_id=5, mimetype=vnd.android.cursor.item/name, data1=João D'Ávila
Row: 8 raw_contact_id=5, mimetype=vnd.android.cursor.item/phone_v2, data1=75988052539
Row: 9 raw_contact_id=4, mimetype=vnd.android.cursor.item/phone_v2, data1=11 98888-7777
Row: 10 raw_contact_id=6, mimetype=vnd.android.cursor.item/phone_v2, data1=4733054406
Row: 11 raw_contact_id=8, mimetype=vnd.android.cursor.item/phone_v2, data1=+55 75 98805-2539
";

    fn contact(name: &str, phones: &[&str], account: (&str, &str)) -> DeviceContact {
        DeviceContact {
            raw_contact_id: 1,
            display_name: name.into(),
            phones: phones.iter().map(|p| p.to_string()).collect(),
            phone_digits: phones.iter().map(|p| digits(p)).collect(),
            account_name: account.0.into(),
            account_type: account.1.into(),
        }
    }

    fn temp_db(tag: &str) -> Database {
        let path = std::env::temp_dir().join(format!("esfera_contact_backup_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        Database::init(path.to_string_lossy().as_ref()).expect("db")
    }

    #[test]
    fn le_a_agenda_com_virgula_acento_e_sem_os_temporarios() {
        let list = build_contacts(RAW_OUT, DATA_OUT).unwrap();
        let names: Vec<&str> = list.iter().map(|c| c.display_name.as_str()).collect();
        // Fora: "Esfera 55..." (disparo), apagado, WhatsApp e o contato sem telefone.
        assert_eq!(names, vec!["", "João D'Ávila", "Marcela Negociadora", "Marcela, Konfiansa"]);
        let konf = list.iter().find(|c| c.display_name == "Marcela, Konfiansa").unwrap();
        assert_eq!(konf.phones, vec!["+55 47 3305-4406", "47 99999-8888"]);
        assert_eq!(konf.phone_digits, vec!["554733054406", "47999998888"]);
        assert_eq!((konf.account_name.as_str(), konf.account_type.as_str()), ("esfera_temp", "com.esfera"));
        let joao = list.iter().find(|c| c.display_name == "João D'Ávila").unwrap();
        assert_eq!((joao.account_type.as_str(), joao.raw_contact_id), ("", 5));
        // Nome exibido que é só o telefone não vira nome.
        let sem_nome = list.iter().find(|c| c.raw_contact_id == 8).unwrap();
        assert_eq!(sem_nome.phones, vec!["+55 75 98805-2539"]);
    }

    #[test]
    fn saida_vazia_ou_de_erro_nao_vira_agenda_vazia() {
        assert!(build_contacts("", DATA_OUT).is_err());
        assert!(build_contacts(RAW_OUT, "Error while accessing provider:com.android.contacts\njava.lang.SecurityException").is_err());
        assert!(build_contacts("Row: 0 _id=1, account_type=x", DATA_OUT).is_err(), "linha sem as colunas pedidas");
        // "No result found." é agenda vazia de verdade.
        assert_eq!(build_contacts("No result found.\n", "No result found.\n").unwrap(), vec![]);
        assert_eq!(build_contacts(RAW_OUT, "No result found.").unwrap(), vec![]);
    }

    #[test]
    fn le_saida_com_crlf_e_valor_em_duas_linhas() {
        let raw = "Row: 0 _id=9, deleted=0, account_type=com.google, account_name=a@b.com, display_name=Ana\r\n";
        let data = "Row: 0 raw_contact_id=9, mimetype=vnd.android.cursor.item/name, data1=Ana\r\nMaria\r\nRow: 1 raw_contact_id=9, mimetype=vnd.android.cursor.item/phone_v2, data1=11 91234-5678\r\n";
        let list = build_contacts(raw, data).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].display_name, "Ana Maria");
        assert_eq!(list[0].phones, vec!["11 91234-5678"]);
    }

    #[test]
    fn temporario_do_esfera_tem_nome_exato() {
        assert!(is_esfera_temp_name("Esfera 5547988887777"));
        assert!(is_esfera_temp_name(" Esfera 4733054406 "));
        assert!(!is_esfera_temp_name("Esfera Marcela"));
        assert!(!is_esfera_temp_name("Esfera 47 3305-4406"));
        assert!(!is_esfera_temp_name("Esfera 123"));
        assert!(!is_esfera_temp_name("Marcela Esfera 5547988887777"));
    }

    #[test]
    fn mesmo_contato_com_numero_escrito_diferente_tem_a_mesma_chave() {
        let a = contact("Marcela  Negociadora", &["+55 (47) 3305-4406"], ("x", "com.google"));
        let b = contact("marcela negociadora", &["4733054406"], ("", ""));
        assert_eq!(a.key(), b.key());
        assert_ne!(a.key(), contact("Marcela", &["4733054406"], ("", "")).key());
    }

    #[test]
    fn mesmo_contato_em_duas_contas_fica_com_a_google() {
        let raw = "Row: 0 _id=1, deleted=0, account_type=com.esfera, account_name=esfera_temp, display_name=Marcela\nRow: 1 _id=2, deleted=0, account_type=com.google, account_name=a@b.com, display_name=Marcela\n";
        let data = "Row: 0 raw_contact_id=1, mimetype=vnd.android.cursor.item/phone_v2, data1=4733054406\nRow: 1 raw_contact_id=2, mimetype=vnd.android.cursor.item/phone_v2, data1=+55 47 3305-4406\n";
        let list = build_contacts(raw, data).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].account_type, "com.google");
    }

    #[test]
    fn contato_que_some_fica_guardado_com_a_data_e_volta_quando_reaparece() {
        let db = temp_db("sumiu");
        let marcela = contact("Marcela", &["(47) 3305-4406"], ("esfera_temp", "com.esfera"));
        let joao = contact("João", &["75988052539"], ("", ""));
        let s1 = db.apply_contact_snapshot("ESF-1", "serial:abc", 1, "abc", "teste", &[marcela.clone(), joao.clone()], "2026-11-05 10:00:00").unwrap();
        assert_eq!((s1.total, s1.added, s1.vanished, s1.returned), (2, 2, 0, 0));

        // A limpeza antiga apagou a Marcela do aparelho.
        let s2 = db.apply_contact_snapshot("ESF-1", "serial:abc", 1, "abc", "teste", &[joao.clone()], "2026-11-05 16:00:00").unwrap();
        assert_eq!((s2.total, s2.added, s2.vanished), (1, 0, 1));
        let rows = db.list_contact_backup(&["ESF-1".into()]).unwrap();
        assert_eq!(rows.len(), 2, "nada é apagado do banco");
        assert_eq!(rows[0].display_name, "Marcela", "os que sumiram vêm primeiro");
        assert_eq!(rows[0].vanished_at.as_deref(), Some("2026-11-05 16:00:00"));
        assert_eq!(rows[0].last_seen_at, "2026-11-05 10:00:00");
        assert_eq!(rows[0].phones, vec!["(47) 3305-4406"]);
        assert_eq!(rows[0].account_label, "Conta do Esfera (esfera_temp)");
        assert!(rows[1].vanished_at.is_none());

        // Cópia seguinte ainda sem ela: continua com a data em que sumiu.
        let s3 = db.apply_contact_snapshot("ESF-1", "serial:abc", 1, "abc", "teste", &[joao.clone()], "2026-11-05 22:00:00").unwrap();
        assert_eq!(s3.vanished, 0);
        assert_eq!(db.list_contact_backup(&["ESF-1".into()]).unwrap()[0].vanished_at.as_deref(), Some("2026-11-05 16:00:00"));

        // Restaurada (em outra conta, número escrito de outro jeito): volta a ser a mesma linha.
        let restaurada = contact("Marcela", &["+55 47 3305-4406"], ("a@b.com", "com.google"));
        let s4 = db.apply_contact_snapshot("ESF-1", "serial:abc", 1, "abc", "teste", &[joao, restaurada], "2026-11-06 04:00:00").unwrap();
        assert_eq!((s4.added, s4.returned, s4.vanished), (0, 1, 0));
        let rows = db.list_contact_backup(&["ESF-1".into()]).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.vanished_at.is_none()));
        assert_eq!(db.last_contact_snapshot(&["ESF-1".into()]).map(|l| l.2), Some(2));
    }

    #[test]
    fn copia_feita_pelo_serial_passa_para_a_identidade() {
        let db = temp_db("chave");
        let ana = contact("Ana", &["11912345678"], ("", ""));
        db.apply_contact_snapshot("serial:abc", "serial:abc", 1, "abc", "teste", &[ana.clone()], "2026-11-05 10:00:00").unwrap();
        let s = db.apply_contact_snapshot("ESF-9", "serial:abc", 1, "abc", "teste", &[ana], "2026-11-05 11:00:00").unwrap();
        assert_eq!((s.added, s.vanished), (0, 0));
        let rows = db.list_contact_backup(&["ESF-9".into()]).unwrap();
        assert_eq!((rows.len(), rows[0].first_seen_at.as_str()), (1, "2026-11-05 10:00:00"));
    }

    #[test]
    fn mostra_quando_o_numero_que_sumiu_ainda_esta_no_aparelho() {
        let db = temp_db("mesmo_numero");
        let antiga = contact("Marcela", &["(47) 3305-4406"], ("", ""));
        let nova = contact("Marcela Konfiansa", &["+55 47 3305-4406"], ("", ""));
        db.apply_contact_snapshot("ESF-2", "", 1, "x", "t", &[antiga], "2026-11-05 10:00:00").unwrap();
        db.apply_contact_snapshot("ESF-2", "", 1, "x", "t", &[nova], "2026-11-05 11:00:00").unwrap();
        let mut rows = db.list_contact_backup(&["ESF-2".into()]).unwrap();
        mark_same_phone(&mut rows);
        assert_eq!(rows[0].display_name, "Marcela");
        assert_eq!(rows[0].same_phone_on_device.as_deref(), Some("Marcela Konfiansa"));
        assert_eq!(rows[1].same_phone_on_device, None);
    }

    #[test]
    fn conta_de_destino_google_ou_local_nunca_esfera() {
        let settings = "Row: 0 account_name=esfera_temp, account_type=com.esfera\nRow: 1 account_name=operador@gmail.com, account_type=com.google\n";
        assert_eq!(pick_target_account(settings, &[]), TargetAccount::Google("operador@gmail.com".into()));
        assert_eq!(pick_target_account("No result found.", &["outro@gmail.com".into()]), TargetAccount::Google("outro@gmail.com".into()));
        assert_eq!(pick_target_account("Row: 0 account_name=esfera_temp, account_type=com.esfera", &[]), TargetAccount::Local);
        assert_eq!(pick_target_account("", &[]), TargetAccount::Local);
        assert!(insert_raw_contact_command(&TargetAccount::Google("esfera_temp".into())).is_err());
        assert!(insert_raw_contact_command(&TargetAccount::Google(" ".into())).is_err());
        let google = insert_raw_contact_command(&TargetAccount::Google("operador@gmail.com".into())).unwrap();
        assert_eq!(google, "content insert --uri content://com.android.contacts/raw_contacts --bind 'account_name:s:operador@gmail.com' --bind account_type:s:com.google");
        let local = insert_raw_contact_command(&TargetAccount::Local).unwrap();
        assert!(!local.contains("account_") && !local.contains("esfera"));
    }

    #[test]
    fn monta_os_comandos_de_restauracao_com_aspas_seguras() {
        assert_eq!(sh_quote("D'Ávila $HOME"), "'D'\\''Ávila $HOME'");
        let cmds = restore_data_commands(42, "João D'Ávila\n", &["+55 47 99999-8888".into(), "(47) 3305-4406".into(), " ".into()]);
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0], "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:42 --bind mimetype:s:vnd.android.cursor.item/name --bind 'data1:s:João D'\\''Ávila'");
        assert_eq!(cmds[1], "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:42 --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind 'data1:s:+55 47 99999-8888' --bind data2:i:2");
        assert!(cmds[2].ends_with("--bind 'data1:s:(47) 3305-4406' --bind data2:i:7"));
        assert!(new_raw_contacts_query(7).contains("--where \"_id>7 AND sourceid IS NULL\""));
    }

    /// Aparelho simulado: responde aos comandos da restauração e guarda o que foi pedido.
    struct FakePhone {
        commands: Vec<String>,
        next_id: i64,
        rows: Vec<(i64, String, String)>,
        created: Vec<(i64, String)>,
    }

    impl FakePhone {
        fn shell(&mut self, cmd: &str) -> Result<String, String> {
            self.commands.push(cmd.to_string());
            if cmd == max_raw_contact_id_query() {
                return Ok("Row: 0 _id=10\nRow: 1 _id=41\nRow: 2 _id=3\n".into());
            }
            if cmd.starts_with("content insert --uri content://com.android.contacts/raw_contacts") {
                self.next_id += 1;
                let account = if cmd.contains("com.google") { "com.google" } else { "NULL" };
                self.created.push((self.next_id, account.into()));
                return Ok(String::new());
            }
            if cmd.contains("--where \"_id>") {
                let base: i64 = cmd.split("_id>").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
                let rows: Vec<String> = self.created.iter().filter(|(id, _)| *id > base).map(|(id, t)| {
                    let name = if t == "com.google" { "operador@gmail.com" } else { "NULL" };
                    format!("Row: 0 _id={}, deleted=0, account_type={}, account_name={}, display_name=NULL", id, t, name)
                }).collect();
                return Ok(if rows.is_empty() { "No result found.".into() } else { rows.join("\n") });
            }
            if cmd.starts_with("content insert --uri content://com.android.contacts/data") {
                let id: i64 = cmd.split("raw_contact_id:i:").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
                let mime = if cmd.contains(PHONE_MIME) { PHONE_MIME } else { NAME_MIME };
                // O shell do aparelho tira as aspas simples.
                let quoted = cmd.split("--bind 'data1:s:").nth(1).unwrap();
                let value = quoted[..quoted.rfind('\'').unwrap()].replace("'\\''", "'");
                self.rows.push((id, mime.into(), value));
                return Ok(String::new());
            }
            if cmd.contains("--where \"raw_contact_id=") {
                let id: i64 = cmd.split("raw_contact_id=").nth(1).unwrap().trim_end_matches('"').parse().unwrap();
                let rows: Vec<String> = self.rows.iter().filter(|r| r.0 == id).map(|r| format!("Row: 0 raw_contact_id={}, mimetype={}, data1={}", r.0, r.1, r.2)).collect();
                return Ok(if rows.is_empty() { "No result found.".into() } else { rows.join("\n") });
            }
            Err(format!("comando inesperado: {}", cmd))
        }
    }

    #[test]
    fn restaura_confere_e_nunca_apaga_nada_no_aparelho() {
        let mut phone = FakePhone { commands: vec![], next_id: 41, rows: vec![], created: vec![] };
        let items = vec![
            RestoreRequest { id: 7, name: "Marcela, Konfiansa".into(), phones: vec!["(47) 3305-4406".into()] },
            RestoreRequest { id: 8, name: "João D'Ávila".into(), phones: vec!["75988052539".into(), "+55 75 3333-4444".into()] },
            RestoreRequest { id: 9, name: "Sem número".into(), phones: vec!["".into()] },
        ];
        let target = TargetAccount::Google("operador@gmail.com".into());
        let done = restore_contacts_with(&mut |c| phone.shell(c), &target, &items);
        assert_eq!(done.iter().map(|d| d.ok).collect::<Vec<_>>(), vec![true, true, false]);
        assert_eq!(phone.created.len(), 2);
        assert!(phone.rows.contains(&(42, NAME_MIME.into(), "Marcela, Konfiansa".into())));
        assert!(phone.rows.contains(&(43, NAME_MIME.into(), "João D'Ávila".into())));
        assert!(phone.rows.contains(&(43, PHONE_MIME.into(), "+55 75 3333-4444".into())));
        assert!(phone.commands.iter().all(|c| !c.contains("content delete") && !c.contains("esfera_temp")), "{:?}", phone.commands);
        // O maior id só é lido uma vez; o segundo contato parte do recém-criado.
        assert_eq!(phone.commands.iter().filter(|c| **c == max_raw_contact_id_query()).count(), 1);
        assert!(phone.commands.iter().any(|c| c.contains("_id>42 AND")));
    }

    #[test]
    fn restauracao_sem_confirmacao_vira_erro_sem_apagar() {
        let mut commands: Vec<String> = vec![];
        let mut shell = |cmd: &str| -> Result<String, String> {
            commands.push(cmd.to_string());
            if cmd == max_raw_contact_id_query() { return Ok("Row: 0 _id=5".into()); }
            if cmd.contains("--where \"_id>") { return Ok("No result found.".into()); }
            Ok(String::new())
        };
        let items = vec![RestoreRequest { id: 1, name: "Ana".into(), phones: vec!["11912345678".into()] }];
        let done = restore_contacts_with(&mut shell, &TargetAccount::Local, &items);
        assert!(!done[0].ok);
        assert_eq!(done[0].detail, "O aparelho não confirmou a criação do contato");
        assert!(commands.iter().all(|c| !c.contains("content delete")), "{:?}", commands);
    }

    #[test]
    fn novo_contato_ignora_conta_do_esfera_e_contatos_com_nome() {
        let out = "Row: 0 _id=50, deleted=0, account_type=com.esfera, account_name=esfera_temp, display_name=NULL\nRow: 1 _id=51, deleted=0, account_type=NULL, account_name=NULL, display_name=Fulano\nRow: 2 _id=52, deleted=0, account_type=NULL, account_name=NULL, display_name=NULL\n";
        assert_eq!(pick_new_raw_contact(out, &TargetAccount::Local), Ok(52));
        assert!(pick_new_raw_contact(out, &TargetAccount::Google("a@b.com".into())).is_err());
    }

    #[test]
    fn planilha_com_aspas_e_sem_formula() {
        let db = temp_db("csv");
        db.apply_contact_snapshot("ESF-3", "", 1, "x", "t", &[contact("Silva, \"Zé\"", &["+55 47 3305-4406"], ("a@b.com", "com.google"))], "2026-11-05 10:00:00").unwrap();
        db.apply_contact_snapshot("ESF-3", "", 1, "x", "t", &[], "2026-11-05 11:00:00").unwrap();
        let csv = backup_csv(&db.list_contact_backup(&["ESF-3".into()]).unwrap());
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert_eq!(lines[0], "\"Nome\";\"Telefones\";\"Conta\";\"Visto por último\";\"Sumiu do aparelho em\"");
        assert!(lines[1].starts_with("\"Silva, \"\"Zé\"\"\";\"'+55 47 3305-4406\";\"Google (a@b.com)\";\""), "{}", lines[1]);
        assert!(lines[1].ends_with(&format!("\"{}\"", local_date("2026-11-05 11:00:00"))), "{}", lines[1]);
        assert_eq!(csv_cell("=1+1"), "\"'=1+1\"");
    }

    #[test]
    fn rotulo_da_conta_de_origem() {
        assert_eq!(account_label("x@gmail.com", "com.google"), "Google (x@gmail.com)");
        assert_eq!(account_label("SIM1", "vnd.sec.contact.sim"), "Chip (SIM)");
        assert_eq!(account_label("", ""), "Aparelho (local)");
        assert_eq!(account_label("vnd.sec.contact.phone", "vnd.sec.contact.phone"), "Aparelho (local)");
        assert_eq!(account_label("esfera_temp", "com.esfera"), "Conta do Esfera (esfera_temp)");
    }

    #[test]
    fn agenda_da_copia_automatica() {
        assert!(snapshot_due(None, false));
        assert!(!snapshot_due(Some((Duration::from_secs(60), true)), false));
        assert!(!snapshot_due(Some((Duration::from_secs(60), true)), true), "reconexão logo depois não copia de novo");
        assert!(snapshot_due(Some((REAPPEAR_MIN_GAP, true)), true));
        assert!(!snapshot_due(Some((REAPPEAR_MIN_GAP, true)), false));
        assert!(snapshot_due(Some((SNAPSHOT_EVERY, true)), false));
        assert!(!snapshot_due(Some((Duration::from_secs(60), false)), false));
        assert!(snapshot_due(Some((RETRY_AFTER, false)), false));
    }
}
