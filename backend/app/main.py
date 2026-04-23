from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.routes import api_router
from app.core.config import settings
from app.core.database import engine

EXPECTED_ALEMBIC_HEAD = "002_domain_purchase_and_notifications"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with engine.connect() as conn:
        try:
            result = await conn.execute(text("SELECT version_num FROM alembic_version"))
        except Exception as exc:
            raise RuntimeError(
                "Cannot read alembic_version (migrations missing?). "
                "Check: docker compose logs backend | grep -i alembic"
            ) from exc
        row = result.fetchone()
        if not row:
            raise RuntimeError("alembic_version is empty; run alembic upgrade head before starting the API.")
        if row[0] != EXPECTED_ALEMBIC_HEAD:
            raise RuntimeError(
                f"Database migration mismatch: alembic_version={row[0]!r}, "
                f"expected {EXPECTED_ALEMBIC_HEAD!r}. Run: alembic upgrade head"
            )
    yield


app = FastAPI(title="Server & Domain Management Panel", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api_router, prefix=settings.API_V1_PREFIX)
