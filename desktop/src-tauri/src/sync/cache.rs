use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub fn open(path: &Path, key: &[u8; 32]) -> Result<Connection, CacheError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    let mut hex = String::with_capacity(64);
    for b in key.iter() {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    conn.pragma_update(None, "key", format!("x'{}'", hex))?;
    hex.zeroize();
    conn.busy_timeout(BUSY_TIMEOUT)?;
    apply_schema(&conn)?;
    Ok(conn)
}

/// Сколько ждать чужой записи в кэш, прежде чем признать её блокировкой.
///
/// Ставится ЯВНО, хотя мгновенного `database is locked` тут никогда и не было:
/// rusqlite сам зовёт `sqlite3_busy_timeout(db, 5000)` на каждом открытии
/// (`inner_connection.rs`), так что молчаливая пятисекундная пауза — это его
/// умолчание, а не наше решение. Полагаться на неё нельзя дважды: она может
/// уехать с версией зависимости, и по коду её не видно вовсе.
///
/// Десять секунд, а не пять: одно соединение на вызов, а вызовов бывает
/// несколько сразу — пачка доменов гоняется с конкуренцией и живёт бок о бок с
/// фоновой синхронизацией, которая пишет в тот же файл сотнями строк в одной
/// транзакции. База в обычном rollback-режиме, то есть писатель блокирует всех,
/// и упереться в таймаут значит показать пользователю провал домена там, где
/// надо было подождать.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn apply_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r"
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rows (
            table_name TEXT NOT NULL,
            id TEXT NOT NULL,
            version INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            fields TEXT,
            PRIMARY KEY (table_name, id)
        );
        CREATE TABLE IF NOT EXISTS blob_cache (
            id TEXT PRIMARY KEY,
            blob_kind TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS bulk_runs (
            idempotency_key TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            detail TEXT
        );
    ",
    )?;
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/// Latest non-deleted row fields for a synced entity (`domains`, `servers`, …).
pub fn get_row_fields(
    conn: &Connection,
    table: &str,
    id: &str,
) -> Result<Option<serde_json::Value>, CacheError> {
    let mut stmt = conn.prepare(
        "SELECT fields FROM rows WHERE table_name = ?1 AND id = ?2 AND deleted = 0",
    )?;
    let mut rows = stmt.query(params![table, id])?;
    if let Some(row) = rows.next()? {
        let s: String = row.get(0)?;
        return Ok(Some(serde_json::from_str(&s)?));
    }
    Ok(None)
}

pub fn bulk_run_upsert_start(
    conn: &Connection,
    key: &str,
    action: &str,
    detail: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO bulk_runs(idempotency_key, action, status, created_at, detail) VALUES (?1, ?2, 'running', datetime('now'), ?3)",
        params![key, action, detail],
    )?;
    Ok(())
}

pub fn bulk_run_complete(conn: &Connection, key: &str, detail: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bulk_runs SET status = 'done', detail = ?2 WHERE idempotency_key = ?1",
        params![key, detail],
    )?;
    Ok(())
}

/// Пометить прогон неудачным, чтобы повтор с тем же ключом был возможен.
///
/// Не `bulk_run_complete`: тот всегда пишет `done`, а `done` — как и `running` —
/// заставляет повторный запуск ответить `already_ran`, ничего не сделав. Прогон, брошенный
/// на середине, обязан оставить статус, по которому его можно перезапустить.
pub fn bulk_run_fail(conn: &Connection, key: &str, detail: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bulk_runs SET status = 'failed', detail = ?2 WHERE idempotency_key = ?1",
        params![key, detail],
    )?;
    Ok(())
}

/// Строка массового прогона.
///
/// `created_at` отдаётся наружу не для украшения: `running` снимается только
/// явными ветками внутри процесса, поэтому по одному статусу нельзя отличить
/// живой прогон от осиротевшего после краша. Дату записи читает
/// `bulk_run_is_stale` в `commands/provision.rs`.
pub struct BulkRun {
    pub status: String,
    pub detail: String,
    /// UTC в формате SQLite `datetime('now')`: `YYYY-MM-DD HH:MM:SS`.
    pub created_at: String,
}

pub fn bulk_run_status(conn: &Connection, key: &str) -> rusqlite::Result<Option<BulkRun>> {
    let mut stmt = conn.prepare(
        "SELECT status, IFNULL(detail, ''), created_at FROM bulk_runs WHERE idempotency_key = ?1",
    )?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(BulkRun {
            status: row.get(0)?,
            detail: row.get(1)?,
            created_at: row.get(2)?,
        }));
    }
    Ok(None)
}

pub fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_and_read_back() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let key = [42u8; 32];
        let conn = open(&path, &key).unwrap();
        set_meta(&conn, "version", "5").unwrap();
        drop(conn);
        let conn = open(&path, &key).unwrap();
        assert_eq!(get_meta(&conn, "version").unwrap().as_deref(), Some("5"));
    }

    /// Пачка доменов гоняется с конкуренцией и живёт рядом с фоновой
    /// синхронизацией: два писателя в один файл — норма, а не край.
    ///
    /// Проверяется И само ожидание, И его величина. Одного сценария мало:
    /// умолчание rusqlite (5s) вывезет его и с удалённым `busy_timeout` —
    /// то есть тест, который «держит» настройку, на деле не держал бы ничего.
    /// Поэтому рядом стоит чтение `PRAGMA busy_timeout`: оно отличает наше
    /// решение от чужого умолчания.
    #[test]
    fn a_writer_waits_out_a_concurrent_transaction_instead_of_failing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let key = [3u8; 32];
        // Схему создаёт первый открывающий — дальше речь только о блокировке.
        let holder = open(&path, &key).unwrap();
        let timeout_ms: i64 = holder
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(timeout_ms, BUSY_TIMEOUT.as_millis() as i64);

        holder.execute_batch("BEGIN IMMEDIATE").unwrap();

        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let conn = open(&writer_path, &key).unwrap();
            set_meta(&conn, "version", "9")
        });

        std::thread::sleep(std::time::Duration::from_millis(200));
        holder.execute_batch("COMMIT").unwrap();

        writer
            .join()
            .unwrap()
            .expect("писатель обязан дождаться чужого коммита, а не упасть");
        assert_eq!(get_meta(&holder, "version").unwrap().as_deref(), Some("9"));
    }

    // Брошенный на середине прогон обязан стать перезапускаемым: `running` и
    // `done` — те два статуса, при которых provision_bulk отвечает
    // `already_ran`, не запустив ни одного домена.
    #[test]
    fn failed_bulk_run_leaves_a_retryable_status() {
        let dir = tempdir().unwrap();
        let conn = open(&dir.path().join("cache.db"), &[7u8; 32]).unwrap();
        bulk_run_upsert_start(&conn, "k1", "provision_bulk", "[\"1\"]").unwrap();
        assert_eq!(
            bulk_run_status(&conn, "k1").unwrap().unwrap().status,
            "running"
        );

        bulk_run_fail(&conn, "k1", "failed on domain 1: boom").unwrap();
        let run = bulk_run_status(&conn, "k1").unwrap().unwrap();
        assert_ne!(run.status, "running");
        assert_ne!(run.status, "done");
        assert!(run.detail.contains("boom"));

        // И повторный старт с тем же ключом снова переводит его в running.
        bulk_run_upsert_start(&conn, "k1", "provision_bulk", "[\"1\"]").unwrap();
        assert_eq!(
            bulk_run_status(&conn, "k1").unwrap().unwrap().status,
            "running"
        );
    }

    // Без даты старта живой прогон неотличим от осиротевшего после краша: и то,
    // и другое — строка `running`.
    #[test]
    fn a_started_run_records_when_it_started() {
        let dir = tempdir().unwrap();
        let conn = open(&dir.path().join("cache.db"), &[7u8; 32]).unwrap();
        bulk_run_upsert_start(&conn, "k2", "provision_bulk", "[\"1\"]").unwrap();
        let run = bulk_run_status(&conn, "k2").unwrap().unwrap();
        assert!(
            chrono::NaiveDateTime::parse_from_str(&run.created_at, "%Y-%m-%d %H:%M:%S").is_ok(),
            "created_at не разбирается: {:?}",
            run.created_at
        );
    }

    #[test]
    fn wrong_key_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let conn = open(&path, &[1u8; 32]).unwrap();
        set_meta(&conn, "k", "v").unwrap();
        drop(conn);
        let r = open(&path, &[2u8; 32]);
        assert!(r.is_err(), "wrong key must not open SQLCipher database");
    }
}
