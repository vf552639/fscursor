"""Смена пароля переворачивает 72 байта обёртки и не трогает блобы.

Раньше `POST /api/auth/password/change` принимал `re_encrypted_blobs`: клиент
обязан был скачать все блобы, перешифровать их новым выведенным из пароля
ключом и прислать обратно. Схема была не только дорогой, но и хрупкой —
частично применённый список оставлял часть секретов на старом ключе, а часть на
новом, и починить это было уже нечем.

С ключом хранилища блобы шифруются VK, который смена пароля не меняет вовсе;
меняется только его обёртка `users.wrapped_vault_key` = aead(VK, KEK). Отсюда
главный инвариант этого файла: после смены пароля блоб остаётся байт в байт
прежним, и его `version` не растёт — последнее и есть доказательство, что
перешифровки не было (на неё немедленно среагировал бы синк всех устройств).
"""

import base64
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app

# `from conftest`, а не `from tests.conftest`: второе написание заводит вторую
# копию модуля и обнуляет уборку (см. шапку `conftest.py`).
from conftest import register_and_login

pytestmark = pytest.mark.usefixtures("purge_test_users")


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


OLD_AUTH_KEY = b"\x01" * 32
NEW_AUTH_KEY = b"\x21" * 32
NEW_SALT = b"\x20" * 16
CIPHERTEXT = b"\x30" * 96
# aead(VK, KEK) на новом пароле: nonce 24 + тег 16 + ключ 32.
NEW_WRAPPED_VK = b"\x31" * 72


def _change_body(**extra) -> dict:
    body = {
        "old_auth_key_b64": b64(OLD_AUTH_KEY),
        "new_salt_b64": b64(NEW_SALT),
        "new_auth_key_b64": b64(NEW_AUTH_KEY),
        "new_wrapped_vault_key_b64": b64(NEW_WRAPPED_VK),
    }
    body.update(extra)
    return body


async def _user_state(email: str) -> tuple[bytes, bytes, bytes | None]:
    """Всё, что password/change имеет право менять.

    `auth_key_hash` здесь не для красоты: хендлер пишет его вторым, сразу за
    солью, и снимок без него не заметил бы затёртого пароля на сторожимом
    пути 401.
    """
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        return (
            bytes(user.salt),
            bytes(user.auth_key_hash),
            bytes(user.wrapped_vault_key) if user.wrapped_vault_key is not None else None,
        )


@pytest.mark.asyncio
async def test_password_change_rewraps_vault_key_and_leaves_blobs_alone():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        email = await register_and_login(c, "pwch", key=OLD_AUTH_KEY)
        blob_id = str(uuid.uuid4())
        r = await c.put(
            f"/api/blobs/{blob_id}",
            json={"blob_kind": "ssh_password", "ciphertext_b64": b64(CIPHERTEXT)},
        )
        assert r.status_code == 200, r.text
        before = r.json()

        r = await c.post("/api/auth/password/change", json=_change_body())
        assert r.status_code == 200, r.text

        salt, _auth_key_hash, wrapped = await _user_state(email)
        assert salt == NEW_SALT
        assert wrapped == NEW_WRAPPED_VK

        # Тот же шифротекст, та же версия, то же время правки: блоба никто не касался.
        assert (await c.get(f"/api/blobs/{blob_id}")).json() == before

        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(OLD_AUTH_KEY)},
        )
        assert r.status_code == 401, r.text
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(NEW_AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        assert r.json()["wrapped_vault_key_b64"] == b64(NEW_WRAPPED_VK)


@pytest.mark.asyncio
async def test_password_change_without_wrapped_vault_key_is_rejected():
    """Обёртка обязательна — и тест сторожит именно обязательность.

    Проверка «снимок не изменился» здесь почти тавтологична: Pydantic отбивает
    запрос до хендлера, так что меняться было нечему. Забор ставится не вокруг
    хендлера, а вокруг схемы: дай кто-нибудь `new_wrapped_vault_key_b64`
    значение по умолчанию — и старый билд, ничего не знающий про VK, вместо 422
    молча повернёт пароль и отрежет владельца от собственных блобов.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        email = await register_and_login(c, "pwchnovk", key=OLD_AUTH_KEY)
        before = await _user_state(email)

        body = _change_body()
        del body["new_wrapped_vault_key_b64"]
        r = await c.post("/api/auth/password/change", json=body)
        assert r.status_code == 422, r.text
        assert await _user_state(email) == before


@pytest.mark.asyncio
async def test_password_change_with_wrong_current_password_mutates_nothing():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        email = await register_and_login(c, "pwchbad", key=OLD_AUTH_KEY)
        before = await _user_state(email)

        r = await c.post(
            "/api/auth/password/change", json=_change_body(old_auth_key_b64=b64(b"\x77" * 32))
        )
        assert r.status_code == 401, r.text
        assert await _user_state(email) == before
