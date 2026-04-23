#!/bin/sh
set -e
cd /app

# Ensure long Alembic revision ids fit in alembic_version.version_num.
# Safe on fresh DBs because table may not exist yet.
python -c '
import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import ASYNCPG_CONNECT_ARGS, settings

async def main():
    engine = create_async_engine(
        settings.SUPABASE_DB_URL,
        connect_args=dict(ASYNCPG_CONNECT_ARGS),
    )
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "ALTER TABLE IF EXISTS alembic_version "
                "ALTER COLUMN version_num TYPE VARCHAR(255)"
            )
        )
    await engine.dispose()

asyncio.run(main())
' 2>/dev/null || true

# Wait for DB (pooler/upstream can flap on cold start). 12 × 5s ≈ 60s max.
python <<'WAIT_DB'
import asyncio
import os
import sys

import asyncpg


def pg_dsn() -> str:
    url = os.environ["SUPABASE_DB_URL"]
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def wait_for_db() -> None:
    last_exc: BaseException | None = None
    for attempt in range(1, 13):
        try:
            conn = await asyncpg.connect(
                pg_dsn(),
                statement_cache_size=0,
                timeout=15,
            )
            try:
                await conn.fetchval("SELECT 1")
            finally:
                await conn.close()
            print(f"wait-for-db: ok on attempt {attempt}", flush=True)
            return
        except Exception as exc:
            last_exc = exc
            print(
                f"wait-for-db: attempt {attempt}/12 failed: {type(exc).__name__}: {exc}",
                flush=True,
            )
            if attempt == 12:
                raise RuntimeError(
                    "wait-for-db: giving up after 12 attempts (~60s). "
                    "Check SUPABASE_DB_URL (pooler host/port/user) or use direct DB URL; "
                    "see .env.example fallback comment."
                ) from last_exc
            await asyncio.sleep(5)


asyncio.run(wait_for_db())
WAIT_DB

alembic upgrade head
exec "$@"
