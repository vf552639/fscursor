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
_HOST_PORT_RE = re.compile(r"^[A-Za-z0-9._-]+:\d{1,5}$")


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

    Правила ровно три: схема `http(s)`, authority вида `хост:порт`, никаких
    управляющих символов. Полноценным URL-валидатором это не притворяется:
    путь и запрос не разбираются вовсе.
    """
    if _CONTROL_CHARS_RE.search(value):
        return False
    for scheme in ("https://", "http://"):
        if value.startswith(scheme):
            rest = value[len(scheme) :]
            break
    else:
        return False
    # Authority кончается на первом `/`, `?` или `#`; всё дальше — путь и
    # запрос, и `@` там к userinfo отношения не имеет.
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    # `@` в authority — это userinfo, то есть креды внутри значения. Проверка
    # формы «хост:порт» ниже отвергла бы такое значение и сама (`@` не входит в
    # набор символов хоста), но правило «userinfo — отказ» слишком важное,
    # чтобы держаться на побочном эффекте чужого регекса.
    if "@" in authority:
        return False
    return bool(_HOST_PORT_RE.match(authority))


def is_valid_fastpanel_user(value: str) -> bool:
    """Свободен ли логин панели от управляющих символов.

    Приезжает тем же write-back'ом, что и `fastpanel_url`, и уходит туда же —
    в колонку, в UI и в metadata аудита. Пробелов в нём не бывает (десктоп
    ловит `(\\S+)`), а вот `\\x1b`/`\\x07` регекс пропускает.
    """
    return not _CONTROL_CHARS_RE.search(value)
