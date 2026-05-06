import hashlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.crypto import parse_session_token
from app.auth.models import Session as DbSession, User
from app.core.config import settings
from app.core.database import get_db


async def get_current_user_or_401(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    cookie_value: Optional[str] = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not cookie_value:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing session")
    user_id_str = parse_session_token(cookie_value, max_age=settings.SESSION_TTL_SECONDS)
    if user_id_str is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session")
    token_hash = hashlib.sha256(cookie_value.encode("utf-8")).digest()
    sess = (await db.execute(select(DbSession).where(DbSession.token_hash == token_hash))).scalar_one_or_none()
    if sess is None or sess.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    user = await db.get(User, uuid.UUID(user_id_str))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user
