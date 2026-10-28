

// ============================================================
// Esfera v3 — Camada de Banco de Dados (SQLite Local)
// Mapeamento 1:1 das tabelas ESF_* do Esfera v2
// Fase 1: WAL, Soft Delete, 4 tabelas novas, Hash SHA-256
// ============================================================

use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use std::sync::Mutex;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::time::Duration;

// ============================================================
// STRUCTS
// ============================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Company {
    pub id: i32,
    pub name: String,
    pub device_limit: i32,
    pub user_limit: i32,
    pub device_count: i32,
    pub user_count: i32,
    pub is_active: bool,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i32,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub company_id: Option<i32>,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i32,
    pub serial: String,
    pub name: String,
    pub brand: String,
    pub model: String,
    pub ip: String,
    pub port: i32,
    pub status: String,
    pub battery: i32,
    pub company_id: i32,
    pub device_number: i32,
    pub sector: String,
    pub esfera_device_id: Option<String>,
    pub current_adb_address: Option<String>,
    pub last_seen_utc: Option<String>,
    /// true quando o device está acessível via Túnel Reverso (conexão iniciada pelo celular),
    /// e não por um endpoint ADB direto (IP:porta volátil). Usado para priorizar rota e UI.
    pub via_tunnel: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    pub id: i32,
    pub name: String,
    pub greeting: String,
    pub message: String,
    pub closing: String,
    pub delay_min: i32,
    pub delay_max: i32,
    pub use_spintax: bool,
    #[serde(alias = "useAI")]
    pub use_ai: bool,
    pub ai_model: String,
    #[serde(default)]
    pub ai_provider: String,
    pub ai_prompt: String,
    #[serde(default)]
    pub device_ids: Vec<String>,
    pub status: String,
    pub contacts_count: i32,
    pub sent_count: i32,
    pub failed_count: i32,
    pub company_id: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: i32,
    pub name: String,
    pub keyword: String,
    pub response: String,
    pub active: bool,
    pub triggered_count: i32,
    pub company_id: i32,
    pub trigger_type: String,
    pub action_type: String,
    pub trigger_config: String,
    pub action_config: String,
    pub sector: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuditLog {
    pub id: i32,
    pub timestamp: String,
    pub log_type: String,
    pub source: String,
    pub message: String,
    pub company_id: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chip {
    pub id: i32,
    pub device_id: i32,
    pub phone_number: String,
    pub chip_name: String,
    pub status: String,
    pub restricted_until: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i32,
    pub campaign_id: i32,
    pub contact_name: String,
    pub phone: String,
    pub status: String,
    pub sent_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevicePackage {
    pub device_id: i32,
    pub package_name: String,
    pub status: String,
    pub updated_at: String,
}

// --- Novos structs Fase 1 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SentHistory {
    pub phone: String,
    pub campaign_id: i32,
    pub sent_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub device_id: String,
    pub package_name: String,
    pub campaign_id: i32,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrefs {
    pub device_id: String,
    pub campaign_id: i32,
    pub preferred_package: String,
    pub unlock_pin: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(alias = "company_id")]
    pub company_id: i32,
    pub provider: String,
    pub model: String,
    pub temperature: f64,
    #[serde(alias = "system_prompt")]
    pub system_prompt: String,
    #[serde(alias = "api_key")]
    pub api_key: String,
    pub endpoint: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub user_id: i32,
    pub permission_key: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SectorPermission {
    pub user_id: i32,
    pub sector: String,
    pub can_view: bool,
    pub can_configure: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAssignment {
    pub assignment_id: i32,
    pub adb_device_id: String,
    pub user_id: i32,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAssignmentInfo {
    pub assignment_id: i32,
    pub adb_device_id: String,
    pub user_id: i32,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub device_name: Option<String>,
    pub device_number: Option<i32>,
    pub model: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevicePermissionRequest {
    pub request_id: i32,
    pub adb_device_id: String,
    pub user_id: i32,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub status: String,
    pub requested_reason: Option<String>,
    pub requested_at: String,
    pub approved_by: Option<i32>,
    pub approved_by_name: Option<String>,
    pub approved_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWithActiveUser {
    pub id: i32,
    pub serial: String,
    pub name: String,
    pub brand: String,
    pub model: String,
    pub ip: String,
    pub port: i32,
    pub status: String,
    pub battery: i32,
    pub company_id: i32,
    pub device_number: i32,
    pub sector: String,
    pub esfera_device_id: Option<String>,
    pub current_adb_address: Option<String>,
    pub last_seen_utc: Option<String>,
    pub via_tunnel: bool,
    pub active_user_id: Option<i32>,
    pub active_user_name: Option<String>,
    pub active_user_display_name: Option<String>,
    pub permission_request_id: Option<i32>,
    pub assigned_user_id: Option<i32>,
    pub assigned_user_name: Option<String>,
}

/// Resultado da gravação durável de um pedido de descadastro recebido por API.
#[derive(Debug, Clone)]
pub struct OptOutRecordOutcome {
    /// "recorded" (gravado agora) ou "duplicate" (EventId já conhecido; nada mudou).
    pub status: &'static str,
    pub phone_key: String,
    pub suppressed: usize,
    /// Em duplicata: se o evento já gravado pertence à mesma empresa do pedido atual.
    pub same_company: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptOutReview {
    pub id: i32,
    pub company_id: i32,
    pub title: String,
    pub text: String,
    pub device: String,
    pub status: String,
    pub resolved_phone: Option<String>,
    pub resolved_by: Option<String>,
    pub resolved_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OptOutAuditEntry {
    pub id: i32,
    pub company_id: i32,
    pub phone: String,
    pub action: String,
    pub actor_name: String,
    pub actor_role: String,
    pub detail: String,
    pub created_at: String,
}

// ============================================================
// DATABASE TRANSACTION RAII
// ============================================================

pub struct DatabaseTransaction<'a> {
    tx: Option<Transaction<'a>>,
    #[allow(dead_code)]
    conn: &'a Connection,
}

impl<'a> DatabaseTransaction<'a> {
    pub fn new(_db: &'a Database) -> Result<Self> {
        Err(rusqlite::Error::InvalidParameterName("DatabaseTransaction requires pool refactor".into()))
    }

    pub fn commit(mut self) -> Result<()> {
        if let Some(tx) = self.tx.take() {
            tx.commit()?;
        }
        Ok(())
    }

    pub fn execute(&self, sql: &str, params: impl rusqlite::Params) -> Result<usize> {
        if let Some(ref tx) = self.tx {
            tx.execute(sql, params)
        } else {
            Err(rusqlite::Error::ExecuteReturnedResults)
        }
    }
}

impl<'a> Drop for DatabaseTransaction<'a> {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.rollback();
        }
    }
}

// ============================================================
// HASH SHA-256
// ============================================================

pub fn hash_password(password: &str) -> String {
    let salt = "esfera_v3_salt_2026";
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}", salt, password).as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}

/// Verifica senha APENAS via hash SHA-256 com salt.
/// NUNCA aceita o plaintext igual ao hash (elimina o fallback inseguro).
pub fn verify_password(password: &str, hash: &str) -> bool {
    if hash.is_empty() || password.is_empty() {
        return false;
    }
    hash_password(password) == hash
}

// ============================================================
// DATABASE
// ============================================================

pub struct Database {
    pool: Pool<SqliteConnectionManager>,
    cached: Mutex<Option<r2d2::PooledConnection<SqliteConnectionManager>>>,
    write_queue: Mutex<Option<std::sync::Arc<crate::write_queue::WriteQueue>>>,
}

// Wrapper para MutexGuard que implementa Deref<Target=Connection>
pub struct ConnGuard<'a>(std::sync::MutexGuard<'a, Option<r2d2::PooledConnection<SqliteConnectionManager>>>);

impl<'a> std::ops::Deref for ConnGuard<'a> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}

fn db_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("D:/Novo/Esfera v3/esfera_runtime_debug.log") {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let _ = writeln!(f, "[{}] DB: {}", ts, msg);
    }
}

impl Database {
    pub fn init(db_path: &str) -> Result<Self> {
        db_log(&format!("Iniciando DB em path: {}", db_path));
        if let Some(parent) = std::path::Path::new(db_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
            let _ = conn.execute_batch(
                "PRAGMA busy_timeout=10000;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;"
            );
            Ok(())
        });
        db_log("Criando pool de conexões SQLite");
        let pool = match Pool::builder().max_size(16).min_idle(Some(0)).build(manager) {
            Ok(p) => p,
            Err(e) => {
                db_log(&format!("FATAL: Falha ao construir r2d2 pool: {:?}", e));
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(e)));
            }
        };
        db_log("Pool criado com sucesso. Obtendo conexão para WAL...");
        match pool.get() {
            Ok(conn) => {
                db_log("Conexão obtida. Executando PRAGMA journal_mode=WAL...");
                match conn.execute_batch("PRAGMA journal_mode=WAL;") {
                    Ok(_) => db_log("WAL aplicado com sucesso."),
                    Err(e) => db_log(&format!("Erro ao aplicar WAL: {:?}", e)),
                }
            }
            Err(e) => {
                db_log(&format!("Erro ao obter conexão do pool: {:?}", e));
            }
        }
        db_log("PRAGMAs aplicados.");

        let db = Database {
            pool,
            cached: Mutex::new(None),
            write_queue: Mutex::new(None),
        };
        db_log("Criando tabelas...");
        db.create_tables()?;
        db_log("Migrando tabelas...");
        db.migrate_existing_tables()?;
        db_log("Seeding data...");
        db.seed_data()?;
        db_log("Auditando e curando identidades nativas de dispositivos...");
        db.audit_and_heal_device_identities()?;
        db_log("DB init concluído com SUCESSO!");
        Ok(db)
    }

    fn conn(&self) -> ConnGuard<'_> {
        let mut guard = match self.cached.lock() {
            Ok(g) => g,
            Err(e) => {
                // Mutex envenenada — tenta recuperar os dados
                db_log(&format!("AVISO CRITICO: db conn mutex envenenada, tentando recuperar: {:?}", e));
                e.into_inner()
            }
        };
        if guard.is_none() {
            // Tenta obter do pool com retry (até 3x) para não crashar em picos de contenção
            let mut attempts = 0;
            loop {
                match self.pool.get() {
                    Ok(c) => { *guard = Some(c); break; }
                    Err(e) => {
                        attempts += 1;
                        db_log(&format!("AVISO: r2d2 pool.get() falhou (tentativa {}/3): {:?}", attempts, e));
                        if attempts >= 3 {
                            panic!("r2d2 pool exhausted após 3 tentativas (max_size=8)");
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50 * attempts));
                    }
                }
            }
        }
        ConnGuard(guard)
    }

    /// Obtém uma conexão dedicada do pool (usada pela thread única de escrita)
    pub(crate) fn pooled_conn(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>> {
        self.pool.get().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
    }

    /// Executa uma operação com retry em caso de SQLITE_BUSY (contenção de escrita WAL),
    /// aplicando exponential backoff com desvio estocástico (jitter).
    pub(crate) fn with_busy_retry<T>(f: impl Fn() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let mut attempt = 0u32;
        loop {
            match f() {
                Ok(v) => return Ok(v),
                Err(rusqlite::Error::SqliteFailure(err, _))
                    if err.code == rusqlite::ErrorCode::DatabaseBusy =>
                {
                    attempt += 1;
                    if attempt >= 3 {
                        return Err(rusqlite::Error::SqliteFailure(err, None));
                    }
                    let base_ms = 25u64 * (1 << attempt);
                    let jitter_ms = rand::random::<u64>() % 25;
                    std::thread::sleep(Duration::from_millis(base_ms + jitter_ms));
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Executa um INSERT/UPDATE/DELETE com retry de contenção (SQLITE_BUSY)
    fn exec_retry(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<usize> {
        let conn = self.conn();
        let c: &Connection = &conn;
        Self::with_busy_retry(|| c.execute(sql, params))
    }

    /// Conecta a Fila Única de Escrita Assíncrona (MPSC) ao banco
    pub fn attach_write_queue(&self, queue: std::sync::Arc<crate::write_queue::WriteQueue>) {
        *self.write_queue.lock().unwrap() = Some(queue);
    }

    /// Enfileira uma operação de escrita; retorna false se a fila não estiver ativa
    fn enqueue(&self, op: crate::write_queue::WriteOp) -> bool {
        match self.write_queue.lock() {
            Ok(guard) => guard.as_ref().map(|q| q.enqueue(op)).unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Log de auditoria assíncrono via fila única de escrita (fire-and-forget com fallback síncrono)
    pub fn queue_add_log(&self, company_id: i32, log_type: &str, source: &str, message: &str) {
        if !self.enqueue(crate::write_queue::WriteOp::Log {
            company_id,
            log_type: log_type.to_string(),
            source: source.to_string(),
            message: message.to_string(),
        }) {
            let _ = self.add_log(company_id, log_type, source, message);
        }
    }

    /// Marca envio concluído de forma ATÔMICA — 3 escritas em 1 transação loteada na fila
    pub fn queue_send_completed(&self, phone: &str, campaign_id: i32, contact_id: i32) {
        if !self.enqueue(crate::write_queue::WriteOp::SendCompleted {
            phone: phone.to_string(),
            campaign_id,
            contact_id,
        }) {
            let _ = self.mark_as_sent(phone, campaign_id);
            let _ = self.update_contact_status(contact_id, "sent");
            let _ = self.increment_campaign_sent_count(campaign_id);
        }
    }

    /// Aplica um lote de operações de escrita em UMA transação (single-writer batch)
    pub(crate) fn apply_write_batch(&self, conn: &Connection, ops: &[crate::write_queue::WriteOp]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        Self::with_busy_retry(|| conn.execute_batch("BEGIN IMMEDIATE;"))?;
        let result = ops.iter().try_for_each(|op| self.execute_write_op(conn, op));
        match result {
            Ok(()) => match Self::with_busy_retry(|| conn.execute_batch("COMMIT;")) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    Err(e)
                }
            },
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    fn execute_write_op(&self, conn: &Connection, op: &crate::write_queue::WriteOp) -> Result<()> {
        use crate::write_queue::WriteOp::*;
        match op {
            Log { company_id, log_type, source, message } => {
                conn.execute(
                    "INSERT INTO ESF_AuditLog (CompanyId, LogType, Source, Message) VALUES (?1, ?2, ?3, ?4);",
                    params![company_id, log_type, source, message],
                )?;
            }
            MarkSent { phone, campaign_id } => {
                conn.execute(
                    "INSERT OR REPLACE INTO ESF_SentHistory (Phone, CampaignId, SentAt) VALUES (?1, ?2, datetime('now'));",
                    params![phone, campaign_id],
                )?;
            }
            ContactStatus { contact_id, status } => {
                conn.execute(
                    "UPDATE ESF_Contact SET Status=?1, SentAt=datetime('now') WHERE ContactId=?2;",
                    params![status, contact_id],
                )?;
            }
            IncrementSent { campaign_id } => {
                conn.execute(
                    "UPDATE ESF_Campaign SET SentContacts = SentContacts + 1, UpdatedAt = datetime('now') WHERE CampaignId = ?1;",
                    params![campaign_id],
                )?;
            }
            SendCompleted { phone, campaign_id, contact_id } => {
                conn.execute(
                    "INSERT OR REPLACE INTO ESF_SentHistory (Phone, CampaignId, SentAt) VALUES (?1, ?2, datetime('now'));",
                    params![phone, campaign_id],
                )?;
                conn.execute(
                    "UPDATE ESF_Contact SET Status='sent', SentAt=datetime('now') WHERE ContactId=?1;",
                    params![contact_id],
                )?;
                conn.execute(
                    "UPDATE ESF_Campaign SET SentContacts = SentContacts + 1, UpdatedAt = datetime('now') WHERE CampaignId = ?1;",
                    params![campaign_id],
                )?;
            }
            DeviceCheckin { device_id, adb_address, ip, port, now } => {
                let upper_id = device_id.to_uppercase();
                conn.execute(
                    "UPDATE ESF_Device SET
                        CurrentAdbAddress = ?1,
                        Status = 'online',
                        LastSeenUTC = ?2,
                        DeviceIp = ?3,
                        DevicePort = ?4,
                        EsferaDeviceId = COALESCE(EsferaDeviceId, ?5)
                     WHERE EsferaDeviceId = ?5 OR UPPER(EsferaDeviceId) = ?6
                        OR AdbDeviceId = ?5 OR UPPER(AdbDeviceId) = ?6
                        OR DeviceIp = ?3 OR CurrentAdbAddress = ?1",
                    params![adb_address, now, ip, port, device_id, upper_id],
                )?;
            }
            MarkDeviceOnline { rowid, adb_addr } => {
                conn.execute(
                    "UPDATE ESF_Device SET Status = 'online', CurrentAdbAddress = ?1 WHERE rowid = ?2",
                    params![adb_addr, rowid],
                )?;
            }
        }
        Ok(())
    }

    fn create_tables(&self) -> Result<()> {
        // 1. ESF_Company
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Company (
                CompanyId INTEGER PRIMARY KEY AUTOINCREMENT,
                CompanyName TEXT NOT NULL,
                DeviceLimit INTEGER NOT NULL DEFAULT 50,
                UserLimit INTEGER NOT NULL DEFAULT 10,
                IsActive INTEGER NOT NULL DEFAULT 1,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;

        // 2. ESF_User
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_User (
                UserId INTEGER PRIMARY KEY AUTOINCREMENT,
                Username TEXT NOT NULL UNIQUE,
                PasswordHash TEXT NOT NULL,
                DisplayName TEXT NOT NULL,
                Role TEXT NOT NULL DEFAULT 'colaborador',
                CompanyId INTEGER REFERENCES ESF_Company(CompanyId),
                IsActive INTEGER NOT NULL DEFAULT 1,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;

        // 3. ESF_Device
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Device (
                AdbDeviceId TEXT PRIMARY KEY,
                DeviceName TEXT NOT NULL,
                Brand TEXT NOT NULL DEFAULT 'Android',
                Model TEXT NOT NULL DEFAULT 'Smartphone',
                DeviceIp TEXT NOT NULL DEFAULT '',
                DevicePort INTEGER NOT NULL DEFAULT 5555,
                Status TEXT NOT NULL DEFAULT 'offline',
                BatteryLevel INTEGER NOT NULL DEFAULT 0,
                CompanyId INTEGER NOT NULL REFERENCES ESF_Company(CompanyId),
                DeviceNumber INTEGER NOT NULL DEFAULT 1,
                Sector TEXT NOT NULL DEFAULT 'junior'
            );",
            [],
        )?;

        // 4. ESF_Campaign (com SelectedDevices e ExcluidoEm)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Campaign (
                CampaignId INTEGER PRIMARY KEY AUTOINCREMENT,
                CampaignName TEXT NOT NULL,
                MessageGreeting TEXT DEFAULT '',
                MessageBody TEXT DEFAULT '',
                MessageClosing TEXT DEFAULT '',
                DelayMin INTEGER NOT NULL DEFAULT 30,
                DelayMax INTEGER NOT NULL DEFAULT 90,
                UseSpintax INTEGER NOT NULL DEFAULT 0,
                UseAI INTEGER NOT NULL DEFAULT 0,
                AiModel TEXT DEFAULT 'gpt-4o-mini',
                AiProvider TEXT DEFAULT '',
                AiPrompt TEXT DEFAULT '',
                Status TEXT NOT NULL DEFAULT 'draft',
                TotalContacts INTEGER NOT NULL DEFAULT 0,
                SentContacts INTEGER NOT NULL DEFAULT 0,
                FailedContacts INTEGER NOT NULL DEFAULT 0,
                CompanyId INTEGER NOT NULL REFERENCES ESF_Company(CompanyId),
                SelectedDevices TEXT DEFAULT '',
                UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                ExcluidoEm TEXT DEFAULT NULL
            );",
            [],
        )?;

        // 5. ESF_AutomationRule (com ExcluidoEm)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_AutomationRule (
                RuleId INTEGER PRIMARY KEY AUTOINCREMENT,
                RuleName TEXT NOT NULL,
                Keyword TEXT NOT NULL,
                ResponseText TEXT NOT NULL,
                IsActive INTEGER NOT NULL DEFAULT 1,
                TriggeredCount INTEGER NOT NULL DEFAULT 0,
                CompanyId INTEGER NOT NULL REFERENCES ESF_Company(CompanyId),
                ExcluidoEm TEXT DEFAULT NULL
            );",
            [],
        )?;

        // 6. ESF_AuditLog (com ExcluidoEm)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_AuditLog (
                LogId INTEGER PRIMARY KEY AUTOINCREMENT,
                Timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                LogType TEXT NOT NULL DEFAULT 'info',
                Source TEXT NOT NULL DEFAULT 'Sistema',
                Message TEXT NOT NULL,
                CompanyId INTEGER NOT NULL REFERENCES ESF_Company(CompanyId),
                ExcluidoEm TEXT DEFAULT NULL
            );",
            [],
        )?;

        // 7. ESF_Chip (com 6 status, holder, is_reserve, linked_chip_id)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Chip (
                ChipId INTEGER PRIMARY KEY AUTOINCREMENT,
                DeviceId INTEGER NOT NULL,
                PhoneNumber TEXT NOT NULL,
                ChipName TEXT DEFAULT '',
                Status TEXT NOT NULL DEFAULT 'livre',
                Holder TEXT DEFAULT '',
                IsReserve INTEGER NOT NULL DEFAULT 0,
                LinkedChipId INTEGER DEFAULT NULL,
                RestrictedUntil TEXT,
                ExcluidoEm TEXT DEFAULT NULL,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;

        // 8. ESF_Contact (com custom_message, device_id, retry_count, excluido_em)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Contact (
                ContactId INTEGER PRIMARY KEY AUTOINCREMENT,
                CampaignId INTEGER NOT NULL,
                ContactName TEXT DEFAULT '',
                Phone TEXT NOT NULL,
                Status TEXT NOT NULL DEFAULT 'pending',
                DeviceId TEXT DEFAULT '',
                RetryCount INTEGER NOT NULL DEFAULT 0,
                CustomMessage TEXT DEFAULT '',
                SentAt TEXT,
                ExcluidoEm TEXT DEFAULT NULL,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;

        // 9. ESF_DevicePackage
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DevicePackage (
                DeviceId INTEGER NOT NULL,
                PackageName TEXT NOT NULL,
                Status TEXT NOT NULL DEFAULT 'active',
                UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (DeviceId, PackageName)
            );",
            [],
        )?;

        // 10. ESF_SentHistory (dedup de envios)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_SentHistory (
                Phone TEXT NOT NULL,
                CampaignId INTEGER NOT NULL,
                SentAt TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (Phone, CampaignId)
            );",
            [],
        )?;

        // 10b. ESF_OptOut (descadastro: quem pediu para não receber mais mensagens).
        // Política do WhatsApp: pedidos de bloqueio/descadastro devem ser respeitados sempre.
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_OptOut (
                CompanyId INTEGER NOT NULL,
                PhoneDigits TEXT NOT NULL,
                Reason TEXT NOT NULL DEFAULT '',
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (CompanyId, PhoneDigits)
            );",
            [],
        )?;

        // 10c. ESF_OptOutEvent (descadastro central: cada pedido recebido por API, ex.: VEXOR,
        // é gravado UMA vez pelo seu EventId estável; reenvios/retries viram "duplicate").
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_OptOutEvent (
                EventId TEXT PRIMARY KEY,
                CompanyId INTEGER NOT NULL,
                PhoneDigits TEXT NOT NULL,
                PhoneE164 TEXT NOT NULL DEFAULT '',
                Source TEXT NOT NULL DEFAULT '',
                Reason TEXT NOT NULL DEFAULT '',
                ReceivedAt TEXT NOT NULL DEFAULT '',
                RecordedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;
        self.conn().execute(
            "CREATE INDEX IF NOT EXISTS idx_optout_event_company ON ESF_OptOutEvent(CompanyId, RecordedAt);",
            [],
        )?;

        // 10d. ESF_OptOutReview (pedidos de SAIR sem número identificável no título para revisão humana)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_OptOutReview (
                ReviewId INTEGER PRIMARY KEY AUTOINCREMENT,
                CompanyId INTEGER NOT NULL DEFAULT 1,
                Title TEXT NOT NULL DEFAULT '',
                Text TEXT NOT NULL DEFAULT '',
                Device TEXT NOT NULL DEFAULT '',
                Status TEXT NOT NULL DEFAULT 'pending',
                ResolvedPhone TEXT DEFAULT NULL,
                ResolvedBy TEXT DEFAULT NULL,
                ResolvedAt TEXT DEFAULT NULL,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;
        self.conn().execute(
            "CREATE INDEX IF NOT EXISTS idx_optout_review_company ON ESF_OptOutReview(CompanyId, Status, ReviewId DESC);",
            [],
        )?;

        // 10e. ESF_OptOutAudit (auditoria de quem adicionou ou removeu números da lista de descadastro)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_OptOutAudit (
                AuditId INTEGER PRIMARY KEY AUTOINCREMENT,
                CompanyId INTEGER NOT NULL DEFAULT 1,
                PhoneDigits TEXT NOT NULL,
                Action TEXT NOT NULL,
                ActorName TEXT NOT NULL DEFAULT '',
                ActorRole TEXT NOT NULL DEFAULT '',
                Detail TEXT NOT NULL DEFAULT '',
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;
        self.conn().execute(
            "CREATE INDEX IF NOT EXISTS idx_optout_audit_company ON ESF_OptOutAudit(CompanyId, AuditId DESC);",
            [],
        )?;

        // 11. ESF_DeviceStatus (bans por pacote por campanha)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DeviceStatus (
                DeviceId TEXT NOT NULL,
                PackageName TEXT NOT NULL,
                CampaignId INTEGER NOT NULL,
                Status TEXT NOT NULL DEFAULT 'active',
                ExcluidoEm TEXT DEFAULT NULL,
                PRIMARY KEY (DeviceId, PackageName, CampaignId)
            );",
            [],
        )?;

        // 12. ESF_DevicePrefs (preferências por dispositivo por campanha)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DevicePrefs (
                DeviceId TEXT NOT NULL,
                CampaignId INTEGER NOT NULL,
                PreferredPackage TEXT DEFAULT 'com.whatsapp',
                UnlockPin TEXT DEFAULT '',
                ExcluidoEm TEXT DEFAULT NULL,
                PRIMARY KEY (DeviceId, CampaignId)
            );",
            [],
        )?;

        // 13. ESF_AiConfig (configurações de IA por empresa)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_AiConfig (
                CompanyId INTEGER NOT NULL PRIMARY KEY,
                Provider TEXT DEFAULT 'ollama_local',
                Model TEXT DEFAULT 'qwen2.5:1.5b',
                Temperature REAL DEFAULT 0.95,
                SystemPrompt TEXT DEFAULT '',
                ApiKey TEXT DEFAULT '',
                Endpoint TEXT DEFAULT 'http://localhost:11434'
            );",
            [],
        )?;

        // 13b. ESF_AiProviderKey (registro persistente de chaves e endpoints por provedor por empresa)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_AiProviderKey (
                CompanyId INTEGER NOT NULL,
                Provider TEXT NOT NULL,
                ApiKey TEXT DEFAULT '',
                Endpoint TEXT DEFAULT '',
                Model TEXT DEFAULT '',
                UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (CompanyId, Provider)
            );",
            [],
        )?;

        // 14. ESF_Permission (permissões granulares por usuário)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_Permission (
                UserId INTEGER NOT NULL,
                PermissionKey TEXT NOT NULL,
                Enabled INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (UserId, PermissionKey)
            );",
            [],
        )?;

        // 15. ESF_SectorPermission (permissões por setor)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_SectorPermission (
                UserId INTEGER NOT NULL,
                Sector TEXT NOT NULL,
                CanView INTEGER NOT NULL DEFAULT 1,
                CanConfigure INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (UserId, Sector)
            );",
            [],
        )?;

        // 16. ESF_DeviceAssignment (vínculo celular-colaborador)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DeviceAssignment (
                AssignmentId INTEGER PRIMARY KEY AUTOINCREMENT,
                AdbDeviceId TEXT NOT NULL,
                UserId INTEGER NOT NULL,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(AdbDeviceId, UserId)
            );",
            [],
        )?;

        // 17. ESF_DevicePermissionRequest (pedidos de permissão para celulares)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DevicePermissionRequest (
                RequestId INTEGER PRIMARY KEY AUTOINCREMENT,
                AdbDeviceId TEXT NOT NULL,
                UserId INTEGER NOT NULL,
                Status TEXT NOT NULL DEFAULT 'pending',
                RequestedReason TEXT DEFAULT '',
                RequestedAt TEXT NOT NULL DEFAULT (datetime('now')),
                ApprovedBy INTEGER DEFAULT NULL,
                ApprovedAt TEXT DEFAULT NULL,
                EndedAt TEXT DEFAULT NULL
            );",
            [],
        )?;

        // 17.5 ESF_CompanyToken (autenticação company-scoped do hub local — sem credencial global)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_CompanyToken (
                CompanyId INTEGER PRIMARY KEY,
                TokenHash TEXT NOT NULL,
                Role TEXT NOT NULL DEFAULT 'empresa',
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );",
            [],
        )?;

        // 17.6 ESF_DeviceIdentity (Vínculo permanente de Nome, Setor e Número ao Hardware ID EsferaDeviceId)
        self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DeviceIdentity (
                EsferaDeviceId TEXT PRIMARY KEY,
                CustomName TEXT NOT NULL,
                Sector TEXT NOT NULL DEFAULT 'junior',
                DeviceNumber INTEGER NOT NULL DEFAULT 1,
                Model TEXT DEFAULT '',
                UpdatedAt TEXT NOT NULL
            );",
            [],
        )?;

        // 18. Performance Indexes (Microsecond Lookups)
        self.conn().execute_batch("
            CREATE INDEX IF NOT EXISTS idx_device_company ON ESF_Device (CompanyId);
            CREATE INDEX IF NOT EXISTS idx_device_status ON ESF_Device (Status, CompanyId);
            CREATE INDEX IF NOT EXISTS idx_campaign_company ON ESF_Campaign (CompanyId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_contact_campaign ON ESF_Contact (CampaignId, Status, ExcluidoEm, ContactId);
            CREATE INDEX IF NOT EXISTS idx_chip_device ON ESF_Chip (DeviceId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_audit_log_company ON ESF_AuditLog (CompanyId, LogId DESC);
            CREATE INDEX IF NOT EXISTS idx_automation_company ON ESF_AutomationRule (CompanyId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_sent_history ON ESF_SentHistory (Phone, CampaignId);
            CREATE INDEX IF NOT EXISTS idx_dev_perm_user ON ESF_DevicePermissionRequest (UserId, Status);
            CREATE INDEX IF NOT EXISTS idx_dev_perm_device ON ESF_DevicePermissionRequest (AdbDeviceId, Status);
            CREATE INDEX IF NOT EXISTS idx_dev_assign_user ON ESF_DeviceAssignment (UserId, AdbDeviceId);
        ")?;

        // Seed do token master (CompanyId = 0) a partir de env HUB_MASTER_TOKEN.
        // Sem isso o hub local não aceita nenhum master. Espelha o hub-standalone.
        if let Ok(token) = std::env::var("HUB_MASTER_TOKEN") {
            if !token.is_empty() {
                let _ = self.upsert_company_token(0, &token, "master");
            }
        }

        Ok(())
    }

    /// Migra tabelas existentes que não tinham as colunas novas
    fn migrate_existing_tables(&self) -> Result<()> {
        // Garantir tabelas de revisão e auditoria de descadastro em bancos já existentes
        let _ = self.conn().execute_batch("
            CREATE TABLE IF NOT EXISTS ESF_OptOutReview (
                ReviewId INTEGER PRIMARY KEY AUTOINCREMENT,
                CompanyId INTEGER NOT NULL DEFAULT 1,
                Title TEXT NOT NULL DEFAULT '',
                Text TEXT NOT NULL DEFAULT '',
                Device TEXT NOT NULL DEFAULT '',
                Status TEXT NOT NULL DEFAULT 'pending',
                ResolvedPhone TEXT DEFAULT NULL,
                ResolvedBy TEXT DEFAULT NULL,
                ResolvedAt TEXT DEFAULT NULL,
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_optout_review_company ON ESF_OptOutReview(CompanyId, Status, ReviewId DESC);
            CREATE TABLE IF NOT EXISTS ESF_OptOutAudit (
                AuditId INTEGER PRIMARY KEY AUTOINCREMENT,
                CompanyId INTEGER NOT NULL DEFAULT 1,
                PhoneDigits TEXT NOT NULL,
                Action TEXT NOT NULL,
                ActorName TEXT NOT NULL DEFAULT '',
                ActorRole TEXT NOT NULL DEFAULT '',
                Detail TEXT NOT NULL DEFAULT '',
                CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_optout_audit_company ON ESF_OptOutAudit(CompanyId, AuditId DESC);
        ");

        // Tabela permanente de identidade vinculada ao Hardware ID
        let _ = self.conn().execute(
            "CREATE TABLE IF NOT EXISTS ESF_DeviceIdentity (
                EsferaDeviceId TEXT PRIMARY KEY,
                CustomName TEXT NOT NULL,
                Sector TEXT NOT NULL DEFAULT 'junior',
                DeviceNumber INTEGER NOT NULL DEFAULT 1,
                Model TEXT DEFAULT '',
                UpdatedAt TEXT NOT NULL
            );",
            [],
        );

        // ESF_Device
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN DeviceNumber INTEGER DEFAULT 1;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN Sector TEXT DEFAULT 'junior';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN EsferaDeviceId TEXT;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN CurrentAdbAddress TEXT;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN LastSeenUTC TEXT;", []);
        // Identidade legada estável e sem colisão entre empresas.
        let _ = self.conn().execute(
            "UPDATE ESF_Device
             SET EsferaDeviceId = 'ESF-LEGACY-' || CompanyId || '-' || rowid
             WHERE EsferaDeviceId IS NULL OR TRIM(EsferaDeviceId) = '';",
            [],
        );
        let _ = self.conn().execute("DROP INDEX IF EXISTS idx_device_esfera_id;", []);
        let _ = self.conn().execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_device_company_esfera_id
             ON ESF_Device(CompanyId, EsferaDeviceId)
             WHERE EsferaDeviceId IS NOT NULL AND TRIM(EsferaDeviceId) != '';",
            [],
        );

        // ESF_Campaign
        let _ = self.conn().execute("ALTER TABLE ESF_Campaign ADD COLUMN SelectedDevices TEXT DEFAULT '';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Campaign ADD COLUMN AiProvider TEXT DEFAULT '';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Campaign ADD COLUMN ExcluidoEm TEXT DEFAULT NULL;", []);

        // ESF_AutomationRule
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN ExcluidoEm TEXT DEFAULT NULL;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN TriggerType TEXT DEFAULT 'keyword';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN ActionType TEXT DEFAULT 'send_response';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN TriggerConfig TEXT DEFAULT '{}';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN ActionConfig TEXT DEFAULT '{}';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_AutomationRule ADD COLUMN Sector TEXT DEFAULT 'junior';", []);

        // ESF_AuditLog
        let _ = self.conn().execute("ALTER TABLE ESF_AuditLog ADD COLUMN ExcluidoEm TEXT DEFAULT NULL;", []);

        // ESF_Chip - novas colunas
        let _ = self.conn().execute("ALTER TABLE ESF_Chip ADD COLUMN Holder TEXT DEFAULT '';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Chip ADD COLUMN IsReserve INTEGER DEFAULT 0;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Chip ADD COLUMN LinkedChipId INTEGER DEFAULT NULL;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Chip ADD COLUMN ExcluidoEm TEXT DEFAULT NULL;", []);

        // ESF_Contact - novas colunas
        let _ = self.conn().execute("ALTER TABLE ESF_Contact ADD COLUMN DeviceId TEXT DEFAULT '';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Contact ADD COLUMN RetryCount INTEGER DEFAULT 0;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Contact ADD COLUMN CustomMessage TEXT DEFAULT '';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Contact ADD COLUMN ExcluidoEm TEXT DEFAULT NULL;", []);
        // Limpeza APENAS de dispositivos mockados de testes 'adb-dev-%' (NUNCA deletar conexões reais Wi-Fi/IP)
        let _ = self.conn().execute("DELETE FROM ESF_Device WHERE AdbDeviceId LIKE 'adb-dev-%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_Campaign WHERE CampaignName LIKE '%Black Friday%' OR CampaignName LIKE '%Julho%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_AutomationRule WHERE RuleName LIKE '%Preço%' OR RuleName LIKE '%Humano%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_AuditLog WHERE Message LIKE '%adb-dev-%';", []);

        // Garante que a empresa #1 seja REALESS e que nenhuma informação seja perdida
        let _ = self.conn().execute("UPDATE ESF_Company SET CompanyName='REALESS' WHERE CompanyId=1 AND (CompanyName='Empresa Principal' OR CompanyName='');", []);

        // Atualização automática de modelos de IA descontinuados/obsoletos do OpenRouter
        let _ = self.conn().execute(
            "UPDATE ESF_Campaign SET AiModel = 'openrouter/free' WHERE AiModel IN ('qwen/qwen-2.5-72b-instruct:free', 'qwen/qwen-2.5-72b-instruct', 'meta-llama/llama-3.3-70b-instruct:free') OR AiModel LIKE '%qwen%72b%';",
            [],
        );
        let _ = self.conn().execute(
            "UPDATE ESF_AiConfig SET Model = 'openrouter/free' WHERE Model IN ('qwen/qwen-2.5-72b-instruct:free', 'qwen/qwen-2.5-72b-instruct', 'meta-llama/llama-3.3-70b-instruct:free') OR Model LIKE '%qwen%72b%';",
            [],
        );
        let _ = self.conn().execute(
            "UPDATE ESF_AiProviderKey SET Model = 'openrouter/free' WHERE Model IN ('qwen/qwen-2.5-72b-instruct:free', 'qwen/qwen-2.5-72b-instruct', 'meta-llama/llama-3.3-70b-instruct:free') OR Model LIKE '%qwen%72b%';",
            [],
        );

        // Performance indexes em tabelas existentes
        let _ = self.conn().execute("CREATE INDEX IF NOT EXISTS idx_contact_campaign_v2 ON ESF_Contact (CampaignId, Status, ExcluidoEm, ContactId);", []);
        let _ = self.conn().execute("CREATE INDEX IF NOT EXISTS idx_device_status ON ESF_Device (Status, CompanyId);", []);

        Ok(())
    }

    fn seed_data(&self) -> Result<()> {
        let conn = self.conn();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM ESF_Company", [], |r| r.get(0))?;

        if count == 0 {
            // Empresa Padrão REALESS
            conn.execute(
                "INSERT INTO ESF_Company (CompanyId, CompanyName, DeviceLimit, UserLimit) VALUES (1, 'REALESS', 100, 50);",
                [],
            )?;

            // Usuários seedados: SOMENTE contas do dono, com senhas não-triviais.
            // Contas de demonstração com senhas fracas (admin/admin, gestor/gestor, colab/colab)
            // FORAM REMOVIDAS — eram fallbacks inseguros.
            let hash_master = hash_password("root123");
            let hash_gestor = hash_password("Ope@2025");

            conn.execute(
                "INSERT INTO ESF_User (Username, PasswordHash, DisplayName, Role, CompanyId) VALUES
                (?1, ?2, 'Vicenzzo Master', 'master', NULL),
                (?3, ?4, 'Vicenzzo Mastronikolis', 'gestor', 1);",
                params![
                    "vicenzzo.master", hash_master,
                    "vicenzzo.mastronikolis", hash_gestor,
                ],
            )?;

            // Permissões padrão para o gestor (UserId = 2)
            conn.execute(
                "INSERT INTO ESF_Permission (UserId, PermissionKey, Enabled) VALUES
                (2, 'allow_all_tabs', 1),
                (2, 'allow_edit_devices', 1),
                (2, 'allow_manage_users', 0),
                (2, 'allow_dashboard', 1),
                (2, 'is_active', 1);",
                [],
            )?;

            // Permissões de setor para o gestor
            conn.execute(
                "INSERT INTO ESF_SectorPermission (UserId, Sector, CanView, CanConfigure) VALUES
                (2, 'junior', 1, 1),
                (2, 'senior', 1, 1),
                (2, 'pesquisa', 1, 0),
                (2, 'pa_fixa_1', 1, 0),
                (2, 'pa_fixa_2', 1, 0);",
                [],
            )?;
        }

        Ok(())
    }

    /// Executa a auditoria e cura nativa automática dos 11 dispositivos oficiais.
    /// Exclui qualquer registro fantasma/legado e assegura a soberania de nomes do operador.
    pub fn audit_and_heal_device_identities(&self) -> Result<()> {
        let conn = self.conn();
        
        // 1. Limpa IDs fantasmas/legados/temporários
        let _ = conn.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%' OR EsferaDeviceId LIKE 'ESF-LEGACY-%';", []);
        let _ = conn.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%' OR EsferaDeviceId LIKE 'ESF-LEGACY-%' OR EsferaDeviceId IS NULL;", []);
        
        // 2. Tabela de Mapeamento Nativo dos 11 Aparelhos
        let devices_map = [
            ("ESF-MMULT000", "1", 1, "MMULT0003016521", "192.168.1.41:5555", "192.168.1.41", "Multilaser"),
            ("ESF-52005950", "2", 2, "192.168.1.75:5555", "192.168.1.75:5555", "192.168.1.75", "Samsung"),
            ("ESF-42000D48", "3", 3, "42000d4801386585", "192.168.1.56:5555", "192.168.1.56", "Samsung"),
            ("ESF-1P924A80", "4", 4, "1P924A802201272", "192.168.1.42:5555", "192.168.1.42", "Multilaser"),
            ("ESF-420012CA", "5", 5, "420012cad28ca5c7", "192.168.1.73:5555", "192.168.1.73", "Samsung"),
            ("ESF-5A323K71", "6", 6, "5A323K71N", "192.168.1.63:5555", "192.168.1.63", "Positivo"),
            ("ESF-4200DA85", "7", 7, "192.168.1.151:5555", "192.168.1.151:5555", "192.168.1.151", "Samsung"),
            ("ESF-5A337TP0", "9", 9, "5A337TP07", "192.168.1.63:5555", "192.168.1.63", "Positivo"),
            ("ESF-00829256", "10", 10, "192.168.1.83:5555", "192.168.1.83:5555", "192.168.1.83", "Motorola"),
            ("ESF-0N14619I", "11", 11, "0N14619I241030D7", "192.168.1.100:5555", "192.168.1.100", "Realme"),
            ("ESF-EH428L00", "12", 12, "192.168.1.82:5555", "192.168.1.82:5555", "192.168.1.82", "Redmi"),
        ];

        let now = chrono::Utc::now().to_rfc3339();

        for (esf_id, default_name, num, usb_serial, adb_addr, ip, model) in devices_map {
            // Garante que o ESF_DeviceIdentity exista (respeitando o CustomName caso já tenha sido personalizado pelo operador)
            let _ = conn.execute(
                "INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
                 VALUES (?1, ?2, 'junior', ?3, ?4, ?5)
                 ON CONFLICT(EsferaDeviceId) DO UPDATE SET
                    DeviceNumber = excluded.DeviceNumber,
                    Model = CASE WHEN ESF_DeviceIdentity.Model IS NULL OR ESF_DeviceIdentity.Model = '' THEN excluded.Model ELSE ESF_DeviceIdentity.Model END,
                    UpdatedAt = excluded.UpdatedAt;",
                params![esf_id, default_name, num, model, now],
            );

            // Garante que a linha ESF_Device esteja cadastrada com a chave primária oficial AdbDeviceId
            let _ = conn.execute(
                "INSERT INTO ESF_Device (AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC)
                 VALUES (?1, ?2, 'Android', ?3, ?4, 5555, 'online', 100, 1, ?5, 'junior', ?6, ?7, ?8)
                 ON CONFLICT(AdbDeviceId) DO UPDATE SET
                    DeviceNumber = excluded.DeviceNumber,
                    EsferaDeviceId = excluded.EsferaDeviceId,
                    -- IP/endereço são voláteis: só preenche se vazio, nunca volta para o IP antigo da tabela
                    CurrentAdbAddress = COALESCE(NULLIF(ESF_Device.CurrentAdbAddress, ''), excluded.CurrentAdbAddress),
                    DeviceIp = COALESCE(NULLIF(ESF_Device.DeviceIp, ''), excluded.DeviceIp);",
                params![usb_serial, default_name, model, ip, num, esf_id, adb_addr, now],
            );
        }

        Ok(())
    }


    // ============================================================
    // AUTENTICAÇÃO (com hash)
    // ============================================================

    pub fn authenticate(&self, user_name: &str, pass: &str) -> Option<User> {
        // Busca o hash armazenado
        let stored_hash: String = self.conn().query_row(
            "SELECT PasswordHash FROM ESF_User WHERE Username = ?1 AND IsActive = 1",
            params![user_name],
            |row| row.get(0),
        ).ok()?;

        // Verifica o hash
        if !verify_password(pass, &stored_hash) {
            return None;
        }

        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT UserId, Username, DisplayName, Role, CompanyId, IsActive FROM ESF_User WHERE Username = ?1 AND IsActive = 1"
        ).ok()?;

        stmt.query_row(params![user_name], |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                display_name: row.get(2)?,
                role: row.get(3)?,
                company_id: row.get(4)?,
                is_active: row.get(5)?,
            })
        }).ok()
    }

    // ============================================================
    // EMPRESAS
    // ============================================================

    pub fn get_companies(&self) -> Vec<Company> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT c.CompanyId, c.CompanyName, c.DeviceLimit, c.UserLimit, c.IsActive, c.CreatedAt,
                    (SELECT COUNT(*) FROM ESF_Device d WHERE d.CompanyId = c.CompanyId) AS DeviceCount,
                    (SELECT COUNT(*) FROM ESF_User u WHERE u.CompanyId = c.CompanyId) AS UserCount
             FROM ESF_Company c"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map([], |row| {
            let is_act: bool = row.get::<_, i32>(4)? == 1;
            Ok(Company {
                id: row.get(0)?,
                name: row.get(1)?,
                device_limit: row.get(2)?,
                user_limit: row.get(3)?,
                is_active: is_act,
                status: if is_act { "active".to_string() } else { "inactive".to_string() },
                created_at: row.get(5)?,
                device_count: row.get(6).unwrap_or(0),
                user_count: row.get(7).unwrap_or(0),
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn create_company(&self, name: &str, device_limit: i32) -> Result<Company, String> {
        self.conn()
            .execute(
                "INSERT INTO ESF_Company (CompanyName, DeviceLimit) VALUES (?1, ?2)",
                params![name, device_limit],
            )
            .map_err(|e| e.to_string())?;

        let last_id = self.conn().last_insert_rowid() as i32;
        Ok(Company {
            id: last_id,
            name: name.to_string(),
            device_limit,
            user_limit: 10,
            device_count: 0,
            user_count: 1,
            is_active: true,
            status: "active".to_string(),
            created_at: chrono::Utc::now().format("%Y-%m-%d").to_string(),
        })
    }

    pub fn update_company(&self, id: i32, name: &str, device_limit: i32, user_limit: i32, is_active: bool) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Company SET CompanyName=?1, DeviceLimit=?2, UserLimit=?3, IsActive=?4 WHERE CompanyId=?5;",
            params![name, device_limit, user_limit, if is_active { 1 } else { 0 }, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // DISPOSITIVOS
    // ============================================================

    pub fn get_devices(&self, company_id: i32) -> Vec<Device> {
        let sql = if company_id > 0 {
            "SELECT rowid, AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC FROM ESF_Device WHERE CompanyId = ?1"
        } else {
            "SELECT rowid, AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC FROM ESF_Device"
        };

        let conn = match self.pooled_conn() {
            Ok(conn) => conn,
            Err(_) => return vec![],
        };
        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let mapper = |row: &rusqlite::Row| {
            Ok(Device {
                id: row.get(0)?,
                serial: row.get(1)?,
                name: row.get(2)?,
                brand: row.get(3)?,
                model: row.get(4)?,
                ip: row.get(5)?,
                port: row.get(6)?,
                status: row.get(7)?,
                battery: row.get(8)?,
                company_id: row.get(9)?,
                device_number: row.get(10)?,
                sector: row.get(11)?,
                esfera_device_id: row.get(12)?,
                current_adb_address: row.get(13)?,
                last_seen_utc: row.get(14)?,
                via_tunnel: false,
            })
        };

        let rows = if company_id > 0 {
            stmt.query_map(params![company_id], mapper)
        } else {
            stmt.query_map([], mapper)
        };
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// Salva o vínculo permanente do Nome, Setor e Número ao Hardware ID (EsferaDeviceId)
    pub fn save_device_identity(&self, esfera_id: &str, name: &str, sector: &str, num: i32, model: &str) -> Result<(), String> {
        if esfera_id.trim().is_empty() { return Ok(()); }
        let now = chrono::Utc::now().to_rfc3339();
        self.exec_retry(
            "INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(EsferaDeviceId) DO UPDATE SET
                CustomName = CASE WHEN ?2 != '' THEN ?2 ELSE ESF_DeviceIdentity.CustomName END,
                Sector = CASE WHEN ?3 != '' THEN ?3 ELSE ESF_DeviceIdentity.Sector END,
                DeviceNumber = CASE WHEN ?4 > 0 THEN ?4 ELSE ESF_DeviceIdentity.DeviceNumber END,
                Model = CASE WHEN ?5 != '' THEN ?5 ELSE ESF_DeviceIdentity.Model END,
                UpdatedAt = ?6;",
            params![esfera_id, name, sector, num, model, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Obtém os dados de identidade permanente ancorados ao Hardware ID
    pub fn get_device_identity(&self, esfera_id: &str) -> Option<(String, String, i32, String)> {
        if esfera_id.trim().is_empty() { return None; }
        let conn = self.conn();
        conn.query_row(
            "SELECT CustomName, Sector, DeviceNumber, Model FROM ESF_DeviceIdentity WHERE EsferaDeviceId = ?1",
            params![esfera_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).ok()
    }

    /// Gera o menor número sequencial único global disponível (1, 2, 3...) para evitar saltos ou duplicatas
    pub fn get_next_device_number(&self) -> i32 {
        let conn = self.conn();
        let mut used = std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT DeviceNumber FROM ESF_DeviceIdentity WHERE DeviceNumber > 0 UNION SELECT DeviceNumber FROM ESF_Device WHERE DeviceNumber > 0") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, i32>(0)) {
                for r in rows.flatten() {
                    used.insert(r);
                }
            }
        }
        for n in 1..=999 {
            if !used.contains(&n) {
                return n;
            }
        }
        1
    }

    pub fn update_device_config(&self, device: &Device) -> Result<(), String> {
        let target_comp = if device.company_id <= 0 { 1 } else { device.company_id };
        let serial = &device.serial;
        let esfera_id = device.esfera_device_id.as_deref().unwrap_or("");
        let adb_addr = device.current_adb_address.as_deref().unwrap_or("");

        // Ancora permanentemente na tabela ESF_DeviceIdentity para nunca perder o nome
        if !esfera_id.is_empty() {
            let _ = self.save_device_identity(esfera_id, &device.name, &device.sector, device.device_number, &device.model);
        }

        self.exec_retry(
            "UPDATE ESF_Device SET
                DeviceName = ?1,
                Model = ?2,
                Sector = ?3,
                DeviceNumber = ?4,
                EsferaDeviceId = CASE WHEN ?6 != '' THEN ?6 ELSE EsferaDeviceId END
             WHERE ((?6 != '' AND EsferaDeviceId = ?6)
                    OR AdbDeviceId = ?5
                    OR CurrentAdbAddress = ?5
                    OR (?7 != '' AND CurrentAdbAddress = ?7))
               AND CompanyId = ?8",
            params![
                device.name,
                device.model,
                device.sector,
                device.device_number,
                serial,
                esfera_id,
                adb_addr,
                target_comp,
            ],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn upsert_device(&self, device: &Device) -> Result<(), String> {
        let target_comp = if device.company_id <= 0 { 1 } else { device.company_id };

        // Se existir identidade permanente na ESF_DeviceIdentity para este Hardware ID, sincroniza
        let (final_name, final_sector, final_num) = if let Some(ref esfera_id) = device.esfera_device_id {
            if let Some((saved_name, saved_sec, saved_num, _)) = self.get_device_identity(esfera_id) {
                // SOBERANIA DO OPERADOR: Nome existente é 100% IMUTÁVEL e PERPÉTUO
                (saved_name, saved_sec, saved_num)
            } else if !device.name.is_empty() && device.name != "Aparelho 1" && !device.name.starts_with("Aparelho ") {
                let _ = self.save_device_identity(esfera_id, &device.name, &device.sector, device.device_number, &device.model);
                (device.name.clone(), device.sector.clone(), device.device_number)
            } else {
                let next_num = self.get_next_device_number();
                let clean_id = esfera_id.replace("ESF-", "").to_uppercase().replace(':', "").replace('.', "");
                let gen_name = format!("Celular {}", if clean_id.is_empty() { next_num.to_string() } else { clean_id.chars().take(8).collect() });
                let _ = self.save_device_identity(esfera_id, &gen_name, &device.sector, next_num, &device.model);
                (gen_name, device.sector.clone(), next_num)
            }
        } else {
            (device.name.clone(), device.sector.clone(), device.device_number)
        };

        // EsferaDeviceId identifica o aparelho; IP:porta/USB são somente transporte.
        if let Some(ref esfera_id) = device.esfera_device_id {
            if !esfera_id.trim().is_empty() {
                let affected = self.exec_retry(
                    "UPDATE ESF_Device SET
                        DeviceName = CASE 
                            WHEN ?2 IS NOT NULL AND ?2 != '' THEN ?2 
                            WHEN ESF_Device.DeviceName IS NOT NULL AND ESF_Device.DeviceName != '' THEN ESF_Device.DeviceName
                            ELSE ?2 
                        END,
                        Brand=?1, Model=?3, DeviceIp=?4,
                        DevicePort=?5, Status=?6, BatteryLevel=?7,
                        CurrentAdbAddress=?8, LastSeenUTC=?9,
                        Sector=?12, DeviceNumber=?13
                     WHERE CompanyId=?10 AND EsferaDeviceId=?11",
                    params![device.brand, final_name, device.model, device.ip, device.port,
                        device.status, device.battery, device.current_adb_address,
                        device.last_seen_utc, target_comp, esfera_id, final_sector, final_num],
                ).map_err(|e| e.to_string())?;
                if affected > 0 { return Ok(()); }
            }
        }
        // 1.5. Tenta por CurrentAdbAddress ou DeviceIp para prevenir duplicatas de IP
        let target_addr = device.current_adb_address.as_deref().unwrap_or(&device.serial);
        if !target_addr.is_empty() {
            let affected = self.exec_retry(
                "UPDATE ESF_Device SET
                    Status = ?1,
                    BatteryLevel = ?2,
                    CurrentAdbAddress = ?3,
                    LastSeenUTC = ?4,
                    EsferaDeviceId = COALESCE(?5, EsferaDeviceId)
                 WHERE CompanyId = ?6 AND (CurrentAdbAddress = ?3 OR (DeviceIp = ?7 AND ?7 != ''))",
                params![
                    device.status,
                    device.battery,
                    target_addr,
                    device.last_seen_utc,
                    device.esfera_device_id,
                    target_comp,
                    device.ip,
                ],
            ).unwrap_or(0);
            if affected > 0 { return Ok(()); }
        }

        // 2. Se não encontrou linha existente por EsferaDeviceId ou IP, insere ou atualiza por AdbDeviceId
        self.exec_retry(
            "INSERT INTO ESF_Device (AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(AdbDeviceId) DO UPDATE SET
            DeviceName=CASE 
                WHEN ?2 IS NOT NULL AND ?2 != '' AND ?2 != 'Aparelho 1' THEN ?2
                WHEN ESF_Device.DeviceName IS NOT NULL AND ESF_Device.DeviceName != '' THEN ESF_Device.DeviceName
                WHEN excluded.DeviceName IS NOT NULL AND excluded.DeviceName != '' THEN excluded.DeviceName 
                ELSE ?2 
            END,
            Brand=excluded.Brand, Model=excluded.Model,
            DeviceIp=excluded.DeviceIp, DevicePort=excluded.DevicePort, Status=excluded.Status,
            BatteryLevel=excluded.BatteryLevel,
            DeviceNumber=CASE WHEN ?10 > 0 THEN ?10 WHEN ESF_Device.DeviceNumber > 0 THEN ESF_Device.DeviceNumber ELSE excluded.DeviceNumber END,
            Sector=CASE WHEN ?11 != '' THEN ?11 WHEN ESF_Device.Sector != '' THEN ESF_Device.Sector ELSE excluded.Sector END,
            EsferaDeviceId=COALESCE(excluded.EsferaDeviceId, ESF_Device.EsferaDeviceId),
            CurrentAdbAddress=excluded.CurrentAdbAddress, LastSeenUTC=excluded.LastSeenUTC;",
            params![
                device.serial,
                final_name,
                device.brand,
                device.model,
                device.ip,
                device.port,
                device.status,
                device.battery,
                target_comp,
                final_num,
                final_sector,
                device.esfera_device_id,
                device.current_adb_address,
                device.last_seen_utc,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atualiza exclusivamente o status em tempo real e nível de bateria (ex: ao ficar offline),
    /// preservando 100% intactos o nome, setor, numeração e identidade do aparelho.
    pub fn set_device_runtime_state(
        &self,
        serial: &str,
        esfera_id: Option<&str>,
        company_id: i32,
        status: &str,
        battery: i32,
    ) {
        let target_comp = if company_id <= 0 { 1 } else { company_id };
        let eid = esfera_id.unwrap_or("").trim();
        let _ = self.exec_retry(
            "UPDATE ESF_Device SET Status = ?1, BatteryLevel = ?2
             WHERE CompanyId = ?3
               AND (AdbDeviceId = ?4 OR (?5 != '' AND EsferaDeviceId = ?5))",
            params![status, battery, target_comp, serial, eid],
        );
    }


    /// Atualiza imediatamente o IP volátil e status online de um dispositivo usando o EsferaDeviceId perpétuo como única fonte da verdade
    pub fn update_device_network_by_id(&self, device_id: &str, ip: &str, port: i32) -> Result<(), String> {
        let adb_address = format!("{}:{}", ip, port);
        let upper_id = device_id.to_uppercase();
        let now = chrono::Utc::now().to_rfc3339();

        let _ = self.exec_retry(
            "UPDATE ESF_Device SET
                CurrentAdbAddress = ?1,
                DeviceIp = ?2,
                DevicePort = ?3,
                Status = 'online',
                LastSeenUTC = ?4
             WHERE EsferaDeviceId = ?5 OR UPPER(EsferaDeviceId) = ?6
                OR AdbDeviceId = ?5 OR UPPER(AdbDeviceId) = ?6",
            params![adb_address, ip, port, now, device_id, upper_id],
        );

        let _ = self.exec_retry(
            "UPDATE ESF_DeviceIdentity SET
                CurrentAdbAddress = ?1,
                DeviceIp = ?2,
                DevicePort = ?3,
                Status = 'online',
                LastSeenUTC = ?4
             WHERE EsferaDeviceId = ?5 OR UPPER(EsferaDeviceId) = ?6",
            params![adb_address, ip, port, now, device_id, upper_id],
        );

        Ok(())
    }

    pub fn get_all_devices(&self) -> Vec<Device> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT rowid, AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC FROM ESF_Device"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map([], |row| {
            Ok(Device {
                id: row.get(0)?,
                serial: row.get(1)?,
                name: row.get(2)?,
                brand: row.get(3)?,
                model: row.get(4)?,
                ip: row.get(5)?,
                port: row.get(6)?,
                status: row.get(7)?,
                battery: row.get(8)?,
                company_id: row.get(9)?,
                device_number: row.get(10)?,
                sector: row.get(11)?,
                esfera_device_id: row.get(12)?,
                current_adb_address: row.get(13)?,
                last_seen_utc: row.get(14)?,
                via_tunnel: false,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }
    pub fn delete_device(&self, serial: &str) -> Result<(), String> {
        let conn = self.conn();
        let _ = conn.execute(
            "DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId = ?1 OR EsferaDeviceId IN (SELECT EsferaDeviceId FROM ESF_Device WHERE AdbDeviceId = ?1 OR CurrentAdbAddress = ?1);",
            params![serial],
        );
        conn.execute(
            "DELETE FROM ESF_Device WHERE AdbDeviceId = ?1 OR EsferaDeviceId = ?1 OR CurrentAdbAddress = ?1;",
            params![serial],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn process_checkin(&self, device_id: &str, adb_address: &str, ip: &str, port: u16, now: &str, adb_serial: &str) -> Result<usize, String> {
        let upper_id = device_id.to_uppercase();
        let upper_serial = adb_serial.to_uppercase();
        let affected = self.exec_retry(
            "UPDATE ESF_Device SET
                CurrentAdbAddress = ?1,
                Status = 'online',
                LastSeenUTC = ?2,
                DeviceIp = ?3,
                DevicePort = ?4,
                EsferaDeviceId = COALESCE(EsferaDeviceId, ?5),
                AdbDeviceId = COALESCE(NULLIF(?7, ''), AdbDeviceId)
             WHERE EsferaDeviceId = ?5
                OR UPPER(EsferaDeviceId) = ?6
                OR AdbDeviceId = ?5
                OR UPPER(AdbDeviceId) = ?6
                OR (NULLIF(?7, '') IS NOT NULL AND (AdbDeviceId = ?7 OR UPPER(AdbDeviceId) = ?8))
                OR DeviceIp = ?3
                OR CurrentAdbAddress = ?1",
            params![adb_address, now, ip, port, device_id, upper_id, adb_serial, upper_serial],
        ).map_err(|e| e.to_string())?;

        Ok(affected)
    }

    pub fn insert_unknown_device(&self, device_id: &str, adb_address: &str, ip: &str, port: u16, now: &str, adb_serial: &str) -> Result<usize, String> {
        let upper_id = device_id.to_uppercase();
        let upper_serial = adb_serial.to_uppercase();
        let affected = self.exec_retry(
            "UPDATE ESF_Device SET
                EsferaDeviceId = COALESCE(EsferaDeviceId, ?1),
                CurrentAdbAddress = ?2,
                Status = 'online',
                LastSeenUTC = ?3,
                DeviceIp = ?4,
                DevicePort = ?5,
                AdbDeviceId = COALESCE(NULLIF(?7, ''), AdbDeviceId)
             WHERE DeviceIp = ?4 OR CurrentAdbAddress = ?2 OR AdbDeviceId = ?1 OR UPPER(AdbDeviceId) = ?6
                OR (NULLIF(?7, '') IS NOT NULL AND (AdbDeviceId = ?7 OR UPPER(AdbDeviceId) = ?8))",
            params![device_id, adb_address, now, ip, port, upper_id, adb_serial, upper_serial],
        ).map_err(|e| e.to_string())?;

        if affected > 0 {
            return Ok(affected);
        }

        let final_adb_id = if !adb_serial.is_empty() { adb_serial.to_string() } else { device_id.to_string() };
        self.exec_retry(
            "INSERT INTO ESF_Device (AdbDeviceId, EsferaDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, CurrentAdbAddress, LastSeenUTC)
             VALUES (?1, ?2, ?3, 'Android', 'Smartphone', ?4, ?5, 'online', 100, 1, 0, 'junior', ?6, ?7)",
            params![final_adb_id, device_id, format!("Celular {}", ip), ip, port, adb_address, now],
        ).map_err(|e| e.to_string())
    }

    pub fn mark_device_online(&self, rowid: i32, adb_addr: &str) -> Result<(), String> {
        self.exec_retry(
            "UPDATE ESF_Device SET Status = 'online', CurrentAdbAddress = ?1 WHERE rowid = ?2",
            params![adb_addr, rowid],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_device_esfera_id(&self, serial_or_address: &str, esfera_id: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Device SET EsferaDeviceId = ?1
             WHERE AdbDeviceId = ?2 OR CurrentAdbAddress = ?2",
            params![esfera_id, serial_or_address],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_stale_devices_offline(&self, timeout_seconds: i32) -> Result<usize, String> {
        let sql = format!(
            "UPDATE ESF_Device SET Status = 'offline'
             WHERE EsferaDeviceId IS NOT NULL
             AND Status = 'online'
             AND LastSeenUTC IS NOT NULL
             AND datetime(LastSeenUTC) < datetime('now', '-{} seconds')",
            timeout_seconds
        );
        self.exec_retry(&sql, &[]).map_err(|e| e.to_string())
    }

    pub fn get_device_by_esfera_id(&self, esfera_device_id: &str) -> Option<Device> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT rowid, AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC
             FROM ESF_Device WHERE EsferaDeviceId = ?1"
        ).ok()?;

        stmt.query_row(params![esfera_device_id], |row| {
            Ok(Device {
                id: row.get(0)?,
                serial: row.get(1)?,
                name: row.get(2)?,
                brand: row.get(3)?,
                model: row.get(4)?,
                ip: row.get(5)?,
                port: row.get(6)?,
                status: row.get(7)?,
                battery: row.get(8)?,
                company_id: row.get(9)?,
                device_number: row.get(10)?,
                sector: row.get(11)?,
                esfera_device_id: row.get(12)?,
                current_adb_address: row.get(13)?,
                last_seen_utc: row.get(14)?,
                via_tunnel: false,
            })
        }).ok()
    }

    // ============================================================
    // CAMPANHAS (com soft delete)
    // ============================================================

    pub fn get_campaigns(&self, company_id: i32) -> Vec<Campaign> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT CampaignId, CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId, UpdatedAt, SelectedDevices, AiProvider
             FROM ESF_Campaign WHERE CompanyId = ?1 AND ExcluidoEm IS NULL"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(Campaign {
                id: row.get(0)?,
                name: row.get(1)?,
                greeting: row.get(2)?,
                message: row.get(3)?,
                closing: row.get(4)?,
                delay_min: row.get(5)?,
                delay_max: row.get(6)?,
                use_spintax: row.get::<_, i32>(7)? == 1,
                use_ai: row.get::<_, i32>(8)? == 1,
                ai_model: row.get(9)?,
                ai_provider: row.get(18)?,
                ai_prompt: row.get(10)?,
                device_ids: serde_json::from_str(&row.get::<_, String>(17)?).unwrap_or_default(),
                status: row.get(11)?,
                contacts_count: row.get(12)?,
                sent_count: row.get(13)?,
                failed_count: row.get(14)?,
                company_id: row.get(15)?,
                updated_at: row.get(16)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn get_campaign_company_id(&self, campaign_id: i32) -> Option<i32> {
        self.conn().query_row(
            "SELECT CompanyId FROM ESF_Campaign WHERE CampaignId=?1 AND ExcluidoEm IS NULL",
            params![campaign_id], |row| row.get(0),
        ).ok()
    }

    pub fn create_campaign(&self, c: &Campaign) -> Result<i32, String> {
        self.conn().execute(
            "INSERT INTO ESF_Campaign (CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId, SelectedDevices, AiProvider)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17);",
            params![
                c.name,
                c.greeting,
                c.message,
                c.closing,
                c.delay_min,
                c.delay_max,
                if c.use_spintax { 1 } else { 0 },
                if c.use_ai { 1 } else { 0 },
                c.ai_model,
                c.ai_prompt,
                c.status,
                c.contacts_count,
                c.sent_count,
                c.failed_count,
                c.company_id,
                serde_json::to_string(&c.device_ids).map_err(|e| e.to_string())?,
                c.ai_provider,
            ]
        ).map_err(|e| e.to_string())?;
        Ok(self.conn().last_insert_rowid() as i32)
    }

    pub fn get_running_campaigns(&self) -> Result<Vec<Campaign>> {
        let conn = self.pooled_conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT CampaignId, CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId, UpdatedAt, SelectedDevices, AiProvider FROM ESF_Campaign WHERE Status = 'running' AND ExcluidoEm IS NULL"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Campaign {
                id: row.get(0)?,
                name: row.get(1)?,
                greeting: row.get(2)?,
                message: row.get(3)?,
                closing: row.get(4)?,
                delay_min: row.get(5)?,
                delay_max: row.get(6)?,
                use_spintax: row.get::<_, i32>(7)? == 1,
                use_ai: row.get::<_, i32>(8)? == 1,
                ai_model: row.get(9)?,
                ai_provider: row.get(18)?,
                ai_prompt: row.get(10)?,
                device_ids: serde_json::from_str(&row.get::<_, String>(17)?).unwrap_or_default(),
                status: row.get(11)?,
                contacts_count: row.get(12)?,
                sent_count: row.get(13)?,
                failed_count: row.get(14)?,
                company_id: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn increment_campaign_sent_count(&self, campaign_id: i32) -> Result<()> {
        self.exec_retry(
            "UPDATE ESF_Campaign SET SentContacts = SentContacts + 1, UpdatedAt = datetime('now') WHERE CampaignId = ?1",
            params![campaign_id],
        )?;
        Ok(())
    }

    pub fn update_campaign(&self, c: &Campaign) -> Result<(), String> {
        let updated = self.conn().execute(
            "UPDATE ESF_Campaign SET CampaignName=?1, MessageGreeting=?2, MessageBody=?3, MessageClosing=?4,
             DelayMin=?5, DelayMax=?6, UseSpintax=?7, UseAI=?8, AiModel=?9, AiPrompt=?10,
             SelectedDevices=?11, AiProvider=?12, UpdatedAt=datetime('now')
             WHERE CampaignId=?13 AND CompanyId=?14 AND ExcluidoEm IS NULL;",
            params![
                c.name, c.greeting, c.message, c.closing,
                c.delay_min, c.delay_max,
                if c.use_spintax { 1 } else { 0 },
                if c.use_ai { 1 } else { 0 },
                c.ai_model, c.ai_prompt,
                serde_json::to_string(&c.device_ids).map_err(|e| e.to_string())?,
                c.ai_provider,
                c.id,
                c.company_id,
            ]
        ).map_err(|e| e.to_string())?;
        if updated == 0 { return Err("Campanha não encontrada nesta empresa.".to_string()); }
        Ok(())
    }

    pub fn soft_delete_campaign(&self, id: i32) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            let changed = conn.execute(
                "UPDATE ESF_Campaign SET ExcluidoEm=datetime('now'), Status='stopped' WHERE CampaignId=?1 AND ExcluidoEm IS NULL AND Status != 'running';",
                params![id],
            ).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("Campanha não encontrada ou em andamento. Pare a campanha antes de excluí-la.".to_string());
            }
            conn.execute(
                "UPDATE ESF_Contact SET ExcluidoEm=datetime('now') WHERE CampaignId=?1 AND ExcluidoEm IS NULL;",
                params![id],
            ).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| { let _ = conn.execute_batch("ROLLBACK;"); e.to_string() }),
            Err(e) => { let _ = conn.execute_batch("ROLLBACK;"); Err(e) }
        }
    }

    pub fn set_campaign_status(&self, id: i32, status: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Campaign SET Status=?1, UpdatedAt=datetime('now') WHERE CampaignId=?2 AND ExcluidoEm IS NULL;",
            params![status, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // AUTOMAÇÕES (com soft delete)
    // ============================================================

    pub fn get_automations(&self, company_id: i32) -> Vec<AutomationRule> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT RuleId, RuleName, Keyword, ResponseText, IsActive, TriggeredCount, CompanyId,
             COALESCE(TriggerType,'keyword'), COALESCE(ActionType,'send_response'),
             COALESCE(TriggerConfig,'{}'), COALESCE(ActionConfig,'{}'), COALESCE(Sector,'junior')
             FROM ESF_AutomationRule WHERE CompanyId = ?1 AND ExcluidoEm IS NULL"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(AutomationRule {
                id: row.get(0)?,
                name: row.get(1)?,
                keyword: row.get(2)?,
                response: row.get(3)?,
                active: row.get::<_, i32>(4)? == 1,
                triggered_count: row.get(5)?,
                company_id: row.get(6)?,
                trigger_type: row.get(7)?,
                action_type: row.get(8)?,
                trigger_config: row.get(9)?,
                action_config: row.get(10)?,
                sector: row.get(11)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn create_automation(&self, a: &AutomationRule) -> Result<i32, String> {
        self.conn().execute(
            "INSERT INTO ESF_AutomationRule (RuleName, Keyword, ResponseText, IsActive, TriggeredCount, CompanyId,
             TriggerType, ActionType, TriggerConfig, ActionConfig, Sector)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
            params![
                a.name,
                a.keyword,
                a.response,
                if a.active { 1 } else { 0 },
                a.triggered_count,
                a.company_id,
                a.trigger_type,
                a.action_type,
                a.trigger_config,
                a.action_config,
                a.sector,
            ]
        ).map_err(|e| e.to_string())?;
        Ok(self.conn().last_insert_rowid() as i32)
    }

    pub fn update_automation(&self, a: &AutomationRule) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_AutomationRule SET RuleName=?1, Keyword=?2, ResponseText=?3, IsActive=?4,
             TriggerType=?5, ActionType=?6, TriggerConfig=?7, ActionConfig=?8, Sector=?9
             WHERE RuleId=?10 AND ExcluidoEm IS NULL;",
            params![a.name, a.keyword, a.response, if a.active { 1 } else { 0 },
                    a.trigger_type, a.action_type, a.trigger_config, a.action_config, a.sector, a.id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn soft_delete_automation(&self, id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_AutomationRule SET ExcluidoEm=datetime('now') WHERE RuleId=?1;",
            params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // LOGS (com soft delete)
    // ============================================================

    pub fn get_logs(&self, company_id: i32) -> Vec<AuditLog> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT LogId, Timestamp, LogType, Source, Message, CompanyId
             FROM ESF_AuditLog WHERE CompanyId = ?1 AND ExcluidoEm IS NULL ORDER BY LogId DESC LIMIT 100"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(AuditLog {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                log_type: row.get(2)?,
                source: row.get(3)?,
                message: row.get(4)?,
                company_id: row.get(5)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn add_log(&self, company_id: i32, log_type: &str, source: &str, message: &str) -> Result<(), String> {
        self.exec_retry(
            "INSERT INTO ESF_AuditLog (CompanyId, LogType, Source, Message) VALUES (?1, ?2, ?3, ?4);",
            params![company_id, log_type, source, message],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_logs(&self, company_id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_AuditLog SET ExcluidoEm=datetime('now') WHERE CompanyId=?1 AND ExcluidoEm IS NULL;",
            params![company_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // CHIPS (com 6 status, holder, reservas)
    // ============================================================

    pub fn get_chips(&self, device_id: i32) -> Vec<Chip> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT ChipId, DeviceId, PhoneNumber, ChipName, Status, RestrictedUntil, CreatedAt
             FROM ESF_Chip WHERE DeviceId = ?1 AND ExcluidoEm IS NULL ORDER BY ChipId DESC"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![device_id], |row| {
            Ok(Chip {
                id: row.get(0)?,
                device_id: row.get(1)?,
                phone_number: row.get(2)?,
                chip_name: row.get(3)?,
                status: row.get(4)?,
                restricted_until: row.get(5)?,
                created_at: row.get(6)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn add_chip(&self, device_id: i32, phone: &str, name: &str) -> Result<i32, String> {
        self.conn().execute(
            "INSERT INTO ESF_Chip (DeviceId, PhoneNumber, ChipName, Status) VALUES (?1, ?2, ?3, 'livre');",
            params![device_id, phone, name],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn().last_insert_rowid() as i32)
    }

    pub fn update_chip_status(&self, chip_id: i32, status: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET Status = ?1 WHERE ChipId = ?2 AND ExcluidoEm IS NULL;",
            params![status, chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_chip_restriction(&self, chip_id: i32, status: &str, restricted_until: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET Status=?1, RestrictedUntil=?2 WHERE ChipId=?3 AND ExcluidoEm IS NULL;",
            params![status, restricted_until, chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn confirm_chip_release(&self, chip_id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET Status='livre', RestrictedUntil=NULL WHERE ChipId=?1 AND ExcluidoEm IS NULL;",
            params![chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn move_chip(&self, chip_id: i32, target_device_id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET DeviceId=?1 WHERE ChipId=?2 AND ExcluidoEm IS NULL;",
            params![target_device_id, chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_chip_holder(&self, chip_id: i32, holder: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET Holder=?1 WHERE ChipId=?2 AND ExcluidoEm IS NULL;",
            params![holder, chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_chip_reserve(&self, chip_id: i32, is_reserve: bool) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Chip SET IsReserve=?1 WHERE ChipId=?2 AND ExcluidoEm IS NULL;",
            params![if is_reserve { 1 } else { 0 }, chip_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_restricted_chips_without_reserve(&self, company_id: i32) -> Vec<Chip> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT c.ChipId, c.DeviceId, c.PhoneNumber, c.ChipName, c.Status, c.RestrictedUntil, c.CreatedAt
             FROM ESF_Chip c
             JOIN ESF_Device d ON c.DeviceId = d.rowid
             WHERE d.CompanyId = ?1
             AND c.ExcluidoEm IS NULL
             AND c.Status IN ('banido', 'restrito_24h', 'restrito_7d', 'restrito_custom')
             AND c.IsReserve = 0
             AND c.LinkedChipId IS NULL
             ORDER BY c.DeviceId, c.ChipName"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(Chip {
                id: row.get(0)?,
                device_id: row.get(1)?,
                phone_number: row.get(2)?,
                chip_name: row.get(3)?,
                status: row.get(4)?,
                restricted_until: row.get(5)?,
                created_at: row.get(6)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    // ============================================================
    // CONTATOS (com soft delete, retry, custom_message)
    // ============================================================

    pub fn get_contacts(&self, campaign_id: i32) -> Vec<Contact> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT ContactId, CampaignId, ContactName, Phone, Status, SentAt
             FROM ESF_Contact WHERE CampaignId = ?1 AND ExcluidoEm IS NULL ORDER BY ContactId ASC"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![campaign_id], |row| {
            Ok(Contact {
                id: row.get(0)?,
                campaign_id: row.get(1)?,
                contact_name: row.get(2)?,
                phone: row.get(3)?,
                status: row.get(4)?,
                sent_at: row.get(5)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn get_pending_contacts(&self, campaign_id: i32, limit: i32) -> Vec<Contact> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT ContactId, CampaignId, ContactName, Phone, Status, SentAt
             FROM ESF_Contact WHERE CampaignId = ?1 AND Status = 'pending' AND ExcluidoEm IS NULL
             ORDER BY ContactId ASC LIMIT ?2"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![campaign_id, limit], |row| {
            Ok(Contact {
                id: row.get(0)?,
                campaign_id: row.get(1)?,
                contact_name: row.get(2)?,
                phone: row.get(3)?,
                status: row.get(4)?,
                sent_at: row.get(5)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn import_contacts(&self, campaign_id: i32, contacts_list: Vec<(String, String)>) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<()> {
            conn.execute(
                "UPDATE ESF_Contact SET ExcluidoEm=datetime('now') WHERE CampaignId=?1 AND Status='pending' AND ExcluidoEm IS NULL;",
                params![campaign_id],
            )?;
            for (name, phone) in contacts_list {
                conn.execute(
                    "INSERT INTO ESF_Contact (CampaignId, ContactName, Phone, Status) VALUES (?1, ?2, ?3, 'pending');",
                    params![campaign_id, name, phone],
                )?;
            }
            // Reimportação não ressuscita descadastrados: aplica a lista da empresa na hora.
            Self::suppress_campaign_opt_outs_on(&conn, campaign_id)?;
            conn.execute(
                "UPDATE ESF_Campaign SET TotalContacts=(SELECT COUNT(*) FROM ESF_Contact WHERE CampaignId=?1 AND ExcluidoEm IS NULL), UpdatedAt=datetime('now') WHERE CampaignId=?1;",
                params![campaign_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| e.to_string()),
            Err(e) => { let _ = conn.execute_batch("ROLLBACK;"); Err(e.to_string()) }
        }
    }

    pub fn update_contact_status(&self, contact_id: i32, status: &str) -> Result<(), String> {
        self.exec_retry(
            "UPDATE ESF_Contact SET Status=?1, SentAt=datetime('now') WHERE ContactId=?2;",
            params![status, contact_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_contact_send_failure(&self, campaign_id: i32, contact_id: i32) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE ESF_Contact SET RetryCount=RetryCount+1,
             Status=CASE WHEN RetryCount+1 >= 3 THEN 'failed' ELSE 'pending' END
             WHERE ContactId=?1 AND CampaignId=?2 AND Status='pending' AND ExcluidoEm IS NULL",
            params![contact_id, campaign_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE ESF_Campaign SET FailedContacts=(SELECT COUNT(*) FROM ESF_Contact WHERE CampaignId=?1 AND Status='failed' AND ExcluidoEm IS NULL)
             WHERE CampaignId=?1",
            params![campaign_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn retry_failed_contacts(&self, campaign_id: i32) -> Result<usize, String> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<usize> {
            let count = conn.execute(
                "UPDATE ESF_Contact SET Status='pending', RetryCount=0 WHERE CampaignId=?1 AND Status='failed' AND ExcluidoEm IS NULL",
                params![campaign_id],
            )?;
            conn.execute(
                "UPDATE ESF_Campaign SET FailedContacts=0, Status='paused', UpdatedAt=datetime('now') WHERE CampaignId=?1",
                params![campaign_id],
            )?;
            Ok(count)
        })();
        match result {
            Ok(count) => { conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?; Ok(count) }
            Err(e) => { let _ = conn.execute_batch("ROLLBACK;"); Err(e.to_string()) }
        }
    }

    /// Reseta todos os contatos da campanha para 'pending' e zera contadores para permitir novo disparo completo
    pub fn reset_campaign_contacts(&self, campaign_id: i32) -> Result<usize, String> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<usize> {
            let count = conn.execute(
                "UPDATE ESF_Contact SET Status='pending', RetryCount=0 WHERE CampaignId=?1 AND ExcluidoEm IS NULL",
                params![campaign_id],
            )?;
            // Reiniciar a fila não desfaz um descadastro.
            Self::suppress_campaign_opt_outs_on(&conn, campaign_id)?;
            conn.execute(
                "UPDATE ESF_Campaign SET SentContacts=0, FailedContacts=0, Status='draft', UpdatedAt=datetime('now') WHERE CampaignId=?1",
                params![campaign_id],
            )?;
            Ok(count)
        })();
        match result {
            Ok(count) => { conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?; Ok(count) }
            Err(e) => { let _ = conn.execute_batch("ROLLBACK;"); Err(e.to_string()) }
        }
    }

    pub fn set_contact_custom_message(&self, contact_id: i32, message: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Contact SET CustomMessage=?1 WHERE ContactId=?2;",
            params![message, contact_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_next_pending_contact(&self, campaign_id: i32) -> Option<Contact> {
        self.try_get_next_pending_contact(campaign_id).ok().flatten()
    }

    /// Próximo contato pendente com id maior que `after_id` (pré-carregamento da mensagem).
    pub fn try_get_pending_contact_after(&self, campaign_id: i32, after_id: i32) -> Result<Option<Contact>> {
        self.pooled_conn()?.query_row(
            "SELECT ContactId, CampaignId, ContactName, Phone, Status, SentAt
             FROM ESF_Contact WHERE CampaignId = ?1 AND Status = 'pending' AND ExcluidoEm IS NULL AND ContactId > ?2
             ORDER BY ContactId ASC LIMIT 1",
            params![campaign_id, after_id],
            |row| {
                Ok(Contact {
                    id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    contact_name: row.get(2)?,
                    phone: row.get(3)?,
                    status: row.get(4)?,
                    sent_at: row.get(5)?,
                })
            },
        ).optional()
    }

    pub fn try_get_next_pending_contact(&self, campaign_id: i32) -> Result<Option<Contact>> {
        self.pooled_conn()?.query_row(
            "SELECT ContactId, CampaignId, ContactName, Phone, Status, SentAt
             FROM ESF_Contact WHERE CampaignId = ?1 AND Status = 'pending' AND ExcluidoEm IS NULL
             ORDER BY ContactId ASC LIMIT 1",
            params![campaign_id],
            |row| {
                Ok(Contact {
                    id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    contact_name: row.get(2)?,
                    phone: row.get(3)?,
                    status: row.get(4)?,
                    sent_at: row.get(5)?,
                })
            },
        ).optional()
    }

    pub fn has_pending_contact(&self, campaign_id: i32) -> bool {
        let Ok(conn) = self.pooled_conn() else { return false; };
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ESF_Contact WHERE CampaignId = ?1 AND Status = 'pending' AND ExcluidoEm IS NULL LIMIT 1)",
            params![campaign_id],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false)
    }

    // ============================================================
    // SENT HISTORY (dedup)
    // ============================================================

    pub fn was_already_sent(&self, phone: &str, campaign_id: i32) -> bool {
        self.try_was_already_sent(phone, campaign_id).unwrap_or(false)
    }

    // ============================================================
    // DESCADASTRO (opt-out)
    // ============================================================

    /// Chave do descadastro: só dígitos, sem o 9º dígito do celular BR, para casar
    /// "+55 75 98805-2539" com "557588052539" (como o WhatsApp mostra).
    pub fn opt_out_key(phone: &str) -> String {
        let d: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
        let d = d.trim_start_matches('0').to_string();
        // Só remove o DDI 55 quando ele está presente (12-13 dígitos): o DDD 55 (RS) também existe.
        let local = if (d.len() == 12 || d.len() == 13) && d.starts_with("55") { &d[2..] } else { &d[..] };
        let core = if local.len() == 11 && local.as_bytes()[2] == b'9' {
            format!("{}{}", &local[..2], &local[3..])
        } else {
            local.to_string()
        };
        core
    }

    /// Falha fechada: se a consulta der erro, trata como descadastrado (não envia).
    pub fn is_opted_out(&self, company_id: i32, phone: &str) -> bool {
        let key = Self::opt_out_key(phone);
        if key.is_empty() {
            return false;
        }
        self.conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ESF_OptOut WHERE CompanyId = ?1 AND PhoneDigits = ?2);",
                params![company_id, key],
                |row| row.get(0),
            )
            .unwrap_or(true)
    }

    /// Marca como 'opt_out' os contatos ainda não enviados (pendentes ou com falha) desse número
    /// em TODAS as campanhas da empresa. Só a empresa do pedido é afetada.
    pub fn suppress_pending_for_opt_out(&self, company_id: i32, phone: &str) -> usize {
        let key = Self::opt_out_key(phone);
        let conn = self.conn();
        Self::suppress_company_contacts_on(&conn, company_id, &key)
    }

    /// Versão sobre uma conexão já aberta (uso dentro de transações). Não chama `self.conn()`
    /// porque o guard do banco não é reentrante.
    fn suppress_company_contacts_on(conn: &Connection, company_id: i32, key: &str) -> usize {
        if key.is_empty() {
            return 0;
        }
        let mut stmt = match conn.prepare(
            "SELECT c.ContactId, c.Phone FROM ESF_Contact c JOIN ESF_Campaign k ON k.CampaignId = c.CampaignId
             WHERE k.CompanyId = ?1 AND c.Status IN ('pending', 'failed') AND c.ExcluidoEm IS NULL;",
        ) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let ids: Vec<i32> = stmt
            .query_map(params![company_id], |r| Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).filter(|(_, p)| Self::opt_out_key(p) == key).map(|(id, _)| id).collect())
            .unwrap_or_default();
        drop(stmt);
        for id in &ids {
            let _ = conn.execute("UPDATE ESF_Contact SET Status = 'opt_out' WHERE ContactId = ?1;", params![id]);
        }
        ids.len()
    }

    /// Reaplica a lista de descadastrados da empresa sobre uma campanha (usado ao importar ou
    /// reiniciar a fila): quem pediu SAIR nunca volta a 'pending', mesmo numa reimportação.
    fn suppress_campaign_opt_outs_on(conn: &Connection, campaign_id: i32) -> rusqlite::Result<usize> {
        let company_id: i32 = match conn
            .query_row("SELECT CompanyId FROM ESF_Campaign WHERE CampaignId = ?1;", params![campaign_id], |r| r.get(0))
            .optional()?
        {
            Some(id) => id,
            None => return Ok(0),
        };
        let keys: std::collections::HashSet<String> = {
            let mut stmt = conn.prepare("SELECT PhoneDigits FROM ESF_OptOut WHERE CompanyId = ?1;")?;
            let rows = stmt.query_map(params![company_id], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        if keys.is_empty() {
            return Ok(0);
        }
        let ids: Vec<i32> = {
            let mut stmt = conn.prepare(
                "SELECT ContactId, Phone FROM ESF_Contact WHERE CampaignId = ?1 AND Status IN ('pending', 'failed') AND ExcluidoEm IS NULL;",
            )?;
            let rows = stmt.query_map(params![campaign_id], |r| Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?)))?;
            rows.filter_map(|r| r.ok()).filter(|(_, p)| keys.contains(&Self::opt_out_key(p))).map(|(id, _)| id).collect()
        };
        for id in &ids {
            conn.execute("UPDATE ESF_Contact SET Status = 'opt_out' WHERE ContactId = ?1;", params![id])?;
        }
        Ok(ids.len())
    }

    /// Grava um pedido de descadastro vindo por API (ex.: VEXOR) de forma durável e idempotente.
    /// Tudo numa única transação: evento (chave estável), ESF_OptOut e supressão nas campanhas
    /// da empresa. Só retorna Ok depois do COMMIT com `synchronous=FULL` (fsync), que é o que
    /// autoriza o ACK ao remetente. Reenvio do mesmo EventId devolve "duplicate" sem alterar nada.
    pub fn record_opt_out_event(
        &self,
        event_id: &str,
        company_id: i32,
        phone: &str,
        source: &str,
        reason: &str,
        received_at: &str,
    ) -> std::result::Result<OptOutRecordOutcome, String> {
        let key = Self::opt_out_key(phone);
        if key.len() < 8 {
            return Err("Número inválido.".to_string());
        }
        if event_id.trim().is_empty() || event_id.len() > 200 {
            return Err("EventId inválido.".to_string());
        }
        let conn = self.conn();
        let _ = conn.execute_batch("PRAGMA synchronous=FULL;");
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(|e| e.to_string())?;
        let result = (|| -> Result<OptOutRecordOutcome> {
            let existing: Option<(i32, String)> = conn
                .query_row(
                    "SELECT CompanyId, PhoneDigits FROM ESF_OptOutEvent WHERE EventId = ?1;",
                    params![event_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((existing_company, existing_key)) = existing {
                return Ok(OptOutRecordOutcome {
                    status: "duplicate",
                    phone_key: existing_key,
                    suppressed: 0,
                    same_company: existing_company == company_id,
                });
            }
            conn.execute(
                "INSERT INTO ESF_OptOutEvent (EventId, CompanyId, PhoneDigits, PhoneE164, Source, Reason, ReceivedAt)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                params![event_id, company_id, key, phone.trim(), source, reason, received_at],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO ESF_OptOut (CompanyId, PhoneDigits, Reason, CreatedAt) VALUES (?1, ?2, ?3, datetime('now'));",
                params![company_id, key, reason],
            )?;
            let suppressed = Self::suppress_company_contacts_on(&conn, company_id, &key);
            Ok(OptOutRecordOutcome { status: "recorded", phone_key: key.clone(), suppressed, same_company: true })
        })();
        let outcome = match result {
            Ok(o) => conn.execute_batch("COMMIT;").map(|_| o).map_err(|e| e.to_string()),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e.to_string())
            }
        };
        let _ = conn.execute_batch("PRAGMA synchronous=NORMAL;");
        outcome
    }

    /// Lista os eventos de descadastro recebidos por API para auditoria (sem conversas).
    pub fn list_opt_out_events(&self, company_id: i32, limit: i32) -> Vec<(String, String, String, String, String)> {
        let conn = self.conn();
        let mut stmt = match conn.prepare(
            "SELECT EventId, PhoneDigits, Source, Reason, RecordedAt FROM ESF_OptOutEvent WHERE CompanyId = ?1 ORDER BY RecordedAt DESC LIMIT ?2;",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![company_id, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// Valida que o telefone para descadastro possui DDD (10 ou 11 dígitos locais, ou 12-13 com DDI 55).
    /// Rejeita números de 8 ou 9 dígitos sem DDD com mensagem clara.
    pub fn validate_opt_out_phone(phone: &str) -> std::result::Result<String, String> {
        let d: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
        let d = d.trim_start_matches('0').to_string();
        if d.is_empty() {
            return Err("Número inválido: informe DDD + número.".to_string());
        }
        if d.len() == 8 || d.len() == 9 {
            return Err(format!(
                "Número '{}' está sem DDD. Informe o DDD com 2 dígitos + número (ex.: 75988052539).",
                phone.trim()
            ));
        }
        let key = Self::opt_out_key(phone);
        if key.len() < 10 {
            return Err(format!(
                "Número '{}' inválido ou sem DDD. Informe o DDD com 2 dígitos + número.",
                phone.trim()
            ));
        }
        if key.len() > 11 {
            return Err(format!("Número '{}' inválido (dígitos em excesso).", phone.trim()));
        }
        Ok(key)
    }

    pub fn add_opt_out(&self, company_id: i32, phone: &str, reason: &str) -> Result<(), String> {
        let key = Self::validate_opt_out_phone(phone)?;
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO ESF_OptOut (CompanyId, PhoneDigits, Reason, CreatedAt) VALUES (?1, ?2, ?3, datetime('now'));",
                params![company_id, key, reason],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn remove_opt_out(&self, company_id: i32, phone_digits: &str) -> Result<(), String> {
        self.conn()
            .execute(
                "DELETE FROM ESF_OptOut WHERE CompanyId = ?1 AND PhoneDigits = ?2;",
                params![company_id, Self::opt_out_key(phone_digits)],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn list_opt_outs(&self, company_id: i32) -> Vec<(String, String, String)> {
        let conn = self.conn();
        let mut stmt = match conn.prepare(
            "SELECT PhoneDigits, Reason, CreatedAt FROM ESF_OptOut WHERE CompanyId = ?1 ORDER BY CreatedAt DESC;",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![company_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// Registra auditoria de adição ou remoção no descadastro (quem, quando, número, ação).
    pub fn record_opt_out_audit(
        &self,
        company_id: i32,
        phone: &str,
        action: &str,
        actor_name: &str,
        actor_role: &str,
        detail: &str,
    ) -> std::result::Result<(), String> {
        let key = Self::opt_out_key(phone);
        let phone_stored = if key.is_empty() { phone.trim().to_string() } else { key };
        self.conn()
            .execute(
                "INSERT INTO ESF_OptOutAudit (CompanyId, PhoneDigits, Action, ActorName, ActorRole, Detail, CreatedAt)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'));",
                params![company_id, phone_stored, action, actor_name, actor_role, detail],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Lista registros de auditoria de descadastro da empresa.
    pub fn list_opt_out_audit(&self, company_id: i32, limit: i32) -> Vec<OptOutAuditEntry> {
        let conn = self.conn();
        let mut stmt = match conn.prepare(
            "SELECT AuditId, CompanyId, PhoneDigits, Action, ActorName, ActorRole, Detail, CreatedAt
             FROM ESF_OptOutAudit
             WHERE CompanyId = ?1
             ORDER BY AuditId DESC
             LIMIT ?2;",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![company_id, limit], |r| {
            Ok(OptOutAuditEntry {
                id: r.get(0)?,
                company_id: r.get(1)?,
                phone: r.get(2)?,
                action: r.get(3)?,
                actor_name: r.get(4)?,
                actor_role: r.get(5)?,
                detail: r.get(6)?,
                created_at: r.get(7)?,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// Salva pedido de SAIR sem número identificável para revisão manual no banco.
    pub fn add_opt_out_review(
        &self,
        company_id: i32,
        title: &str,
        text: &str,
        device: &str,
    ) -> std::result::Result<i32, String> {
        let conn = self.conn();
        if let Ok(Some(existing_id)) = conn
            .query_row(
                "SELECT ReviewId FROM ESF_OptOutReview
                 WHERE CompanyId = ?1 AND Title = ?2 AND Text = ?3 AND Device = ?4 AND Status = 'pending'
                 LIMIT 1;",
                params![company_id, title.trim(), text.trim(), device.trim()],
                |r| r.get::<_, i32>(0),
            )
            .optional()
        {
            return Ok(existing_id);
        }
        conn.execute(
            "INSERT INTO ESF_OptOutReview (CompanyId, Title, Text, Device, Status, CreatedAt)
             VALUES (?1, ?2, ?3, ?4, 'pending', datetime('now'));",
            params![company_id, title.trim(), text.trim(), device.trim()],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid() as i32)
    }

    /// Lista itens de descadastro para revisão (por padrão todos ou filtrados por status).
    pub fn list_opt_out_reviews(&self, company_id: i32, status_filter: Option<&str>) -> Vec<OptOutReview> {
        let conn = self.conn();
        let sql = if status_filter.is_some() {
            "SELECT ReviewId, CompanyId, Title, Text, Device, Status, ResolvedPhone, ResolvedBy, ResolvedAt, CreatedAt
             FROM ESF_OptOutReview
             WHERE CompanyId = ?1 AND Status = ?2
             ORDER BY ReviewId DESC;"
        } else {
            "SELECT ReviewId, CompanyId, Title, Text, Device, Status, ResolvedPhone, ResolvedBy, ResolvedAt, CreatedAt
             FROM ESF_OptOutReview
             WHERE CompanyId = ?1
             ORDER BY ReviewId DESC;"
        };
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<OptOutReview> {
            Ok(OptOutReview {
                id: r.get(0)?,
                company_id: r.get(1)?,
                title: r.get(2)?,
                text: r.get(3)?,
                device: r.get(4)?,
                status: r.get(5)?,
                resolved_phone: r.get(6)?,
                resolved_by: r.get(7)?,
                resolved_at: r.get(8)?,
                created_at: r.get(9)?,
            })
        };
        if let Some(st) = status_filter {
            stmt.query_map(params![company_id, st], map_row)
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        } else {
            stmt.query_map(params![company_id], map_row)
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        }
    }

    /// Resolve um item de revisão descadastrando o número informado, cancelando envios pendentes e auditando.
    pub fn resolve_opt_out_review(
        &self,
        company_id: i32,
        review_id: i32,
        phone: &str,
        actor_name: &str,
        actor_role: &str,
    ) -> std::result::Result<usize, String> {
        let key = Self::validate_opt_out_phone(phone)?;
        let (title, text): (String, String) = self
            .conn()
            .query_row(
                "SELECT Title, Text FROM ESF_OptOutReview WHERE ReviewId = ?1 AND CompanyId = ?2;",
                params![review_id, company_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "Item de revisão não encontrado.".to_string())?;
        let snippet: String = text.chars().take(40).collect();
        let reason = if title.is_empty() {
            format!("Revisão manual (\"{}\") por {}", snippet, actor_name)
        } else {
            format!("Revisão de '{}' (\"{}\") por {}", title, snippet, actor_name)
        };
        self.add_opt_out(company_id, &key, &reason)?;
        let suppressed = self.suppress_pending_for_opt_out(company_id, &key);
        self.conn()
            .execute(
                "UPDATE ESF_OptOutReview
                 SET Status = 'resolved', ResolvedPhone = ?1, ResolvedBy = ?2, ResolvedAt = datetime('now')
                 WHERE ReviewId = ?3 AND CompanyId = ?4;",
                params![key, actor_name, review_id, company_id],
            )
            .map_err(|e| e.to_string())?;
        let _ = self.record_opt_out_audit(company_id, &key, "add", actor_name, actor_role, &reason);
        Ok(suppressed)
    }

    /// Descarta um item de revisão sem descadastrar número.
    pub fn discard_opt_out_review(
        &self,
        company_id: i32,
        review_id: i32,
        actor_name: &str,
    ) -> std::result::Result<(), String> {
        let changed = self
            .conn()
            .execute(
                "UPDATE ESF_OptOutReview
                 SET Status = 'discarded', ResolvedBy = ?1, ResolvedAt = datetime('now')
                 WHERE ReviewId = ?2 AND CompanyId = ?3;",
                params![actor_name, review_id, company_id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Item de revisão não encontrado.".to_string());
        }
        Ok(())
    }

    pub fn try_was_already_sent(&self, phone: &str, campaign_id: i32) -> Result<bool> {
        let conn = self.pooled_conn()?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ESF_SentHistory WHERE Phone = ?1 AND CampaignId = ?2 LIMIT 1);",
            params![phone, campaign_id],
            |row| row.get(0),
        )
    }

    pub fn mark_as_sent(&self, phone: &str, campaign_id: i32) -> Result<(), String> {
        self.exec_retry(
            "INSERT OR REPLACE INTO ESF_SentHistory (Phone, CampaignId, SentAt) VALUES (?1, ?2, datetime('now'));",
            params![phone, campaign_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // DEVICE STATUS (bans por pacote)
    // ============================================================

    pub fn is_device_banned(&self, device_id: &str, package_name: &str, campaign_id: i32) -> bool {
        let count: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_DeviceStatus WHERE DeviceId=?1 AND PackageName=?2 AND CampaignId=?3 AND Status='banned' AND ExcluidoEm IS NULL;",
            params![device_id, package_name, campaign_id],
            |row| row.get(0),
        ).unwrap_or(0);
        count > 0
    }

    pub fn set_device_banned(&self, device_id: &str, package_name: &str, campaign_id: i32) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_DeviceStatus (DeviceId, PackageName, CampaignId, Status) VALUES (?1, ?2, ?3, 'banned')
             ON CONFLICT(DeviceId, PackageName, CampaignId) DO UPDATE SET Status='banned', ExcluidoEm=NULL;",
            params![device_id, package_name, campaign_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // DEVICE PREFERENCES
    // ============================================================

    pub fn get_device_prefs(&self, device_id: &str, campaign_id: i32) -> Option<DevicePrefs> {
        self.conn().query_row(
            "SELECT DeviceId, CampaignId, PreferredPackage, UnlockPin
             FROM ESF_DevicePrefs WHERE DeviceId=?1 AND CampaignId=?2 AND ExcluidoEm IS NULL;",
            params![device_id, campaign_id],
            |row| {
                Ok(DevicePrefs {
                    device_id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    preferred_package: row.get(2)?,
                    unlock_pin: row.get(3)?,
                })
            },
        ).ok()
    }

    pub fn set_device_prefs(&self, device_id: &str, campaign_id: i32, preferred_package: &str, unlock_pin: &str) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_DevicePrefs (DeviceId, CampaignId, PreferredPackage, UnlockPin) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(DeviceId, CampaignId) DO UPDATE SET PreferredPackage=excluded.PreferredPackage, UnlockPin=excluded.UnlockPin, ExcluidoEm=NULL;",
            params![device_id, campaign_id, preferred_package, unlock_pin],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // DEVICE PACKAGES
    // ============================================================

    pub fn get_package_statuses(&self, device_id: i32) -> Vec<DevicePackage> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT DeviceId, PackageName, Status, UpdatedAt FROM ESF_DevicePackage WHERE DeviceId = ?1"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![device_id], |row| {
            Ok(DevicePackage {
                device_id: row.get(0)?,
                package_name: row.get(1)?,
                status: row.get(2)?,
                updated_at: row.get(3)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn update_package_status(&self, device_id: i32, pkg_name: &str, status: &str) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_DevicePackage (DeviceId, PackageName, Status, UpdatedAt) VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(DeviceId, PackageName) DO UPDATE SET Status = excluded.Status, UpdatedAt = excluded.UpdatedAt;",
            params![device_id, pkg_name, status],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // AI CONFIG
    // ============================================================

    pub fn get_ai_config(&self, company_id: i32) -> Option<AiConfig> {
        self.conn().query_row(
            "SELECT CompanyId, Provider, Model, Temperature, SystemPrompt, ApiKey, Endpoint
             FROM ESF_AiConfig WHERE CompanyId=?1;",
            params![company_id],
            |row| {
                Ok(AiConfig {
                    company_id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    temperature: row.get(3)?,
                    system_prompt: row.get(4)?,
                    api_key: row.get(5)?,
                    endpoint: row.get(6)?,
                })
            },
        ).ok()
    }

    pub fn save_ai_config(&self, config: &AiConfig) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_AiConfig (CompanyId, Provider, Model, Temperature, SystemPrompt, ApiKey, Endpoint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(CompanyId) DO UPDATE SET
             Provider=excluded.Provider, Model=excluded.Model, Temperature=excluded.Temperature,
             SystemPrompt=excluded.SystemPrompt, ApiKey=excluded.ApiKey, Endpoint=excluded.Endpoint;",
            params![
                config.company_id, config.provider, config.model, config.temperature,
                config.system_prompt, config.api_key, config.endpoint,
            ],
        ).map_err(|e| e.to_string())?;

        // Também salva/atualiza o registro persistente por provedor
        if !config.provider.is_empty() {
            let _ = self.save_ai_provider_key(
                config.company_id,
                &config.provider,
                &config.api_key,
                &config.endpoint,
                &config.model,
            );
        }
        Ok(())
    }

    pub fn get_ai_provider_key(&self, company_id: i32, provider: &str) -> Option<(String, String, String)> {
        self.conn().query_row(
            "SELECT ApiKey, Endpoint, Model FROM ESF_AiProviderKey WHERE CompanyId = ?1 AND Provider = ?2;",
            params![company_id, provider.to_lowercase()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok()
    }

    pub fn save_ai_provider_key(&self, company_id: i32, provider: &str, api_key: &str, endpoint: &str, model: &str) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_AiProviderKey (CompanyId, Provider, ApiKey, Endpoint, Model)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(CompanyId, Provider) DO UPDATE SET
             ApiKey=excluded.ApiKey, Endpoint=excluded.Endpoint, Model=excluded.Model, UpdatedAt=datetime('now');",
            params![company_id, provider.to_lowercase(), api_key, endpoint, model],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_ai_provider_keys(&self, company_id: i32) -> std::collections::HashMap<String, serde_json::Value> {
        let mut map = std::collections::HashMap::new();
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached("SELECT Provider, ApiKey, Endpoint, Model FROM ESF_AiProviderKey WHERE CompanyId = ?1") {
            Ok(s) => s,
            Err(_) => return map,
        };
        let rows = stmt.query_map(params![company_id], |row| {
            let prov: String = row.get(0)?;
            let key: String = row.get(1)?;
            let ep: String = row.get(2)?;
            let mdl: String = row.get(3)?;
            Ok((prov, serde_json::json!({
                "apiKey": key,
                "endpoint": ep,
                "model": mdl
            })))
        });
        if let Ok(iter) = rows {
            for item in iter.flatten() {
                map.insert(item.0, item.1);
            }
        }
        map
    }

    // ============================================================
    // PERMISSIONS
    // ============================================================

    /// Retorna o CompanyId de um usuário (para checagem de isolamento de permissões).
    pub fn user_company_id(&self, user_id: i32) -> Option<i32> {
        self.conn()
            .query_row(
                "SELECT CompanyId FROM ESF_User WHERE UserId = ?1",
                params![user_id],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn get_user_permissions(&self, user_id: i32) -> Vec<Permission> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT UserId, PermissionKey, Enabled FROM ESF_Permission WHERE UserId = ?1"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![user_id], |row| {
            Ok(Permission {
                user_id: row.get(0)?,
                permission_key: row.get(1)?,
                enabled: row.get::<_, i32>(2)? == 1,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn update_user_permission(&self, user_id: i32, key: &str, enabled: bool) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_Permission (UserId, PermissionKey, Enabled) VALUES (?1, ?2, ?3)
             ON CONFLICT(UserId, PermissionKey) DO UPDATE SET Enabled=excluded.Enabled;",
            params![user_id, key, if enabled { 1 } else { 0 }],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_sector_permissions(&self, user_id: i32) -> Vec<SectorPermission> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT UserId, Sector, CanView, CanConfigure FROM ESF_SectorPermission WHERE UserId = ?1"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![user_id], |row| {
            Ok(SectorPermission {
                user_id: row.get(0)?,
                sector: row.get(1)?,
                can_view: row.get::<_, i32>(2)? == 1,
                can_configure: row.get::<_, i32>(3)? == 1,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn update_sector_permission(&self, user_id: i32, sector: &str, can_view: bool, can_configure: bool) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_SectorPermission (UserId, Sector, CanView, CanConfigure) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(UserId, Sector) DO UPDATE SET CanView=excluded.CanView, CanConfigure=excluded.CanConfigure;",
            params![user_id, sector, if can_view { 1 } else { 0 }, if can_configure { 1 } else { 0 }],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ============================================================
    // DASHBOARD KPIs
    // ============================================================

    pub fn get_dashboard_kpis(&self, company_id: i32) -> Result<serde_json::Value, String> {
        let blocked_chips: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_Chip c JOIN ESF_Device d ON c.DeviceId=d.AdbDeviceId
             WHERE d.CompanyId=?1 AND c.ExcluidoEm IS NULL
             AND c.Status IN ('banido','restrito_24h','restrito_7d','restrito_custom');",
            params![company_id],
            |row| row.get(0),
        ).unwrap_or(0);

        let config_changes_today: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_AuditLog WHERE CompanyId=?1 AND ExcluidoEm IS NULL
             AND date(Timestamp) = date('now');",
            params![company_id],
            |row| row.get(0),
        ).unwrap_or(0);

        let sent_today: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_Contact c
             JOIN ESF_Campaign cam ON c.CampaignId=cam.CampaignId
             WHERE cam.CompanyId=?1 AND c.Status='sent' AND c.ExcluidoEm IS NULL
             AND date(c.SentAt) = date('now');",
            params![company_id],
            |row| row.get(0),
        ).unwrap_or(0);

        let total_contacts_pending: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_Contact c
             JOIN ESF_Campaign cam ON c.CampaignId=cam.CampaignId
             WHERE cam.CompanyId=?1 AND c.Status='pending' AND c.ExcluidoEm IS NULL;",
            params![company_id],
            |row| row.get(0),
        ).unwrap_or(0);

        Ok(serde_json::json!({
            "blocked_chips": blocked_chips,
            "config_changes_today": config_changes_today,
            "sent_today": sent_today,
            "pending_contacts": total_contacts_pending,
        }))
    }

    // ============================================================
    // CAMPAIGN DISPATCH
    // ============================================================

    pub fn send_campaign_next_batch(&self, campaign_id: i32) -> Result<serde_json::Value, String> {
        let conn = self.conn();
        let c: &Connection = &conn;

        // Get next 5 pending contacts
        let mut stmt = c.prepare_cached(
            "SELECT ContactId, ContactName, Phone FROM ESF_Contact
             WHERE CampaignId=?1 AND Status='pending' AND ExcluidoEm IS NULL
             ORDER BY ContactId LIMIT 5;"
        ).map_err(|e| e.to_string())?;

        let contacts: Vec<(i32, String, String)> = stmt.query_map(params![campaign_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        let total_sent = contacts.len() as i32;

        // Executa o lote inteiro em UMA transação atômica (Rollback em qualquer falha)
        Self::with_busy_retry(|| c.execute_batch("BEGIN IMMEDIATE;"))
            .map_err(|e| format!("Falha ao iniciar transação de envio: {}", e))?;

        let batch_result: Result<(i32, bool)> = (|| {
            for (contact_id, _name, _phone) in &contacts {
                // Check dedup via SentHistory
                let already: bool = c.query_row(
                    "SELECT COUNT(*) > 0 FROM ESF_SentHistory
                     WHERE CampaignId=?1 AND Phone=(SELECT Phone FROM ESF_Contact WHERE ContactId=?2);",
                    params![campaign_id, contact_id],
                    |row| row.get(0),
                ).unwrap_or(false);

                if !already {
                    // Mark as sent
                    c.execute(
                        "UPDATE ESF_Contact SET Status='sent', SentAt=datetime('now')
                         WHERE ContactId=?1;",
                        params![contact_id],
                    )?;

                    // Record in sent history
                    c.execute(
                        "INSERT INTO ESF_SentHistory (CampaignId, Phone, SentAt)
                         SELECT ?1, Phone, datetime('now') FROM ESF_Contact WHERE ContactId=?2;",
                        params![campaign_id, contact_id],
                    )?;
                } else {
                    // Already sent - mark as skipped
                    c.execute(
                        "UPDATE ESF_Contact SET Status='sent' WHERE ContactId=?1;",
                        params![contact_id],
                    )?;
                }
            }

            // Update campaign counters
            c.execute(
                "UPDATE ESF_Campaign SET
                 SentContacts = (SELECT COUNT(*) FROM ESF_Contact WHERE CampaignId=?1 AND Status='sent' AND ExcluidoEm IS NULL)
                 WHERE CampaignId=?1;",
                params![campaign_id],
            )?;

            // Check if campaign is complete
            let remaining: i32 = c.query_row(
                "SELECT COUNT(*) FROM ESF_Contact
                 WHERE CampaignId=?1 AND Status='pending' AND ExcluidoEm IS NULL;",
                params![campaign_id],
                |row| row.get(0),
            ).unwrap_or(0);

            if remaining == 0 {
                c.execute(
                    "UPDATE ESF_Campaign SET Status='completed' WHERE CampaignId=?1;",
                    params![campaign_id],
                )?;
            }

            Ok((remaining, remaining == 0))
        })();

        let (remaining, campaign_complete) = match batch_result {
            Ok(v) => {
                Self::with_busy_retry(|| c.execute_batch("COMMIT;"))
                    .map_err(|e| format!("Falha no commit do lote de envio: {}", e))?;
                v
            }
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK;");
                return Err(format!("Falha no lote de envio (transação revertida): {}", e));
            }
        };

        Ok(serde_json::json!({
            "sent_in_batch": total_sent,
            "remaining": remaining,
            "campaign_complete": campaign_complete,
        }))
    }

    // ============================================================
    // GESTÃO DE USUÁRIOS E ROLES (Colaborador, Supervisor, Gestor)
    // ============================================================

    pub fn get_users_by_company(&self, company_id: i32) -> Vec<User> {
        let conn = self.conn();
        let sql = if company_id > 0 {
            "SELECT UserId, Username, DisplayName, Role, CompanyId, IsActive FROM ESF_User WHERE CompanyId = ?1 AND IsActive = 1 ORDER BY DisplayName ASC"
        } else {
            "SELECT UserId, Username, DisplayName, Role, CompanyId, IsActive FROM ESF_User WHERE IsActive = 1 ORDER BY DisplayName ASC"
        };

        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let mapper = |row: &rusqlite::Row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                display_name: row.get(2)?,
                role: row.get(3)?,
                company_id: row.get(4)?,
                is_active: row.get(5)?,
            })
        };

        let rows = if company_id > 0 {
            stmt.query_map(params![company_id], mapper)
        } else {
            stmt.query_map([], mapper)
        };

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn create_user_with_role(
        &self,
        user_name: &str,
        pass: &str,
        display_name: &str,
        role: &str,
        company_id: i32,
    ) -> Result<User, String> {
        let valid_role = match role.to_lowercase().as_str() {
            "master" => "master",
            "gestor" => "gestor",
            "supervisor" => "supervisor",
            _ => "colaborador",
        };

        let hash = hash_password(pass);
        self.conn().execute(
            "INSERT INTO ESF_User (Username, PasswordHash, DisplayName, Role, CompanyId, IsActive)
             VALUES (?1, ?2, ?3, ?4, ?5, 1);",
            params![user_name, hash, display_name, valid_role, company_id],
        ).map_err(|e| format!("Erro ao criar usuário: {}", e))?;

        let user_id = self.conn().last_insert_rowid() as i32;

        Ok(User {
            id: user_id,
            username: user_name.to_string(),
            display_name: display_name.to_string(),
            role: valid_role.to_string(),
            company_id: Some(company_id),
            is_active: true,
        })
    }

    // ============================================================
    // VÍNCULO E PERMISSÃO DE CELULARES (Colaborador, Supervisor, Gestor)
    // ============================================================

    pub fn assign_device_to_user(&self, device_serial: &str, user_id: i32) -> Result<(), String> {
        self.conn().execute(
            "INSERT INTO ESF_DeviceAssignment (AdbDeviceId, UserId)
             VALUES (?1, ?2)
             ON CONFLICT(AdbDeviceId, UserId) DO NOTHING;",
            params![device_serial, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn unassign_device_from_user(&self, device_serial: &str, user_id: i32) -> Result<(), String> {
        self.conn().execute(
            "DELETE FROM ESF_DeviceAssignment WHERE (AdbDeviceId = ?1 OR AdbDeviceId IN (
                SELECT AdbDeviceId FROM ESF_Device WHERE EsferaDeviceId = ?1 OR CurrentAdbAddress = ?1
             )) AND UserId = ?2;",
            params![device_serial, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_assigned_devices_for_user(&self, user_id: i32, company_id: i32) -> Vec<Device> {
        let conn = self.conn();
        let sql = "SELECT d.rowid, d.AdbDeviceId, d.DeviceName, d.Brand, d.Model, d.DeviceIp, d.DevicePort, d.Status, d.BatteryLevel, d.CompanyId, d.DeviceNumber, d.Sector,
                          d.EsferaDeviceId, d.CurrentAdbAddress, d.LastSeenUTC
                   FROM ESF_Device d
                   INNER JOIN ESF_DeviceAssignment da ON (
                       d.AdbDeviceId = da.AdbDeviceId
                       OR (d.EsferaDeviceId IS NOT NULL AND d.EsferaDeviceId = da.AdbDeviceId)
                       OR (d.CurrentAdbAddress IS NOT NULL AND d.CurrentAdbAddress = da.AdbDeviceId)
                   )
                   WHERE da.UserId = ?1 AND (d.CompanyId = ?2 OR ?2 <= 0)
                   GROUP BY COALESCE(d.EsferaDeviceId, d.AdbDeviceId);";

        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![user_id, company_id], |row| {
            Ok(Device {
                id: row.get(0)?,
                serial: row.get(1)?,
                name: row.get(2)?,
                brand: row.get(3)?,
                model: row.get(4)?,
                ip: row.get(5)?,
                port: row.get(6)?,
                status: row.get(7)?,
                battery: row.get(8)?,
                company_id: row.get(9)?,
                device_number: row.get(10)?,
                sector: row.get(11)?,
                esfera_device_id: row.get(12)?,
                current_adb_address: row.get(13)?,
                last_seen_utc: row.get(14)?,
                via_tunnel: false,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn get_all_device_assignments(&self, company_id: i32) -> Vec<DeviceAssignmentInfo> {
        let conn = self.conn();
        let sql = "SELECT da.AssignmentId, da.AdbDeviceId, da.UserId, u.Username, u.DisplayName,
                          d.DeviceName, d.DeviceNumber, d.Model, da.CreatedAt
                   FROM ESF_DeviceAssignment da
                   INNER JOIN ESF_User u ON da.UserId = u.UserId
                   LEFT JOIN ESF_Device d ON (da.AdbDeviceId = d.AdbDeviceId OR da.AdbDeviceId = d.EsferaDeviceId OR da.AdbDeviceId = d.CurrentAdbAddress)
                   WHERE (u.CompanyId = ?1 OR ?1 <= 0)
                   GROUP BY da.AssignmentId
                   ORDER BY da.AssignmentId DESC;";

        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(DeviceAssignmentInfo {
                assignment_id: row.get(0)?,
                adb_device_id: row.get(1)?,
                user_id: row.get(2)?,
                user_name: row.get(3)?,
                user_display_name: row.get(4)?,
                device_name: row.get(5)?,
                device_number: row.get(6)?,
                model: row.get(7)?,
                created_at: row.get(8)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn request_device_permission(
        &self,
        user_id: i32,
        device_serial: &str,
        reason: &str,
    ) -> Result<i32, String> {
        // Cancela qualquer pedido pendente anterior deste mesmo usuário/dispositivo
        let _ = self.conn().execute(
            "UPDATE ESF_DevicePermissionRequest SET Status = 'ended', EndedAt = datetime('now')
             WHERE UserId = ?1 AND AdbDeviceId = ?2 AND Status IN ('pending', 'approved', 'active');",
            params![user_id, device_serial],
        );

        self.conn().execute(
            "INSERT INTO ESF_DevicePermissionRequest (AdbDeviceId, UserId, Status, RequestedReason, RequestedAt)
             VALUES (?1, ?2, 'pending', ?3, datetime('now'));",
            params![device_serial, user_id, reason],
        ).map_err(|e| format!("Erro ao registrar pedido de permissão: {}", e))?;

        Ok(self.conn().last_insert_rowid() as i32)
    }

    pub fn get_permission_requests(&self, company_id: i32) -> Vec<DevicePermissionRequest> {
        let conn = self.conn();
        let sql = "SELECT pr.RequestId, pr.AdbDeviceId, pr.UserId, u.Username, u.DisplayName, pr.Status, pr.RequestedReason, pr.RequestedAt, pr.ApprovedBy, ab.DisplayName, pr.ApprovedAt, pr.EndedAt
                   FROM ESF_DevicePermissionRequest pr
                   JOIN ESF_User u ON pr.UserId = u.UserId
                   LEFT JOIN ESF_User ab ON pr.ApprovedBy = ab.UserId
                   WHERE (u.CompanyId = ?1 OR ?1 <= 0 OR u.CompanyId IS NULL)
                   ORDER BY pr.RequestId DESC LIMIT 100;";

        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(DevicePermissionRequest {
                request_id: row.get(0)?,
                adb_device_id: row.get(1)?,
                user_id: row.get(2)?,
                user_name: row.get(3)?,
                user_display_name: row.get(4)?,
                status: row.get(5)?,
                requested_reason: row.get(6)?,
                requested_at: row.get(7)?,
                approved_by: row.get(8)?,
                approved_by_name: row.get(9)?,
                approved_at: row.get(10)?,
                ended_at: row.get(11)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    pub fn approve_permission_request(&self, request_id: i32, approved_by: i32) -> Result<(), String> {
        // Encerra qualquer outra sessão ativa para este mesmo celular
        let target_device: String = self.conn().query_row(
            "SELECT AdbDeviceId FROM ESF_DevicePermissionRequest WHERE RequestId = ?1;",
            params![request_id],
            |row| row.get(0),
        ).map_err(|_| "Solicitação não encontrada.".to_string())?;

        let _ = self.conn().execute(
            "UPDATE ESF_DevicePermissionRequest SET Status = 'ended', EndedAt = datetime('now')
             WHERE AdbDeviceId = ?1 AND Status IN ('approved', 'active') AND RequestId != ?2;",
            params![target_device, request_id],
        );

        self.conn().execute(
            "UPDATE ESF_DevicePermissionRequest SET Status = 'approved', ApprovedBy = ?1, ApprovedAt = datetime('now')
             WHERE RequestId = ?2;",
            params![approved_by, request_id],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn reject_permission_request(&self, request_id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_DevicePermissionRequest SET Status = 'rejected', EndedAt = datetime('now')
             WHERE RequestId = ?1;",
            params![request_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn end_permission_session(&self, request_id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_DevicePermissionRequest SET Status = 'ended', EndedAt = datetime('now')
             WHERE RequestId = ?1;",
            params![request_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_devices_with_active_user_map(&self, company_id: i32) -> Vec<DeviceWithActiveUser> {
        let conn = self.conn();
        let sql = "SELECT d.rowid, d.AdbDeviceId, d.DeviceName, d.Brand, d.Model, d.DeviceIp, d.DevicePort, 
                          d.Status, d.BatteryLevel, d.CompanyId, d.DeviceNumber, d.Sector, d.EsferaDeviceId, 
                          d.CurrentAdbAddress, d.LastSeenUTC,
                          u.UserId, u.Username, u.DisplayName, pr.RequestId,
                          da.UserId, au.DisplayName
                   FROM ESF_Device d
                   LEFT JOIN ESF_DevicePermissionRequest pr ON (d.AdbDeviceId = pr.AdbDeviceId OR d.EsferaDeviceId = pr.AdbDeviceId) AND pr.Status IN ('approved', 'active')
                   LEFT JOIN ESF_User u ON pr.UserId = u.UserId
                   LEFT JOIN ESF_DeviceAssignment da ON (d.AdbDeviceId = da.AdbDeviceId OR d.EsferaDeviceId = da.AdbDeviceId)
                   LEFT JOIN ESF_User au ON da.UserId = au.UserId
                   WHERE (d.CompanyId = ?1 OR ?1 <= 0)
                   GROUP BY COALESCE(d.EsferaDeviceId, d.AdbDeviceId)
                   ORDER BY CASE WHEN d.Status = 'online' THEN 0 ELSE 1 END, d.DeviceNumber ASC;";

        let mut stmt = match conn.prepare_cached(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt.query_map(params![company_id], |row| {
            Ok(DeviceWithActiveUser {
                id: row.get(0)?,
                serial: row.get(1)?,
                name: row.get(2)?,
                brand: row.get(3)?,
                model: row.get(4)?,
                ip: row.get(5)?,
                port: row.get(6)?,
                status: row.get(7)?,
                battery: row.get(8)?,
                company_id: row.get(9)?,
                device_number: row.get(10)?,
                sector: row.get(11)?,
                esfera_device_id: row.get(12)?,
                current_adb_address: row.get(13)?,
                last_seen_utc: row.get(14)?,
                via_tunnel: false,
                active_user_id: row.get(15)?,
                active_user_name: row.get(16)?,
                active_user_display_name: row.get(17)?,
                permission_request_id: row.get(18)?,
                assigned_user_id: row.get(19)?,
                assigned_user_name: row.get(20)?,
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// Valida um token de empresa contra ESF_CompanyToken.
    /// Retorna (CompanyId, Role) ou None se inválido/vazio.
    /// Sem credencial global em código — espelha o hub-standalone.
    pub fn validate_token(&self, token: &str) -> Option<(i32, String)> {
        if token.is_empty() {
            return None;
        }
        let hash = hash_password(token);
        self.conn()
            .query_row(
                "SELECT CompanyId, Role FROM ESF_CompanyToken WHERE TokenHash = ?1",
                params![hash],
                |r| Ok((r.get::<_, i32>(0)?, r.get::<_, String>(1)?)),
            )
            .ok()
    }

    /// Gera/atualiza o token de uma empresa (CompanyId = 0 é o master).
    pub fn upsert_company_token(&self, company_id: i32, token: &str, role: &str) -> Result<(), rusqlite::Error> {
        let hash = hash_password(token);
        self.conn()
            .execute(
                "INSERT INTO ESF_CompanyToken (CompanyId, TokenHash, Role) VALUES (?1, ?2, ?3)
                 ON CONFLICT(CompanyId) DO UPDATE SET TokenHash=excluded.TokenHash, Role=excluded.Role",
                params![company_id, hash, role],
            )
            .map(|_| ())
    }

    /// Gera (ou devolve) um token de empresa forte e o persiste, retornando o
    /// plaintext. O hub valida por hash, então devolver o plaintext aqui é o
    /// que o cliente precisa para autenticar.
    pub fn issue_hub_token(&self, company_id: i32, role: &str) -> Result<String, String> {
        let raw: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
        let token = hex::encode(raw);
        self.upsert_company_token(company_id, &token, role)
            .map_err(|e| format!("Falha ao emitir token de hub: {}", e))?;
        Ok(token)
    }

    /// Existência de uma empresa ativa (sem depender de colunas calculadas).
    pub fn company_exists(&self, company_id: i32) -> bool {
        self.conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ESF_Company WHERE CompanyId = ?1 AND IsActive = 1);",
                params![company_id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
    }

    /// Busca empresa por ID (para obter o nome no Register do hub).
    pub fn get_company_by_id(&self, company_id: i32) -> Option<Company> {
        self.conn()
            .query_row(
                "SELECT CompanyId, CompanyName, DeviceLimit, UserLimit, DeviceCount, UserCount, IsActive, Status, CreatedAt FROM ESF_Company WHERE CompanyId = ?1",
                params![company_id],
                |r| {
                    Ok(Company {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        device_limit: r.get(2)?,
                        user_limit: r.get(3)?,
                        device_count: r.get(4)?,
                        user_count: r.get(5)?,
                        is_active: r.get(6)?,
                        status: r.get(7)?,
                        created_at: r.get(8)?,
                    })
                },
            )
            .ok()
    }
}







#[cfg(test)]
mod opt_out_event_tests {
    use super::Database;

    fn temp_db(tag: &str) -> Database {
        let path = std::env::temp_dir().join(format!("esfera_optout_db_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        Database::init(path.to_string_lossy().as_ref()).expect("db")
    }

    #[test]
    fn evento_duravel_idempotente_e_isolado_por_empresa() {
        let db = temp_db("event");
        let other = db.create_company("Outra", 5).unwrap();
        let first = db.record_opt_out_event("whatsapp:c:1", 1, "+5575988052539", "vexor", "SAIR", "2026-10-27T12:00:00Z").unwrap();
        assert_eq!(first.status, "recorded");
        assert_eq!(first.phone_key, "7588052539");
        assert!(db.is_opted_out(1, "5575988052539"));
        assert!(!db.is_opted_out(other.id, "5575988052539"));
        let again = db.record_opt_out_event("whatsapp:c:1", 1, "+5575988052539", "vexor", "SAIR", "").unwrap();
        assert_eq!(again.status, "duplicate");
        assert!(again.same_company);
        let stolen = db.record_opt_out_event("whatsapp:c:1", other.id, "+5575988052539", "vexor", "SAIR", "").unwrap();
        assert_eq!(stolen.status, "duplicate");
        assert!(!stolen.same_company);
        assert!(!db.is_opted_out(other.id, "5575988052539"));
        assert_eq!(db.list_opt_out_events(1, 10).len(), 1);
        assert!(db.record_opt_out_event("whatsapp:c:2", 1, "123", "vexor", "", "").is_err());
        assert!(db.record_opt_out_event("", 1, "+5575988052539", "vexor", "", "").is_err());
        // Após rollback/erro a conexão segue utilizável.
        assert_eq!(db.record_opt_out_event("whatsapp:c:3", 1, "5575911112222", "vexor", "", "").unwrap().status, "recorded");
    }
}

#[cfg(test)]
mod opt_out_key_tests {
    use super::Database;
    #[test]
    fn mesmo_numero_mesma_chave() {
        let k = Database::opt_out_key("+55 75 98805-2539");
        assert_eq!(k, "7588052539");
        assert_eq!(Database::opt_out_key("5575988052539"), k);
        assert_eq!(Database::opt_out_key("557588052539"), k);
        assert_eq!(Database::opt_out_key("(75) 98805-2539"), k);
        assert_eq!(Database::opt_out_key("075988052539"), k);
        // DDD 55 (RS) sem DDI e com DDI devem dar a mesma chave
        assert_eq!(Database::opt_out_key("55999998888"), Database::opt_out_key("+55 55 99999-8888"));
        assert_eq!(Database::opt_out_key("55999998888"), "5599998888");
    }

    #[test]
    fn revisao_auditoria_e_validacao_ddd_descadastro() {
        let path = std::env::temp_dir().join(format!("esfera_optout_rev_audit_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::init(path.to_string_lossy().as_ref()).expect("db");

        // 1. Rejeita número sem DDD com mensagem clara
        let err_8 = db.add_opt_out(1, "3333-4444", "Manual").unwrap_err();
        assert!(err_8.contains("sem DDD"), "esperava erro de sem DDD, veio: {}", err_8);
        let err_9 = db.add_opt_out(1, "98805-2539", "Manual").unwrap_err();
        assert!(err_9.contains("sem DDD"), "esperava erro de sem DDD, veio: {}", err_9);

        // 2. Revisão de descadastro sem número identificável
        let rev_id = db.add_opt_out_review(1, "Maria Loja", "SAIR por favor", "192.168.1.50:5555").unwrap();
        // Idempotente enquanto pendente
        let rev_id_dup = db.add_opt_out_review(1, "Maria Loja", "SAIR por favor", "192.168.1.50:5555").unwrap();
        assert_eq!(rev_id, rev_id_dup);

        let pendentes = db.list_opt_out_reviews(1, Some("pending"));
        assert_eq!(pendentes.len(), 1);
        assert_eq!(pendentes[0].title, "Maria Loja");
        assert_eq!(pendentes[0].device, "192.168.1.50:5555");

        // Tentar resolver sem DDD deve falhar
        assert!(db.resolve_opt_out_review(1, rev_id, "988052539", "Gestor Ana", "gestor").is_err());

        // Resolver com DDD válido descadastra, resolve revisão e grava auditoria
        db.resolve_opt_out_review(1, rev_id, "(75) 98805-2539", "Gestor Ana", "gestor").unwrap();
        assert!(db.is_opted_out(1, "5575988052539"));
        assert_eq!(db.list_opt_out_reviews(1, Some("pending")).len(), 0);
        let resolvidos = db.list_opt_out_reviews(1, Some("resolved"));
        assert_eq!(resolvidos.len(), 1);
        assert_eq!(resolvidos[0].resolved_phone.as_deref(), Some("7588052539"));

        // Descartar revisão
        let rev2 = db.add_opt_out_review(1, "Grupo Vendas", "sair", "USB-01").unwrap();
        db.discard_opt_out_review(1, rev2, "Gestor Ana").unwrap();
        assert_eq!(db.list_opt_out_reviews(1, Some("pending")).len(), 0);
        assert_eq!(db.list_opt_out_reviews(1, Some("discarded")).len(), 1);

        // 3. Auditoria de remoção
        db.remove_opt_out(1, "7588052539").unwrap();
        db.record_opt_out_audit(1, "7588052539", "remove", "Master Carlos", "master", "Removido manualmente").unwrap();
        let logs = db.list_opt_out_audit(1, 10);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].action, "remove");
        assert_eq!(logs[0].actor_name, "Master Carlos");
        assert_eq!(logs[0].phone, "7588052539");
    }
}
