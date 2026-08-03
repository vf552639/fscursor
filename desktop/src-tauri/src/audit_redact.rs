//! Guards so nothing we push to the server carries an obvious secret field name.
//!
//! Обе проверки смотрят ТОЛЬКО имена полей и никогда — значения. Причина одна
//! на двоих: значения приходят из данных пользователя (имя домена, путь
//! `/var/www/u1/data/www/password.com`, URL панели), и проверка по подстроке в
//! значении срабатывала бы на доменах вида `password.com` — там, где ничего
//! секретного нет. Для write-back'а это означало бы отказ отправлять результат
//! (то есть ровно ту потерю данных, ради устранения которой он и написан), а
//! для аудита — панику `debug_assert` в dev-сборке уже после SSH-работы;
//! паника не `Err`, поймать её нечем, и вместе с задачей умерли бы свежие
//! пароли БД и FTP, существующие только в её результате.
//!
//! Разная у них только строгость, и это осознанно:
//!
//! * [`redact_check_metadata`] — debug-only, для аудит-метаданных: провал
//!   аудита не стоит того, чтобы падать в бою.
//! * [`ensure_no_secrets`] — работает и в release, для write-back'а: возвращает
//!   `Err`, и тело не уходит в сеть вовсе.
//!
//! Цена решения: секрет, положенный под безобидным именем (`{"note": "<пароль
//! от панели>"}`), обе проверки пропустят — они смотрят имена, а имя тут
//! честное. Поэтому первая линия обороны не здесь, а в типах: у
//! `DomainWriteBack` и `ServerWriteBack` полей под пароли просто нет, положить
//! их туда некуда. Эти две проверки — вторая линия, на случай сырых тел и
//! будущих полей; добавляя поле в write-back-структуру, полагаться на них как
//! на единственную защиту нельзя.

/// Секретоподобные ИМЕНА полей. Сравниваются как подстрока имени в нижнем
/// регистре, поэтому `db_password` и `ftp_password` ловятся одним маркером.
const SECRET_KEY_MARKERS: [&str; 3] = ["password", "auth_key", "api_key"];

/// Суффиксы имён, которые секретом не являются по построению: `*_blob_id` — это
/// ссылка на зашифрованный блоб, а не его содержимое.
///
/// Исключение не косметическое: `fastpanel_password_blob_id` уже есть в схеме
/// `ServerUpdate`, и в тот день, когда его добавят в `ServerWriteBack`, без
/// этой строчки каждый `server_write_back` начал бы возвращать `Secret` — молча,
/// одним варнингом, — и FastPanel переустанавливался бы поверх рабочего.
///
/// Именно суффикс, а не подстрока: `password_blob_id_extra` исключением не
/// является и обязан отвергаться (на это есть тест).
const NOT_A_SECRET_SUFFIXES: [&str; 1] = ["_blob_id"];

/// Первое секретоподобное ИМЯ поля — рекурсивно по объектам и массивам.
/// Скалярные значения не проверяются вовсе (см. модульный комментарий).
fn find_secret_key(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                let lower = key.to_lowercase();
                let exempt = NOT_A_SECRET_SUFFIXES.iter().any(|s| lower.ends_with(s));
                if !exempt && SECRET_KEY_MARKERS.iter().any(|m| lower.contains(m)) {
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

/// Debug-only проверка аудит-метаданных.
pub fn redact_check_metadata(v: &serde_json::Value) {
    debug_assert!(
        find_secret_key(v).is_none(),
        "audit metadata must not contain a secret-named field: {:?}",
        find_secret_key(v)
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

    // Ссылка на блоб — не секрет. Запрет на неё выключил бы write-back серверов
    // целиком в тот день, когда `fastpanel_password_blob_id` свяжут с панелью.
    #[test]
    fn ensure_no_secrets_allows_a_blob_id_reference() {
        let v = json!({
            "fastpanel_status": "installed",
            "fastpanel_password_blob_id": "6f1a0c66-0b3a-4a1e-9c7c-2f9a4d1a77e1",
            "ssh_password_blob_id": "8c2b1d77-1c4b-4b2f-8d8d-3f0b5e2b88f2",
        });
        assert_eq!(ensure_no_secrets(&v), Ok(()));
    }

    // Безопасность исключения держится на `ends_with`, а не на `contains`:
    // «почти блоб-id» обязан отвергаться, иначе исключение станет дырой,
    // через которую пройдёт что угодно с `_blob_id` в середине имени.
    #[test]
    fn ensure_no_secrets_rejects_a_near_miss_of_the_blob_id_exemption() {
        assert_eq!(
            ensure_no_secrets(&json!({"password_blob_id_extra": "x"})),
            Err("password_blob_id_extra".to_string())
        );
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
        assert_eq!(
            ensure_no_secrets(&in_array),
            Err("ftp_password".to_string())
        );
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

    // Регрессия: аудит провижининга кладёт в метаданные `domain_name`, взятый
    // из кэша, — метаданные собираются не только из литералов. Проверка по
    // значению роняла бы dev-сборку на домене `password.com` после всей
    // SSH-работы и уносила бы с собой пароли БД и FTP.
    #[test]
    fn redact_check_metadata_survives_a_password_shaped_domain_name() {
        redact_check_metadata(&json!({
            "action": "device.action.complete",
            "metadata": {"domain_name": "password.com", "steps": ["ssh", "create_site"]},
        }));
    }

    #[test]
    #[should_panic(expected = "secret-named field")]
    fn redact_check_metadata_still_catches_a_secret_named_field() {
        redact_check_metadata(&json!({"metadata": {"db_password": "s3cret"}}));
    }
}
