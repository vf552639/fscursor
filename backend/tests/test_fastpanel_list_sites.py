import pytest

pytest.importorskip("paramiko")

from app.services.fastpanel_client import list_sites


class _DummyClient:
    pass


def test_list_sites_json(monkeypatch) -> None:
    responses = [
        (0, '[{"domain_name":"example.com","site_user":"example_usr","site_path":"/var/www/example_usr/data/www/example.com","php_version":"8.2"}]'),
    ]

    def _fake_run_remote(_client, _cmd, timeout=None):  # noqa: ARG001
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

    def _fake_run_remote(_client, _cmd, timeout=None):  # noqa: ARG001
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

    def _fake_run_remote(_client, _cmd, timeout=None):  # noqa: ARG001
        return responses.pop(0)

    monkeypatch.setattr("app.services.fastpanel_client.run_remote", _fake_run_remote)
    rows = list_sites(_DummyClient(), "/usr/local/fastpanel2/fastpanel")
    assert {r["domain_name"] for r in rows} == {"site1.com", "site2.net"}
