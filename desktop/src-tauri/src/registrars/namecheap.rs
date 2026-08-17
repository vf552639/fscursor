//! Namecheap XML API.

use async_trait::async_trait;
use reqwest::Client;
use roxmltree::Document;

use super::{DomainInfo, RegistrarError, RegistrarService};

const NAMECHEAP_API: &str = "https://api.namecheap.com/xml.response";

/// Чем заменяется ключ в любом тексте, который уезжает наружу.
const REDACTED: &str = "***";

pub struct NamecheapService {
    api_key: String,
    api_user: String,
    client_ip: String,
    /// Адрес API. Поле, а не константа, ради теста на утечку ключа: проверять
    /// её надо на НАСТОЯЩЕЙ ошибке транспорта, а получить её без сети нельзя.
    base_url: String,
    http: Client,
}

impl NamecheapService {
    pub fn new(api_key: &str, api_user: &str, client_ip: &str) -> Self {
        Self::with_base_url(api_key, api_user, client_ip, NAMECHEAP_API)
    }

    fn with_base_url(api_key: &str, api_user: &str, client_ip: &str, base_url: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            api_user: api_user.to_string(),
            client_ip: client_ip.to_string(),
            base_url: base_url.to_string(),
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest"),
        }
    }

    /// Вычистить секреты из текста, который увидит человек.
    ///
    /// Namecheap принимает `ApiKey` ПАРАМЕТРОМ URL (см. `base_params`), поэтому
    /// любая строка, куда мог попасть адрес запроса, — это потенциальный слив
    /// секрета: `Display` у `reqwest::Error` дописывает `for url (…)`
    /// безусловно, а страница ошибки от прокси или WAF (в отличие от XML самого
    /// Namecheap) вполне может отэхоить request URI в теле ответа. Первый путь
    /// закрыт `without_url()` ниже, второй — тем, что тело наружу вообще не
    /// уезжает (`failure_text`); эта чистка стоит третьей и страхует оба.
    ///
    /// `client_ip` вычищается наравне с ключом, и это не перестраховка: у
    /// Namecheap им едет whitelisted IP, который продукт хранит ЗАШИФРОВАННЫМ
    /// блобом (`api_secret_blob_id`) и расшифровывает на клиенте той же
    /// машинерией, что и сам ключ. Раз на хранении он признан секретом, на
    /// показе он им тоже остаётся — иначе классификация продукта расходится
    /// сама с собой. `api_user` не вычищается сознательно: это логин, он не
    /// шифруется и без него текст ошибки нечем соотнести с аккаунтом.
    ///
    /// Пустые значения пропускаем: замена пустой подстроки изрешетила бы текст
    /// маркерами, а секрета в этом случае и нет.
    fn scrub(&self, text: String) -> String {
        let mut out = text;
        for secret in [self.api_key.as_str(), self.client_ip.as_str()] {
            if !secret.is_empty() {
                out = out.replace(secret, REDACTED);
            }
        }
        out
    }

    /// Ошибка транспорта без адреса запроса.
    ///
    /// `without_url()` у reqwest существует ровно для этого случая («useful if
    /// you need to remove sensitive information from the URL»), и вызывать его
    /// обязаны ОБА пути — и `send`, и чтение тела: таймаут в 30 секунд, обрыв
    /// Wi-Fi, сбой DNS и TLS через корпоративный прокси — это не «если», а
    /// «когда», а текст ошибки доезжает до экрана карточки домена.
    fn transport_err(&self, e: reqwest::Error) -> RegistrarError {
        RegistrarError::Api(self.scrub(e.without_url().to_string()))
    }

    fn base_params<'a>(
        &'a self,
        command: &'a str,
    ) -> Vec<(&'static str, &'a str)> {
        vec![
            ("ApiUser", self.api_user.as_str()),
            ("ApiKey", self.api_key.as_str()),
            ("UserName", self.api_user.as_str()),
            ("ClientIp", self.client_ip.as_str()),
            ("Command", command),
        ]
    }

    async fn call(&self, command: &str, extra: &[(&str, &str)]) -> Result<String, RegistrarError> {
        let mut params = self.base_params(command);
        params.extend_from_slice(extra);
        let resp = self
            .http
            .get(&self.base_url)
            .query(&params)
            .send()
            .await
            .map_err(|e| self.transport_err(e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| self.transport_err(e))?;
        // Два разных признака неудачи с одним исходом: HTTP-код (ответил не
        // Namecheap — прокси, WAF, капча) и `Status="ERROR"` в его собственном
        // XML (Namecheap ответил отказом, и код у него при этом 200). Ветки
        // сведены в одну намеренно: пока их было две, они формировали текст
        // порознь, и `scrub` можно было уронить в одной, не заметив.
        //
        // Наружу уезжает РАЗОБРАННАЯ ошибка, а не тело ответа (`failure_text`);
        // `scrub` поверх неё — страховка, а не единственная защита.
        if status.as_u16() >= 400 || !namecheap_status_ok(&text) {
            return Err(RegistrarError::Api(self.scrub(failure_text(status, &text))));
        }
        Ok(text)
    }
}

fn strip_ns(tag: &str) -> &str {
    tag.rsplit_once(':').map(|(_, t)| t).unwrap_or(tag)
}

fn namecheap_status_ok(xml: &str) -> bool {
    let Ok(doc) = Document::parse(xml) else {
        return false;
    };
    doc.descendants()
        .find(|n| strip_ns(n.tag_name().name()) == "ApiResponse")
        .and_then(|n| n.attribute("Status"))
        .map(|s| s.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
}

/// Как назвать неудачный ответ.
///
/// Тело сюда НЕ попадает, и это главная защита, а не придирка к формату.
/// Ветка «тело как есть» срабатывала ровно тогда, когда `namecheap_errors`
/// ничего не нашёл, — то есть когда ответ пришёл не от Namecheap: страница
/// прокси, WAF или капчи. Пользователю её текст (`<html><head><title>403…`) не
/// говорит ничего, а секрет в ней как раз бывает: такие страницы охотно эхоят
/// request URI, в котором у Namecheap лежит `ApiKey`. Показывать нечего —
/// значит и показывать не будем; `scrub` остаётся страховкой на случай, если
/// секрет просочится в разобранный текст (денилист по значению всегда неполон:
/// перенос строки внутри ключа в HTML, частичное вхождение, экранирование).
///
/// Разобранная ошибка Namecheap при этом сохраняется целиком: она и есть ответ
/// на вопрос «почему не вышло» («API Key is invalid», «IP is not whitelisted»).
fn failure_text(status: reqwest::StatusCode, xml: &str) -> String {
    match namecheap_errors(xml) {
        Some(err) => format!("Namecheap error: {err}"),
        None => format!("Namecheap returned an unrecognised response (HTTP {status})"),
    }
}

fn namecheap_errors(xml: &str) -> Option<String> {
    let doc = Document::parse(xml).ok()?;
    let errs: Vec<String> = doc
        .descendants()
        .filter(|n| strip_ns(n.tag_name().name()) == "Error")
        .filter_map(|n| n.text().map(|t| t.to_string()))
        .collect();
    if errs.is_empty() {
        None
    } else {
        Some(errs.join("; "))
    }
}

fn split_domain(domain: &str) -> Result<(&str, &str), RegistrarError> {
    let d = domain.trim().trim_end_matches('.');
    let Some((sld, tld)) = d.split_once('.') else {
        return Err(RegistrarError::Api(format!("Invalid domain: {domain}")));
    };
    Ok((sld, tld))
}

#[async_trait]
impl RegistrarService for NamecheapService {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError> {
        match self.call("namecheap.domains.getList", &[("PageSize", "10")]).await {
            Ok(_) => Ok((true, "ok".into())),
            Err(e) => Ok((false, e.to_string())),
        }
    }

    /// Домены аккаунта — ПЕРВАЯ СТРАНИЦА, и это надо знать вызывающему.
    ///
    /// `PageSize=100` без `Page`: пагинации здесь нет, хотя у `domains.getList`
    /// она есть (`Page`, а в ответе — `Paging/TotalItems`). Поэтому на аккаунте в
    /// 250 доменов отсутствие домена в ответе значит «страница кончилась» ничуть
    /// не реже, чем «домена в аккаунте нет», — и делать по этому листингу выводы
    /// ПРО ОТДЕЛЬНЫЙ домен нельзя. Раньше это обоснование стояло рядом с чтением
    /// NS, которое из-за него и было заведено поимённой командой; чтение уехало в
    /// реестр, а сама ловушка осталась здесь — и молчать о ней хуже, чем о ней
    /// написать. Соседний клиент листает по-настоящему (`hostiq::all_domains`
    /// идёт по `offset` до `total`), так что асимметрия эта — недоделка, а не
    /// решение.
    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError> {
        let xml = self
            .call("namecheap.domains.getList", &[("PageSize", "100")])
            .await?;
        let doc = Document::parse(&xml).map_err(|e| RegistrarError::Api(e.to_string()))?;
        let mut items = Vec::new();
        for n in doc.descendants() {
            if strip_ns(n.tag_name().name()) != "Domain" {
                continue;
            }
            let Some(name) = n.attribute("Name") else { continue };
            let expires = n.attribute("Expires").map(|s| s.to_string());
            let expired = n.attribute("IsExpired") == Some("true");
            items.push(DomainInfo {
                domain: name.to_string(),
                expiry_date: expires,
                status: Some(if expired {
                    "expired".into()
                } else {
                    "active".into()
                }),
            });
        }
        Ok(items)
    }

    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError> {
        let (sld, tld) = split_domain(domain)?;
        let joined = ns.join(",");
        let xml = self
            .call(
                "namecheap.domains.dns.setCustom",
                &[("SLD", sld), ("TLD", tld), ("Nameservers", joined.as_str())],
            )
            .await?;
        if !command_response_ok(&xml) {
            return Err(RegistrarError::Api(format!(
                "Namecheap setCustom failed: {}",
                namecheap_errors(&xml).unwrap_or_default()
            )));
        }
        Ok(true)
    }
}

fn command_response_ok(xml: &str) -> bool {
    let Ok(doc) = Document::parse(xml) else {
        return true;
    };
    doc.descendants()
        .find(|n| strip_ns(n.tag_name().name()) == "CommandResponse")
        .and_then(|n| n.attribute("Status"))
        .map(|s| s.eq_ignore_ascii_case("ok"))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn status_ok_detection() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"></ApiResponse>"#;
        assert!(namecheap_status_ok(xml));
    }

    const SECRET: &str = "SUPER-SECRET-API-KEY";

    /// Ключ Namecheap едет ПАРАМЕТРОМ URL, а текст ошибки этого клиента
    /// доезжает до экрана: карточка домена показывает его рядом с бейджем
    /// делегирования (`DomainNsPanel`), и он же уходит в любой лог, скриншот и
    /// баг-репорт.
    ///
    /// Проверяется на настоящем отказе транспорта (закрытый порт на localhost),
    /// потому что сливает секрет именно `Display` у `reqwest::Error`: он
    /// БЕЗУСЛОВНО дописывает « for url (…)» со всей query string. Ни собрать
    /// такую ошибку руками, ни поймать её на моке нельзя — только сходив в сеть.
    #[tokio::test]
    async fn transport_failure_does_not_leak_api_key() {
        // Порт 1 на localhost закрыт: соединение отваливается сразу, без
        // ожидания таймаута.
        let svc = NamecheapService::with_base_url(
            SECRET,
            "user1",
            "1.2.3.4",
            "http://127.0.0.1:1/xml.response",
        );
        let err = svc
            .call("namecheap.domains.dns.getList", &[("SLD", "example"), ("TLD", "com")])
            .await
            .expect_err("закрытый порт обязан дать ошибку");
        let text = err.to_string();

        assert!(
            !text.contains(SECRET),
            "ключ уехал в текст ошибки: {text}"
        );
        // И сам адрес тоже: query string целиком — это и ApiUser, и ClientIp.
        assert!(
            !text.contains("ApiKey"),
            "в тексте ошибки остался адрес запроса: {text}"
        );
        // Диагностическая ценность при этом сохранена — иначе «почистили»
        // означало бы «выбросили».
        assert!(
            text.contains("error sending request"),
            "из ошибки пропала её причина: {text}"
        );
    }

    /// Ошибка, разобранная из ответа Namecheap, проходит через `scrub` — и
    /// проверяется это ЧЕРЕЗ `call()`, а не вызовом `scrub` напрямую.
    ///
    /// Разница принципиальная: сам по себе `scrub` может быть безупречен и при
    /// этом не быть позван. Текст `<Error>` — единственное чужое содержимое,
    /// которое мы показываем намеренно (в нём и лежит «почему не вышло»), так
    /// что структурной заменой его не закрыть: если API отэхоит в нём параметр
    /// запроса, между ключом и экраном останется только эта чистка.
    #[tokio::test]
    async fn parsed_error_from_call_is_scrubbed() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xml.response"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors>
                <Error Number="2011102">Invalid request: ApiKey={SECRET} is not valid</Error>
                </Errors></ApiResponse>"#
            )))
            .mount(&srv)
            .await;
        let svc = NamecheapService::with_base_url(
            SECRET,
            "user1",
            "1.2.3.4",
            &format!("{}/xml.response", srv.uri()),
        );

        let err = svc
            .call("namecheap.domains.dns.getList", &[])
            .await
            .expect_err("Status=ERROR обязан стать ошибкой");
        let text = err.to_string();

        assert!(!text.contains(SECRET), "ключ уехал в текст ошибки: {text}");
        assert!(text.contains(REDACTED), "чистка не сработала: {text}");
        // Причина при этом сохранена: вычистили секрет, а не сообщение.
        assert!(text.contains("2011102") || text.contains("is not valid"), "объяснение потеряно: {text}");
    }

    /// Страница прокси/WAF наружу не уезжает вовсе — ни с секретом, ни без.
    #[tokio::test]
    async fn proxy_page_body_never_reaches_the_message() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/xml.response"))
            .respond_with(ResponseTemplate::new(403).set_body_string(format!(
                "<html><head><title>403</title></head><body>Request: GET /xml.response?ApiKey={SECRET}</body></html>"
            )))
            .mount(&srv)
            .await;
        let svc = NamecheapService::with_base_url(
            SECRET,
            "user1",
            "1.2.3.4",
            &format!("{}/xml.response", srv.uri()),
        );

        let text = svc
            .call("namecheap.domains.dns.getList", &[])
            .await
            .expect_err("403 обязан стать ошибкой")
            .to_string();

        assert!(!text.contains(SECRET), "ключ уехал в текст ошибки: {text}");
        // Именно НЕ показываем тело: пользователю оно не говорит ничего, а
        // носителем секрета бывает именно оно.
        assert!(!text.contains("<html>"), "тело чужой страницы уехало наружу: {text}");
        assert!(text.contains("403"), "статус потерян: {text}");
    }

    /// `client_ip` у Namecheap — это whitelisted IP, который продукт хранит
    /// зашифрованным блобом (`api_secret_blob_id`). Раз он секрет на хранении,
    /// он секрет и на показе.
    #[test]
    fn scrub_hides_the_whitelisted_ip_too() {
        let svc = NamecheapService::new(SECRET, "user1", "203.0.113.7");
        let scrubbed = svc.scrub("Namecheap error: 203.0.113.7 is not whitelisted".into());
        assert!(!scrubbed.contains("203.0.113.7"), "IP остался: {scrubbed}");
        assert!(scrubbed.contains("is not whitelisted"), "объяснение потеряно");
    }

    #[test]
    fn failure_text_keeps_namecheap_errors_and_drops_foreign_bodies() {
        let status = reqwest::StatusCode::FORBIDDEN;
        let xml = r#"<ApiResponse Status="ERROR"><Errors><Error Number="1011102">API Key is invalid</Error></Errors></ApiResponse>"#;
        assert_eq!(failure_text(status, xml), "Namecheap error: API Key is invalid");

        let html = "<html><body>blocked</body></html>";
        assert_eq!(
            failure_text(status, html),
            "Namecheap returned an unrecognised response (HTTP 403 Forbidden)"
        );
    }

    /// Пустой ключ (аккаунт без секрета) не должен превращать текст в решето из
    /// маркеров: `String::replace` по пустой подстроке вставляет её между всеми
    /// символами.
    #[test]
    fn empty_key_does_not_shred_the_text() {
        let svc = NamecheapService::new("", "user1", "1.2.3.4");
        assert_eq!(svc.scrub("Namecheap error: nope".into()), "Namecheap error: nope");
    }
}
