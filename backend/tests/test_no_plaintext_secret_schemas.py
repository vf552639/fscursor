"""Ни одна схема запроса/ответа не объявляет поле под плейнтекст-секрет.

Целевой инвариант продукта: секрет шифруется на клиенте, лежит в
`blob_storage` непрозрачными байтами, а сущность хранит только ссылку —
`*_blob_id`. Значит и в схемах не должно быть полей, куда плейнтекст физически
влезает.

Целевой, а не достигнутый: сегодня инвариант нарушен в одном известном месте —
`system_config` хранит «Webhook Secret» открытым текстом
(`services/system_config_service.py`), пишется он через `PUT
/api/settings/config/{key}` схемой `ConfigUpdate`, а поле там называется
`value`. По имени такой гард его не видит и увидеть не может; это отдельный
долг, а не дыра в переборе. Формулировка здесь стоит по факту нарочно: гард,
чья шапка обещает больше, чем он проверяет, вводит в заблуждение сильнее, чем
его отсутствие.

Почему этого НЕ ловит `test_secret_write_path.py`. Тот файл сторожит другой
дефект: плейнтекст в поле, которого в схеме НЕТ. Его ловит `extra="forbid"` —
422 `extra_forbidden`. Но `forbid` по построению молчит про поля, которые схема
ОБЪЯВЛЯЕТ: объяви завтра `db_password: str`, и тот же запрос пройдёт с 201, а
все 33 теста останутся зелёными. Ровно этот путь и был открыт до сегодня —
`DomainDbCredentials`/`DomainFtpCredentials` с `*_password: Optional[str]`
лежали в `schemas/domain.py` живыми классами, ничем не подключёнными: готовая
форма под новый роут (долг №12 спринта уборки).

Два перебора, и оба нужны:

* **по роутам** — всё, что реально подключено к приложению, включая модели,
  объявленные ПРЯМО в роуте (`api/routes/settings.py` объявляет четыре) и
  синтезированные FastAPI тела форм. Он fail-closed: новый роут с инлайновой
  схемой попадает под гард сам, без правки этого файла;
* **по модулям схем** — всё объявленное, даже если к роуту ещё не подключено.
  Ровно случай сегодняшнего долга: `DomainDbCredentials` не был подключён
  никуда, и перебор по роутам его бы не увидел. Гард, который не поймал бы
  дефект, ради которого написан, — плохой гард.

Оба перебора находят модули динамически, не по захардкоженному списку: пакет
`app/<новое>/schemas.py` иначе выпадал бы из охвата МОЛЧА, а мета-тест охвата
сторожил бы только переименование уже известного.

Дешёвый и статический: ни БД, ни HTTP, только импорт и разбор аннотаций.
Прогон — доли секунды, в отличие от полутораминутного
`test_secret_write_path.py`.
"""

import datetime
import decimal
import importlib
import pathlib
import uuid
from typing import Any, Optional, get_args

import pytest
from fastapi.routing import APIRoute
from pydantic import BaseModel, SecretStr

import app as app_package
from app.main import SECRET_NAME_MARKERS, app

# Модули, чьи схемы под гард не попадают.
#
# `app/auth/schemas.py` — материал протокола аутентификации: `auth_key_b64`,
# recovery-ключи, TOTP-`secret`, токен подтверждения почты. По устройству
# ZK-схемы он едет по проводу в открытом виде — это не секрет пользователя, а
# доказательство владения им, и хранится он на сервере намеренно. Занеси
# модуль в перебор — и файл превратится в список исключений на десяток строк,
# то есть в ничто.
#
# Список явный, а не «модуля просто нет во include»: граница, заданная
# умолчанием, не переживает рефакторинг перебора и исчезает молча.
EXCLUDED_MODULES = frozenset({"app.auth.schemas"})

# Поля, чьё ИМЯ попадает в `SECRET_NAME_MARKERS`, но чьё ЗНАЧЕНИЕ секретом не
# является. Ключ — `Модель.поле`, а не голое имя: глобальное по имени
# исключение обезоруживало бы проверку для этого имени сразу во всех схемах, и
# давление на рост списка было бы встроено в конструкцию. Каждая строка здесь —
# разрешение держать текст в поле с секретоподобным именем, и добавление сюда
# обязано быть видимым в диффе актом.
ALLOWED_TEXT_FIELDS = frozenset(
    {
        # Маркер сработал на `fastpanel_url` — он в `SECRET_NAME_MARKERS` не за
        # имя, а за содержимое: валидатор отвергает userinfo
        # (`admin:pass@ip`), то есть пароль панели внутри URL (долг №10). Само
        # поле — адрес панели.
        "ServerCreate.fastpanel_url",
        "ServerUpdate.fastpanel_url",
        "ServerResponse.fastpanel_url",
        "FastpanelStatusResponse.fastpanel_url",
        # Это и есть шифротекст блоба: единственное поле во всём API, которому
        # секрет проходить положено — потому что сервер не может его прочитать.
        "BlobUpsert.ciphertext_b64",
        "BlobResponse.ciphertext_b64",
        # Токен, уже замаскированный сервером (`****abcd`) для списка в UI.
        "CloudflareAccountResponse.api_token_masked",
    }
)

# Суффикс непрозрачной ссылки. `ssh_password_blob_id` содержит `password`, но
# несёт UUID блоба, а не пароль; десктопный `audit_redact.rs` выносит этот же
# суффикс в исключения тем же рассуждением. Правило по суффиксу, а не по типу:
# объявленный строкой UUID остаётся ссылкой (`sync/schemas.py` уже возит
# `blob_ids: list[str]`).
BLOB_REF_SUFFIX = "_blob_id"

# Типы, в которые текст физически не влезает. Правило намеренно ИНВЕРСНОЕ:
# подозрительно всё, кроме перечисленного здесь, — а не «подозрительны `str` и
# `bytes`». Список разрешённых типов конечен и известен, список способов
# провезти строку — нет: `SecretStr` (самый правдоподобный способ воскресить
# поле «безопасно выглядящим» — по проводу-то едет тот же плейнтекст), `Any`,
# `object`, `dict`, `Literal`, любой пользовательский тип. Перечисляя опасное,
# гард обязан угадать все; перечисляя безопасное — ошибается в сторону лишнего
# срабатывания, а его цена одна строка в `ALLOWED_TEXT_FIELDS` против
# пропущенного плейнтекста.
NON_TEXT_TYPES = (
    int,
    float,
    bool,
    complex,
    uuid.UUID,
    datetime.datetime,
    datetime.date,
    datetime.time,
    datetime.timedelta,
    decimal.Decimal,
    type(None),
)


def _carries_text(annotation: object) -> bool:
    """Может ли в аннотацию физически лечь текст. При сомнении — да."""
    args = [a for a in get_args(annotation) if a is not type(None)]
    if args:
        # `Optional[X]`, `Union`, `list[X]`, `dict[K, V]`: подозрителен, если
        # подозрителен хоть один аргумент. Рекурсия нужна ради `Optional[str]`
        # — именно так были объявлены удалённые `ftp_password`/`db_password`.
        return any(_carries_text(a) for a in args)
    return not any(annotation is safe for safe in NON_TEXT_TYPES)


def plaintext_secret_fields(model: type[BaseModel]) -> list[str]:
    """Поля модели, похожие на плейнтекст-секрет, — как есть, без вердикта.

    Отдельной функцией, а не инлайном в тесте, чтобы контроли ниже проверяли
    ровно тот код, который ходит по настоящим схемам.
    """
    found = []
    for name, field in model.model_fields.items():
        lowered = name.lower()
        if lowered.endswith(BLOB_REF_SUFFIX):
            continue
        if f"{model.__name__}.{name}" in ALLOWED_TEXT_FIELDS:
            continue
        if not any(marker in lowered for marker in SECRET_NAME_MARKERS):
            continue
        if _carries_text(field.annotation):
            found.append(name)
    return found


def _schema_module_names() -> list[str]:
    """Модули схем — поиском по дереву, а не списком в константе.

    Ищутся файлы `schemas.py` и всё, что лежит в каталоге `schemas/`. Список в
    константе устарел бы в день появления нового пакета, и устарел бы молча:
    непросмотренный модуль выглядит ровно как просмотренный и чистый.
    """
    root = pathlib.Path(app_package.__file__).parent
    names = []
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts or path.name == "__init__.py":
            continue
        if path.name != "schemas.py" and "schemas" not in relative.parts[:-1]:
            continue
        names.append("app." + ".".join(relative.with_suffix("").parts))
    return names


def _collect_models(annotation: object, into: set) -> None:
    """Достать из аннотации все pydantic-модели, включая вложенные."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        if annotation in into:
            return
        into.add(annotation)
        for field in annotation.model_fields.values():
            _collect_models(field.annotation, into)
        return
    for arg in get_args(annotation):
        _collect_models(arg, into)


def models_reachable_from_routes() -> set:
    """Схемы, подключённые к приложению, — тела запросов и модели ответов.

    Отсюда видны модели, объявленные прямо в модуле роута (`routes/settings.py`
    объявляет четыре) и синтезированные FastAPI тела форм: их не найдёт никакой
    перебор по файлам `schemas.py`.
    """
    models: set = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        _collect_models(route.response_model, models)
        if route.body_field is not None:
            _collect_models(route.body_field.type_, models)
    return models


def models_declared_in_schema_modules() -> set:
    """Схемы, объявленные в модулях схем, — подключённые и ещё нет.

    Фильтр по `__module__` отсекает импортированные в модуль чужие модели:
    иначе модель из исключённого модуля попадала бы под гард через чужой
    импорт.
    """
    models: set = set()
    for module_name in _schema_module_names():
        module = importlib.import_module(module_name)
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and issubclass(obj, BaseModel)
                and obj is not BaseModel
                and obj.__module__ == module_name
            ):
                models.add(obj)
    return models


def all_guarded_models() -> list[type[BaseModel]]:
    union = models_reachable_from_routes() | models_declared_in_schema_modules()
    return sorted(
        (m for m in union if m.__module__ not in EXCLUDED_MODULES),
        key=lambda m: (m.__module__, m.__name__),
    )


def test_both_scans_reach_what_only_they_can_see():
    """Оба перебора живы — иначе главный тест тихо сужается.

    Самый вероятный способ незаметно сломать этот файл — не «завести плохое
    поле», а уронить один из переборов: главный тест останется зелёным, просто
    проверять станет меньше. Поэтому здесь названы схемы, которые видит ТОЛЬКО
    свой перебор, — падение сразу говорит, какой именно сломан.
    """
    from_routes = {m.__name__ for m in models_reachable_from_routes()}
    from_modules = {m.__name__ for m in models_declared_in_schema_modules()}

    # Объявлена прямо в роуте — перебор по модулям схем её не найдёт.
    assert "ConfigItem" in from_routes, "перебор по роутам сломан"
    assert "ConfigItem" not in from_modules

    # Объявлена в модуле схем, но к роутам не подключена — ровно класс
    # сегодняшнего долга, и виден он только модульным перебором.
    assert "DomainFtpCredentials" not in from_modules, "мёртвая схема вернулась"
    unwired = from_modules - from_routes
    assert unwired, "перебор по модулям больше не даёт ничего сверх роутов"

    # И общий охват: по одной схеме на каждую сущность с секретами.
    names = from_routes | from_modules
    for expected in (
        "ServerCreate",
        "ServerUpdate",
        "DomainUpdate",
        "CloudflareAccountCreate",
        "RegistrarAccountCreate",
        "BlobUpsert",
    ):
        assert expected in names, f"перебор схем не видит {expected} — охват сломан"


def test_excluded_modules_are_actually_excluded():
    """Граница по `app/auth/schemas.py` держится — и держится не случайно.

    Перебор по роутам до auth-схем ДОХОДИТ (они подключены к эндпоинтам), так
    что исключение здесь работает, а не совпадает с недостижимостью.
    """
    reachable = {m.__module__ for m in models_reachable_from_routes()}
    assert "app.auth.schemas" in reachable, (
        "auth-схемы стали недостижимы — исключение больше ничего не значит"
    )
    assert all(m.__module__ not in EXCLUDED_MODULES for m in all_guarded_models())


@pytest.mark.parametrize(
    "model", all_guarded_models(), ids=lambda m: f"{m.__module__.split('.')[-1]}.{m.__name__}"
)
def test_schema_declares_no_plaintext_secret_field(model: type[BaseModel]):
    """Схема не объявляет поля, в которое влезет плейнтекст-секрет.

    По одному случаю на схему, а не один тест на все: имя упавшей схемы должно
    быть видно в выводе pytest без чтения ассерта.
    """
    offenders = plaintext_secret_fields(model)
    assert offenders == [], (
        f"{model.__module__}.{model.__name__} объявляет плейнтекст-поля под секрет: "
        f"{offenders}. Секрет шифруется на клиенте и хранится блобом — в схеме "
        f"должна быть ссылка `*_blob_id`, а не значение."
    )


# Способы объявить поле, в которое всё равно влезает плейнтекст. `str` — как
# были объявлены удалённые схемы; остальные три обходили прежнюю версию гарда,
# которая перечисляла опасные типы вместо безопасных.
RESURRECTION_SHAPES = [
    pytest.param(Optional[str], id="str-как-в-удалённой-схеме"),
    # По проводу едет тот же плейнтекст: `SecretStr` прячет значение в `repr` и
    # логах, но не в теле запроса и не в БД. Самый правдоподобный способ
    # воскресить поле, выглядя при этом аккуратным.
    pytest.param(SecretStr, id="SecretStr"),
    pytest.param(Any, id="Any"),
    pytest.param(object, id="object"),
]


@pytest.mark.parametrize("annotation", RESURRECTION_SHAPES)
def test_detector_catches_a_resurrected_plaintext_field(annotation):
    """Позитивный контроль: детектор ловит воскрешение в любом обличье.

    Без него весь файл нефальсифицируем — он зелен и на пустом переборе, и на
    детекторе, который всегда возвращает `[]`. Модель ниже воспроизводит
    удалённую `DomainDbCredentials` из `schemas/domain.py`.
    """
    resurrected = type(
        "ResurrectedDomainDbCredentials",
        (BaseModel,),
        {
            "__annotations__": {
                "domain_id": int,
                "db_name": Optional[str],
                "db_user": Optional[str],
                "db_password": annotation,
            }
        },
    )

    assert plaintext_secret_fields(resurrected) == ["db_password"]


@pytest.mark.parametrize(
    "blob_id_type",
    [
        # Как объявлены ссылки в схемах сущностей сегодня. Тип и так не
        # текстовый, правило `BLOB_REF_SUFFIX` здесь не при чём.
        pytest.param(Optional[uuid.UUID], id="ссылка-UUID"),
        # А ради этого случая правило и существует: ссылку вполне могут
        # объявить строкой — `sync/schemas.py` уже возит `blob_ids: list[str]`.
        # UUID строкой остаётся непрозрачной ссылкой, а не паролем.
        pytest.param(Optional[str], id="ссылка-строкой"),
    ],
)
def test_detector_leaves_the_zero_knowledge_shape_alone(blob_id_type):
    """Негативный контроль: правильная форма детектор не трогает.

    Иначе «детектор», ругающийся на всё подряд, тоже прошёл бы позитивный
    контроль — и первым же ложным срабатыванием научил бы команду его
    выключать.
    """
    proper = type(
        "ProperDomainDbRef",
        (BaseModel,),
        {
            "__annotations__": {
                "domain_id": int,
                "db_name": Optional[str],
                "db_user": Optional[str],
                "db_password_blob_id": blob_id_type,
            }
        },
    )

    assert plaintext_secret_fields(proper) == []
