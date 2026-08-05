import asyncio
import logging
from contextlib import asynccontextmanager

from typing import Any, Mapping

from fastapi import FastAPI, Request, status
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

# Обновляется ВМЕСТЕ с новой миграцией, в том же коммите: страж ниже роняет
# старт приложения, если голова в БД разошлась с этой строкой. Забыть его —
# значит получить упавший бэкенд сразу после `alembic upgrade head` (так и
# случилось при добавлении `015_server_provider`).
EXPECTED_ALEMBIC_HEAD = "015_server_provider"


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


# Секретоподобные ИМЕНА полей: значение такого поля не показываем обратно
# никогда. Список — та же конвенция, что у десктопного `SECRET_KEY_MARKERS`
# (`desktop/src-tauri/src/audit_redact.rs`), и сравнение такое же: подстрока в
# имени, приведённом к нижнему регистру, так что `db_password` ловится одним
# маркером `password`.
#
# Расхождения с десктопным списком намеренные, их три — и все в одну сторону:
# здесь маркеров больше (8 против 5), своих у десктопа нет. Состав расхождений
# сторожит `test_marker_lists_diverge_exactly_as_documented`
# (`tests/test_secret_write_path.py`): счёт в этом абзаце уже расходился с
# фактом, пока список рос.
#
# 1. `*_blob_id`: там он в ИСКЛЮЧЕНИЯХ, здесь — в маркерах. Списки решают
#    разные вопросы. Десктоп спрашивает «можно ли отправить это ПОЛЕ на
#    сервер»: ссылка на блоб отправляться обязана. Здесь вопрос другой —
#    «можно ли показать обратно ЗНАЧЕНИЕ, которое в это поле не влезло», а не
#    влезает в `*_blob_id` ровно один тип значения: плейнтекст-секрет,
#    посаженный туда опечаткой (`api_token_blob_id: token` вместо `blobId`).
#    То есть эхо показало бы секрет именно тогда, когда он там по ошибке.
# 2. `_b64` — материал учётных данных из `auth/schemas.py`: это единственные
#    поля во всём приложении с `min_length`, то есть единственные, способные
#    отдать `string_too_*` с самим значением внутри.
# 3. `fastpanel_url` — единственное имя, попавшее сюда не за имя, а за
#    содержимое; подробности у самой строки в кортеже ниже. Десктопу такой
#    маркер не нужен: он это значение чистит на месте разбора
#    (`provision/fastpanel_install.rs`), а не показывает обратно.
#
# Почему в списке `token` и `secret`, раз расхождения с десктопом их больше не
# касаются: причина здесь СВОЯ, за десктопной ссылкой её не найти. Там за этими
# маркерами стоят блобы `cloudflare_api_token`/`registrar_api_secret`, здесь
# плейнтекст-полей с такими именами схемы не объявляют вовсе
# (`api_token`/`api_secret` отбиваются как `extra_forbidden`, а он `input`
# прячет и без имени). Держит их `ConfirmEmailRequest.token`
# (`auth/schemas.py`): он живёт без `min_length`, и в день, когда ограничение
# туда добавят, `string_too_*` вернул бы сам токен. Не удалять как «дубль
# десктопного списка»: на это есть кейсы `секретное-имя-token` и
# `секретное-имя-secret` в `tests/test_secret_write_path.py`.
#
# Цена: `salt_b64` глушится зря — соль секретом не является, сервер сам отдаёт
# её в `LoginStartResponse`. Диагностику это ослабляет ровно на «какую строку
# прислали вместо соли», и переживать это дешевле, чем вести список исключений
# рядом со списком маркеров.
#
# У списка есть третий потребитель, и читает он его в ДРУГОМ смысле:
# `tests/test_no_plaintext_secret_schemas.py` берёт эти маркеры как словарь
# секретоподобных ИМЁН и ругается на схему, объявившую такое поле под текст.
# Здесь же список означает «чьё значение нельзя вернуть клиенту» — а это не
# одно и то же, и натяжение видно на `fastpanel_url`: имя не секретное, поэтому
# гарду пришлось завести четыре записи в своём `ALLOWED_TEXT_FIELDS` (из семи
# всего). Каждый следующий маркер, добавленный по echo-причине, потребует того
# же. Терпимо, потому что fail-closed: гард краснеет, а не молчит, и записи в
# нём — видимый в диффе акт. Но если таких маркеров станет заметно больше,
# правильный шаг — развести списки, а не растить исключения.
#
# Меняешь список — посмотри на все три места: десктопный `SECRET_KEY_MARKERS`,
# этот кортеж и гард схем. Соседи по смыслу, но не копии.
SECRET_NAME_MARKERS = (
    "password",
    "auth_key",
    "api_key",
    "token",
    "secret",
    "_b64",
    "_blob_id",
    # Единственное имя в списке, которое секретным не выглядит, — и попало сюда
    # именно поэтому. Валидатор `fastpanel_url` отвергает значение в том числе
    # (и в первую очередь) когда в нём сидит userinfo
    # (`https://admin:s3cr3t@ip:8888/`), то есть пароль панели: у такой ошибки
    # `input` — сам пароль. Остальные его отказы (пустая строка, не-http схема,
    # адрес без порта, control-символы) секрета не несут, и там `input`
    # гасится зря — цена та же, что у `salt_b64` выше, и платится по той же
    # причине: список ведётся по именам, а не по содержимому. Список про то,
    # чьё значение нельзя вернуть клиенту, а не про то, чьё имя похоже на
    # секрет.
    "fastpanel_url",
)


def _input_is_unsafe_to_echo(err: Mapping[str, Any]) -> bool:
    """Вернёт ли `input` этой ошибки клиенту то, чего он видеть не должен.

    Четыре признака, все — про форму ошибки, а не про список типов pydantic
    (`missing`, `model_attributes_type`, `model_type`, `dict_type`, …):
    перечисление типов пришлось бы догонять за каждой версией библиотеки, и
    первый незнакомый тип протёк бы молча.

    1. `type == "extra_forbidden"` — `input` и есть значение незаявленного
       поля, то есть в нашем сценарии сам пароль.
    2. `input` — контейнер. Pydantic кладёт в него РОДИТЕЛЯ ошибки, а не
       значение поля: у `missing` (не хватает `name`) `input` равен всему телу
       запроса, вместе с плейнтекстом, который в нём был. Регрессировавшая
       форма запросто пришлёт и лишнее поле, и недодаст обязательное.
    3. `loc == ("body",)` — ошибка про КОРЕНЬ тела (`model_attributes_type`:
       прислали список или строку вместо объекта). Признак (2) ловит только
       list/dict, а двойная сериализация (`JSON.stringify` поверх тела) даёт
       тело-строку — и она проехала бы целиком. У ошибки про корень нет имени
       поля, о котором `input` мог бы что-то диагностировать, так что терять
       тут нечего.
    4. Имя поля секретоподобное (`SECRET_NAME_MARKERS`). Скалярный `input`
       объявленного поля — тоже секрет, если поле секретное: `auth_key_b64` и
       `recovery_blob_b64` короче минимума отдают `string_too_short` с самим
       материалом внутри (и на `/auth/register`, то есть без всякой сессии), а
       `ssh_password_blob_id` с плейнтекстом вместо UUID — `uuid_parsing` с
       паролем внутри.

    Что остаётся: `input` скалярных ошибок несекретных объявленных полей
    (`int_parsing` у `ssh_port`, `value_error` у `provider`) и ошибок
    path-параметров. Без них разбор кривого запроса стал бы гаданием, и на это
    есть отдельный тест — иначе «починка» вида «снять `input` вообще» прошла
    бы незамеченной.
    """
    if err.get("type") == "extra_forbidden":
        return True
    if isinstance(err.get("input"), (dict, list)):
        return True
    loc = tuple(err.get("loc") or ())
    if loc == ("body",):
        return True
    # По всему `loc`, а не только по последнему элементу: у ошибки внутри
    # секретного поля (индекс списка, вложенный объект) имя секрета стоит
    # выше, а `input` всё тот же материал.
    return any(
        marker in str(part).lower() for part in loc for marker in SECRET_NAME_MARKERS
    )


@app.exception_handler(RequestValidationError)
async def validation_error_without_secret_input(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    """422, который не возвращает клиенту присланный плейнтекст.

    Схемы записи (`ServerCreate/Update`, `CloudflareAccount*`,
    `RegistrarAccount*`) стоят с `extra="forbid"` — это ловушка на регрессию
    «форма опять шлёт плейнтекст-секрет». Дефолтный обработчик FastAPI кладёт
    в ответ `input`, и тогда ловушка возвращает секрет обратно.

    Куда он оттуда уезжает: `frontend/src/api/client.ts` кладёт тело ответа
    целиком в `ApiError.details`, а оттуда оно попадает в состояние ошибки
    React Query и в логи. (В ТЕКСТ ошибки — нет: у 422 `detail` это массив, и
    `String(data.detail)` даёт `"[object Object]"`. Тост секрета не покажет.)
    В десктопе тело живёт в `ApiError::Status { status, body }`
    (`sync/http.rs`) — не в `ApiError::Http`, который `#[error(transparent)]`
    поверх `reqwest::Error` и тела не несёт вовсе. Плюс лог прокси.

    Отказ обязан быть громким по ИМЕНИ поля, а не по его содержимому. Что
    именно считается небезопасным — в `_input_is_unsafe_to_echo`.
    """
    errors = [
        {k: v for k, v in err.items() if k != "input"} if _input_is_unsafe_to_echo(err) else err
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=jsonable_encoder({"detail": errors}),
    )

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
