//! Namecheap XML API.

use async_trait::async_trait;
use reqwest::Client;
use roxmltree::Document;

use super::{DomainInfo, RegistrarError, RegistrarService};

const NAMECHEAP_API: &str = "https://api.namecheap.com/xml.response";

pub struct NamecheapService {
    api_key: String,
    api_user: String,
    client_ip: String,
    http: Client,
}

impl NamecheapService {
    pub fn new(api_key: &str, api_user: &str, client_ip: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            api_user: api_user.to_string(),
            client_ip: client_ip.to_string(),
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest"),
        }
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
            .get(NAMECHEAP_API)
            .query(&params)
            .send()
            .await
            .map_err(|e| RegistrarError::Api(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| RegistrarError::Api(e.to_string()))?;
        if status.as_u16() >= 400 {
            return Err(RegistrarError::Api(format!(
                "Namecheap HTTP {}: {}",
                status, text
            )));
        }
        if !namecheap_status_ok(&text) {
            let err = namecheap_errors(&text);
            return Err(RegistrarError::Api(format!(
                "Namecheap error: {}",
                err.unwrap_or_else(|| text.clone())
            )));
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

/// Привести имя nameserver'а к сравнимому виду — так же, как это делает Hostiq
/// (`hostiq.rs`) и фронт (`normalizeZoneName`): без пробелов, без завершающей
/// точки, в нижнем регистре. Разные ответы на один вопрос от двух провайдеров
/// превратились бы в «расходится» на верном делегировании.
fn normalize_ns(raw: &str) -> String {
    raw.trim().trim_end_matches('.').to_lowercase()
}

/// Разбор ответа `namecheap.domains.dns.getList`.
///
/// Отдельной чистой функцией, потому что проверить её можно без сети — а
/// именно разбор тут и ломается: у Namecheap ответы отличаются по форме от
/// команды к команде, и промах даёт не ошибку, а пустой список, то есть
/// молчаливое «NS у домена нет».
fn parse_dns_get_list(xml: &str) -> Result<Vec<String>, RegistrarError> {
    let doc = Document::parse(xml).map_err(|e| RegistrarError::Api(e.to_string()))?;
    let mut out: Vec<String> = Vec::new();
    for n in doc.descendants() {
        match strip_ns(n.tag_name().name()) {
            "Nameserver" => {
                if let Some(ns) = n.text().map(normalize_ns) {
                    if !ns.is_empty() {
                        out.push(ns);
                    }
                }
            }
            "DomainDNSGetListResult" => {
                if let Some(raw) = n.attribute("Nameservers") {
                    out.extend(
                        raw.split(',')
                            .map(normalize_ns)
                            .filter(|s| !s.is_empty()),
                    );
                }
            }
            _ => {}
        }
    }
    out.dedup();
    Ok(out)
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

    #[test]
    fn dns_get_list_survives_empty_result() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse>
        <DomainDNSGetListResult Domain="example.com"/></CommandResponse></ApiResponse>"#;
        assert!(parse_dns_get_list(xml).unwrap().is_empty());
    }
}
