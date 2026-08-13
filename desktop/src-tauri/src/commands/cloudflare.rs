//! Tauri-команды Cloudflare. Токен CF-аккаунта расшифровывается на клиенте,
//! операции идут напрямую в Cloudflare API v4. Каждая мутация пишется в
//! audit_log — best-effort, см. `creds::audit_best_effort`.

use serde::Deserialize;
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::cloudflare::client::{self, DnsRecord, DnsRecordPatch, DnsRecordPayload, Zone};
use crate::commands::auth::CommandError;
use crate::commands::creds::{audit_best_effort, blob_plaintext, cache_path, json_str};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Контекст CF-аккаунта: расшифрованный токен, CF account_id (для create_zone),
/// device_id (для audit).
///
/// Намеренно без `Debug`: `token` — это ключ ко всему аккаунту Cloudflare.
struct CfCtx {
    token: String,
    cf_account_id: Option<String>,
    device_id: Option<Uuid>,
}

/// Токен гасим в `Drop`, а не вручную по месту: контекст живёт в шести
/// командах, и в каждой между его созданием и концом функции есть `?` после
/// вызова Cloudflare — ручной `.zeroize()` в конце пропускался бы ровно на
/// ошибочных путях.
impl Drop for CfCtx {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

async fn cf_ctx(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<CfCtx, CommandError> {
    let mut key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let row = cache::get_row_fields(&conn, "cloudflare_accounts", account_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("cloudflare account not in local cache".into()))?;

    let blob_id = row
        .get("api_token_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("account has no api_token_blob_id".into()))?;
    let token_bytes = blob_plaintext(api, &key, &blob_id).await;
    // Мастер-ключ больше не нужен: дальше только HTTP в Cloudflare. Гасим до
    // разбора результата, а не после, — иначе ошибочный путь его пропустит.
    key.zeroize();
    let token_bytes = token_bytes?;
    let token =
        String::from_utf8(token_bytes).map_err(|_| CommandError::Aead("token not utf8".into()))?;

    let cf_account_id = row.get("account_id").and_then(json_str);
    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    Ok(CfCtx {
        token,
        cf_account_id,
        device_id,
    })
}

#[derive(Deserialize)]
pub struct DnsRecordInput {
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub proxied: Option<bool>,
    /// Приоритет MX/SRV/URI. Веб-путь его передаёт; десктопный до этого молча
    /// терял, и MX-запись уезжала в Cloudflare без приоритета.
    pub priority: Option<u16>,
}

#[derive(Deserialize)]
pub struct DnsRecordPatchInput {
    /// Смена типа записи. Форма редактирования во фронте её предлагает, и
    /// веб-путь её передаёт; без этого поля на десктопе она молча не работала.
    #[serde(rename = "type")]
    pub record_type: Option<String>,
    pub name: Option<String>,
    pub content: Option<String>,
    pub ttl: Option<u32>,
    pub proxied: Option<bool>,
    pub priority: Option<u16>,
}

#[tauri::command]
pub async fn cf_verify_token(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::verify_token(&ctx.token)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

/// Зоны аккаунта — вместе с их name_servers: отдельной команды под NS не надо,
/// `Zone.name_servers` приходит прямо здесь.
///
/// Аудита нет намеренно: это чтение, а audit_log в проекте пишут только
/// мутации (ср. `cf_verify_token` и `registrar_get_domains` — тоже без него).
#[tauri::command]
pub async fn cf_list_zones(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Vec<Zone>, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::list_zones(&ctx.token)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

/// DNS-записи зоны. Чтение — без аудита, см. `cf_list_zones`.
#[tauri::command]
pub async fn cf_list_dns_records(
    user_id: String,
    account_id: String,
    zone_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Vec<DnsRecord>, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::list_dns_records(&ctx.token, &zone_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

/// Действие аудита создания зоны. Оно же — ключ в `AUDIT_ACTION_LABEL` на
/// фронте («Zone created»), поэтому по нему же шлётся событие о непрошедшем
/// write-back'е `cloudflare_zone_id` (`commands::full_setup`).
pub(crate) const AUDIT_ACTION_ZONE_CREATE: &str = "cf.zone.create";

/// Завести зону домена в аккаунте — или взять уже заведённую — и записать
/// создание в audit log.
///
/// Отдельно от команды, потому что у неё два вызывающих с разными нуждами:
/// фронту (`cf_create_zone`) нужна зона, а full-setup'у — ещё и ответ на
/// вопрос, создал ли её ЭТОТ прогон (в отчёте «зона создана» и «зона уже была»
/// — разные новости). Токен при этом остаётся внутри модуля: наружу уезжает
/// только зона.
pub(crate) async fn ensure_zone(
    app: &AppHandle,
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
    zone_name: &str,
) -> Result<(Zone, bool), CommandError> {
    let ctx = cf_ctx(api, user_id, handle, account_id).await?;
    let (zone, created) = client::create_zone(&ctx.token, zone_name, ctx.cf_account_id.as_deref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    if created {
        // Зона в Cloudflare уже создана. `?` здесь отрапортовал бы неудачу об
        // удавшейся работе, а повтор упёрся бы в «zone already exists» —
        // best-effort, не превращать обратно в `?` (см. `audit_best_effort`).
        audit_best_effort(
            app,
            api,
            AUDIT_ACTION_ZONE_CREATE,
            "cloudflare_zone",
            &zone.id,
            ctx.device_id,
            Some(serde_json::json!({ "name": zone.name })),
        )
        .await;
    }
    Ok((zone, created))
}

#[tauri::command]
pub async fn cf_create_zone(
    app: AppHandle,
    user_id: String,
    account_id: String,
    zone_name: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Zone, CommandError> {
    ensure_zone(&app, &api, &user_id, &handle, &account_id, &zone_name)
        .await
        .map(|(zone, _)| zone)
}

#[tauri::command]
pub async fn cf_create_dns_record(
    app: AppHandle,
    user_id: String,
    account_id: String,
    zone_id: String,
    record: DnsRecordInput,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<DnsRecord, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let payload = DnsRecordPayload {
        record_type: record.record_type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
        priority: record.priority,
    };
    let rec = client::create_dns_record(&ctx.token, &zone_id, &payload)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    // Запись в Cloudflare уже создана: `?` из-за сбоя аудита превратил бы успех
    // в ошибку, а повтор создал бы дубль. Best-effort, не превращать в `?`.
    audit_best_effort(
        &app,
        &api,
        "cf.dns.create",
        "cloudflare_zone",
        &zone_id,
        ctx.device_id,
        Some(serde_json::json!({ "type": rec.record_type, "name": rec.name })),
    )
    .await;
    Ok(rec)
}

/// Аргументов восемь, и сгруппировать их нельзя: у Tauri-команды форма
/// параметров — это контракт с фронтом (invoke передаёт их по именам), а `app`
/// добавлен ради события о незаписанном аудите.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cf_update_dns_record(
    app: AppHandle,
    user_id: String,
    account_id: String,
    zone_id: String,
    record_id: String,
    patch: DnsRecordPatchInput,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<DnsRecord, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let p = DnsRecordPatch {
        record_type: patch.record_type,
        name: patch.name,
        content: patch.content,
        ttl: patch.ttl,
        proxied: patch.proxied,
        priority: patch.priority,
    };
    let rec = client::update_dns_record(&ctx.token, &zone_id, &record_id, &p)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    // Запись в Cloudflare уже изменена: `?` из-за сбоя аудита показал бы
    // пользователю ошибку на удавшейся правке. Best-effort, не превращать в `?`.
    audit_best_effort(
        &app,
        &api,
        "cf.dns.update",
        "cloudflare_zone",
        &zone_id,
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await;
    Ok(rec)
}

#[tauri::command]
pub async fn cf_delete_dns_record(
    app: AppHandle,
    user_id: String,
    account_id: String,
    zone_id: String,
    record_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::delete_dns_record(&ctx.token, &zone_id, &record_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    // Самый наглядный случай, ради которого аудит здесь best-effort: записи в
    // Cloudflare уже нет. `?` вернул бы `Err` на удавшемся удалении,
    // пользователь повторил бы его и получил 404 — а в аудите так ничего и не
    // появилось бы. Не превращать обратно в `?`.
    audit_best_effort(
        &app,
        &api,
        "cf.dns.delete",
        "cloudflare_zone",
        &zone_id,
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn cf_purge_cache(
    app: AppHandle,
    user_id: String,
    account_id: String,
    zone_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::purge_cache(&ctx.token, &zone_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    // Кэш уже сброшен, откатить это нельзя. Best-effort, не превращать в `?`.
    audit_best_effort(
        &app,
        &api,
        "cf.cache_purge",
        "cloudflare_zone",
        &zone_id,
        ctx.device_id,
        None,
    )
    .await;
    Ok(())
}
