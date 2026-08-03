import base64
import uuid as uuid_mod
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.system_config import SystemConfig
from app.services import system_config_service


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_confirm_login(client: AsyncClient, email: str) -> None:
    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
        },
    )
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )


async def _audit_rows(client: AsyncClient) -> list[dict]:
    r = await client.get("/api/audit/log")
    assert r.status_code == 200
    return r.json()


def _assert_no_secret_keys(rows: list[dict]) -> None:
    # ни в одной записи metadata нет ключей, похожих на плейнтекст-секреты
    for row in rows:
        for k in (row.get("metadata") or {}):
            assert "password" not in k.lower()
            assert "token" not in k.lower()


def _assert_values_do_not_contain(rows: list[dict], forbidden: set[str]) -> None:
    """Guard against a future `metadata={...}` call leaking real secret material.

    The key-substring check above only screens *field names* — a call like
    `metadata={"blob_ciphertext": body.ciphertext_b64}` would sail right past
    it. This checks that none of the *values* logged in any audit row's
    metadata contain a piece of secret material the test itself actually
    submitted (e.g. a blob's ciphertext, or a config value that looks like a
    secret), regardless of what key it ends up nested under.
    """
    forbidden = {f for f in forbidden if f}
    for row in rows:
        meta = row.get("metadata") or {}
        blob = str(meta)
        for secret in forbidden:
            assert secret not in blob, f"secret material leaked into audit metadata: {row}"


async def _audit_actions(client: AsyncClient) -> set[str]:
    rows = await _audit_rows(client)
    _assert_no_secret_keys(rows)
    return {row["action"] for row in rows}


@pytest.mark.asyncio
async def test_blob_mutations_are_audited():
    bid = str(uuid_mod.uuid4())
    ciphertext_b64 = b64(b"super-secret-ssh-password-value")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-blob-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.put(
            f"/api/blobs/{bid}",
            json={"blob_kind": "ssh_password", "ciphertext_b64": ciphertext_b64},
        )
        assert r.status_code == 200
        r = await c.delete(f"/api/blobs/{bid}")
        assert r.status_code == 204
        rows = await _audit_rows(c)
        _assert_no_secret_keys(rows)
        # реальный секрет (ciphertext, который мы только что записали) не должен
        # утечь в metadata ни под каким ключом
        _assert_values_do_not_contain(rows, {ciphertext_b64})
        actions = {row["action"] for row in rows}
        assert "blob.upsert" in actions
        assert "blob.delete" in actions


@asynccontextmanager
async def _unowned_config_row(key: str):
    """Освободить глобальную строку `system_config` на время теста и вернуть как было.

    Первичный ключ `system_config` — один только `key`, то есть строка на ключ
    одна на всю установку, а `user_id` — отметка владельца. В общей (не
    эфемерной) dev-базе все ключи по умолчанию уже принадлежат ранее
    зарегистрированному пользователю, поэтому свежий тестовый пользователь
    получил бы на них честный 403.

    Это не обход бага, а подготовка условия: ставим `user_id = NULL`
    («ничья строка»), чтобы тест мог легально занять ключ ровно тем же путём,
    что и первый пользователь на чистой установке. Значение и владелец
    восстанавливаются в любом случае, чтобы не портить реальный конфиг.
    """
    async with AsyncSessionLocal() as s:
        before = await s.get(SystemConfig, key)
        before_value = before.value if before else None
        before_owner = before.user_id if before else None
        if before is not None:
            before.user_id = None
            await s.commit()
    try:
        yield
    finally:
        async with AsyncSessionLocal() as s:
            row = await s.get(SystemConfig, key)
            if row is not None:
                if before_value is None:
                    await s.delete(row)
                else:
                    row.value = before_value
                    row.user_id = before_owner
                await s.commit()


@pytest.mark.asyncio
async def test_settings_config_update_is_audited():
    """`PUT /api/settings/config/{key}` владельцем ключа пишет запись в аудит.

    Тест занимает свободный (`user_id IS NULL`) ключ — это разрешённый путь, —
    затем перезаписывает уже свой ключ ещё раз, чтобы обе ветки `upsert`
    (захват ничьей строки и запись в собственную) были покрыты. Проверяем, что
    `settings.config_update` доходит до аудита и что само значение секрета в
    metadata не попадает.
    """
    key = "Webhook Secret"
    assert key in system_config_service.EDITABLE_KEYS

    async with _unowned_config_row(key):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await _register_confirm_login(c, f"maud-set-{uuid_mod.uuid4().hex[:8]}@example.com")
            marker = f"super-secret-value-{uuid_mod.uuid4().hex}"
            # 1. ничья строка достаётся тому, кто первым за ней пришёл
            r = await c.put(f"/api/settings/config/{key}", json={"value": marker})
            assert r.status_code == 200
            # 2. свою собственную строку владелец может переписывать дальше
            marker2 = f"super-secret-value-{uuid_mod.uuid4().hex}"
            r = await c.put(f"/api/settings/config/{key}", json={"value": marker2})
            assert r.status_code == 200
            assert r.json()["value"] == marker2

            rows = await _audit_rows(c)
            _assert_no_secret_keys(rows)
            # само значение (не ключ), которое мы только что записали, не
            # должно попасть в metadata аудита
            _assert_values_do_not_contain(rows, {marker, marker2})
            actions = {row["action"] for row in rows}
            assert "settings.config_update" in actions


@pytest.mark.asyncio
async def test_config_key_owned_by_another_user_cannot_be_overwritten():
    """Чужой ключ конфигурации не переписывается и не переприсваивается.

    `Webhook URL`/`Webhook Secret` определяют, куда и с какой подписью уходят
    вебхуки. Раз строка в `system_config` одна на всю установку, отсутствие
    проверки владельца означало бы, что любой аутентифицированный пользователь
    перенаправляет чужие вебхуки на себя — и попутно делает строку невидимой
    для настоящего владельца (`get_all` фильтрует по `user_id`).
    """
    key = "Webhook URL"
    assert key in system_config_service.EDITABLE_KEYS
    owner_email = f"maud-own-{uuid_mod.uuid4().hex[:8]}@example.com"
    owner_value = f"https://owner-{uuid_mod.uuid4().hex}.example.com/hook"

    async with _unowned_config_row(key):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as owner:
            await _register_confirm_login(owner, owner_email)
            r = await owner.put(f"/api/settings/config/{key}", json={"value": owner_value})
            assert r.status_code == 200

        async with AsyncSessionLocal() as s:
            owner_id = (
                await s.execute(select(User.id).where(User.email == owner_email))
            ).scalar_one()
            row = await s.get(SystemConfig, key)
            assert row is not None and row.user_id == owner_id

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as other:
            await _register_confirm_login(other, f"maud-oth-{uuid_mod.uuid4().hex[:8]}@example.com")
            r = await other.put(
                f"/api/settings/config/{key}",
                json={"value": "https://attacker.example.com/hook"},
            )
            assert r.status_code == 403, r.text

            # отказ должен быть полным: ни значения, ни владельца
            async with AsyncSessionLocal() as s:
                row = await s.get(SystemConfig, key)
                assert row is not None
                assert row.value == owner_value
                assert row.user_id == owner_id

            # и в аудит чужого пользователя ничего не записалось
            assert "settings.config_update" not in await _audit_actions(other)

        # владелец по-прежнему видит своё значение
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as owner:
            await _register_confirm_login(owner, owner_email)
            r = await owner.get("/api/settings/config")
            assert r.status_code == 200
            assert any(
                item["key"] == key and item["value"] == owner_value for item in r.json()
            )


@pytest.mark.asyncio
async def test_notification_mark_read_is_audited():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-ntf-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/notifications/mark-read", json={})
        assert r.status_code == 200
        actions = await _audit_actions(c)
        assert "notification.mark_read" in actions
