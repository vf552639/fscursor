"""Ни одна схема запроса/ответа не объявляет поле под плейнтекст-секрет.

Инвариант продукта: плейнтекста секретов на сервере не существует. Секрет
шифруется на клиенте, лежит в `blob_storage` непрозрачными байтами, а сущность
хранит только ссылку — `*_blob_id`. Значит и в схемах не должно быть полей,
куда плейнтекст физически влезает.

Почему этого НЕ ловит `test_secret_write_path.py`. Тот файл сторожит другой
дефект: плейнтекст в поле, которого в схеме НЕТ. Его ловит `extra="forbid"` —
422 `extra_forbidden`. Но `forbid` по построению молчит про поля, которые схема
ОБЪЯВЛЯЕТ: объяви завтра `db_password: str`, и тот же запрос пройдёт с 201, а
все 33 теста останутся зелёными. Ровно этот путь и был открыт до сегодня —
`DomainDbCredentials`/`DomainFtpCredentials` с `*_password: Optional[str]`
лежали в `schemas/domain.py` живыми классами, ничем не подключёнными: готовая
форма под новый роут (долг №12 спринта уборки). Удаление их само по себе от
повторения не защищает — защищает этот файл.

Дешёвый и статический: ни БД, ни HTTP, только импорт модулей и разбор
аннотаций. Прогон — доли секунды, так что его не жалко гонять на каждой правке
схем, в отличие от полутораминутного `test_secret_write_path.py`.

Что вне охвата: `app/auth/schemas.py`. Там материал протокола аутентификации
(`auth_key_b64`, recovery-ключи, TOTP-`secret`, токен подтверждения почты) по
устройству ZK-схемы едет по проводу в открытом виде — это не секрет
пользователя, а доказательство владения им. Занеси этот модуль в перебор — и
файл превратится в список исключений на десяток строк, то есть в ничто.
Границей охвата является пакет `app/schemas/` (сущности: серверы, домены,
Cloudflare, регистраторы) плюс три модуля рядом, которые сегодня чисты и
поэтому достаются бесплатно.
"""

import importlib
import pkgutil
import uuid
from typing import Optional, get_args

import pytest
from pydantic import BaseModel

import app.schemas
from app.main import SECRET_NAME_MARKERS

# Модули со схемами, которые обязаны быть свободны от плейнтекст-секретов.
# `app.auth.schemas` исключён осознанно — см. шапку файла.
SCANNED_MODULES = sorted(
    [f"app.schemas.{m.name}" for m in pkgutil.iter_modules(app.schemas.__path__)]
    + ["app.audit.schemas", "app.blobs.schemas", "app.sync.schemas"]
)

# Поля, чьё ИМЯ попадает в `SECRET_NAME_MARKERS`, но чьё ЗНАЧЕНИЕ секретом не
# является. Список короткий намеренно: каждая строка здесь — разрешение держать
# в схеме строку с секретоподобным именем, и добавление сюда обязано быть
# видимым в диффе актом, а не побочным эффектом.
ALLOWED_TEXT_FIELDS = {
    # Маркер сработал на `fastpanel_url` — он в `SECRET_NAME_MARKERS` не за
    # имя, а за содержимое: валидатор отвергает userinfo (`admin:pass@ip`), то
    # есть пароль панели внутри URL (долг №10). Само поле — адрес панели.
    "fastpanel_url",
    # Это и есть шифротекст блоба: единственное поле во всём API, которому
    # секрет проходить положено — потому что сервер не может его прочитать.
    "ciphertext_b64",
    # Токен, уже замаскированный сервером (`****abcd`) для отрисовки в списке.
    "api_token_masked",
}

# Суффикс непрозрачной ссылки. `ssh_password_blob_id` содержит `password`, но
# несёт UUID блоба, а не пароль; десктопный `audit_redact.rs` выносит этот же
# суффикс в исключения тем же рассуждением. Проверка по суффиксу, а не по типу:
# объявленный строкой UUID остаётся ссылкой.
BLOB_REF_SUFFIX = "_blob_id"


def _carries_text(annotation: object) -> bool:
    """Может ли в аннотацию физически лечь строка/байты.

    Рекурсивно, потому что интересный случай — не голый `str`, а
    `Optional[str]`: именно так были объявлены удалённые `ftp_password` и
    `db_password`, и проверка «annotation is str» их бы не заметила.
    """
    if annotation is str or annotation is bytes:
        return True
    return any(_carries_text(arg) for arg in get_args(annotation))


def plaintext_secret_fields(model: type[BaseModel]) -> list[str]:
    """Поля модели, похожие на плейнтекст-секрет, — как есть, без вердикта.

    Отдельной функцией, а не инлайном в тесте, чтобы позитивный контроль ниже
    проверял ровно тот же код, который ходит по настоящим схемам.
    """
    found = []
    for name, field in model.model_fields.items():
        lowered = name.lower()
        if lowered.endswith(BLOB_REF_SUFFIX) or name in ALLOWED_TEXT_FIELDS:
            continue
        if not any(marker in lowered for marker in SECRET_NAME_MARKERS):
            continue
        if _carries_text(field.annotation):
            found.append(name)
    return found


def _discovered_models() -> list[type[BaseModel]]:
    """Все pydantic-модели, ОБЪЯВЛЕННЫЕ в просматриваемых модулях.

    Фильтр по `__module__` отсекает импортированные в модуль чужие модели:
    иначе одна и та же схема разъезжалась бы по нескольким именам, а модель из
    невходящего в охват модуля попадала бы в перебор через чужой импорт.
    """
    models = []
    for module_name in SCANNED_MODULES:
        module = importlib.import_module(module_name)
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and issubclass(obj, BaseModel)
                and obj is not BaseModel
                and obj.__module__ == module_name
            ):
                models.append(obj)
    return models


def test_scan_actually_reaches_the_schemas():
    """Перебор действительно что-то нашёл — иначе главный тест пуст и зелен.

    Самый вероятный способ незаметно сломать этот файл — не «завести плохое
    поле», а переименовать пакет/модуль так, что `_discovered_models()` вернёт
    пустой список: главный тест останется зелёным, ничего не проверяя. Поэтому
    здесь названы схемы, которые перебор обязан видеть, — по одной на каждую
    сущность с секретами.
    """
    names = {m.__name__ for m in _discovered_models()}
    for expected in (
        "ServerCreate",
        "ServerUpdate",
        "DomainUpdate",
        "CloudflareAccountCreate",
        "RegistrarAccountCreate",
        "BlobUpsert",
    ):
        assert expected in names, f"перебор схем не видит {expected} — охват сломан"


@pytest.mark.parametrize(
    "model", _discovered_models(), ids=lambda m: f"{m.__module__.split('.')[-1]}.{m.__name__}"
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


def test_detector_catches_a_resurrected_plaintext_schema():
    """Позитивный контроль: детектор ловит ровно то, что сегодня удалено.

    Без него весь файл нефальсифицируем — он зелен и на пустом переборе, и на
    детекторе, который всегда возвращает `[]`. Модель ниже — дословная копия
    удалённой `DomainDbCredentials` из `schemas/domain.py`.
    """

    class ResurrectedDomainDbCredentials(BaseModel):
        domain_id: int
        db_name: Optional[str] = None
        db_user: Optional[str] = None
        db_password: Optional[str] = None

    assert plaintext_secret_fields(ResurrectedDomainDbCredentials) == ["db_password"]


@pytest.mark.parametrize(
    "blob_id_type",
    [
        # Как объявлены ссылки в схемах сущностей сегодня. Тип и так не строка,
        # так что правило `BLOB_REF_SUFFIX` здесь не при чём — отсекает сам
        # разбор аннотации.
        pytest.param(Optional[uuid.UUID], id="ссылка-UUID"),
        # А вот ради этого случая правило и существует: ссылку вполне могут
        # объявить строкой — `sync/schemas.py` уже возит `blob_ids: list[str]`.
        # UUID строкой остаётся непрозрачной ссылкой, а не паролем, и ругаться
        # на него детектор не вправе.
        pytest.param(Optional[str], id="ссылка-строкой"),
    ],
)
def test_detector_leaves_the_zero_knowledge_shape_alone(blob_id_type):
    """Негативный контроль: правильная форма детектор не трогает.

    Иначе «детектор», ругающийся на всё подряд, тоже прошёл бы позитивный
    контроль — и первым же ложным срабатыванием научил бы команду его
    выключать.
    """
    ProperDomainDbRef = type(
        "ProperDomainDbRef",
        (BaseModel,),
        {
            "__annotations__": {
                "domain_id": int,
                "db_name": Optional[str],
                "db_user": Optional[str],
                "db_password_blob_id": blob_id_type,
            },
            "db_name": None,
            "db_user": None,
            "db_password_blob_id": None,
        },
    )

    assert plaintext_secret_fields(ProperDomainDbRef) == []
