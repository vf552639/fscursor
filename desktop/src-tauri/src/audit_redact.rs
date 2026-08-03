//! Guards so nothing we push to the server carries an obvious secret field name.
//!
//! Две функции с разной силой и разным назначением:
//!
//! * [`redact_check_metadata`] — debug-only проверка аудит-метаданных. В release
//!   её нет: аудит собирается вручную из литералов, и падать в проде из-за него
//!   хуже, чем не записать строчку.
//! * [`ensure_no_secrets`] — жёсткая проверка для write-back'а результатов
//!   провижининга. Там тело собирается из данных, пришедших с чужого сервера, и
//!   `debug_assert` в release-сборке означал бы «инварианта нет вовсе».

/// Маркеры секретов в сериализованном (уже приведённом к нижнему регистру) JSON.
///
/// `password` — без кавычек: пароль опасен и в ключе, и в значении. `auth_key` и
/// `api_key` — в кавычках: это имена полей, а как подстрока они встречаются в
/// безобидных текстах.
const SECRETISH: [&str; 3] = ["password", "\"auth_key\"", "\"api_key\""];

/// Первый найденный секретоподобный маркер, если он есть.
fn find_secretish(v: &serde_json::Value) -> Option<&'static str> {
    let s = serde_json::to_string(v).unwrap_or_default().to_lowercase();
    SECRETISH.into_iter().find(|m| s.contains(m))
}

pub fn redact_check_metadata(v: &serde_json::Value) {
    debug_assert!(
        find_secretish(v).is_none(),
        "audit metadata must not contain {:?}",
        find_secretish(v)
    );
}

/// Проверка, которая работает и в release: возвращает найденный маркер, чтобы
/// вызывающий отказался отправлять тело, а не «отправил и понадеялся».
pub fn ensure_no_secrets(v: &serde_json::Value) -> Result<(), &'static str> {
    match find_secretish(v) {
        Some(marker) => Err(marker),
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
    fn ensure_no_secrets_rejects_a_password_field() {
        let v = json!({"site_user": "u", "db_password": "s3cret"});
        assert_eq!(ensure_no_secrets(&v), Err("password"));
    }

    #[test]
    fn ensure_no_secrets_rejects_a_password_in_a_value_too() {
        // Ключа `password` нет, но значение — пароль под безобидным именем.
        // Отличить одно от другого мы не можем, поэтому отказываем.
        let v = json!({"site_user": "PassWord"});
        assert_eq!(ensure_no_secrets(&v), Err("password"));
    }

    #[test]
    fn ensure_no_secrets_rejects_auth_key_and_api_key() {
        assert_eq!(
            ensure_no_secrets(&json!({"auth_key": "x"})),
            Err("\"auth_key\"")
        );
        assert_eq!(
            ensure_no_secrets(&json!({"api_key": "x"})),
            Err("\"api_key\"")
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
}
