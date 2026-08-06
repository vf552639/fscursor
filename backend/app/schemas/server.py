from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

from app.core.validators import (
    FASTPANEL_VERSION_MAX_LEN,
    IP_ADDRESS_MAX_LEN,
    KERNEL_MAX_LEN,
    OS_MAX_LEN,
    OS_PRETTY_MAX_LEN,
    PG_BIGINT_MAX,
    PG_INT_MAX,
    PROVIDER_MAX_LEN,
    SERVER_NAME_MAX_LEN,
    SSH_USER_MAX_LEN,
    is_valid_column_text,
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
    внятный 422 в 500 из Postgres. Все такие проверки — в `is_valid_provider`,
    а через него в `is_valid_column_text`, где они и разобраны.

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


# Ширина колонки на каждое строковое поле сервера, которое заполняет клиент.
# Он же — список полей для валидатора (`@field_validator(*_SERVER_TEXT_MAX_LEN)`),
# по тем же соображениям, что и у `_TEXT_METRIC_MAX_LEN` ниже.
_SERVER_TEXT_MAX_LEN = {
    "name": SERVER_NAME_MAX_LEN,
    "ip_address": IP_ADDRESS_MAX_LEN,
    "ssh_user": SSH_USER_MAX_LEN,
    "os": OS_MAX_LEN,
}


def _checked_server_text(value: Optional[str], field_name: str) -> Optional[str]:
    """Свободная строка сервера — пригодна для своей колонки.

    Те же три свойства, что у `provider` и строковых метрик, и по тем же
    причинам: разбор — в `is_valid_column_text` (`core/validators.py`). Поля
    `name`, `ip_address`, `ssh_user`, `os` до сих пор не проверялись ничем, и
    `POST /api/servers` с 300-символьным именем (или с одиночным суррогатом в
    нём) отвечал 500 из `asyncpg` вместо 422 с именем поля.

    Проверяется РОВНО пригодность для колонки — не формат. В частности,
    `ip_address` этой проверкой адресом быть не обязывается: он и сегодня не
    валидируется как IP (`is_valid_ipv4` к нему не подключён), и вводить такое
    правило здесь значило бы протащить продуктовое решение под видом починки
    500-к. Это отдельный долг.

    Пустая строка тоже не запрещается, хотя `name` с `NOT NULL` пустым быть не
    должен: это снова другой класс правила (какое значение осмысленно), а не
    «влезает ли значение в колонку». Смешивать их — как раз тот способ, каким
    проверка тихо меняет поведение на входах, которые кто-то считал законными.

    Валидаторы объявлены на `ServerCreate` и `ServerUpdate` порознь, а не на
    общей `ServerBase`: `ServerResponse` наследует ту же базу и собирается из
    ORM-объекта, так что проверка на базе отвергала бы ЧТЕНИЕ уже лежащих в БД
    строк — 500 на ровном месте вместо 500, который мы чиним.
    """
    if value is not None and not is_valid_column_text(value, _SERVER_TEXT_MAX_LEN[field_name]):
        raise ValueError(
            f"must be at most {_SERVER_TEXT_MAX_LEN[field_name]} characters, "
            f"encodable as UTF-8 and free of control characters"
        )
    return value


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

    @field_validator(*_SERVER_TEXT_MAX_LEN)
    @classmethod
    def _validate_server_text(cls, v: Optional[str], info: ValidationInfo) -> Optional[str]:
        return _checked_server_text(v, info.field_name)


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

    @field_validator(*_SERVER_TEXT_MAX_LEN)
    @classmethod
    def _validate_server_text(cls, v: Optional[str], info: ValidationInfo) -> Optional[str]:
        return _checked_server_text(v, info.field_name)


# Ширина колонки на каждую строковую метрику. Словарём, а не тремя валидаторами
# по одному на поле: правило у них буквально одно, различается только число, и
# три копии `_checked_*` отличались бы друг от друга исключительно константой.
#
# Он же — единственный список этих полей: `_validate_text_metric` ниже
# объявляется через `*_TEXT_METRIC_MAX_LEN`, а не повторяет имена. Второй
# список разошёлся бы с этим молча, и поле, забытое здесь, роняло бы валидатор
# `KeyError`-ом — то есть 500, потому что `KeyError` pydantic в 422 не
# заворачивает.
_TEXT_METRIC_MAX_LEN = {
    "os_pretty": OS_PRETTY_MAX_LEN,
    "kernel": KERNEL_MAX_LEN,
    "fastpanel_version": FASTPANEL_VERSION_MAX_LEN,
}


class ServerMetricsIn(BaseModel):
    """Снимок метрик сервера, снятый десктопом по SSH.

    После переезда на zero-knowledge бэкенд не может залогиниться на сервер:
    SSH-пароль лежит зашифрованным блобом, ключа от которого у сервера нет.
    Метрики снимает десктоп (принцип №3 — «desktop выполняет, web смотрит»), а
    эта схема — дверь, через которую готовые числа попадают в колонки.

    Чего здесь нет и не должно быть:

    * `metrics_collected_at` — время снимка ставит сервер. Присланное клиентом
      означало бы, что «когда сняли» диктуют часы удалённой машины;
    * `status` и `last_check_*` — их не пишет сборщик метрик: снятый снимок
      ничего не говорит о том, считается ли сервер живым. Про `status` это
      именно «не здесь», а не «нигде»: его принимает `ServerUpdate` на
      `PUT /api/servers/{id}` — но то другая операция и другой смысл;
    * секретов в любом виде — сюда едут показания, а не креды.

    Всё, что не перечислено, — 422 `extra_forbidden`: см. `ServerCreate`, там
    записана история правила (поле `ssh_password` молча выбрасывалось, и API
    отвечал 200, ничего не сохранив).

    Границы диапазонов — не вкус, а защита от промахнувшегося парсера на чужой
    машине: `cpu_usage_pct` — доля от 0 до 100, всё прочее неотрицательно, а
    сверху упирается в ширину колонки Postgres (`PG_INT_MAX`/`PG_BIGINT_MAX`),
    иначе внятный 422 превращается в 500 из драйвера.

    Все поля опциональны, но тело без единого установленного поля — 422
    (`_at_least_one_metric` ниже). Что означает явный `null` и чем он
    отличается от неприсланного поля — единственный канонический разбор в
    `server_service.apply_metrics`, там же и контракт сборщика; здесь на него
    только ссылка.

    Содержимое строк не нормализуется (в отличие от `provider`, который
    набирает человек): источник — машинный парсер, у него нет «Hetzner » с
    хвостовым пробелом, а группировкой эти поля не служат. Что при этом
    проверяется — в `_validate_text_metric` ниже.
    """

    model_config = ConfigDict(extra="forbid")

    uptime_seconds: Optional[int] = Field(default=None, ge=0, le=PG_BIGINT_MAX)
    cpu_usage_pct: Optional[int] = Field(default=None, ge=0, le=100)
    cpu_count: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    ram_used_mb: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    ram_total_mb: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    disk_used_gb: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    disk_total_gb: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    net_in_kbps: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    net_out_kbps: Optional[int] = Field(default=None, ge=0, le=PG_INT_MAX)
    os_pretty: Optional[str] = None
    kernel: Optional[str] = None
    fastpanel_version: Optional[str] = None

    # Перебором по тому же словарю, а не вторым списком имён: разойдясь, они
    # дали бы `KeyError` внутри валидатора — а `KeyError` pydantic в 422 не
    # заворачивает, и поле, забытое в словаре, отвечало бы 500 на любое тело
    # с ним.
    @field_validator(*_TEXT_METRIC_MAX_LEN)
    @classmethod
    def _validate_text_metric(cls, v: Optional[str], info: ValidationInfo) -> Optional[str]:
        """Строка с чужой машины: пригодна для колонки и не пуста.

        Пригодность — три общих свойства (длина, управляющие символы,
        кодируемость в UTF-8); разбор каждого — в `is_valid_column_text`
        (`core/validators.py`). Источник здесь тот же, что у `fastpanel_url`, —
        вывод чужой машины, то есть строка, которую никто не набирал.

        Пустое значение — отказ, а не тихий `NULL`, и расхождение с
        `_checked_provider` выше намеренное. У провайдера источник — человек в
        форме, очищенное поле которой законно означает «не указано». Здесь
        источник машинный, и для машинного write-back'а в этом файле уже
        принято (`_checked_fastpanel_url`): сервер — получатель, а не источник,
        и молча переписывать присланное значит прятать дефект клиента. Сказать
        «не смогли снять» клиенту есть чем: `null` — часть контракта сборщика.
        Пусто считается по `strip()`, потому что строка из одних пробелов несёт
        ровно столько же показаний, сколько пустая; сами края при этом не
        срезаются — см. шапку схемы.
        """
        if v is None:
            return v
        max_len = _TEXT_METRIC_MAX_LEN[info.field_name]
        if not v.strip():
            raise ValueError("must not be blank; send null when the metric could not be read")
        if not is_valid_column_text(v, max_len):
            raise ValueError(
                f"must be at most {max_len} characters, encodable as UTF-8 "
                f"and free of control characters"
            )
        return v

    @model_validator(mode="after")
    def _at_least_one_metric(self) -> "ServerMetricsIn":
        """Тело без единого установленного поля — отказ.

        Пустой запрос ничего не сообщает о сервере и делает ровно одну вещь:
        двигает `metrics_collected_at`, из-за чего показания прошлого снимка
        начинают выглядеть свежими. «Снято только что» поверх недельных чисел —
        не пустая операция, а ложь в UI, и 200 в ответ был бы самым дешёвым
        способом её получить.

        Считается `model_fields_set`, а не значения: снимок, где парсер не смог
        разобрать ничего, — это законный запрос из двенадцати явных `null`, и
        он гасит протухшие числа, а не молодит их. Отвергается ровно отсутствие
        полей, а не отсутствие значений.
        """
        if not self.model_fields_set:
            raise ValueError("at least one metric field must be present")
        return self


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
