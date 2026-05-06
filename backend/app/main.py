import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text

from app.api.routes import api_router
from app.core.config import settings
from app.core.database import engine
from app.core.logging import add_loguru_intercept_handler, configure_logging
from app.core.rate_limit import limiter

logger = logging.getLogger(__name__)

EXPECTED_ALEMBIC_HEAD = "011_zero_knowledge_v1"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    last_exc: BaseException | None = None
    for attempt in range(1, 11):
        try:
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT version_num FROM alembic_version"))
                row = result.fetchone()
            if not row:
                raise RuntimeError(
                    "alembic_version is empty; run alembic upgrade head before starting the API."
                )
            if row[0] != EXPECTED_ALEMBIC_HEAD:
                raise RuntimeError(
                    f"Database migration mismatch: alembic_version={row[0]!r}, "
                    f"expected {EXPECTED_ALEMBIC_HEAD!r}. Run: alembic upgrade head"
                )
            if attempt > 1:
                logger.info("alembic_version check succeeded on attempt %s", attempt)
            break
        except RuntimeError:
            raise
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "alembic_version check attempt %s/10 failed: %s",
                attempt,
                exc,
            )
            if attempt == 10:
                raise RuntimeError(
                    "Cannot read alembic_version after retries (DB unreachable?). "
                    "Check: docker compose logs backend | grep -i alembic; "
                    "verify SUPABASE_DB_URL / pooler upstream."
                ) from last_exc
            await asyncio.sleep(2)
    yield


app = FastAPI(title="Server & Domain Management Panel", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

configure_logging()
add_loguru_intercept_handler()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api_router, prefix=settings.API_V1_PREFIX)
