import os

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

_storage_uri = "memory://" if os.getenv("USE_MEMORY_RATE_LIMIT") == "1" else settings.REDIS_URL

limiter = Limiter(key_func=get_remote_address, storage_uri=_storage_uri)
