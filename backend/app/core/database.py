from typing import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.core.config import ASYNCPG_CONNECT_ARGS, settings

# Through Supabase pooler, let PgBouncer own pooling; QueuePool + pooler is a common footgun.
_use_null_pool = "pooler.supabase.com" in settings.SUPABASE_DB_URL

_engine_kw: dict = {
    "echo": False,
    "future": True,
    "connect_args": dict(ASYNCPG_CONNECT_ARGS),
}
if _use_null_pool:
    _engine_kw["poolclass"] = NullPool
else:
    _engine_kw.update(
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=300,
    )

engine = create_async_engine(settings.SUPABASE_DB_URL, **_engine_kw)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session

@asynccontextmanager
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
