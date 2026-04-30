from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("paramiko")

from app.services.fastpanel_client import (
    _render_nginx_snippet,
    create_database,
    http_check,
    make_ftp_login,
    make_site_user,
    read_ssl_info_via_ssh,
    revoke_ssl_certificate,
)


def test_make_site_user() -> None:
    assert make_site_user("my-example-domain.com") == "my_example_d_usr"
    assert make_site_user("abc.com") == "abc_usr"


def test_make_ftp_login() -> None:
    assert make_ftp_login("my-example-domain.com") == "ftp_my_example_domain"
    assert make_ftp_login("abc.com") == "ftp_abc"


def test_http_check_success() -> None:
    cm = MagicMock()
    cm.__enter__.return_value = cm
    cm.__exit__.return_value = False
    with patch("app.services.fastpanel_client.socket.create_connection", return_value=cm):
        assert http_check("example.com", port=80) is True


def test_http_check_failure() -> None:
    with patch(
        "app.services.fastpanel_client.socket.create_connection",
        side_effect=OSError("refused"),
    ):
        assert http_check("example.com", port=80) is False


def test_create_database_uses_cli_success() -> None:
    client = object()
    with patch("app.services.fastpanel_client.run_remote", return_value=(0, "ok")):
        result = create_database(client, "/usr/local/bin/fastpanel", "example.com")
    assert result["success"] is True
    assert result["db_name"]
    assert result["db_user"]
    assert result["db_password"]


def test_revoke_ssl_certificate_success() -> None:
    client = object()
    with patch("app.services.fastpanel_client.run_remote", side_effect=[(0, "a"), (0, "b"), (0, "c")]):
        result = revoke_ssl_certificate(client, "/usr/local/bin/fastpanel", "example.com")
    assert result["success"] is True


def test_read_ssl_info_via_ssh_parses_dates() -> None:
    with patch("app.services.fastpanel_client.cert_exists", return_value=True):
        with patch(
            "app.services.fastpanel_client.run_remote",
            return_value=(0, "notAfter=May 30 12:00:00 2027 GMT\nissuer=CN=Let's Encrypt"),
        ):
            result = read_ssl_info_via_ssh(object(), "example.com")
    assert result["has_certificate"] is True
    assert result["issuer"] == "CN=Let's Encrypt"
    assert result["is_letsencrypt"] is True


def test_render_nginx_snippet_combines_presets_and_raw() -> None:
    rendered = _render_nginx_snippet(
        "example.com",
        "location /ping { return 200; }",
        {"force_https": True, "www_redirect": True},
    )
    assert "return 301 https://example.com$request_uri;" in rendered
    assert "location /ping" in rendered
