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

        let default_system = "Você é um assistente humano brasileiro redigindo mensagens diretas no WhatsApp.\n\
            REGRAS OBRIGATÓRIAS:\n\
            1. Retorne APENAS o texto da mensagem final pronto para envio. NUNCA adicione introduções (como 'Aqui está', 'Segue a mensagem:'), explicações ou aspas.\n\
            2. Mantenha intactos todos os links (http/https), números de telefone, chaves PIX, datas e valores (R$).\n\
            3. Use tom natural, coloquial, amigável e direto. Evite parecer robô ou telemarketing formal.\n\
            4. Use no máximo 1 ou 2 emojis.\n\
            5. Preserve a variável {nome} ou o nome do contato.";

        let prompt = if !config.system_prompt.is_empty() {
            format!(
                "{}\n\n{}\n\nReescreva a mensagem para o contato '{}':\n{}",
                default_system, config.system_prompt, contact_name, base_message
            )
        } else {
            format!(
                "{}\n\nReescreva a mensagem para o contato '{}':\n{}",
                default_system, contact_name, base_message
            )
        };

        let raw_response = match config.provider.to_lowercase().as_str() {
            "groq" => Self::call_groq(&client, config, &prompt).await?,
            "openrouter" => Self::call_openrouter(&client, config, &prompt).await?,
            "cerebras" => Self::call_cerebras(&client, config, &prompt).await?,
            "lmstudio" | "lm_studio" => Self::call_lmstudio(&client, config, &prompt).await?,
            "ollama" | "ollama_local" => Self::call_ollama(&client, config, &prompt).await?,
            "openai" => Self::call_openai(&client, config, &prompt).await?,
            "anthropic" => Self::call_anthropic(&client, config, &prompt).await?,
            "custom" => Self::call_custom_endpoint(&client, config, &prompt).await?,
            _ => {
                // Fallback inteligente: se tem URL de custom/openai, chama openai; senão ollama
                if config.endpoint.contains("groq.com") {
                    Self::call_groq(&client, config, &prompt).await?
                } else if config.endpoint.contains("openrouter.ai") {
                    Self::call_openrouter(&client, config, &prompt).await?
                } else if config.endpoint.contains("cerebras.ai") {
                    Self::call_cerebras(&client, config, &prompt).await?
                } else if !config.endpoint.is_empty() && !config.endpoint.contains("11434") {
                    Self::call_custom_endpoint(&client, config, &prompt).await?
                } else {
                    Self::call_ollama(&client, config, &prompt).await?
                }
            }
        };

        let sanitized = Self::sanitize_ai_response(&raw_response, contact_name);
        Ok(sanitized)
    }

    /// Requisição para GroqCloud (API Free Tier ultrarrápida compatível com OpenAI)
    async fn call_groq(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let mut groq_cfg = config.clone();
        if groq_cfg.endpoint.is_empty() || !groq_cfg.endpoint.contains("groq.com") {
            groq_cfg.endpoint = "https://api.groq.com/openai/v1/chat/completions".to_string();
        }
        if groq_cfg.model.is_empty() {
            groq_cfg.model = "llama-3.3-70b-versatile".to_string();
        }
        if groq_cfg.api_key.trim().is_empty() {
            return Err("Chave de API do Groq não configurada. Obtenha grátis em https://console.groq.com/keys e configure em Parâmetros de IA.".to_string());
        }
        match Self::call_openai(client, &groq_cfg, prompt).await {
            Ok(content) => Ok(content),
            Err(first_err) => {
                let is_recoverable = first_err.contains("404") || first_err.contains("429") || first_err.contains("503") || first_err.contains("decommissioned");
                if is_recoverable && groq_cfg.model != "llama-3.1-8b-instant" {
                    eprintln!("[GROQ RESILIÊNCIA] Modelo '{}' falhou. Tentando fallback para 'llama-3.1-8b-instant'...", groq_cfg.model);
                    let mut fallback_cfg = groq_cfg.clone();
                    fallback_cfg.model = "llama-3.1-8b-instant".to_string();
                    if let Ok(content) = Self::call_openai(client, &fallback_cfg, prompt).await {
                        return Ok(content);
                    }
                }
                Err(first_err)
            }
        }
    }

    /// Requisição para OpenRouter (Modelos 100% Free com sufixo :free ou router)
    async fn call_openrouter(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let mut router_cfg = config.clone();
        if router_cfg.endpoint.is_empty() || !router_cfg.endpoint.contains("openrouter.ai") {
            router_cfg.endpoint = "https://openrouter.ai/api/v1/chat/completions".to_string();
        }
        if router_cfg.api_key.trim().is_empty() {
            return Err("Chave de API do OpenRouter não configurada. Obtenha grátis em https://openrouter.ai/keys e configure em Parâmetros de IA.".to_string());
        }

        // Sanitização proativa: substitui slugs descontinuados conhecidos do OpenRouter
        let clean_model = router_cfg.model.trim();
        let normalized_model = Self::normalize_openrouter_model(clean_model);
        if normalized_model != clean_model {
            eprintln!(
                "[OPENROUTER] Slug sanitizado no OpenRouter ('{}' -> '{}').",
                clean_model, normalized_model
            );
        }
        router_cfg.model = normalized_model;

        // Tenta a chamada com o modelo selecionado
        match Self::call_openai(client, &router_cfg, prompt).await {
            Ok(content) => Ok(content),
            Err(initial_err) => {
                // Se o erro indicar modelo indisponível, 404, 402, 429 ou erro upstream, executa fallback resiliente
                let is_recoverable = initial_err.contains("404")
                    || initial_err.contains("unavailable for free")
                    || initial_err.contains("402")
                    || initial_err.contains("Payment Required")
                    || initial_err.contains("Insufficient credits")
                    || initial_err.contains("out of credit")
                    || initial_err.contains("429")
                    || initial_err.contains("500")
                    || initial_err.contains("502")
                    || initial_err.contains("503")
                    || initial_err.contains("No available endpoints")
                    || initial_err.contains("rate-limited");

                if !is_recoverable {
                    return Err(initial_err);
                }

                let fallbacks = [
                    "openrouter/free",
                    "minimax/minimax-m3.1-flash:free",
                    "nvidia/nemotron-3.5-lightning:free",
                    "liquid/lfm-2.5-2.6b:free",
                    "google/gemma-4-26b-a4b-it:free",
                ];

                for fb_model in fallbacks {
                    if fb_model == router_cfg.model {
                        continue;
                    }
                    eprintln!(
                        "[OPENROUTER RESILIÊNCIA] Modelo inicial '{}' falhou ({}). Tentando fallback automático para '{}'...",
                        router_cfg.model, initial_err, fb_model
                    );
                    let mut fallback_cfg = router_cfg.clone();
                    fallback_cfg.model = fb_model.to_string();
                    if let Ok(content) = Self::call_openai(client, &fallback_cfg, prompt).await {
                        eprintln!("[OPENROUTER RESILIÊNCIA] Sucesso com modelo fallback '{}'!", fb_model);
                        return Ok(content);
                    }
                }

                Err(initial_err)
            }
        }
    }

    /// Normaliza slugs de modelos do OpenRouter, redirecionando modelos gratuitos descontinuados para o router oficial
    pub fn normalize_openrouter_model(model: &str) -> String {
        let clean = model.trim();
        if clean.is_empty() {
            return "openrouter/free".to_string();
        }
        let lower = clean.to_lowercase();
        if lower == "qwen/qwen-2.5-72b-instruct:free"
            || lower == "qwen/qwen-2.5-72b-instruct"
            || lower == "meta-llama/llama-3.3-70b-instruct:free"
            || lower == "meta-llama/llama-3.1-405b-instruct:free"
            || lower == "meta-llama/llama-3-70b-instruct:free"
            || lower == "google/gemma-2-9b-it:free"
            || lower.contains("qwen-2.5-72b")
        {
            return "openrouter/free".to_string();
        }
        clean.to_string()
    }

    /// Requisição para Cerebras Cloud (LPUs de alta velocidade com Free Tier)
    async fn call_cerebras(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let mut cer_cfg = config.clone();
        if cer_cfg.endpoint.is_empty() || !cer_cfg.endpoint.contains("cerebras.ai") {
            cer_cfg.endpoint = "https://api.cerebras.ai/v1/chat/completions".to_string();
        }
        if cer_cfg.model.is_empty() {
            cer_cfg.model = "llama3.1-8b".to_string();
        }
        if cer_cfg.api_key.trim().is_empty() {
            return Err("Chave de API do Cerebras Cloud não configurada. Obtenha grátis em https://cloud.cerebras.ai e configure em Parâmetros de IA.".to_string());
        }
        Self::call_openai(client, &cer_cfg, prompt).await
    }

    /// Requisição para LM Studio Local (Interface visual na porta 1234)
    async fn call_lmstudio(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let mut lms_cfg = config.clone();
        if lms_cfg.endpoint.is_empty() || !lms_cfg.endpoint.contains("1234") {
            lms_cfg.endpoint = "http://localhost:1234/v1/chat/completions".to_string();
        }
        if lms_cfg.model.is_empty() {
            lms_cfg.model = "local-model".to_string();
        }
        Self::call_openai(client, &lms_cfg, prompt).await
    }

    /// Requisição para Ollama Local/Cloud (API /api/generate)
    async fn call_ollama(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() || !config.endpoint.contains("11434") {
            "http://localhost:11434/api/generate".to_string()
        } else if !config.endpoint.contains("/api/generate") {
            format!("{}/api/generate", config.endpoint.trim_end_matches('/'))
        } else {
            config.endpoint.clone()
        };

        let model = if config.model.is_empty() { "llama3.2:3b".to_string() } else { config.model.clone() };

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
            .map_err(|e| format!("Falha ao conectar no Ollama (porta 11434): {}", e))?;

        if !res.status().is_success() {
            return Err(format!("Ollama retornou status HTTP {}: certifique-se de que o modelo '{}' está instalado", res.status(), model));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta Ollama inválida: {}", e))?;
        body["response"].as_str().map(|s| s.to_string()).ok_or_else(|| "Resposta Ollama vazia".to_string())
    }

    /// Requisição para OpenAI API (/v1/chat/completions) ou endpoints compatíveis
    async fn call_openai(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() {
            "https://api.openai.com/v1/chat/completions".to_string()
        } else if !config.endpoint.contains("/chat/completions") && !config.endpoint.contains("/v1") {
            format!("{}/v1/chat/completions", config.endpoint.trim_end_matches('/'))
        } else if !config.endpoint.contains("/chat/completions") {
            format!("{}/chat/completions", config.endpoint.trim_end_matches('/'))
        } else {
            config.endpoint.clone()
        };

        let model = if config.model.is_empty() { "gpt-4o-mini".to_string() } else { config.model.clone() };

        let payload = json!({
            "model": model,
            "temperature": config.temperature,
            "messages": [
                {
                    "role": "system",
                    "content": "Você é um assistente humano brasileiro redigindo mensagens diretas para WhatsApp. Retorne APENAS o texto pronto para envio, sem aspas, introduções ou explicações adicionais."
                },
                { "role": "user", "content": prompt }
            ]
        });

        let mut req = client.post(&endpoint).json(&payload);

        // Headers recomendados para OpenRouter (evita rate limits e prioriza free models)
        if endpoint.contains("openrouter.ai") {
            req = req
                .header("HTTP-Referer", "https://esfera.local")
                .header("X-Title", "Esfera v3");
        }

        if !config.api_key.is_empty() {
            req = req.bearer_auth(&config.api_key);
        }

        let res = req.send().await.map_err(|e| format!("Falha de conexão com IA ({endpoint}): {e}"))?;
        if !res.status().is_success() {
            let status_code = res.status();
            let err_body = res.text().await.unwrap_or_default();
            return Err(format!("Provedor IA retornou erro HTTP {status_code}: {err_body}"));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta de IA inválida: {e}"))?;
        if let Some(err_msg) = body.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
            return Err(format!("Erro da API de IA: {err_msg}"));
        }
        body["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Conteúdo de IA não encontrado no retorno".to_string())
    }

    /// Requisição para Anthropic API (/v1/messages)
    async fn call_anthropic(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let endpoint = if config.endpoint.is_empty() {
            "https://api.anthropic.com/v1/messages".to_string()
        } else {
            config.endpoint.clone()
        };

        if config.api_key.trim().is_empty() {
            return Err("Chave de API Anthropic Claude não configurada.".to_string());
        }

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
            .map_err(|e| format!("Falha na chamada Anthropic: {e}"))?;

        if !res.status().is_success() {
            let status_code = res.status();
            let err_body = res.text().await.unwrap_or_default();
            return Err(format!("Anthropic retornou erro HTTP {status_code}: {err_body}"));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| format!("Resposta Anthropic inválida: {e}"))?;
        body["content"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Conteúdo Anthropic não encontrado".to_string())
    }

    /// Requisição para Endpoint Customizado (formato OpenAI)
    async fn call_custom_endpoint(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        Self::call_openai(client, config, prompt).await
    }

    /// Substitui variáveis de contato ({nome}, {Nome}, etc.) de forma resiliente.
    /// Se o nome for vazio, limpa pontuação residual como espaços antes de vírgula.
    pub fn replace_contact_name(template: &str, contact_name: &str) -> String {
        let clean_name = contact_name.trim();
        if clean_name.is_empty() {
            template
                .replace("{nome}", "")
                .replace("{Nome}", "")
                .replace("{NOME}", "")
                .replace("{name}", "")
                .replace("{Name}", "")
                .replace(" ,", ",")
                .replace(" !", "!")
                .replace(" ?", "?")
                .replace("  ", " ")
                .trim()
                .to_string()
        } else {
            template
                .replace("{nome}", clean_name)
                .replace("{Nome}", clean_name)
                .replace("{NOME}", clean_name)
                .replace("{name}", clean_name)
                .replace("{Name}", clean_name)
        }
    }

    /// Sanitiza o texto retornado pela IA para remover markdown invasivo, blocos de código,
    /// JSON acidental, prefixos robóticos, aspas, notas de rodapé, preservando URLs, PIX e valores.
    pub fn sanitize_ai_response(raw_text: &str, contact_name: &str) -> String {
        let mut text = raw_text.trim().to_string();
        text = text.replace("\r\n", "\n").replace('\r', "\n");

        // 1. Extrai conteúdo dentro de blocos de código ```markdown ... ``` ou ``` ... ```
        if let Some(start_fence) = text.find("```") {
            let after_start = &text[start_fence + 3..];
            let content_start = if let Some(newline_pos) = after_start.find('\n') {
                start_fence + 3 + newline_pos + 1
            } else {
                start_fence + 3
            };

            if let Some(end_fence) = text[content_start..].rfind("```") {
                let inner = &text[content_start..content_start + end_fence];
                text = inner.trim().to_string();
            } else if start_fence == 0 {
                text = text[content_start..].trim().to_string();
            }
        }

        // 2. Extrai de objeto JSON caso o modelo tenha retornado schema JSON
        if (text.starts_with('{') && text.ends_with('}')) || (text.contains("{\"") && text.ends_with('}')) {
            let json_slice = if let Some(idx) = text.find('{') {
                &text[idx..]
            } else {
                &text
            };
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_slice) {
                let candidate = parsed.get("message")
                    .or_else(|| parsed.get("response"))
                    .or_else(|| parsed.get("text"))
                    .or_else(|| parsed.get("content"))
                    .or_else(|| parsed.get("output"))
                    .or_else(|| parsed.get("rewritten"))
                    .or_else(|| parsed.get("result"))
                    .or_else(|| parsed.get("msg"));

                if let Some(s) = candidate.and_then(|v| v.as_str()) {
                    text = s.trim().to_string();
                }
            }
        }

        // 3. Remove citações markdown do início de linhas (ex: `> Olá {nome}`)
        text = Self::strip_blockquotes(&text);

        // 4. Remove cabeçalhos markdown ou converte em negrito
        text = Self::clean_markdown_headers(&text);

        // 5. Remove prefixos comuns de IA em loop (até 3 passagens consecutivas)
        let prefixes = [
            "aqui está a mensagem reescrita:",
            "aqui está sua mensagem reescrita:",
            "aqui está uma versão reescrita:",
            "aqui está a versão humanizada:",
            "aqui está a mensagem humanizada:",
            "aqui está a mensagem:",
            "aqui está sua mensagem:",
            "aqui está uma mensagem:",
            "aqui está uma versão:",
            "aqui está uma opção:",
            "aqui está uma sugestão:",
            "aqui está:",
            "aqui vai a mensagem reescrita:",
            "aqui vai a mensagem:",
            "aqui vai uma versão amigável:",
            "aqui vai uma versão:",
            "aqui vai uma opção:",
            "aqui vai:",
            "segue a mensagem reescrita:",
            "segue sua mensagem reescrita:",
            "segue a versão reescrita:",
            "segue a versão humanizada:",
            "segue a mensagem pronta:",
            "segue a mensagem:",
            "segue sua mensagem:",
            "segue uma opção:",
            "segue uma sugestão:",
            "segue:",
            "opção de mensagem:",
            "opção 1:",
            "opção:",
            "mensagem reescrita:",
            "mensagem humanizada:",
            "mensagem final:",
            "mensagem pronta:",
            "mensagem sugerida:",
            "mensagem:",
            "versão reescrita:",
            "versão humanizada:",
            "versão sugerida:",
            "versão 1:",
            "versão:",
            "sugestão de mensagem:",
            "sugestão:",
            "claro! segue uma opção:",
            "claro! segue a mensagem:",
            "claro! aqui está a mensagem:",
            "claro! aqui está uma versão:",
            "claro! aqui está:",
            "claro, aqui está a mensagem:",
            "claro, aqui está sua mensagem:",
            "claro, aqui está:",
            "claro, segue a mensagem:",
            "claro!",
            "com certeza! segue a mensagem:",
            "com certeza! aqui está a mensagem:",
            "com certeza! aqui está:",
            "com certeza!",
            "olá! segue uma opção:",
            "olá! aqui está a mensagem:",
            "olá! segue a mensagem:",
            "resposta:",
            "texto reescrito:",
            "texto final:",
            "texto:",
        ];

        for _ in 0..3 {
            text = Self::strip_outer_quotes(&text);

            // Se começar com negrito markdown como `**Mensagem:**`, remove o rótulo
            if text.starts_with("**") {
                if let Some(end_bold) = text[2..].find("**") {
                    let inside = &text[2..2 + end_bold];
                    if prefixes.iter().any(|p| inside.to_lowercase().starts_with(&p[..p.len().saturating_sub(1)])) {
                        text = text[2 + end_bold + 2..].trim().to_string();
                    }
                }
            }

            let mut matched = false;
            let lower = text.to_lowercase();
            for prefix in &prefixes {
                if lower.starts_with(prefix) {
                    text = text[prefix.len()..].trim().to_string();
                    matched = true;
                    break;
                }
            }

            // Detector dinâmico: se a primeira linha for introdução conversacional terminando em ':'
            // ex: "Aqui está a mensagem reescrita para o contato Mariana:"
            if !matched {
                if let Some(first_line_end) = text.find('\n') {
                    let first_line = text[..first_line_end].trim();
                    let f_lower = first_line.to_lowercase();
                    if f_lower.ends_with(':') && (
                        f_lower.starts_with("aqui está") || f_lower.starts_with("aqui vai")
                        || f_lower.starts_with("segue") || f_lower.starts_with("claro")
                        || f_lower.starts_with("com certeza") || f_lower.starts_with("mensagem")
                        || f_lower.starts_with("versão") || f_lower.starts_with("opção")
                    ) {
                        text = text[first_line_end + 1..].trim().to_string();
                        matched = true;
                    }
                }
            }

            if !matched {
                break;
            }
        }

        // 6. Remove aspas externas residuais
        text = Self::strip_outer_quotes(&text);

        // 7. Remove notas, disclaimers ou placeholders de assinatura no final da mensagem
        text = Self::strip_trailing_disclaimers(&text);

        // 8. Converte links markdown no formato `[Texto](url)` para `Texto: url`
        // Protege contra duplicações (ex: `[https://...](https://...)` -> `https://...`)
        text = Self::convert_markdown_links(&text);

        // 9. Converte markdown negrito `**texto**` para o padrão WhatsApp `*texto*`
        text = Self::convert_markdown_bold(&text);

        // 10. Converte listas com marcadores `* item` para `• item` (evita quebrar formatação negrito no WhatsApp)
        text = Self::convert_bullet_points(&text);

        // 11. Garante substituição de marcadores de nome {nome}, {name}, {Nome}
        text = Self::replace_contact_name(&text, contact_name);

        // 12. Normaliza quebras de linha excessivas (mais de 2 seguidas para no máximo 2)
        while text.contains("\n\n\n") {
            text = text.replace("\n\n\n", "\n\n");
        }

        text.trim().to_string()
    }

    fn strip_outer_quotes(s: &str) -> String {
        let mut t = s.trim();
        // Aspas duplas normais ou curvas, simples ou guillemets
        if (t.starts_with('"') && t.ends_with('"'))
            || (t.starts_with('\'') && t.ends_with('\''))
            || (t.starts_with('“') && t.ends_with('”'))
            || (t.starts_with('«') && t.ends_with('»'))
            || (t.starts_with('”') && t.ends_with('”'))
        {
            if t.chars().count() >= 2 {
                let mut chars = t.chars();
                chars.next();
                chars.next_back();
                t = chars.as_str().trim();
            }
        }
        t.to_string()
    }

    fn strip_blockquotes(s: &str) -> String {
        s.lines()
            .map(|line| {
                let trimmed = line.trim_start();
                if trimmed.starts_with('>') {
                    trimmed.trim_start_matches('>').trim_start()
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn clean_markdown_headers(s: &str) -> String {
        s.lines()
            .map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with('#') {
                    let stripped = trimmed.trim_start_matches('#').trim();
                    let lower = stripped.to_lowercase();
                    // Se for rótulo introdutório, descarta
                    if lower.starts_with("mensagem") || lower.starts_with("resposta") || lower.starts_with("sugestão") || lower.starts_with("opção") {
                        ""
                    } else if !stripped.is_empty() {
                        // Mantém como destaque com asteriscos simples para WhatsApp
                        stripped
                    } else {
                        ""
                    }
                } else {
                    line
                }
            })
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn convert_markdown_bold(s: &str) -> String {
        // Converte `**texto**` para `*texto*` preservando formatação natural do WhatsApp
        let mut result = String::with_capacity(s.len());
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '*' && chars.peek() == Some(&'*') {
                chars.next(); // consome o segundo '*'
                result.push('*');
            } else {
                result.push(c);
            }
        }
        result
    }

    fn convert_bullet_points(s: &str) -> String {
        s.lines()
            .map(|line| {
                let trimmed = line.trim_start();
                if trimmed.starts_with("* ") {
                    format!("• {}", &trimmed[2..])
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn strip_trailing_disclaimers(s: &str) -> String {
        let mut lines: Vec<&str> = s.lines().collect();
        while let Some(last_line) = lines.last() {
            let trimmed = last_line.trim();
            if trimmed.is_empty() {
                lines.pop();
                continue;
            }
            let clean = trimmed.trim_start_matches(|c| c == '*' || c == '_' || c == '-' || c == '•' || c == ' ').trim();
            let lower = clean.to_lowercase();

            let is_disclaimer = lower.starts_with("obs:")
                || lower.starts_with("observação:")
                || lower.starts_with("observacoes:")
                || lower.starts_with("observações:")
                || lower.starts_with("nota:")
                || lower.starts_with("notas:")
                || lower.starts_with("ps:")
                || lower.starts_with("p.s.:")
                || (lower.starts_with('(') && lower.ends_with(')') && (
                    lower.contains("espero") || lower.contains("ajud") || lower.contains("dúvida") || lower.contains("disposi")
                ))
                || lower.starts_with("espero ter ajudado")
                || lower.starts_with("espero que ajude")
                || lower.starts_with("espero que tenha gostado")
                || lower.starts_with("qualquer dúvida estou à disposição")
                || lower.starts_with("qualquer duvida estou a disposicao")
                || lower.starts_with("qualquer dúvida, estou à disposição")
                || lower.starts_with("fique à vontade para ajustar")
                || lower.starts_with("se precisar de ajustes")
                || (lower.starts_with('[') && lower.ends_with(']') && (
                    lower.contains("seu nome") || lower.contains("empresa") || lower.contains("cargo") || lower.contains("atendente")
                ));

            if is_disclaimer {
                lines.pop();
            } else {
                break;
            }
        }
        lines.join("\n").trim().to_string()
    }

    fn convert_markdown_links(s: &str) -> String {
        let mut result = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(open_bracket) = rest.find('[') {
            result.push_str(&rest[..open_bracket]);
            let after_open = &rest[open_bracket + 1..];
            if let Some(close_bracket) = after_open.find(']') {
                let link_text = &after_open[..close_bracket];
                let after_close = &after_open[close_bracket + 1..];
                if after_close.starts_with('(') {
                    if let Some(close_paren) = after_close.find(')') {
                        let url = after_close[1..close_paren].trim();
                        if url.starts_with("http://") || url.starts_with("https://") {
                            let clean_text = link_text.trim();
                            if clean_text == url || clean_text.is_empty() {
                                result.push_str(url);
                            } else {
                                result.push_str(clean_text);
                                result.push_str(": ");
                                result.push_str(url);
                            }
                            rest = &after_close[close_paren + 1..];
                            continue;
                        }
                    }
                }
            }
            result.push('[');
            rest = after_open;
        }
        result.push_str(rest);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_clean_message() {
        let input = "Olá Carlos, seu boleto de R$ 120,00 vence amanhã.";
        let res = AiEngine::sanitize_ai_response(input, "Carlos");
        assert_eq!(res, "Olá Carlos, seu boleto de R$ 120,00 vence amanhã.");
    }

    #[test]
    fn test_sanitize_strip_prefixes() {
        let input = "Aqui está a mensagem reescrita:\nOlá Mariana, tudo bem? Segue a chave PIX: 123456.";
        let res = AiEngine::sanitize_ai_response(input, "Mariana");
        assert_eq!(res, "Olá Mariana, tudo bem? Segue a chave PIX: 123456.");

        let input_bold = "**Mensagem reescrita:**\nOlá Mariana!";
        let res_bold = AiEngine::sanitize_ai_response(input_bold, "Mariana");
        assert_eq!(res_bold, "Olá Mariana!");

        let input_chained = "Claro! Segue uma opção:\n\"Olá {nome}!\"\n";
        let res_chained = AiEngine::sanitize_ai_response(input_chained, "Mariana");
        assert_eq!(res_chained, "Olá Mariana!");

        let input_dynamic = "Aqui está a mensagem reescrita para o contato Mariana:\nOlá Mariana, tudo bem?";
        let res_dynamic = AiEngine::sanitize_ai_response(input_dynamic, "Mariana");
        assert_eq!(res_dynamic, "Olá Mariana, tudo bem?");
    }

    #[test]
    fn test_sanitize_strip_outer_quotes() {
        let input_double = "\"Olá Maria, tudo bem com você?\"";
        let res_double = AiEngine::sanitize_ai_response(input_double, "Maria");
        assert_eq!(res_double, "Olá Maria, tudo bem com você?");

        let input_curly = "“Olá Maria, tudo bem com você?”";
        let res_curly = AiEngine::sanitize_ai_response(input_curly, "Maria");
        assert_eq!(res_curly, "Olá Maria, tudo bem com você?");

        let input_guillemets = "«Olá Maria, tudo bem com você?»";
        let res_guillemets = AiEngine::sanitize_ai_response(input_guillemets, "Maria");
        assert_eq!(res_guillemets, "Olá Maria, tudo bem com você?");
    }

    #[test]
    fn test_sanitize_code_blocks() {
        let input = "Aqui está a mensagem:\n```markdown\nOlá {nome}, acesse o link: https://esfera.local/fatura\n```";
        let res = AiEngine::sanitize_ai_response(input, "João");
        assert_eq!(res, "Olá João, acesse o link: https://esfera.local/fatura");
    }

    #[test]
    fn test_sanitize_json_output() {
        let input = "{\"message\": \"Olá Roberto, seu plano foi ativado com sucesso!\"}";
        let res = AiEngine::sanitize_ai_response(input, "Roberto");
        assert_eq!(res, "Olá Roberto, seu plano foi ativado com sucesso!");

        let input_out = "{\"output\": \"Olá Roberto, tudo certo!\"}";
        let res_out = AiEngine::sanitize_ai_response(input_out, "Roberto");
        assert_eq!(res_out, "Olá Roberto, tudo certo!");
    }

    #[test]
    fn test_sanitize_blockquotes() {
        let input = "> Olá {nome}!\n> Seu plano está disponível.\n> Acesse https://esfera.local";
        let res = AiEngine::sanitize_ai_response(input, "Fabio");
        assert_eq!(res, "Olá Fabio!\nSeu plano está disponível.\nAcesse https://esfera.local");
    }

    #[test]
    fn test_sanitize_markdown_headers() {
        let input = "### Mensagem Sugerida:\nOlá {nome}! Segue seu código.";
        let res = AiEngine::sanitize_ai_response(input, "Paula");
        assert_eq!(res, "Olá Paula! Segue seu código.");
    }

    #[test]
    fn test_sanitize_markdown_bold_to_whatsapp() {
        let input = "Olá {nome}, seu desconto de **50%** no valor de **R$ 150,00** é válido até amanhã!";
        let res = AiEngine::sanitize_ai_response(input, "Marcos");
        assert_eq!(res, "Olá Marcos, seu desconto de *50%* no valor de *R$ 150,00* é válido até amanhã!");
    }

    #[test]
    fn test_sanitize_bullet_points() {
        let input = "Olá {nome}! Opções:\n* Pagamento via PIX\n* Pagamento no boleto";
        let res = AiEngine::sanitize_ai_response(input, "Camila");
        assert_eq!(res, "Olá Camila! Opções:\n• Pagamento via PIX\n• Pagamento no boleto");
    }

    #[test]
    fn test_sanitize_duplicate_markdown_link() {
        let input = "Acesse [https://esfera.com/fatura](https://esfera.com/fatura) ou [segunda via](https://esfera.com/2via)";
        let res = AiEngine::sanitize_ai_response(input, "Juliana");
        assert_eq!(res, "Acesse https://esfera.com/fatura ou segunda via: https://esfera.com/2via");
    }

    #[test]
    fn test_sanitize_trailing_disclaimers() {
        let input = "Olá Ana, seu saldo é R$ 450,00.\n\n(Espero ter ajudado!)\nObservação: Mantive os valores intactos.";
        let res = AiEngine::sanitize_ai_response(input, "Ana");
        assert_eq!(res, "Olá Ana, seu saldo é R$ 450,00.");

        let input_italic = "Olá Ana! Seu pedido foi enviado.\n\n*Observação: Não hesite em nos contatar.*";
        let res_italic = AiEngine::sanitize_ai_response(input_italic, "Ana");
        assert_eq!(res_italic, "Olá Ana! Seu pedido foi enviado.");
    }

    #[test]
    fn test_sanitize_strip_hallucinated_signature() {
        let input = "Olá Paulo, sua fatura vence hoje.\nAtenciosamente,\n[Seu Nome / Equipe]";
        let res = AiEngine::sanitize_ai_response(input, "Paulo");
        assert_eq!(res, "Olá Paulo, sua fatura vence hoje.\nAtenciosamente,");
    }

    #[test]
    fn test_sanitize_empty_contact_name() {
        let input = "Olá {nome}, seu plano vence amanhã!";
        let res = AiEngine::sanitize_ai_response(input, "");
        assert_eq!(res, "Olá, seu plano vence amanhã!");
    }

    #[test]
    fn test_sanitize_preserves_urls_pix_values() {
        let input = "Olá {nome}! O valor de R$ 99,90 deve ser pago até 20/10 no PIX suporte@esfera.com.br ou no link https://pagar.esfera.com.br/123";
        let res = AiEngine::sanitize_ai_response(input, "Lucas");
        assert_eq!(
            res,
            "Olá Lucas! O valor de R$ 99,90 deve ser pago até 20/10 no PIX suporte@esfera.com.br ou no link https://pagar.esfera.com.br/123"
        );
    }

    #[test]
    fn test_sanitize_markdown_links() {
        let input = "Olá {nome}, [clique aqui para ver sua fatura](https://esfera.com/fatura/123).";
        let res = AiEngine::sanitize_ai_response(input, "Beatriz");
        assert_eq!(res, "Olá Beatriz, clique aqui para ver sua fatura: https://esfera.com/fatura/123.");
    }

    #[test]
    fn test_openrouter_discontinued_model_normalization() {
        assert_eq!(
            AiEngine::normalize_openrouter_model("qwen/qwen-2.5-72b-instruct:free"),
            "openrouter/free"
        );
        assert_eq!(
            AiEngine::normalize_openrouter_model("qwen/qwen-2.5-72b-instruct"),
            "openrouter/free"
        );
        assert_eq!(
            AiEngine::normalize_openrouter_model("meta-llama/llama-3.3-70b-instruct:free"),
            "openrouter/free"
        );
        assert_eq!(
            AiEngine::normalize_openrouter_model(""),
            "openrouter/free"
        );
        assert_eq!(
            AiEngine::normalize_openrouter_model("   "),
            "openrouter/free"
        );
        assert_eq!(
            AiEngine::normalize_openrouter_model("minimax/minimax-m3.1-flash:free"),
            "minimax/minimax-m3.1-flash:free"
        );
    }
}

