"""Ответ аккаунта Cloudflare — ровно про аккаунт, и состав модуля схем.

Почему у сервера нет и не может быть схем под зоны/DNS — в докстринге
`app/schemas/cloudflare.py`.

Тесты уровня схемы и сервиса, а не HTTP: роут поверх них — три строки
`response_model=`, а прогон через `AsyncClient` требует живой БД
(см. `test_user_scoping.py`), которой здесь не нужно ничего.
"""

import datetime
import uuid

from test_no_plaintext_secret_schemas import models_declared_in_schema_modules

from app.models.cloudflare_account import CloudflareAccount
from app.services.cloudflare_service import build_account_response

BLOB_ID = uuid.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")

SCHEMA_MODULE = "app.schemas.cloudflare"

# Имена строками, а не через `Класс.__name__`: с импортом обе стороны равенства
# приезжают из одного модуля, и переименование `CloudflareAccountUpdate` в
# `CloudflareZoneUpdate` гард бы не заметил — то есть не заметил бы ровно то,
# что обещает ловить.
ACCOUNT_CRUD_SCHEMAS = {
    "CloudflareAccountBase",
    "CloudflareAccountCreate",
    "CloudflareAccountUpdate",
    "CloudflareAccountResponse",
}


def _account() -> CloudflareAccount:
    """Аккаунт в памяти: `build_account_response` в БД не ходит."""
    moment = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    return CloudflareAccount(
        id=5,
        user_id=uuid.uuid4(),
        name="cf-main",
        account_id="acc-1",
        api_token_blob_id=BLOB_ID,
        is_active=True,
        created_at=moment,
        updated_at=moment,
    )


def test_build_account_response_returns_exactly_the_account():
    """Ответ = сам аккаунт плюс маска токена, и ничего сверх.

    Точный набор ключей, а не «нет вот такого поля»: ответ, обещающий то, чего
    сервер не делает (итог синхронизации зон, состояние делегирования), фронт
    обязан как-то истолковать, а истолковать вечный `None` нечем.
    """
    response = build_account_response(_account())

    assert response.model_dump().keys() == {
        "id",
        "name",
        "account_id",
        "is_active",
        "api_token_blob_id",
        "api_token_masked",
        "created_at",
        "updated_at",
    }
    assert response.id == 5
    assert response.api_token_blob_id == BLOB_ID
    # Маска — единственное, что сервис добавляет от себя: сам токен он не видит.
    assert response.api_token_masked == "••••eeee"


def test_schema_module_declares_only_account_crud():
    """В `app/schemas/cloudflare.py` нет схем под то, чего сервер не делает.

    Гард однофайловый и большего не обещает: схему под зоны, заведённую в
    соседнем `app/schemas/cloudflare_zones.py`, он не увидит. Сторожится то,
    куда её положат вероятнее всего, — модуль, где такие схемы уже лежали.

    Равенство множеств, а не «нет вот этих имён»: перечень отсутствующих
    молчал бы про следующее добавленное.

    Перебор взят у `test_no_plaintext_secret_schemas` (там же он и объяснён), а
    не написан заново: две копии одного сканера разъезжаются молча.
    """
    declared = {
        model.__name__
        for model in models_declared_in_schema_modules()
        if model.__module__ == SCHEMA_MODULE
    }

    assert declared == ACCOUNT_CRUD_SCHEMAS, (
        f"состав {SCHEMA_MODULE} изменился: {declared ^ ACCOUNT_CRUD_SCHEMAS}. "
        f"Если это схема под серверный роут на зоны/DNS/проверку токена — её быть "
        f"не должно: токен расшифровывается на клиенте, у сервера его нет "
        f"(zero-knowledge). Если это ещё одна схема самого аккаунта — допиши имя "
        f"в ACCOUNT_CRUD_SCHEMAS."
    )
