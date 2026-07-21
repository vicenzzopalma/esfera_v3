// ============================================================
// Esfera v3 — Motor de Inteligência Artificial (ai_engine.rs)
// Suporte nativo a Ollama, OpenAI, Anthropic e Custom Endpoint
// ============================================================

use crate::db::AiConfig;
use reqwest::Client;
use serde_json::json;
use std::time::Duration;

pub struct AiEngine;

impl AiEngine {
    /// Reescreve ou gera mensagens personalizadas utilizando o provedor configurado
    pub async fn generate_message(
        config: &AiConfig,
        base_message: &str,
        contact_name: &str,
    ) -> Result<String, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Falha ao criar cliente HTTP IA: {}", e))?;

        let prompt = if !config.system_prompt.is_empty() {
            format!(
                "{}\n\nReescreva a mensagem para o contato '{}':\n{}",
                config.system_prompt, contact_name, base_message
            )
        } else {
            format!(
                "Reescreva a seguinte mensagem comercial para o contato '{}' de forma natural, amigável e persuasiva, mantendo a variável {{nome}} se houver:\n{}",
                contact_name, base_message
            )
        };

        let raw_response = match config.provider.to_lowercase().as_str() {
            "ollama" => Self::call_ollama(&client, config, &prompt).await?,
            "openai" => Self::call_openai(&client, config, &prompt).await?,
            "anthropic" => Self::call_anthropic(&client, config, &prompt).await?,
            "custom" => Self::call_custom_endpoint(&client, config, &prompt).await?,
            _ => Self::call_ollama(&client, config, &prompt).await?,
        };

        let sanitized = Self::sanitize_ai_response(&raw_response, contact_name);
        Ok(sanitized)
    }

    /// Requisição para Ollama Local/Cloud (API /api/generate)
    async fn call_ollama(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() {
            "http://localhost:11434/api/generate".to_string()
        } else if !config.endpoint.contains("/api/generate") {
            format!("{}/api/generate", config.endpoint.trim_end_matches('/'))
        } else {
            config.endpoint.clone()
        };

        let model = if config.model.is_empty() { "llama3".to_string() } else { config.model.clone() };

        let payload = json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "options": {
                "temperature": config.temperature
            }
        });

        let res = client.post(&endpoint)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Falha na chamada ao Ollama: {}", e))?;

        if !res.status().is_success() {
            return Err(format!("Ollama retornou status de erro HTTP: {}", res.status()));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta Ollama inválida: {}", e))?;
        body["response"].as_str().map(|s| s.to_string()).ok_or_else(|| "Resposta Ollama vazia".to_string())
    }

    /// Requisição para OpenAI API (/v1/chat/completions)
    async fn call_openai(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() {
            "https://api.openai.com/v1/chat/completions".to_string()
        } else if !config.endpoint.contains("/chat/completions") {
            format!("{}/v1/chat/completions", config.endpoint.trim_end_matches('/'))
        } else {
            config.endpoint.clone()
        };

        let model = if config.model.is_empty() { "gpt-4o-mini".to_string() } else { config.model.clone() };

        let payload = json!({
            "model": model,
            "temperature": config.temperature,
            "messages": [
                { "role": "system", "content": "Você é um assistente especialista em redação de mensagens para WhatsApp." },
                { "role": "user", "content": prompt }
            ]
        });

        let req = client.post(&endpoint)
            .json(&payload);

        let req = if !config.api_key.is_empty() {
            req.bearer_auth(&config.api_key)
        } else {
            req
        };

        let res = req.send().await.map_err(|e| format!("Falha na chamada OpenAI: {}", e))?;
        if !res.status().is_success() {
            return Err(format!("OpenAI retornou erro HTTP: {}", res.status()));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta OpenAI inválida: {}", e))?;
        body["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Conteúdo OpenAI não encontrado".to_string())
    }

    /// Requisição para Anthropic API (/v1/messages)
    async fn call_anthropic(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() {
            "https://api.anthropic.com/v1/messages".to_string()
        } else {
            config.endpoint.clone()
        };

        let model = if config.model.is_empty() { "claude-3-haiku-20240307".to_string() } else { config.model.clone() };

        let payload = json!({
            "model": model,
            "max_tokens": 1000,
            "messages": [
                { "role": "user", "content": prompt }
            ]
        });

        let res = client.post(&endpoint)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Falha na chamada Anthropic: {}", e))?;

        if !res.status().is_success() {
            return Err(format!("Anthropic retornou erro HTTP: {}", res.status()));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta Anthropic inválida: {}", e))?;
        body["content"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Conteúdo Anthropic não encontrado".to_string())
    }

    /// Requisição para Endpoint Customizado (formato OpenAI)
    async fn call_custom_endpoint(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        Self::call_openai(client, config, prompt).await
    }

    /// Sanitiza o texto retornado pela IA para remover markdown, aspas e ajustar o nome
    pub fn sanitize_ai_response(raw_text: &str, contact_name: &str) -> String {
        let mut text = raw_text.trim().to_string();

        if text.starts_with('"') && text.ends_with('"') && text.len() > 2 {
            text = text[1..text.len() - 1].to_string();
        }

        text = text.replace("{nome}", contact_name);
        text
    }
}
