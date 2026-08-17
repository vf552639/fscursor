import uuid
from datetime import datetime
from typing import Annotated, Optional

from pydantic import BaseModel, EmailStr, Field

# aead(VK, KEK) = nonce 24 + тег 16 + ключ 32 = ровно 72 байта, то есть ровно 96
# символов base64. Граница точная намеренно: содержимое обёртки сервер проверить
# не может по построению — это непрозрачный шифротекст, и длина всё, что ему
# видно. Кривая обёртка, однажды принятая, лежит в колонке навсегда и стоит
# владельцу всех секретов; 422 стоит клиенту одной сборки.
WrappedVaultKeyB64 = Annotated[str, Field(min_length=96, max_length=96)]


class RegisterRequest(BaseModel):
    email: EmailStr
    salt_b64: str = Field(min_length=16, max_length=64)
    auth_key_b64: str = Field(min_length=32, max_length=128)
    recovery_blob_b64: str = Field(min_length=64, max_length=512)
    # Argon2id(phrase, salt=b"sdmp-recovery-v1", context="sdmp-recovery-key-v1"), 32 байта.
    recovery_auth_key_b64: str = Field(min_length=32, max_length=128)
    # Обязательное: новый аккаунт рождается с ключом хранилища, NULL в колонке
    # значит совсем другое — «заведён до перехода» (см. `User.wrapped_vault_key`).
    wrapped_vault_key_b64: WrappedVaultKeyB64


class LoginStartRequest(BaseModel):
    email: EmailStr


class LoginStartResponse(BaseModel):
    salt_b64: str


class LoginFinishRequest(BaseModel):
    email: EmailStr
    auth_key_b64: str
    totp_code: Optional[str] = None


class LoginFinishResponse(BaseModel):
    user_id: uuid.UUID
    # None = аккаунт до перехода на VK: клиент выводит ключ по-старому и
    # закрепляет его обёрткой через /auth/vault-key/init.
    wrapped_vault_key_b64: Optional[str] = None


class UserMeResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    email_confirmed_at: Optional[datetime] = None
    totp_enabled: bool
    # True ровно тогда, когда /auth/recovery/finish не ответит 409 (см. routes.me).
    recovery_configured: bool = False
    # Соль и обёртка VK здесь же, чтобы вебу хватало одного аутентифицированного
    # вызова: раньше за солью он ходил в анонимный /auth/login/start.
    # None = аккаунт до перехода на VK, клиенту предстоит /auth/vault-key/init.
    salt_b64: str
    wrapped_vault_key_b64: Optional[str] = None


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
    # Границы те же, что у одноимённых полей регистрации: соль тут перезаписывает
    # `users.salt`, и пустая строка увела бы клиента выводить KEK на пустой соли —
    # а KEK теперь единственное, что закрывает VK, то есть все секреты аккаунта.
    new_salt_b64: str = Field(min_length=16, max_length=64)
    new_auth_key_b64: str = Field(min_length=32, max_length=128)
    new_recovery_blob_b64: str = Field(min_length=64, max_length=512)
    # VK, переобёрнутый ключом из нового пароля. Обязательное: без него поворот
    # соли и пароля отрезал бы владельца от собственных блобов, а клиент, не
    # знающий про VK, должен упереться в 422, а не добить аккаунт молча.
    new_wrapped_vault_key_b64: WrappedVaultKeyB64
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


class VaultKeyInitRequest(BaseModel):
    """Ленивая миграция аккаунта, заведённого до перехода на ключ хранилища."""

    wrapped_vault_key_b64: WrappedVaultKeyB64


class ChangePasswordRequest(BaseModel):
    old_auth_key_b64: str = Field(min_length=32, max_length=128)
    # См. `RecoveryFinishRequest`: тот же поворот соли и пароля, те же границы.
    new_salt_b64: str = Field(min_length=16, max_length=64)
    new_auth_key_b64: str = Field(min_length=32, max_length=128)
    # Всё, что меняется вместе с паролем: VK прежний, новый лишь ключ, которым он
    # обёрнут. Прежнее поле `re_encrypted_blobs` (клиент перешифровывал блобы
    # своими силами) исчезло вместе с самой необходимостью их трогать.
    new_wrapped_vault_key_b64: WrappedVaultKeyB64


class TotpEnableResponse(BaseModel):
    provisioning_uri: str
    secret: str


class TotpVerifyRequest(BaseModel):
    code: str
