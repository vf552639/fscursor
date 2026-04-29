from app.core.validators import (
    is_valid_domain,
    is_valid_email,
    is_valid_ipv4,
    normalize_domain,
)


def test_is_valid_domain() -> None:
    assert is_valid_domain("example.com")
    assert is_valid_domain("sub.example.co.uk")
    assert not is_valid_domain("bad_domain")


def test_is_valid_email() -> None:
    assert is_valid_email("user@example.com")
    assert not is_valid_email("user@example")


def test_is_valid_ipv4() -> None:
    assert is_valid_ipv4("127.0.0.1")
    assert not is_valid_ipv4("999.1.1.1")


def test_normalize_domain() -> None:
    assert normalize_domain(" Example.COM. ") == "example.com"
