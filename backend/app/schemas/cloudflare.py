"""Схемы Cloudflare — только CRUD аккаунта, и это не недоделка.

Зоны, DNS-записи, проверка токена, сброс кэша — команды `cf_*` в десктопе: токен
расшифровывается на клиенте, у сервера его нет и не будет. Поэтому и схем под них
здесь нет: схема — это форма под роут, а роут на зоны означал бы токен Cloudflare
на сервере. По той же причине ответ аккаунта не рассказывает про зоны (сервер их
не видит) — он ровно про аккаунт.

Состав модуля сторожит `tests/test_cloudflare_account_response.py`.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CloudflareAccountBase(BaseModel):
    name: str
    account_id: Optional[str] = None
    is_active: bool = True


class CloudflareAccountCreate(CloudflareAccountBase):
    # Плейнтекст `api_token` в теле — 422, а не тихо потерянный токен.
    # Почему `forbid` и почему на каждой схеме отдельно — `ServerCreate` в
    # `schemas/server.py`.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    api_token_blob_id: Optional[UUID] = None


class CloudflareAccountUpdate(BaseModel):
    # См. `CloudflareAccountCreate`.
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1)
    account_id: Optional[str] = None
    api_token_blob_id: Optional[UUID] = None
    is_active: Optional[bool] = None


class CloudflareAccountResponse(CloudflareAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    api_token_blob_id: Optional[UUID] = None
    api_token_masked: Optional[str] = None
    created_at: datetime
    updated_at: datetime
