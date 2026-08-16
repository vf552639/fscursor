from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.validators import is_valid_domain, normalize_domain


def _checked_domain_name(value: str) -> str:
    """Имя домена — проверенное и уже нормализованное.

    До этой проверки имя не проверял НИ один одиночный путь: `is_valid_domain`
    звался только в массовых, и `POST /domains` с телом «не домен вовсе»
    отвечал 201. Мусор оттуда уходит в десктоп как имя будущей зоны Cloudflare
    — то есть всплывает у CF API, на шаге, где его никто не ждёт, и ПОСЛЕ того
    как связки уже записаны.

    Нормализация идёт до проверки формы: иначе `Example.COM.` (как его и
    вводят руками) был бы отвергнут.

    Значение присланной строки в текст ошибки НЕ вставляется: 422 отдаёт
    `input` отдельным полем, и обработчик в `app/main.py` умеет его снять, а из
    текста — не может.
    """
    normalized = normalize_domain(value)
    if not is_valid_domain(normalized):
        raise ValueError("not a valid domain name")
    return normalized


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
    # Валидатор объявлен на `DomainCreate`, а не на общей `DomainBase`:
    # `DomainResponse` наследует ту же базу и читает строки, заведённые ДО
    # появления правила, — на базе оно сделало бы их нечитаемыми (500 на
    # `GET /domains`). Схем записи с именем домена две, и правило стоит на
    # каждой отдельно: см. `DomainUpdate`.
    @field_validator("domain_name")
    @classmethod
    def _validate_domain_name(cls, value: str) -> str:
        return _checked_domain_name(value)


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
    # Пароль FTP пользователь задаёт вручную старым доменам: фронт кладёт блоб и
    # присылает сюда его id (плейнтекст на сервер не уходит — это тот же путь,
    # что и `ssh_password_blob_id` у сервера). `PUT /domains/{id}` его применяет
    # общим циклом `setattr` в `domain_service.update`.
    ftp_password_blob_id: Optional[UUID] = None
    # Пароль БД — тот же путь, что и FTP выше: provision генерирует его на
    # сервере и больше нигде не хранит, фронт шифрует в блоб и присылает сюда
    # только его id. Плейнтекста здесь нет и быть не должно.
    db_password_blob_id: Optional[UUID] = None

    # Переименование — тот же путь записи имени, что и заведение, и правило на
    # нём то же: без него `PUT {"domain_name": "не домен вовсе"}` отвечал 200,
    # а слишком длинное имя — 500 из драйвера. `None` значит «поле не
    # прислали», то есть «не менять», и проходит насквозь.
    @field_validator("domain_name")
    @classmethod
    def _validate_domain_name(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else _checked_domain_name(value)


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
    # Снимок с сервера и его две отметки времени (разбор — в модели и в
    # `DomainFactsIn`). `ftp_password_blob_id` наружу отдавать безопасно: это id
    # непрозрачного блоба, а не пароль, — ровно как `ServerResponse` отдаёт
    # `fastpanel_password_blob_id` (на нём во фронте стоит `RevealSecret`).
    fp_checked_at: Optional[datetime] = None
    fp_check_error: Optional[str] = None
    fp_facts: Optional[dict] = None
    fp_facts_at: Optional[datetime] = None
    # Зарезервированная колонка под будущий SQL-фильтр по обработчику. Роут
    # `apply_facts` её НЕ пишет (снимок целиком лежит в `fp_facts`), поэтому
    # наружу она пока всегда `None`; UI берёт обработчик из `fp_facts.php_handler`.
    # Заполнится, когда появится фильтрация доменов по обработчику на уровне SQL.
    php_handler: Optional[str] = None
    ftp_password_blob_id: Optional[UUID] = None
    # id блоба с паролем БД — наружу безопасен по той же причине, что и
    # `ftp_password_blob_id` выше: это непрозрачная ссылка, а не пароль. Фронт
    # берёт его, чтобы при переprovision переписать тот же блоб, а не осиротить.
    db_password_blob_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


class DomainFactsIn(BaseModel):
    """Результат чтения состояния домена с сервера, снятый десктопом по SSH.

    Зеркало `ServerMetricsIn`, и по тем же причинам. После переезда на
    zero-knowledge бэкенд на сервер зайти не может (SSH-пароль — зашифрованный
    блоб), состояние читает десктоп (принцип №3), а эта схема — дверь, через
    которую результат попадает в колонки.

    Ровно два исхода, и тело описывает один из них:

    * `{"facts": {...}}` — успех. Снимок ложится в `fp_facts`, `fp_facts_at` и
      `fp_checked_at` получают текущее время сервера, `fp_check_error`
      обнуляется;
    * `{"error": "..."}` — неудача. `fp_check_error` пишется, `fp_checked_at`
      двигается, но снимок (`fp_facts`/`fp_facts_at`) НЕ трогается — провал не
      вправе ни стереть последний хороший снимок, ни омолодить его (принцип №6).

    Чего здесь нет и не должно быть:

    * времени — его ставит сервер (`domain_service.apply_facts`). Присланное
      клиентом означало бы, что «когда прочитали» диктуют часы удалённой машины;
    * секретов в любом виде — пароль FTP сюда не едет; он попадает в БД
      отдельным путём (блоб + `ftp_password_blob_id` через `PUT /domains/{id}`).

    Всё, что не перечислено, — 422 `extra_forbidden` (см. `ServerCreate`, там
    записана история правила). Тело без единственного значащего поля — тоже 422
    (`_at_least_facts_or_error`): пустая попытка ничего не сообщает и лишь
    двигала бы `fp_checked_at`, из-за чего протухший снимок начал бы выглядеть
    свежим.

    Успех — это `facts` с содержимым, а не `facts: null`. Здесь мы намеренно
    ЖЁСТЧЕ зеркала (`ServerMetricsIn`, где `null` на отдельной метрике — легальное
    «эту метрику снять не смогли»): там поле — одно из многих показаний, а тут
    `facts` — весь снимок целиком, и `null` в нём не значит ничего законного.
    «Не смогли прочитать» выражается каналом `error`; `{"facts": null}` без
    `error` попал бы в success-ветку и стёр бы (да ещё омолодил) последний
    хороший снимок — ровно то, что инвариант двух времён обязан не допустить.
    Поэтому такое тело — 422 (`_at_least_facts_or_error`).
    """

    model_config = ConfigDict(extra="forbid")

    facts: Optional[dict] = None
    error: Optional[str] = None

    @model_validator(mode="after")
    def _at_least_facts_or_error(self) -> "DomainFactsIn":
        """Тело обязано нести успех (`facts` с содержимым) либо неудачу (`error`).

        Две проверки, обе про инвариант двух времён:

        * тело без единственного значащего поля — отказ. Считается
          `model_fields_set`, а не значения: `{"error": ...}` — законная неудача,
          а тело вовсе без полей смысла не несёт (та же граница, что у
          `ServerMetricsIn._at_least_one_metric`);
        * успех без снимка — тоже отказ. Если `error` не задан, это success-путь,
          и `facts=None` там стёр бы и омолодил последний хороший снимок. «Не
          смогли прочитать» шлётся через `error`, а не `facts: null`.
        """
        if not self.model_fields_set:
            raise ValueError("either 'facts' or 'error' must be present")
        if self.error is None and self.facts is None:
            raise ValueError(
                "'facts' must be a non-null snapshot on success; "
                "send 'error' to report a failure"
            )
        return self


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
