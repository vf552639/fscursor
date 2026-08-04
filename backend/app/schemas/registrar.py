from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RegistrarAccountBase(BaseModel):
    provider: str
    name: str
    api_user: Optional[str] = None
    is_active: bool = True


class RegistrarAccountCreate(RegistrarAccountBase):
    # Незнакомое поле — 422, а не тишина: плейнтекст `api_key`/`api_secret` с
    # дефолтным `extra="ignore"` молча выбрасывался, а аккаунт оставался с
    # `*_blob_id = NULL`. `forbid` только здесь и на `Update`:
    # `RegistrarAccountResponse` наследует ту же базу и собирается из ORM.
    model_config = ConfigDict(extra="forbid")

    api_key_blob_id: Optional[UUID] = None
    api_secret_blob_id: Optional[UUID] = None


class RegistrarAccountUpdate(BaseModel):
    # См. `RegistrarAccountCreate`.
    model_config = ConfigDict(extra="forbid")

    provider: Optional[str] = None
    name: Optional[str] = None
    api_user: Optional[str] = None
    is_active: Optional[bool] = None
    api_key_blob_id: Optional[UUID] = None
    api_secret_blob_id: Optional[UUID] = None


class RegistrarAccountResponse(RegistrarAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    # Не секреты, а непрозрачные ссылки, и форме правки они обязательны: без
    # них она не знает, какой блоб перезаписывать, и заведёт новый — аккаунт
    # останется указывать на прежний ключ. `ServerResponse` и
    # `CloudflareAccountResponse` свои отдают по той же причине.
    api_key_blob_id: Optional[UUID] = None
    api_secret_blob_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class RegistrarTestResponse(BaseModel):
    success: bool
    message: str


class RegistrarDomain(BaseModel):
    domain: Optional[str] = None
    expiry_date: Optional[str] = None
    status: Optional[str] = None
    nameservers: list[str] = []
