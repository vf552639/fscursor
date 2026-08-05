from app.core.validators import (
    PROVIDER_MAX_LEN,
    is_valid_domain,
    is_valid_email,
    is_valid_fastpanel_url,
    is_valid_fastpanel_user,
    is_valid_ipv4,
    is_valid_provider,
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


def test_is_valid_fastpanel_url() -> None:
    assert is_valid_fastpanel_url("https://203.0.113.10:8888")
    assert is_valid_fastpanel_url("http://panel.example.com:8888/login")
    # Userinfo — это встроенные креды: `https://admin:s3cr3t@ip:8888/` уезжал
    # в колонку и в аудит, а гард редакции смотрит на имя поля (`url`), а не
    # на значение. Долг №10.
    assert not is_valid_fastpanel_url("https://admin:s3cr3t@203.0.113.10:8888/")
    assert not is_valid_fastpanel_url("https://admin@203.0.113.10:8888")
    # Пароль с `/` внутри — по RFC это уже не userinfo: authority кончается на
    # первом `/` и равна `admin:12`, идеальному «хост:порт», а логин с паролем
    # проезжали как путь. Отсюда правило «`@` где угодно — отказ».
    assert not is_valid_fastpanel_url("https://203.0.113.10:8888/mail@example")
    assert not is_valid_fastpanel_url("https://admin:12/345@203.0.113.10:8888")
    # Не http(s), без порта, с управляющим символом — не адрес панели.
    assert not is_valid_fastpanel_url("ftp://203.0.113.10:8888")
    assert not is_valid_fastpanel_url("https://203.0.113.10")
    assert not is_valid_fastpanel_url("https://203.0.113.10:8888/\x1b[0m")
    # Порт — ASCII-цифры. `\d` вместо `[0-9]` пропустил бы юникодные, и правило
    # разошлось бы с парным регексом десктопа (`[0-9]`).
    assert not is_valid_fastpanel_url("https://203.0.113.10:४४४४")


def test_is_valid_fastpanel_user() -> None:
    assert is_valid_fastpanel_user("fastuser")
    # Управляющие символы уезжают в аудит и в UI как есть: `\n` дробит строку
    # лога, `\x1b` — escape-последовательность терминала.
    assert not is_valid_fastpanel_user("fast\nuser")
    assert not is_valid_fastpanel_user("fast\x1buser")
    # Пустая строка и пробел — то, чего разбор на десктопе (`(\S+)`) вернуть не
    # может; правила обеих сторон обязаны совпадать.
    assert not is_valid_fastpanel_user("")
    assert not is_valid_fastpanel_user("fast user")


def test_is_valid_provider() -> None:
    """Провайдер: пробелы внутри можно, управляющие и длиннее колонки — нельзя."""
    assert is_valid_provider("Hetzner")
    # Пробел внутри — законная часть имени («Hetzner Online», «OVH Cloud»), в
    # отличие от логина панели, где `is_valid_fastpanel_user` его запрещает.
    assert is_valid_provider("Hetzner Online")
    # Управляющие символы: `\n` дробит строку аудит-лога на две, `\x1b` —
    # escape-последовательность терминала. Тот же запрет, что у соседей выше,
    # и по той же причине — значение уезжает в БД, в аудит и в UI.
    assert not is_valid_provider("Het\nzner")
    assert not is_valid_provider("Het\x1bzner")
    assert not is_valid_provider("Het\x7fzner")
    # Ровно ширина колонки `servers.provider` — граница проходит по ней, а не
    # рядом: на 65 символах Postgres ответил бы `StringDataRightTruncation`,
    # то есть 500 вместо 422.
    assert is_valid_provider("x" * PROVIDER_MAX_LEN)
    assert not is_valid_provider("x" * (PROVIDER_MAX_LEN + 1))
