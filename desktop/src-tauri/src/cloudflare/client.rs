//! Cloudflare API v4 client (token-only).

use http::Method;
use reqwest::Client;
use serde::{Deserialize, Serialize};

const CF_API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, thiserror::Error)]
pub enum CloudflareError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("cloudflare api: {0}")]
    Api(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn http_client() -> Client {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("reqwest")
}

async fn call_with_base(
    api_base: &str,
    token: &str,
    method: Method,
    path: &str,
    params: Option<Vec<(String, String)>>,
    json_body: Option<serde_json::Value>,
) -> Result<serde_json::Value, CloudflareError> {
    let url = format!(
        "{}/{}",
        api_base.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let mut req = http_client()
        .request(method, &url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json");
    if let Some(p) = params {
        let q: Vec<(&str, &str)> = p.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        req = req.query(&q);
    }
    if let Some(j) = json_body {
        req = req.json(&j);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    let data: serde_json::Value = if text.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text)?
    };
    let success = data.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
    if status.as_u16() >= 400 || !success {
        let errors = data
            .get("errors")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([{"message": text}]));
        return Err(CloudflareError::Api(errors.to_string()));
    }
    Ok(data)
}

pub async fn call(
    token: &str,
    method: Method,
    path: &str,
    params: Option<Vec<(String, String)>>,
    json_body: Option<serde_json::Value>,
) -> Result<serde_json::Value, CloudflareError> {
    call_with_base(CF_API, token, method, path, params, json_body).await
}

pub async fn verify_token(token: &str) -> Result<bool, CloudflareError> {
    let v = call(token, Method::GET, "/user/tokens/verify", None, None).await?;
    let ok = v
        .get("result")
        .and_then(|r| r.get("status"))
        .and_then(|s| s.as_str())
        .map(|s| s == "active")
        .unwrap_or(true);
    Ok(ok)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub name_servers: Option<Vec<String>>,
    /// Статус делегирования у Cloudflare (`active`/`pending`/`moved`). Приходит
    /// в том же ответе `/zones`, что и всё остальное, — не читать его значило
    /// показывать пользователю уверенное «Unknown» вместо ответа, который у нас
    /// уже на руках.
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn list_zones(token: &str) -> Result<Vec<Zone>, CloudflareError> {
    list_zones_with_base(CF_API, token).await
}

async fn list_zones_with_base(api_base: &str, token: &str) -> Result<Vec<Zone>, CloudflareError> {
    let mut all = Vec::new();
    let mut page = 1u32;
    loop {
        let params = vec![
            ("per_page".into(), "50".into()),
            ("page".into(), page.to_string()),
        ];
        let data = call_with_base(api_base, token, Method::GET, "/zones", Some(params), None).await?;
        let rows: Vec<Zone> = serde_json::from_value(
            data.get("result")
                .cloned()
                .unwrap_or(serde_json::json!([])),
        )
        .unwrap_or_default();
        all.extend(rows);
        let total_pages = data
            .get("result_info")
            .and_then(|i| i.get("total_pages"))
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        if page as u64 >= total_pages {
            break;
        }
        page += 1;
    }
    Ok(all)
}

pub async fn get_zone(token: &str, zone_id: &str) -> Result<Zone, CloudflareError> {
    let data = call(
        token,
        Method::GET,
        &format!("/zones/{zone_id}"),
        None,
        None,
    )
    .await?;
    Ok(serde_json::from_value(
        data.get("result").cloned().unwrap_or(serde_json::json!({})),
    )?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub ttl: Option<u32>,
    #[serde(default)]
    pub proxied: bool,
    #[serde(default)]
    pub zone_id: Option<String>,
    /// Приоритет MX/SRV/URI: у остальных типов Cloudflare поля не отдаёт вовсе.
    /// Во фронт едет как есть (`null` там, где приоритета нет) — так же, как
    /// соседние `ttl` и `zone_id`: форма правки различает «нет значения» и
    /// «значение 0» по самому значению, а не по наличию ключа.
    #[serde(default)]
    pub priority: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DnsRecordPayload {
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxied: Option<bool>,
    /// Приоритет MX/SRV/URI. У Cloudflare это целое 0..=65535, поэтому `u16`;
    /// для остальных типов записи поле не шлём вовсе — иначе API ругается.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
}

/// Все записи зоны. Страницы обязательны: у зоны их бывают сотни, а обрезка по
/// первой сотне не выглядит обрезкой — пользователь просто не находит запись и
/// заводит дубль. Цикл тот же, что в `list_zones`.
pub async fn list_dns_records(
    token: &str,
    zone_id: &str,
) -> Result<Vec<DnsRecord>, CloudflareError> {
    list_dns_records_with_base(CF_API, token, zone_id).await
}

async fn list_dns_records_with_base(
    api_base: &str,
    token: &str,
    zone_id: &str,
) -> Result<Vec<DnsRecord>, CloudflareError> {
    let mut all = Vec::new();
    let mut page = 1u32;
    loop {
        let params = vec![
            ("per_page".into(), "100".into()),
            ("page".into(), page.to_string()),
        ];
        let data = call_with_base(
            api_base,
            token,
            Method::GET,
            &format!("/zones/{zone_id}/dns_records"),
            Some(params),
            None,
        )
        .await?;
        let rows: Vec<DnsRecord> = serde_json::from_value(
            data.get("result")
                .cloned()
                .unwrap_or(serde_json::json!([])),
        )
        .unwrap_or_default();
        all.extend(rows);
        let total_pages = data
            .get("result_info")
            .and_then(|i| i.get("total_pages"))
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        if page as u64 >= total_pages {
            break;
        }
        page += 1;
    }
    Ok(all)
}

pub async fn create_dns_record(
    token: &str,
    zone_id: &str,
    payload: &DnsRecordPayload,
) -> Result<DnsRecord, CloudflareError> {
    let params = vec![
        ("type".into(), payload.record_type.clone()),
        ("name".into(), payload.name.clone()),
        ("per_page".into(), "1".into()),
    ];
    let existing = call(
        token,
        Method::GET,
        &format!("/zones/{zone_id}/dns_records"),
        Some(params),
        None,
    )
    .await?;
    if let Some(arr) = existing.get("result").and_then(|v| v.as_array()) {
        if let Some(first) = arr.first() {
            if let Some(rid) = first.get("id").and_then(|v| v.as_str()) {
                let data = call(
                    token,
                    Method::PATCH,
                    &format!("/zones/{zone_id}/dns_records/{rid}"),
                    None,
                    Some(serde_json::to_value(payload)?),
                )
                .await?;
                return Ok(serde_json::from_value(
                    data.get("result").cloned().unwrap_or(serde_json::json!({})),
                )?);
            }
        }
    }
    let data = call(
        token,
        Method::POST,
        &format!("/zones/{zone_id}/dns_records"),
        None,
        Some(serde_json::to_value(payload)?),
    )
    .await?;
    Ok(serde_json::from_value(
        data.get("result").cloned().unwrap_or(serde_json::json!({})),
    )?)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DnsRecordPatch {
    /// Тип записи (A/CNAME/MX/...). Cloudflare разрешает менять его через PATCH,
    /// и форма редактирования во фронте это предлагает; без поля смена типа
    /// молча не доезжала до API.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub record_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxied: Option<bool>,
    /// Приоритет MX/SRV/URI — см. `DnsRecordPayload::priority`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
}

pub async fn update_dns_record(
    token: &str,
    zone_id: &str,
    record_id: &str,
    patch: &DnsRecordPatch,
) -> Result<DnsRecord, CloudflareError> {
    let data = call(
        token,
        Method::PATCH,
        &format!("/zones/{zone_id}/dns_records/{record_id}"),
        None,
        Some(serde_json::to_value(patch)?),
    )
    .await?;
    Ok(serde_json::from_value(
        data.get("result").cloned().unwrap_or(serde_json::json!({})),
    )?)
}

pub async fn delete_dns_record(
    token: &str,
    zone_id: &str,
    record_id: &str,
) -> Result<(), CloudflareError> {
    call(
        token,
        Method::DELETE,
        &format!("/zones/{zone_id}/dns_records/{record_id}"),
        None,
        None,
    )
    .await?;
    Ok(())
}

pub async fn purge_cache(token: &str, zone_id: &str) -> Result<(), CloudflareError> {
    call(
        token,
        Method::POST,
        &format!("/zones/{zone_id}/purge_cache"),
        None,
        Some(serde_json::json!({"purge_everything": true})),
    )
    .await?;
    Ok(())
}

/// Завести зону — или вернуть уже заведённую. `bool` в ответе: `true` — зону
/// создал этот вызов, `false` — она была раньше.
///
/// Флаг существует не для красоты отчёта: за `true` вызывающий пишет строчку
/// `cf.zone.create` в audit log, и на переиспользованной зоне она врала бы
/// истории.
pub async fn create_zone(
    token: &str,
    zone_name: &str,
    cf_account_id: Option<&str>,
) -> Result<(Zone, bool), CloudflareError> {
    create_zone_with_base(CF_API, token, zone_name, cf_account_id).await
}

async fn create_zone_with_base(
    api_base: &str,
    token: &str,
    zone_name: &str,
    cf_account_id: Option<&str>,
) -> Result<(Zone, bool), CloudflareError> {
    let mut body = serde_json::json!({ "name": zone_name.trim() });
    if let Some(aid) = cf_account_id.filter(|s| !s.is_empty()) {
        body["account"] = serde_json::json!({ "id": aid });
    }
    match call_with_base(api_base, token, Method::POST, "/zones", None, Some(body)).await {
        Ok(data) => {
            let z: Zone = serde_json::from_value(
                data.get("result").cloned().unwrap_or(serde_json::json!({})),
            )?;
            Ok((z, true))
        }
        Err(CloudflareError::Api(e)) => {
            let low = e.to_lowercase();
            if low.contains("1061")
                || low.contains("already exists")
                || low.contains("duplicate")
                || low.contains("already been added")
            {
                if let Some(z) = get_zone_by_name_with_base(api_base, token, zone_name).await? {
                    return Ok((z, false));
                }
            }
            Err(CloudflareError::Api(e))
        }
        Err(e) => Err(e),
    }
}

async fn get_zone_by_name_with_base(
    api_base: &str,
    token: &str,
    zone_name: &str,
) -> Result<Option<Zone>, CloudflareError> {
    let name = zone_name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let params = vec![
        ("name".into(), name.to_string()),
        ("per_page".into(), "50".into()),
        ("page".into(), "1".into()),
    ];
    let data = call_with_base(api_base, token, Method::GET, "/zones", Some(params), None).await?;
    let rows: Vec<Zone> = serde_json::from_value(
        data.get("result")
            .cloned()
            .unwrap_or(serde_json::json!([])),
    )
    .unwrap_or_default();
    Ok(rows
        .into_iter()
        .find(|z| z.name.trim().to_lowercase() == name.to_lowercase()))
}

pub async fn get_nameservers(token: &str, zone_id: &str) -> Result<Vec<String>, CloudflareError> {
    let z = get_zone(token, zone_id).await?;
    Ok(z.name_servers.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// `status` — ответ Cloudflare на «доехало ли делегирование NS». Он лежит в
    /// том же JSON, что и всё остальное; пока структура его не читала, UI
    /// показывал уверенное «Unknown» вместо этого ответа.
    #[test]
    fn zone_keeps_status_and_survives_its_absence() {
        let z: Zone = serde_json::from_value(serde_json::json!({
            "id": "z1",
            "name": "example.com",
            "status": "pending",
            "name_servers": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        }))
        .unwrap();
        assert_eq!(z.status.as_deref(), Some("pending"));
        assert_eq!(z.name_servers.unwrap().len(), 2);

        let bare: Zone =
            serde_json::from_value(serde_json::json!({"id": "z2", "name": "x"})).unwrap();
        assert!(bare.status.is_none());
    }

    /// Мокает `pages` страниц по одной строке на каждой. `per_page` в матчере
    /// не для красоты: если размер страницы перестанет уезжать в запрос, ни
    /// один mock не подойдёт и тест упадёт.
    async fn mount_pages(
        srv: &MockServer,
        api_path: &str,
        per_page: &str,
        pages: u32,
        row: impl Fn(u32) -> serde_json::Value,
    ) {
        for p in 1..=pages {
            Mock::given(method("GET"))
                .and(path(api_path))
                .and(query_param("per_page", per_page))
                .and(query_param("page", p.to_string()))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "success": true,
                    "result": [row(p)],
                    "result_info": {"total_pages": pages}
                })))
                .mount(srv)
                .await;
        }
    }

    /// Одна страница и ни одного лишнего запроса: `result_info` в ответе нет,
    /// и это не повод уйти в бесконечный цикл. `.expect(1)` проверяется в Drop.
    async fn mount_single_page_without_result_info(
        srv: &MockServer,
        api_path: &str,
        row: serde_json::Value,
    ) {
        Mock::given(method("GET"))
            .and(path(api_path))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": [row]
            })))
            .expect(1)
            .mount(srv)
            .await;
    }

    fn dns_row(p: u32) -> serde_json::Value {
        serde_json::json!({"id": format!("r{p}"), "type": "A", "name": format!("n{p}"), "content": "1.1.1.1"})
    }

    fn zone_row(p: u32) -> serde_json::Value {
        serde_json::json!({"id": format!("z{p}"), "name": format!("d{p}.com"), "status": "active"})
    }

    /// Зона на несколько страниц: без цикла редактор показал бы первую сотню
    /// записей под уверенным заголовком «DNS Records (100)», и пользователь,
    /// не найдя запись, завёл бы дубль.
    #[tokio::test]
    async fn list_dns_records_walks_all_pages() {
        let srv = MockServer::start().await;
        mount_pages(&srv, "/client/v4/zones/z1/dns_records", "100", 3, dns_row).await;

        let base = format!("{}/client/v4", srv.uri());
        let recs = list_dns_records_with_base(&base, "t", "z1").await.unwrap();
        let ids: Vec<&str> = recs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["r1", "r2", "r3"]);
    }

    #[tokio::test]
    async fn list_dns_records_stops_without_result_info() {
        let srv = MockServer::start().await;
        mount_single_page_without_result_info(&srv, "/client/v4/zones/z1/dns_records", dns_row(1))
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let recs = list_dns_records_with_base(&base, "t", "z1").await.unwrap();
        assert_eq!(recs.len(), 1);
    }

    /// Тот же цикл, что и у записей, — и до сих пор без единого теста под ним.
    /// У аккаунта с сотней доменов вторая страница зон так же обязательна.
    #[tokio::test]
    async fn list_zones_walks_all_pages() {
        let srv = MockServer::start().await;
        mount_pages(&srv, "/client/v4/zones", "50", 3, zone_row).await;

        let base = format!("{}/client/v4", srv.uri());
        let zones = list_zones_with_base(&base, "t").await.unwrap();
        let ids: Vec<&str> = zones.iter().map(|z| z.id.as_str()).collect();
        assert_eq!(ids, vec!["z1", "z2", "z3"]);
        assert_eq!(zones[0].status.as_deref(), Some("active"));
    }

    #[tokio::test]
    async fn list_zones_stops_without_result_info() {
        let srv = MockServer::start().await;
        mount_single_page_without_result_info(&srv, "/client/v4/zones", zone_row(1)).await;

        let base = format!("{}/client/v4", srv.uri());
        let zones = list_zones_with_base(&base, "t").await.unwrap();
        assert_eq!(zones.len(), 1);
    }

    /// Ответ Cloudflare на попытку завести зону, которая в аккаунте уже есть.
    /// Код 1061 — его собственный; HTTP при этом 400.
    fn zone_already_exists() -> ResponseTemplate {
        ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "success": false,
            "errors": [{"code": 1061, "message": "zone already exists"}],
            "result": null
        }))
    }

    #[tokio::test]
    async fn create_zone_reports_a_fresh_zone_as_created() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/client/v4/zones"))
            // Аккаунт обязан доехать в теле: без него Cloudflare заводит зону в
            // аккаунте по умолчанию — то есть не в том, что выбрал пользователь.
            .and(body_partial_json(
                serde_json::json!({"name": "example.com", "account": {"id": "acc-1"}}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": {"id": "z1", "name": "example.com", "status": "pending",
                           "name_servers": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]}
            })))
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let (zone, created) = create_zone_with_base(&base, "t", " example.com ", Some("acc-1"))
            .await
            .unwrap();
        assert!(created, "новую зону обязаны назвать созданной: за этот флаг пишется аудит");
        assert_eq!(zone.id, "z1");
        assert_eq!(zone.name_servers.unwrap().len(), 2);
    }

    /// Повтор full-setup по тому же домену обязан переиспользовать зону, а не
    /// уронить прогон: Cloudflare отвечает 1061, и зона ищется по имени.
    #[tokio::test]
    async fn create_zone_reuses_an_existing_zone_instead_of_failing() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/client/v4/zones"))
            .respond_with(zone_already_exists())
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/client/v4/zones"))
            .and(query_param("name", "example.com"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                // Cloudflare фильтрует по имени сам, но ответ может содержать и
                // соседние зоны: берём ту, у которой имя совпало.
                "result": [
                    {"id": "z-other", "name": "other.com"},
                    {"id": "z1", "name": "Example.COM", "status": "active",
                     "name_servers": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]}
                ]
            })))
            .expect(1)
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let (zone, created) = create_zone_with_base(&base, "t", "example.com", Some("acc-1"))
            .await
            .unwrap();
        assert!(!created, "зона была раньше — это не создание");
        assert_eq!(zone.id, "z1");
    }

    /// Зона занята вне видимости токена (чужой аккаунт Cloudflare): поиск по
    /// имени ничего не находит, и отказ обязан дойти до пользователя как отказ.
    /// Тихое «переиспользовали» тут было бы худшим из исходов — домен считался
    /// бы настроенным без единой зоны.
    #[tokio::test]
    async fn create_zone_surfaces_the_refusal_when_the_zone_is_not_ours() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/client/v4/zones"))
            .respond_with(zone_already_exists())
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/client/v4/zones"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": []
            })))
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let err = create_zone_with_base(&base, "t", "example.com", None)
            .await
            .unwrap_err();
        assert!(matches!(&err, CloudflareError::Api(m) if m.contains("1061")), "{err}");
    }

    /// Отказ не про существующую зону (нет прав у токена) поиском по имени не
    /// лечится, и лишнего запроса за ним быть не должно — `.expect(0)`.
    #[tokio::test]
    async fn create_zone_does_not_search_after_an_unrelated_refusal() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/client/v4/zones"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "success": false,
                "errors": [{"code": 9109, "message": "Unauthorized to access requested resource"}]
            })))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/client/v4/zones"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let err = create_zone_with_base(&base, "t", "example.com", None)
            .await
            .unwrap_err();
        assert!(matches!(&err, CloudflareError::Api(m) if m.contains("9109")), "{err}");
    }

    #[tokio::test]
    async fn verify_token_request() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/client/v4/user/tokens/verify"))
            .and(header("Authorization", "Bearer secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": { "status": "active" }
            })))
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let v = call_with_base(
            &base,
            "secret",
            Method::GET,
            "/user/tokens/verify",
            None,
            None,
        )
        .await
        .unwrap();
        assert!(v.get("success").and_then(|x| x.as_bool()).unwrap());
    }

    #[tokio::test]
    async fn dns_upsert_uses_patch_when_exists() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/client/v4/zones/z1/dns_records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": [{"id": "rec1", "type": "A", "name": "x", "content": "1.1.1.1"}]
            })))
            .mount(&srv)
            .await;
        // Матчер перечисляет все поля payload'а, которые обязаны доехать до CF:
        // если любое перестанет сериализоваться, ни один mock не подойдёт,
        // сервер ответит 404 и тест упадёт.
        Mock::given(method("PATCH"))
            .and(path("/client/v4/zones/z1/dns_records/rec1"))
            .and(body_partial_json(serde_json::json!({
                "type": "MX",
                "name": "x",
                "content": "2.2.2.2",
                "proxied": true,
                "priority": 10,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": {"id": "rec1", "type": "MX", "name": "x", "content": "2.2.2.2"}
            })))
            .mount(&srv)
            .await;

        let base = format!("{}/client/v4", srv.uri());
        let p = DnsRecordPayload {
            record_type: "MX".into(),
            name: "x".into(),
            content: "2.2.2.2".into(),
            ttl: None,
            proxied: Some(true),
            priority: Some(10),
        };
        // create_dns_record uses global CF_API — test local helper path by duplicating logic slice:
        let params = vec![
            ("type".into(), p.record_type.clone()),
            ("name".into(), p.name.clone()),
            ("per_page".into(), "1".into()),
        ];
        let existing = call_with_base(
            &base,
            "t",
            Method::GET,
            "/zones/z1/dns_records",
            Some(params),
            None,
        )
        .await
        .unwrap();
        let rid = existing["result"][0]["id"].as_str().unwrap();
        let data = call_with_base(
            &base,
            "t",
            Method::PATCH,
            &format!("/zones/z1/dns_records/{rid}"),
            None,
            Some(serde_json::to_value(&p).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(data["result"]["content"], "2.2.2.2");
    }

    // Смена типа записи (A → MX и обратно) и приоритет MX обязаны доехать до
    // Cloudflare: форма редактирования во фронте предлагает и то, и другое.
    // Матчер здесь — тот же приём, что и в тесте выше: не совпало тело —
    // сервер отвечает 404, и `unwrap` падает.
    #[tokio::test]
    async fn dns_patch_sends_type_and_priority() {
        let srv = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/client/v4/zones/z1/dns_records/rec1"))
            .and(body_partial_json(serde_json::json!({
                "type": "MX",
                "content": "mail.example.com",
                "priority": 20,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "result": {"id": "rec1", "type": "MX", "name": "x", "content": "mail.example.com"}
            })))
            .mount(&srv)
            .await;

        let patch = DnsRecordPatch {
            record_type: Some("MX".into()),
            content: Some("mail.example.com".into()),
            priority: Some(20),
            ..Default::default()
        };
        let base = format!("{}/client/v4", srv.uri());
        let data = call_with_base(
            &base,
            "t",
            Method::PATCH,
            "/zones/z1/dns_records/rec1",
            None,
            Some(serde_json::to_value(&patch).unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(data["result"]["type"], "MX");
    }

    #[test]
    fn dns_record_payload_omits_proxied_when_none() {
        let p = DnsRecordPayload {
            record_type: "A".into(),
            name: "x".into(),
            content: "1.1.1.1".into(),
            ttl: None,
            proxied: None,
            priority: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(!v.as_object().unwrap().contains_key("proxied"));
        // priority шлём только для MX/SRV/URI: для A-записи Cloudflare на него
        // отвечает ошибкой, поэтому пустое поле обязано исчезать из тела.
        assert!(!v.as_object().unwrap().contains_key("priority"));
    }

    #[test]
    fn dns_record_patch_serializes_proxied_when_set() {
        let p = DnsRecordPatch {
            proxied: Some(false),
            ..Default::default()
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["proxied"], false);
        assert!(!v.as_object().unwrap().contains_key("name"));
        // PATCH в Cloudflare — частичный: незаданный тип не должен превращаться
        // в `null` и перетирать реальный тип записи.
        assert!(!v.as_object().unwrap().contains_key("type"));
        assert!(!v.as_object().unwrap().contains_key("priority"));
    }

    #[test]
    fn dns_record_deserializes_proxied_and_zone_id() {
        let raw = serde_json::json!({
            "id": "rec1",
            "type": "A",
            "name": "x",
            "content": "1.1.1.1",
            "ttl": 1,
            "proxied": true,
            "zone_id": "zone123"
        });
        let rec: DnsRecord = serde_json::from_value(raw).unwrap();
        assert!(rec.proxied);
        assert_eq!(rec.zone_id.as_deref(), Some("zone123"));
    }

    // Приоритет Cloudflare отдаёт только у MX/SRV/URI. Пока структура его не
    // читала, форма правки открывала MX с пустым полем — и приоритет терялся
    // при первом же сохранении. Запись без поля обязана разбираться по-прежнему.
    #[test]
    fn dns_record_priority_roundtrip() {
        let mx: DnsRecord = serde_json::from_value(serde_json::json!({
            "id": "rec1",
            "type": "MX",
            "name": "x",
            "content": "mail.example.com",
            "ttl": 1,
            "proxied": false,
            "zone_id": "zone123",
            "priority": 20
        }))
        .unwrap();
        assert_eq!(mx.priority, Some(20));

        let a: DnsRecord = serde_json::from_value(serde_json::json!({
            "id": "rec2",
            "type": "A",
            "name": "x",
            "content": "1.1.1.1"
        }))
        .unwrap();
        assert_eq!(a.priority, None);
        // Во фронт ключ едет всегда: TS-тип объявляет `priority: number | null`,
        // и пропажа ключа сделала бы это объявление ложным.
        let json = serde_json::to_value(&a).unwrap();
        assert!(json.as_object().unwrap().contains_key("priority"));
        assert!(json["priority"].is_null());
    }
}
