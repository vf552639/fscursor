//! Tauri-команды регистраторов (Hostiq/Namecheap). API-ключ/секрет расшифровываются
//! на клиенте; смена NS пишет `ns_status` обратно в строку домена и строчку в
//! audit_log — и то и другое best-effort, см. `creds::audit_best_effort`.

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{
    audit_best_effort, blob_plaintext, cache_path, json_str, AUDIT_PROGRESS_EVENT,
};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::registrars::{self, DomainInfo, RegistrarError, RegistrarService};
use crate::sync::cache;
use crate::sync::http::{ApiClient, DomainWriteBack};

/// Собрать RegistrarService из кэшированной строки registrar_accounts + вернуть device_id.
async fn reg_service(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<(Box<dyn RegistrarService>, Option<Uuid>), CommandError> {
    let mut key = keychain::load_master_key(user_id)
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
    let mut api_key = String::from_utf8(api_key_bytes)
        .map_err(|_| CommandError::Aead("api_key not utf8".into()))?;

    // api_secret опционален: для Namecheap этот параметр используется как whitelisted client IP.
    let secret_blob = row.get("api_secret_blob_id").and_then(json_str);
    let mut api_secret = match secret_blob {
        Some(blob) => {
            let bytes = blob_plaintext(api, &key, &blob).await;
            // Мастер-ключ отработал оба блоба и больше не нужен. Гасим до
            // разбора результата, а не после, — иначе ошибочный путь его
            // пропустит.
            key.zeroize();
            let bytes = bytes?;
            Some(
                String::from_utf8(bytes)
                    .map_err(|_| CommandError::Aead("api_secret not utf8".into()))?,
            )
        }
        None => {
            key.zeroize();
            None
        }
    };

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    let svc = registrars::make_service(
        &provider,
        &api_key,
        api_user.as_deref(),
        api_secret.as_deref(),
    );
    // Свою копию ключа и секрета сервис уже забрал; наши расшифрованные строки
    // отжили своё. Гасим до `?`, чтобы ошибка `make_service` их не пропустила.
    api_key.zeroize();
    if let Some(s) = api_secret.as_mut() {
        s.zeroize();
    }
    let svc = svc.map_err(|e| CommandError::Api(e.to_string()))?;
    Ok((svc, device_id))
}

/// Провайдер аккаунта регистратора по данным локального кэша.
///
/// Отдельно от `reg_service` — потому что отвечает на вопрос, который задают ДО
/// расшифровки ключей: умеет ли этот регистратор менять NS вообще
/// (`registrars::supports_ns_api`). Ценой второго открытия кэша: спросив через
/// `reg_service`, мы получили бы вместо ответа ошибку «unknown provider», а
/// отсутствие API — это не сбой, и в отчёте full-setup'а оно стоит отдельной
/// строкой, а не красной.
pub(crate) fn registrar_provider(
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<String, CommandError> {
    let mut key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(handle)?;
    let conn = cache::open(&path, &key);
    // Ключ отработал: дальше только чтение несекретного поля. Гасим до разбора
    // результата, а не после, — иначе ошибочный путь его пропустит.
    key.zeroize();
    let conn = conn.map_err(|e| CommandError::Api(e.to_string()))?;

    cache::get_row_fields(&conn, "registrar_accounts", account_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("registrar account not in local cache".into()))?
        .get("provider")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("registrar account has no provider".into()))
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

/// Какие nameservers стоят у ОДНОГО домена по данным его регистратора.
///
/// Отдельная команда, а не поле в `registrar_get_domains`, по трём причинам, и
/// каждая из них — про правду, а не про удобство.
///
/// Первая: листинг их не знает. `namecheap.domains.getList` nameservers не
/// отдаёт вовсе (`namecheap.rs` кладёт туда пустой вектор), так что «сверка с
/// регистратором» по листингу у половины провайдеров не работала бы никогда.
///
/// Вторая: листинг — одна непагинированная страница (`PageSize=100` у
/// Namecheap, `GET /domains` у Hostiq). На аккаунте в 250 доменов отсутствие
/// строки означает не «домена тут нет», а «страница кончилась», и вызывающий
/// не может отличить одно от другого. Спрашивая про конкретный домен, мы
/// получаем либо ответ, либо ошибку регистратора — оба однозначны.
///
/// Третья: цена. Карточке домена нужен один домен, а не выкачка аккаунта.
///
/// Аудита тут нет намеренно: audit_log пишут действия, которые что-то меняют
/// (`registrar.ns_set`), а это чтение — как `registrar_get_domains` и
/// `registrar_test_connection` рядом.
#[tauri::command]
pub async fn registrar_get_nameservers(
    user_id: String,
    account_id: String,
    domain: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Vec<String>, CommandError> {
    let (svc, _) = reg_service(&api, &user_id, &handle, &account_id).await?;
    svc.get_nameservers(&domain)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

/// Словарь `domains.ns_status`. Enum'а под него на бэкенде НЕТ: колонка —
/// голый `String(32)` (`models/domain.py`), и ни один серверный путь в неё не
/// пишет. Не искать `NsStatus` в `core/constants.py` — там есть `DomainStatus`
/// с `ns_pending`/`ns_ok`, но это ДРУГАЯ колонка (`domains.status`).
///
/// Фактический источник правды — фронт, который по этим значениям рисует бейдж
/// «NS push to registrar»: `ok` → зелёный, `error` → красный, всё остальное →
/// «Pending» (`Domains.tsx`, `Dashboard.tsx`, `ServerDetail.tsx`).
const NS_STATUS_OK: &str = "ok";
const NS_STATUS_ERROR: &str = "error";
/// Действие аудита смены NS. Оно же — ключ в `AUDIT_ACTION_LABEL` на фронте.
const AUDIT_ACTION_NS_SET: &str = "registrar.ns_set";

/// Что команда делает с итогом смены NS, кроме как возвращает его.
///
/// Три решения, которые обязаны быть согласованы, и раньше принимались врозь
/// прямо в теле команды: аудит успел разойтись с остальными и записывал
/// `Ok(false)` как состоявшуюся смену. Вынесено в чистую функцию не ради
/// красоты: поставить `AppHandle`/`State` в тест дорого, поэтому иначе гейты
/// не покрыть вовсе — их можно было снять, и все тесты оставались зелёными.
#[derive(Debug, PartialEq, Eq)]
struct NsOutcomePlan {
    /// Значение `domains.ns_status`, которое уедет на сервер. Пишется ВСЕГДА:
    /// отбитая попытка обязана перестать выглядеть как «менять не пробовали».
    status: &'static str,
    /// Писать ли строчку `registrar.ns_set` в audit log. Только за
    /// состоявшуюся смену — на отказе она врала бы истории.
    audit: bool,
    /// Слать ли `writeback_failed`, если write-back не прошёл. Текст на той
    /// стороне склеивается из `AUDIT_ACTION_LABEL` («Nameservers set») с
    /// суффиксом, поэтому на отказе тост противоречил бы баннеру об ошибке.
    report_writeback_failure: bool,
}

/// Разобрать итог регистратора в план действий.
///
/// Принимает ВЕСЬ итог, а не `bool`: отказ (`Err`) — единственный достижимый
/// провал (обе реализации отвечают либо `Ok(true)`, либо ошибкой — см.
/// `hostiq.rs`, `namecheap.rs`), и именно ради него `ns_status` и заведён. Если
/// бы сюда приходил `bool` уже после `?`, `error` не писался бы никогда.
/// `Ok(false)` — та же семантика «не применил», просто сегодня недостижимая.
fn ns_outcome_plan(outcome: &Result<bool, RegistrarError>) -> NsOutcomePlan {
    let applied = matches!(outcome, Ok(true));
    NsOutcomePlan {
        status: if applied {
            NS_STATUS_OK
        } else {
            NS_STATUS_ERROR
        },
        audit: applied,
        report_writeback_failure: applied,
    }
}

/// Что из итога смены NS уезжает на сервер.
///
/// Только статус: сами nameservers — это состояние зоны у Cloudflare и у
/// регистратора, дублировать его в строке домена нечем (колонки под список нет),
/// а `ns_updated_at` не заполняет ни один путь — ни серверный, ни этот.
fn ns_write_back_body(plan: &NsOutcomePlan) -> DomainWriteBack {
    DomainWriteBack {
        ns_status: Some(plan.status.to_string()),
        ..Default::default()
    }
}

/// Прописать NS у регистратора.
///
/// `domain` — ИМЯ домена: его ждёт API регистратора, и оно же идёт в `target_id`
/// аудита. `domain_id` — строка `domains` на сервере, адресат write-back'а;
/// одно из другого не выводится, поэтому приходят оба.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn registrar_set_nameservers(
    app: AppHandle,
    user_id: String,
    account_id: String,
    domain_id: String,
    domain: String,
    nameservers: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let (svc, device_id) = reg_service(&api, &user_id, &handle, &account_id).await?;
    // Итог держим целиком и НЕ разворачиваем через `?` до write-back'а: отказ
    // регистратора — это как раз тот исход, ради которого `ns_status` и нужен.
    let outcome = svc.set_nameservers(&domain, &nameservers).await;
    let plan = ns_outcome_plan(&outcome);

    // Write-back раньше аудита — как в провижининге. Без него `ns_status` домена
    // навсегда оставался бы `pending`: другого пути его заполнить нет (роутов
    // `check-ns`/`mark-ns-set` на бэкенде не существует), и бейдж «NS push to
    // registrar» врал бы — и про удавшуюся смену, и про отбитую попытку.
    //
    // Best-effort по той же причине, что и аудит: на успехе NS у регистратора
    // уже переписаны и откату не подлежат, а на провале пользователю нужен
    // текст ошибки регистратора, а не сообщение про незаписанный статус. Ни в
    // одну сторону не превращать в `?`: там он подменил бы собой настоящий
    // результат.
    if let Err(e) = api
        .domain_write_back(&domain_id, &ns_write_back_body(&plan))
        .await
    {
        tracing::warn!(target: "registrars", "write-back of ns_status failed: {e}");
        // Событие — только когда смена состоялась. Текст на той стороне
        // склеивается из `AUDIT_ACTION_LABEL` («Nameservers set») и суффикса про
        // незаписанный результат; на отбитой попытке пользователь получил бы
        // тост «Nameservers set, but…» одновременно с баннером «Namecheap
        // setCustom failed: …» — два взаимоисключающих сообщения об одном
        // действии. Незаписанный `ns_status` на уже видимой ошибке — меньшее
        // зло: ошибка на экране, а не молчание.
        if plan.report_writeback_failure {
            let _ = app.emit(
                AUDIT_PROGRESS_EVENT,
                serde_json::json!({
                    "step": "writeback_failed",
                    "action": AUDIT_ACTION_NS_SET,
                    "target_type": "domain",
                    "target_id": domain,
                }),
            );
        }
    }

    // Только теперь наружу: ошибка регистратора доезжает до баннера модалки как
    // была, статус на сервере к этому моменту уже записан.
    let ok = outcome.map_err(|e| CommandError::Api(e.to_string()))?;

    // Аудит — только за состоявшуюся смену: строчка `registrar.ns_set` на
    // непринятом `Ok(false)` врала бы истории, а write-back и фронт этот же
    // случай трактуют как «не применено» (`ns_status: error`). `?` из-за сбоя
    // аудита показал бы неудачу на удавшейся смене, а повтор ничего бы не
    // исправил. Best-effort, не превращать обратно в `?`.
    if plan.audit {
        audit_best_effort(
            &app,
            &api,
            AUDIT_ACTION_NS_SET,
            "domain",
            &domain,
            device_id,
            Some(serde_json::json!({ "nameservers": nameservers })),
        )
        .await;
    }
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(outcome: Result<bool, RegistrarError>) -> String {
        serde_json::to_string(&ns_write_back_body(&ns_outcome_plan(&outcome))).unwrap()
    }

    /// Ожидания ЛИТЕРАЛЬНЫЕ, а не пересчитанные тем же кодом, который
    /// проверяются. Прошлая версия считала `expected` через ту же функцию, что
    /// и предмет проверки, — обе стороны равенства были одним выражением, и
    /// тест не мог упасть в принципе.
    #[test]
    fn ns_outcome_plan_spells_out_every_decision() {
        let ok = ns_outcome_plan(&Ok(true));
        assert_eq!(ok.status, "ok");
        assert!(ok.audit, "состоявшаяся смена обязана попасть в audit log");
        assert!(ok.report_writeback_failure);

        // Отказ регистратора: статус пишем, но ни строчки в историю, ни тоста
        // «Nameservers set, but…» поверх баннера с текстом отказа.
        let refused = ns_outcome_plan(&Err(RegistrarError::Api(
            "Namecheap setCustom failed: Invalid nameserver".into(),
        )));
        assert_eq!(refused.status, "error");
        assert!(!refused.audit, "аудит за несостоявшуюся смену врёт истории");
        assert!(
            !refused.report_writeback_failure,
            "тост «Nameservers set, but…» противоречил бы баннеру об отказе"
        );

        // `Ok(false)` сегодня недостижим, но семантика у него та же «не
        // применил» — и решаться он обязан так же, как отказ.
        let unapplied = ns_outcome_plan(&Ok(false));
        assert_eq!(unapplied.status, "error");
        assert!(!unapplied.audit);
        assert!(!unapplied.report_writeback_failure);
    }

    #[test]
    fn ns_write_back_body_maps_success_to_ok() {
        assert_eq!(body_of(Ok(true)), r#"{"ns_status":"ok"}"#);
    }

    #[test]
    fn ns_write_back_body_maps_registrar_rejection_to_error() {
        // Единственный достижимый провал: обе реализации отвечают либо
        // `Ok(true)`, либо `Err`. Пока итог разворачивался через `?` до
        // write-back'а, именно этот случай не записывался вообще — домен с
        // отбитой попыткой оставался `pending`.
        let err = RegistrarError::Api("Namecheap setCustom failed: Invalid nameserver".into());
        assert_eq!(body_of(Err(err)), r#"{"ns_status":"error"}"#);
    }

    #[test]
    fn ns_write_back_body_maps_unapplied_to_error() {
        assert_eq!(body_of(Ok(false)), r#"{"ns_status":"error"}"#);
    }

    #[test]
    fn ns_write_back_body_touches_nothing_but_ns_status() {
        // Патч применяется как `exclude_unset`: лишнее поле здесь затёрло бы
        // чужой результат (например, `ssl_status`, который ставит провижининг).
        for outcome in [Ok(true), Ok(false), Err(RegistrarError::NotImplemented)] {
            let body: serde_json::Value =
                serde_json::to_value(ns_write_back_body(&ns_outcome_plan(&outcome))).unwrap();
            let obj = body.as_object().unwrap();
            assert_eq!(obj.len(), 1, "лишние поля в патче: {obj:?}");
        }
    }
}
