//! Namecheap XML API.

use async_trait::async_trait;
use reqwest::Client;
use roxmltree::Document;

use super::{normalize_ns, DomainInfo, RegistrarError, RegistrarService};

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

    /// Вычистить ключ из текста, который увидит человек.
    ///
    /// Namecheap принимает `ApiKey` ПАРАМЕТРОМ URL (см. `base_params`), поэтому
    /// любая строка, куда мог попасть адрес запроса, — это потенциальный слив
    /// секрета: `Display` у `reqwest::Error` дописывает `for url (…)`
    /// безусловно, а страница ошибки от прокси или WAF (в отличие от XML самого
    /// Namecheap) вполне может отэхоить request URI в теле ответа. Первый путь
    /// закрыт `without_url()` ниже, второй закрывается только так.
    ///
    /// Пустой ключ не вычищаем: замена пустой подстроки изрешетила бы текст
    /// маркерами, а секрета в этом случае и нет.
    fn scrub(&self, text: String) -> String {
        if self.api_key.is_empty() {
            return text;
        }
        text.replace(&self.api_key, REDACTED)
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
        // Тело ответа уезжает в текст ошибки целиком (в нём и лежит объяснение
        // от Namecheap), поэтому через `scrub` проходят ОБЕ ветки: XML самого
        // Namecheap ключа не эхоит, а вот HTML-страница прокси или WAF с
        // «Request: GET …?ApiKey=…» — обычное дело, и попадает она ровно сюда.
        if status.as_u16() >= 400 {
            return Err(RegistrarError::Api(self.scrub(format!(
                "Namecheap HTTP {}: {}",
                status, text
            ))));
        }
        if !namecheap_status_ok(&text) {
            let err = namecheap_errors(&text);
            return Err(RegistrarError::Api(self.scrub(format!(
                "Namecheap error: {}",
                err.unwrap_or_else(|| text.clone())
            ))));
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
                nameservers: vec![],
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

    /// Какие nameservers сейчас стоят у домена.
    ///
    /// Команда — `namecheap.domains.dns.getList`, и это ИМЕННО она: элемент
    /// `DomainDNSGetListResult`, который разбирается ниже, есть только в её
    /// ответе. `domains.getInfo` отдаёт другое дерево (`DomainGetInfoResult` с
    /// `DnsDetails`), так что разбор по нему не находил ничего и отдавал пустой
    /// список — «у домена нет NS» вместо ответа.
    ///
    /// Namecheap перечисляет серверы ДЕТЬМИ `<Nameserver>`; атрибут
    /// `Nameservers` со списком через запятую разбирается тоже — он встречается
    /// у прокси и в старых ответах, и стоит он дешевле, чем ещё один способ
    /// получить пустоту.
    async fn get_nameservers(&self, domain: &str) -> Result<Vec<String>, RegistrarError> {
        let (sld, tld) = split_domain(domain)?;
        let xml = self
            .call(
                "namecheap.domains.dns.getList",
                &[("SLD", sld), ("TLD", tld)],
            )
            .await?;
        parse_dns_get_list(&xml)
    }
}

/// Разбор ответа `namecheap.domains.dns.getList`.
///
/// Отдельной чистой функцией, потому что проверить её можно без сети — а
/// именно разбор тут и ломается: у Namecheap ответы отличаются по форме от
/// команды к команде, и промах даёт не ошибку, а пустой список, то есть
/// молчаливое «NS у домена нет».
fn parse_dns_get_list(xml: &str) -> Result<Vec<String>, RegistrarError> {
    let doc = Document::parse(xml).map_err(|e| RegistrarError::Api(e.to_string()))?;
    let mut children: Vec<String> = Vec::new();
    let mut from_attribute: Vec<String> = Vec::new();
    for n in doc.descendants() {
        match strip_ns(n.tag_name().name()) {
            "Nameserver" => {
                if let Some(ns) = n.text().map(normalize_ns) {
                    if !ns.is_empty() {
                        children.push(ns);
                    }
                }
            }
            "DomainDNSGetListResult" => {
                if let Some(raw) = n.attribute("Nameservers") {
                    from_attribute
                        .extend(raw.split(',').map(normalize_ns).filter(|s| !s.is_empty()));
                }
            }
            _ => {}
        }
    }
    // Формы РАВНОЗНАЧНЫ, а не дополняют друг друга: приди они обе (ответ через
    // прокси, который дописал атрибут к настоящему дереву), сложенные вместе они
    // дали бы каждый сервер дважды. Дедупликацией это не лечится — `Vec::dedup`
    // снимает только СОСЕДНИЕ повторы, а тут списки идут подряд целиком
    // (`[a,b,a,b]`), и повторы получаются несоседними. Поэтому не «склеить и
    // почистить», а выбрать: дети — основная форма, атрибут — запасная.
    Ok(if children.is_empty() {
        from_attribute
    } else {
        children
    })
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

    /// Тело ответа уезжает в текст ошибки целиком, а страница от прокси или WAF
    /// вполне может отэхоить request URI — с ключом внутри.
    #[test]
    fn response_body_is_scrubbed_of_the_key() {
        let svc = NamecheapService::new(SECRET, "user1", "1.2.3.4");
        let proxy_page =
            format!("<html>403 Forbidden. Request: GET /xml.response?ApiKey={SECRET}&Command=x</html>");

        let scrubbed = svc.scrub(format!("Namecheap HTTP 403 Forbidden: {proxy_page}"));

        assert!(!scrubbed.contains(SECRET), "ключ остался в теле: {scrubbed}");
        assert!(scrubbed.contains(REDACTED));
        assert!(scrubbed.contains("403 Forbidden"), "объяснение потеряно");
    }

    /// Пустой ключ (аккаунт без секрета) не должен превращать текст в решето из
    /// маркеров: `String::replace` по пустой подстроке вставляет её между всеми
    /// символами.
    #[test]
    fn empty_key_does_not_shred_the_text() {
        let svc = NamecheapService::new("", "user1", "1.2.3.4");
        assert_eq!(svc.scrub("Namecheap error: nope".into()), "Namecheap error: nope");
    }

    /// Ответ `namecheap.domains.dns.getList` в том виде, в каком его отдаёт
    /// Namecheap: пространство имён, серверы — дочерними элементами.
    #[test]
    fn dns_get_list_reads_nameserver_elements() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <CommandResponse Type="namecheap.domains.dns.getList">
    <DomainDNSGetListResult Domain="example.com" IsUsingOurDNS="false">
      <Nameserver>ADA.ns.cloudflare.com.</Nameserver>
      <Nameserver> bob.ns.cloudflare.com </Nameserver>
    </DomainDNSGetListResult>
  </CommandResponse>
</ApiResponse>"#;
        // Регистр и завершающая точка схлопнуты здесь же: сравнивать наборы
        // будет фронт, и приводить их к одному виду должны оба конца.
        assert_eq!(
            parse_dns_get_list(xml).unwrap(),
            vec!["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
        );
    }

    #[test]
    fn dns_get_list_reads_comma_attribute_form() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
        <DomainDNSGetListResult Domain="example.com" Nameservers="ns1.hoster.net, ns2.hoster.net"/>
        </CommandResponse></ApiResponse>"#;
        assert_eq!(
            parse_dns_get_list(xml).unwrap(),
            vec!["ns1.hoster.net", "ns2.hoster.net"]
        );
    }

    /// Домен на дефолтных NS Namecheap — это НЕ «нет ответа»: список приходит,
    /// просто он не наш. Пустым его отдавать нельзя, иначе фронт объявит
    /// делегирование неизвестным вместо расхождения.
    #[test]
    fn dns_get_list_returns_default_namecheap_servers() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
        <DomainDNSGetListResult Domain="example.com" IsUsingOurDNS="true">
          <Nameserver>dns1.registrar-servers.com</Nameserver>
          <Nameserver>dns2.registrar-servers.com</Nameserver>
        </DomainDNSGetListResult></CommandResponse></ApiResponse>"#;
        assert_eq!(parse_dns_get_list(xml).unwrap().len(), 2);
    }

    /// Обе формы в одном ответе — то, что докстринг разбора объявляет
    /// возможным (прокси дописал атрибут к настоящему дереву). Список серверов
    /// от этого удваиваться не должен: `Vec::dedup` тут бессилен, потому что
    /// повторы получаются НЕсоседними (`[a,b,a,b]`).
    #[test]
    fn dns_get_list_does_not_double_count_mixed_form() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
        <DomainDNSGetListResult Domain="example.com" Nameservers="ada.ns.cloudflare.com,bob.ns.cloudflare.com">
          <Nameserver>ada.ns.cloudflare.com</Nameserver>
          <Nameserver>bob.ns.cloudflare.com</Nameserver>
        </DomainDNSGetListResult></CommandResponse></ApiResponse>"#;
        assert_eq!(
            parse_dns_get_list(xml).unwrap(),
            vec!["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
        );
    }

    #[test]
    fn dns_get_list_survives_empty_result() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
        <DomainDNSGetListResult Domain="example.com"/></CommandResponse></ApiResponse>"#;
        assert!(parse_dns_get_list(xml).unwrap().is_empty());
    }
}
