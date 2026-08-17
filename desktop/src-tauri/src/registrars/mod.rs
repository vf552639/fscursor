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

/// Строка листинга аккаунта регистратора (`get_domains`).
///
/// Поля с nameservers здесь НЕТ, и это утверждение, а не пробел: листинг их не
/// знает НИ У ОДНОГО провайдера. `namecheap.domains.getList` не отдаёт NS вовсе
/// (в ответе есть только атрибуты домена), а в `domain/list` у Hostiq нет ни
/// одного поля с nameservers — проверено на всех 127 доменах боевого аккаунта
/// (`docs/HOSTIQ_API.md` §5).
///
/// Поле раньше было и всегда содержало `vec![]` у обоих клиентов — то есть
/// ловушка ровно того сорта, от которого построена лестница делегирования на
/// фронте: пустой список неотличим от ответа «у домена нет NS». Отсутствующее
/// поле такой подмены не допускает: за NS домена идут в реестр (`crate::rdap`),
/// и только туда.
#[derive(Debug, Clone, Serialize)]
pub struct DomainInfo {
    pub domain: String,
    pub expiry_date: Option<String>,
    pub status: Option<String>,
}

/// Что мы просим у API регистратора.
///
/// Чтения nameservers здесь НЕТ, и это решение, а не пробел. Источник «как есть»
/// один на всех провайдеров — реестр (`crate::rdap`): у Hostiq чтения NS в API
/// не существует вовсе (в `domain/list` нет такого поля — проверено на всех 127
/// доменах боевого аккаунта, см. `docs/HOSTIQ_API.md` §5), а у ручных
/// провайдеров вроде Dynadot нет и самого API. Метод в трейте означал бы, что
/// путь есть, — и у двух провайдеров из двух он врал бы по-разному: у Hostiq
/// отказом, у Namecheap правдой, которую всё равно никто не спрашивает.
/// Регистратору остаётся то, чего реестр не умеет: ЗАПИСЬ (`set_nameservers`).
#[async_trait]
pub trait RegistrarService: Send + Sync {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError>;
    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError>;
    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError>;
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
        // `?`, а не `expect` внутри клиента: сборка HTTP-клиента может не
        // удаться, и паника в async-команде оставила бы промис на фронте
        // невыполненным (см. `HostiqService::with_base_url`).
        "hostiq" => Ok(Box::new(hostiq::HostiqService::new(api_key)?)),
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
