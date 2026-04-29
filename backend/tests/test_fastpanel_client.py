from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("paramiko")

from app.services.fastpanel_client import http_check, make_ftp_login, make_site_user


def test_make_site_user() -> None:
    assert make_site_user("my-example-domain.com") == "my_example_do_usr"
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
