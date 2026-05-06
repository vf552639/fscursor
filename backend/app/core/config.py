import uuid
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/core/config.py -> repo root is parents[3]
_REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(_REPO_ROOT / ".env"), str(_REPO_ROOT / "backend" / ".env")),
        extra="ignore",
    )

    SUPABASE_DB_URL: str
    SUPABASE_URL: str
    SUPABASE_KEY: str
    REDIS_URL: str
    CELERY_BROKER_URL: str
    CELERY_RESULT_BACKEND: str

    SECRET_KEY: str
    SESSION_COOKIE_NAME: str = "sdmp_session"
    SESSION_TTL_SECONDS: int = 60 * 60 * 24 * 14
    BCRYPT_ROUNDS: int = 12

    RESEND_API_KEY: Optional[str] = None
    EMAIL_FROM: str = "noreply@sdmp.app"
    EMAIL_CONFIRM_BASE_URL: str = "http://localhost:3100"

    BACKEND_CORS_ORIGINS: str = (
        "http://localhost:3100,http://localhost:8080,tauri://localhost"
    )
    API_V1_PREFIX: str = "/api"
    LOG_LEVEL: str = "INFO"
    LOG_DIR: Path = Path("logs")

    DNS_PRECHECK_ATTEMPTS: int = 10
    DNS_PRECHECK_DELAY: int = 15

    TELEGRAM_BOT_TOKEN: Optional[str] = None
    TELEGRAM_CHAT_ID: Optional[str] = None

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.BACKEND_CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()


def _asyncpg_prepared_statement_name() -> str:
    return f"__asyncpg_{uuid.uuid4().hex}__"


ASYNCPG_CONNECT_ARGS: dict[str, object] = {
    "server_settings": {"statement_timeout": "60000"},
    "statement_cache_size": 0,
    "prepared_statement_cache_size": 0,
    "prepared_statement_name_func": _asyncpg_prepared_statement_name,
}
