def pytest_configure(config) -> None:
    import os

    os.environ.setdefault("USE_MEMORY_RATE_LIMIT", "1")


from typing import NamedTuple

import pytest


@pytest.fixture(autouse=True)
def _disable_rate_limit_except_rate_tests(request: pytest.FixtureRequest) -> None:
    from app.main import app

    lim = app.state.limiter
    if "test_rate_limit" in request.node.nodeid:
        lim.enabled = True
        yield
        return
    lim.enabled = False
    yield
    lim.enabled = True


@pytest.fixture
def app_log(caplog):
    """Записи логгеров `app.*` — сам по себе `caplog` их не видит.

    `add_loguru_intercept_handler` (зовётся при импорте `app.main`, то есть в
    каждом тесте) вешает логгеру `app` собственный handler и снимает
    `propagate`. Handler `caplog` сидит на root, до которого ничего уже не
    доходит, — и любой тест про «в логах должно быть предупреждение» падал бы
    не потому, что предупреждения нет, а потому, что его некому услышать.
    Поэтому handler подключается к `app` напрямую и снимается в teardown.
    """
    import logging

    target = logging.getLogger("app")
    previous_level = target.level
    target.addHandler(caplog.handler)
    target.setLevel(logging.DEBUG)
    yield caplog
    target.removeHandler(caplog.handler)
    target.setLevel(previous_level)


class PublishedTask(NamedTuple):
    """Задача, которую тест попытался отправить в брокер."""

    name: str
    args: tuple
    kwargs: dict


class _NotPublishedResult:
    """Заглушка `AsyncResult`: у неё есть `id`, и больше ничего нет.

    `id` нужен по-настоящему — роут `/notifications/check-renewals` уносит его
    в audit log. Всё остальное (`get`, `state`) намеренно отсутствует: задача
    не поставлена, ждать её результата в тесте нечего, и падение на атрибуте
    честнее, чем правдоподобный ответ ни о чём.
    """

    id = "not-published-in-tests"


@pytest.fixture(autouse=True)
def published_tasks(monkeypatch) -> list[PublishedTask]:
    """Ни один тест не публикует задачу в брокер — конструкцией, а не уговором.

    Причина не в чистоте, а в уже случившемся: тестовая БД общая с
    dev-окружением, и прогон мониторинга без сужения по владельцу однажды
    записал трём настоящим машинам «упал» и разослал их владельцу уведомления
    (разбор — в шапке `test_server_monitor_task.py`). После того как заведение
    сервера начало ставить проверку само, эта мина перезарядилась: `POST
    /api/servers` дёргают около двух десятков тестов, и каждый из них при живом
    локальном Redis отправил бы воркеру настоящую работу по настоящей базе.

    Поэтому перехват стоит не у одной задачи, а у обеих дверей публикации —
    `Task.apply_async` (через неё же идёт и `delay`) и `Celery.send_task`, — и
    делает это autouse, то есть распространяется на весь набор тестов. Забыть
    его негде: чтобы отправить что-то в брокер, тесту пришлось бы обойти обе
    двери руками.

    Перехваченное не выбрасывается, а складывается в список: факт постановки
    задачи — это поведение, и тесты про немедленную проверку сервера проверяют
    именно его (имя задачи и сужение по владельцу). Тест, которому нужен
    сломанный брокер, доопределяет перехват своим `monkeypatch` поверх этого.
    """
    from celery import Celery
    from celery.app.task import Task

    published: list[PublishedTask] = []

    def _record_apply_async(self, args=None, kwargs=None, **options):
        published.append(PublishedTask(self.name, tuple(args or ()), dict(kwargs or {})))
        return _NotPublishedResult()

    def _record_send_task(self, name, args=None, kwargs=None, **options):
        published.append(PublishedTask(name, tuple(args or ()), dict(kwargs or {})))
        return _NotPublishedResult()

    monkeypatch.setattr(Task, "apply_async", _record_apply_async)
    monkeypatch.setattr(Celery, "send_task", _record_send_task)
    return published


# --- Общая заготовка тестов, работающих с живым API -------------------------
#
# `_register_and_login` + уборка за собой + заведение сервера/CF-аккаунта/
# регистратора дословно повторялись в каждом новом файле. Здесь они лежат
# один раз; файл подключает их строкой
# `pytestmark = pytest.mark.usefixtures("purge_test_users")`.
#
# Уборка обязательна: база тестов общая с dev-окружением, а `domains.domain_name`
# уникален глобально — брошенные строки мешают не только глазам.
#
# ВАЖНО про импорт: тащить эти помощники надо `from conftest import ...`, а не
# `from tests.conftest import ...`. У каталога нет `__init__.py`, поэтому pytest
# грузит этот файл как модуль `conftest`, а второе написание заводит ЕЩЁ ОДИН
# модуль `tests.conftest` — со своим, отдельным `_REGISTERED_EMAILS`. Реестр
# тогда наполняет одна копия, а фикстура ниже читает другую, пустую: уборка
# молча превращается в ничто, и тесты об этом, разумеется, не падают.

_REGISTERED_EMAILS: list[str] = []


def b64(b: bytes) -> str:
    import base64

    return base64.b64encode(b).decode()


@pytest.fixture
def purge_test_users():
    """Убрать пользователей, заведённых `register_and_login` в этом тесте.

    Серверы, домены и аккаунты уезжают за пользователем по FK CASCADE, поэтому
    отдельной уборки им не нужно. Живёт в teardown, а не в `finally` у каждого
    случая: упавший ассерт обрывает тест на середине.

    Не `autouse`: реестр наполняет только `register_and_login`, и молча
    включать уборку всему набору (где есть свои схемы уборки) — лишнее.
    """
    import asyncio

    _REGISTERED_EMAILS.clear()
    yield
    emails = list(_REGISTERED_EMAILS)
    _REGISTERED_EMAILS.clear()
    if emails:
        asyncio.run(_purge_users(emails))


async def _purge_users(emails: list[str]) -> None:
    from sqlalchemy import delete as sa_delete

    from app.auth.models import User
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as s:
        await s.execute(sa_delete(User).where(User.email.in_(emails)))
        await s.commit()


async def register_and_login(client, prefix: str, key: bytes = b"\x01" * 32) -> str:
    """Завести подтверждённого пользователя и войти им. Возвращает e-mail.

    Регистрация обязана дать ровно 201: e-mail содержит `uuid4`, поэтому 409
    означает не «уже есть», а поломку — и продолжать тест после него значило бы
    работать под чужим паролем и падать позже и невнятнее.
    """
    import uuid
    from datetime import datetime, timezone

    from sqlalchemy import update

    from app.auth.models import User
    from app.core.database import AsyncSessionLocal

    email = f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
        },
    )
    assert r.status_code == 201, r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    r = await client.post(
        "/api/auth/login/finish", json={"email": email, "auth_key_b64": b64(key)}
    )
    assert r.status_code == 200, r.text
    return email


def domain_name() -> str:
    import uuid

    return f"{uuid.uuid4().hex[:10]}.example.com"


async def create_server(client) -> int:
    import uuid

    r = await client.post(
        "/api/servers",
        json={
            "name": f"srv-{uuid.uuid4().hex[:6]}",
            "ip_address": f"203.0.113.{uuid.uuid4().int % 200 + 10}",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def create_cf_account(client) -> int:
    import uuid

    r = await client.post(
        "/api/cloudflare/accounts", json={"name": f"cf-{uuid.uuid4().hex[:6]}"}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def create_registrar(client, provider: str = "hostiq") -> int:
    import uuid

    r = await client.post(
        "/api/registrars/accounts",
        json={"provider": provider, "name": f"reg-{uuid.uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]
