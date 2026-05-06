import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    salt_b64: str = Field(min_length=16, max_length=64)
    auth_key_b64: str = Field(min_length=32, max_length=128)
    recovery_blob_b64: str = Field(min_length=64, max_length=512)


class LoginStartRequest(BaseModel):
    email: EmailStr


class LoginStartResponse(BaseModel):
    salt_b64: str


class LoginFinishRequest(BaseModel):
    email: EmailStr
    auth_key_b64: str
    totp_code: Optional[str] = None


class UserMeResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    email_confirmed_at: Optional[datetime] = None
    totp_enabled: bool


class ConfirmEmailRequest(BaseModel):
    token: str


class RecoveryStartRequest(BaseModel):
    email: EmailStr


class RecoveryStartResponse(BaseModel):
    salt_b64: str
    recovery_blob_b64: str


class RecoveryFinishRequest(BaseModel):
    email: EmailStr
    new_salt_b64: str
    new_auth_key_b64: str
    new_recovery_blob_b64: str


class ChangePasswordRequest(BaseModel):
    old_auth_key_b64: str
    new_salt_b64: str
    new_auth_key_b64: str
    re_encrypted_blobs: list[dict]


class TotpEnableResponse(BaseModel):
    provisioning_uri: str
    secret: str


class TotpVerifyRequest(BaseModel):
    code: str
