"""Прогон мониторинга серверов: опрос веером, запись по одному, TaskLog.

Предмет проверки здесь — именно склейка, а не решение о переходе: таблица
состояний уже проверена юнитами в `test_server_monitor.py`. Тут важно другое —
что выбраны те строки, что результат каждого опроса доехал до своей строки, что
`sync_version` поднялся (иначе десктоп о падении не узнает никогда) и что один
сбойный сервер не уносит прогон остальных.

Реальный TCP не открывается: `probe` подменяется целиком. Заглушка знает
только хосты, заведённые самим тестом, а на любой незнакомый **бросает**. Это
не каприз: тестовая БД общая с dev-окружением, в ней лежат чужие серверы, и
прогон задачи опрашивает их наравне с нашими. Исключение из опроса — ровно тот
исход, при котором чужая строка не будет ни прочитана, ни изменена (задача
такой результат пропускает), поэтому чужие данные остаются нетронутыми, а
`checked`/`down`/`up` считаются только по нашим серверам и не зависят от того,
что ещё лежит в базе.

Побочная выгода: если запись перестанет пропускать сбойный опрос и начнёт,
например, считать исключение падением сервера, чужие строки поедут в `checked`
и тесты покраснеют.

Плата за это — `failed`: чужие серверы всегда добавляют в него своё, поэтому по
БД он сверяется только через `>=`, а точные значения и статус строки журнала
проверяются юнитом на `_task_log`.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from celery.schedules import crontab
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, text

from app.auth.models import SyncState, User
from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.notification import Notification
from app.models.server import Server
from app.models.task_log import TaskLog
from app.tasks import server_monitor_task


class _ForeignServer(Exception):
    """Заглушку спросили про сервер, которого этот тест не заводил."""


class _Probe:
    """Опрос-заглушка: исход задаётся по хосту.

    Значение `(ok, error)` — готовый исход, исключение — падение самой
    корутины опроса. Незнакомый хост тоже даёт исключение (см. шапку файла).
    """

    def __init__(self, outcomes: dict[str, object]) -> None:
        self._outcomes = outcomes
        self.asked: list[tuple[str, int]] = []

    async def __call__(self, host: str, port: int):
        self.asked.append((host, port))
        outcome = self._outcomes.get(host)
        if outcome is None:
            raise _ForeignServer(host)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    @property
    def asked_hosts(self) -> list[str]:
        return [host for host, _port in self.asked]


def _host() -> str:
    """Уникальный хост для одного теста.

    Не IP: чужие строки в общей БД содержат настоящие адреса, и совпадение
    сломало бы адресацию исходов в заглушке.
    """
    return f"{uuid.uuid4().hex[:12]}.probe.invalid"


class _World:
    """Данные теста в общей БД: свой пользователь и чтение результатов прогона.

    Всё читается свежими сессиями и прямо из таблиц — состояние ORM-объектов,
    оставшихся в памяти после задачи, ничего не доказывает о том, что доехало
    до БД.
    """

    def __init__(self, user_id: uuid.UUID, log_watermark: int) -> None:
        self.user_id = user_id
        self.log_watermark = log_watermark
        self.ownerless_server_ids: list[int] = []

    async def server(self, host: str, *, owner: bool = True, **fields) -> int:
        async with AsyncSessionLocal() as session:
            server = Server(
                user_id=self.user_id if owner else None,
                name=f"srv-{host.split('.')[0]}",
                ip_address=host,
                ssh_port=22,
                **fields,
            )
            session.add(server)
            await session.commit()
            if not owner:
                self.ownerless_server_ids.append(server.id)
            return server.id

    async def reload(self, server_id: int) -> Server:
        async with AsyncSessionLocal() as session:
            return await session.get(Server, server_id)

    async def logs(self) -> list[TaskLog]:
        """`task_logs` мониторинга, написанные после старта теста."""
        async with AsyncSessionLocal() as session:
            return list(
                (
                    await session.execute(
                        select(TaskLog)
                        .where(
                            TaskLog.task_type == "server_monitor",
                            TaskLog.id > self.log_watermark,
                        )
                        .order_by(TaskLog.id)
                    )
                ).scalars().all()
            )

    async def notifications(self) -> list[Notification]:
        async with AsyncSessionLocal() as session:
            return list(
                (
                    await session.execute(
                        select(Notification)
                        .where(Notification.user_id == self.user_id)
                        .order_by(Notification.id)
                    )
                ).scalars().all()
            )

    async def sync_version(self) -> int:
        async with AsyncSessionLocal() as session:
            state = await session.get(SyncState, self.user_id)
            return state.current_version if state else 0


@pytest.fixture
async def world():
    """Пользователь теста и уборка за прогоном.

    Пользователь уносит за собой серверы и уведомления по FK CASCADE. Не
    уносит двух вещей: серверов без владельца (FK там нет) и `task_logs`
    задачи (они пишутся с `user_id = NULL`), поэтому и то и другое убирается
    отдельно.
    """
    async with AsyncSessionLocal() as session:
        user = User(
            email=f"srvmon-{uuid.uuid4().hex[:8]}@example.com",
            salt=b"\x00" * 16,
            auth_key_hash=b"\x01" * 32,
        )
        session.add(user)
        log_watermark = (
            await session.execute(select(func.coalesce(func.max(TaskLog.id), 0)))
        ).scalar_one()
        await session.commit()
        state = _World(user.id, log_watermark)

    yield state

    async with AsyncSessionLocal() as session:
        await session.execute(sa_delete(User).where(User.id == state.user_id))
        if state.ownerless_server_ids:
            await session.execute(
                sa_delete(Server).where(Server.id.in_(state.ownerless_server_ids))
            )
        await session.execute(
            sa_delete(TaskLog).where(
                TaskLog.task_type == "server_monitor", TaskLog.id > state.log_watermark
            )
        )
        await session.commit()


# --- фаза опроса -------------------------------------------------------------


def test_probe_concurrency_is_the_one_the_spec_asks_for():
    """Ширина веера — 20.

    Проверяется явно, потому что в остальных тестах она подменена малым
    числом. Худший случай одной проверки — 12 секунд (таймаут + пауза +
    таймаут), и в лимит задачи (55 минут до мягкого стопа) сотня молчащих
    серверов укладывается только за счёт этой ширины.
    """
    assert server_monitor_task.PROBE_CONCURRENCY == 20


async def test_probe_phase_is_parallel_but_bounded_by_the_semaphore():
    """Опрос идёт веером и ровно в `concurrency` корутин, не больше.

    Пик замеряется прямо внутри заглушки. Ассерт двусторонний намеренно:
    `<= limit` в одиночку зеленеет и на честной параллельности, и на
    последовательном обходе (пик 1), то есть на реализации, где семафор
    поставлен для вида. Равенство пика лимиту доказывает, что корутины
    действительно живут одновременно.
    """
    limit = 4
    targets = [(i, f"h{i}.probe.invalid", 22) for i in range(12)]
    inflight = 0
    peak = 0

    async def _slow(host: str, port: int):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        try:
            await asyncio.sleep(0.02)
            return True, None
        finally:
            inflight -= 1

    results = await server_monitor_task._probe_all(targets, probe=_slow, concurrency=limit)

    assert len(results) == len(targets)
    assert peak == limit, f"пик одновременных опросов {peak}, ожидался {limit}"


async def test_probe_results_are_keyed_by_server_not_by_arrival_order():
    """Исход достаётся тому серверу, которого опрашивали.

    Опрос параллельный, и порядок завершения корутин не совпадает с порядком
    серверов: здесь первый по списку отвечает последним. Если результаты
    раздавать по порядку прибытия, живой сервер получит чужую ошибку и уедет
    в «упал» — самый дорогой из возможных сбоев этой фичи.
    """
    targets = [(1, "slow.probe.invalid", 22), (2, "fast.probe.invalid", 22)]

    async def _by_host(host: str, port: int):
        if host == "slow.probe.invalid":
            await asyncio.sleep(0.05)
            return False, "slow is down"
        return True, None

    results = await server_monitor_task._probe_all(targets, probe=_by_host, concurrency=2)

    assert results[1] == (False, "slow is down")
    assert results[2] == (True, None)


async def test_a_crashing_probe_does_not_take_down_the_others():
    """Упавшая корутина опроса возвращается как исключение, а не как обвал.

    `probe` по контракту не бросает, но контракт держится на перехватах внутри
    неё. Один недосмотр там — и `gather` унёс бы весь прогон, то есть
    мониторинг всех серверов пользователя, из-за одной кривой строки.
    """
    targets = [(1, "boom.probe.invalid", 22), (2, "ok.probe.invalid", 22)]

    async def _explodes(host: str, port: int):
        if host == "boom.probe.invalid":
            raise RuntimeError("резолвер придумал новый способ упасть")
        return True, None

    results = await server_monitor_task._probe_all(targets, probe=_explodes, concurrency=2)

    assert isinstance(results[1], RuntimeError)
    assert results[2] == (True, None)


# --- прогон целиком ----------------------------------------------------------


async def test_run_applies_every_result_and_logs_the_statistics(world):
    """Три сервера с разной судьбой: поля, уведомления и строка TaskLog.

    Один живой (ничего не меняется, кроме отметки времени), один добирает
    второй промах подряд и падает, один отвечает после подтверждённого падения
    и поднимается. Статистика в `TaskLog` — единственное, что человек увидит о
    прогоне, поэтому сверяется по числам, а не по факту наличия строки.
    """
    alive, falling, recovering = _host(), _host(), _host()
    alive_id = await world.server(alive, last_check_ok=True, consecutive_failures=0)
    falling_id = await world.server(
        falling,
        last_check_ok=True,
        consecutive_failures=1,
        last_check_at=datetime.now(timezone.utc) - timedelta(hours=6),
    )
    recovering_id = await world.server(
        recovering, last_check_ok=False, consecutive_failures=4, last_check_error="timeout after 5s"
    )
    probe = _Probe(
        {
            alive: (True, None),
            falling: (False, "connection refused"),
            recovering: (True, None),
        }
    )

    stats = await server_monitor_task._monitor_servers(probe=probe)

    assert stats["checked"] == 3
    assert stats["down"] == 1
    assert stats["up"] == 1

    still_alive = await world.reload(alive_id)
    assert still_alive.last_check_ok is True
    assert still_alive.last_check_at is not None, "живой сервер не получил отметку проверки"
    assert still_alive.consecutive_failures == 0

    fallen = await world.reload(falling_id)
    assert fallen.last_check_ok is False
    assert fallen.consecutive_failures == 2
    assert fallen.last_check_error == "connection refused"

    back_up = await world.reload(recovering_id)
    assert back_up.last_check_ok is True
    assert back_up.consecutive_failures == 0
    assert back_up.last_check_error is None

    types = sorted(n.type for n in await world.notifications())
    assert types == ["server_down", "server_up"], types

    logs = await world.logs()
    assert len(logs) == 1, f"прогон написал {len(logs)} записей вместо одной"
    log = logs[0]
    assert log.entity_type == "system"
    assert "checked 3" in log.log_text
    assert "1 down" in log.log_text and "1 up" in log.log_text


async def test_check_results_reach_the_desktop_via_sync_version(world):
    """У проверенных серверов поднялся `sync_version`.

    Без бампа инкрементальный `/sync/changes?since=` не отдаст строку вовсе:
    выборка идёт по `sync_version > since`. Десктоп продолжит показывать
    «сервер жив» из локального SQLCipher-кэша до полной пересинхронизации,
    то есть, возможно, никогда — а результат мониторинга нужен ровно там.
    """
    first, second = _host(), _host()
    first_id = await world.server(first, last_check_ok=True)
    second_id = await world.server(second, last_check_ok=True)
    version_before = await world.sync_version()

    await server_monitor_task._monitor_servers(
        probe=_Probe({first: (True, None), second: (True, None)})
    )

    versions = [
        (await world.reload(first_id)).sync_version,
        (await world.reload(second_id)).sync_version,
    ]
    assert all(v > version_before for v in versions), f"версия не поднялась: {versions}"
    assert len(set(versions)) == 2, "оба сервера получили одну и ту же версию"
    assert await world.sync_version() == max(versions)


async def test_a_broken_probe_does_not_stop_the_rest_of_the_run(world):
    """Сбой опроса одного сервера не мешает записать результат остальных.

    Главный сценарий отказа этой фичи: она нужна как раз тогда, когда что-то
    сломалось, и обвал всего прогона из-за одной строки означал бы тишину
    вместо оповещения по всем остальным машинам.
    """
    broken, healthy = _host(), _host()
    broken_id = await world.server(broken, last_check_ok=True)
    healthy_id = await world.server(healthy, last_check_ok=True)
    probe = _Probe({broken: RuntimeError("boom"), healthy: (True, None)})

    stats = await server_monitor_task._monitor_servers(probe=probe)

    assert stats["checked"] == 1
    assert stats["failed"] >= 1
    untouched = await world.reload(broken_id)
    assert untouched.last_check_at is None, "сбойный опрос всё-таки записали как проверку"
    assert untouched.sync_version == 0
    written = await world.reload(healthy_id)
    assert written.last_check_at is not None
    assert written.sync_version > 0

    log = (await world.logs())[0]
    assert log.status == "partial", "прогон со сбоями отчитался как полностью успешный"


async def test_a_write_failure_on_one_server_keeps_the_rest_of_the_run(world, monkeypatch):
    """Отказ БД на одном сервере не уносит ни соседей до него, ни после.

    Сценарий редкий, но именно он ловит две мины сразу. Первая: коммит один
    на весь цикл — тогда откат из-за сбойной строки утащил бы уже записанные
    результаты соседей. Вторая: отсутствие `rollback()` в обработчике — после
    ошибки Postgres отвергает в этой транзакции всё подряд («current
    transaction is aborted»), и один сбой превратился бы в отказ мониторинга
    для всех оставшихся серверов.

    Сбой изображается настоящей ошибкой БД (деление на ноль внутри
    транзакции), а не питоновским исключением: питоновское транзакцию не
    ломает, и вторую мину не показало бы.
    """
    first, poisoned, last = _host(), _host(), _host()
    first_id = await world.server(first, last_check_ok=True)
    poisoned_id = await world.server(poisoned, last_check_ok=True)
    last_id = await world.server(last, last_check_ok=True)
    real_touch = server_monitor_task.touch_entity_sync

    async def _touch(db, user_id, entity):
        if entity.id == poisoned_id:
            await db.execute(text("SELECT 1 / 0"))
        return await real_touch(db, user_id, entity)

    monkeypatch.setattr(server_monitor_task, "touch_entity_sync", _touch)

    stats = await server_monitor_task._monitor_servers(
        probe=_Probe({first: (True, None), poisoned: (True, None), last: (True, None)})
    )

    assert stats["checked"] == 2, "сбой на одном сервере унёс соседей"
    assert stats["failed"] >= 1
    for server_id in (first_id, last_id):
        survivor = await world.reload(server_id)
        assert survivor.last_check_at is not None, f"результат сервера {server_id} потерян"
        assert survivor.sync_version > 0
    broken = await world.reload(poisoned_id)
    assert broken.last_check_at is None
    assert broken.sync_version == 0, "недописанный сервер всё-таки поднял версию"


async def test_a_run_without_servers_logs_checked_zero(world):
    """Ни одного своего сервера: строка TaskLog есть, исключения нет.

    Пустой прогон — обычное состояние свежего аккаунта, и он не должен ни
    падать, ни оставлять расписание без следа в журнале.
    """
    stats = await server_monitor_task._monitor_servers(probe=_Probe({}))

    assert stats["checked"] == 0
    assert stats["down"] == 0 and stats["up"] == 0
    logs = await world.logs()
    assert len(logs) == 1
    assert "checked 0" in logs[0].log_text


async def test_servers_without_an_owner_are_never_probed(world):
    """Строка без `user_id` не попадает даже в опрос.

    Такие строки в БД есть (колонка nullable), но адресовать по ним нечего:
    уведомление некому, в чей `sync_version` бампить — неизвестно. Проверяем
    именно то, что её не спросили: строка, доехавшая до записи, обвалила бы
    `touch_entity_sync` на `user_id = None`.
    """
    orphan, owned = _host(), _host()
    orphan_id = await world.server(orphan, owner=False, last_check_ok=True)
    await world.server(owned, last_check_ok=True)
    probe = _Probe({orphan: (False, "should never be asked"), owned: (True, None)})

    stats = await server_monitor_task._monitor_servers(probe=probe)

    assert orphan not in probe.asked_hosts, "сервер без владельца всё-таки опросили"
    assert stats["checked"] == 1
    untouched = await world.reload(orphan_id)
    assert untouched.last_check_at is None
    assert untouched.consecutive_failures == 0


async def test_a_repeated_run_is_idempotent(world):
    """Второй прогон в том же состоянии не плодит уведомлений.

    Прогоны могут перекрыться (ручной запуск поверх расписания), и защита тут
    только одна — то, что неизменное состояние не считается переходом.
    """
    host = _host()
    await world.server(host, last_check_ok=False, consecutive_failures=3)

    first = await server_monitor_task._monitor_servers(probe=_Probe({host: (True, None)}))
    second = await server_monitor_task._monitor_servers(probe=_Probe({host: (True, None)}))

    assert (first["up"], second["up"]) == (1, 0)
    assert len(await world.notifications()) == 1, "повторный прогон прислал второе уведомление"


# --- строка журнала ----------------------------------------------------------


def test_a_clean_run_is_logged_as_success():
    """Прогон без сбоев: статус `success` и все три числа в тексте.

    Строка журнала проверяется отдельным юнитом, а не в прогоне по БД, по
    честной причине: тестовая БД общая, чужие серверы попадают в опрос и
    всегда дают ненулевой `failed` (см. шапку файла), так что «чистого»
    прогона там не собрать.
    """
    log = server_monitor_task._task_log({"checked": 7, "down": 2, "up": 1, "failed": 0})

    assert log.status == "success"
    assert log.task_type == "server_monitor"
    assert log.entity_type == "system"
    assert log.user_id is None
    assert log.log_text == "checked 7 servers: 2 down, 1 up"


def test_a_run_with_failures_is_not_logged_as_success():
    """Есть непроверенные серверы — статус и текст обязаны это показать.

    `probe` по контракту не бросает, поэтому ненулевой `failed` означает баг,
    а не фон. Спрятать его под `success` — значит не узнать о нём никогда.
    """
    log = server_monitor_task._task_log({"checked": 5, "down": 0, "up": 0, "failed": 2})

    assert log.status == "partial"
    assert "2 not checked" in log.log_text


# --- регистрация задачи ------------------------------------------------------


def test_task_is_registered_and_scheduled_every_six_hours():
    """Задача зарегистрирована в Celery и стоит в расписании раз в 6 часов.

    Без этого весь мониторинг — мёртвый код: некому запустить. Имя задачи
    сверяется с реестром Celery, а не с самой собой, — расписание, ссылающееся
    на несуществующее имя, беззвучно ничего не запускает.
    """
    entry = celery_app.conf.beat_schedule["check-server-reachability-6h"]

    assert entry["task"] in celery_app.tasks, f"в расписании имя-призрак: {entry['task']}"
    assert entry["task"] == server_monitor_task.check_server_reachability.name
    assert entry["schedule"] == crontab(minute=0, hour="*/6")
