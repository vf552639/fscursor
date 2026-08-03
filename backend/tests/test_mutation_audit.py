import base64
import uuid as uuid_mod
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

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


@pytest.mark.asyncio
async def test_settings_config_update_is_audited():
    """
    `system_config` rows are keyed globally by `key` (no per-user column in
    the primary key), and `system_config_service.upsert` unconditionally sets
    `row.user_id = user_id` on every PUT with no ownership/authorization
    check. In this shared, non-ephemeral dev database that means:

    - `GET /api/settings/config` returns an *empty list* for a freshly
      registered user (not just zero *editable* items) whenever any config
      row is already owned by a different user — which is the case here (13
      rows, all owned by one pre-existing user). The plan's original
      "pick an editable item from the GET response" approach therefore always
      fails, not flakily but deterministically, for any user other than the
      current owner.
    - Naively PUTting to a known editable key (to work around the above)
      would silently steal ownership of, and overwrite, that other user's
      real config value.

    Both are pre-existing bugs in `system_config_service`/`settings.py`
    unrelated to the audit-logging change this test targets. To exercise the
    audit call end-to-end without corrupting real state, we bypass the broken
    GET, target a known key from `EDITABLE_KEYS` directly, and restore the
    row's original value/owner afterwards regardless of outcome.
    """
    key = "Webhook Secret"
    assert key in system_config_service.EDITABLE_KEYS

    async with AsyncSessionLocal() as s:
        before = await s.get(SystemConfig, key)
        before_value = before.value if before else None
        before_owner = before.user_id if before else None

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await _register_confirm_login(c, f"maud-set-{uuid_mod.uuid4().hex[:8]}@example.com")
            marker = f"super-secret-value-{uuid_mod.uuid4().hex}"
            r = await c.put(
                f"/api/settings/config/{key}",
                json={"value": marker},
            )
            assert r.status_code == 200
            rows = await _audit_rows(c)
            _assert_no_secret_keys(rows)
            # само значение (не ключ), которое мы только что записали, не
            # должно попасть в metadata аудита
            _assert_values_do_not_contain(rows, {marker})
            actions = {row["action"] for row in rows}
            assert "settings.config_update" in actions
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
async def test_notification_mark_read_is_audited():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-ntf-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/notifications/mark-read", json={})
        assert r.status_code == 200
        actions = await _audit_actions(c)
        assert "notification.mark_read" in actions
