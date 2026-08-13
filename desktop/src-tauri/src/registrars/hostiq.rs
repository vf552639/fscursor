//! Hostiq registrar (https://hostiq.ua/api).

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use super::{normalize_ns, DomainInfo, RegistrarError, RegistrarService};

const HOSTIQ_API: &str = "https://hostiq.ua/api";

pub struct HostiqService {
    token: String,
    client: Client,
}

impl HostiqService {
    pub fn new(api_key: &str) -> Self {
        Self {
            token: api_key.to_string(),
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
            HOSTIQ_API.trim_end_matches('/'),
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
            return Err(RegistrarError::Api(format!("Hostiq {}: {}", status, text)));
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
        let items = data
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .or_else(|| data.as_array().cloned())
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
        let nameservers = data.get("nameservers").and_then(|v| v.as_array());
        let Some(arr) = nameservers else {
            return Err(RegistrarError::Api(
                "Hostiq response does not contain nameservers".into(),
            ));
        };
        Ok(arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(normalize_ns)
            .filter(|s| !s.is_empty())
            .collect())
    }
}
