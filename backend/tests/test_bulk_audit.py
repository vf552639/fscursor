"""Аудит массовых (bulk) маршрутов.

Единичный CRUD писался в audit log с самого начала, а его bulk-вариант — нет:
перенос одного домена оставлял запись, перенос 500 — ни одной. Эти тесты
проверяют не только «запись появилась», но и дисциплину метаданных: в
`backend/app/audit/` нет ни одного слоя редакции, metadata сохраняется ровно
в том виде, в каком её передали, поэтому счётчики вместо списков сущностей и
отсутствие всего, что выведено из учётных данных, — часть контракта.
"""

import base64
import uuid as uuid_mod
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


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
            .values(
                email_confirmed_at=datetime.now(timezone.utc),
                email_confirm_token_hash=None,
            )
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


def _row_for(rows: list[dict], action: str) -> dict:
    matching = [r for r in rows if r["action"] == action]
    assert matching, f"нет записи аудита для действия {action}"
    return matching[0]


def _assert_no_secret_keys(rows: list[dict]) -> None:
    for row in rows:
        for k in row.get("metadata") or {}:
            assert "password" not in k.lower()
            assert "token" not in k.lower()


def _assert_values_do_not_contain(rows: list[dict], forbidden: set[str]) -> None:
    for row in rows:
        blob = str(row.get("metadata") or {})
        for secret in forbidden:
            if secret:
                assert secret not in blob, f"утечка в metadata аудита: {row}"


@pytest.mark.asyncio
async def test_domain_bulk_create_is_audited_with_counts_not_names():
    names = [f"{uuid_mod.uuid4().hex[:10]}.example.com" for _ in range(3)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"bulk-dc-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains/bulk", json={"domains_text": "\n".join(names)})
        assert r.status_code == 201
        assert len(r.json()["created"]) == 3

        rows = await _audit_rows(c)
        _assert_no_secret_keys(rows)
        # имена доменов — это как раз «список сущностей», которого в аудите
        # быть не должно: массовая заливка бывает и на сотни строк
        _assert_values_do_not_contain(rows, set(names))
        meta = _row_for(rows, "domain.bulk_create")["metadata"]
        assert meta["mode"] == "text"
        assert meta["created"] == 3
        assert meta["skipped"] == 0


@pytest.mark.asyncio
async def test_domain_bulk_structured_create_is_audited():
    names = [f"{uuid_mod.uuid4().hex[:10]}.example.com" for _ in range(2)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"bulk-ds-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/domains/bulk-structured",
            json={"items": [{"domain_name": n} for n in names]},
        )
        assert r.status_code == 201

        rows = await _audit_rows(c)
        _assert_values_do_not_contain(rows, set(names))
        meta = _row_for(rows, "domain.bulk_create")["metadata"]
        assert meta["mode"] == "structured"
        assert meta["requested"] == 2
        assert meta["created"] == 2


@pytest.mark.asyncio
async def test_bulk_assign_records_target_and_count_not_id_list():
    names = [f"{uuid_mod.uuid4().hex[:10]}.example.com" for _ in range(2)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"bulk-as-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains/bulk", json={"domains_text": "\n".join(names)})
        assert r.status_code == 201
        domain_ids = [d["id"] for d in r.json()["created"]]

        # server_id=None — легальный «отвязать»: не требует реального сервера,
        # но проходит ровно тот же путь массового UPDATE
        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": domain_ids, "server_id": None},
        )
        assert r.status_code == 200
        r = await c.post(
            "/api/domains/bulk-assign-cloudflare",
            json={"domain_ids": domain_ids, "cloudflare_account_id": None},
        )
        assert r.status_code == 200

        rows = await _audit_rows(c)
        _assert_no_secret_keys(rows)
        srv = _row_for(rows, "domain.bulk_assign_server")
        assert srv["target_type"] == "server"
        assert srv["metadata"]["domains_requested"] == 2
        assert srv["metadata"]["domains_updated"] == 2
        cf = _row_for(rows, "domain.bulk_assign_cloudflare")
        assert cf["target_type"] == "cloudflare_account"
        assert cf["metadata"]["domains_requested"] == 2

        # в metadata нет ни одного перечня сущностей — только скаляры-счётчики
        assert set(srv["metadata"]) == {
            "server_id",
            "domains_requested",
            "domains_updated",
        }
        assert set(cf["metadata"]) == {
            "cloudflare_account_id",
            "domains_requested",
            "domains_updated",
        }
        for row in (srv, cf):
            for key, value in row["metadata"].items():
                assert not isinstance(value, (list, dict)), (
                    f"в аудит попал перечень вместо счётчика: {key}={value!r}"
                )


@pytest.mark.asyncio
async def test_domain_bulk_import_logs_outcome_not_rows():
    good = f"{uuid_mod.uuid4().hex[:10]}.example.com"
    bad = "не домен вовсе"
    csv_body = f"domain,registrar\n{good},\n{bad},\n".encode()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"bulk-di-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/domains/bulk-import",
            files={"file": ("import.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["created"] == 1
        assert body["errors"]
        # токен на неаутентифицированную выдачу CSV с ошибками
        errors_token = (body["errors_csv_url"] or "").rsplit("/", 1)[-1]

        rows = await _audit_rows(c)
        _assert_no_secret_keys(rows)
        # ни строки файла, ни токен выгрузки ошибок в аудит не попадают
        _assert_values_do_not_contain(rows, {good, bad, errors_token})
        meta = _row_for(rows, "domain.bulk_import")["metadata"]
        assert meta["filename"] == "import.csv"
        assert meta["created"] == 1
        assert meta["errors"] == len(body["errors"])


@pytest.mark.asyncio
async def test_server_bulk_import_never_logs_the_ssh_password_column():
    """Формат CSV импорта серверов включает колонку ssh_password.

    Пароль разбирается в `ServerImportRow.ssh_password` и дальше отбрасывается
    (в `ServerCreate` его нет), но именно поэтому важно зафиксировать тестом,
    что он не окажется в аудите при следующей правке метаданных.
    """
    marker = f"S3cr3t-{uuid_mod.uuid4().hex}"
    name = f"srv-{uuid_mod.uuid4().hex[:8]}"
    ip = f"203.0.113.{uuid_mod.uuid4().int % 200 + 10}"
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port\n"
        f"{name},{ip},root,{marker},22\n"
        f",{ip},root,{marker},22\n"  # без имени → строка уйдёт в errors
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"bulk-si-{uuid_mod.uuid4().hex[:8]}@example.com")
        try:
            r = await c.post(
                "/api/servers/bulk-import",
                files={"file": ("servers.csv", csv_body, "text/csv")},
                data={"has_header": "true"},
            )
            assert r.status_code == 200
            body = r.json()
            assert body["created"] == 1
            assert body["skipped"] == 1

            rows = await _audit_rows(c)
            _assert_no_secret_keys(rows)
            # ни пароль, ни имя/IP сервера из строки файла
            _assert_values_do_not_contain(rows, {marker, name, ip})
            meta = _row_for(rows, "server.bulk_import")["metadata"]
            assert meta["filename"] == "servers.csv"
            assert meta["created"] == 1
            assert meta["skipped"] == 1
            assert meta["errors"] == len(body["errors"])
        finally:
            listing = await c.get("/api/servers")
            for srv in listing.json()["items"]:
                if srv["ip_address"] == ip:
                    await c.delete(f"/api/servers/{srv['id']}")
