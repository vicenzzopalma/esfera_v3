// ============================================================
// Esfera v3 — Motor de Inteligência Artificial (ai_engine.rs)
// Suporte nativo a Ollama, OpenAI, Anthropic e Custom Endpoint
// ============================================================

use crate::db::AiConfig;
use reqwest::Client;
use serde_json::json;
use std::time::Duration;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GeminiWebStatus {
    pub connected: bool,
    pub browser_open: bool,
    pub detail: String,
}

pub struct AiEngine;

impl AiEngine {
    /// Reescreve ou gera mensagens personalizadas utilizando o provedor configurado
    pub async fn generate_message(
        config: &AiConfig,
        base_message: &str,
        contact_name: &str,
    ) -> Result<String, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|e| format!("Falha ao criar cliente HTTP IA: {}", e))?;

        // Regras fixas: valem para toda campanha e não podem ser desligadas pelo prompt da empresa.
        // Base: CDC arts. 42, 42-A, 71 e 54-C IV (Lei 14.181/2021); LGPD arts. 6º e 7º, X.
        let default_system = "Você reescreve mensagens de WhatsApp de uma empresa brasileira, inclusive mensagens de cobrança. \
            Seu trabalho é só mudar a redação, mantendo o mesmo conteúdo.\n\
            FORMATO:\n\
            1. Retorne APENAS o texto final pronto para envio, sem introduções ('Aqui está', 'Segue'), explicações ou aspas.\n\
            2. Mantenha exatamente iguais: links, telefones, datas, prazos, protocolos, nome da empresa, CNPJ do credor e instruções de descadastro (ex.: 'responda SAIR').\n\
            PROIBIDO FALAR DE VALORES: nunca escreva quantias em dinheiro (R$, reais, centavos, números como 350,00), saldo, parcelas, juros, multas ou descontos. Se o texto original tiver valores, retire-os e convide o cliente a consultar as condições pelo canal de negociação.\n\
            3. Preserve o nome do contato ou a variável {nome}. Tom natural, educado e direto; no máximo 1 emoji.\n\
            UMA MENSAGEM: o texto recebido é UMA mensagem do WhatsApp (só a saudação, só o corpo ou só a finalização). Reescreva só ela, num único parágrafo curto, sem acrescentar saudação ou despedida que não estejam nela.\n\
            ANTI-BLOQUEIO: cada envio precisa ser diferente. Reescreva de verdade: troque a saudação, use sinônimos, mude a ordem e a estrutura das frases e o tamanho do texto. Nunca devolva o texto original quase igual. O significado e os itens da regra 2 não mudam.\n\
            REGRAS LEGAIS DE COBRANÇA (CDC arts. 42 e 71) — OBRIGATÓRIAS:\n\
            4. Nunca use ameaça, coação, intimidação, humilhação, deboche, culpa ou linguagem agressiva.\n\
            5. Nunca invente nem exagere consequências (negativação, protesto, processo, corte, visita, perda de bens). Só mencione uma consequência se ela já estiver no texto original, com as mesmas palavras e sem aumentar a gravidade.\n\
            6. Nunca crie urgência falsa ('última chance', 'só hoje', 'urgente') nem prazos ou condições que não estejam no original.\n\
            7. Nunca diga ou insinue que outras pessoas (família, trabalho, vizinhos, empregador) saberão da dívida.\n\
            8. Não pressione nem explore pessoas vulneráveis (idosos, doentes, desempregados) (CDC art. 54-C, IV).\n\
            9. Se o original identificar o credor (nome, CNPJ, endereço), mantenha essa identificação (CDC art. 42-A).\n\
            REGRAS DE DADOS PESSOAIS (LGPD arts. 6º e 7º, X):\n\
            10. Use só os dados que já estão no texto. Nunca acrescente CPF, endereço, dados bancários, detalhes da dívida ou qualquer informação pessoal.\n\
            11. Escreva sempre para o próprio titular. Nunca peça para repassar a mensagem a terceiros nem fale da dívida como se fosse para outra pessoa.\n\
            12. Se o texto original oferecer um canal para negociar, contestar ou parar de receber mensagens, mantenha esse canal.";

        let prompt = if !config.system_prompt.is_empty() {
            format!(
                "{}\n\nInstruções adicionais da empresa (as regras legais acima sempre prevalecem):\n{}\n\nReescreva a mensagem para o contato '{}':\n{}",
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
            "gemini_web" => Self::call_gemini_web(&prompt).await?,
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
        Self::validate_rewrite(base_message, &sanitized)?;
        Ok(sanitized)
    }

    /// Reescreve cada parte (blocos separados por linha em branco) e devolve as partes reescritas.
    /// Usa o marcador {nome} no lugar do nome: a IA não recebe o nome do devedor e a mesma versão
    /// serve para qualquer contato (o nome entra só na hora do envio).
    pub async fn rewrite_parts(chain: &[AiConfig], base_message: &str) -> Result<Vec<String>, String> {
        let parts: Vec<&str> = base_message
            .split("\n\n")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return Err("texto base vazio".to_string());
        }
        let results = futures_util::future::join_all(
            parts.iter().map(|part| Self::generate_message_chain(chain, part, "{nome}")),
        )
        .await;
        let mut out = Vec::with_capacity(results.len());
        for (original, r) in parts.iter().zip(results) {
            let text = r?.split_whitespace().collect::<Vec<_>>().join(" ");
            if original.contains("{nome}") && !text.contains("{nome}") {
                return Err("a IA tirou o nome do contato da mensagem".to_string());
            }
            out.push(text);
        }
        Ok(out)
    }

    /// Tenta cada provedor em ordem (cada um com no máximo 20s) até um devolver texto válido.
    pub async fn generate_message_chain(
        chain: &[AiConfig],
        base_message: &str,
        contact_name: &str,
    ) -> Result<String, String> {
        let mut errors = Vec::new();
        for cfg in chain {
            let max_secs = if cfg.provider.eq_ignore_ascii_case("gemini_web") { 180 } else { 20 };
            let attempt = tokio::time::timeout(
                Duration::from_secs(max_secs),
                Self::generate_message(cfg, base_message, contact_name),
            )
            .await
            .unwrap_or_else(|_| Err(format!("tempo limite de {}s", max_secs)));
            match attempt {
                Ok(text) => return Ok(text),
                Err(e) => {
                    eprintln!("[IA CADEIA] {} / {} falhou: {}", cfg.provider, cfg.model, e);
                    errors.push(format!("{}: {}", cfg.provider, e));
                }
            }
        }
        Err(if errors.is_empty() { "Nenhum provedor de IA configurado".to_string() } else { errors.join(" | ") })
    }

    /// Recusa respostas que não podem ir ao cliente: recusa/explicação da IA, texto vazio ou
    /// perda de dados obrigatórios do original (links, valores, datas, documentos, opção SAIR).
    pub fn validate_rewrite(original: &str, output: &str) -> Result<(), String> {
        let out = output.trim();
        if out.is_empty() {
            return Err("IA devolveu texto vazio".to_string());
        }
        let lower = out.to_lowercase();
        const META: [&str; 16] = [
            "i'm sorry", "i’m sorry", "i can't", "i can’t", "i cannot", "as an ai",
            "não posso", "não é possível", "nao e possivel", "não consigo", "desculpe, mas",
            "conforme solicitado", "versão reescrita", "aqui está", "segue a mensagem", "reescrevi",
        ];
        let orig_lower = original.to_lowercase();
        if let Some(m) = META.iter().find(|m| lower.contains(*m) && !orig_lower.contains(*m)) {
            return Err(format!("IA respondeu com recusa/explicação ('{}')", m));
        }
        if out.chars().count() > original.chars().count() * 3 + 200 {
            return Err("IA devolveu texto longo demais".to_string());
        }
        let raw_orig: Vec<&str> = original.split_whitespace().collect();
        let out_tokens: Vec<String> = out
            .split_whitespace()
            .map(Self::trim_token_punct)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        for (idx, raw) in raw_orig.iter().enumerate() {
            let w = Self::trim_token_punct(raw);
            if w.is_empty() {
                continue;
            }
            let is_protected = Self::is_date_token(w)
                || Self::is_cpf_or_cnpj_token(w)
                || Self::is_url_token(w)
                || Self::is_pix_key_token(w)
                || (Self::is_number_token(w) && !Self::is_money_token_in_context(&raw_orig, idx, w));

            if is_protected && !Self::contains_exact_token(out, &out_tokens, w) {
                return Err(format!("IA alterou ou removeu '{}'", w));
            }
        }
        if original.contains("SAIR") && !out.contains("SAIR") {
            return Err("IA removeu a opção de descadastro (SAIR)".to_string());
        }
        if Self::has_money(out) {
            return Err("IA citou valores (proibido falar de valores)".to_string());
        }
        Ok(())
    }

    fn trim_token_punct(raw: &str) -> &str {
        raw.trim_matches(|c: char| {
            matches!(
                c,
                '.' | ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
                    | '"' | '\'' | '“' | '”' | '‘' | '’'
            )
        })
    }

    /// Detecta datas como dd/mm/aaaa, dd/mm/aa, dd/mm, dd.mm.aaaa, dd.mm.aa, dd-mm-aaaa e aaaa-mm-dd.
    fn is_date_token(w: &str) -> bool {
        for sep in ['/', '.', '-'] {
            if !w.contains(sep) {
                continue;
            }
            let parts: Vec<&str> = w.split(sep).collect();
            if !parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
                continue;
            }
            if sep == '/' && parts.len() == 2 {
                let d: u32 = parts[0].parse().unwrap_or(0);
                let m: u32 = parts[1].parse().unwrap_or(0);
                if (1..=2).contains(&parts[0].len())
                    && (1..=2).contains(&parts[1].len())
                    && (1..=31).contains(&d)
                    && (1..=12).contains(&m)
                {
                    return true;
                }
            } else if parts.len() == 3 {
                if (1..=2).contains(&parts[0].len())
                    && (1..=2).contains(&parts[1].len())
                    && (parts[2].len() == 2 || parts[2].len() == 4)
                {
                    let d: u32 = parts[0].parse().unwrap_or(0);
                    let m: u32 = parts[1].parse().unwrap_or(0);
                    let y: u32 = parts[2].parse().unwrap_or(0);
                    let y_ok = if parts[2].len() == 4 { (1900..=2100).contains(&y) } else { y <= 99 };
                    if (1..=31).contains(&d) && (1..=12).contains(&m) && y_ok {
                        return true;
                    }
                }
                if parts[0].len() == 4
                    && (1..=2).contains(&parts[1].len())
                    && (1..=2).contains(&parts[2].len())
                {
                    let y: u32 = parts[0].parse().unwrap_or(0);
                    let m: u32 = parts[1].parse().unwrap_or(0);
                    let d: u32 = parts[2].parse().unwrap_or(0);
                    if (1900..=2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Detecta CPF (formatado, mascarado ou 11 dígitos) e CNPJ (formatado ou 14 dígitos).
    fn is_cpf_or_cnpj_token(w: &str) -> bool {
        let b = w.as_bytes();
        if b.len() == 14 && b[3] == b'.' && b[7] == b'.' && b[11] == b'-' {
            let valid_chars = b.iter().enumerate().all(|(i, &c)| {
                matches!(i, 3 | 7 | 11) || c.is_ascii_digit() || c == b'*'
            });
            if valid_chars && b.iter().any(|c| c.is_ascii_digit()) {
                return true;
            }
        }
        if b.len() == 18 && b[2] == b'.' && b[6] == b'.' && b[10] == b'/' && b[15] == b'-' {
            let valid_chars = b.iter().enumerate().all(|(i, &c)| {
                matches!(i, 2 | 6 | 10 | 15) || c.is_ascii_digit() || c == b'*'
            });
            if valid_chars && b.iter().any(|c| c.is_ascii_digit()) {
                return true;
            }
        }
        if (b.len() == 11 || b.len() == 14) && b.iter().all(|c| c.is_ascii_digit()) {
            return true;
        }
        false
    }

    /// Detecta URLs com protocolo (http/https), www. ou domínios com caminho/TLD.
    fn is_url_token(w: &str) -> bool {
        let lower = w.to_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
            return true;
        }
        if lower.contains('@') {
            return false;
        }
        if let Some(slash_idx) = lower.find('/') {
            let host = &lower[..slash_idx];
            if host.contains('.')
                && host.chars().any(|c| c.is_ascii_alphabetic())
                && host.split('.').all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            {
                return true;
            }
        }
        const TLDS: [&str; 12] = [
            ".com.br", ".net.br", ".org.br", ".gov.br", ".emp.br",
            ".com", ".net", ".org", ".io", ".app", ".me", ".ly",
        ];
        if TLDS.iter().any(|tld| lower.ends_with(tld))
            && lower.split('.').all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        {
            return true;
        }
        false
    }

    /// Detecta chaves PIX: e-mail, UUID/EVP aleatória, telefone E.164 (+55...), Copia e Cola e CPF/CNPJ.
    fn is_pix_key_token(w: &str) -> bool {
        if Self::is_cpf_or_cnpj_token(w) {
            return true;
        }
        if let Some((local, domain)) = w.split_once('@') {
            if !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !w.contains(char::is_whitespace)
            {
                return true;
            }
        }
        let b = w.as_bytes();
        if b.len() == 36 && b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-' {
            if b.iter().enumerate().all(|(i, &c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit()) {
                return true;
            }
        }
        if w.starts_with('+') {
            let digits = w[1..].chars().filter(|c| c.is_ascii_digit()).count();
            if digits >= 8 && w[1..].chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '.' | '(' | ')')) {
                return true;
            }
        }
        let lower = w.to_lowercase();
        if (w.starts_with("000201") && w.len() >= 20) || lower.contains("br.gov.bcb.pix") {
            return true;
        }
        false
    }

    /// Detecta números do texto original (telefones, DDD, protocolos, contratos, prazos).
    fn is_number_token(w: &str) -> bool {
        let digits = w.chars().filter(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return false;
        }
        if w.chars().all(|c| c.is_ascii_digit() || "./-:,+*#ºª".contains(c)) {
            return true;
        }
        let lower = w.to_lowercase();
        for suffix in ["hs", "h"] {
            if let Some(num) = lower.strip_suffix(suffix) {
                if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                    return true;
                }
            }
        }
        false
    }

    /// Verifica se um token numérico no texto original faz parte de uma expressão de valor monetário
    /// (que a IA tem obrigação de remover, e portanto não deve ser exigido na reescrita).
    fn is_money_token_in_context(raw_tokens: &[&str], idx: usize, w: &str) -> bool {
        if Self::is_date_token(w)
            || Self::is_cpf_or_cnpj_token(w)
            || Self::is_url_token(w)
            || Self::is_pix_key_token(w)
        {
            return false;
        }
        let raw = raw_tokens[idx];
        let raw_lower = raw.to_lowercase();
        if raw_lower.starts_with("r$")
            || raw_lower.starts_with("rs$")
            || raw_lower.ends_with('%')
            || Self::has_money(w)
        {
            return true;
        }
        const MONEY_KEYS: [&str; 24] = [
            "r", "r$", "rs$", "brl", "valor", "valores", "saldo", "parcela", "parcelas",
            "divida", "dívida", "debito", "débito", "total", "quantia", "montante",
            "preco", "preço", "desconto", "juros", "multa", "pague", "pagar", "pagamento",
        ];
        let clean_word = |s: &str| -> String {
            s.trim_matches(|c: char| !c.is_alphanumeric() && c != '$' && c != '%').to_lowercase()
        };
        let start = idx.saturating_sub(3);
        for prev in &raw_tokens[start..idx] {
            let pw = clean_word(prev);
            if MONEY_KEYS.contains(&pw.as_str()) {
                return true;
            }
        }
        if let Some(next) = raw_tokens.get(idx + 1) {
            let nw = clean_word(next);
            if matches!(nw.as_str(), "%" | "reais" | "centavos" | "porcento") {
                return true;
            }
            if nw == "por" {
                if let Some(next2) = raw_tokens.get(idx + 2) {
                    if clean_word(next2) == "cento" {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Confere se `target` aparece de forma idêntica em `out` sem ser apenas prefixo/sufixo de outro número/data/URL.
    fn contains_exact_token(out: &str, out_tokens: &[String], target: &str) -> bool {
        if out_tokens.iter().any(|t| t == target) {
            return true;
        }
        for (start, _) in out.match_indices(target) {
            let end = start + target.len();
            let prev_char = out[..start].chars().next_back();
            let next_char = out[end..].chars().next();

            let prev_conflict = prev_char.map_or(false, |c| {
                c.is_ascii_alphanumeric()
                    || matches!(c, '/' | '-' | '@' | '_' | '+')
                    || (c == '.' && out[..start - c.len_utf8()].chars().next_back().map_or(false, |p| p.is_ascii_alphanumeric()))
            });
            let next_conflict = next_char.map_or(false, |c| {
                c.is_ascii_alphanumeric()
                    || matches!(c, '/' | '-' | '@' | '_')
                    || (matches!(c, '.' | ',') && out[end + c.len_utf8()..].chars().next().map_or(false, |n| n.is_ascii_alphanumeric()))
            });

            if !prev_conflict && !next_conflict {
                return true;
            }
        }
        false
    }

    /// Detecta menção a valores em dinheiro: R$, "reais", "centavos" ou quantia com centavos (350,00).
    pub fn has_money(text: &str) -> bool {
        let lower = text.to_lowercase();
        if lower.contains("r$") || lower.contains("rs$") || lower.contains("brl") {
            return true;
        }
        let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric() && c != '%').filter(|w| !w.is_empty()).collect();
        if words.iter().any(|w| *w == "reais" || *w == "centavos") {
            return true;
        }
        // Percentual (desconto/juros) também é valor.
        if words.iter().any(|w| w.ends_with('%') && w.chars().any(|c| c.is_ascii_digit())) {
            return true;
        }
        // "10 %" (com espaço) e "10 por cento" também são percentual.
        let chars: Vec<char> = lower.chars().collect();
        if chars.iter().enumerate().any(|(i, &c)| {
            c == '%' && chars[..i].iter().rev().find(|ch| !ch.is_whitespace()).map_or(false, |ch| ch.is_ascii_digit())
        }) {
            return true;
        }
        if words.windows(2).any(|w| w[0] == "por" && w[1] == "cento") || words.contains(&"porcento") {
            return true;
        }
        // "R 350" e palavras de valor seguidas de número em até 3 palavras ("valor de 350", "saldo 120").
        const KEYS: [&str; 22] = [
            "r", "valor", "valores", "saldo", "parcela", "parcelas", "divida", "dívida", "debito", "débito",
            "total", "quantia", "montante", "preco", "preço", "desconto", "juros", "multa", "pague", "pagar",
            "pagamento", "custa",
        ];
        for (i, w) in words.iter().enumerate() {
            if KEYS.contains(w) && words.iter().skip(i + 1).take(3).any(|n| n.chars().next().map_or(false, |c| c.is_ascii_digit())) {
                return true;
            }
        }
        // Quantia com centavos: "350,00" ou "350.00" (não confunde com data "10.10.2026" nem "10.10.26").
        let b = text.as_bytes();
        (1..b.len().saturating_sub(2)).any(|i| {
            (b[i] == b',' || b[i] == b'.')
                && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit() && b[i + 2].is_ascii_digit()
                && (i + 3 >= b.len() || !(b[i + 3].is_ascii_digit() || b[i + 3] == b'.' || b[i + 3] == b'/'))
                && !(b[i] == b'.' && ((i >= 2 && b[i - 2] == b'.') || (i >= 3 && b[i - 3] == b'.')))
        })
    }

    /// Requisição para GroqCloud (API Free Tier ultrarrápida compatível com OpenAI)
    async fn call_groq(client: &Client, config: &AiConfig, prompt: &str) -> Result<String, String> {
        let mut groq_cfg = config.clone();
        if groq_cfg.endpoint.is_empty() || !groq_cfg.endpoint.contains("groq.com") {
            groq_cfg.endpoint = "https://api.groq.com/openai/v1/chat/completions".to_string();
        }
        // Llama/Mixtral saíram do Groq; modelos ativos em 27/10/2026: gpt-oss-120b/20b e qwen3.8-27b
        let old = groq_cfg.model.trim().to_lowercase();
        if old.is_empty() || old.starts_with("llama-3") || old.starts_with("mixtral") {
            groq_cfg.model = "openai/gpt-oss-120b".to_string();
        }
        if groq_cfg.api_key.trim().is_empty() {
            return Err("Chave de API do Groq não configurada. Obtenha grátis em https://console.groq.com/keys e configure em Parâmetros de IA.".to_string());
        }
        match Self::call_openai(client, &groq_cfg, prompt).await {
            Ok(content) => Ok(content),
            Err(first_err) => {
                let is_recoverable = first_err.contains("400") || first_err.contains("404") || first_err.contains("429") || first_err.contains("503") || first_err.contains("decommissioned");
                if is_recoverable && groq_cfg.model != "openai/gpt-oss-20b" {
                    eprintln!("[GROQ RESILIÊNCIA] Modelo '{}' falhou. Tentando fallback para 'openai/gpt-oss-20b'...", groq_cfg.model);
                    let mut fallback_cfg = groq_cfg.clone();
                    fallback_cfg.model = "openai/gpt-oss-20b".to_string();
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

                // Ordem pela latência medida em 27/10/2026 (modelos gratuitos ativos no OpenRouter)
                let fallbacks = [
                    "nvidia/nemotron-3.5-lightning:free",
                    "xingchen-agi/xing4.0-29b-a4b:free",
                    "openrouter/free",
                    "liquid/lfm-2.5-2.6b:free",
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
        // Variante gratuita aposentada pelo OpenRouter em 22/10/2026 (responde 404)
        if lower == "minimax/minimax-m3.1-flash:free" {
            return "nvidia/nemotron-3.5-lightning:free".to_string();
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

    // ============================================================
    // GEMINI WEB (Login Google via navegador Chrome/Edge + CDP 9223)
    // ============================================================

    pub const GEMINI_WEB_CDP_PORT: u16 = 9223;
    pub const GEMINI_WEB_APP_URL: &'static str = "https://gemini.google.com/app";
    pub const GEMINI_WEB_MIN_INTERVAL_MS: u64 = 4000;
    pub const GEMINI_WEB_TIMEOUT_SECS: u64 = 60;

    fn gemini_web_lock() -> &'static tokio::sync::Mutex<Option<std::time::Instant>> {
        static LOCK: std::sync::LazyLock<tokio::sync::Mutex<Option<std::time::Instant>>> =
            std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
        &LOCK
    }

    /// Pasta do perfil exclusivo do navegador para manter o login Google do Gemini Web.
    pub fn gemini_web_profile_dir() -> std::path::PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("esfera_v3")
            .join("gemini-edge-profile")
    }

    /// Detecta o ProgId do navegador padrão do Windows (HKCU\...\UrlAssociations\https\UserChoice).
    fn windows_default_https_prog_id() -> String {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            if let Ok(out) = std::process::Command::new("reg")
                .args([
                    "query",
                    r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
                    "/v",
                    "ProgId",
                ])
                .creation_flags(0x08000000)
                .output()
            {
                return String::from_utf8_lossy(&out.stdout).to_lowercase();
            }
        }
        String::new()
    }

    /// Caminhos padrão do navegador no Windows, priorizando o navegador padrão do sistema (Microsoft Edge).
    pub fn default_browser_candidates() -> Vec<std::path::PathBuf> {
        let mut candidates = Vec::new();
        let mut roots = Vec::new();
        for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(val) = std::env::var_os(var) {
                roots.push(std::path::PathBuf::from(val));
            }
        }
        roots.push(std::path::PathBuf::from(r"C:\Program Files (x86)"));
        roots.push(std::path::PathBuf::from(r"C:\Program Files"));

        let prog_id = Self::windows_default_https_prog_id();
        let prefer_chrome = prog_id.contains("chrome") && !prog_id.contains("edge");

        if prefer_chrome {
            for root in &roots {
                candidates.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
            }
            for root in &roots {
                candidates.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
            }
        } else {
            // Prioriza Microsoft Edge (msedge.exe) quando o Edge é o navegador padrão do sistema
            for root in &roots {
                candidates.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
            }
            for root in &roots {
                candidates.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
            }
        }
        candidates
    }

    /// Retorna o primeiro executável de navegador existente na lista de candidatos.
    pub fn find_chromium_browser_from_candidates(candidates: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
        candidates.iter().find(|p| p.is_file()).cloned()
    }

    /// Procura `msedge.exe` (padrão) ou `chrome.exe` instalados nos caminhos padrão do Windows.
    pub fn find_chromium_browser() -> Option<std::path::PathBuf> {
        Self::find_chromium_browser_from_candidates(&Self::default_browser_candidates())
    }

    /// Monta os argumentos de linha de comando para abrir o navegador com perfil próprio e CDP na porta 9223.
    pub fn build_gemini_browser_args(profile_dir: &std::path::Path, minimized: bool) -> Vec<String> {
        let mut args = vec![
            format!("--user-data-dir={}", profile_dir.display()),
            format!("--remote-debugging-port={}", Self::GEMINI_WEB_CDP_PORT),
            "--remote-allow-origins=*".to_string(),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
        ];
        if minimized {
            args.push("--start-minimized".to_string());
        } else {
            args.push("--new-window".to_string());
        }
        args.push(Self::GEMINI_WEB_APP_URL.to_string());
        args
    }

    /// Abre o navegador padrão (Microsoft Edge) com o perfil do Gemini Web e porta de depuração 9223.
    pub fn launch_gemini_web_browser(minimized: bool) -> Result<String, String> {
        let browser = Self::find_chromium_browser().ok_or_else(|| {
            "Microsoft Edge (msedge.exe) ou Google Chrome (chrome.exe) não encontrado nos caminhos padrão.".to_string()
        })?;
        let profile_dir = Self::gemini_web_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Falha ao criar pasta de perfil {:?}: {}", profile_dir, e))?;
        let args = Self::build_gemini_browser_args(&profile_dir, minimized);
        std::process::Command::new(&browser)
            .args(&args)
            .spawn()
            .map_err(|e| format!("Falha ao iniciar navegador {:?}: {}", browser, e))?;
        Ok(browser.to_string_lossy().to_string())
    }

    /// Aplica intervalo mínimo entre chamadas ao Gemini Web mantendo o controle de instante.
    pub async fn enforce_gemini_web_rate_limit(
        last_call: &mut Option<std::time::Instant>,
        min_interval: Duration,
    ) {
        if let Some(prev) = *last_call {
            let elapsed = prev.elapsed();
            if elapsed < min_interval {
                tokio::time::sleep(min_interval - elapsed).await;
            }
        }
        *last_call = Some(std::time::Instant::now());
    }

    /// Verifica em um HTML da página do Gemini se a sessão está logada (tem caixa de texto do chat e não exibe "Fazer login").
    pub fn detect_gemini_login_from_html(html: &str) -> bool {
        let lower = html.to_lowercase();
        let has_login_prompt = lower.contains("fazer login")
            || lower.contains("sign in")
            || lower.contains("iniciar sessão")
            || lower.contains("accounts.google.com/servicelogin")
            || lower.contains("accounts.google.com/v3/signin");
        if has_login_prompt {
            return false;
        }
        lower.contains("ql-editor")
            || lower.contains("rich-textarea")
            || (lower.contains("contenteditable=\"true\"") && lower.contains("role=\"textbox\""))
            || lower.contains("peça ao gemini")
            || lower.contains("ask gemini")
    }

    /// Extrai o texto limpo da última resposta do modelo a partir de um HTML da conversa do Gemini.
    pub fn extract_gemini_response_from_html(html: &str) -> Option<String> {
        let markers = [
            "model-response-text",
            "data-message-author-role=\"model\"",
            "<message-content",
            "<model-response",
        ];
        let mut best_slice: Option<&str> = None;
        for marker in markers {
            if let Some(pos) = html.rfind(marker) {
                if let Some(gt) = html[pos..].find('>') {
                    let after_open = &html[pos + gt + 1..];
                    let end = after_open
                        .find("</model-response>")
                        .or_else(|| after_open.find("</message-content>"))
                        .unwrap_or(after_open.len());
                    best_slice = Some(&after_open[..end]);
                    break;
                }
            }
        }
        let raw_fragment = best_slice?;
        let text = Self::strip_html_tags(raw_fragment);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn strip_html_tags(fragment: &str) -> String {
        let normalized = fragment
            .replace("<br>", "\n")
            .replace("<br/>", "\n")
            .replace("<br />", "\n")
            .replace("</p>", "\n")
            .replace("</div>", "\n")
            .replace("</li>", "\n");
        let mut out = String::with_capacity(normalized.len());
        let mut in_tag = false;
        for c in normalized.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Envia um comando JSON-RPC via WebSocket CDP e aguarda a resposta com o mesmo `id`.
    async fn cdp_send_cmd(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        ws.send(Message::Text(payload.to_string()))
            .await
            .map_err(|e| format!("Erro ao enviar comando CDP {}: {}", method, e))?;

        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| format!("Erro ao ler WebSocket CDP: {}", e))?;
            if let Message::Text(txt) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        if let Some(err) = v.get("error") {
                            return Err(format!("Erro CDP em {}: {}", method, err));
                        }
                        return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
                    }
                }
            }
        }
        Err("Conexão CDP encerrada antes da resposta".to_string())
    }

    async fn cdp_eval_js(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        id: u64,
        expression: &str,
    ) -> Result<serde_json::Value, String> {
        let res = Self::cdp_send_cmd(
            ws,
            id,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            }),
        )
        .await?;
        Ok(res.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(serde_json::Value::Null))
    }

    /// Verifica se o navegador aberto na porta 9223 é um Chrome residual quando o navegador preferido é o Microsoft Edge.
    async fn cdp_close_if_wrong_browser(client: &Client) {
        let preferred_is_edge = Self::find_chromium_browser()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            .map(|n| n.contains("msedge"))
            .unwrap_or(false);
        if !preferred_is_edge {
            return;
        }
        let ver_url = format!("http://127.0.0.1:{}/json/version", Self::GEMINI_WEB_CDP_PORT);
        if let Ok(resp) = client.get(&ver_url).send().await {
            if let Ok(ver) = resp.json::<serde_json::Value>().await {
                let browser_str = ver.get("Browser").and_then(|v| v.as_str()).unwrap_or("");
                if !browser_str.is_empty() && !browser_str.contains("Edg/") {
                    if let Some(ws_url) = ver.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(ws_url).await {
                            let _ = Self::cdp_send_cmd(&mut ws, 1, "Browser.close", json!({})).await;
                        }
                    }
                    // Aguarda a porta 9223 liberar completamente
                    for _ in 0..15 {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        if client.get(&ver_url).send().await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    }

    /// Localiza (ou abre) a aba do Gemini / login Google na porta 9223 e retorna a URL de WebSocket CDP da aba.
    async fn cdp_get_gemini_page_ws(client: &Client) -> Result<(String, String), String> {
        Self::cdp_close_if_wrong_browser(client).await;

        let list_url = format!("http://127.0.0.1:{}/json/list", Self::GEMINI_WEB_CDP_PORT);
        let resp = client
            .get(&list_url)
            .send()
            .await
            .map_err(|e| format!("Porta {} indisponível: {}", Self::GEMINI_WEB_CDP_PORT, e))?;
        let targets: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Resposta inválida da porta {}: {}", Self::GEMINI_WEB_CDP_PORT, e))?;

        // 1. Prioriza aba do Gemini ou da tela de login da Conta Google (accounts.google.com)
        if let Some(t) = targets.iter().find(|t| {
            let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
            let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
            is_page
                && (url.contains("gemini.google.com") || url.contains("accounts.google.com"))
                && t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).is_some()
        }) {
            let ws = t["webSocketDebuggerUrl"].as_str().unwrap_or_default().to_string();
            let url = t.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            return Ok((ws, url));
        }

        // 2. Qualquer outra aba de página visível (não extensão)
        if let Some(t) = targets.iter().find(|t| {
            let is_page = t.get("type").and_then(|v| v.as_str()) == Some("page");
            let url = t.get("url").and_then(|v| v.as_str()).unwrap_or("");
            is_page
                && !url.starts_with("chrome-extension://")
                && !url.starts_with("devtools://")
                && t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).is_some()
        }) {
            let ws = t["webSocketDebuggerUrl"].as_str().unwrap_or_default().to_string();
            let url = t.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            return Ok((ws, url));
        }

        let new_url = format!(
            "http://127.0.0.1:{}/json/new?{}",
            Self::GEMINI_WEB_CDP_PORT,
            Self::GEMINI_WEB_APP_URL
        );
        let created: serde_json::Value = client
            .put(&new_url)
            .send()
            .await
            .map_err(|e| format!("Falha ao abrir aba no navegador CDP: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Resposta inválida ao criar aba CDP: {}", e))?;
        let ws = created
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Aba criada sem webSocketDebuggerUrl".to_string())?
            .to_string();
        let url = created.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        Ok((ws, url))
    }

    /// Traz a janela/aba do Gemini Web no Microsoft Edge para a frente.
    pub async fn bring_gemini_web_to_front() -> Result<(), String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;
        let (ws_url, page_url) = Self::cdp_get_gemini_page_ws(&client).await?;
        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| e.to_string())?;
        let _ = Self::cdp_send_cmd(&mut ws, 1, "Page.bringToFront", json!({})).await;
        if !page_url.contains("gemini.google.com") && !page_url.contains("accounts.google.com") {
            let _ = Self::cdp_send_cmd(
                &mut ws,
                2,
                "Page.navigate",
                json!({ "url": Self::GEMINI_WEB_APP_URL }),
            )
            .await;
        }
        Ok(())
    }

    /// Conecta na porta 9223 (CDP) e verifica se o usuário está logado no Gemini Web.
    pub async fn check_gemini_web_status() -> GeminiWebStatus {
        let client = match Client::builder().timeout(Duration::from_secs(4)).build() {
            Ok(c) => c,
            Err(e) => {
                return GeminiWebStatus {
                    connected: false,
                    browser_open: false,
                    detail: e.to_string(),
                };
            }
        };
        let (ws_url, page_url) = match Self::cdp_get_gemini_page_ws(&client).await {
            Ok(v) => v,
            Err(_) => {
                return GeminiWebStatus {
                    connected: false,
                    browser_open: false,
                    detail: "Navegador não está aberto. Clique em “Entrar com Google” para abrir o Microsoft Edge e fazer login.".to_string(),
                };
            }
        };

        if page_url.contains("accounts.google.com") {
            return GeminiWebStatus {
                connected: false,
                browser_open: true,
                detail: "Microsoft Edge aberto na tela de login do Google — conclua o login para conectar.".to_string(),
            };
        }

        let (mut ws, _) = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok(v) => v,
            Err(e) => {
                return GeminiWebStatus {
                    connected: false,
                    browser_open: true,
                    detail: format!("Falha ao conectar via WebSocket na porta 9223: {}", e),
                };
            }
        };

        let mut cmd_id = 1u64;
        if !page_url.contains("gemini.google.com") && !page_url.contains("accounts.google.com") {
            let _ = Self::cdp_send_cmd(
                &mut ws,
                cmd_id,
                "Page.navigate",
                json!({ "url": Self::GEMINI_WEB_APP_URL }),
            )
            .await;
            cmd_id += 1;
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }

        let js_check = r#"(() => {
            const href = location.href || '';
            if (href.includes('accounts.google.com')) {
                return { loggedIn: false, hasSignIn: true };
            }
            const input = document.querySelector(
                'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea'
            );
            const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
            const signInBtn = links.find(el => {
                const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                const h = (el.getAttribute('href') || '').toLowerCase();
                return t === 'fazer login'
                    || t.startsWith('fazer login')
                    || t === 'sign in'
                    || t.startsWith('sign in')
                    || t === 'iniciar sessão'
                    || t === 'entrar'
                    || h.includes('accounts.google.com/servicelogin')
                    || h.includes('accounts.google.com/v3/signin');
            });
            return {
                loggedIn: Boolean(input) && !Boolean(signInBtn),
                hasInput: Boolean(input),
                hasSignIn: Boolean(signInBtn)
            };
        })()"#;

        let val = match Self::cdp_eval_js(&mut ws, cmd_id, js_check).await {
            Ok(v) => v,
            Err(e) => {
                return GeminiWebStatus {
                    connected: false,
                    browser_open: true,
                    detail: e,
                };
            }
        };
        let logged_in = val.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false);

        if logged_in {
            GeminiWebStatus {
                connected: true,
                browser_open: true,
                detail: "Conectado ao Gemini Web no Microsoft Edge (sessão ativa na porta 9223).".to_string(),
            }
        } else {
            GeminiWebStatus {
                connected: false,
                browser_open: true,
                detail: "Microsoft Edge aberto — clique em “Fazer login” na janela do Gemini para entrar na sua Conta Google.".to_string(),
            }
        }
    }

    /// Fecha o navegador do perfil conectado na porta 9223 e aguarda liberar a porta.
    pub async fn close_gemini_web_browser() -> Result<(), String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;
        let ver_url = format!("http://127.0.0.1:{}/json/version", Self::GEMINI_WEB_CDP_PORT);
        let mut closed = false;
        if let Ok(resp) = client.get(&ver_url).send().await {
            if let Ok(ver) = resp.json::<serde_json::Value>().await {
                if let Some(ws_url) = ver.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                    if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(ws_url).await {
                        let _ = Self::cdp_send_cmd(&mut ws, 1, "Browser.close", json!({})).await;
                        closed = true;
                    }
                }
            }
        }
        if !closed {
            if let Ok((ws_url, _)) = Self::cdp_get_gemini_page_ws(&client).await {
                if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&ws_url).await {
                    let _ = Self::cdp_send_cmd(&mut ws, 1, "Browser.close", json!({})).await;
                }
            }
        }
        for _ in 0..15 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if client.get(&ver_url).send().await.is_err() {
                break;
            }
        }
        Ok(())
    }

    /// Reescreve mensagem usando o Gemini Web via CDP (porta 9223):
    /// 1 pedido por vez (mutex global), intervalo mínimo entre pedidos e tempo-limite de 60 s.
    pub async fn call_gemini_web(prompt: &str) -> Result<String, String> {
        let mut guard = Self::gemini_web_lock().lock().await;
        Self::enforce_gemini_web_rate_limit(
            &mut *guard,
            Duration::from_millis(Self::GEMINI_WEB_MIN_INTERVAL_MS),
        )
        .await;

        let res = tokio::time::timeout(
            Duration::from_secs(Self::GEMINI_WEB_TIMEOUT_SECS),
            Self::call_gemini_web_inner(prompt),
        )
        .await
        .unwrap_or_else(|_| Err("Tempo limite de 60s excedido no Gemini Web".to_string()));

        *guard = Some(std::time::Instant::now());
        res
    }

    async fn call_gemini_web_inner(prompt: &str) -> Result<String, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;

        // Se o navegador do perfil não estiver aberto na porta 9223, abre minimizado e aguarda subir.
        if Self::cdp_get_gemini_page_ws(&client).await.is_err() {
            Self::launch_gemini_web_browser(true)?;
            let start = std::time::Instant::now();
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if Self::cdp_get_gemini_page_ws(&client).await.is_ok() {
                    break;
                }
                if start.elapsed() > Duration::from_secs(12) {
                    return Err("Não foi possível conectar na porta 9223 do navegador Gemini Web.".to_string());
                }
            }
        }

        let (ws_url, _) = Self::cdp_get_gemini_page_ws(&client).await?;
        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("Falha ao conectar ao WebSocket CDP: {}", e))?;

        let mut cmd_id = 1u64;
        // Janela minimizada deixa a aba "escondida" e o Gemini ignora o envio:
        // a emulação de foco faz a aba contar como visível e ativa.
        let _ = Self::cdp_send_cmd(&mut ws, cmd_id, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true })).await;
        cmd_id += 1;
        let _ = Self::cdp_send_cmd(&mut ws, cmd_id, "Page.setWebLifecycleState", json!({ "state": "active" })).await;
        cmd_id += 1;
        // Abre um chat novo. Recarregar o Gemini (Page.navigate) deixa a página travada por 20s+,
        // então, já estando no Gemini, clica em "Nova conversa" (troca sem recarregar).
        let new_chat_js = r#"(() => {
            if (location.hostname !== 'gemini.google.com') return 'nav';
            const busy = document.querySelector('message-content, model-response, user-query');
            if (location.pathname === '/app' && !busy) return 'ok';
            const a = document.querySelector(
                'a[href="/app"], [aria-label="Nova conversa"], [aria-label="New chat"], side-nav-action-button[data-test-id="new-chat-button"] a'
            );
            if (a) { a.click(); return 'clicked'; }
            return 'nav';
        })()"#;
        let new_chat = tokio::time::timeout(Duration::from_secs(5), Self::cdp_eval_js(&mut ws, cmd_id, new_chat_js))
            .await
            .ok()
            .and_then(|r| r.ok())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "nav".to_string());
        cmd_id += 1;
        if new_chat == "nav" {
            let _ = Self::cdp_send_cmd(
                &mut ws,
                cmd_id,
                "Page.navigate",
                json!({ "url": Self::GEMINI_WEB_APP_URL }),
            )
            .await?;
            cmd_id += 1;
        }

        // Aguarda a caixa de texto do chat carregar (até 15s)
        let wait_input_js = r#"(() => {
            const links = Array.from(document.querySelectorAll('a, button'));
            const signIn = links.some(el => {
                const t = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
                const h = (el.getAttribute('href') || '').toLowerCase();
                return t === 'fazer login' || t === 'sign in' || h.includes('accounts.google.com/servicelogin');
            });
            const el = document.querySelector(
                'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea'
            );
            const responses = document.querySelectorAll(
                'model-response, message-content, .model-response-text, [data-message-author-role="model"]'
            ).length;
            return { ready: Boolean(el) && !signIn && document.readyState === 'complete', signIn, responses };
        })()"#;

        let mut baseline_responses = 0usize;
        let mut ready = false;
        let nav_start = std::time::Instant::now();
        while nav_start.elapsed() < Duration::from_secs(15) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = Self::cdp_eval_js(&mut ws, cmd_id, wait_input_js).await?;
            cmd_id += 1;
            if state.get("signIn").and_then(|v| v.as_bool()).unwrap_or(false) {
                return Err("Gemini Web não está logado. Acesse Configurações → Integrações → Entrar com Google.".to_string());
            }
            if state.get("ready").and_then(|v| v.as_bool()).unwrap_or(false) {
                baseline_responses = state.get("responses").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                ready = true;
                break;
            }
        }
        if !ready {
            return Err("Caixa de texto do Gemini Web não ficou pronta (verifique se o login Google está ativo).".to_string());
        }

        // Foca e limpa a caixa de texto
        let focus_js = r#"(() => {
            const el = document.querySelector(
                'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea'
            );
            if (!el) return false;
            el.focus();
            if ('value' in el) {
                el.value = '';
            } else {
                // O Gemini exige Trusted Types: innerHTML dá erro, textContent não.
                el.textContent = '';
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()"#;
        // A navegação pode trocar a página logo depois da checagem acima: tenta de novo por até 10s.
        let mut focused = false;
        let focus_start = std::time::Instant::now();
        while focus_start.elapsed() < Duration::from_secs(10) {
            let res = Self::cdp_eval_js(&mut ws, cmd_id, focus_js).await;
            cmd_id += 1;
            if res.ok().and_then(|v| v.as_bool()).unwrap_or(false) {
                focused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        if !focused {
            return Err("Não foi possível focar o campo de mensagem do Gemini Web.".to_string());
        }

        // Digita o prompt via Input.insertText (com fallback via DOM caso necessário)
        if Self::cdp_send_cmd(&mut ws, cmd_id, "Input.insertText", json!({ "text": prompt }))
            .await
            .is_err()
        {
            cmd_id += 1;
            let set_text_js = format!(
                r#"(() => {{
                    const el = document.querySelector('div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea');
                    if (!el) return false;
                    const txt = {};
                    if ('value' in el) {{ el.value = txt; }} else {{ el.textContent = txt; }}
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    return true;
                }})()"#,
                serde_json::to_string(prompt).unwrap_or_else(|_| "\"\"".to_string())
            );
            let _ = Self::cdp_eval_js(&mut ws, cmd_id, &set_text_js).await?;
        }
        cmd_id += 1;
        tokio::time::sleep(Duration::from_millis(250)).await;

        // Envia a mensagem clicando no botão de envio ou pressionando Enter
        let send_js = r#"(() => {
            const btn = document.querySelector(
                'button.send-button, button[aria-label*="Enviar"], button[aria-label*="Send"], .send-button-container button'
            );
            if (btn && !btn.disabled) {
                btn.click();
                return 'clicked';
            }
            const el = document.querySelector(
                'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea'
            );
            if (el) {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                return 'enter';
            }
            return '';
        })()"#;
        let sent_mode = Self::cdp_eval_js(&mut ws, cmd_id, send_js).await?;
        cmd_id += 1;
        if sent_mode.as_str().unwrap_or("").is_empty() {
            return Err("Não foi possível acionar o envio no Gemini Web.".to_string());
        }

        // Aguarda a resposta terminar: botão de parar some e o texto para de mudar por 2 s
        let poll_js = r#"(() => {
            const nodes = Array.from(document.querySelectorAll(
                'message-content, .model-response-text, model-response, [data-message-author-role="model"]'
            ));
            const count = nodes.length;
            const last = count > 0 ? nodes[count - 1] : null;
            const text = last ? (last.innerText || last.textContent || '').trim() : '';
            const html = last ? (last.outerHTML || '') : '';
            const stopBtn = document.querySelector(
                'button[aria-label*="Parar"], button[aria-label*="Stop"], .stop-button, mat-icon[data-mat-icon-name="stop"]'
            );
            const generating = Boolean(stopBtn && stopBtn.offsetParent !== null);
            return { count, text, html, generating };
        })()"#;

        let mut last_text = String::new();
        let mut stable_since: Option<std::time::Instant> = None;
        let poll_start = std::time::Instant::now();

        while poll_start.elapsed() < Duration::from_secs(50) {
            tokio::time::sleep(Duration::from_millis(450)).await;
            let state = Self::cdp_eval_js(&mut ws, cmd_id, poll_js).await?;
            cmd_id += 1;

            let count = state.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let generating = state.get("generating").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut text = state
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                if let Some(html_str) = state.get("html").and_then(|v| v.as_str()) {
                    if let Some(extracted) = Self::extract_gemini_response_from_html(html_str) {
                        text = extracted;
                    }
                }
            }

            if count > baseline_responses && !text.is_empty() {
                if text != last_text {
                    last_text = text;
                    stable_since = Some(std::time::Instant::now());
                } else if !generating {
                    if let Some(since) = stable_since {
                        if since.elapsed() >= Duration::from_secs(2) {
                            return Ok(last_text);
                        }
                    } else {
                        stable_since = Some(std::time::Instant::now());
                    }
                } else {
                    // Enquanto o botão de parar está visível, reinicia a janela de estabilidade de 2s
                    stable_since = Some(std::time::Instant::now());
                }
            }
        }

        if !last_text.is_empty() {
            Ok(last_text)
        } else {
            Err("Gemini Web não retornou texto de resposta dentro do tempo esperado.".to_string())
        }
    }

    /// Apelidos do nome do contato aceitos no texto, além de {nome}: o nome da coluna da planilha
    /// ({NOME DEVEDOR}, {Razão Social}, {cliente}...). Comparação sem acento, caixa, espaço ou "_".
    const NAME_ALIASES: &'static [&'static str] = &[
        "nome", "name", "nomedevedor", "nomedodevedor", "devedor", "razaosocial", "razao", "nomefantasia",
        "cliente", "nomecliente", "nomedocliente", "contato", "nomecontato", "nomedocontato", "nomecompleto", "destinatario",
    ];

    fn name_alias_key(inner: &str) -> String {
        inner
            .to_lowercase()
            .chars()
            .map(|c| match c {
                'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
                'é' | 'è' | 'ê' | 'ë' => 'e',
                'í' | 'ì' | 'î' | 'ï' => 'i',
                'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
                'ú' | 'ù' | 'û' | 'ü' => 'u',
                'ç' => 'c',
                other => other,
            })
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    /// Troca os apelidos do nome ({NOME DEVEDOR}, {Razão Social}...) por {nome}. Blocos com "|"
    /// são spintax e ficam como estão; outros {X} também (a tela avisa da variável desconhecida).
    pub fn normalize_name_variables(template: &str) -> String {
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            match after.find(|c: char| c == '{' || c == '}') {
                Some(end) if after[end..].starts_with('}') => {
                    let inner = &after[..end];
                    if !inner.contains('|') && Self::NAME_ALIASES.contains(&Self::name_alias_key(inner).as_str()) {
                        out.push_str("{nome}");
                    } else {
                        out.push('{');
                        out.push_str(inner);
                        out.push('}');
                    }
                    rest = &after[end + 1..];
                }
                _ => {
                    out.push('{');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// Substitui variáveis de contato ({nome}, {Nome}, etc.) de forma resiliente.
    /// Se o nome for vazio, limpa pontuação residual como espaços antes de vírgula.
    pub fn replace_contact_name(template: &str, contact_name: &str) -> String {
        let normalized = Self::normalize_name_variables(template);
        let template = normalized.as_str();
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
        // Variante gratuita aposentada pelo OpenRouter em 22/10/2026 (responde 404)
        assert_eq!(
            AiEngine::normalize_openrouter_model("minimax/minimax-m3.1-flash:free"),
            "nvidia/nemotron-3.5-lightning:free"
        );
    }
}


#[cfg(test)]
mod gemini_web_live_tests {
    use super::AiEngine;
    /// Teste manual contra o Edge do Esfera logado (porta 9223):
    /// cargo test --lib gemini_web_ao_vivo -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn gemini_web_ao_vivo() {
        let out = AiEngine::call_gemini_web("Responda apenas com a palavra: pronto").await;
        println!("RESULTADO: {:?}", out);
        assert!(out.is_ok());
    }
}

#[cfg(test)]
mod has_money_tests {
    use super::AiEngine;
    #[test]
    fn detecta_valores() {
        for t in ["pague 350", "valor: 350", "R$ 350,00", "R 350", "valor de 350", "saldo 120", "350.00 em aberto", "350,00", "50% de desconto", "parcela 2 de 5", "pague 100 reais"] {
            assert!(AiEngine::has_money(t), "deveria bloquear: {}", t);
        }
    }
    #[test]
    fn nao_bloqueia_texto_normal() {
        for t in ["Oi Teste, tudo bem?", "Referente ao contrato 4471, vencido em 10/10/2026.", "Prazo até 10.10.2026", "Acesse https://realess.com.br/negociar e responda SAIR", "Atenciosamente, Equipe REALESS", "Ligue (75) 3333-4444"] {
            assert!(!AiEngine::has_money(t), "não deveria bloquear: {}", t);
        }
    }

    #[test]
    fn apelidos_do_nome_viram_nome() {
        assert_eq!(
            AiEngine::normalize_name_variables("Olá {NOME DEVEDOR}, {Razão Social} {Oi|Olá} {PROCESSO} {nome_cliente} {Olá {nome devedor}|Oi}"),
            "Olá {nome}, {nome} {Oi|Olá} {PROCESSO} {nome} {Olá {nome}|Oi}"
        );
        assert_eq!(AiEngine::replace_contact_name("Olá {NOME DEVEDOR}!", "PRIME ACABAMENTOS"), "Olá PRIME ACABAMENTOS!");
        assert_eq!(AiEngine::normalize_name_variables("sem chave { aberta"), "sem chave { aberta");
    }

    #[test]
    fn percentual_com_espaco_ou_por_extenso_e_valor() {
        assert!(AiEngine::has_money("condição especial de 10 % hoje"));
        assert!(AiEngine::has_money("abatimento de 30 por cento"));
        assert!(!AiEngine::has_money("Olá, tudo bem? Para deixar de receber mensagens, responda SAIR."));
    }

    #[test]
    fn validate_rewrite_protege_datas_cnpj_cpf_urls_pix_e_numeros() {
        // 1. Datas (dd/mm/aaaa, dd/mm/aa, dd/mm, dd.mm.aaaa, dd.mm.aa, aaaa-mm-dd)
        let orig_data = "Olá João, referente ao contrato 4471 com vencimento em 20/10/2026. Responda SAIR para descadastrar.";
        assert!(AiEngine::validate_rewrite(
            orig_data,
            "Oi João! Sobre o seu contrato 4471 que vence em 20/10/2026, fale conosco. Para não receber mais, envie SAIR."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_data,
            "Oi João! Sobre o seu contrato 4471 que vence em 21/10/2026, fale conosco. Envie SAIR."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_data,
            "Oi João! Sobre o seu contrato 4471 que vence em 20/10/26, fale conosco. Envie SAIR."
        ).is_err());

        // Data curta dd/mm e dd.mm.aa
        let orig_curta = "Prazo especial até 20/10 ou 25.10.26 para regularizar.";
        assert!(AiEngine::validate_rewrite(
            orig_curta,
            "Aproveite o prazo até 20/10 ou 25.10.26 para regularizar sua situação."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_curta,
            "Aproveite o prazo até 20/10/2026 ou 25.10.26 para regularizar sua situação."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_curta,
            "Aproveite o prazo até 20/10 ou 26.10.26 para regularizar sua situação."
        ).is_err());

        // 2. CNPJ e CPF
        let orig_docs = "Credor REALESS CNPJ 12.345.678/0001-90 referente ao titular CPF 123.456.789-00.";
        assert!(AiEngine::validate_rewrite(
            orig_docs,
            "Mensagem da REALESS (CNPJ 12.345.678/0001-90) para o titular de CPF 123.456.789-00."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_docs,
            "Mensagem da REALESS (CNPJ 12.345.678/0001-99) para o titular de CPF 123.456.789-00."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_docs,
            "Mensagem da REALESS (CNPJ 12345678000190) para o titular de CPF 123.456.789-00."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_docs,
            "Mensagem da REALESS (CNPJ 12.345.678/0001-90) para o titular de CPF 123.456.789-01."
        ).is_err());

        // 3. URLs
        let orig_url = "Negocie pelo portal https://realess.com.br/negociar?id=987 ou www.realess.com.br/acordo";
        assert!(AiEngine::validate_rewrite(
            orig_url,
            "Acesse https://realess.com.br/negociar?id=987 ou www.realess.com.br/acordo para negociar."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_url,
            "Acesse https://realess.com.br/negociar?id=98 ou www.realess.com.br/acordo para negociar."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_url,
            "Acesse https://realess.com.br/negociar?id=987 ou www.realess.com.br/outro para negociar."
        ).is_err());

        // 4. Chaves PIX (e-mail, UUID aleatória, telefone +55, Copia e Cola)
        let orig_pix_email = "Chave PIX: financeiro@realess.com.br ou aleatoria 123e4567-e89b-12d3-a456-426614174000";
        assert!(AiEngine::validate_rewrite(
            orig_pix_email,
            "Utilize a chave PIX financeiro@realess.com.br ou a chave 123e4567-e89b-12d3-a456-426614174000."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_pix_email,
            "Utilize a chave PIX contato@realess.com.br ou a chave 123e4567-e89b-12d3-a456-426614174000."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_pix_email,
            "Utilize a chave PIX financeiro@realess.com.br ou a chave 123e4567-e89b-12d3-a456-426614174001."
        ).is_err());

        let orig_pix_tel = "Chave PIX celular +5575988052539 ou código 00020126580014br.gov.bcb.pix0136123e4567";
        assert!(AiEngine::validate_rewrite(
            orig_pix_tel,
            "Chave PIX +5575988052539 ou copia e cola 00020126580014br.gov.bcb.pix0136123e4567."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_pix_tel,
            "Chave PIX +5575988052530 ou copia e cola 00020126580014br.gov.bcb.pix0136123e4567."
        ).is_err());

        // 5. Números (DDD, telefone, prazo, protocolo) e remoção permitida de valores em dinheiro
        let orig_num = "Ligue no (75) 3333-4475 em até 48 horas sobre o protocolo 852 (valor de R$ 350,00).";
        assert!(AiEngine::validate_rewrite(
            orig_num,
            "Entre em contato pelo (75) 3333-4475 dentro de 48 horas informando o protocolo 852 para consultar condições."
        ).is_ok());
        assert!(AiEngine::validate_rewrite(
            orig_num,
            "Entre em contato pelo (11) 3333-4475 dentro de 48 horas informando o protocolo 852."
        ).is_err());
        assert!(AiEngine::validate_rewrite(
            orig_num,
            "Entre em contato pelo (75) 3333-4475 dentro de 24 horas informando o protocolo 852."
        ).is_err());
    }

    #[test]
    fn gemini_web_browser_path_and_args_detection() {
        let tmp_exe = std::env::temp_dir().join(format!("esfera_fake_chrome_{}.exe", std::process::id()));
        std::fs::write(&tmp_exe, b"fake").unwrap();
        let missing = std::env::temp_dir().join("nao_existe_123456.exe");

        let found = AiEngine::find_chromium_browser_from_candidates(&[missing, tmp_exe.clone()]);
        assert_eq!(found, Some(tmp_exe.clone()));
        let _ = std::fs::remove_file(&tmp_exe);

        let profile = std::path::PathBuf::from(r"C:\Users\Operador\AppData\Local\esfera_v3\gemini-web-profile");
        let args_normal = AiEngine::build_gemini_browser_args(&profile, false);
        assert!(args_normal.iter().any(|a| a.starts_with("--user-data-dir=") && a.contains("gemini-web-profile")));
        assert!(args_normal.contains(&"--remote-debugging-port=9223".to_string()));
        assert!(args_normal.contains(&"--no-first-run".to_string()));
        assert!(args_normal.contains(&"https://gemini.google.com/app".to_string()));
        assert!(!args_normal.contains(&"--start-minimized".to_string()));

        let args_min = AiEngine::build_gemini_browser_args(&profile, true);
        assert!(args_min.contains(&"--start-minimized".to_string()));
    }

    #[test]
    fn gemini_web_html_login_and_response_extraction() {
        let html_logged_out = r#"
            <html><body>
                <header><a href="https://accounts.google.com/ServiceLogin">Fazer login</a></header>
            </body></html>
        "#;
        assert!(!AiEngine::detect_gemini_login_from_html(html_logged_out));

        let html_logged_in = r#"
            <html><body>
                <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
                <model-response>
                    <message-content class="model-response-text">
                        <p>Olá {nome}, tudo bem?</p>
                        <p>Entre em contato pelo (75) 3333-4475 até 20/10/2026 ou responda SAIR.</p>
                    </message-content>
                </model-response>
            </body></html>
        "#;
        assert!(AiEngine::detect_gemini_login_from_html(html_logged_in));
        let extracted = AiEngine::extract_gemini_response_from_html(html_logged_in).expect("deve extrair resposta");
        assert!(extracted.contains("Olá {nome}, tudo bem?"));
        assert!(extracted.contains("(75) 3333-4475"));
        assert!(extracted.contains("20/10/2026"));
        assert!(AiEngine::validate_rewrite(
            "Oi {nome}! Ligue para (75) 3333-4475 até 20/10/2026. Responda SAIR.",
            &extracted
        ).is_ok());
    }

    #[tokio::test]
    async fn gemini_web_rate_limit_interval() {
        let mut last: Option<std::time::Instant> = None;
        let min_wait = std::time::Duration::from_millis(80);
        AiEngine::enforce_gemini_web_rate_limit(&mut last, min_wait).await;
        assert!(last.is_some());
        let t0 = std::time::Instant::now();
        AiEngine::enforce_gemini_web_rate_limit(&mut last, min_wait).await;
        assert!(t0.elapsed() >= std::time::Duration::from_millis(70));
    }
}
