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
    BACKEND_CORS_ORIGINS: str = ""
    API_V1_PREFIX: str = "/api"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.BACKEND_CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
