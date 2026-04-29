import re

from app.core.constants import DOMAIN_REGEX, EMAIL_REGEX, IPV4_REGEX

_DOMAIN_RE = re.compile(DOMAIN_REGEX)
_EMAIL_RE = re.compile(EMAIL_REGEX)
_IPV4_RE = re.compile(IPV4_REGEX)


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
