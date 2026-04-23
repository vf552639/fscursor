import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings


def _key() -> bytes:
    raw = settings.ENCRYPTION_KEY.encode("utf-8")
    return hashlib.sha256(raw).digest()


def encrypt(plaintext: str) -> str:
    if plaintext is None:
        return None  # type: ignore[return-value]
    aes = AESGCM(_key())
    nonce = os.urandom(12)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("utf-8")


def decrypt(token: str) -> str:
    if token is None:
        return None  # type: ignore[return-value]
    data = base64.b64decode(token.encode("utf-8"))
    nonce, ct = data[:12], data[12:]
    aes = AESGCM(_key())
    return aes.decrypt(nonce, ct, None).decode("utf-8")
