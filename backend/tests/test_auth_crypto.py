import pytest
from itsdangerous import timed as timed_mod

from app.auth.crypto import hash_auth_key, parse_session_token, sign_session_token, verify_auth_key


def test_hash_and_verify_auth_key():
    key = b"a" * 32
    h = hash_auth_key(key)
    assert verify_auth_key(key, h)
    assert not verify_auth_key(b"b" * 32, h)


def test_session_token_roundtrip():
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    token = sign_session_token(user_id)
    assert parse_session_token(token, max_age=60) == user_id


def test_session_token_expired(monkeypatch):
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    monkeypatch.setattr(timed_mod.time, "time", lambda: 0.0)
    token = sign_session_token(user_id)
    monkeypatch.setattr(timed_mod.time, "time", lambda: 9999.0)
    assert parse_session_token(token, max_age=1) is None


def test_session_token_tampered():
    token = sign_session_token("550e8400-e29b-41d4-a716-446655440000") + "x"
    assert parse_session_token(token, max_age=60) is None
