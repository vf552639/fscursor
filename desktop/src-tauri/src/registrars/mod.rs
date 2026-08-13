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

/// Имя nameserver'а в сравнимом виде: без пробелов по краям, без завершающей
/// точки, в нижнем регистре.
///
/// Один нормализатор на всех провайдеров — по той же причине, по которой фронт
/// держит один `normalizeZoneName` на весь UI: списки от двух регистраторов
/// сравниваются с одним и тем же списком зоны Cloudflare, и разъехавшиеся
/// правила дали бы «расходится» на верном делегировании. Пока это выражение
/// стояло инлайном в каждом клиенте, оно уже было двумя копиями.
pub fn normalize_ns(raw: &str) -> String {
    raw.trim().trim_end_matches('.').to_lowercase()
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
