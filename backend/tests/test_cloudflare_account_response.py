"""Ответ аккаунта Cloudflare не обещает того, чего сервер не делает.

`CloudflareAccountResponse` возил `sync_result`/`sync_warning` — итог
синхронизации зон, которой на сервере нет: токен расшифровывается на клиенте, и
зоны читает десктоп (`cf_list_zones`). `build_account_response` зашивал туда
`None`, из-за чего форма создания во фронте всегда уходила в ветку «зоны не
синхронизировались» и рисовала жёлтое предупреждение поверх удачного создания.

Тест уровня схемы и сервиса, а не HTTP: роут поверх них — три строки
`response_model=`, а полный прогон через `AsyncClient` требует живой БД
(см. `test_user_scoping.py`), которой в этом сценарии не нужно ничего.
"""

import datetime
import importlib
import uuid

from pydantic import BaseModel

from app.models.cloudflare_account import CloudflareAccount
from app.schemas.cloudflare import (
    CloudflareAccountBase,
    CloudflareAccountCreate,
    CloudflareAccountResponse,
    CloudflareAccountUpdate,
)
from app.services.cloudflare_service import build_account_response

BLOB_ID = uuid.UUID("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")


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


def test_response_carries_no_sync_fields():
    """Полей нет в схеме — а не «есть, но всегда пустые».

    Пустое поле фронт обязан как-то истолковать, и толковать его нечем: `None`
    там означал одновременно «не синхронизировали» и «синхронизировать нечего».
    """
    fields = CloudflareAccountResponse.model_fields
    assert "sync_result" not in fields
    assert "sync_warning" not in fields


def test_build_account_response_returns_exactly_the_account():
    """Ответ = сам аккаунт плюс маска токена, и ничего сверх."""
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
    """В модуле нет схем под то, чего сервер не делает.

    Здесь лежали `ZoneResponse`, `DnsRecord*`, `NameserversResponse`,
    `PurgeResponse`, `CloudflareTestResponse`, `CloudflareRaw` — ни одна никуда
    не импортировалась. Это не просто мусор: готовая схема — это форма под
    роут, а роут на зоны означал бы токен Cloudflare на сервере, то есть отказ
    от zero-knowledge. Гард именно на равенство множеств: «нет вот этих шести»
    молчал бы про седьмую.
    """
    module = importlib.import_module("app.schemas.cloudflare")
    declared = {
        obj.__name__
        for obj in vars(module).values()
        if isinstance(obj, type)
        and issubclass(obj, BaseModel)
        and obj.__module__ == module.__name__
    }
    assert declared == {
        CloudflareAccountBase.__name__,
        CloudflareAccountCreate.__name__,
        CloudflareAccountResponse.__name__,
        CloudflareAccountUpdate.__name__,
    }
