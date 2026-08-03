"""Recovery требует доказательства владения recovery-фразой.

До этого спринта `POST /api/auth/recovery/finish` принимал только email и новые
ключи: любой, кто знал зарегистрированный адрес, перезаписывал salt,
auth_key_hash и recovery-блоб — владелец терял вход, а блобы в `blob_storage`
оставались зашифрованными на старом мастер-ключе, то есть данные не
восстанавливал уже никто. Теперь клиент обязан предъявить `recovery_auth_key`
(Argon2id от фразы, контекст "sdmp-recovery-key-v1"), сервер держит его
bcrypt-хеш в `recovery_blob.recovery_auth_key_hash` и сверяет ДО любой мутации.
"""

import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.auth.models import RecoveryBlob, Session as DbSession, User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


AUTH_KEY = b"\x01" * 32
BLOB = b"\x02" * 96
REC_KEY = b"\x03" * 32
WRONG_REC_KEY = b"\x99" * 32


async def _register_and_confirm(c: AsyncClient, email: str, rec_key: bytes = REC_KEY) -> None:
    r = await c.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(AUTH_KEY),
            "recovery_blob_b64": b64(BLOB),
            "recovery_auth_key_b64": b64(rec_key),
        },
    )
    assert r.status_code == 201, r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(
                email_confirmed_at=datetime.now(timezone.utc),
                email_confirm_token_hash=None,
            )
        )
        await s.commit()


async def _snapshot(email: str) -> dict:
    """Всё, что recovery/finish имеет право менять."""
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        rb = await s.get(RecoveryBlob, user.id)
        sessions = (
            (await s.execute(select(DbSession.id).where(DbSession.user_id == user.id)))
            .scalars()
            .all()
        )
        return {
            "salt": bytes(user.salt),
            "auth_key_hash": bytes(user.auth_key_hash),
            "ciphertext": bytes(rb.ciphertext),
            "recovery_auth_key_hash": (
                bytes(rb.recovery_auth_key_hash) if rb.recovery_auth_key_hash else None
            ),
            "session_ids": sorted(str(x) for x in sessions),
        }


async def _clear_recovery_hash(email: str) -> None:
    """Состояние пользователя, зарегистрированного до миграции 014."""
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        await s.execute(
            update(RecoveryBlob)
            .where(RecoveryBlob.user_id == user.id)
            .values(recovery_auth_key_hash=None)
        )
        await s.commit()


def _finish_body(email: str, rec_key: bytes, **extra) -> dict:
    body = {
        "email": email,
        "recovery_auth_key_b64": b64(rec_key),
        "new_salt_b64": b64(b"\x10" * 16),
        "new_auth_key_b64": b64(b"\x11" * 32),
        "new_recovery_blob_b64": b64(b"\x12" * 96),
    }
    body.update(extra)
    return body


@pytest.mark.asyncio
async def test_recovery_changes_master_password():
    email = f"rec-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)

        r = await c.post("/api/auth/recovery/start", json={"email": email})
        assert r.status_code == 200

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 200, r.text

        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 401

        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(b"\x11" * 32)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_finish_wrong_key_rejected_and_mutates_nothing():
    email = f"recbad-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        # Живая сессия: rejected-попытка не должна разлогинивать владельца.
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        before = await _snapshot(email)
        assert len(before["session_ids"]) == 1

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, WRONG_REC_KEY))
        assert r.status_code == 401, r.text

        assert await _snapshot(email) == before
        # Сессия жива, старый пароль по-прежнему рабочий.
        r = await c.get("/api/auth/me")
        assert r.status_code == 200
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_finish_without_key_is_rejected():
    email = f"recnokey-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        before = await _snapshot(email)
        r = await c.post(
            "/api/auth/recovery/finish",
            json={
                "email": email,
                "new_salt_b64": b64(b"\x10" * 16),
                "new_auth_key_b64": b64(b"\x11" * 32),
                "new_recovery_blob_b64": b64(b"\x12" * 96),
            },
        )
        assert r.status_code == 422, r.text
        assert await _snapshot(email) == before


@pytest.mark.asyncio
async def test_recovery_finish_unknown_email_returns_401_like_wrong_key():
    """Эндпоинт не подтверждает существование адреса."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/recovery/finish",
            json=_finish_body(f"ghost-{uuid.uuid4().hex[:10]}@example.com", REC_KEY),
        )
        assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_recovery_finish_refuses_when_hash_not_configured():
    """Пользователь до миграции 014: отказ, а не разовый пропуск."""
    email = f"reclegacy-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_recovery_hash(email)
        before = await _snapshot(email)
        assert before["recovery_auth_key_hash"] is None

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 409, r.text
        assert "sign in" in r.json()["detail"]
        assert await _snapshot(email) == before

        # Старый пароль по-прежнему пускает: ничего не сломано.
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_setup_restores_ability_to_recover():
    """Единственный выход для NULL-хеша: переустановить recovery из-под сессии."""
    email = f"recsetup-{uuid.uuid4().hex[:10]}@example.com"
    new_rec_key = b"\x44" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_recovery_hash(email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text

        # Неверный текущий пароль — отказ.
        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(b"\x77" * 32),
                "recovery_blob_b64": b64(b"\x55" * 96),
                "recovery_auth_key_b64": b64(new_rec_key),
            },
        )
        assert r.status_code == 401, r.text
        async with AsyncSessionLocal() as s:
            user = (await s.execute(select(User).where(User.email == email))).scalar_one()
            rb = await s.get(RecoveryBlob, user.id)
            assert rb.recovery_auth_key_hash is None
            assert bytes(rb.ciphertext) == BLOB

        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(AUTH_KEY),
                "recovery_blob_b64": b64(b"\x55" * 96),
                "recovery_auth_key_b64": b64(new_rec_key),
            },
        )
        assert r.status_code == 200, r.text

        # Старый ключ не подходит, новый — работает.
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 401, r.text
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, new_rec_key))
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_setup_requires_session():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(AUTH_KEY),
                "recovery_blob_b64": b64(BLOB),
                "recovery_auth_key_b64": b64(REC_KEY),
            },
        )
        assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_recovery_finish_rotates_hash_when_new_key_supplied():
    """Клиент выдал новую фразу в процессе восстановления — хеш едет следом."""
    email = f"recrot-{uuid.uuid4().hex[:10]}@example.com"
    rotated = b"\x66" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post(
            "/api/auth/recovery/finish",
            json=_finish_body(email, REC_KEY, new_recovery_auth_key_b64=b64(rotated)),
        )
        assert r.status_code == 200, r.text

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 401, r.text
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, rotated))
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_successful_recovery_kills_sessions_and_rewrites_blob():
    email = f"recok-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        assert len((await _snapshot(email))["session_ids"]) == 1

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 200, r.text

        after = await _snapshot(email)
        assert after["session_ids"] == []
        assert after["salt"] == b"\x10" * 16
        assert after["ciphertext"] == b"\x12" * 96
        # Фраза не менялась — хеш остался прежним.
        assert after["recovery_auth_key_hash"] is not None
        r = await c.get("/api/auth/me")
        assert r.status_code == 401
