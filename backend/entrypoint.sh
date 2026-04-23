#!/bin/sh
set -e
cd /app

# Ensure long Alembic revision ids fit in alembic_version.version_num.
# Safe on fresh DBs because table may not exist yet.
python -c '
import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import settings

async def main():
    engine = create_async_engine(settings.SUPABASE_DB_URL)
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

alembic upgrade head
exec "$@"
