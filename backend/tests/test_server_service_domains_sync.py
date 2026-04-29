from types import SimpleNamespace

import pytest

pytest.importorskip("paramiko")

from app.services import server_service


class _FakeDB:
    def __init__(self) -> None:
        self.added = []
        self.commits = 0
        self.refreshed = []

    def add(self, item) -> None:
        self.added.append(item)

    async def commit(self) -> None:
        self.commits += 1

    async def refresh(self, item) -> None:
        self.refreshed.append(item)

    async def rollback(self) -> None:
        return None


class _FakeClient:
    def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_fetch_and_persist_domains_creates_and_links(monkeypatch) -> None:
    db = _FakeDB()
    server = SimpleNamespace(
        id=11,
        has_ssh=True,
        status="provisioned",
        last_check_ok=None,
        last_check_error=None,
        last_check_at=None,
        secret=SimpleNamespace(ssh_password_encrypted="enc"),
    )
    existing = SimpleNamespace(
        domain_name="old.com",
        server_id=None,
        site_user=None,
        site_path=None,
        php_version=None,
    )

    async def _fake_get_by_id(_db, _id):  # noqa: ARG001
        return server

    async def _fake_get_by_name(_db, name):
        return existing if name == "old.com" else None

    monkeypatch.setattr(server_service, "get_by_id", _fake_get_by_id)
    monkeypatch.setattr("app.services.server_service.decrypt", lambda _: "pwd")
    monkeypatch.setattr("app.services.server_service._open_ssh_client", lambda *_a, **_k: _FakeClient())
    monkeypatch.setattr("app.services.server_service.get_fastpanel_path", lambda _c: "/usr/local/fastpanel2/fastpanel")
    monkeypatch.setattr(
        "app.services.server_service.list_sites",
        lambda _c, _fp: [
            {"domain_name": "old.com", "site_user": "u1", "site_path": "/var/www/u1/data/www/old.com", "php_version": "8.2"},
            {"domain_name": "new.com", "site_user": "u2", "site_path": "/var/www/u2/data/www/new.com", "php_version": "8.1"},
        ],
    )
    monkeypatch.setattr("app.services.server_service.domain_service.get_by_name", _fake_get_by_name)

    result = await server_service.fetch_and_persist_domains(db, 11)
    assert result["created"] == 1
    assert result["linked"] == 1
    assert result["total"] == 2
    assert result["error"] is None
    assert existing.server_id == 11
    assert len(db.added) == 1
    assert db.added[0].domain_name == "new.com"


@pytest.mark.asyncio
async def test_fetch_and_persist_domains_normalizes_php_version(monkeypatch) -> None:
    db = _FakeDB()
    server = SimpleNamespace(
        id=12,
        has_ssh=True,
        status="provisioned",
        last_check_ok=None,
        last_check_error=None,
        last_check_at=None,
        secret=SimpleNamespace(ssh_password_encrypted="enc"),
    )

    async def _fake_get_by_id(_db, _id):  # noqa: ARG001
        return server

    async def _fake_get_by_name(_db, _name):  # noqa: ARG001
        return None

    monkeypatch.setattr(server_service, "get_by_id", _fake_get_by_id)
    monkeypatch.setattr("app.services.server_service.decrypt", lambda _: "pwd")
    monkeypatch.setattr("app.services.server_service._open_ssh_client", lambda *_a, **_k: _FakeClient())
    monkeypatch.setattr("app.services.server_service.get_fastpanel_path", lambda _c: "/usr/local/fastpanel2/fastpanel")
    monkeypatch.setattr(
        "app.services.server_service.list_sites",
        lambda _c, _fp: [
            {
                "domain_name": "normalized.com",
                "site_user": "u1",
                "site_path": "/var/www/u1/data/www/normalized.com",
                "php_version": "php-8.1-fpm",
            }
        ],
    )
    monkeypatch.setattr("app.services.server_service.domain_service.get_by_name", _fake_get_by_name)

    result = await server_service.fetch_and_persist_domains(db, 12)
    assert result["created"] == 1
    assert result["error"] is None
    assert db.added[0].php_version == "8.1"
