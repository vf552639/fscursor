import uuid

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    SUPABASE_DB_URL: str
    SUPABASE_URL: str
    SUPABASE_KEY: str
    REDIS_URL: str
    CELERY_BROKER_URL: str
    CELERY_RESULT_BACKEND: str
    ENCRYPTION_KEY: str
    SECRET_KEY: str
    BACKEND_CORS_ORIGINS: str = "http://localhost:3100,http://localhost:8080"
    API_V1_PREFIX: str = "/api"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.BACKEND_CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()


def _asyncpg_prepared_statement_name() -> str:
    return f"__asyncpg_{uuid.uuid4().hex}__"


# asyncpg + Supabase pooler (transaction mode / port 6543): PgBouncer may swap backends
# per transaction; disable statement caches and use unique prepared statement names.
ASYNCPG_CONNECT_ARGS: dict[str, object] = {
    "server_settings": {"statement_timeout": "60000"},
    "statement_cache_size": 0,
    "prepared_statement_cache_size": 0,
    "prepared_statement_name_func": _asyncpg_prepared_statement_name,
}
