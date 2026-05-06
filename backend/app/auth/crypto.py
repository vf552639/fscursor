import time
from typing import Callable, Optional

import bcrypt
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from app.core.config import settings

_signer = TimestampSigner(settings.SECRET_KEY, salt="sdmp.session")


def hash_auth_key(auth_key: bytes) -> bytes:
    return bcrypt.hashpw(auth_key, bcrypt.gensalt(rounds=settings.BCRYPT_ROUNDS))


def verify_auth_key(auth_key: bytes, stored_hash: bytes) -> bool:
    try:
        return bcrypt.checkpw(auth_key, stored_hash)
    except ValueError:
        return False


def sign_session_token(user_id: str) -> str:
    raw = user_id.encode("utf-8")
    signed = _signer.sign(raw)
    return signed.decode("utf-8")


def parse_session_token(token: str, *, max_age: int) -> Optional[str]:
    try:
        raw = _signer.unsign(token.encode("utf-8"), max_age=max_age)
        return raw.decode("utf-8")
    except (BadSignature, SignatureExpired):
        return None
