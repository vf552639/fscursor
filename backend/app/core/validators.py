import re

from app.core.constants import DOMAIN_REGEX, EMAIL_REGEX, IPV4_REGEX

_DOMAIN_RE = re.compile(DOMAIN_REGEX)
_EMAIL_RE = re.compile(EMAIL_REGEX)
_IPV4_RE = re.compile(IPV4_REGEX)

# C0 плюс DEL. Управляющие символы не встречаются ни в адресе панели, ни в её
# логине, зато ломают всё, куда эти значения попадают: `\n` дробит строку
# аудита, `\x1b` — escape-последовательность терминала.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
# Authority без userinfo: хост (буквы/цифры/`.`/`-`/`_`) и обязательный порт.
# Порт — `[0-9]`, а не `\d`: `\d` в Python матчит и юникодные цифры (`४४४४`),
# а парный регекс в `provision/fastpanel_install.rs` — ASCII-only. Правила
# должны совпадать символ в символ, см. `is_valid_fastpanel_url`.
# `\Z`, а не `$`: `$` в Python матчит ещё и позицию перед завершающим `\n`,
# то есть `1.2.3.4:8888\n` прошёл бы проверку формы. Сегодня такое значение
# отсекает проверка управляющих символов выше — но тогда одно правило держится
# на порядке другого, а в парных регексах (JS, Rust) `$` так себя не ведёт.
_HOST_PORT_RE = re.compile(r"^[A-Za-z0-9._-]+:[0-9]{1,5}\Z")
# Пробельные символы (юникодные тоже) — парно к `\S+` в регексах десктопа.
_WHITESPACE_RE = re.compile(r"\s")


def is_valid_domain(value: str) -> bool:
    if not value:
        return False
    return bool(_DOMAIN_RE.match(value.strip()))


def is_valid_email(value: str) -> bool:
    if not value:
        return False
    return bool(_EMAIL_RE.match(value.strip()))


def is_valid_ipv4(value: str) -> bool:
    if not value:
        return False
    return bool(_IPV4_RE.match(value.strip()))


def normalize_domain(value: str) -> str:
    return value.strip().lower().rstrip(".")


def is_valid_fastpanel_url(value: str) -> bool:
    """Похоже ли значение на адрес панели и свободно ли оно от кредов.

    Значение приезжает write-back'ом с десктопа (его разбирает регекс по stdout
    инсталлятора) и ложится в `servers.fastpanel_url`, откуда его показывает и
    веб, и десктоп. Регекс десктопа матчит в том числе
    `https://admin:s3cr3t@ip:8888/` — пароль панели внутри URL, — а гард
    редакции аудита смотрит на ИМЕНА полей, и имя `url` секретным не выглядит.
    Схема — та дверь, которая закрыта для любого клиента, а не только для
    нашего десктопа (долг №10).

    Правила ровно четыре: никаких `@`, схема `http(s)`, authority вида
    `хост:порт`, никаких управляющих символов. Полноценным URL-валидатором это
    не притворяется: путь и запрос не разбираются вовсе.
    """
    if _CONTROL_CHARS_RE.search(value):
        return False
    # `@` где угодно в значении — отказ, а не «userinfo по букве RFC».
    #
    # Разбирать по RFC тут мало: в `https://admin:12/345@1.2.3.4:8888` пароль
    # содержит `/`, поэтому authority кончается на нём и равна `admin:12` —
    # идеальному «хост:порт», — а логин с паролем уезжают в путь и дальше в
    # колонку и в аудит. Проверка формы ниже такой вход пропускала.
    #
    # Цена: `@` в пути (`.../mail@example`) тоже отказ. Панельного адреса с `@`
    # в пути не существует, FastPanel живёт в корне — размен в нашу пользу.
    if "@" in value:
        return False
    for scheme in ("https://", "http://"):
        if value.startswith(scheme):
            rest = value[len(scheme) :]
            break
    else:
        return False
    # Authority кончается на первом `/`, `?` или `#`; всё дальше — путь и запрос.
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    return bool(_HOST_PORT_RE.match(authority))


def is_valid_fastpanel_user(value: str) -> bool:
    """Годится ли значение в логин панели: непустое, без пробелов и управляющих.

    Приезжает тем же write-back'ом, что и `fastpanel_url`, и уходит туда же —
    в колонку, в UI и в metadata аудита.

    Три правила ровно повторяют то, что даёт разбор на десктопе: `(\\S+)` в
    `provision/fastpanel_install.rs` не может вернуть ни пустую строку, ни
    значение с пробелом, а `sanitize_panel_user` отвергает управляющие символы.
    Расхождения тут дороги — см. парный `is_valid_fastpanel_url`.

    Пустая строка — отказ по той же причине, что и у URL: колонка с `""`
    означает «логин есть, и он пустой», хотя означать должна «логина нет»
    (`NULL`). Прислать `null` никто не мешает.
    """
    if not value:
        return False
    return not (_CONTROL_CHARS_RE.search(value) or _WHITESPACE_RE.search(value))
