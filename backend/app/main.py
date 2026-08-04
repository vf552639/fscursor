import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text

from app.api.routes import api_router
from app.core.config import settings
from app.core.database import engine
from app.core.logging import add_loguru_intercept_handler, configure_logging
from app.core.rate_limit import limiter

logger = logging.getLogger(__name__)

EXPECTED_ALEMBIC_HEAD = "014_recovery_auth_key"


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


@app.exception_handler(RequestValidationError)
async def validation_error_without_extra_input(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    """422, который не возвращает клиенту присланный плейнтекст.

    Схемы записи (`ServerCreate/Update`, `CloudflareAccount*`,
    `RegistrarAccount*`) стоят с `extra="forbid"` — это ловушка на регрессию
    «форма опять шлёт плейнтекст-секрет». Дефолтный обработчик FastAPI кладёт
    в ответ `input`, и тогда ловушка возвращает секрет обратно: фронт
    подставляет `detail` в текст ошибки (`api/client.ts`), оттуда он идёт в
    тост и в кэш мутаций; десктоп кладёт тело в `ApiError::Http`
    (`sync/http.rs`); прокси пишет его в лог. Отказ обязан быть громким по
    ИМЕНИ поля, а не по его содержимому.

    Снимаем `input` по двум признакам.

    1. `type == "extra_forbidden"` — здесь `input` и есть значение
       незаявленного поля, то есть в нашем сценарии сам пароль.
    2. `input` — контейнер (dict/list). Pydantic подставляет в него РОДИТЕЛЬ
       ошибки, а не значение поля: у `missing` (не хватает `name`) и у
       `model_attributes_type` (тело — список) `input` равен всему телу
       запроса целиком, вместе с любым плейнтекстом, который туда попал.
       Регрессировавшая форма вполне может заодно недодать обязательное поле —
       и тогда одного признака (1) не хватило бы.

    Признак (2) структурный, а не список типов (`missing`,
    `model_attributes_type`, `model_type`, `dict_type`, …): перечисление
    пришлось бы догонять за каждой версией pydantic, и первый же незнакомый
    тип с телом внутри протёк бы молча. И не `loc == ["body"]`: у `missing`
    loc указывает на поле (`["body","name"]`), а `input` — всё равно всё тело.

    Что сохраняется: `input` скалярных ошибок объявленных полей
    (`int_parsing` у порта, `uuid_parsing` у id блоба, `string_too_short`) и
    ошибок path-параметров. Плейнтекст-секретов среди объявленных полей нет —
    в этом и смысл фазы, — а без этих значений диагностика стала бы гаданием.
    """
    errors = [
        {k: v for k, v in err.items() if k != "input"}
        if err.get("type") == "extra_forbidden" or isinstance(err.get("input"), (dict, list))
        else err
        for err in exc.errors()
    ]
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": errors}))

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
