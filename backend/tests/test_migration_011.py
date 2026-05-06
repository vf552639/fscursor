import pytest
from sqlalchemy import inspect

from app.core.database import engine


@pytest.mark.asyncio
async def test_011_creates_zero_knowledge_tables():
    async with engine.connect() as conn:

        def check(sync_conn):
            insp = inspect(sync_conn)
            tables = set(insp.get_table_names())
            assert {"users", "sessions", "blob_storage", "audit_log", "recovery_blob", "sync_state"} <= tables
            assert "server_secrets" not in tables, "server_secrets must be dropped"
            domain_cols = {c["name"] for c in insp.get_columns("domains")}
            assert "user_id" in domain_cols
            assert "ftp_password_encrypted" not in domain_cols
            assert "db_password_encrypted" not in domain_cols
            assert "ftp_password_blob_id" in domain_cols
            assert "db_password_blob_id" in domain_cols
            server_cols = {c["name"] for c in insp.get_columns("servers")}
            assert "user_id" in server_cols
            assert "ssh_password_encrypted" not in server_cols
            assert "fastpanel_password_encrypted" not in server_cols
            assert "ssh_password_blob_id" in server_cols
            assert "fastpanel_password_blob_id" in server_cols

        await conn.run_sync(check)
