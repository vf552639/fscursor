# Спринт 1 — Ядро исполнения: план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОД-НАВЫК — используй
> `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`,
> чтобы выполнять план задача-за-задачей. Шаги отмечены чекбоксами (`- [ ]`).

**Goal:** desktop-приложение SDMP выполняет полный цикл provisioning из UI (Cloudflare/registrar
операции, установка FastPanel, site+FTP+SSL с опциональной БД), каждое исполнительное действие
пишется в audit_log, а Dashboard показывает реальные данные вместо заглушек.

**Architecture:** все execute-действия — Tauri-команды в Rust. Секреты (CF-токен, registrar-ключ,
SSH-пароль) лежат на сервере как зашифрованные blob'ы; команда грузит master-key из OS-keychain,
открывает зашифрованный локальный кэш (SQLCipher), читает строку сущности, расшифровывает нужный
blob и вызывает готовый Rust-клиент. После операции — `api.audit_log(...)` (session-cookie,
без плейнтекст-секретов в metadata). Веб-хуки остаются как fallback: мутации идут в Tauri, только
если `isTauri()`.

**Tech Stack:** Rust (Tauri 2, reqwest, russh, dryoc, rusqlite+sqlcipher), TypeScript/React 18 +
TanStack Query, Python 3.12 (FastAPI, pytest), vitest.

---

## Контекст и решения (зафиксировано с пользователем)

- **SSL email** → fallback на `users.email` аккаунта. В Rust берётся через уже существующий
  `ApiClient::me()` (`desktop/src-tauri/src/sync/http.rs:235`), возвращающий `{ id, email }`.
  Новых полей/ключей в backend не заводим.
- **Provision по умолчанию** = site + FTP + SSL. SSL выпускается только после успешной проверки
  `fastpanel::dns_resolves_to` (иначе шаг пропускается с предупреждением, весь provision не падает).
  Создание БД — опционально, по флагу `with_db`.
- **Объём** — только Спринт 1 (5 блоков). Планы для спринтов 2–5 будут отдельными файлами.

## Философия тестирования (важно прочитать до старта)

Кодовая база уже задаёт паттерн: чистые функции → `cargo test`/`vitest`/`pytest`; HTTP-клиенты →
wiremock (см. `sync/http.rs` tests, `cloudflare/client.rs` tests); Tauri-команды-оркестраторы,
которым нужен реальный OS-keychain, SSH или живой API — **не** покрываются unit-тестами (их нельзя
честно замокать), а проверяются через `cargo test` (компиляция + существующие тесты остаются
зелёными) + ручной чек-лист на тестовом сервере.

Поэтому в плане: где есть чистая логика (парсинг вывода инсталлятора, выбор команды обновления ОС,
мапперы Dashboard, набор audit-действий) — пишем настоящие тесты по TDD. Где команда — тонкая
обёртка над уже протестированным клиентом — тест не выдумываем, а даём конкретный шаг ручной
проверки. Это осознанное следование паттернам репозитория, а не пропуск тестов.

Базовые команды прогонки:
- Rust: `cd desktop/src-tauri && cargo test`
- Frontend: `cd frontend && npx vitest run <путь>`
- Backend: `cd backend && python3.12 -m pytest tests/<файл> -v`

---

## File Structure

**Создаются:**
- `desktop/src-tauri/src/commands/creds.rs` — общие helper'ы (`blob_plaintext`, `json_str`,
  `json_i64`, `cache_path`) для всех команд, работающих с blob'ами/кэшем.
- `desktop/src-tauri/src/commands/cloudflare.rs` — Tauri-команды Cloudflare (DNS CRUD, purge,
  create_zone, verify_token).
- `desktop/src-tauri/src/commands/registrars.rs` — Tauri-команды registrar (test, get_domains,
  set_nameservers).
- `frontend/src/pages/dashboardData.ts` + `.test.ts` — чистые мапперы Dashboard (метрики сервера,
  строки активности) с тестами.
- `backend/tests/test_audit_actions.py` — тест набора `SAFE_ACTIONS`.

**Модифицируются:**
- `backend/app/audit/service.py` — добавить исполнительные действия в `SAFE_ACTIONS`.
- `desktop/src-tauri/src/commands/mod.rs` — объявить новые модули.
- `desktop/src-tauri/src/lib.rs` — зарегистрировать новые команды в `generate_handler!`.
- `desktop/src-tauri/src/commands/provision.rs` — вынести helper'ы в `creds`; реализовать
  `install_fastpanel`; достроить `run_provision_domain` (SSL + опц. БД); расширить
  `ProvisionResultOut`.
- `desktop/src-tauri/src/provision/fastpanel_install.rs` — чистые helper'ы порта легаси-инсталла.
- `frontend/src/api/cloudflare.ts`, `frontend/src/api/registrars.ts`, `frontend/src/api/domains.ts`
  — мутации через Tauri при `isTauri()`.
- `frontend/src/lib/deepLink.ts` — передать `userId` в `install_fastpanel`.
- `frontend/src/pages/Dashboard.tsx` — реальные данные вместо захардкоженных нулей и пустой
  активности.

---

## Task 1: Backend — audit-действия для исполнительных мутаций

**Files:**
- Test: `backend/tests/test_audit_actions.py`
- Modify: `backend/app/audit/service.py:8-31`

- [x] **Step 1: Написать падающий тест**

Создать `backend/tests/test_audit_actions.py`:

```python
from app.audit.service import SAFE_ACTIONS

EXECUTIVE_ACTIONS = [
    "cf.zone.create",
    "cf.dns.create",
    "cf.dns.update",
    "cf.dns.delete",
    "cf.cache_purge",
    "registrar.ns_set",
    "server.fastpanel_install",
]


def test_executive_actions_are_in_safe_actions():
    for action in EXECUTIVE_ACTIONS:
        assert action in SAFE_ACTIONS, f"{action} must be allow-listed"


def test_device_action_complete_still_present():
    # provision продолжает логироваться под этим действием
    assert "device.action.complete" in SAFE_ACTIONS
```

- [x] **Step 2: Прогнать тест — убедиться, что падает**

Run: `cd backend && python3.12 -m pytest tests/test_audit_actions.py -v`
Expected: FAIL — новые действия отсутствуют в `SAFE_ACTIONS`.

- [x] **Step 3: Добавить действия в `SAFE_ACTIONS`**

В `backend/app/audit/service.py` внутрь `frozenset({...})` (после строки `"registrar.account.delete",`,
строка 21) добавить:

```python
        "cf.zone.create",
        "cf.dns.create",
        "cf.dns.update",
        "cf.dns.delete",
        "cf.cache_purge",
        "registrar.ns_set",
        "server.fastpanel_install",
```

- [x] **Step 4: Прогнать тест — убедиться, что проходит**

Run: `cd backend && python3.12 -m pytest tests/test_audit_actions.py -v`
Expected: PASS (2 passed).

- [x] **Step 5: Коммит**

```bash
git add backend/app/audit/service.py backend/tests/test_audit_actions.py
git commit -m "feat(audit): allow-list executive actions (cf/registrar/fastpanel)"
```

---

## Task 2: Общие helper'ы команд (`commands/creds.rs`) + рефактор provision

Цель: убрать дублирование `blob_plaintext`/`json_str`/`json_i64` и дать новым командам общий доступ
к расшифровке blob'ов и пути кэша.

**Files:**
- Create: `desktop/src-tauri/src/commands/creds.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs:1-6`
- Modify: `desktop/src-tauri/src/commands/provision.rs:1-42` (импорты + удаление локальных helper'ов)

- [x] **Step 1: Создать `desktop/src-tauri/src/commands/creds.rs`**

```rust
//! Общие helper'ы для Tauri-команд: расшифровка blob'ов и доступ к локальному кэшу.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

use crate::commands::auth::CommandError;
use crate::commands::sync_cmd::SyncHandle;
use crate::crypto::aead;
use crate::sync::http::ApiClient;

/// Забрать зашифрованный blob по id и расшифровать его master-key'ом.
pub(crate) async fn blob_plaintext(
    api: &ApiClient,
    key: &[u8; 32],
    blob_id: &str,
) -> Result<Vec<u8>, CommandError> {
    let blob = api
        .blob_get(blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    aead::decrypt(&raw, key).map_err(|e| CommandError::Aead(e.to_string()))
}

pub(crate) fn json_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

pub(crate) fn json_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))
}

/// Путь к локальному кэшу из инициализированного `SyncHandle`.
pub(crate) fn cache_path(handle: &State<'_, SyncHandle>) -> Result<PathBuf, CommandError> {
    let g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
    let c = g
        .as_ref()
        .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
    Ok(c.cache_path.clone())
}
```

- [x] **Step 2: Объявить модуль в `commands/mod.rs`**

`desktop/src-tauri/src/commands/mod.rs` — добавить строку (в алфавитном порядке, после `pub mod auth;`):

```rust
pub mod creds;
```

- [x] **Step 3: Рефактор `provision.rs` — использовать общие helper'ы**

В `desktop/src-tauri/src/commands/provision.rs`:

1. Удалить локальные определения `blob_plaintext` (строки 25-34), `json_str` (36-38),
   `json_i64` (40-42).
2. В блок импортов (после строки 16) добавить:

```rust
use crate::commands::creds::{blob_plaintext, cache_path, json_i64, json_str};
```

3. Удалить ставшие ненужными импорты из шапки: строку 3
   `use base64::{engine::general_purpose::STANDARD as B64, Engine};` и `use crate::crypto::aead;`
   (строка 11) — они больше не используются в этом файле.
4. В `provision_domain` (строки 190-196) и `provision_bulk` (209-215) заменить ручное
   получение `cache_path` из `handle` на общий helper:

```rust
    let cache_path = cache_path(&handle)?;
```

- [x] **Step 4: Прогнать тесты — убедиться, что всё зелёное**

Run: `cd desktop/src-tauri && cargo test`
Expected: компилируется, PASS (24 passed, 1 ignored — как до рефактора).

- [x] **Step 5: Коммит**

```bash
git add desktop/src-tauri/src/commands/creds.rs desktop/src-tauri/src/commands/mod.rs desktop/src-tauri/src/commands/provision.rs
git commit -m "refactor(desktop): extract shared cache/blob helpers into commands::creds"
```

---

## Task 3: Tauri-команды Cloudflare

**Files:**
- Create: `desktop/src-tauri/src/commands/cloudflare.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs:33-49` (generate_handler)

- [x] **Step 1: Создать `desktop/src-tauri/src/commands/cloudflare.rs`**

```rust
//! Tauri-команды Cloudflare. Токен CF-аккаунта расшифровывается на клиенте,
//! операции идут напрямую в Cloudflare API v4. Каждая мутация пишется в audit_log.

use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::cloudflare::client::{self, DnsRecord, DnsRecordPatch, DnsRecordPayload, Zone};
use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_str};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Контекст CF-аккаунта: расшифрованный токен, CF account_id (для create_zone),
/// device_id (для audit).
struct CfCtx {
    token: String,
    cf_account_id: Option<String>,
    device_id: Option<Uuid>,
}

async fn cf_ctx(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<CfCtx, CommandError> {
    let key = keychain::load_master_key(user_id)
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
    let token_bytes = blob_plaintext(api, &key, &blob_id).await?;
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
}

#[derive(Deserialize)]
pub struct DnsRecordPatchInput {
    pub name: Option<String>,
    pub content: Option<String>,
    pub ttl: Option<u32>,
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

#[tauri::command]
pub async fn cf_create_zone(
    user_id: String,
    account_id: String,
    zone_name: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Zone, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let (zone, created) = client::create_zone(&ctx.token, &zone_name, ctx.cf_account_id.as_deref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    if created {
        api.audit_log(
            "cf.zone.create",
            Some("cloudflare_zone"),
            Some(&zone.id),
            ctx.device_id,
            Some(serde_json::json!({ "name": zone.name })),
        )
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    }
    Ok(zone)
}

#[tauri::command]
pub async fn cf_create_dns_record(
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
    };
    let rec = client::create_dns_record(&ctx.token, &zone_id, &payload)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.dns.create",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "type": rec.record_type, "name": rec.name })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(rec)
}

#[tauri::command]
pub async fn cf_update_dns_record(
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
        name: patch.name,
        content: patch.content,
        ttl: patch.ttl,
    };
    let rec = client::update_dns_record(&ctx.token, &zone_id, &record_id, &p)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.dns.update",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(rec)
}

#[tauri::command]
pub async fn cf_delete_dns_record(
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
    api.audit_log(
        "cf.dns.delete",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn cf_purge_cache(
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
    api.audit_log(
        "cf.cache_purge",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        None,
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}
```

- [x] **Step 2: Объявить модуль в `commands/mod.rs`**

Добавить (после `pub mod creds;`):

```rust
pub mod cloudflare;
```

- [x] **Step 3: Зарегистрировать команды в `lib.rs`**

В `desktop/src-tauri/src/lib.rs`, внутри `tauri::generate_handler![...]` (после
`commands::provision::install_fastpanel` на строке 48) добавить:

```rust
            commands::cloudflare::cf_verify_token,
            commands::cloudflare::cf_create_zone,
            commands::cloudflare::cf_create_dns_record,
            commands::cloudflare::cf_update_dns_record,
            commands::cloudflare::cf_delete_dns_record,
            commands::cloudflare::cf_purge_cache,
```

- [x] **Step 4: Проверить компиляцию и существующие тесты**

Run: `cd desktop/src-tauri && cargo test`
Expected: компилируется без ошибок; существующие тесты PASS (24 passed, 1 ignored). Тесты
CF-клиента (`cloudflare::client`, wiremock) продолжают покрывать сами вызовы API.

- [x] **Step 5: Коммит**

```bash
git add desktop/src-tauri/src/commands/cloudflare.rs desktop/src-tauri/src/commands/mod.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): expose Cloudflare DNS/zone/purge as Tauri commands with audit"
```

---

## Task 4: Tauri-команды registrar

**Files:**
- Create: `desktop/src-tauri/src/commands/registrars.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (generate_handler)

- [x] **Step 1: Создать `desktop/src-tauri/src/commands/registrars.rs`**

```rust
//! Tauri-команды регистраторов (Hostiq/Namecheap). API-ключ/секрет расшифровываются
//! на клиенте; смена NS пишется в audit_log.

use tauri::State;
use uuid::Uuid;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_str};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::registrars::{self, DomainInfo, RegistrarService};
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Собрать RegistrarService из кэшированной строки registrar_accounts + вернуть device_id.
async fn reg_service(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<(Box<dyn RegistrarService>, Option<Uuid>), CommandError> {
    let key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let row = cache::get_row_fields(&conn, "registrar_accounts", account_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("registrar account not in local cache".into()))?;

    let provider = row
        .get("provider")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("registrar account has no provider".into()))?;
    let api_user = row.get("api_user").and_then(json_str);

    let api_key_blob = row
        .get("api_key_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("registrar account has no api_key_blob_id".into()))?;
    let api_key_bytes = blob_plaintext(api, &key, &api_key_blob).await?;
    let api_key =
        String::from_utf8(api_key_bytes).map_err(|_| CommandError::Aead("api_key not utf8".into()))?;

    // api_secret опционален: для Namecheap этот параметр используется как whitelisted client IP.
    let api_secret = match row.get("api_secret_blob_id").and_then(json_str) {
        Some(blob) => {
            let bytes = blob_plaintext(api, &key, &blob).await?;
            Some(String::from_utf8(bytes).map_err(|_| CommandError::Aead("api_secret not utf8".into()))?)
        }
        None => None,
    };

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    let svc = registrars::make_service(&provider, &api_key, api_user.as_deref(), api_secret.as_deref())
        .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok((svc, device_id))
}

#[tauri::command]
pub async fn registrar_test_connection(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(bool, String), CommandError> {
    let (svc, _) = reg_service(&api, &user_id, &handle, &account_id).await?;
    svc.test_connection()
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub async fn registrar_get_domains(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Vec<DomainInfo>, CommandError> {
    let (svc, _) = reg_service(&api, &user_id, &handle, &account_id).await?;
    svc.get_domains()
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub async fn registrar_set_nameservers(
    user_id: String,
    account_id: String,
    domain: String,
    nameservers: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let (svc, device_id) = reg_service(&api, &user_id, &handle, &account_id).await?;
    let ok = svc
        .set_nameservers(&domain, &nameservers)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "registrar.ns_set",
        Some("domain"),
        Some(&domain),
        device_id,
        Some(serde_json::json!({ "nameservers": nameservers })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(ok)
}
```

- [x] **Step 2: Объявить модуль в `commands/mod.rs`**

Добавить (после `pub mod provision;`):

```rust
pub mod registrars;
```

- [x] **Step 3: Зарегистрировать команды в `lib.rs`**

В `generate_handler!` добавить (после блока cf-команд из Task 3):

```rust
            commands::registrars::registrar_test_connection,
            commands::registrars::registrar_get_domains,
            commands::registrars::registrar_set_nameservers,
```

- [x] **Step 4: Проверить компиляцию и тесты**

Run: `cd desktop/src-tauri && cargo test`
Результат: компилируется; **26 passed, 1 ignored** (было 24+1 в момент написания плана — за счёт более
ранних задач спринта количество тестов выросло; новых тестов в Task 4 намеренно не добавляли —
это тонкая orchestration-обёртка над уже протестированными клиентами, см. testing philosophy).

- [x] **Step 5: Коммит**

```bash
git add desktop/src-tauri/src/commands/registrars.rs desktop/src-tauri/src/commands/mod.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): expose registrar test/list/set-ns as Tauri commands with audit"
```

Коммит: `b05fb3e`.

**Итог Task 4: реализовано целиком**, без отклонений от плана. Сигнатуры `registrars::make_service`,
`RegistrarService`, `DomainInfo` (уже `Serialize`), `cache::get_row_fields`/`get_meta`,
`ApiClient::audit_log` и поля `registrar_accounts` (`provider`, `api_user`, `api_key_blob_id`,
`api_secret_blob_id`) в реальном коде совпали с кодом из плана 1:1 — правок не потребовалось.

---

## Task 5: Фронтенд — CF/registrar мутации через Tauri

Каждая мутация: если `isTauri()` → вызвать Tauri-команду; иначе — прежний HTTP-fallback. Паттерн
берём из `useProvisionDomain` (`frontend/src/api/domains.ts:263-286`). Tauri сам конвертирует
camelCase-аргументы JS в snake_case параметры Rust.

**Files:**
- Modify: `frontend/src/api/cloudflare.ts`
- Modify: `frontend/src/api/registrars.ts`

- [x] **Step 1: Обновить импорты в `cloudflare.ts`**

В шапку `frontend/src/api/cloudflare.ts` (после строки 4) добавить:

```ts
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { useAuthStore } from "../store/auth";
```

- [x] **Step 2: Перевести CF-мутации на Tauri**

Заменить тела `mutationFn` в `useTestCloudflareAccount`, `useCreateDnsRecord`, `useUpdateDnsRecord`,
`useDeleteDnsRecord`, `usePurgeCache`. Образец для `useCreateDnsRecord` (accountId/zoneId уже в
замыкании хука):

```ts
export function useCreateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async (data: DnsRecordCreate) => {
      if (isTauri()) {
        const userId = useAuthStore.getState().userId;
        if (!userId) throw new Error("Desktop: unlock session (user id missing)");
        return invokeIfTauri<DnsRecord>("cf_create_dns_record", {
          userId,
          accountId: String(accountId),
          zoneId,
          record: { type: data.type, name: data.name, content: data.content, ttl: data.ttl },
        });
      }
      return apiPost<DnsRecord>(`/cloudflare/accounts/${accountId}/zones/${zoneId}/dns`, data);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}
```

Аналогично:
- `useUpdateDnsRecord` → `cf_update_dns_record` с `{ userId, accountId: String(accountId), zoneId, recordId, patch: { name: data.name, content: data.content, ttl: data.ttl } }` (аргумент мутации `{ recordId, data }`).
- `useDeleteDnsRecord` → `cf_delete_dns_record` с `{ userId, accountId: String(accountId), zoneId, recordId }` (аргумент — `recordId: string`).
- `usePurgeCache` → `cf_purge_cache` с `{ userId, accountId: String(accountId), zoneId }`; при Tauri вернуть `{ success: true, message: null }`.
- `useTestCloudflareAccount` → `cf_verify_token` с `{ userId, accountId: String(id) }`; аргумент мутации `id: number`; при Tauri вернуть `{ success: ok, message: ok ? "OK" : "invalid token", account_email: null }` по boolean-результату.

- [x] **Step 3: Перевести registrar-мутации на Tauri**

В `frontend/src/api/registrars.ts` добавить те же импорты (Step 1) и обновить:
- `useTestRegistrarConnection` → при `isTauri()` вызвать `registrar_test_connection`
  `{ userId, accountId: String(id) }`; команда возвращает кортеж `[bool, string]` — привести к
  `{ success, message }`:

```ts
export function useTestRegistrarConnection() {
  return useMutation({
    mutationFn: async (id: number): Promise<RegistrarTestResult> => {
      if (isTauri()) {
        const userId = useAuthStore.getState().userId;
        if (!userId) throw new Error("Desktop: unlock session (user id missing)");
        const [success, message] = await invokeIfTauri<[boolean, string]>(
          "registrar_test_connection",
          { userId, accountId: String(id) }
        );
        return { success, message };
      }
      return apiPost<RegistrarTestResult>(`/registrars/accounts/${id}/test`);
    },
  });
}
```

- `useRegistrarDomains` (это `useQuery`) — в `queryFn` при `isTauri()` вызвать
  `registrar_get_domains` `{ userId, accountId: String(accountId) }` (тип результата
  `RegistrarDomain[]`), иначе прежний `apiGet`.

- [x] **Step 4: Прогнать фронт-тесты**

Run: `cd frontend && npx vitest run`
Expected: PASS (12 существующих тестов остаются зелёными; поведение web-ветки не изменилось).

- [x] **Step 5: Коммит**

```bash
git add frontend/src/api/cloudflare.ts frontend/src/api/registrars.ts
git commit -m "feat(frontend): route CF/registrar mutations through Tauri when in desktop"
```

---

## Task 6: install_fastpanel — чистые helper'ы порта легаси

Легаси-исходник для сверки: `.worktrees/fs-cursor-stage/backend/app/tasks/fastpanel_task.py`
(`_update_cmd` строки 34-37, `_parse_credentials` строки 40-53, `INSTALL_CMD` строки 15-17).

**Files:**
- Modify: `desktop/src-tauri/src/provision/fastpanel_install.rs` (сейчас 1 строка-заглушка)

- [x] **Step 1: Написать падающие тесты**

Заменить содержимое `desktop/src-tauri/src/provision/fastpanel_install.rs` тестовым блоком (реализация
появится в Step 3). Пока — только модуль-doc и тесты:

```rust
//! FastPanel install-over-SSH pipeline (порт легаси `fastpanel_task`).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_command_debian_default() {
        assert!(update_command("Ubuntu 22.04").contains("apt-get"));
        assert!(update_command("debian").contains("apt-get"));
        assert!(update_command("").contains("apt-get"));
    }

    #[test]
    fn update_command_rhel_family() {
        assert_eq!(update_command("CentOS 7"), "yum -y update");
        assert_eq!(update_command("AlmaLinux 9"), "yum -y update");
        assert_eq!(update_command("Rocky Linux"), "yum -y update");
    }

    #[test]
    fn parse_credentials_extracts_url_user_password() {
        let out = "Installation complete\n\
                   Panel URL: https://1.2.3.4:8888\n\
                   Username: fastuser\n\
                   Password: s3cr3t!\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
        assert_eq!(c.user.as_deref(), Some("fastuser"));
        assert_eq!(c.password.as_deref(), Some("s3cr3t!"));
    }

    #[test]
    fn parse_credentials_handles_login_and_equals() {
        let out = "Login: root\nPassword=abc123\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("root"));
        assert_eq!(c.password.as_deref(), Some("abc123"));
    }

    #[test]
    fn parse_credentials_missing_returns_none() {
        let c = parse_fastpanel_credentials("nothing useful here");
        assert!(c.url.is_none() && c.user.is_none() && c.password.is_none());
    }
}
```

- [x] **Step 2: Прогнать тесты — убедиться, что не компилируется/падает**

Run: `cd desktop/src-tauri && cargo test fastpanel_install`
Expected: FAIL — `update_command` / `parse_fastpanel_credentials` не определены.

- [x] **Step 3: Реализовать helper'ы**

В начало `fastpanel_install.rs` (до `#[cfg(test)]`) добавить:

```rust
/// Команда установки FastPanel (из легаси `INSTALL_CMD`).
pub const INSTALL_CMD: &str =
    "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -";

/// Команда обновления системы под семейство ОС (порт `_update_cmd`).
pub fn update_command(os: &str) -> String {
    let o = os.to_ascii_lowercase();
    if o.contains("centos")
        || o.contains("rhel")
        || o.contains("rocky")
        || o.contains("alma")
        || o.contains("fedora")
    {
        "yum -y update".to_string()
    } else {
        "DEBIAN_FRONTEND=noninteractive apt-get update && \
         DEBIAN_FRONTEND=noninteractive apt-get -y upgrade"
            .to_string()
    }
}

/// Разобранные креды из вывода инсталлятора.
#[derive(Debug, Default, PartialEq)]
pub struct FpCredentials {
    pub url: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

/// Достать URL панели / логин / пароль из stdout инсталлятора (порт `_parse_credentials`).
pub fn parse_fastpanel_credentials(output: &str) -> FpCredentials {
    let mut creds = FpCredentials::default();
    for line in output.lines() {
        let l = line.trim();

        if creds.url.is_none() {
            if let Some(idx) = l.find("http") {
                let tail = &l[idx..];
                if tail.contains("://") {
                    if let Some(tok) = tail.split_whitespace().next() {
                        creds.url = Some(tok.trim_end_matches(['.', ',']).to_string());
                    }
                }
            }
        }
        // Username проверяем раньше User, чтобы "User" не съел подстроку "Username".
        for kw in ["Username", "Login", "User"] {
            if creds.user.is_none() {
                if let Some(v) = value_after_key(l, kw) {
                    creds.user = Some(v);
                }
            }
        }
        if creds.password.is_none() {
            if let Some(v) = value_after_key(l, "Password") {
                creds.password = Some(v);
            }
        }
    }
    creds
}

/// Вернуть первый токен после `key:` или `key=` в строке (регистронезависимо).
fn value_after_key(line: &str, key: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let pos = lower.find(&key.to_ascii_lowercase())?;
    let rest = &line[pos + key.len()..];
    let rest = rest.trim_start();
    let rest = rest
        .strip_prefix(':')
        .or_else(|| rest.strip_prefix('='))
        .unwrap_or(rest);
    let val = rest.trim().split_whitespace().next()?;
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}
```

- [x] **Step 4: Прогнать тесты — убедиться, что проходят**

Run: `cd desktop/src-tauri && cargo test fastpanel_install`
Expected: PASS (5 тестов из Step 1).

- [x] **Step 5: Коммит**

```bash
git add desktop/src-tauri/src/provision/fastpanel_install.rs
git commit -m "feat(desktop): port FastPanel installer helpers (os update cmd, creds parser)"
```

---

## Task 7: install_fastpanel — реализация команды

Заменить заглушку (`commands/provision.rs:251-260`) реальной оркестрацией: SSH → update → install →
разбор кред → audit. Персист fastpanel-кред обратно на сервер в этом спринте не делаем (легаси
fastpanel_* поля — P2 на удаление; текущий provision тоже не персистит FTP-креды) — возвращаем их
в результате команды, чтобы UI мог показать/сохранить.

**Files:**
- Modify: `desktop/src-tauri/src/commands/provision.rs`
- Modify: `frontend/src/lib/deepLink.ts:45-50`

- [x] **Step 1: Добавить импорты и структуру результата в `provision.rs`**

В блок импортов добавить:

```rust
use crate::provision::fastpanel_install::{parse_fastpanel_credentials, update_command, INSTALL_CMD};
```

Рядом с `ProvisionResultOut` добавить:

```rust
#[derive(Serialize)]
pub struct InstallFastpanelResult {
    pub server_id: String,
    pub url: Option<String>,
    pub user: Option<String>,
    /// Пароль панели: чувствительно, показывать по образцу RevealSecret.
    pub password: Option<String>,
}
```

- [x] **Step 2: Реализовать команду `install_fastpanel`**

Заменить весь блок `install_fastpanel` (строки 251-260) на:

```rust
#[tauri::command]
pub async fn install_fastpanel(
    app: AppHandle,
    user_id: String,
    server_id: String,
    force: bool,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<InstallFastpanelResult, CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(&handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let server_row = cache::get_row_fields(&conn, "servers", &server_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("server not in local cache".into()))?;

    // Идемпотентность: не переустанавливаем, если уже установлено (кроме force).
    let fp_status = server_row
        .get("fastpanel_status")
        .and_then(json_str)
        .unwrap_or_default();
    if fp_status == "installed" && !force {
        return Err(CommandError::Api(
            "FastPanel already installed on this server (use force to reinstall)".into(),
        ));
    }

    let blob_id = server_row
        .get("ssh_password_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server has no ssh_password_blob_id".into()))?;
    let password = blob_plaintext(&api, &key, &blob_id).await?;
    let host = server_row
        .get("ip_address")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server missing ip_address".into()))?;
    let port = server_row
        .get("ssh_port")
        .and_then(json_i64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let ssh_user = server_row
        .get("ssh_user")
        .and_then(json_str)
        .unwrap_or_else(|| "root".into());
    let os = server_row.get("os").and_then(json_str).unwrap_or_default();

    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "ssh_connect", "server_id": server_id }),
    );
    let mut session = ssh_connect_session(&app, &host, port, &ssh_user, &password).await?;

    // 1) Обновление системы (долгая операция).
    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "updating", "server_id": server_id }),
    );
    let (upd_code, _upd_out) = session
        .exec(&update_command(&os), std::time::Duration::from_secs(900), true)
        .await?;
    if upd_code != 0 {
        let _ = session.disconnect().await;
        return Err(CommandError::Api(format!("system update failed (exit {upd_code})")));
    }

    // 2) Установка FastPanel.
    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "installing", "server_id": server_id }),
    );
    let (inst_code, inst_out) = session
        .exec(INSTALL_CMD, std::time::Duration::from_secs(900), true)
        .await?;
    let _ = session.disconnect().await;
    if inst_code != 0 {
        return Err(CommandError::Api(format!("fastpanel installer failed (exit {inst_code})")));
    }

    let creds = parse_fastpanel_credentials(&inst_out);

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());
    // metadata без пароля (redaction guard в http.rs всё равно запрещает ключ "password").
    api.audit_log(
        "server.fastpanel_install",
        Some("server"),
        Some(&server_id),
        device_id,
        Some(serde_json::json!({ "url": creds.url, "user": creds.user })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;

    Ok(InstallFastpanelResult {
        server_id,
        url: creds.url,
        user: creds.user,
        password: creds.password,
    })
}
```

- [x] **Step 3: Прокинуть `userId` в deep-link CTA**

В `frontend/src/lib/deepLink.ts`, ветка `install-fastpanel` (строки 45-50), заменить invoke на
передачу `userId` (в этой функции `userId` уже доступен как аргумент `handleSdmpDeepLinkInTauri`):

```ts
    if (u.hostname === "install-fastpanel") {
      const sid = u.searchParams.get("serverId") || u.searchParams.get("id");
      if (!sid) return false;
      await invoke("install_fastpanel", { userId, serverId: sid, force: false });
      return true;
    }
```

- [x] **Step 4: Проверить компиляцию, тесты, типы**

Run: `cd desktop/src-tauri && cargo test`
Expected: компилируется; PASS (24 + новые helper-тесты Task 6).
Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок типов в `deepLink.ts`.

- [ ] **Step 5: Ручная проверка (на тестовом сервере без FastPanel)**

В desktop: сервер → «Установить FastPanel». Ожидается: события `fastpanel:progress`
(ssh_connect → updating → installing), по завершении в UI приходят url/user/password; в
Activity/audit появляется `server.fastpanel_install` без пароля в metadata.

- [x] **Step 6: Коммит**

```bash
git add desktop/src-tauri/src/commands/provision.rs frontend/src/lib/deepLink.ts
git commit -m "feat(desktop): implement install_fastpanel over SSH with audit"
```

---

## Task 8: Provision-пайплайн — SSL (dns-gated) + опциональная БД

Достроить `run_provision_domain`: после site+FTP выпускать SSL (если `dns_resolves_to` истинно) и,
по флагу `with_db`, создавать БД. SSL/БД делаем до `session.disconnect()`. Email для LE берём из
`api.me().await?.email`.

**Files:**
- Modify: `desktop/src-tauri/src/commands/provision.rs`

- [x] **Step 1: Написать тест сериализации результата (контракт с фронтом)**

В конец `commands/provision.rs` добавить:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provision_result_omits_empty_optionals() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: None,
            ssl_error: None,
            db: None,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(!j.contains("ssl_issued"));
        assert!(!j.contains("ssl_error"));
        assert!(!j.contains("\"db\""));
    }

    #[test]
    fn provision_result_includes_db_when_present() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: Some(true),
            ssl_error: None,
            db: Some(DbInfoOut {
                db_name: "d".into(),
                db_user: "du".into(),
                db_password: "dp".into(),
            }),
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("ssl_issued"));
        assert!(j.contains("db_name"));
    }
}
```

- [x] **Step 2: Прогнать — убедиться, что не компилируется**

Run: `cd desktop/src-tauri && cargo test provision`
Expected: FAIL — поля `ssl_issued`/`ssl_error`/`db` и `DbInfoOut` не существуют.

- [x] **Step 3: Расширить `ProvisionResultOut` и импорты**

Заменить `ProvisionResultOut` (строки 18-23) на:

```rust
#[derive(Serialize)]
pub struct ProvisionResultOut {
    pub domain_id: String,
    pub site_user: String,
    pub site_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_issued: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<DbInfoOut>,
}

#[derive(Serialize)]
pub struct DbInfoOut {
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
}
```

В импорт fastpanel (строка 14) добавить `CreateDbResult`:

```rust
use crate::ssh::fastpanel::{self, CreateDbResult, CreateSiteResult};
```

- [x] **Step 4: Достроить `run_provision_domain`**

4a. Изменить сигнатуру — добавить `with_db: bool` перед `cache_path`:

```rust
pub async fn run_provision_domain(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    with_db: bool,
    cache_path: &Path,
    api: &ApiClient,
) -> Result<ProvisionResultOut, CommandError> {
```

4b. Заменить хвост функции начиная с блока FTP (строки 145-178) на полный цикл (FTP → SSL → DB →
disconnect → audit → return). Обрати внимание: `session.disconnect()` теперь ПОСЛЕ SSL/DB:

```rust
    let mut steps: Vec<&str> = vec!["ssh", "create_site"];
    let mut ssl_issued: Option<bool> = None;
    let mut ssl_error: Option<String> = None;
    let mut db_out: Option<DbInfoOut> = None;

    if !site_only {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ftp", "domain_id": domain_id }),
        );
        let _ftp = fastpanel::create_ftp_account(&mut session, &fp_path, &domain_name).await?;
        steps.push("ftp");

        // SSL: только если домен уже резолвится на IP сервера.
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ssl_dns_check", "domain_id": domain_id }),
        );
        let resolves = fastpanel::dns_resolves_to(
            &domain_name,
            &host,
            5,
            std::time::Duration::from_secs(3),
        )
        .await;
        if resolves {
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": "ssl_issue", "domain_id": domain_id }),
            );
            let email = api
                .me()
                .await
                .map_err(|e| CommandError::Api(e.to_string()))?
                .email;
            match fastpanel::issue_ssl_certificate(&mut session, &fp_path, &domain_name, &email)
                .await
            {
                Ok(_) => {
                    ssl_issued = Some(true);
                    steps.push("ssl");
                }
                Err(e) => {
                    tracing::warn!(target: "provision", "ssl issue failed: {e}");
                    ssl_issued = Some(false);
                    ssl_error = Some(e.to_string());
                }
            }
        } else {
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": "ssl_skipped_dns", "domain_id": domain_id }),
            );
            ssl_issued = Some(false);
            ssl_error = Some("dns does not resolve to server ip yet".into());
        }
    }

    if with_db {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "db", "domain_id": domain_id }),
        );
        let CreateDbResult {
            db_name,
            db_user,
            db_password,
            ..
        } = fastpanel::create_database(&mut session, &fp_path, &domain_name, None, None).await?;
        steps.push("db");
        db_out = Some(DbInfoOut {
            db_name,
            db_user,
            db_password,
        });
    }

    let _ = session.disconnect().await;

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    api.audit_log(
        "device.action.complete",
        Some("domain"),
        Some(domain_id),
        device_id,
        Some(serde_json::json!({
            "steps": steps,
            "domain_name": domain_name,
            "server_id": server_id,
            "site_only": site_only,
            "ssl_issued": ssl_issued,
        })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;

    Ok(ProvisionResultOut {
        domain_id: domain_id.to_string(),
        site_user,
        site_path,
        ssl_issued,
        ssl_error,
        db: db_out,
    })
```

- [x] **Step 5: Обновить вызовы `run_provision_domain` и команду `provision_domain`**

5a. `provision_domain` — добавить параметр `with_db` (Option для обратной совместимости со старыми
вызовами без аргумента):

```rust
#[tauri::command]
pub async fn provision_domain(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    site_only: bool,
    with_db: Option<bool>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<ProvisionResultOut, CommandError> {
    let cache_path = cache_path(&handle)?;
    run_provision_domain(
        &app,
        &user_id,
        &domain_id,
        site_only,
        with_db.unwrap_or(false),
        &cache_path,
        &api,
    )
    .await
}
```

5b. В `provision_bulk` (цикл, строка 241) обновить вызов — bulk без БД:

```rust
        run_provision_domain(&app, &user_id, did, false, false, &cache_path, &api).await?;
```

- [x] **Step 6: Прогнать тесты**

Run: `cd desktop/src-tauri && cargo test provision`
Expected: PASS (оба теста Step 1 + всё остальное компилируется).

- [ ] **Step 7: Ручная проверка (тестовый домен, указывающий на сервер)**

Provision домена: ожидается прохождение site → ftp → ssl_dns_check → ssl_issue; в результате
`ssl_issued=true`. Для домена без корректного DNS — шаг `ssl_skipped_dns`, provision не падает.
С флагом БД — создаётся БД, креды возвращаются.

- [x] **Step 8: Коммит**

```bash
git add desktop/src-tauri/src/commands/provision.rs
git commit -m "feat(desktop): provision pipeline issues SSL (dns-gated) and optional DB"
```

---

## Task 9: Фронтенд — флаг `withDb` и результат provision

`provision_domain` теперь принимает `with_db: Option<bool>` и возвращает расширенный результат.
Существующие вызовы `mutate(id)` продолжают работать (withDb по умолчанию false).

**Files:**
- Modify: `frontend/src/api/domains.ts:263-286`

- [x] **Step 1: Расширить `useProvisionDomain` (обратно совместимо)**

Заменить `useProvisionDomain` на версию, принимающую либо `number`, либо
`{ domainId: number; withDb?: boolean }`:

```ts
export interface ProvisionDesktopResult {
  domain_id: string;
  site_user: string;
  site_path: string;
  ssl_issued?: boolean;
  ssl_error?: string;
  db?: { db_name: string; db_user: string; db_password: string };
}

export function useProvisionDomain() {
  return useMutation({
    mutationFn: async (arg: number | { domainId: number; withDb?: boolean }) => {
      if (!isTauri()) {
        throw new Error("Provisioning runs in the SDMP desktop app.");
      }
      const domainId = typeof arg === "number" ? arg : arg.domainId;
      const withDb = typeof arg === "number" ? false : Boolean(arg.withDb);
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      const result = await invokeIfTauri<ProvisionDesktopResult>("provision_domain", {
        userId,
        domainId: String(domainId),
        siteOnly: false,
        withDb,
      });
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}
```

- [x] **Step 2: Проверить типы**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок. Существующие вызовы `provision.mutate(domainId)` валидны (union принимает
`number`).

- [x] **Step 3: Прогнать фронт-тесты**

Run: `cd frontend && npx vitest run`
Expected: PASS (12 существующих).

- [x] **Step 4: Коммит**

```bash
git add frontend/src/api/domains.ts
git commit -m "feat(frontend): provision hook supports withDb flag and returns ssl/db result"
```

---

## Task 10: Dashboard — чистые мапперы данных + тесты

**Files:**
- Create: `frontend/src/pages/dashboardData.ts`
- Test: `frontend/src/pages/dashboardData.test.ts`

- [x] **Step 1: Написать падающие тесты**

Создать `frontend/src/pages/dashboardData.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serverMetrics, formatUptime, auditRowToActivity } from "./dashboardData";

describe("serverMetrics", () => {
  it("maps real server fields instead of zeros", () => {
    const m = serverMetrics({
      cpu_usage_pct: 42,
      ram_used_mb: 2048,
      ram_total_mb: 4096,
      disk_used_gb: 10,
      disk_total_gb: 40,
      uptime_seconds: 172800,
    } as any);
    expect(m.cpu).toBe(42);
    expect(m.ramUsed).toBe(2);
    expect(m.ramTotal).toBe(4);
    expect(m.ssdUsed).toBe(10);
    expect(m.uptime).toBe("2 days");
  });

  it("defaults missing metrics to zero without throwing", () => {
    const m = serverMetrics({} as any);
    expect(m.cpu).toBe(0);
    expect(m.uptime).toBe("0h");
  });
});

describe("formatUptime", () => {
  it("uses days when >= 1 day, hours otherwise", () => {
    expect(formatUptime(86400)).toBe("1 day");
    expect(formatUptime(3600)).toBe("1h");
  });
});

describe("auditRowToActivity", () => {
  it("labels a known action and picks the type icon", () => {
    const a = auditRowToActivity({
      id: 7,
      action: "cf.dns.create",
      target_type: "cloudflare_zone",
      target_id: "z1",
      metadata: null,
      ts: "2026-08-02T10:00:00Z",
    } as any);
    expect(a.label).toBe("DNS record created");
    expect(a.icon).toBe("☁");
  });

  it("falls back to the raw action for unknown actions", () => {
    const a = auditRowToActivity({
      id: 8,
      action: "weird.thing",
      target_type: null,
      target_id: null,
      metadata: null,
      ts: "x",
    } as any);
    expect(a.label).toBe("weird.thing");
    expect(a.icon).toBe("·");
  });
});
```

- [x] **Step 2: Прогнать — убедиться, что падает**

Run: `cd frontend && npx vitest run src/pages/dashboardData.test.ts`
Expected: FAIL — модуль `./dashboardData` не существует.

- [x] **Step 3: Реализовать мапперы**

Создать `frontend/src/pages/dashboardData.ts`:

```ts
import type { Server } from "../api/servers";
import type { AuditLogRow } from "../api/audit";

export interface ServerMetrics {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  ssdUsed: number;
  ssdTotal: number;
  uptime: string;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function serverMetrics(s: Server): ServerMetrics {
  return {
    cpu: Math.round(s.cpu_usage_pct ?? 0),
    ramUsed: round1((s.ram_used_mb ?? 0) / 1024),
    ramTotal: round1((s.ram_total_mb ?? 0) / 1024),
    ssdUsed: Math.round(s.disk_used_gb ?? 0),
    ssdTotal: Math.round(s.disk_total_gb ?? 0),
    uptime: formatUptime(s.uptime_seconds ?? 0),
  };
}

export interface ActivityItem {
  id: string;
  icon: string;
  label: string;
  target: string;
  ts: string;
}

const ACTION_LABELS: Record<string, string> = {
  "domain.create": "Domain created",
  "domain.update": "Domain updated",
  "domain.delete": "Domain deleted",
  "server.create": "Server added",
  "server.fastpanel_install": "FastPanel installed",
  "cf.zone.create": "Zone created",
  "cf.dns.create": "DNS record created",
  "cf.dns.update": "DNS record updated",
  "cf.dns.delete": "DNS record deleted",
  "cf.cache_purge": "Cache purged",
  "registrar.ns_set": "Nameservers set",
  "device.action.complete": "Provisioned",
  "auth.login": "Signed in",
};

const TYPE_ICONS: Record<string, string> = {
  domain: "◎",
  server: "🖥",
  cloudflare_zone: "☁",
  registrar: "📋",
};

export function auditRowToActivity(row: AuditLogRow): ActivityItem {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const target =
    (meta.domain_name as string) ||
    (row.target_id ? `${row.target_type ?? ""} #${row.target_id}`.trim() : "");
  return {
    id: String(row.id),
    icon: TYPE_ICONS[row.target_type ?? ""] ?? "·",
    label: ACTION_LABELS[row.action] ?? row.action,
    target,
    ts: row.ts,
  };
}
```

- [x] **Step 4: Прогнать — убедиться, что проходит**

Run: `cd frontend && npx vitest run src/pages/dashboardData.test.ts`
Expected: PASS (все describe-блоки зелёные).

- [x] **Step 5: Коммит**

```bash
git add frontend/src/pages/dashboardData.ts frontend/src/pages/dashboardData.test.ts
git commit -m "feat(frontend): pure dashboard mappers for server metrics and activity"
```

---

## Task 11: Dashboard.tsx — подключить реальные данные

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [x] **Step 1: Импорты и хук активности**

В шапку `Dashboard.tsx` добавить:

```tsx
import { useAuditLog } from "../api/audit";
import { serverMetrics, auditRowToActivity } from "./dashboardData";
```

После `const { data: qTasks, isLoading: l5 } = useTaskLogs();` (строка 14) добавить:

```tsx
  const { data: qAudit, isLoading: l6 } = useAuditLog(20);
```

- [x] **Step 2: Реальные метрики серверов**

Заменить блок `const servers = (qServers?.items || []).map(...)` (строки 16-29) на:

```tsx
  const servers = (qServers?.items || []).map((s: any) => {
    const m = serverMetrics(s);
    return {
      id: s.id,
      name: s.name,
      ip: s.ip_address,
      cpu: m.cpu,
      ram_used: m.ramUsed,
      ram_total: m.ramTotal,
      ssd_used: m.ssdUsed,
      ssd_total: m.ssdTotal,
      uptime: m.uptime,
      status: s.status === "active" ? "healthy" : (s.status || "warning"),
      fastpanel: s.fastpanel_status === "installed",
      original: s,
    };
  });
```

- [x] **Step 3: Реальная активность**

Заменить строку 35 (`const activityLogs: any[] = [];`) на:

```tsx
  const activityLogs = (qAudit ?? []).map(auditRowToActivity);
```

Удалить теперь неиспользуемые карты `aLabel`/`aIcon` (строки 41-42).

- [x] **Step 4: Обновить loading-гейт и рендер активности**

4a. В строке 44 добавить `l6` в условие загрузки:

```tsx
  if (l1 || l2 || l3 || l4 || l5 || l6) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading dashboard data...</div>;
```

4b. Заменить рендер элементов активности (строки 113-120) на использование `ActivityItem`:

```tsx
              {activityLogs.slice(0,6).map(l=>(
                <div key={l.id} style={{display:"flex",gap:10,padding:"9px 0",borderBottom:"1px solid #f3f4f6",alignItems:"flex-start"}}>
                  <div style={{width:26,height:26,borderRadius:6,background:"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>{l.icon}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,color:"#111"}}><span style={{color:"#9ca3af"}}>{l.label}: </span>{l.target}</div>
                    <div style={{fontSize:11.5,color:"#9ca3af",marginTop:1}}>{fmtDT(l.ts)}</div>
                  </div>
                </div>
              ))}
```

- [x] **Step 5: Починить поля SSL в Quick Stats**

В блоке Quick Stats (строки 100-101) заменить некорректное поле `d.ssl` на реальное `d.ssl_status`:

```tsx
                ["Domains w/ SSL",domains.filter((d: any)=>d.ssl_status==="valid").length,"#16a34a"],
                ["SSL Expiring",domains.filter((d: any)=>d.ssl_status==="expiring").length,"#d97706"],
```

- [x] **Step 6: Проверить типы и тесты**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок (в т.ч. нет «unused variable» для `aLabel`/`aIcon`).
Run: `cd frontend && npx vitest run`
Expected: PASS (12 существующих + 3 новых describe из Task 10).

- [ ] **Step 7: Ручная проверка**

Открыть Dashboard: Server Health показывает реальные CPU/RAM/SSD/uptime; Recent Activity —
последние записи из audit_log с корректными иконками/подписями; «No recent activity» только при
пустом логе.

- [x] **Step 8: Коммит**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat(frontend): wire Dashboard to real server metrics and audit activity"
```

---

## Финальная проверка спринта (acceptance)

- [x] `cd desktop/src-tauri && cargo test` — **67 passed, 0 failed, 1 ignored** (было 24 до спринта).
      `cargo clippy --all-targets` — 14 предупреждений, ни одного в тронутых файлах.
- [x] `cd frontend && npx vitest run && npx tsc --noEmit` — **50 passed в 8 файлах**; tsc — 53 ошибки,
      это ровно преэкзистующий долг Спринта 0 (`Settings.tsx` и др.), новых не добавлено.
- [x] `cd backend && python3.12 -m pytest tests/test_audit_actions.py tests/test_audit.py -q` — **3 passed**.
- [ ] Ручной end-to-end в desktop на тестовом сервере: добавить сервер → install FastPanel →
      добавить домен → назначить CF-зону + registrar → set nameservers (registrar-команда) →
      создать/изменить DNS-запись (CF-команда) → provision (site+FTP+SSL, опц. БД).
- [ ] В Activity/audit видны: `server.fastpanel_install`, `registrar.ns_set`, `cf.dns.*`,
      `device.action.complete` — и ни в одной записи metadata нет плейнтекст-секретов
      (проверить существующим тестом `backend/tests/test_audit.py`).

---

## Итоговый блок

- **Реализован целиком / частично:** **все 11 задач плана выполнены целиком**, но
  **цель спринта достигнута частично**. Код исполнительного слоя написан, покрыт тестами и
  проверен ревью; часть команд при этом ещё не имеет кнопок в UI (детали ниже).
- **Что сделано по блокам:**
  1. CF/registrar Tauri-команды — **да** (6 CF + 3 registrar, каждая мутация в audit_log).
  2. install_fastpanel — **да** (SSH → update → инсталлятор → разбор кред → audit + progress-события).
  3. Provision site+FTP+SSL (+опц. БД) — **да** (SSL под DNS-гейтом, БД по флагу, одна SSH-сессия).
  4. Аудит исполнительных мутаций — **да, с оговоркой**: пишутся только успехи;
     `device.action.start`/`fail` объявлены в `SAFE_ACTIONS`, но не эмитятся (см. ниже).
  5. Dashboard на реальных данных — **наполовину**: активность настоящая, метрики серверов
     никто не собирает, поэтому теперь честно рисуется `—` вместо выдуманных нулей.

### Найдено и починено сверх плана

- **Ключи аргументов Tauri 2 — camelCase.** `sync_init`/`sync_now` вызывались с `user_id`, падали,
  а `catch` это глотал: **локальный кэш не наполнялся никогда**, то есть весь слой команд,
  резолвящих сущности из кэша, физически не мог работать. Там же: `auth_logout` не срабатывал →
  мастер-ключ оставался в OS-keychain после выхода; `totp_code` терялся → аккаунт с 2FA не мог
  войти в десктоп; `new_password` не доходил до восстановления.
- **Утечки секретов в текст ошибки:** пароль БД попадал в `SshError` через вывод mysql
  (`CREATE USER … IDENTIFIED BY`), FTP-пароль — через argv. Закрыто `opaque_exit` + `db_error`.
- **`proxied` терялся** на desktop-пути создания/правки DNS-записи → запись пользователя,
  помеченная как проксируемая, создавалась без проксирования (origin-IP переставал скрываться).
  Там же дозаведены `type` и `priority`.
- **russh inactivity_timeout 45s** оборвал бы сессию посреди `apt-get upgrade` и выпуска SSL.
- **Исполняющие `sdmp://` deep-link'и** запускались без подтверждения — любая веб-страница могла
  инициировать 30-минутную установку или SSH-провижининг. Добавлено подтверждение с указанием
  действия и цели.
- Двойной клик по Provision запускал две параллельные SSH-сессии — кнопка блокируется.
- Аудит CF/registrar был фатальным: успешное удаление DNS-записи рапортовало ошибкой, повтор давал
  404. Переведён в best-effort, как в provision/install.
- Пароль FTP генерировался и выбрасывался — теперь показывается один раз, как пароли БД и панели.

### Что осталось / вынесено за скоуп Спринта 1

**Достижимость из UI (главное — без этого цель спринта не закрыта):**
  - Кнопка «Install FastPanel» в `ServerDetail.tsx` ведёт на несуществующий HTTP-роут
    `POST /servers/{id}/install-fastpanel`; единственный путь к команде — deep link.
  - `CloudflareZoneView` написан, но нигде не рендерится → DNS-редактор недоступен, четыре
    CF DNS-команды не имеют вызывающих. `cf_create_zone` — вызывающих нет.
  - «Set NS» ведёт на несуществующий `POST /domains/{id}/set-ns`; `registrar_set_nameservers`
    не вызывается из UI.
  - Чекбокса `withDb` нет — опциональная БД недостижима (флаг проброшен до Rust).
  - Сбора метрик серверов нет ни в каком виде (нет коллектора, `/servers/{id}/refresh-metrics`
    не существует).

**Известные архитектурные долги:**
  - Персист результатов исполнения (`site_user`, `ftp_user`, `ssl_*`, `db_*`, `fastpanel_status`)
    обратно на сервер. Sync односторонний, `DomainUpdate`/`ServerUpdate` этих полей не имеют.
    Следствие: гарды идемпотентности (`ssl_exists`, «FastPanel уже установлен») читают поля,
    которые никто не пишет, — то есть выглядят рабочими, но не срабатывают.
  - `device.action.start`/`device.action.fail` не эмитятся: журнал фиксирует только успехи.
  - Очереди/ретраев аудита нет — `audit_log` это живой HTTP-запрос посреди операции.
  - `keychain::load_master_key` отдаёт голый `[u8; 32]`; затирать обязан каждый вызывающий.
    Просится `Zeroizing<[u8; 32]>` в сигнатуре.
  - `ssh_exec` — команда произвольного выполнения на произвольном хосте, вызывающих во фронте нет.
  - Разделение `commands/provision.rs` (два несвязанных оркестратора) и наполнение
    однострочной заглушки `provision/domain.rs`.

- **Замечания по эффективности / что можно лучше:** снипеты кода в плане писались по памяти и
  систематически расходились с реальностью — в них были несуществующие поля (`d.ssl`,
  `ssl_status === "valid"`), устаревшие сигнатуры и утечки секретов. Каждая задача требовала
  сверки с настоящим кодом до реализации; там, где сверка была, находились настоящие баги.
  Отдельно дорого обошлось то, что план описывал UI, которого нет: задачи «сделай команду»
  закрывались честно, а продуктовая цель при этом не двигалась. В следующий раз в план стоит
  включать проверку «есть ли кнопка, которая это вызывает» как явный шаг приёмки.
