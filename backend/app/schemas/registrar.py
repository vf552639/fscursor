from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class RegistrarAccountBase(BaseModel):
    provider: str
    name: str
    api_user: Optional[str] = None
    is_active: bool = True


class RegistrarAccountCreate(RegistrarAccountBase):
    api_key: Optional[str] = Field(default=None, repr=False)
    api_secret: Optional[str] = Field(default=None, repr=False)


class RegistrarAccountUpdate(BaseModel):
    provider: Optional[str] = None
    name: Optional[str] = None
    api_user: Optional[str] = None
    is_active: Optional[bool] = None
    api_key: Optional[str] = Field(default=None, repr=False)
    api_secret: Optional[str] = Field(default=None, repr=False)


class RegistrarAccountResponse(RegistrarAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
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
