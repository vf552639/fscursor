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

/// Провайдеры, у которых есть API смены nameservers. Единственный список на
/// десктоп: `make_service` умеет ровно их (тест ниже это и держит), а фронт
/// зеркалит его в `lib/registrarCaps.ts`, чтобы дизейблить тумблер «Прописать
/// NS» до нажатия.
const NS_API_PROVIDERS: [&str; 2] = ["hostiq", "namecheap"];

/// Умеет ли провайдер менять NS через API.
///
/// Спрашивается ДО расшифровки ключей: у провайдера без API смена NS не
/// «падает», а не существует, и показывать её пользователю ошибкой значило бы
/// предлагать чинить то, что чинится только руками в панели регистратора.
/// Нормализация ровно та же, что у `make_service` (`to_lowercase`, без
/// `trim`): любое расхождение здесь означало бы «умеет» на провайдере, для
/// которого фабрика сервис не соберёт.
pub fn supports_ns_api(provider: &str) -> bool {
    NS_API_PROVIDERS.contains(&provider.to_lowercase().as_str())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Список и фабрика обязаны говорить одно и то же. Разъехавшись, они дают
    /// худший из исходов: full-setup пропускает шаг NS как «нет API» у
    /// провайдера, который его умеет, — то есть молча не делает работу.
    #[test]
    fn ns_api_list_matches_what_make_service_can_build() {
        // Хвост списка — ровно те входы, на которых две нормализации могли бы
        // разъехаться: регистр, пробелы, пустая строка, чужой провайдер.
        for provider in ["hostiq", "namecheap", "HostIQ", "godaddy", "", " namecheap "] {
            let built = make_service(provider, "k", Some("u"), Some("1.2.3.4")).is_ok();
            assert_eq!(
                supports_ns_api(provider),
                built,
                "расхождение по провайдеру {provider:?}"
            );
        }
    }
}
