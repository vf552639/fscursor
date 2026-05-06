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

    async fn get_nameservers(&self, domain: &str) -> Result<Vec<String>, RegistrarError> {
        let (sld, tld) = split_domain(domain)?;
        let xml = self
            .call("namecheap.domains.getInfo", &[("SLD", sld), ("TLD", tld)])
            .await?;
        let doc = Document::parse(&xml).map_err(|e| RegistrarError::Api(e.to_string()))?;
        for n in doc.descendants() {
            if strip_ns(n.tag_name().name()) == "DomainDNSGetListResult" {
                if let Some(raw) = n.attribute("Nameservers") {
                    return Ok(raw
                        .split(',')
                        .map(|s| s.trim().trim_end_matches('.').to_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect());
                }
            }
        }
        Ok(vec![])
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

    #[test]
    fn status_ok_detection() {
        let xml = r#"<?xml version="1.0"?><ApiResponse Status="OK"></ApiResponse>"#;
        assert!(namecheap_status_ok(xml));
    }
}
