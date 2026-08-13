from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.validators import DOMAIN_NAME_MAX_LEN, is_valid_domain, normalize_domain


class DomainBase(BaseModel):
    domain_name: str
    registrar_id: Optional[int] = None
    server_id: Optional[int] = None
    cloudflare_account_id: Optional[int] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_enabled: bool = False
    expiry_date: Optional[date] = None
    purchase_date: Optional[date] = None


class DomainCreate(DomainBase):
    @field_validator("domain_name")
    @classmethod
    def _checked_domain_name(cls, value: str) -> str:
        """Имя домена — проверенное и уже нормализованное.

        До этой проверки `POST /domains` принимал что угодно: `is_valid_domain`
        звался только в массовых путях, и «не домен вовсе» заводился со
        статусом 201. Одиночный вход мастера full-setup идёт ровно сюда, а
        дальше имя уходит в десктоп как имя будущей зоны Cloudflare — то есть
        мусор всплывал бы у CF API, на шаге, где его никто не ждёт, и ПОСЛЕ
        того как связки уже записаны.

        Валидатор стоит на `DomainCreate`, а не на общей `DomainBase`:
        `DomainResponse` наследует ту же базу и читает строки, заведённые до
        этой проверки, — правило на базе сделало бы их нечитаемыми (500 на
        `GET /domains`).

        Значение присланной строки в текст ошибки НЕ вставляется: 422 отдаёт
        `input` отдельным полем, и обработчик в `app/main.py` умеет его снять,
        а из текста — не может.
        """
        normalized = normalize_domain(value)
        if not is_valid_domain(normalized):
            raise ValueError("not a valid domain name")
        if len(normalized) > DOMAIN_NAME_MAX_LEN:
            raise ValueError(f"domain name is longer than {DOMAIN_NAME_MAX_LEN} characters")
        return normalized


class DomainUpdate(BaseModel):
    domain_name: Optional[str] = None
    status: Optional[str] = None
    registrar_id: Optional[int] = None
    server_id: Optional[int] = None
    cloudflare_account_id: Optional[int] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_enabled: Optional[bool] = None
    expiry_date: Optional[date] = None
    purchase_date: Optional[date] = None
    ns_status: Optional[str] = None
    ns_check_mode: Optional[str] = None
    site_user: Optional[str] = None
    site_path: Optional[str] = None
    ssl_status: Optional[str] = None
    ssl_expires_at: Optional[datetime] = None
    ssl_issuer: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    nginx_override: Optional[str] = None
    nginx_presets: Optional[dict] = None
    last_provision_error: Optional[str] = None


class DomainResponse(DomainBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    ns_status: Optional[str] = None
    ns_updated_at: Optional[datetime] = None
    site_user: Optional[str] = None
    site_path: Optional[str] = None
    ftp_user: Optional[str] = None
    ssl_status: Optional[str] = None
    ssl_email_used: Optional[str] = None
    ssl_expires_at: Optional[datetime] = None
    ssl_issuer: Optional[str] = None
    php_version: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    ns_check_mode: Optional[str] = None
    nginx_override: Optional[str] = None
    nginx_presets: Optional[dict] = None
    last_provision_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class DomainBulkCreate(BaseModel):
    domains_text: str
    registrar_id: Optional[int] = None


class DomainBulkCreateResponse(BaseModel):
    created: list[DomainResponse]
    skipped: list[str]


class DomainBulkCreateItem(BaseModel):
    domain_name: str
    registrar_id: Optional[int] = None
    registrar_name: Optional[str] = None


class DomainBulkStructuredCreate(BaseModel):
    items: list[DomainBulkCreateItem]


class DomainBulkAssignServer(BaseModel):
    domain_ids: list[int]
    server_id: Optional[int] = None


class DomainBulkAssignCloudflare(BaseModel):
    domain_ids: list[int]
    cloudflare_account_id: Optional[int] = None


class DomainBulkAssignResponse(BaseModel):
    updated: int


class SetNSResponse(BaseModel):
    task_id: str
    domain_id: int


class BulkSetNSRequest(BaseModel):
    domain_ids: list[int]


class BulkSetNSResponse(BaseModel):
    task_ids: list[str]


class CreateSiteRequest(BaseModel):
    site_only: bool = False


class NginxOverrideRequest(BaseModel):
    snippet: str = ""
    presets: dict = Field(default_factory=dict)


class NginxOverrideResponse(BaseModel):
    domain_id: int
    snippet: str
    presets: dict


class RefreshSslResponse(BaseModel):
    domain_id: int
    has_certificate: bool
    expires_at: Optional[datetime] = None
    issuer: Optional[str] = None
    is_letsencrypt: bool = False


class ProvisionResponse(BaseModel):
    task_id: str
    task_log_id: int
    domain_id: int


class BulkProvisionRequest(BaseModel):
    domain_ids: list[int]


class BulkProvisionResponse(BaseModel):
    task_ids: list[str]


class BulkFullSetupRequest(BaseModel):
    # `extra="forbid"` — то же правило, что у схем записи в `server.py` /
    # `cloudflare.py` / `registrar.py`: незнакомое поле в теле обязано дать 422,
    # а не молча пропасть. Здесь оно ещё и держит границу zero-knowledge —
    # тело full-setup описывает ТОЛЬКО связки, и попытка дослать сюда токен
    # Cloudflare (шаг зоны живёт в десктопе) отобьётся как `extra_forbidden`,
    # а не уедет на сервер.
    model_config = ConfigDict(extra="forbid")

    # Пустая пачка — это дефект вызывающего, а не «ноль обновлённых»: экран
    # зовёт full-setup по выделению, и выделение не бывает пустым.
    domain_ids: list[int] = Field(min_length=1)
    server_id: int
    cloudflare_account_id: int
    # `None` означает «не трогать регистратора», а НЕ «отвязать»: в мастере
    # поле необязательное, и у существующих доменов регистратор обычно уже
    # проставлен импортом. Отвязка делается через `PUT /domains/{id}`.
    registrar_id: Optional[int] = None


class FullSetupDomain(BaseModel):
    """Домен, доведённый бэкендом до состояния «связки проставлены».

    Ровно то, что нужно десктопу для следующего шага: `id` — адрес write-back
    `cloudflare_zone_id`, `domain_name` — имя будущей зоны.
    """

    id: int
    domain_name: str


class BulkFullSetupResponse(BaseModel):
    # Не `task_ids`/`task_log_ids`, как было объявлено в мёртвой версии этой
    # схемы: бэкенд после переезда на zero-knowledge не запускает по full-setup
    # ни одной задачи — зону заводит десктоп, у которого есть токен. Отдавать
    # id несуществующих задач значило бы описывать несуществующий контракт.
    domains: list[FullSetupDomain]
    # id из запроса, которых у этого пользователя нет (удалён в другой вкладке,
    # чужой). Строки отчёта, а не исключение: см. `bulk_full_setup`.
    skipped_ids: list[int]


class DomainBulkImportError(BaseModel):
    row: int
    domain: str
    reason: str


class DomainBulkImportResponse(BaseModel):
    created: int
    skipped: int
    errors: list[DomainBulkImportError]
    errors_csv_url: Optional[str] = None


class DomainBulkImportRequest(BaseModel):
    has_header: bool = Field(default=True)
    default_registrar_id: Optional[int] = None
