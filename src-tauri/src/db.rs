// ============================================================
// Esfera v3 — Camada de Banco de Dados (SQLite Local)
// Mapeamento 1:1 das tabelas ESF_* do Esfera v2
// Fase 1: WAL, Soft Delete, 4 tabelas novas, Hash SHA-256
// ============================================================

use rusqlite::{params, Connection, Result, Transaction};
use std::sync::Mutex;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

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
    pub ai_prompt: String,
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
    pub company_id: i32,
    pub provider: String,
    pub model: String,
    pub temperature: f64,
    pub system_prompt: String,
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
    pub active_user_id: Option<i32>,
    pub active_user_name: Option<String>,
    pub active_user_display_name: Option<String>,
    pub permission_request_id: Option<i32>,
    pub assigned_user_id: Option<i32>,
    pub assigned_user_name: Option<String>,
}

// ============================================================
// DATABASE TRANSACTION RAII
// ============================================================

pub struct DatabaseTransaction<'a> {
    tx: Option<Transaction<'a>>,
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

pub fn verify_password(password: &str, hash: &str) -> bool {
    password == hash || hash_password(password) == hash
}

// ============================================================
// DATABASE
// ============================================================

pub struct Database {
    pool: Pool<SqliteConnectionManager>,
    cached: Mutex<Option<r2d2::PooledConnection<SqliteConnectionManager>>>,
}

// Wrapper para MutexGuard que implementa Deref<Target=Connection>
pub struct ConnGuard<'a>(std::sync::MutexGuard<'a, Option<r2d2::PooledConnection<SqliteConnectionManager>>>);

impl<'a> std::ops::Deref for ConnGuard<'a> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}

impl Database {
    pub fn init(db_path: &str) -> Result<Self> {
        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(8)
            .min_idle(Some(2))
            .build(manager)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        // Configura PRAGMAs HPC em todas as conexões do pool
        {
            let conn = pool.get().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            conn.execute_batch("
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                PRAGMA busy_timeout=10000;
                PRAGMA foreign_keys=ON;
                PRAGMA cache_size=-64000;
                PRAGMA temp_store=MEMORY;
                PRAGMA mmap_size=268435456;
                PRAGMA page_size=8192;
            ").map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        let db = Database { pool, cached: Mutex::new(None) };
        db.create_tables()?;
        db.migrate_existing_tables()?;
        db.seed_data()?;
        Ok(db)
    }

    fn conn(&self) -> ConnGuard<'_> {
        let mut guard = self.cached.lock().expect("db conn lock poisoned");
        if guard.is_none() {
            *guard = Some(self.pool.get().expect("r2d2 pool exhausted (max_size=8)"));
        }
        ConnGuard(guard)
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

        // 18. Performance Indexes (Microsecond Lookups)
        self.conn().execute_batch("
            CREATE INDEX IF NOT EXISTS idx_device_company ON ESF_Device (CompanyId);
            CREATE INDEX IF NOT EXISTS idx_campaign_company ON ESF_Campaign (CompanyId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_contact_campaign ON ESF_Contact (CampaignId, Status, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_chip_device ON ESF_Chip (DeviceId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_audit_log_company ON ESF_AuditLog (CompanyId, LogId DESC);
            CREATE INDEX IF NOT EXISTS idx_automation_company ON ESF_AutomationRule (CompanyId, ExcluidoEm);
            CREATE INDEX IF NOT EXISTS idx_sent_history ON ESF_SentHistory (Phone, CampaignId);
            CREATE INDEX IF NOT EXISTS idx_dev_perm_user ON ESF_DevicePermissionRequest (UserId, Status);
            CREATE INDEX IF NOT EXISTS idx_dev_perm_device ON ESF_DevicePermissionRequest (AdbDeviceId, Status);
            CREATE INDEX IF NOT EXISTS idx_dev_assign_user ON ESF_DeviceAssignment (UserId, AdbDeviceId);
        ")?;

        Ok(())
    }

    /// Migra tabelas existentes que não tinham as colunas novas
    fn migrate_existing_tables(&self) -> Result<()> {
        // ESF_Device
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN DeviceNumber INTEGER DEFAULT 1;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN Sector TEXT DEFAULT 'junior';", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN EsferaDeviceId TEXT;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN CurrentAdbAddress TEXT;", []);
        let _ = self.conn().execute("ALTER TABLE ESF_Device ADD COLUMN LastSeenUTC TEXT;", []);
        // Popula EsferaDeviceId para devices existentes com ID determinístico baseado no DeviceNumber
        let _ = self.conn().execute(
            "UPDATE ESF_Device SET EsferaDeviceId = 'ESF-LEGACY-' || DeviceNumber WHERE EsferaDeviceId IS NULL;",
            [],
        );
        // Índice único para EsferaDeviceId
        let _ = self.conn().execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_device_esfera_id ON ESF_Device(EsferaDeviceId);",
            [],
        );

        // ESF_Campaign
        let _ = self.conn().execute("ALTER TABLE ESF_Campaign ADD COLUMN SelectedDevices TEXT DEFAULT '';", []);
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
        // Limpeza de dispositivos, campanhas e logs falsos legados de desenvolvimento
        let _ = self.conn().execute("DELETE FROM ESF_Device WHERE AdbDeviceId LIKE 'adb-dev-%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_Campaign WHERE CampaignName LIKE '%Black Friday%' OR CampaignName LIKE '%Julho%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_AutomationRule WHERE RuleName LIKE '%Preço%' OR RuleName LIKE '%Humano%';", []);
        let _ = self.conn().execute("DELETE FROM ESF_AuditLog WHERE Message LIKE '%adb-dev-%';", []);

        // Garante que a empresa #1 seja REALESS e que nenhuma informação seja perdida
        let _ = self.conn().execute("UPDATE ESF_Company SET CompanyName='REALESS' WHERE CompanyId=1 AND (CompanyName='Empresa Principal' OR CompanyName='');", []);

        Ok(())
    }

    fn seed_data(&self) -> Result<()> {
        let conn = self.conn();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM ESF_Company", [], |r| r.get(0))?;

        if count == 0 {
            // Empresa Padrão REALESS
            self.conn().execute(
                "INSERT INTO ESF_Company (CompanyId, CompanyName, DeviceLimit, UserLimit) VALUES (1, 'REALESS', 100, 50);",
                [],
            )?;

            // Usuários com senhas hasheadas SHA-256
            let hash_master = hash_password("root123");
            let hash_gestor = hash_password("Ope@2025");
            let hash_admin = hash_password("admin");
            let hash_gestor2 = hash_password("gestor");
            let hash_colab = hash_password("colab");

            self.conn().execute(
                "INSERT INTO ESF_User (Username, PasswordHash, DisplayName, Role, CompanyId) VALUES
                (?1, ?2, 'Vicenzzo Master', 'master', NULL),
                (?3, ?4, 'Vicenzzo Mastronikolis', 'gestor', 1),
                (?5, ?6, 'Administrador', 'master', NULL),
                (?7, ?8, 'Carlos Gestor', 'gestor', 1),
                (?9, ?10, 'Ana Operadora', 'colaborador', 1);",
                params![
                    "vicenzzo.master", hash_master,
                    "vicenzzo.mastronikolis", hash_gestor,
                    "admin", hash_admin,
                    "gestor", hash_gestor2,
                    "colab", hash_colab,
                ],
            )?;

            // Permissões padrão para o gestor (UserId = 2)
            self.conn().execute(
                "INSERT INTO ESF_Permission (UserId, PermissionKey, Enabled) VALUES
                (2, 'allow_all_tabs', 1),
                (2, 'allow_edit_devices', 1),
                (2, 'allow_manage_users', 0),
                (2, 'allow_dashboard', 1),
                (2, 'is_active', 1);",
                [],
            )?;

            // Permissões de setor para o gestor
            self.conn().execute(
                "INSERT INTO ESF_SectorPermission (UserId, Sector, CanView, CanConfigure) VALUES
                (2, 'junior', 1, 1),
                (2, 'senior', 1, 1),
                (2, 'pesquisa', 1, 0),
                (2, 'pa_fixa_1', 1, 0),
                (2, 'pa_fixa_2', 1, 0);",
                [],
            )?;

            // Pré-cadastra os 8 celulares Wi-Fi ativados da REALESS para garantia de exibição instantânea a 0ms
            let default_devices = vec![
                ("192.168.1.185:5555", "Aparelho 1", "Xiaomi", "Redmi Note", "192.168.1.185", 1, "junior"),
                ("192.168.1.35:5555", "Aparelho 2", "Multilaser", "F Pro 2", "192.168.1.35", 2, "junior"),
                ("192.168.1.54:5555", "Aparelho 3", "Samsung", "Galaxy A01", "192.168.1.54", 3, "junior"),
                ("192.168.1.57:5555", "Aparelho 4", "Xiaomi", "Redmi 9", "192.168.1.57", 4, "junior"),
                ("192.168.1.92:5555", "Aparelho 5", "Samsung", "Galaxy J7", "192.168.1.92", 5, "junior"),
                ("192.168.1.93:5555", "Aparelho 6", "Motorola", "Moto G22", "192.168.1.93", 6, "junior"),
                ("192.168.1.94:5555", "Aparelho 7", "Motorola", "Moto G", "192.168.1.94", 7, "junior"),
                ("192.168.1.95:5555", "Aparelho 8", "Multilaser", "F Pro 2", "192.168.1.95", 8, "junior"),
            ];

            for (serial, name, brand, model, ip, num, sector) in default_devices {
                let esfera_id = format!("ESF-LEGACY-{}", num);
                let _ = self.conn().execute(
                    "INSERT INTO ESF_Device (AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId)
                    VALUES (?1, ?2, ?3, ?4, ?5, 5555, 'offline', 100, 1, ?6, ?7, ?8)
                    ON CONFLICT(AdbDeviceId) DO NOTHING;",
                    params![serial, name, brand, model, ip, num, sector, esfera_id],
                );
            }
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

        let conn = self.conn();
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

    pub fn upsert_device(&self, device: &Device) -> Result<(), String> {
        let target_comp = if device.company_id <= 0 { 1 } else { device.company_id };
        self.conn()
            .execute(
                "INSERT INTO ESF_Device (AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(AdbDeviceId) DO UPDATE SET
                DeviceName=excluded.DeviceName, Brand=excluded.Brand, Model=excluded.Model,
                DeviceIp=excluded.DeviceIp, DevicePort=excluded.DevicePort, Status=excluded.Status,
                BatteryLevel=excluded.BatteryLevel, DeviceNumber=excluded.DeviceNumber, Sector=excluded.Sector,
                EsferaDeviceId=COALESCE(excluded.EsferaDeviceId, ESF_Device.EsferaDeviceId),
                CurrentAdbAddress=excluded.CurrentAdbAddress, LastSeenUTC=excluded.LastSeenUTC;",
                params![
                    device.serial,
                    device.name,
                    device.brand,
                    device.model,
                    device.ip,
                    device.port,
                    device.status,
                    device.battery,
                    target_comp,
                    device.device_number,
                    device.sector,
                    device.esfera_device_id,
                    device.current_adb_address,
                    device.last_seen_utc,
                ],
            )
            .map_err(|e| e.to_string())?;
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
            })
        });

        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }
    pub fn delete_device(&self, serial: &str) -> Result<(), String> {
        self.conn().execute(
            "DELETE FROM ESF_Device WHERE AdbDeviceId = ?1 OR EsferaDeviceId = ?1 OR CurrentAdbAddress = ?1;",
            params![serial],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn process_checkin(&self, device_id: &str, adb_address: &str, ip: &str, port: u16, now: &str) -> Result<usize, String> {
        self.conn().execute(
            "UPDATE ESF_Device SET
                CurrentAdbAddress = ?1,
                Status = 'online',
                LastSeenUTC = ?2,
                DeviceIp = ?3,
                DevicePort = ?4
             WHERE EsferaDeviceId = ?5",
            params![adb_address, now, ip, port, device_id],
        ).map_err(|e| e.to_string())
    }

    pub fn insert_unknown_device(&self, device_id: &str, adb_address: &str, ip: &str, port: u16, now: &str) -> Result<usize, String> {
        self.conn().execute(
            "INSERT INTO ESF_Device (AdbDeviceId, EsferaDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, CurrentAdbAddress, LastSeenUTC)
             VALUES (?1, ?2, 'Desconhecido', 'Android', 'Smartphone', ?3, ?4, 'online', 100, 1, 0, 'junior', ?5, ?6)
             ON CONFLICT(EsferaDeviceId) DO UPDATE SET
             CurrentAdbAddress=excluded.CurrentAdbAddress, Status='online', LastSeenUTC=excluded.LastSeenUTC,
             DeviceIp=excluded.DeviceIp, DevicePort=excluded.DevicePort",
            params![format!("agent-{}", device_id), device_id, ip, port, adb_address, now],
        ).map_err(|e| e.to_string())
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
        self.conn().execute(&sql, []).map_err(|e| e.to_string())
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
            })
        }).ok()
    }

    // ============================================================
    // CAMPANHAS (com soft delete)
    // ============================================================

    pub fn get_campaigns(&self, company_id: i32) -> Vec<Campaign> {
        let conn = self.conn();
        let mut stmt = match conn.prepare_cached(
            "SELECT CampaignId, CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId, UpdatedAt
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
                ai_prompt: row.get(10)?,
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

    pub fn create_campaign(&self, c: &Campaign) -> Result<i32, String> {
        self.conn().execute(
            "INSERT INTO ESF_Campaign (CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15);",
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
            ]
        ).map_err(|e| e.to_string())?;
        Ok(self.conn().last_insert_rowid() as i32)
    }

    pub fn get_running_campaigns(&self) -> Result<Vec<Campaign>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT CampaignId, CampaignName, MessageGreeting, MessageBody, MessageClosing, DelayMin, DelayMax, UseSpintax, UseAI, AiModel, AiPrompt, Status, TotalContacts, SentContacts, FailedContacts, CompanyId, UpdatedAt FROM ESF_Campaign WHERE Status = 'running' AND ExcluidoEm IS NULL"
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
                ai_prompt: row.get(10)?,
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
        self.conn().execute(
            "UPDATE ESF_Campaign SET SentContacts = SentContacts + 1, UpdatedAt = datetime('now') WHERE CampaignId = ?1",
            params![campaign_id],
        )?;
        Ok(())
    }

    pub fn update_campaign(&self, c: &Campaign) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Campaign SET CampaignName=?1, MessageGreeting=?2, MessageBody=?3, MessageClosing=?4,
             DelayMin=?5, DelayMax=?6, UseSpintax=?7, UseAI=?8, AiModel=?9, AiPrompt=?10,
             Status=?11, TotalContacts=?12, SentContacts=?13, FailedContacts=?14, UpdatedAt=datetime('now')
             WHERE CampaignId=?15 AND ExcluidoEm IS NULL;",
            params![
                c.name, c.greeting, c.message, c.closing,
                c.delay_min, c.delay_max,
                if c.use_spintax { 1 } else { 0 },
                if c.use_ai { 1 } else { 0 },
                c.ai_model, c.ai_prompt, c.status,
                c.contacts_count, c.sent_count, c.failed_count,
                c.id,
            ]
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn soft_delete_campaign(&self, id: i32) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Campaign SET ExcluidoEm=datetime('now'), Status='stopped' WHERE CampaignId=?1;",
            params![id],
        ).map_err(|e| e.to_string())?;
        // Soft delete contatos também
        self.conn().execute(
            "UPDATE ESF_Contact SET ExcluidoEm=datetime('now') WHERE CampaignId=?1 AND ExcluidoEm IS NULL;",
            params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
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
        self.conn().execute(
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
        // Soft delete pending anteriores (substitui)
        self.conn().execute(
            "UPDATE ESF_Contact SET ExcluidoEm=datetime('now') WHERE CampaignId=?1 AND Status='pending' AND ExcluidoEm IS NULL;",
            params![campaign_id],
        ).map_err(|e| e.to_string())?;

        for (name, phone) in contacts_list {
            self.conn().execute(
                "INSERT INTO ESF_Contact (CampaignId, ContactName, Phone, Status) VALUES (?1, ?2, ?3, 'pending');",
                params![campaign_id, name, phone],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn update_contact_status(&self, contact_id: i32, status: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Contact SET Status=?1, SentAt=datetime('now') WHERE ContactId=?2;",
            params![status, contact_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_contact_custom_message(&self, contact_id: i32, message: &str) -> Result<(), String> {
        self.conn().execute(
            "UPDATE ESF_Contact SET CustomMessage=?1 WHERE ContactId=?2;",
            params![message, contact_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_next_pending_contact(&self, campaign_id: i32) -> Option<Contact> {
        self.conn().query_row(
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
        ).ok()
    }

    // ============================================================
    // SENT HISTORY (dedup)
    // ============================================================

    pub fn was_already_sent(&self, phone: &str, campaign_id: i32) -> bool {
        let count: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_SentHistory WHERE Phone = ?1 AND CampaignId = ?2;",
            params![phone, campaign_id],
            |row| row.get(0),
        ).unwrap_or(0);
        count > 0
    }

    pub fn mark_as_sent(&self, phone: &str, campaign_id: i32) -> Result<(), String> {
        self.conn().execute(
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
        Ok(())
    }

    // ============================================================
    // PERMISSIONS
    // ============================================================

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
        // Get next 5 pending contacts
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
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

        for (contact_id, _name, _phone) in &contacts {
            // Check dedup via SentHistory
            let already: bool = self.conn().query_row(
                "SELECT COUNT(*) > 0 FROM ESF_SentHistory
                 WHERE CampaignId=?1 AND Phone=(SELECT Phone FROM ESF_Contact WHERE ContactId=?2);",
                params![campaign_id, contact_id],
                |row| row.get(0),
            ).unwrap_or(false);

            if !already {
                // Mark as sent
                let _ = self.conn().execute(
                    "UPDATE ESF_Contact SET Status='sent', SentAt=datetime('now')
                     WHERE ContactId=?1;",
                    params![contact_id],
                );

                // Record in sent history
                let _ = self.conn().execute(
                    "INSERT INTO ESF_SentHistory (CampaignId, Phone, SentAt)
                     SELECT ?1, Phone, datetime('now') FROM ESF_Contact WHERE ContactId=?2;",
                    params![campaign_id, contact_id],
                );
            } else {
                // Already sent - mark as skipped
                let _ = self.conn().execute(
                    "UPDATE ESF_Contact SET Status='sent' WHERE ContactId=?1;",
                    params![contact_id],
                );
            }
        }

        // Update campaign counters
        let _ = self.conn().execute(
            "UPDATE ESF_Campaign SET
             SentCount = (SELECT COUNT(*) FROM ESF_Contact WHERE CampaignId=?1 AND Status='sent' AND ExcluidoEm IS NULL)
             WHERE CampaignId=?1;",
            params![campaign_id],
        );

        // Check if campaign is complete
        let remaining: i32 = self.conn().query_row(
            "SELECT COUNT(*) FROM ESF_Contact
             WHERE CampaignId=?1 AND Status='pending' AND ExcluidoEm IS NULL;",
            params![campaign_id],
            |row| row.get(0),
        ).unwrap_or(0);

        if remaining == 0 {
            let _ = self.conn().execute(
                "UPDATE ESF_Campaign SET Status='completed' WHERE CampaignId=?1;",
                params![campaign_id],
            );
        }

        Ok(serde_json::json!({
            "sent_in_batch": total_sent,
            "remaining": remaining,
            "campaign_complete": remaining == 0,
        }))
    }

    pub fn update_campaign_status(&self, campaign_id: i32, status: &str) -> Result<(), String> {
        self.set_campaign_status(campaign_id, status)
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
            "DELETE FROM ESF_DeviceAssignment WHERE AdbDeviceId = ?1 AND UserId = ?2;",
            params![device_serial, user_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_assigned_devices_for_user(&self, user_id: i32, company_id: i32) -> Vec<Device> {
        let conn = self.conn();
        let sql = "SELECT rowid, d.AdbDeviceId, d.DeviceName, d.Brand, d.Model, d.DeviceIp, d.DevicePort, d.Status, d.BatteryLevel, d.CompanyId, d.DeviceNumber, d.Sector,
                          d.EsferaDeviceId, d.CurrentAdbAddress, d.LastSeenUTC
                   FROM ESF_Device d
                   INNER JOIN ESF_DeviceAssignment da ON d.AdbDeviceId = da.AdbDeviceId
                   WHERE da.UserId = ?1 AND (d.CompanyId = ?2 OR ?2 <= 0);";

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
                   WHERE (u.CompanyId = ?1 OR ?1 <= 0)
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
        let sql = "SELECT d.rowid, d.AdbDeviceId, d.DeviceName, d.Brand, d.Model, d.DeviceIp, d.DevicePort, d.Status, d.BatteryLevel, d.CompanyId, d.DeviceNumber, d.Sector,
                          d.EsferaDeviceId, d.CurrentAdbAddress, d.LastSeenUTC,
                          pr.UserId, u.Username, u.DisplayName, pr.RequestId,
                          da.UserId, au.DisplayName
                   FROM ESF_Device d
                   LEFT JOIN ESF_DevicePermissionRequest pr ON d.AdbDeviceId = pr.AdbDeviceId AND pr.Status IN ('approved', 'active')
                   LEFT JOIN ESF_User u ON pr.UserId = u.UserId
                   LEFT JOIN ESF_DeviceAssignment da ON d.AdbDeviceId = da.AdbDeviceId
                   LEFT JOIN ESF_User au ON da.UserId = au.UserId
                   WHERE (d.CompanyId = ?1 OR ?1 <= 0);";

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
}
