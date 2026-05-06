use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
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
    apply_schema(&conn)?;
    Ok(conn)
}

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
