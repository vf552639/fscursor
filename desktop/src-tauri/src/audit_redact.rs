//! Guards so nothing we push to the server carries an obvious secret field name.
//!
//! Две проверки с разной силой, разным назначением и — сознательно — разной
//! логикой:
//!
//! * [`redact_check_metadata`] — debug-only проверка аудит-метаданных по
//!   подстроке во всём сериализованном JSON. В release её нет: аудит собирается
//!   вручную из литералов, и падать в проде из-за него хуже, чем не записать
//!   строчку. Грубость этой проверки там уместна — она ловит опечатки автора
//!   на этапе разработки и ничего не ломает в бою.
//! * [`ensure_no_secrets`] — жёсткая проверка write-back'а результатов
//!   провижининга, работающая и в release. Она смотрит ТОЛЬКО имена полей и
//!   никогда — значения: значения там приходят с чужого сервера (имя сайта,
//!   путь `/var/www/u1/data/www/password.com`, URL панели), и проверка по
//!   подстроке в значении навсегда отключила бы write-back для доменов вида
//!   `password.com` — то есть ровно ту потерю данных, ради устранения которой
//!   write-back и написан.

/// Секретоподобные ИМЕНА полей. Сравниваются как подстрока имени в нижнем
/// регистре, поэтому `db_password` и `ftp_password` ловятся одним маркером.
///
/// Известный побочный эффект: `fastpanel_password_blob_id` тоже не пройдёт,
/// хотя id блоба секретом не является. Сегодня мы его не отправляем, а сторона
/// ошибки здесь правильная.
const SECRET_KEY_MARKERS: [&str; 3] = ["password", "auth_key", "api_key"];

/// Первое секретоподобное ИМЯ поля — рекурсивно по объектам и массивам.
/// Скалярные значения не проверяются вовсе (см. модульный комментарий).
fn find_secret_key(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                let lower = key.to_lowercase();
                if SECRET_KEY_MARKERS.iter().any(|m| lower.contains(m)) {
                    return Some(key.clone());
                }
                if let Some(found) = find_secret_key(value) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_secret_key),
        _ => None,
    }
}

pub fn redact_check_metadata(v: &serde_json::Value) {
    let s = serde_json::to_string(v).unwrap_or_default().to_lowercase();
    debug_assert!(
        !s.contains("password"),
        "audit metadata must not contain password"
    );
    debug_assert!(
        !s.contains("\"auth_key\""),
        "audit metadata must not contain auth_key"
    );
    debug_assert!(
        !s.contains("\"api_key\""),
        "audit metadata must not contain api_key"
    );
}

/// Проверка, которая работает и в release: возвращает имя провинившегося поля,
/// чтобы вызывающий отказался отправлять тело, а не «отправил и понадеялся».
pub fn ensure_no_secrets(v: &serde_json::Value) -> Result<(), String> {
    match find_secret_key(v) {
        Some(key) => Err(key),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Обычный `#[test]`, а не debug_assert: смысл `ensure_no_secrets` ровно в
    // том, что она работает в release, где debug_assert вырезан.
    #[test]
    fn ensure_no_secrets_rejects_a_password_key() {
        let v = json!({"site_user": "u", "db_password": "s3cret"});
        assert_eq!(ensure_no_secrets(&v), Err("db_password".to_string()));
    }

    // Настоящий случай: `site_path` собирается как
    // `/var/www/{site_user}/data/www/{domain}`, поэтому домен `password.com`
    // даёт «password» в значении. Отказ здесь означал бы, что для таких доменов
    // write-back не работает НИКОГДА и `site_user` до сервера не доедет.
    #[test]
    fn ensure_no_secrets_allows_a_password_shaped_value() {
        let v = json!({
            "site_user": "password_com",
            "site_path": "/var/www/u1/data/www/password.com",
        });
        assert_eq!(ensure_no_secrets(&v), Ok(()));
    }

    #[test]
    fn ensure_no_secrets_rejects_auth_key_and_api_key_names() {
        assert_eq!(
            ensure_no_secrets(&json!({"auth_key": "x"})),
            Err("auth_key".to_string())
        );
        assert_eq!(
            ensure_no_secrets(&json!({"recovery_api_key_b64": "x"})),
            Err("recovery_api_key_b64".to_string())
        );
    }

    // Секрет может лежать не в корне: тело собирается из вложенных структур.
    #[test]
    fn ensure_no_secrets_walks_nested_objects_and_arrays() {
        let nested = json!({"db": {"db_name": "d", "db_password": "s3cret"}});
        assert_eq!(ensure_no_secrets(&nested), Err("db_password".to_string()));
        let in_array = json!({"items": [{"ok": 1}, {"ftp_password": "s3cret"}]});
        assert_eq!(ensure_no_secrets(&in_array), Err("ftp_password".to_string()));
    }

    #[test]
    fn ensure_no_secrets_accepts_a_clean_metadata_body() {
        let v = json!({
            "site_user": "u1",
            "site_path": "/var/www/u1/data/www/example.com",
            "ssl_status": "active",
            "db_name": "u1_db",
            "db_user": "u1_dbu",
            "last_provision_error": null,
        });
        assert_eq!(ensure_no_secrets(&v), Ok(()));
    }
}
