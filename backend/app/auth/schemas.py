import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    salt_b64: str = Field(min_length=16, max_length=64)
    auth_key_b64: str = Field(min_length=32, max_length=128)
    recovery_blob_b64: str = Field(min_length=64, max_length=512)
    # Argon2id(phrase, salt=b"sdmp-recovery-v1", context="sdmp-recovery-key-v1"), 32 байта.
    recovery_auth_key_b64: str = Field(min_length=32, max_length=128)


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
    # True ровно тогда, когда /auth/recovery/finish не ответит 409 (см. routes.me).
    recovery_configured: bool = False


class ConfirmEmailRequest(BaseModel):
    token: str


class RecoveryStartRequest(BaseModel):
    email: EmailStr


class RecoveryStartResponse(BaseModel):
    salt_b64: str
    recovery_blob_b64: str


class RecoveryFinishRequest(BaseModel):
    email: EmailStr
    # Доказательство владения recovery-фразой: тот же вывод, что лёг в хеш при
    # регистрации / recovery/setup. Обязателен.
    recovery_auth_key_b64: str = Field(min_length=32, max_length=128)
    new_salt_b64: str
    new_auth_key_b64: str
    new_recovery_blob_b64: str
    # Заполняется только если клиент выдал НОВУЮ recovery-фразу в процессе
    # восстановления: тогда хеш надо перезаписать, иначе аккаунт станет
    # невосстановимым. Пусто => хеш остаётся прежним.
    new_recovery_auth_key_b64: Optional[str] = Field(
        default=None, min_length=32, max_length=128
    )


class RecoverySetupRequest(BaseModel):
    """(Пере)настройка recovery из-под живой сессии."""

    # Текущий auth_key (пароль) — step-up для деструктивной операции.
    auth_key_b64: str = Field(min_length=32, max_length=128)
    recovery_blob_b64: str = Field(min_length=64, max_length=512)
    recovery_auth_key_b64: str = Field(min_length=32, max_length=128)


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
