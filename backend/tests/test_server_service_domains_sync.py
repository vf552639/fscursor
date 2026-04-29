from types import SimpleNamespace

import pytest

pytest.importorskip("paramiko")

from app.services import server_service


class _FakeDB:
    def __init__(self) -> None:
        self.added = []
        self.commits = 0
        self.refreshed = []
        self.rollbacks = 0

    def add(self, item) -> None:
        self.added.append(item)

    async def commit(self) -> None:
        self.commits += 1

    async def refresh(self, item) -> None:
        self.refreshed.append(item)

    async def rollback(self) -> None:
        self.rollbacks += 1
        self.added.clear()


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


@pytest.mark.asyncio
async def test_fetch_and_persist_domains_idempotent_same_server(monkeypatch) -> None:
    db = _FakeDB()
    server = SimpleNamespace(
        id=13,
        has_ssh=True,
        status="provisioned",
        last_check_ok=True,
        last_check_error=None,
        last_check_at=None,
        secret=SimpleNamespace(ssh_password_encrypted="enc"),
    )
    attached = SimpleNamespace(
        domain_name="same.com",
        server_id=13,
        site_user="old_u",
        site_path="/old/path",
        php_version="8.0",
    )

    async def _fake_get_by_id(_db, _id):  # noqa: ARG001
        return server if _id == 13 else None

    async def _fake_get_by_name(_db, name):
        return attached if name == "same.com" else None

    monkeypatch.setattr(server_service, "get_by_id", _fake_get_by_id)
    monkeypatch.setattr("app.services.server_service.decrypt", lambda _: "pwd")
    monkeypatch.setattr("app.services.server_service._open_ssh_client", lambda *_a, **_k: _FakeClient())
    monkeypatch.setattr("app.services.server_service.get_fastpanel_path", lambda _c: "/usr/local/fastpanel2/fastpanel")
    monkeypatch.setattr(
        "app.services.server_service.list_sites",
        lambda _c, _fp: [
            {
                "domain_name": "same.com",
                "site_user": "u1",
                "site_path": "/var/www/u1/data/www/same.com",
                "php_version": "8.2",
            }
        ],
    )
    monkeypatch.setattr("app.services.server_service.domain_service.get_by_name", _fake_get_by_name)

    result = await server_service.fetch_and_persist_domains(db, 13)
    assert result["created"] == 0
    assert result["linked"] == 1
    assert result["error"] is None
    assert attached.server_id == 13
    assert attached.site_user == "u1"
    assert attached.php_version == "8.2"


@pytest.mark.asyncio
async def test_fetch_and_persist_domains_links_unattached_domain(monkeypatch) -> None:
    db = _FakeDB()
    server = SimpleNamespace(
        id=15,
        has_ssh=True,
        status="provisioned",
        last_check_ok=None,
        last_check_error=None,
        last_check_at=None,
        secret=SimpleNamespace(ssh_password_encrypted="enc"),
    )
    orphan = SimpleNamespace(
        domain_name="orphan.com",
        server_id=None,
        site_user=None,
        site_path=None,
        php_version=None,
    )

    async def _fake_get_by_id(_db, _id):  # noqa: ARG001
        return server

    async def _fake_get_by_name(_db, name):
        return orphan if name == "orphan.com" else None

    monkeypatch.setattr(server_service, "get_by_id", _fake_get_by_id)
    monkeypatch.setattr("app.services.server_service.decrypt", lambda _: "pwd")
    monkeypatch.setattr("app.services.server_service._open_ssh_client", lambda *_a, **_k: _FakeClient())
    monkeypatch.setattr("app.services.server_service.get_fastpanel_path", lambda _c: "/usr/local/fastpanel2/fastpanel")
    monkeypatch.setattr(
        "app.services.server_service.list_sites",
        lambda _c, _fp: [
            {
                "domain_name": "orphan.com",
                "site_user": "ou",
                "site_path": "/var/www/ou/data/www/orphan.com",
                "php_version": "8.1",
            }
        ],
    )
    monkeypatch.setattr("app.services.server_service.domain_service.get_by_name", _fake_get_by_name)

    result = await server_service.fetch_and_persist_domains(db, 15)
    assert result["created"] == 0
    assert result["linked"] == 1
    assert result["error"] is None
    assert orphan.server_id == 15


@pytest.mark.asyncio
async def test_fetch_and_persist_domains_conflict_aborts(monkeypatch) -> None:
    db = _FakeDB()
    server = SimpleNamespace(
        id=14,
        has_ssh=True,
        status="provisioned",
        last_check_ok=True,
        last_check_error=None,
        last_check_at=None,
        secret=SimpleNamespace(ssh_password_encrypted="enc"),
    )
    other = SimpleNamespace(id=99, name="OtherSrv")
    taken = SimpleNamespace(
        domain_name="taken.com",
        server_id=99,
        site_user="x",
        site_path="/x",
        php_version="8.0",
    )

    async def _fake_get_by_id(_db, sid):
        if sid == 14:
            return server
        if sid == 99:
            return other
        return None

    async def _fake_get_by_name(_db, name):
        return taken if name == "taken.com" else None

    monkeypatch.setattr(server_service, "get_by_id", _fake_get_by_id)
    monkeypatch.setattr("app.services.server_service.decrypt", lambda _: "pwd")
    monkeypatch.setattr("app.services.server_service._open_ssh_client", lambda *_a, **_k: _FakeClient())
    monkeypatch.setattr("app.services.server_service.get_fastpanel_path", lambda _c: "/usr/local/fastpanel2/fastpanel")
    monkeypatch.setattr(
        "app.services.server_service.list_sites",
        lambda _c, _fp: [
            {
                "domain_name": "taken.com",
                "site_user": "u9",
                "site_path": "/var/www/u9/data/www/taken.com",
                "php_version": "8.2",
            }
        ],
    )
    monkeypatch.setattr("app.services.server_service.domain_service.get_by_name", _fake_get_by_name)

    result = await server_service.fetch_and_persist_domains(db, 14)
    assert result["created"] == 0
    assert result["linked"] == 0
    assert result["error"] is not None
    assert "taken.com" in result["error"]
    assert "OtherSrv" in result["error"]
    assert "id=99" in result["error"]
    assert taken.server_id == 99
    assert server.last_check_ok is True
    assert db.rollbacks >= 1
