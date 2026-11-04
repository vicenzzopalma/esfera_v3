// Leitura do CRM de celulares do VERITAS ("Gestão de celulares").
//
// Só GET em duas rotas públicas que já existem lá — nada é escrito e nada do
// VERITAS foi alterado:
//   GET /api/public/chips             -> chip, número, status do CRM, aparelho, setor
//   GET /api/integrations/veritas/status -> status da sessão de WhatsApp por chip
// As duas respostas são unidas pelo id do chip. O Esfera apenas exibe: nenhum
// número daqui entra no ESF_Chip nem no disparo.
use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Janela em que a leitura é reaproveitada. A lista de aparelhos recarrega a
/// cada 7 s; sem isto o CRM levaria uma rajada de consultas por minuto.
pub const CACHE_TTL: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmChip {
    pub id: i64,
    pub phone: String,
    pub name: String,
    /// Status do CRM: Livre, Em Uso, Banido, Restrito 24 horas...
    pub status: String,
    pub holder: String,
    /// Nome do aparelho no CRM — é o número do aparelho ("9", "10").
    pub device_name: String,
    pub sector: String,
    pub restricted_until: String,
    pub alarm_active: bool,
    /// Sessão do WhatsApp no VERITAS: CONNECTED, DISCONNECTED, OPENING, NOT_REGISTERED.
    pub whatsapp_status: String,
    pub whatsapp_name: String,
    /// Quando o VERITAS reportou esse status ao CRM. Vai para a tela porque o
    /// dado é tão fresco quanto a última sincronia — pode estar velho.
    pub whatsapp_last_seen: String,
}

static CACHE: LazyLock<Mutex<Option<(Instant, Vec<CrmChip>)>>> = LazyLock::new(|| Mutex::new(None));

fn texto(v: &serde_json::Value, chave: &str) -> String {
    match v.get(chave) {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn verdade(v: &serde_json::Value, chave: &str) -> bool {
    match v.get(chave) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(serde_json::Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn lista<'a>(raiz: &'a serde_json::Value, chave: &str) -> &'a [serde_json::Value] {
    if let Some(arr) = raiz.as_array() {
        return arr;
    }
    raiz.get(chave).and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[])
}

/// Minúsculas e sem acento, para comparar setor ("Júnior" = "Junior" = "junior").
pub fn normalizar(texto: &str) -> String {
    texto
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'ë' | 'è' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            outro => outro,
        })
        .collect()
}

/// O chip pertence ao aparelho quando o número do aparelho e o setor batem.
/// É a única chave em comum: o CRM guarda o aparelho como número ("9") + setor.
pub fn chip_do_aparelho(chip: &CrmChip, device_number: i32, sector: &str) -> bool {
    if device_number <= 0 {
        return false;
    }
    let numero_crm = chip.device_name.trim().parse::<i32>().ok();
    if numero_crm != Some(device_number) {
        return false;
    }
    let a = normalizar(&chip.sector);
    let b = normalizar(sector);
    !a.is_empty() && a == b
}

/// Une as duas respostas do CRM pelo id do chip. Tolerante a campo nulo,
/// ausente ou numérico: o CRM evoluiu de versão algumas vezes.
pub fn parse_chips(corpo_chips: &str, corpo_status: &str) -> Result<Vec<CrmChip>, String> {
    let raiz: serde_json::Value =
        serde_json::from_str(corpo_chips).map_err(|_| "O CRM respondeu algo que não é JSON.".to_string())?;
    let sessoes: std::collections::HashMap<i64, (String, String, String)> =
        match serde_json::from_str::<serde_json::Value>(corpo_status) {
            Ok(v) => lista(&v, "items")
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(|x| x.as_i64())?;
                    Some((
                        id,
                        (
                            texto(item, "veritasStatus"),
                            texto(item, "veritasName"),
                            texto(item, "veritasLastSeen"),
                        ),
                    ))
                })
                .collect(),
            // Sem o status do WhatsApp ainda vale mostrar número e status do CRM.
            Err(_) => std::collections::HashMap::new(),
        };

    let mut saida = Vec::new();
    for item in lista(&raiz, "chips") {
        let id = item.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
        let (whatsapp_status, whatsapp_name, whatsapp_last_seen) =
            sessoes.get(&id).cloned().unwrap_or_default();
        saida.push(CrmChip {
            id,
            phone: texto(item, "phone_number"),
            name: texto(item, "name"),
            status: texto(item, "status"),
            holder: texto(item, "holder"),
            device_name: texto(item, "device_name"),
            sector: texto(item, "sector"),
            restricted_until: texto(item, "restricted_until"),
            alarm_active: verdade(item, "alarm_active"),
            whatsapp_status,
            whatsapp_name,
            whatsapp_last_seen,
        });
    }
    Ok(saida)
}

fn url_base(configurado: &str) -> String {
    let limpo = configurado.trim().trim_end_matches('/');
    if limpo.is_empty() {
        return "http://187.77.243.224:3000".to_string();
    }
    if limpo.starts_with("http://") || limpo.starts_with("https://") {
        limpo.to_string()
    } else {
        format!("http://{}", limpo)
    }
}

/// Lê os chips do CRM. `forcar` ignora o cache (botão de atualizar da tela).
pub async fn fetch_chips(base: &str, forcar: bool) -> Result<Vec<CrmChip>, String> {
    if !forcar {
        let cache = CACHE.lock().map_err(|_| "Cache do CRM indisponível.".to_string())?;
        if let Some((quando, chips)) = cache.as_ref() {
            if quando.elapsed() < CACHE_TTL {
                return Ok(chips.clone());
            }
        }
    }

    let base = url_base(base);
    let cliente = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|_| "Não foi possível preparar a consulta ao CRM.".to_string())?;

    let resp = cliente
        .get(format!("{}/api/public/chips", base))
        .send()
        .await
        .map_err(|_| format!("CRM de celulares não respondeu em {}. Ele está rodando?", base))?;
    if !resp.status().is_success() {
        return Err(format!("O CRM respondeu {} ao listar os chips.", resp.status().as_u16()));
    }
    let corpo_chips = resp.text().await.map_err(|_| "Resposta do CRM ilegível.".to_string())?;

    // O status do WhatsApp é um extra: se falhar, segue com número e status do CRM.
    let corpo_status = match cliente.get(format!("{}/api/integrations/veritas/status", base)).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => String::new(),
    };

    let chips = parse_chips(&corpo_chips, &corpo_status)?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), chips.clone()));
    }
    Ok(chips)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHIPS: &str = r#"{"success":true,"count":2,"chips":[
        {"id":31,"name":"Izaac Amorim","phone_number":"47996769980","status":"Livre","holder":"",
         "device_id":15,"device_name":"9","sector":"Junior","restricted_until":null,
         "restricted_at":null,"alarm_active":0},
        {"id":32,"name":"RESERVA","phone_number":"47997763482","status":"Em Uso","holder":"Paola",
         "device_id":16,"device_name":"10","sector":"Senior","restricted_until":"2026-11-05",
         "restricted_at":null,"alarm_active":1}]}"#;

    const STATUS: &str = r#"{"success":true,"total":2,"online":1,"offline":1,"items":[
        {"id":31,"phone":"47996769980","name":"Izaac Amorim","veritasName":"IZAAC 9980",
         "veritasStatus":"CONNECTED","veritasLastSeen":"2026-09-28T12:08:58.609Z"}]}"#;

    #[test]
    fn une_o_status_do_whatsapp_ao_chip_pelo_id() {
        let chips = parse_chips(CHIPS, STATUS).expect("deveria ler");
        assert_eq!(chips.len(), 2);
        assert_eq!(chips[0].phone, "47996769980");
        assert_eq!(chips[0].whatsapp_status, "CONNECTED");
        assert_eq!(chips[0].whatsapp_name, "IZAAC 9980");
        assert!(!chips[0].alarm_active);
        // Chip sem sessão no VERITAS continua na lista, só sem status.
        assert_eq!(chips[1].whatsapp_status, "");
        assert_eq!(chips[1].status, "Em Uso");
        assert!(chips[1].alarm_active);
    }

    #[test]
    fn status_do_whatsapp_fora_do_ar_nao_derruba_a_leitura() {
        let chips = parse_chips(CHIPS, "").expect("deveria ler mesmo sem o status");
        assert_eq!(chips.len(), 2);
        assert!(chips.iter().all(|c| c.whatsapp_status.is_empty()));
    }

    #[test]
    fn resposta_que_nao_e_json_vira_erro_em_vez_de_lista_vazia() {
        assert!(parse_chips("<html>502</html>", "").is_err());
    }

    #[test]
    fn campo_nulo_ou_ausente_vira_texto_vazio() {
        let chips = parse_chips(CHIPS, STATUS).unwrap();
        assert_eq!(chips[0].restricted_until, "");
        assert_eq!(chips[0].holder, "");
    }

    #[test]
    fn setor_casa_ignorando_acento_e_caixa() {
        let chips = parse_chips(CHIPS, STATUS).unwrap();
        assert!(chip_do_aparelho(&chips[0], 9, "Júnior"));
        assert!(chip_do_aparelho(&chips[0], 9, "junior"));
        assert!(chip_do_aparelho(&chips[1], 10, "senior"));
    }

    #[test]
    fn aparelho_com_dois_chips_devolve_os_dois() {
        // No CRM real um aparelho costuma ter dois chips (dual SIM): os dois
        // precisam aparecer, não só o primeiro encontrado.
        let dois = r#"{"chips":[
            {"id":20,"name":"RESERVA","phone_number":"47991776696","status":"Em Uso","holder":"Laiz",
             "device_id":15,"device_name":"9","sector":"Junior","restricted_until":null,"alarm_active":0},
            {"id":128,"name":"RESERVA","phone_number":"47996092255","status":"Livre","holder":"",
             "device_id":15,"device_name":"9","sector":"Junior","restricted_until":null,"alarm_active":0}]}"#;
        let chips = parse_chips(dois, "").unwrap();
        let do_nove: Vec<_> = chips.iter().filter(|c| chip_do_aparelho(c, 9, "junior")).collect();
        assert_eq!(do_nove.len(), 2);
        assert_eq!(do_nove[0].holder, "Laiz");
        assert_eq!(do_nove[1].status, "Livre");
    }

    #[test]
    fn chip_de_outro_aparelho_ou_setor_nao_casa() {
        let chips = parse_chips(CHIPS, STATUS).unwrap();
        // Mesmo número de aparelho em setor diferente é outro aparelho no CRM.
        assert!(!chip_do_aparelho(&chips[0], 9, "Senior"));
        assert!(!chip_do_aparelho(&chips[0], 10, "Junior"));
        // Aparelho sem número cadastrado no Esfera nunca casa.
        assert!(!chip_do_aparelho(&chips[0], 0, "Junior"));
    }

    // Sobe um CRM de mentira nas mesmas duas rotas para provar o caminho
    // completo: URL montada, duas chamadas, união e cache. Porta 0 = o sistema
    // escolhe uma livre, então o teste não briga com nada que esteja rodando.
    async fn crm_de_mentira(status_ok: bool) -> String {
        use axum::{routing::get, Router};
        let app = Router::new()
            .route("/api/public/chips", get(|| async { CHIPS }))
            .route(
                "/api/integrations/veritas/status",
                get(move || async move {
                    if status_ok {
                        axum::http::Response::new(STATUS.to_string())
                    } else {
                        let mut r = axum::http::Response::new(String::new());
                        *r.status_mut() = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
                        r
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn le_do_crm_de_ponta_a_ponta() {
        let base = crm_de_mentira(true).await;
        let chips = fetch_chips(&base, true).await.expect("deveria ler do CRM");
        assert_eq!(chips.len(), 2);
        assert_eq!(chips[0].whatsapp_status, "CONNECTED");
        assert!(chip_do_aparelho(&chips[0], 9, "Júnior"));
    }

    #[tokio::test]
    async fn status_do_whatsapp_com_erro_nao_impede_a_lista() {
        let base = crm_de_mentira(false).await;
        let chips = fetch_chips(&base, true).await.expect("a lista de chips deveria vir mesmo assim");
        assert_eq!(chips.len(), 2);
        assert!(chips.iter().all(|c| c.whatsapp_status.is_empty()));
    }

    #[tokio::test]
    async fn crm_fora_do_ar_vira_erro_explicando_o_que_fazer() {
        // Porta reservada para descarte: ninguém escuta nela.
        let erro = fetch_chips("http://127.0.0.1:9", true).await.unwrap_err();
        assert!(erro.contains("não respondeu"), "mensagem inesperada: {erro}");
    }

    #[test]
    fn url_base_aceita_host_sem_esquema_e_barra_sobrando() {
        assert_eq!(url_base(""), "http://187.77.243.224:3000");
        assert_eq!(url_base("  "), "http://187.77.243.224:3000");
        assert_eq!(url_base("localhost:3000/"), "http://localhost:3000");
        assert_eq!(url_base("https://crm.exemplo.com/"), "https://crm.exemplo.com");
    }
}
