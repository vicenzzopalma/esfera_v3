use crate::db::User;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub token: String,
    pub user_id: i32,
    pub username: String,
    pub role: String,
    pub company_id: Option<i32>,
    pub created_at: i64,
    pub expires_at: i64,
}

impl UserSession {
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        now >= self.expires_at
    }
}

pub struct SessionManager {
    sessions: HashMap<String, UserSession>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    fn generate_token() -> String {
        let mut rng = rand::thread_rng();
        (0..64).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
    }

    pub fn create_session(&mut self, user_id: i32, username: &str, role: &str, company_id: Option<i32>) -> String {
        let token = Self::generate_token();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        self.cleanup_expired();
        self.sessions.insert(token.clone(), UserSession {
            token: token.clone(),
            user_id,
            username: username.to_string(),
            role: role.to_string(),
            company_id,
            created_at: now,
            expires_at: now + 24 * 60 * 60 * 1000,
        });
        token
    }

    pub fn validate_token(&self, token: &str) -> Option<UserSession> {
        let session = self.sessions.get(token)?.clone();
        if session.is_expired() {
            return None;
        }
        Some(session)
    }

    pub fn remove_session(&mut self, token: &str) {
        self.sessions.remove(token);
    }

    pub fn cleanup_expired(&mut self) {
        self.sessions.retain(|_, s| !s.is_expired());
    }
}
