//! Registrar API clients (Hostiq JSON, Namecheap XML).

use async_trait::async_trait;
use serde::Serialize;

pub mod hostiq;
pub mod namecheap;

#[derive(Debug, thiserror::Error)]
pub enum RegistrarError {
    #[error("api: {0}")]
    Api(String),
    #[error("not implemented")]
    NotImplemented,
}

#[derive(Debug, Clone, Serialize)]
pub struct DomainInfo {
    pub domain: String,
    pub expiry_date: Option<String>,
    pub status: Option<String>,
    pub nameservers: Vec<String>,
}

#[async_trait]
pub trait RegistrarService: Send + Sync {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError>;
    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError>;
    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError>;
    async fn get_nameservers(&self, domain: &str) -> Result<Vec<String>, RegistrarError>;
}

pub fn make_service(
    provider: &str,
    api_key: &str,
    api_user: Option<&str>,
    api_secret: Option<&str>,
) -> Result<Box<dyn RegistrarService>, RegistrarError> {
    match provider.to_lowercase().as_str() {
        "hostiq" => Ok(Box::new(hostiq::HostiqService::new(api_key))),
        "namecheap" => Ok(Box::new(namecheap::NamecheapService::new(
            api_key,
            api_user.unwrap_or(""),
            api_secret.unwrap_or("127.0.0.1"),
        ))),
        other => Err(RegistrarError::Api(format!("unknown provider: {other}"))),
    }
}
