//! Hostiq registrar (https://hostiq.ua/api).

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use super::{normalize_ns, DomainInfo, RegistrarError, RegistrarService};

const HOSTIQ_API: &str = "https://hostiq.ua/api";

pub struct HostiqService {
    token: String,
    /// Адрес API. Поле, а не константа, — тем же приёмом и по той же нужде, что
    /// у `NamecheapService`: проверять надо не разбор в отдельной функции, а то,
    /// что живой путь ответа зовёт именно её. Асимметрия «листинг умеет конверт
    /// `data`, а карточка домена — нет» жила в этом файле ровно потому, что до
    /// сетевого пути тест не доставал.
    base_url: String,
    client: Client,
}

impl HostiqService {
    pub fn new(api_key: &str) -> Self {
        Self::with_base_url(api_key, HOSTIQ_API)
    }

    fn with_base_url(api_key: &str, base_url: &str) -> Self {
        Self {
            token: api_key.to_string(),
            base_url: base_url.to_string(),
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest"),
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            "Authorization",
            format!("Bearer {}", self.token).parse().unwrap(),
        );
        h.insert("Content-Type", "application/json".parse().unwrap());
        h.insert("Accept", "application/json".parse().unwrap());
        h
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        json_body: Option<Value>,
    ) -> Result<Value, RegistrarError> {
        let url = format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let mut req = self.client.request(method, url).headers(self.headers());
        if let Some(j) = json_body {
            req = req.json(&j);
        }
        // Ошибку транспорта отдаём как есть — вместе с адресом, который
        // `Display` у reqwest дописывает сам. Здесь это безопасно: токен уходит
        // ЗАГОЛОВКОМ `Authorization` (см. `headers`), и в URL секретов нет.
        //
        // У соседнего клиента (`namecheap::transport_err`) ровно поэтому всё
        // иначе: там credential едет query-параметром, и адрес из текста
        // ошибки вычищается. Разница между двумя клиентами — следствие разных
        // способов авторизации, а не недосмотр; выравнивать их «под один
        // стиль» нельзя. Если Hostiq однажды переедет на ключ в query-строке,
        // эти две строки станут такой же утечкой, как та, что чинилась там.
        let resp = req
            .send()
            .await
            .map_err(|e| RegistrarError::Api(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| RegistrarError::Api(e.to_string()))?;
        if status.as_u16() >= 400 {
            return Err(RegistrarError::Api(failure_text(status, &text)));
        }
        if text.is_empty() {
            return Ok(serde_json::json!({}));
        }
        match serde_json::from_str(&text) {
            Ok(v) => Ok(v),
            Err(_) => Ok(Value::String(text)),
        }
    }
}

/// Как назвать неудачный ответ Hostiq.
///
/// Тело сюда НЕ попадает, и это не про формат, а про то, что текст ошибки
/// теперь виден пользователю: карточка домена печатает его в бейдже
/// делегирования (`DomainNsPanel`). Ответ не от Hostiq — страница корпоративного
/// прокси, WAF, капча, HTML-заглушка — не должен въезжать в интерфейс целиком.
/// Тот же приём и по той же причине, что у `namecheap::failure_text`; секрета в
/// теле нет (токен уходит заголовком), но и мусору там не место.
fn failure_text(status: reqwest::StatusCode, body: &str) -> String {
    match error_message(body) {
        Some(m) => format!("Hostiq error: {m}"),
        None => format!("Hostiq returned an unrecognised response (HTTP {status})"),
    }
}

/// Человекочитаемая причина из тела ошибки Hostiq, если она там есть.
/// Ключи перечислены, а не угаданы: у API встречаются и `message`, и `error`,
/// и список `errors`.
fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    for key in ["message", "error", "detail"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    let errs: Vec<String> = v
        .get("errors")?
        .as_array()?
        .iter()
        .filter_map(|e| {
            e.as_str()
                .or_else(|| e.get("message").and_then(|m| m.as_str()))
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .collect();
    (!errs.is_empty()).then(|| errs.join("; "))
}

/// Полезное тело ответа без конверта.
///
/// Hostiq кладёт данные то в `data`, то на верхний уровень: листинг доменов это
/// умел с самого начала, а карточка одного домена — нет, и на конверте
/// `{"data": …}` она не находила nameservers ВООБЩЕ ни у одного домена, то есть
/// бейдж делегирования у всех доменов Hostiq навсегда оставался бы «UNKNOWN».
/// Одна функция на оба места, чтобы асимметрия не завелась заново.
fn unwrap_envelope(data: &Value) -> &Value {
    data.get("data").unwrap_or(data)
}

#[async_trait]
impl RegistrarService for HostiqService {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError> {
        match self.call(reqwest::Method::GET, "/domains", None).await {
            Ok(_) => Ok((true, "ok".into())),
            Err(e) => Ok((false, e.to_string())),
        }
    }

    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError> {
        let data = self
            .call(reqwest::Method::GET, "/domains", None)
            .await?;
        let items = unwrap_envelope(&data)
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        for d in items {
            let Some(o) = d.as_object() else { continue };
            let domain = o
                .get("domain")
                .or(o.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if domain.is_empty() {
                continue;
            }
            let ns = o
                .get("nameservers")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            out.push(DomainInfo {
                domain,
                expiry_date: o
                    .get("expires_at")
                    .or(o.get("expiry_date"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                status: o.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                nameservers: ns,
            });
        }
        Ok(out)
    }

    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError> {
        let payload = serde_json::json!({ "nameservers": ns });
        self.call(
            reqwest::Method::PUT,
            &format!("/domains/{domain}/nameservers"),
            Some(payload),
        )
        .await?;
        Ok(true)
    }

    async fn get_nameservers(&self, domain: &str) -> Result<Vec<String>, RegistrarError> {
        let data = self
            .call(reqwest::Method::GET, &format!("/domains/{domain}"), None)
            .await?;
        nameservers_of(&data).ok_or_else(|| {
            RegistrarError::Api("Hostiq response does not contain nameservers".into())
        })
    }
}

/// Nameservers из ответа по одному домену — в сравнимом виде.
///
/// Отдельной чистой функцией, потому что живой вызов требует сети, а цена
/// ошибки здесь — «UNKNOWN» на бейдже делегирования у всех доменов Hostiq
/// сразу: ровно так и вышло бы, читай мы `nameservers` мимо конверта `data`.
fn nameservers_of(data: &Value) -> Option<Vec<String>> {
    let arr = unwrap_envelope(data).get("nameservers")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str())
            .map(normalize_ns)
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Живой путь целиком: ответ в конверте `data` обязан доехать до
    /// вызывающего списком NS. Разбор проверен и отдельно, но именно здесь
    /// видно, что `get_nameservers` его зовёт — асимметрия внутри файла
    /// заводится ровно в этом зазоре.
    #[tokio::test]
    async fn get_nameservers_reads_a_wrapped_response_end_to_end() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domains/example.com"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"domain": "example.com",
                         "nameservers": ["ADA.ns.cloudflare.com.", "bob.ns.cloudflare.com"]}
            })))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        assert_eq!(
            svc.get_nameservers("example.com").await.unwrap(),
            vec!["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
        );
    }

    /// Ошибка живого пути доезжает до экрана (бейдж делегирования), поэтому
    /// чужое тело не должно доезжать вместе с ней. Тест держит именно вызов
    /// `failure_text` в `call`, а не саму функцию.
    #[tokio::test]
    async fn a_foreign_error_body_does_not_reach_the_caller() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domains/example.com"))
            .respond_with(
                ResponseTemplate::new(502)
                    .set_body_string("<html><body>nginx proxy error, request id 42</body></html>"),
            )
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let err = svc.get_nameservers("example.com").await.unwrap_err();
        let text = err.to_string();
        assert!(text.contains("unrecognised response (HTTP 502"), "{text}");
        assert!(!text.contains("nginx"), "{text}");
        // Токен уходит заголовком, но проверить его отсутствие дешевле, чем
        // однажды это обнаружить: текст едет в интерфейс.
        assert!(!text.contains("secret-token"), "{text}");
    }

    /// Оба варианта ответа, и оба — с живого API: листинг Hostiq заворачивает
    /// данные в `data`, и нет причины считать, что карточка домена отвечает
    /// иначе. Пока читался только верхний уровень, конверт означал «NS нет».
    #[test]
    fn nameservers_are_read_through_the_data_envelope_and_without_it() {
        let wrapped = serde_json::json!({
            "data": {"domain": "example.com", "nameservers": ["ADA.ns.cloudflare.com.", "bob.ns.cloudflare.com"]}
        });
        assert_eq!(
            nameservers_of(&wrapped).unwrap(),
            vec!["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
        );

        let bare = serde_json::json!({
            "domain": "example.com", "nameservers": ["ada.ns.cloudflare.com"]
        });
        assert_eq!(
            nameservers_of(&bare).unwrap(),
            vec!["ada.ns.cloudflare.com"]
        );
    }

    /// «Ответ без nameservers» обязан остаться отличимым от «nameservers пусты»:
    /// первое — незнание (бейдж «UNKNOWN»), второе — утверждение.
    #[test]
    fn a_response_without_nameservers_is_not_an_empty_list() {
        assert!(nameservers_of(&serde_json::json!({"data": {"domain": "x"}})).is_none());
        assert!(nameservers_of(&serde_json::json!({"nameservers": "ns1"})).is_none());
        assert_eq!(
            nameservers_of(&serde_json::json!({"nameservers": []})).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn failure_text_names_the_reason_from_the_body() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(
            failure_text(status, r#"{"message":"Domain not found"}"#),
            "Hostiq error: Domain not found"
        );
        assert_eq!(
            failure_text(status, r#"{"error":"invalid token"}"#),
            "Hostiq error: invalid token"
        );
        assert_eq!(
            failure_text(status, r#"{"errors":["ns1 is invalid","ns2 is invalid"]}"#),
            "Hostiq error: ns1 is invalid; ns2 is invalid"
        );
        assert_eq!(
            failure_text(status, r#"{"errors":[{"message":"too many nameservers"}]}"#),
            "Hostiq error: too many nameservers"
        );
    }

    /// Главное в этой функции — чего в ответе НЕТ. Текст ошибки едет на экран
    /// (бейдж делегирования в карточке домена), а ответ мог прийти не от
    /// Hostiq: страница прокси или капча целиком в интерфейсе — не сообщение
    /// об ошибке, а мусор.
    #[test]
    fn failure_text_never_echoes_a_body_it_did_not_understand() {
        let html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
        let text = failure_text(reqwest::StatusCode::BAD_GATEWAY, html);
        assert_eq!(
            text,
            "Hostiq returned an unrecognised response (HTTP 502 Bad Gateway)"
        );
        assert!(!text.contains("nginx"), "{text}");

        // JSON, но без узнаваемой причины — тот же случай: пересказывать чужую
        // структуру целиком мы не беремся.
        let json = failure_text(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"trace_id":"abc","payload":{"whatever":1}}"#,
        );
        assert!(
            json.starts_with("Hostiq returned an unrecognised response"),
            "{json}"
        );
        assert!(!json.contains("trace_id"), "{json}");
    }
}
