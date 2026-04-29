import json

import pytest

pytest.importorskip("paramiko")

from app.services.fastpanel_client import _coerce_php_version, _normalize_site_row, list_sites


class _DummyClient:
    pass


def test_list_sites_json(monkeypatch) -> None:
    responses = [
        (0, '[{"domain_name":"example.com","site_user":"example_usr","site_path":"/var/www/example_usr/data/www/example.com","php_version":"8.2"}]'),
    ]

    def _fake_run_remote(_client, _cmd, timeout=None, pty=True):  # noqa: ARG001
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    rows = list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")
    assert len(rows) == 1
    assert rows[0]["domain_name"] == "example.com"
    assert rows[0]["site_user"] == "example_usr"


def test_list_sites_table_fallback(monkeypatch) -> None:
    responses = [
        (1, "bad json"),
        (
            0,
            "Domain             Owner         Path                                      PHP\n"
            "example.org        owner1        /var/www/owner1/data/www/example.org     8.1\n",
        ),
    ]

    def _fake_run_remote(_client, _cmd, timeout=None, pty=True):  # noqa: ARG001
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    rows = list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")
    assert len(rows) == 1
    assert rows[0]["domain_name"] == "example.org"
    assert rows[0]["php_version"] == "8.1"


def test_list_sites_filesystem_fallback(monkeypatch) -> None:
    responses = [
        (1, "json not available"),
        (1, "table not available"),
        (
            0,
            "/var/www/u1/data/www/site1.com\n"
            "/var/www/u2/data/www/site2.net\n",
        ),
    ]

    def _fake_run_remote(_client, _cmd, timeout=None, pty=True):  # noqa: ARG001
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    rows = list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")
    assert {r["domain_name"] for r in rows} == {"site1.com", "site2.net"}


def test_list_sites_uses_timeout_and_no_pty(monkeypatch) -> None:
    calls = []
    responses = [
        (1, "json not available"),
        (1, "table not available"),
        (0, "/var/www/u1/data/www/site1.com\n"),
    ]

    def _fake_run_remote(_client, cmd, timeout=None, pty=True):  # noqa: ARG001
        calls.append((cmd, timeout, pty))
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")

    assert len(calls) == 3
    for _cmd, timeout, pty in calls:
        assert timeout == 15
        assert pty is False


def test_coerce_php_version() -> None:
    assert _coerce_php_version("php-8.1-fpm") == "8.1"
    assert _coerce_php_version("8.1.27") == "8.1.27"
    assert _coerce_php_version("n/a") is None


def test_list_sites_json_nested_owner_dict(monkeypatch) -> None:
    payload = [
        {
            "domain_name": "betty.example.com",
            "owner": {
                "id": 4,
                "username": "betty_ontari_usr",
                "home_dir": "/var/www/betty_ontari_usr/data",
            },
            "php_version": "8.2",
        }
    ]
    responses = [(0, json.dumps(payload))]

    def _fake_run_remote(_client, _cmd, timeout=None, pty=True):  # noqa: ARG001
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    rows = list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")
    assert len(rows) == 1
    assert rows[0]["site_user"] == "betty_ontari_usr"
    assert rows[0]["site_path"] == "/var/www/betty_ontari_usr/data/www/betty.example.com"
    assert rows[0]["php_version"] == "8.2"


def test_normalize_site_row_owner_plain_string() -> None:
    row = _normalize_site_row(
        {
            "domain_name": "legacy.com",
            "owner": "legacyowner",
            "site_path": "/var/www/legacyowner/data/www/legacy.com",
        }
    )
    assert row is not None
    assert row["site_user"] == "legacyowner"
    assert row["site_path"] == "/var/www/legacyowner/data/www/legacy.com"


def test_normalize_site_row_owner_dict_without_recognized_keys() -> None:
    row = _normalize_site_row({"domain_name": "only.com", "owner": {"id": 99}})
    assert row is not None
    assert row["domain_name"] == "only.com"
    assert row["site_user"] is None
    assert row["site_path"] is None
