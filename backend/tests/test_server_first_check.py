"""Первая проверка сервера — сразу после заведения, а не через шесть часов.

Расписание мониторинга бьёт по слотам 00/06/12/18 UTC. Сервер, заведённый в
06:05, до полудня стоял бы с `unchecked` и «Last check: never» — при том что
сама проверка занимает секунды. Продукт от этого выглядит сломанным ровно в
тот момент, когда человек впервые к нему присматривается.

Предмет файла — не сам мониторинг (он проверен в `test_server_monitor_task.py`),
а два свойства триггера, и оба отказывают тихо:

* **проверка сужена до владельца новой строки.** Задача по умолчанию берёт ВСЕ
  серверы ВСЕХ пользователей, и потерянное сужение в продакшене означало бы
  полный обход парка на каждое чужое добавление сервера. Здесь это ещё и
  единственное, что стоит между тестами и живыми серверами общей с dev базой;
* **постановка в очередь не входит в контракт создания.** С мёртвым Redis
  `POST /api/servers` обязан вернуть 201 и оставить сервер в БД: немедленная
  проверка — удобство, а не часть сделки. Отказ при этом обязан быть слышен в
  логах, иначе «мониторинг молчит» не отличить от «брокер лежит вторые сутки».

Ни один тест здесь не публикует ничего по-настоящему: `published_tasks` из
`conftest.py` перехватывает обе двери публикации на весь набор тестов, и
утверждения читают именно её записи.
"""

import asyncio
import base64
import io
import json
import logging
import uuid
from datetime import datetime, timezone

import pytest
from celery.app.task import Task
from httpx import ASGITransport, AsyncClient
from kombu.exceptions import OperationalError
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.server import Server
from app.services import server_service
from app.tasks.server_monitor_task import check_server_reachability

_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — серверы уедут за ними по FK CASCADE."""
    _REGISTERED_EMAILS.clear()
    yield
    emails = list(_REGISTERED_EMAILS)
    _REGISTERED_EMAILS.clear()
    if emails:
        asyncio.run(_purge_users(emails))


async def _purge_users(emails: list[str]) -> None:
    async with AsyncSessionLocal() as s:
        await s.execute(sa_delete(User).where(User.email.in_(emails)))
        await s.commit()


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_and_login(client: AsyncClient, prefix: str) -> uuid.UUID:
    """Завести и залогинить пользователя; вернуть его `id`.

    `id` нужен по-настоящему: именно он обязан оказаться в аргументах задачи, и
    сверять сужение не с чем иным.
    """
    email = f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": _b64(b"\x00" * 16),
            "auth_key_b64": _b64(b"\x01" * 32),
            "recovery_blob_b64": _b64(b"\x02" * 96),
            "recovery_auth_key_b64": _b64(b"\x03" * 32),
        },
    )
    assert r.status_code in (201, 409), r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
        user_id = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": _b64(b"\x01" * 32)},
    )
    assert r.status_code == 200, r.text
    return user_id


async def _stored_server_ids(user_id: uuid.UUID) -> list[int]:
    async with AsyncSessionLocal() as s:
        return list(
            (
                await s.execute(select(Server.id).where(Server.user_id == user_id))
            ).scalars().all()
        )


async def test_creating_a_server_queues_a_check_scoped_to_its_owner(published_tasks):
    """`POST /api/servers` ставит проверку — одну и только по своему владельцу.

    Три утверждения об одном событии, и каждое ловит свой отказ. Имя задачи:
    промах в нём — беззвучный no-op, а не ошибка. Сужение: без него задача
    обходит парк всех пользователей сразу. Тип аргумента: `user_ids` обязаны
    быть строками, потому что брокер настроен на JSON, а `uuid.UUID` в него не
    сериализуется — задача с таким аргументом не уехала бы в очередь вовсе, и
    проверить это дешевле всего попыткой сериализации.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        user_id = await _register_and_login(c, "firstcheck")
        # Отсечь всё, что могли бы поставить регистрация и логин: предмет
        # утверждений ниже — ровно один запрос, `POST /api/servers`.
        published_tasks.clear()

        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.71"},
        )
        assert r.status_code == 201, r.text

    assert len(published_tasks) == 1, f"поставлено задач: {published_tasks}"
    published = published_tasks[0]
    assert published.name == check_server_reachability.name
    assert published.kwargs == {"user_ids": [str(user_id)]}, (
        "проверка не сужена до владельца новой строки — задача обойдёт весь парк всех"
    )
    json.dumps(published.kwargs)  # брокер сериализует в JSON; UUID туда не пролезет


async def test_a_dead_broker_does_not_break_server_creation(published_tasks, monkeypatch, app_log):
    """Redis лежит — сервер всё равно создан, ответ 201, в логах предупреждение.

    Немедленная проверка — удобство поверх создания, а не его часть. Отдать
    здесь 500 значило бы уронить основную функцию продукта из-за необязательной:
    человек не смог бы завести сервер, пока не поднимут брокер.

    Молча проглотить отказ тоже нельзя. Симптом у пользователя один и тот же —
    «сервер добавлен, статуса нет», — и без строки в логе неотличимо, ждёт ли
    он ближайшего слота расписания или брокер лежит вторые сутки.
    """

    def _broker_is_down(self, args=None, kwargs=None, **options):
        raise OperationalError("Redis не отвечает")

    monkeypatch.setattr(Task, "apply_async", _broker_is_down)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        user_id = await _register_and_login(c, "firstcheck-nobroker")

        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.72"},
        )

    assert r.status_code == 201, r.text
    assert await _stored_server_ids(user_id), "сервер не доехал до БД из-за мёртвого брокера"
    assert published_tasks == [], "перехват публикации подменён — сценарий не воспроизвёлся"
    warnings = [
        rec
        for rec in app_log.records
        if rec.levelno == logging.WARNING and rec.name == server_service.__name__
    ]
    assert warnings, "провал постановки в очередь прошёл бесследно"
    assert str(user_id) in warnings[0].getMessage(), (
        "по записи в логе не понять, чью проверку не поставили"
    )


async def test_a_bulk_import_queues_one_check_for_the_whole_batch(published_tasks):
    """Пакетный импорт ставит одну проверку на пачку, а не по одной на строку.

    `create` зовётся в цикле, и задача на каждую строку означала бы N прогонов
    по одному и тому же парку из N серверов: N×N сокетов и N претендентов на
    `SELECT … FOR UPDATE` по одной строке `sync_state` этого пользователя.
    Прогон и так берёт весь парк владельца — второй такой же ничего не
    добавляет.
    """
    rows = "\n".join(
        f"srv-{i},203.0.113.8{i},root,secret,22" for i in range(3)
    )
    csv = f"name,ip,ssh_user,ssh_password,ssh_port\n{rows}\n".encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        user_id = await _register_and_login(c, "firstcheck-bulk")
        published_tasks.clear()

        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", io.BytesIO(csv), "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["created"] == 3, r.text

    assert len(published_tasks) == 1, (
        f"импорт трёх строк поставил {len(published_tasks)} прогонов вместо одного"
    )
    assert published_tasks[0].kwargs == {"user_ids": [str(user_id)]}


async def test_an_import_that_created_nothing_queues_nothing(published_tasks):
    """Ни одной созданной строки — и проверять нечего.

    Файл целиком из брака (нет имени сервера) — обычный исход первой попытки
    импорта. Прогон по всему парку владельца в ответ на «создано 0» был бы
    работой ни за чем, причём тем более обидной, что повторяют такой импорт
    обычно несколько раз подряд.
    """
    csv = b"name,ip,ssh_user,ssh_password,ssh_port\n,203.0.113.90,root,secret,22\n"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "firstcheck-empty")
        published_tasks.clear()

        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", io.BytesIO(csv), "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["created"] == 0, r.text

    assert published_tasks == [], "импорт, не создавший ничего, всё-таки заказал прогон"
