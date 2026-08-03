import base64
import binascii
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import uuid

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.auth import schemas
from app.auth.crypto import hash_auth_key, sign_session_token, verify_auth_key
from app.auth.dependencies import get_current_user_or_401
from app.auth.email import send_confirmation_email
from app.auth.models import RecoveryBlob, Session as DbSession, User
from app.blobs.models import BlobStorage
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter

router = APIRouter(prefix="/auth", tags=["auth"])


def _b64decode(s: str) -> bytes:
    return base64.b64decode(s.encode("utf-8"))


def _b64decode_or_400(s: str, field: str) -> bytes:
    try:
        return base64.b64decode(s.encode("utf-8"), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid base64 in {field}")


# Сравнение по времени с несуществующим пользователем: без этого recovery/finish
# отвечает 401 мгновенно для неизвестного email и медленно (bcrypt) для известного.
@lru_cache(maxsize=1)
def _dummy_recovery_hash() -> bytes:
    return hash_auth_key(b"\x00" * 32)


def _burn_recovery_timing(candidate: bytes) -> None:
    verify_auth_key(candidate, _dummy_recovery_hash())


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_TTL_SECONDS,
        httponly=True,
        secure=False,
        samesite="strict",
    )


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: schemas.RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    existing = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")
    salt = _b64decode(body.salt_b64)
    auth_key = _b64decode(body.auth_key_b64)
    recovery_blob = _b64decode(body.recovery_blob_b64)
    recovery_auth_key = _b64decode_or_400(body.recovery_auth_key_b64, "recovery_auth_key_b64")
    confirm_token = secrets.token_urlsafe(32)
    user = User(
        email=body.email,
        salt=salt,
        auth_key_hash=hash_auth_key(auth_key),
        email_confirm_token_hash=hashlib.sha256(confirm_token.encode("utf-8")).digest(),
    )
    db.add(user)
    await db.flush()
    db.add(
        RecoveryBlob(
            user_id=user.id,
            ciphertext=recovery_blob,
            recovery_auth_key_hash=hash_auth_key(recovery_auth_key),
        )
    )
    await db.commit()
    await send_confirmation_email(body.email, confirm_token)
    return {"user_id": str(user.id)}


@router.post("/confirm-email", status_code=status.HTTP_200_OK)
async def confirm_email(
    body: schemas.ConfirmEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    token_hash = hashlib.sha256(body.token.encode("utf-8")).digest()
    user = (
        await db.execute(select(User).where(User.email_confirm_token_hash == token_hash))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired token")
    user.email_confirmed_at = datetime.now(timezone.utc)
    user.email_confirm_token_hash = None
    await db.commit()
    return {"ok": True}


@router.post("/login/start", response_model=schemas.LoginStartResponse)
async def login_start(
    body: schemas.LoginStartRequest,
    db: AsyncSession = Depends(get_db),
) -> schemas.LoginStartResponse:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        dummy = hashlib.sha256(body.email.lower().encode("utf-8")).digest()[:16]
        return schemas.LoginStartResponse(salt_b64=base64.b64encode(dummy).decode())
    return schemas.LoginStartResponse(salt_b64=base64.b64encode(user.salt).decode())


@router.post("/login/finish")
@limiter.limit("10/minute")
async def login_finish(
    request: Request,
    body: schemas.LoginFinishRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    if not verify_auth_key(_b64decode(body.auth_key_b64), user.auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    if user.totp_secret:
        if not body.totp_code or not pyotp.TOTP(user.totp_secret).verify(
            body.totp_code, valid_window=1
        ):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid TOTP code")
    if user.email_confirmed_at is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "email not confirmed")
    token = sign_session_token(str(user.id))
    expires = datetime.now(timezone.utc) + timedelta(seconds=settings.SESSION_TTL_SECONDS)
    db.add(
        DbSession(
            user_id=user.id,
            token_hash=hashlib.sha256(token.encode("utf-8")).digest(),
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:255],
            expires_at=expires,
        )
    )
    await audit_service.log(
        db,
        user_id=user.id,
        action="auth.login",
        ip=request.client.host if request.client else None,
        metadata={"email": user.email},
    )
    await db.commit()
    _set_session_cookie(response, token)
    return {"user_id": str(user.id)}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> None:
    cookie_value = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if cookie_value:
        token_hash = hashlib.sha256(cookie_value.encode("utf-8")).digest()
        sess = (
            await db.execute(select(DbSession).where(DbSession.token_hash == token_hash))
        ).scalar_one_or_none()
        if sess is not None:
            await audit_service.log(
                db,
                user_id=sess.user_id,
                action="auth.logout",
                ip=request.client.host if request.client else None,
            )
            await db.delete(sess)
            await db.commit()
    response.delete_cookie(settings.SESSION_COOKIE_NAME)


@router.get("/me", response_model=schemas.UserMeResponse)
async def me(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.UserMeResponse:
    rb = await db.get(RecoveryBlob, user.id)
    return schemas.UserMeResponse(
        id=user.id,
        email=user.email,
        email_confirmed_at=user.email_confirmed_at,
        totp_enabled=user.totp_secret is not None,
        # Ровно то же условие, по которому recovery/finish отдаёт 409. Аккаунт,
        # заведённый до миграции 014, восстановиться не может, и узнать об этом
        # он должен заранее, а не в момент, когда пароль уже потерян.
        recovery_configured=rb is not None and rb.recovery_auth_key_hash is not None,
    )


@router.post("/recovery/setup", status_code=status.HTTP_200_OK)
async def recovery_setup(
    request: Request,
    body: schemas.RecoverySetupRequest,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """(Пере)настроить recovery: новый блоб + хеш ключа-доказательства.

    Единственный путь, которым пользователь с NULL-хешем (recovery настроен до
    миграции 014) снова получает право на /recovery/finish.
    """
    if not verify_auth_key(_b64decode_or_400(body.auth_key_b64, "auth_key_b64"), user.auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid current password")
    ciphertext = _b64decode_or_400(body.recovery_blob_b64, "recovery_blob_b64")
    key_hash = hash_auth_key(_b64decode_or_400(body.recovery_auth_key_b64, "recovery_auth_key_b64"))
    rb = await db.get(RecoveryBlob, user.id)
    if rb is None:
        db.add(
            RecoveryBlob(user_id=user.id, ciphertext=ciphertext, recovery_auth_key_hash=key_hash)
        )
    else:
        rb.ciphertext = ciphertext
        rb.recovery_auth_key_hash = key_hash
    await audit_service.log(
        db,
        user_id=user.id,
        action="auth.recovery_setup",
        ip=request.client.host if request.client else None,
    )
    await db.commit()
    return {"ok": True}


@router.post("/recovery/start", response_model=schemas.RecoveryStartResponse)
@limiter.limit("10/minute")
async def recovery_start(
    request: Request,
    body: schemas.RecoveryStartRequest,
    db: AsyncSession = Depends(get_db),
) -> schemas.RecoveryStartResponse:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        return schemas.RecoveryStartResponse(
            salt_b64=base64.b64encode(secrets.token_bytes(16)).decode(),
            recovery_blob_b64=base64.b64encode(secrets.token_bytes(96)).decode(),
        )
    rb = await db.get(RecoveryBlob, user.id)
    if rb is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "recovery not configured")
    return schemas.RecoveryStartResponse(
        salt_b64=base64.b64encode(user.salt).decode(),
        recovery_blob_b64=base64.b64encode(rb.ciphertext).decode(),
    )


@router.post("/recovery/finish", status_code=status.HTTP_200_OK)
@limiter.limit("5/minute")
async def recovery_finish(
    request: Request,
    body: schemas.RecoveryFinishRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    # --- Только чтение и валидация до самого конца проверок. ---
    proof = _b64decode_or_400(body.recovery_auth_key_b64, "recovery_auth_key_b64")
    new_salt = _b64decode_or_400(body.new_salt_b64, "new_salt_b64")
    new_auth_key = _b64decode_or_400(body.new_auth_key_b64, "new_auth_key_b64")
    new_blob = _b64decode_or_400(body.new_recovery_blob_b64, "new_recovery_blob_b64")
    rotated_key = (
        _b64decode_or_400(body.new_recovery_auth_key_b64, "new_recovery_auth_key_b64")
        if body.new_recovery_auth_key_b64 is not None
        else None
    )

    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        # Тот же ответ, что и на неверный ключ: эндпоинт не подтверждает существование email.
        _burn_recovery_timing(proof)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid recovery key")
    rb = await db.get(RecoveryBlob, user.id)
    if rb is None or rb.recovery_auth_key_hash is None:
        _burn_recovery_timing(proof)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "recovery is not configured for this account: sign in and set up recovery "
            "again (Settings -> recovery) before using recovery",
        )
    if not verify_auth_key(proof, rb.recovery_auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid recovery key")

    # --- Ниже — первая мутация. Всё, что выше, ничего не меняет. ---
    user.salt = new_salt
    user.auth_key_hash = hash_auth_key(new_auth_key)
    rb.ciphertext = new_blob
    if rotated_key is not None:
        rb.recovery_auth_key_hash = hash_auth_key(rotated_key)
    await db.execute(sa_delete(DbSession).where(DbSession.user_id == user.id))
    await audit_service.log(
        db,
        user_id=user.id,
        action="auth.recovery",
        ip=request.client.host if request.client else None,
    )
    await db.commit()
    return {"ok": True, "user_id": str(user.id)}


@router.post("/password/change", status_code=status.HTTP_200_OK)
async def change_password(
    request: Request,
    body: schemas.ChangePasswordRequest,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not verify_auth_key(_b64decode(body.old_auth_key_b64), user.auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid current password")
    user.salt = _b64decode(body.new_salt_b64)
    user.auth_key_hash = hash_auth_key(_b64decode(body.new_auth_key_b64))
    for entry in body.re_encrypted_blobs:
        blob = await db.get(BlobStorage, uuid.UUID(entry["id"]))
        if blob is None or blob.user_id != user.id:
            continue
        blob.ciphertext = _b64decode(entry["ciphertext_b64"])
    await audit_service.log(
        db,
        user_id=user.id,
        action="auth.password_change",
        ip=request.client.host if request.client else None,
    )
    await db.commit()
    return {"ok": True}


@router.post("/totp/enable", response_model=schemas.TotpEnableResponse)
async def totp_enable(
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.TotpEnableResponse:
    if user.totp_secret:
        raise HTTPException(status.HTTP_409_CONFLICT, "totp already enabled")
    secret = pyotp.random_base32()
    user.totp_secret = secret
    await audit_service.log(
        db,
        user_id=user.id,
        action="auth.totp_enable",
        ip=request.client.host if request.client else None,
    )
    await db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="SDMP")
    return schemas.TotpEnableResponse(provisioning_uri=uri, secret=secret)


@router.post("/totp/verify", status_code=status.HTTP_200_OK)
async def totp_verify(
    body: schemas.TotpVerifyRequest,
    user: User = Depends(get_current_user_or_401),
) -> dict:
    if not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "totp not enabled")
    ok = pyotp.TOTP(user.totp_secret).verify(body.code, valid_window=1)
    return {"ok": ok}
