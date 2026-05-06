use base64::Engine;

use crate::sync::{cache, http::ApiClient};
use anyhow::Context;
use rusqlite::params;
use std::path::PathBuf;

pub struct SyncClient {
    pub api: ApiClient,
    pub cache_path: PathBuf,
}

impl SyncClient {
    pub fn new(api: ApiClient, cache_path: PathBuf) -> Self {
        Self { api, cache_path }
    }

    pub async fn pull(&self, user_id: &str) -> anyhow::Result<u64> {
        let key = crate::keychain::load_master_key(user_id)
            .map_err(|e| anyhow::anyhow!("{}", e))?
            .ok_or_else(|| anyhow::anyhow!("master key not in keychain"))?;
        self.pull_with_key(&key).await
    }

    pub async fn pull_with_key(&self, key: &[u8; 32]) -> anyhow::Result<u64> {
        let conn = cache::open(&self.cache_path, key).map_err(|e| anyhow::anyhow!("{}", e))?;
        let last = cache::get_meta(&conn, "last_version")?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let changes = self.api.sync_changes(last).await?;
        for row in &changes.rows {
            let fields_json: Option<String> = row.fields.as_ref().map(|f| f.to_string());
            conn.execute(
                "INSERT OR REPLACE INTO rows(table_name, id, version, deleted, fields) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.table.as_str(),
                    row.id.as_str(),
                    row.version as i64,
                    if row.deleted { 1i64 } else { 0i64 },
                    fields_json,
                ],
            )
            .context("upsert sync row")?;
        }
        for blob_id in &changes.blob_ids {
            let blob = self.api.blob_get(blob_id).await?;
            let ct = base64::engine::general_purpose::STANDARD.decode(&blob.ciphertext_b64)?;
            conn.execute(
                "INSERT OR REPLACE INTO blob_cache(id, blob_kind, ciphertext, version, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    blob.id.as_str(),
                    blob.blob_kind.as_str(),
                    ct,
                    blob.version,
                    blob.updated_at.as_str(),
                    if blob.deleted { 1i64 } else { 0i64 },
                ],
            )
            .context("cache blob")?;
        }
        cache::set_meta(&conn, "last_version", &changes.version.to_string())?;
        Ok(changes.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn pull_writes_rows_to_cache() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sync/changes"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "version": 3,
                "rows": [{
                    "table": "domains",
                    "id": "d1",
                    "version": 2,
                    "deleted": false,
                    "fields": {"name": "x.com"}
                }],
                "blob_ids": []
            })))
            .mount(&srv)
            .await;

        let dir = tempdir().unwrap();
        let dbpath = dir.path().join("s.db");
        let key = [7u8; 32];
        cache::open(&dbpath, &key).unwrap();

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let client = SyncClient::new(api, dbpath.clone());
        let v = client.pull_with_key(&key).await.unwrap();
        assert_eq!(v, 3);

        let conn = cache::open(&dbpath, &key).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM rows WHERE table_name = 'domains'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
