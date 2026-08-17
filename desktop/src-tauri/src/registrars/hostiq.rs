//! Hostiq DI-API v3 (https://hostiq.ua/clients/di-api/v3).
//!
//! Прежний клиент этого файла был ВЫДУМАН: он бил в `https://hostiq.ua/api` с
//! `Authorization: Bearer`, а такого хоста нет вовсе — `/api/domains` отдаёт
//! 404 HTML, эндпоинта `PUT /domains/{d}/nameservers` не существует. То есть
//! смена NS у Hostiq не работала никогда, а не «сломалась».
//!
//! Контракт ниже установлен живой проверкой боевым токеном (127 доменов, 120
//! активных), а не документацией. Ловушки DI-API v3 молчаливые: API не отвечает
//! ошибкой, а тихо делает не то, — поэтому каждая отмечена комментарием там, где
//! на неё поставлен код.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use serde_json::Value;

use super::{normalize_ns, DomainInfo, RegistrarError, RegistrarService};

const HOSTIQ_API: &str = "https://hostiq.ua/clients/di-api/v3";

/// Размер страницы листинга. 1000 — это ПОТОЛОК, а не выбор: `limit=1001` API
/// не отбивает ошибкой, а молча откатывает к 100. Взять «весь аккаунт одним
/// запросом» нельзя даже на большом числе — только пагинация.
const PAGE_LIMIT: usize = 1000;

/// Сколько nameservers принимает `domain/changeNameServer`: `ns1`+`ns2`
/// обязательны, дальше до `ns5`.
const MIN_NS: usize = 2;
const MAX_NS: usize = 5;

pub struct HostiqService {
    token: String,
    /// Адрес API. Поле, а не константа, — тем же приёмом и по той же нужде, что
    /// у `NamecheapService`: проверять надо не разбор в отдельной функции, а то,
    /// что живой путь ответа зовёт именно её.
    base_url: String,
    client: Client,
    /// Карта «имя домена → `domainid`» на время жизни сервиса.
    ///
    /// Кэш здесь не украшение: `domainid` добывается ТОЛЬКО полным листингом
    /// аккаунта (см. `domain_id`), то есть цена одной смены NS — выкачка всех
    /// 127 доменов.
    ///
    /// Живёт он ровно столько, сколько сам сервис, и это его потолок:
    /// `commands::registrars::reg_service` собирает новый сервис на КАЖДУЮ
    /// tauri-команду, так что массовый прогон (`full_setup::push_nameservers`
    /// зовёт команду смены NS по домену за раз) всё ещё листает аккаунт заново
    /// на каждый домен. Убрать это можно только слоем выше — переиспользованием
    /// сервиса между вызовами; здесь такой рычаг недостижим.
    domain_ids: Mutex<HashMap<String, i64>>,
}

impl HostiqService {
    pub fn new(api_key: &str) -> Self {
        Self::with_base_url(api_key, HOSTIQ_API)
    }

    fn with_base_url(api_key: &str, base_url: &str) -> Self {
        Self {
            // Токен приезжает вставкой из личного кабинета, а вставка охотно
            // тащит перевод строки и пробелы по краям — в заголовок такое
            // значение не кладётся вовсе (см. `headers`).
            token: api_key.trim().to_string(),
            base_url: base_url.to_string(),
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest"),
            domain_ids: Mutex::new(HashMap::new()),
        }
    }

    /// Заголовки запроса.
    ///
    /// Авторизация — один заголовок `X-Authorization-Token` с тем самым «hash»
    /// из личного кабинета. Email при этом не нужен вовсе: у DI-API v3 нет
    /// второго credential'а, и поле «API User» в форме Hostiq лишнее.
    ///
    /// `Result`, а не `HeaderMap`, из-за токена: значение приходит от человека, и
    /// невалидный символ в нём обязан стать ошибкой запроса, а не паникой внутри
    /// tauri-команды. Сам токен в текст ошибки не попадает — он и есть секрет.
    fn headers(&self) -> Result<HeaderMap, RegistrarError> {
        let token = HeaderValue::from_str(&self.token).map_err(|_| {
            RegistrarError::Api("Hostiq token contains characters that cannot be sent".into())
        })?;
        let mut h = HeaderMap::new();
        h.insert("X-Authorization-Token", token);
        h.insert("Content-Type", HeaderValue::from_static("application/json"));
        h.insert("Accept", HeaderValue::from_static("application/json"));
        Ok(h)
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
        let mut req = self.client.request(method, url).headers(self.headers()?);
        if let Some(j) = json_body {
            // Тело только JSON. Form-encoded DI-API v3 отбивает `400 Syntax
            // error` — без подсказки, что дело в кодировке тела.
            req = req.json(&j);
        }
        // Ошибку транспорта отдаём как есть — вместе с адресом, который
        // `Display` у reqwest дописывает сам. Здесь это безопасно: токен уходит
        // ЗАГОЛОВКОМ `X-Authorization-Token` (см. `headers`), и в URL секретов
        // нет.
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

    /// Весь список доменов аккаунта, страницами.
    ///
    /// Смещение двигается на ЧИСЛО ПОЛУЧЕННЫХ записей, а не на `PAGE_LIMIT`:
    /// запрошенный `limit` API соблюдать не обязан (выше 1000 он молча отдаёт
    /// 100), и шаг «по запрошенному» перепрыгивал бы через хвост каждой
    /// страницы. Условие остановки — `total` из ответа; пустая страница
    /// обрывает цикл отдельно, чтобы враньё в `total` не стало вечным циклом.
    async fn all_domains(&self) -> Result<Vec<Value>, RegistrarError> {
        let mut out: Vec<Value> = Vec::new();
        let mut offset = 0usize;
        loop {
            let page = self
                .call(
                    reqwest::Method::GET,
                    &format!("/domain/list?limit={PAGE_LIMIT}&offset={offset}"),
                    None,
                )
                .await?;
            let items = page
                .get("domains")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                break;
            }
            offset += items.len();
            out.extend(items);
            let total = page
                .get("total")
                .and_then(as_i64)
                .map(|t| t.max(0) as usize)
                .unwrap_or(out.len());
            if out.len() >= total {
                break;
            }
        }
        Ok(out)
    }

    /// `domainid` домена — числом, как его требует `changeNameServer`.
    ///
    /// Только полным листингом: `filter` по имени домена DI-API v3 МОЛЧА
    /// игнорирует — `{"domainname":"…"}` и `{"domain":"…"}` возвращают весь
    /// аккаунт целиком, так что «нашли одну запись» означало бы «взяли первую
    /// попавшуюся». Работает лишь документированный ключ (`status`), а по нему
    /// домен не найти.
    async fn domain_id(&self, domain: &str) -> Result<i64, RegistrarError> {
        // Нормализация та же, что у имён NS: регистр и завершающая точка не
        // должны решать, найдётся домен или нет.
        let key = normalize_ns(domain);
        if let Some(id) = self.cached_id(&key) {
            return Ok(id);
        }
        let index = domain_index(&self.all_domains().await?);
        let found = index.get(&key).copied();
        *self.domain_ids.lock().unwrap_or_else(|e| e.into_inner()) = index;
        found.ok_or_else(|| {
            // Отдельная ошибка, а не то, что ответит API: с чужим или неверным
            // `domainid` DI-API v3 отвечает `403 Forbidden`, и «нет прав» вместо
            // «домена нет в аккаунте» отправило бы разбираться не туда.
            RegistrarError::Api(format!(
                "Hostiq: domain {domain} is not in this account's domain list"
            ))
        })
    }

    fn cached_id(&self, key: &str) -> Option<i64> {
        self.domain_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .copied()
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
///
/// Ключи перечислены, а не угаданы. DI-API v3 отвечает ВЛОЖЕННЫМ конвертом
/// `{"error":{"code":400,"message":"…"}}`, и читать его обязательно: без этой
/// ветки любой отказ API выглядел бы «нераспознанным ответом», то есть выглядел
/// бы поломкой прокси. Ключи верхнего уровня (`message`, `error` строкой,
/// `detail`, список `errors`) оставлены рядом: они встречались у Hostiq и стоят
/// дешевле, чем ещё один способ получить «нераспознанный ответ».
fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    for key in ["message", "error", "detail"] {
        if let Some(s) = non_empty(v.get(key)) {
            return Some(s);
        }
    }
    if let Some(s) = non_empty(v.get("error").and_then(|e| e.get("message"))) {
        return Some(s);
    }
    let errs: Vec<String> = v
        .get("errors")?
        .as_array()?
        .iter()
        .filter_map(|e| non_empty(Some(e)).or_else(|| non_empty(e.get("message"))))
        .collect();
    (!errs.is_empty()).then(|| errs.join("; "))
}

/// Непустая строка из значения JSON. Значение нестрокового типа (тот самый
/// `error`, который у DI-API v3 бывает объектом) — не строка, а не пустая.
fn non_empty(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Число из значения, которое API отдаёт то числом, то строкой (`id`, `total`).
fn as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str()?.trim().parse().ok())
}

/// Карта «имя домена → `domainid`» из записей листинга.
fn domain_index(items: &[Value]) -> HashMap<String, i64> {
    items
        .iter()
        .filter_map(|d| {
            let name = normalize_ns(d.get("domainname")?.as_str()?);
            let id = as_i64(d.get("id")?)?;
            (!name.is_empty()).then_some((name, id))
        })
        .collect()
}

#[async_trait]
impl RegistrarService for HostiqService {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError> {
        match self
            .call(reqwest::Method::GET, "/domain/list?limit=10", None)
            .await
        {
            Ok(_) => Ok((true, "ok".into())),
            Err(e) => Ok((false, e.to_string())),
        }
    }

    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError> {
        let items = self.all_domains().await?;
        let mut out = Vec::new();
        for d in items {
            let Some(o) = d.as_object() else { continue };
            let domain = o
                .get("domainname")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if domain.is_empty() {
                continue;
            }
            out.push(DomainInfo {
                domain,
                expiry_date: o
                    .get("expirydate")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                status: o
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                // Пусто не «не разобрали», а «их тут нет»: в `domain/list` нет
                // ни одного поля с nameservers — проверено на всех 127 доменах
                // боевого аккаунта.
                nameservers: vec![],
            });
        }
        Ok(out)
    }

    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError> {
        let servers: Vec<String> = ns
            .iter()
            .map(|s| normalize_ns(s))
            .filter(|s| !s.is_empty())
            .collect();
        // Гейты ДО сети. На неверном числе серверов API отвечает голым
        // `{"code":400,"message":"error"}` — без объяснения причины, так что
        // пользователю досталась бы ошибка, из которой нечего понять.
        if servers.len() < MIN_NS {
            return Err(RegistrarError::Api(format!(
                "Hostiq requires at least {MIN_NS} nameservers, got {}",
                servers.len()
            )));
        }
        if servers.len() > MAX_NS {
            return Err(RegistrarError::Api(format!(
                "Hostiq accepts at most {MAX_NS} nameservers, got {}",
                servers.len()
            )));
        }

        let id = self.domain_id(domain).await?;
        let mut body = serde_json::Map::new();
        // `domainid` только ЧИСЛОМ: строкой (`"245736"`) DI-API v3 отвечает
        // `400 Bad Request`, хотя значение то же самое.
        body.insert("domainid".into(), Value::from(id));
        for (i, host) in servers.iter().enumerate() {
            body.insert(format!("ns{}", i + 1), Value::from(host.clone()));
        }
        self.call(
            reqwest::Method::POST,
            "/domain/changeNameServer",
            Some(Value::Object(body)),
        )
        .await?;
        Ok(true)
    }

    /// Чтения nameservers у Hostiq НЕ СУЩЕСТВУЕТ.
    ///
    /// Не «не реализовано» и не «сломано»: в единственном источнике данных о
    /// доменах (`domain/list`) нет поля с nameservers вовсе — проверено на всех
    /// 127 доменах боевого аккаунта, — а отдельного эндпоинта под них у DI-API
    /// v3 нет. Поэтому здесь честный отказ без сети: выдуманный эндпоинт вернул
    /// бы 404, и «Hostiq не отвечает» врало бы про причину, а пустой список врал
    /// бы ещё хуже — «у домена нет NS».
    ///
    /// Метод существует только потому, что он ещё в трейте `RegistrarService`.
    /// Источником «как есть» становится RDAP (реестр), после чего метод уезжает
    /// из трейта целиком вместе с этой заглушкой.
    async fn get_nameservers(&self, _domain: &str) -> Result<Vec<String>, RegistrarError> {
        Err(RegistrarError::Api(
            "Hostiq DI-API v3 does not expose nameservers: read them from the registry (RDAP)"
                .into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Закрытый порт: любая попытка сходить в сеть отсюда провалится и будет
    /// отличима от ожидаемой ошибки по тексту.
    const NOWHERE: &str = "http://127.0.0.1:1";

    fn page(domains: Value, total: i64) -> ResponseTemplate {
        let count = domains.as_array().map(|a| a.len()).unwrap_or(0);
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "domains": domains, "count": count, "total": total
        }))
    }

    /// Токен уезжает заголовком `X-Authorization-Token` — на этом стоит весь
    /// разбор про безопасность текста ошибок в `call`. Матчер по заголовку
    /// держит именно это: со старым `Authorization: Bearer` мок не ответит.
    #[tokio::test]
    async fn test_connection_lists_domains_with_the_token_header() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .and(query_param("limit", "10"))
            .and(header("X-Authorization-Token", "secret-token"))
            .respond_with(page(serde_json::json!([]), 0))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        assert_eq!(svc.test_connection().await.unwrap(), (true, "ok".into()));
    }

    /// Пагинация целиком, живым путём: аккаунт больше страницы обязан доехать
    /// до вызывающего полностью. Смещение идёт по числу ПОЛУЧЕННЫХ записей —
    /// страница здесь короче запрошенного `limit` ровно потому, что в жизни API
    /// так и делает (выше 1000 он молча отдаёт 100).
    #[tokio::test]
    async fn get_domains_walks_every_page_until_total() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .and(query_param("offset", "0"))
            .respond_with(page(
                serde_json::json!([
                    {"id": 245736, "domainname": "betify2.com",
                     "expirydate": "2027-01-15", "status": "Active"},
                    {"id": 245737, "domainname": "second.com",
                     "expirydate": "2026-12-01", "status": "Active"}
                ]),
                3,
            ))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .and(query_param("offset", "2"))
            .respond_with(page(
                serde_json::json!([
                    {"id": 245738, "domainname": "third.com",
                     "expirydate": "2026-03-09", "status": "Expired"}
                ]),
                3,
            ))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let domains = svc.get_domains().await.unwrap();

        let names: Vec<&str> = domains.iter().map(|d| d.domain.as_str()).collect();
        assert_eq!(names, vec!["betify2.com", "second.com", "third.com"]);
        assert_eq!(domains[0].expiry_date.as_deref(), Some("2027-01-15"));
        assert_eq!(domains[2].status.as_deref(), Some("Expired"));
        // NS у Hostiq не отдаёт ни один эндпоинт: пусто здесь — утверждение
        // «их тут нет», а не потерянный разбор.
        assert!(domains[0].nameservers.is_empty());
    }

    /// Смена NS целиком: имя домена → `domainid` из листинга → тело запроса.
    /// Форма тела проверяется по факту отправки, а не по коду: `domainid`
    /// строкой и form-encoded тело API отбивает `400`, и обе ошибки молчаливые.
    #[tokio::test]
    async fn set_nameservers_matches_the_domain_by_name_and_sends_a_numeric_id() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .respond_with(page(
                serde_json::json!([
                    {"id": 245735, "domainname": "other.com"},
                    {"id": 245736, "domainname": "betify2.com"}
                ]),
                2,
            ))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path("/domain/changeNameServer"))
            .and(body_json(serde_json::json!({
                "domainid": 245736,
                "ns1": "ada.ns.cloudflare.com",
                "ns2": "bob.ns.cloudflare.com"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": "success"
            })))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        // Регистр и завершающая точка нормализуются по дороге: реестр принимает
        // только существующие хосты, и мусор по краям имени — лишний повод для
        // отказа без объяснения.
        let ns = vec![
            "ADA.ns.cloudflare.com.".to_string(),
            " bob.ns.cloudflare.com ".to_string(),
        ];
        assert!(svc.set_nameservers("Betify2.com", &ns).await.unwrap());

        // Тело запроса проверяем ещё раз глазами: `body_json` выше уже сравнил
        // его целиком, но именно тип `domainid` стоил живой отладки.
        let sent = srv.received_requests().await.unwrap();
        let post: Value = sent
            .iter()
            .find(|r| r.url.path().ends_with("changeNameServer"))
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .expect("запрос смены NS не отправлен");
        assert!(post["domainid"].is_i64(), "domainid уехал не числом: {post}");
        assert!(post.get("ns3").is_none(), "лишний ns3 в теле: {post}");
    }

    /// Листинг ради `domainid` — дорогой: весь аккаунт целиком на одну смену NS.
    /// В пределах жизни сервиса он обязан случиться один раз (границы кэша — в
    /// докстринге поля `domain_ids`).
    #[tokio::test]
    async fn the_domain_id_map_is_fetched_once_per_service() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .respond_with(page(
                serde_json::json!([
                    {"id": 1, "domainname": "one.com"},
                    {"id": 2, "domainname": "two.com"}
                ]),
                2,
            ))
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path("/domain/changeNameServer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "result": "success"
            })))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let ns = vec![
            "ada.ns.cloudflare.com".to_string(),
            "bob.ns.cloudflare.com".to_string(),
        ];
        svc.set_nameservers("one.com", &ns).await.unwrap();
        svc.set_nameservers("two.com", &ns).await.unwrap();

        let listings = srv
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().ends_with("/domain/list"))
            .count();
        assert_eq!(listings, 1, "аккаунт выкачан заново на второй домен");
    }

    /// Домена нет в аккаунте — это своя ошибка, а не то, что ответит API: с
    /// чужим `domainid` DI-API v3 говорит `403 Forbidden`, и «нет прав» вместо
    /// «домена нет» отправило бы разбираться не туда.
    #[tokio::test]
    async fn an_unknown_domain_is_named_as_such_and_never_sent() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .respond_with(page(
                serde_json::json!([{"id": 1, "domainname": "one.com"}]),
                1,
            ))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let ns = vec![
            "ada.ns.cloudflare.com".to_string(),
            "bob.ns.cloudflare.com".to_string(),
        ];
        let text = svc
            .set_nameservers("missing.com", &ns)
            .await
            .expect_err("домена нет в листинге — обязана быть ошибка")
            .to_string();

        assert!(text.contains("missing.com"), "{text}");
        assert!(!text.to_lowercase().contains("forbidden"), "{text}");
        // Запрос смены при этом не уходил вовсе.
        let posted = srv
            .received_requests()
            .await
            .unwrap()
            .iter()
            .any(|r| r.method == wiremock::http::Method::POST);
        assert!(!posted, "смена NS ушла на неизвестный домен");
    }

    /// Число серверов проверяется ДО сети: адрес заведомо мёртвый, и ошибка
    /// обязана быть про количество, а не про соединение. Иначе пользователю
    /// достался бы голый `{"code":400,"message":"error"}` от API.
    #[tokio::test]
    async fn a_wrong_number_of_nameservers_never_reaches_the_network() {
        let svc = HostiqService::with_base_url("secret-token", NOWHERE);
        let one = vec!["ada.ns.cloudflare.com".to_string()];
        let text = svc
            .set_nameservers("betify2.com", &one)
            .await
            .expect_err("одного NS мало")
            .to_string();
        assert!(text.contains("at least 2"), "{text}");

        let six: Vec<String> = (1..=6).map(|i| format!("ns{i}.example.com")).collect();
        let text = svc
            .set_nameservers("betify2.com", &six)
            .await
            .expect_err("шести NS много")
            .to_string();
        assert!(text.contains("at most 5"), "{text}");
    }

    /// Пустые строки в списке — это не серверы: до гейта они доходить не должны,
    /// иначе «две штуки, одна из них пустая» уехала бы в API и вернулась голым
    /// `400`.
    #[tokio::test]
    async fn blank_entries_do_not_count_as_nameservers() {
        let svc = HostiqService::with_base_url("secret-token", NOWHERE);
        let ns = vec!["ada.ns.cloudflare.com".to_string(), "  ".to_string()];
        let text = svc
            .set_nameservers("betify2.com", &ns)
            .await
            .expect_err("пустая строка — не nameserver")
            .to_string();
        assert!(text.contains("at least 2"), "{text}");
    }

    /// Чтение NS у Hostiq невозможно, и отказ обязан быть без сети: выдуманный
    /// эндпоинт вернул бы 404, то есть соврал бы про причину.
    #[tokio::test]
    async fn get_nameservers_refuses_instead_of_inventing_an_endpoint() {
        let svc = HostiqService::with_base_url("secret-token", NOWHERE);
        let text = svc
            .get_nameservers("betify2.com")
            .await
            .expect_err("чтения NS у Hostiq нет")
            .to_string();
        assert!(text.contains("does not expose nameservers"), "{text}");
        assert!(!text.contains("127.0.0.1"), "в сеть всё-таки сходили: {text}");
    }

    /// Вложенный конверт ошибки — родная форма DI-API v3. Проверяется живым
    /// путём: разбор мог быть безупречен и при этом не позван.
    #[tokio::test]
    async fn the_nested_error_envelope_reaches_the_caller() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": {"code": 400, "message": "Syntax error"}
            })))
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let text = svc.get_domains().await.unwrap_err().to_string();
        assert!(text.contains("Hostiq error: Syntax error"), "{text}");
    }

    /// Ошибка живого пути доезжает до экрана (бейдж делегирования), поэтому
    /// чужое тело не должно доезжать вместе с ней. Тест держит именно вызов
    /// `failure_text` в `call`, а не саму функцию.
    #[tokio::test]
    async fn a_foreign_error_body_does_not_reach_the_caller() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/domain/list"))
            .respond_with(
                ResponseTemplate::new(502)
                    .set_body_string("<html><body>nginx proxy error, request id 42</body></html>"),
            )
            .mount(&srv)
            .await;

        let svc = HostiqService::with_base_url("secret-token", &srv.uri());
        let err = svc.get_domains().await.unwrap_err();
        let text = err.to_string();
        assert!(text.contains("unrecognised response (HTTP 502"), "{text}");
        assert!(!text.contains("nginx"), "{text}");
        // Токен уходит заголовком, но проверить его отсутствие дешевле, чем
        // однажды это обнаружить: текст едет в интерфейс.
        assert!(!text.contains("secret-token"), "{text}");
    }

    /// Токен приходит от человека. Символ, который в заголовок не кладётся
    /// (перевод строки из буфера обмена), обязан стать ошибкой запроса, а не
    /// паникой внутри tauri-команды — и уж точно не утечкой самого токена.
    #[tokio::test]
    async fn an_unsendable_token_becomes_an_error_not_a_panic() {
        let svc = HostiqService::with_base_url("secret\ntoken", NOWHERE);
        let text = svc.get_domains().await.unwrap_err().to_string();
        assert!(text.contains("cannot be sent"), "{text}");
        assert!(!text.contains("secret"), "токен уехал в текст ошибки: {text}");
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
        // Та же строка `error`, но объектом: конверт DI-API v3.
        assert_eq!(
            failure_text(status, r#"{"error":{"code":400,"message":"Syntax error"}}"#),
            "Hostiq error: Syntax error"
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
