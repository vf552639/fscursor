"""Схемы Cloudflare — только CRUD аккаунта, и это не недоделка.

Зоны, DNS-записи, проверка токена и сброс кэша живут в десктопе (команды `cf_*`):
токен расшифровывается на клиенте, у сервера его нет и не будет. Схемы под них
(`ZoneResponse`, `DnsRecord*`, `NameserversResponse`, `PurgeResponse`,
`CloudflareTestResponse`, `CloudflareRaw`) остались от дозеро-ноледж эпохи и
лежали здесь мёртвыми — готовой формой под роут, которого быть не должно.
Оттуда же были `sync_result`/`sync_warning` в ответе аккаунта: серверной
синхронизации зон нет, так что фронт всегда получал `None` и всегда рисовал
жёлтое «zone sync did not complete» на успешном создании.
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
