import pytest

pytest.importorskip("paramiko")

from app.services.fastpanel_client import make_ftp_login, make_site_user


def test_make_site_user() -> None:
    assert make_site_user("my-example-domain.com") == "my_example_do_usr"
    assert make_site_user("abc.com") == "abc_usr"


def test_make_ftp_login() -> None:
    assert make_ftp_login("my-example-domain.com") == "ftp_my_example_domain"
    assert make_ftp_login("abc.com") == "ftp_abc"
