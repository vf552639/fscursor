from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.validators import (
    PROVIDER_MAX_LEN,
    is_valid_fastpanel_url,
    is_valid_fastpanel_user,
    is_valid_provider,
)


def _checked_fastpanel_url(value: Optional[str]) -> Optional[str]:
    """Отвергнуть адрес панели, в котором сидят креды или мусор.

    Канонический комментарий на обе схемы записи. Значение приезжает
    write-back'ом с десктопа после установки FastPanel; его разбор — регекс по
    stdout инсталлятора, и `https://admin:s3cr3t@ip:8888/` он матчит наравне с
    нормальным адресом. Дальше это значение уходит в колонку и в metadata
    аудита, где гард редакции смотрит на ИМЕНА полей, — а имя `url` секретным
    не выглядит.

    Десктоп с этого спринта срезает userinfo сам
    (`provision/fastpanel_install.rs`), но десктоп — не единственный возможный
    клиент, и серверная схема закрывает дверь в БД для любого из них.

    Отказ, а не тихая очистка: сервер тут получатель, а не источник. Молча
    переписать присланное значило бы спрятать дефект клиента и развести БД с
    тем, что клиент считает записанным; у самого клиента адрес панели есть, и
    он может прислать его правильно.

    Условие `is not None` — не то же самое, что `if value`: пустая строка
    должна получить 422, а не проехать как «нечего проверять».
    """
    if value is not None and not is_valid_fastpanel_url(value):
        raise ValueError("must be an http(s) URL with host:port and without credentials")
    return value


def _checked_fastpanel_user(value: Optional[str]) -> Optional[str]:
    """Отвергнуть логин панели с пробелами, управляющими или пустой. См. выше."""
    if value is not None and not is_valid_fastpanel_user(value):
        raise ValueError("must be non-empty and free of spaces and control characters")
    return value


def _checked_provider(value: Optional[str]) -> Optional[str]:
    """Привести имя провайдера к хранимому виду или отвергнуть его.

    Поле свободное — фиксированного списка провайдеров нет и не будет, — но
    непроверенная свободная строка уже стоила этому проекту дыры: разобранный
    `fastpanel_url` уезжал в колонку, в UI и в metadata аудита вместе с
    паролем внутри (долг №10). Провайдер секретом не является, зато `\\n` в нём
    рвёт строку аудит-лога надвое, а значение длиннее колонки превращает
    внятный 422 в 500 из Postgres. Обе проверки — в `is_valid_provider`.

    Здесь, в отличие от `_checked_fastpanel_url`, значение НОРМАЛИЗУЕТСЯ, а не
    отвергается за обрамляющие пробелы, и это осознанное расхождение. Источник
    другой: адрес панели приезжает write-back'ом от машины (клиент знает
    правильное значение и обязан прислать именно его), а провайдера набирает
    человек в форме. И назначение другое: провайдер — ключ группировки, по нему
    строятся `datalist` подсказок и фильтр списка серверов (фазы 2–3 плана).
    «Hetzner » с хвостовым пробелом дал бы в фильтре второй «тот же самый»
    провайдер — дефект, которого пользователь не увидит и не поймёт.

    Пустая строка после обрезки — это `NULL`, а не `""`: очищенное поле формы
    означает «провайдер не указан», и хранить для этого два разных значения
    незачем — фильтр и подсказки считали бы `""` отдельным провайдером.
    """
    if value is None:
        return None
    provider = value.strip()
    if not provider:
        return None
    if not is_valid_provider(provider):
        raise ValueError(
            f"must be at most {PROVIDER_MAX_LEN} characters and free of control characters"
        )
    return provider


class ServerBase(BaseModel):
    name: str
    ip_address: str
    ssh_port: int = 22
    ssh_user: str = "root"
    os: Optional[str] = None
    # Рядом с `os`, а не среди полей записи ниже: это такой же описательный
    # атрибут железа, нужный и на входе (`ServerCreate`), и на выходе
    # (`ServerResponse`). Проверка живёт на схемах записи — см. ниже.
    provider: Optional[str] = None
    purchase_date: Optional[date] = None
    expiry_date: Optional[date] = None


class ServerCreate(ServerBase):
    # Незнакомое поле — это отказ, а не тишина. С дефолтным `extra="ignore"`
    # форма могла прислать `ssh_password` плейнтекстом, сервер молча выбрасывал
    # его и отвечал 201 с `ssh_password_blob_id = NULL`: пользователь видел
    # «сохранено», а секрет исчезал бесследно.
    #
    # Канонический комментарий на все шесть схем записи (`ServerCreate/Update`,
    # `CloudflareAccount*`, `RegistrarAccount*`) — остальные ссылаются сюда.
    #
    # Конфиг стоит на каждой схеме отдельно, а не на общей базе, и НЕ потому,
    # что на базе нельзя: `ServerResponse` наследует ту же `ServerBase`, но
    # `extra="forbid"` ему не мешает — `model_validate` ORM-объекта идёт не
    # через dict, и лишние атрибуты не проверяются (проверено на pydantic 2.9).
    # Причины две, обе практические: на самой схеме видно, что она запрещает
    # лишнее, и снятие запрета роняет ровно её тест — на общей базе одна правка
    # разом погасила бы ловушку у всех шести, и красное сказало бы «сломано
    # где-то».
    model_config = ConfigDict(extra="forbid")

    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_user: Optional[str] = None
    fastpanel_password_blob_id: Optional[UUID] = None
    fastpanel_url: Optional[str] = None
    fastpanel_status: Optional[str] = "not_installed"

    # Валидаторы объявлены на каждой схеме отдельно по той же причине, что и
    # `extra="forbid"` выше: снятие проверки роняет тест ровно этой схемы.
    @field_validator("fastpanel_url")
    @classmethod
    def _validate_fastpanel_url(cls, v: Optional[str]) -> Optional[str]:
        return _checked_fastpanel_url(v)

    @field_validator("fastpanel_user")
    @classmethod
    def _validate_fastpanel_user(cls, v: Optional[str]) -> Optional[str]:
        return _checked_fastpanel_user(v)

    @field_validator("provider")
    @classmethod
    def _validate_provider(cls, v: Optional[str]) -> Optional[str]:
        return _checked_provider(v)


class ServerUpdate(BaseModel):
    # См. `ServerCreate`: незнакомое поле — 422, а не тихая потеря.
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = None
    ip_address: Optional[str] = None
    ssh_port: Optional[int] = None
    ssh_user: Optional[str] = None
    os: Optional[str] = None
    provider: Optional[str] = None
    status: Optional[str] = None
    purchase_date: Optional[date] = None
    expiry_date: Optional[date] = None
    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_user: Optional[str] = None
    fastpanel_password_blob_id: Optional[UUID] = None
    fastpanel_url: Optional[str] = None
    fastpanel_status: Optional[str] = None

    # См. `ServerCreate`: креды внутри URL и управляющие символы в логине — 422.
    @field_validator("fastpanel_url")
    @classmethod
    def _validate_fastpanel_url(cls, v: Optional[str]) -> Optional[str]:
        return _checked_fastpanel_url(v)

    @field_validator("fastpanel_user")
    @classmethod
    def _validate_fastpanel_user(cls, v: Optional[str]) -> Optional[str]:
        return _checked_fastpanel_user(v)

    # Своя копия по той же причине, что и у соседей: снятие проверки с правки
    # сервера обязано ронять тест правки, а не прятаться за проверкой создания.
    @field_validator("provider")
    @classmethod
    def _validate_provider(cls, v: Optional[str]) -> Optional[str]:
        return _checked_provider(v)


class ServerResponse(ServerBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    fastpanel_status: str
    fastpanel_url: Optional[str] = None
    fastpanel_user: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    has_ssh: bool = False
    uptime_seconds: Optional[int] = None
    cpu_usage_pct: Optional[int] = None
    cpu_count: Optional[int] = None
    ram_used_mb: Optional[int] = None
    ram_total_mb: Optional[int] = None
    disk_used_gb: Optional[int] = None
    disk_total_gb: Optional[int] = None
    net_in_kbps: Optional[int] = None
    net_out_kbps: Optional[int] = None
    os_pretty: Optional[str] = None
    kernel: Optional[str] = None
    fastpanel_version: Optional[str] = None
    fastpanel_port: Optional[int] = None
    metrics_collected_at: Optional[datetime] = None
    last_check_at: Optional[datetime] = None
    last_check_ok: Optional[bool] = None
    last_check_error: Optional[str] = None
    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_password_blob_id: Optional[UUID] = None


class ServerListResponse(BaseModel):
    items: list[ServerResponse]
    total: int


class SSHTestResponse(BaseModel):
    success: bool
    message: str


class InstallFastpanelResponse(BaseModel):
    task_id: str
    server_id: int


class FastpanelStatusResponse(BaseModel):
    server_id: int
    fastpanel_status: str
    fastpanel_url: Optional[str] = None
    fastpanel_user: Optional[str] = None
    log_tail: list[str]


class SyncDomainsResponse(BaseModel):
    created: int
    linked: int
    total: int
    error: Optional[str] = None


class ServerBulkImportError(BaseModel):
    row: int
    server: str
    reason: str


class ServerBulkImportResponse(BaseModel):
    created: int
    skipped: int
    errors: list[ServerBulkImportError]
    errors_csv_url: Optional[str] = None
