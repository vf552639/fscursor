"""Прогон мониторинга серверов: опрос веером, запись по одному, TaskLog.

Предмет проверки здесь — именно склейка, а не решение о переходе: таблица
состояний уже проверена юнитами в `test_server_monitor.py`. Тут важно другое —
что выбраны те строки, что результат каждого опроса доехал до своей строки, что
`sync_version` поднялся (иначе десктоп о падении не узнает никогда) и что один
сбойный сервер не уносит прогон остальных.

Реальный TCP не открывается ни разу: `probe` подменяется целиком.

Прогон всегда сужен до пользователя теста — он идёт только через
`_World.run`. Задача по построению берёт ВСЕ серверы с владельцем, а тестовая
БД общая с dev-окружением, и цена ошибки здесь уже заплачена: прогон без
сужения записал трём настоящим машинам «упал» и разослал их владельцу
уведомления. Живые строки должны быть недостижимы конструкцией, а не
корректностью проверяемого кода, — фильтр по `user_id` ровно это и даёт.

Заглушка `probe` вдобавок **бросает** на любом хосте, которого тест не
заводил. Это второй рубеж: если фильтр однажды перестанет фильтровать, чужая
строка всё равно не будет ни прочитана, ни изменена — задача сбойный опрос
пропускает. Оба рубежа снимаются разом только одним способом — вызовом задачи
мимо `_World.run`, — и на этот случай стоит autouse-фикстура
`unscoped_run_is_a_test_failure`: она делает такой вызов падением теста.

Раз чужого в выборке нет, счётчики (`checked`/`down`/`up`/`undelivered`/
`failed`) сверяются точными равенствами и не зависят от того, что ещё лежит в
базе.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from celery import Celery
from celery.schedules import crontab
from kombu.exceptions import OperationalError
from sqlalchemy import delete as sa_delete
from sqlalchemy import update as sa_update
from sqlalchemy import func, select, text

from app.api.routes.tasks import TERMINAL_TASK_STATUSES
from app.auth.models import SyncState, User
from app.core import celery_app as celery_app_module
from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.notification import Notification
from app.models.server import Server
from app.models.task_log import TaskLog
from app.services import notification_service
from app.tasks import server_monitor_task


class _ForeignServer(Exception):
    """Заглушку спросили про сервер, которого этот тест не заводил."""


class _Probe:
    """Опрос-заглушка: исход задаётся по хосту.

    Значение `(ok, error)` — готовый исход, исключение — падение самой
    корутины опроса, корутинная функция — исход, который надо вычислить (так
    тест изображает медленный опрос или удаление строки прямо во время него).

    Незнакомый хост даёт исключение, и через эту заглушку в файле проходит
    КАЖДЫЙ опрос — обходных «просто верни True» нет намеренно. Иначе второй
    рубеж (см. шапку файла) держал бы не весь файл, а только те тесты, где о
    нём вспомнили.
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
        if callable(outcome):
            return await outcome()
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
        self.extra_user_ids: list[uuid.UUID] = []

    async def another_user(self) -> uuid.UUID:
        """Второй владелец в том же прогоне — и он тоже уберётся за собой.

        Нужен ровно для одного вопроса: журнал пишется по строке на владельца,
        и с одним пользователем «своя строка» неотличима от «одна общая».
        """
        async with AsyncSessionLocal() as session:
            user = User(
                email=f"srvmon-{uuid.uuid4().hex[:8]}@example.com",
                salt=b"\x00" * 16,
                auth_key_hash=b"\x01" * 32,
            )
            session.add(user)
            await session.commit()
            self.extra_user_ids.append(user.id)
            return user.id

    async def server(
        self, host: str, *, owner: bool = True, owner_id: uuid.UUID = None, **fields
    ) -> int:
        async with AsyncSessionLocal() as session:
            server = Server(
                user_id=(owner_id or self.user_id) if owner else None,
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

    async def run(self, probe, owners: list[uuid.UUID] = None) -> dict[str, int]:
        """Прогон, суженный до серверов этого теста.

        Единственная точка запуска в файле — намеренно. Задача по построению
        берёт ВСЕ серверы с владельцем, а тестовая БД общая с dev-окружением:
        один забытый на call-site фильтр — и прогон пишет «упал» живым
        машинам и рассылает их владельцам уведомления. Такое уже случилось,
        и лечится оно тем, что забыть фильтр негде.

        `owners` позволяет сузить прогон ЕЩЁ, до части своих же пользователей —
        это нужно тесту про само сужение. Расширить им область нельзя: список
        сверяется с теми, кого тест завёл, и посторонний владелец в нём —
        падение. Так вторая дверь остаётся дверью, а не дырой.

        Заглушка проверяется типом, а не на слово: сырая функция вида «просто
        верни True» отчиталась бы «жив» о любом сервере, до которого прогон
        дотянулся, — то есть сняла бы второй рубеж (см. шапку файла) заодно с
        первым.
        """
        assert isinstance(probe, _Probe), "в прогон уехала заглушка мимо _Probe"
        mine = [self.user_id, *self.extra_user_ids]
        scope = mine if owners is None else owners
        assert scope and set(scope) <= set(mine), (
            "прогон сужен до владельцев, которых этот тест не заводил"
        )
        return await server_monitor_task._monitor_servers(probe=probe, user_ids=scope)

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


@pytest.fixture(autouse=True)
def unscoped_run_is_a_test_failure(monkeypatch):
    """Запретить прогон без сужения по владельцу — на уровне кода, не уговоров.

    Оба рубежа изоляции (фильтр по `user_id` и заглушка `_Probe`) независимы
    относительно отказа «фильтр перестал фильтровать», но не относительно
    отказа «кто-то позвал задачу мимо `_World.run`»: такой вызов снимает сразу
    оба. Здесь этот вызов становится падением теста, а не записью в живую БД.

    Фикстура отдаёт настоящую `_load_targets` — она нужна тесту на саму
    выборку, единственному, кто зовёт её без сужения (и только на чтение).
    """
    real_load_targets = server_monitor_task._load_targets

    async def _guarded(session, user_ids=None):
        assert user_ids is not None, (
            "прогон без сужения по владельцу дотянулся бы до живых серверов общей БД"
        )
        return await real_load_targets(session, user_ids)

    monkeypatch.setattr(server_monitor_task, "_load_targets", _guarded)
    return real_load_targets


@pytest.fixture
async def world():
    """Пользователь теста и уборка за прогоном.

    Пользователь уносит за собой серверы, уведомления и строки журнала по FK
    CASCADE. Не уносит серверов без владельца (FK там нет), поэтому они
    убираются отдельно. Отдельная уборка `task_logs` оставлена намеренно: она
    подметёт за прогоном и в том случае, если журнал однажды снова начнут
    писать с `user_id = NULL`, — то есть тестовая БД не засорится незаметно.
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
        await session.execute(
            sa_delete(User).where(User.id.in_([state.user_id, *state.extra_user_ids]))
        )
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
    owner = uuid.uuid4()
    targets = [(i, f"h{i}.probe.invalid", 22, owner) for i in range(12)]
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
    owner = uuid.uuid4()
    targets = [(1, "slow.probe.invalid", 22, owner), (2, "fast.probe.invalid", 22, owner)]

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
    owner = uuid.uuid4()
    targets = [(1, "boom.probe.invalid", 22, owner), (2, "ok.probe.invalid", 22, owner)]

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

    Падений намеренно два, а восстановление одно: при симметричных числах
    перепутанные местами счётчики «упал»/«поднялся» дали бы ту же статистику,
    и подмена вердикта на противоположный прошла бы незамеченной.
    """
    alive, falling, also_falling, recovering = _host(), _host(), _host(), _host()
    six_hours_ago = datetime.now(timezone.utc) - timedelta(hours=6)
    alive_id = await world.server(alive, last_check_ok=True, consecutive_failures=0)
    falling_id = await world.server(
        falling,
        last_check_ok=True,
        consecutive_failures=1,
        last_check_at=six_hours_ago,
    )
    also_falling_id = await world.server(
        also_falling,
        last_check_ok=True,
        consecutive_failures=1,
        last_check_at=six_hours_ago,
    )
    recovering_id = await world.server(
        recovering, last_check_ok=False, consecutive_failures=4, last_check_error="timeout after 5s"
    )
    probe = _Probe(
        {
            alive: (True, None),
            falling: (False, "connection refused"),
            also_falling: (False, "timeout after 5s"),
            recovering: (True, None),
        }
    )

    stats = await world.run(probe=probe)

    assert stats["checked"] == 4
    assert stats["down"] == 2, "падения посчитаны не как падения"
    assert stats["up"] == 1, "восстановления посчитаны не как восстановления"
    assert stats["failed"] == 0

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

    also_fallen = await world.reload(also_falling_id)
    assert also_fallen.last_check_ok is False
    assert also_fallen.consecutive_failures == 2

    types = sorted(n.type for n in await world.notifications())
    assert types == ["server_down", "server_down", "server_up"], types

    logs = await world.logs()
    assert len(logs) == 1, f"прогон написал {len(logs)} записей вместо одной"
    log = logs[0]
    assert log.entity_type == "system"
    assert log.status == "success"
    assert log.log_text == "checked 4 servers: 2 down, 1 up"
    # Адресат — владелец серверов. Без него строка не доедет ни до страницы
    # Activity (`GET /tasks` фильтрует `user_id = :current_user`), ни до
    # десктопа (`/sync/changes` выбирает по владельцу): прогон отчитался бы
    # в пустоту, а весь UI под статус `partial` остался бы мёртвым кодом.
    assert log.user_id == world.user_id, "журнал прогона некому прочитать"


async def test_every_owner_gets_his_own_row_with_his_own_numbers(world):
    """Два владельца в одном прогоне — две строки журнала, у каждой свои числа.

    С одним пользователем «строка на владельца» неотличима от «одна общая», и
    подмена прошла бы незамеченной. Числа тоже нарочно разные: сумма по всему
    прогону («checked 3») выглядела бы правдоподобно в обеих строках, но она —
    ответ на вопрос, которого человек не задавал, и про чужие машины.

    Статус тоже свой: у второго владельца сервер сбойный, и его строка обязана
    быть `partial`, тогда как у первого в тот же прогон — `success`. Общая
    строка обязана была бы выбрать одно из двух и соврать одному из них.
    """
    other = await world.another_user()
    mine_a, mine_b, his = _host(), _host(), _host()
    await world.server(mine_a, last_check_ok=True)
    await world.server(mine_b, last_check_ok=True)
    await world.server(his, owner_id=other, last_check_ok=True)

    totals = await world.run(
        probe=_Probe({mine_a: (True, None), mine_b: (True, None), his: RuntimeError("boom")})
    )

    assert totals["checked"] == 2 and totals["failed"] == 1, "итог по прогону разошёлся"

    rows = {log.user_id: log for log in await world.logs()}
    assert set(rows) == {world.user_id, other}, f"адресаты строк: {list(rows)}"
    assert rows[world.user_id].log_text == "checked 2 servers: 0 down, 0 up"
    assert rows[world.user_id].status == "success"
    assert "checked 0 servers" in rows[other].log_text
    assert "1 not checked" in rows[other].log_text
    assert rows[other].status == "partial"
    # И причина сбоя — в строке того, у кого он случился, а не у соседа.
    assert "RuntimeError: boom" in rows[other].log_text
    assert "RuntimeError" not in rows[world.user_id].log_text


async def test_the_journal_row_reaches_the_desktop_too(world):
    """У строки журнала поднят `sync_version`.

    `task_logs` входит в `SCOPED_MODELS` синхронизации, а `/sync/changes?since=`
    выбирает по `sync_version > since`. Со стоящим на нуле полем строка
    добралась бы только до веба, а десктоп увидел бы её лишь при полной
    пересинхронизации — то есть, возможно, никогда.
    """
    host = _host()
    await world.server(host, last_check_ok=True)

    await world.run(probe=_Probe({host: (True, None)}))

    log = (await world.logs())[0]
    assert log.sync_version > 0, "строка журнала не попадёт в инкрементальную выдачу"
    assert await world.sync_version() >= log.sync_version


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

    await world.run(
        probe=_Probe({first: (True, None), second: (True, None)})
    )

    versions = [
        (await world.reload(first_id)).sync_version,
        (await world.reload(second_id)).sync_version,
    ]
    assert all(v > version_before for v in versions), f"версия не поднялась: {versions}"
    assert len(set(versions)) == 2, "оба сервера получили одну и ту же версию"
    # Ровно +1 сверх последнего сервера — строка журнала прогона: она тоже
    # синхронизируемая сущность и берёт следующую версию (см. `_write_task_logs`
    # и `test_the_journal_row_reaches_the_desktop_too`).
    assert await world.sync_version() == max(versions) + 1


async def test_a_broken_probe_does_not_stop_the_rest_of_the_run(world, monkeypatch):
    """Сбой опроса одного сервера не мешает записать результат остальных.

    Главный сценарий отказа этой фичи: она нужна как раз тогда, когда что-то
    сломалось, и обвал всего прогона из-за одной строки означал бы тишину
    вместо оповещения по всем остальным машинам.

    Заодно проверяется, что от сбоя остаётся след. `probe` по контракту не
    бросает — значит, исключение отсюда всегда баг, и схлопнуть его в одно
    число в журнале («200 not checked») значит остаться без единой зацепки:
    трейс нужен в stdout воркера, класс ошибки — в самом журнале.
    """
    logged: list[BaseException] = []
    monkeypatch.setattr(
        server_monitor_task.logger,
        "error",
        lambda *a, **kw: logged.append(kw.get("exc_info")),
    )
    broken, healthy = _host(), _host()
    broken_id = await world.server(broken, last_check_ok=True)
    healthy_id = await world.server(healthy, last_check_ok=True)
    probe = _Probe({broken: RuntimeError("boom"), healthy: (True, None)})

    stats = await world.run(probe=probe)

    assert [type(e) for e in logged] == [RuntimeError], "упавший опрос не оставил трейса"

    assert stats["checked"] == 1
    assert stats["failed"] == 1
    untouched = await world.reload(broken_id)
    assert untouched.last_check_at is None, "сбойный опрос всё-таки записали как проверку"
    assert untouched.sync_version == 0
    written = await world.reload(healthy_id)
    assert written.last_check_at is not None
    assert written.sync_version > 0

    log = (await world.logs())[0]
    assert log.status == "partial", "прогон со сбоями отчитался как полностью успешный"
    assert "RuntimeError: boom" in log.log_text, "в журнале нет ни намёка на причину"


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

    «До» и «после» здесь — не фигура речи: смысл теста держится на том, что
    серверы обрабатываются в порядке id (`sorted()` в `_apply_results`), а
    id идут по порядку вставки. Порядок поэтому и записывается, и сверяется —
    иначе, потеряв сортировку, тест остался бы зелёным, доказывая меньше, чем
    обещает его имя.
    """
    first, poisoned, last = _host(), _host(), _host()
    first_id = await world.server(first, last_check_ok=True)
    poisoned_id = await world.server(poisoned, last_check_ok=True)
    last_id = await world.server(last, last_check_ok=True)
    assert first_id < poisoned_id < last_id, "serial id перестали расти по порядку вставки"
    real_touch = server_monitor_task.touch_entity_sync
    handled: list[int] = []

    async def _touch(db, user_id, entity):
        # Только серверы: через ту же функцию проходит и строка журнала в конце
        # прогона, а она к порядку записи серверов отношения не имеет.
        if isinstance(entity, Server):
            handled.append(entity.id)
        if getattr(entity, "id", None) == poisoned_id:
            await db.execute(text("SELECT 1 / 0"))
        return await real_touch(db, user_id, entity)

    monkeypatch.setattr(server_monitor_task, "touch_entity_sync", _touch)
    traced: list[tuple] = []
    monkeypatch.setattr(
        server_monitor_task.logger, "exception", lambda *a, **kw: traced.append(a)
    )

    stats = await world.run(
        probe=_Probe({first: (True, None), poisoned: (True, None), last: (True, None)})
    )

    assert traced, "отказ записи не оставил трейса в логе"

    assert handled == [first_id, poisoned_id, last_id], (
        "порядок обработки не по id — «сосед до» и «сосед после» больше не гарантированы"
    )
    assert stats["checked"] == 2, "сбой на одном сервере унёс соседей"
    assert stats["failed"] == 1
    for server_id in (first_id, last_id):
        survivor = await world.reload(server_id)
        assert survivor.last_check_at is not None, f"результат сервера {server_id} потерян"
        assert survivor.sync_version > 0
    broken = await world.reload(poisoned_id)
    assert broken.last_check_at is None
    assert broken.sync_version == 0, "недописанный сервер всё-таки поднял версию"


async def test_a_run_without_servers_writes_nobody_a_journal_row(world):
    """Ни одного своего сервера: прогон не падает и не пишет никому ничего.

    Пустой прогон — обычное состояние свежего аккаунта. Раньше он оставлял
    общую строку «checked 0», и она была безобидна ровно потому, что её никто
    не видел. Теперь строка адресная, и «checked 0 servers: 0 down, 0 up»
    приходило бы человеку без серверов четыре раза в сутки, вечно, вытесняя со
    страницы Activity всё осмысленное.
    """
    stats = await world.run(probe=_Probe({}))

    assert stats["checked"] == 0
    assert stats["down"] == 0 and stats["up"] == 0
    assert await world.logs() == [], "человеку без серверов написали отчёт ни о чём"


async def test_the_selection_takes_owned_servers_and_only_the_asked_owners(
    world, unscoped_run_is_a_test_failure
):
    """Что вообще попадает в опрос: с владельцем — да, без владельца — нет.

    Тест читающий и потому единственный, который зовёт продакшн-выборку без
    сужения по пользователю: `_load_targets` только `SELECT`-ит, дотянуться до
    чужих данных ей нечем. Сужать тут и нельзя — фильтр по `user_id` сам
    отсекает строки с `user_id IS NULL`, и продакшн-условие `isnot(None)`
    осталось бы непроверенным: в реальном прогоне фильтра нет, и защищает
    только оно. Строка без владельца, доехавшая до записи, обвалила бы
    `touch_entity_sync` на `user_id = None`.

    Вторым утверждением проверяется сам фильтр — тот, на котором держится
    безопасность всех остальных тестов файла.
    """
    load_targets = unscoped_run_is_a_test_failure  # настоящая, без предохранителя
    orphan_id = await world.server(_host(), owner=False)
    owned_id = await world.server(_host())

    async with AsyncSessionLocal() as session:
        everyones = await load_targets(session)
        mine = await load_targets(session, [world.user_id])

    assert owned_id in [t[0] for t in everyones]
    assert orphan_id not in [t[0] for t in everyones], "сервер без владельца попал в опрос"
    assert [t[0] for t in mine] == [owned_id], "фильтр по владельцу пропустил чужие строки"


async def test_a_scoped_run_leaves_the_other_owners_servers_alone(world):
    """Сужение по владельцу доходит до конца: чужой сервер не опрошен и не тронут.

    Так задачу зовёт заведение сервера — с одним владельцем в аргументе. Если
    сужение теряется где-нибудь по дороге (задача разобрала аргумент, но не
    донесла его до выборки), в продакшене каждое добавление сервера
    превращалось бы в опрос всего парка всех пользователей, а в общей с dev
    базе — ещё и в «упал» живым чужим машинам.

    Чужому хосту здесь намеренно задан нормальный исход `(True, None)`, а не
    оставлен без ответа: заглушка на незнакомом хосте бросает (второй рубеж из
    шапки файла), и тест зеленел бы от неё, а не от фильтра. Предметом должен
    быть фильтр, поэтому второй рубеж на этот один хост снят, и всё держится на
    первом.
    """
    outsider = await world.another_user()
    mine, his = _host(), _host()
    mine_id = await world.server(mine, last_check_ok=True)
    his_id = await world.server(his, owner_id=outsider, last_check_ok=True)
    probe = _Probe({mine: (True, None), his: (True, None)})

    stats = await world.run(probe=probe, owners=[world.user_id])

    assert probe.asked_hosts == [mine], f"опрошены лишние хосты: {probe.asked_hosts}"
    assert stats["checked"] == 1
    assert (await world.reload(mine_id)).last_check_at is not None
    untouched = await world.reload(his_id)
    assert untouched.last_check_at is None, "чужому серверу записали чужую проверку"
    assert untouched.sync_version == 0
    assert [log.user_id for log in await world.logs()] == [world.user_id], (
        "постороннему владельцу написали строку журнала о прогоне, которого он не просил"
    )


async def test_the_real_run_probes_in_parallel_too(world):
    """Веер включён в самом прогоне, а не только в `_probe_all`.

    Отдельно проверенный семафор и отдельно проверенная константа связку не
    доказывают: `_probe_all(..., concurrency=1)` внутри `_monitor_servers`
    прошёл бы оба этих теста. А это ровно тот последовательный опрос, от
    которого спека защищается словами «лимит задачи держится только на
    параллельности»: сотня молчащих серверов по 12 секунд — двадцать минут
    вместо одной.

    Пик замеряется по живому прогону: три сервера обязаны оказаться в воздухе
    одновременно.
    """
    hosts = [_host() for _ in range(3)]
    for host in hosts:
        await world.server(host, last_check_ok=True)
    inflight = 0
    peak = 0

    async def _slow():
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        try:
            await asyncio.sleep(0.02)
            return True, None
        finally:
            inflight -= 1

    stats = await world.run(probe=_Probe({host: _slow for host in hosts}))

    assert stats["checked"] == 3
    assert peak == 3, f"опрос шёл по {peak} за раз — веера в прогоне нет"


async def test_a_failing_notification_dispatch_cannot_strand_the_version(world, monkeypatch):
    """Упавшая доставка уведомления не оставляет строку без новой версии.

    Тот самый случай, ради которого `touch_entity_sync` стоит ДО
    `apply_check_result`. На переходе `create_notification` коммитит поля
    сервера, а сразу после коммита идёт `dispatch_notification` — чужой вебхук
    и Telegram. Пусть он бросит: управление уйдёт в обработчик прогона, и
    бамп, стоявший бы ПОСЛЕ, не случится уже никогда. В БД останется «упал»
    со старой версией, то есть строка, навсегда выпавшая из
    `/sync/changes?since=`: десктоп будет показывать живой сервер, пока
    кто-нибудь не тронет его руками.

    Перестановка двух строк местами в остальном незаметна — обычный ход дел
    её прощает, потому что бамп после доедет следующим коммитом.
    """
    host = _host()
    server_id = await world.server(host, last_check_ok=False, consecutive_failures=3)

    async def _webhook_is_down(db, payload, user_id):
        raise RuntimeError("вебхук пользователя не ответил")

    monkeypatch.setattr(notification_service, "dispatch_notification", _webhook_is_down)

    stats = await world.run(probe=_Probe({host: (True, None)}))

    recovered = await world.reload(server_id)
    assert recovered.last_check_ok is True, "поля не закоммичены — сценарий не воспроизвёлся"
    assert recovered.sync_version > 0, "поля уехали в БД, а версия осталась старой"

    # Проверка записана — значит, она проверена, что бы ни случилось с
    # доставкой письма. Записать её в «не проверено» значит соврать в журнале
    # про ту самую строку, ради которой мониторинг и заведён, — и соврать не
    # в случайный прогон, а с повышенной вероятностью в инцидентный: вебхук
    # пользователя нередко живёт на той же инфраструктуре, что и упавший
    # сервер, и падает вместе с ним.
    assert stats["checked"] == 1, "записанная проверка объявлена несостоявшейся"
    assert stats["failed"] == 0
    assert stats["undelivered"] == 1, "сорванная доставка не отражена в статистике"

    log = (await world.logs())[0]
    assert "checked 1" in log.log_text
    assert "1 undelivered" in log.log_text
    assert "not checked" not in log.log_text
    assert log.status == "partial"
    assert "RuntimeError" in log.log_text, "класс ошибки не доехал до журнала"


async def test_a_result_for_a_changed_address_is_thrown_away(world):
    """Адрес переписали, пока шёл опрос, — устаревший вердикт не применяется.

    Сценарий целиком: в строке опечатка в IP, один промах уже накоплен.
    Пользователь чинит адрес, пока идёт фаза опроса. Прежний `False` добирает
    второй промах подряд — и живая машина объявляется упавшей, причём в письме
    стоит НОВЫЙ адрес, которого никто не опрашивал: неверен и вердикт, и
    адрес. Окно узкое, но это ровно тот исход, который спека называет самым
    дорогим.
    """
    typo_host, fixed_host = _host(), _host()
    server_id = await world.server(
        typo_host, last_check_ok=True, consecutive_failures=1
    )

    async def _fix_the_address_mid_probe():
        async with AsyncSessionLocal() as session:
            await session.execute(
                sa_update(Server).where(Server.id == server_id).values(ip_address=fixed_host)
            )
            await session.commit()
        return False, "nodename nor servname provided"

    stats = await world.run(probe=_Probe({typo_host: _fix_the_address_mid_probe}))

    untouched = await world.reload(server_id)
    assert untouched.ip_address == fixed_host
    assert untouched.last_check_ok is True, "живой сервер уронен вердиктом о старом адресе"
    assert untouched.consecutive_failures == 1, "протухший промах всё-таки засчитан"
    assert untouched.last_check_at is None
    assert stats["checked"] == 0
    assert stats["failed"] == 1
    assert await world.notifications() == []


async def test_a_server_deleted_between_the_phases_is_counted_as_not_checked(world):
    """Сервер, удалённый во время опроса, не пропадает из статистики молча.

    Между опросом и записью проходят минуты, и строку за это время могут
    удалить. Записывать её результат некуда, но и потерять её из счёта нельзя:
    иначе `checked + failed` перестанет сходиться с числом опрошенных, и по
    журналу будет не понять, куда делись серверы.
    """
    doomed, survivor = _host(), _host()
    doomed_id = await world.server(doomed, last_check_ok=True)
    await world.server(survivor, last_check_ok=True)

    async def _delete_the_row_mid_probe():
        async with AsyncSessionLocal() as session:
            await session.execute(sa_delete(Server).where(Server.id == doomed_id))
            await session.commit()
        return True, None

    stats = await world.run(
        probe=_Probe({doomed: _delete_the_row_mid_probe, survivor: (True, None)})
    )

    assert stats["checked"] == 1
    assert stats["failed"] == 1, "исчезнувший сервер потерялся между счётчиками"
    assert await world.reload(doomed_id) is None
    assert (await world.logs())[0].status == "partial"


async def test_a_repeated_run_is_idempotent(world):
    """Второй прогон в том же состоянии не плодит уведомлений.

    Прогоны могут перекрыться (ручной запуск поверх расписания), и защита тут
    только одна — то, что неизменное состояние не считается переходом.
    """
    host = _host()
    await world.server(host, last_check_ok=False, consecutive_failures=3)

    first = await world.run(probe=_Probe({host: (True, None)}))
    second = await world.run(probe=_Probe({host: (True, None)}))

    assert (first["up"], second["up"]) == (1, 0)
    assert len(await world.notifications()) == 1, "повторный прогон прислал второе уведомление"


async def test_the_write_phase_goes_in_id_order_whatever_the_probe_order(world, monkeypatch):
    """Запись идёт по возрастанию id, а не в том порядке, в каком пришли исходы.

    Порядок обработки — не украшение: на нём держится воспроизводимость
    прогона (журнал и уведомления идут одинаково от запуска к запуску) и смысл
    теста про «соседа до и соседа после». Проверять его прогоном целиком
    бесполезно: порядок строк из `SELECT` без `ORDER BY` не определён, и на
    практике Postgres отдаёт их по id — тест зеленел бы и без сортировки,
    доказывая ровно ничего.

    Поэтому исходы подаются в `_apply_results` напрямую и в заведомо обратном
    порядке.
    """
    hosts = [_host() for _ in range(3)]
    ids = [await world.server(host, last_check_ok=True) for host in hosts]
    targets = [(server_id, host, 22, world.user_id) for server_id, host in zip(ids, hosts)]
    results = {server_id: (True, None) for server_id in reversed(ids)}
    handled: list[int] = []
    real_touch = server_monitor_task.touch_entity_sync

    async def _touch(db, user_id, entity):
        handled.append(entity.id)
        return await real_touch(db, user_id, entity)

    monkeypatch.setattr(server_monitor_task, "touch_entity_sync", _touch)

    async with AsyncSessionLocal() as session:
        stats, _errors = await server_monitor_task._apply_results(session, results, targets)

    assert stats[world.user_id]["checked"] == 3
    assert handled == sorted(ids), f"порядок записи задан не id, а порядком исходов: {handled}"


async def test_a_failing_rollback_does_not_escape_the_handler(monkeypatch):
    """Откат, который сам бросил, не уносит прогон.

    Если сбой был обрывом соединения, то бросит именно `rollback()`. Голый
    вызов в обработчике отдал бы это исключение наружу мимо всех перехватов —
    и унёс бы и остаток прогона, и запись `TaskLog`, то есть ровно тот
    инвариант, ради которого обработчик и написан. Случай нарочно узкий и
    поэтому проверяется юнитом: поднимать ради него мёртвое соединение к БД
    дороже, чем он того стоит.
    """
    traced: list[tuple] = []
    monkeypatch.setattr(
        server_monitor_task.logger, "exception", lambda *a, **kw: traced.append(a)
    )

    class _DeadSession:
        async def rollback(self):
            raise ConnectionResetError(54, "Connection reset by peer")

    await server_monitor_task._safe_rollback(_DeadSession())  # не должно бросить

    assert traced, "провалившийся откат прошёл бесследно"


# --- строка журнала ----------------------------------------------------------


def test_a_clean_run_is_logged_as_success():
    """Прогон без сбоев: статус `success`, все три числа в тексте и адресат.

    Юнит поверх прогона по БД: тот показывает, что строка пишется и статус
    верен, а здесь дёшево фиксируется точный текст — числа в журнале и есть
    всё, что человек увидит о прогоне.
    """
    owner = uuid.uuid4()
    log = server_monitor_task._build_task_log(
        {"checked": 7, "down": 2, "up": 1, "undelivered": 0, "failed": 0}, user_id=owner
    )

    assert log.status == "success"
    assert log.task_type == "server_monitor"
    assert log.entity_type == "system"
    # Без адресата строку не отдаст ни `GET /tasks`, ни `/sync/changes`: оба
    # фильтруют по владельцу, и `user_id = NULL` не проходит ни один из них.
    assert log.user_id == owner
    assert log.log_text == "checked 7 servers: 2 down, 1 up"


def test_a_run_with_failures_is_not_logged_as_success():
    """Есть непроверенные серверы — статус и текст обязаны это показать.

    `probe` по контракту не бросает, поэтому ненулевой `failed` означает баг,
    а не фон. Спрятать его под `success` — значит не узнать о нём никогда.
    """
    log = server_monitor_task._build_task_log(
        {"checked": 5, "down": 0, "up": 0, "undelivered": 0, "failed": 2},
        user_id=uuid.uuid4(),
    )

    assert log.status == "partial"
    assert "2 not checked" in log.log_text


def test_the_degraded_status_ends_the_sse_stream():
    """Статус, который пишет мониторинг, закрывает поток `/tasks/{id}/stream`.

    Связка производителя с потребителем, и проверять её надо именно связкой:
    `partial` завели в `TaskLogStatus`, показали на странице Activity, но в
    множество терминальных статусов SSE-обработчика не донесли. Поток по такой
    задаче не завершался бы никогда — `sleep(0.5)` крутился бы до отключения
    клиента, держа соединение и сессию к БД на каждый тик.
    """
    degraded = server_monitor_task._build_task_log(
        {"checked": 5, "down": 0, "up": 0, "undelivered": 0, "failed": 2},
        user_id=uuid.uuid4(),
    )
    clean = server_monitor_task._build_task_log(
        {"checked": 5, "down": 0, "up": 0, "undelivered": 0, "failed": 0},
        user_id=uuid.uuid4(),
    )

    assert degraded.status in TERMINAL_TASK_STATUSES
    assert clean.status in TERMINAL_TASK_STATUSES
    # И обратное: незавершённые статусы поток не закрывают, иначе он обрывался
    # бы на первом же тике, ничего не показав.
    assert TERMINAL_TASK_STATUSES.isdisjoint({"pending", "running"})


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


def test_the_task_takes_owners_as_json_strings_and_parses_them(monkeypatch):
    """Владельцы приезжают в задачу строками, а в выборку — уже как `UUID`.

    Брокер настроен на `task_serializer="json"`, и `uuid.UUID` в аргументах
    задачу до очереди попросту не довёз бы. Обратная сторона — строка, дошедшая
    до `WHERE user_id IN (…)` без разбора: тип аргумента здесь и есть предмет,
    и проверяется он на границе задачи, потому что дальше по коду его уже никто
    не проверяет.

    Заодно фиксируется, что вызов без аргумента остаётся прогоном по всему
    парку: так задачу зовут расписание и сигнал старта воркера, и подмена
    `None` на пустой список тихо превратила бы их в прогон ни по кому.
    """
    seen: list = []

    async def _fake_run(*, probe=None, user_ids=None):
        seen.append(user_ids)
        return {"checked": 0}

    monkeypatch.setattr(server_monitor_task, "_monitor_servers", _fake_run)
    owner = uuid.uuid4()

    server_monitor_task.check_server_reachability([str(owner)])
    server_monitor_task.check_server_reachability()

    assert seen == [[owner], None], f"аргумент доехал до выборки как {seen}"


def test_worker_start_rechecks_the_whole_fleet(published_tasks):
    """Старт воркера ставит прогон — по всему парку и по существующему имени.

    Дыра, ради которой сигнал заведён, реальная: расписание бьёт по слотам
    00/06/12/18 UTC, воркер поднялся в 06:09 и промахнулся мимо слота на девять
    минут — в БД у всех серверов остался `last_check_at = NULL` до полудня.

    Проверять «сигнал подключён, потому что мы его подключили» смысла нет,
    поэтому предмет тут другой и падает он по-настоящему: имя задачи (константа
    могла бы разъехаться с реестром Celery, и тогда сигнал стал бы беззвучным
    no-op) и отсутствие сужения (сузить прогон по владельцу означало бы после
    деплоя переопросить чей-то один парк вместо всех).
    """
    celery_app_module.recheck_the_fleet_on_worker_start(sender="worker@test")

    assert len(published_tasks) == 1, f"опубликовано не одно: {published_tasks}"
    published = published_tasks[0]
    assert published.name in celery_app.tasks, f"сигнал зовёт имя-призрак: {published.name}"
    assert published.name == server_monitor_task.check_server_reachability.name
    assert published.args == () and published.kwargs == {}, (
        "прогон после деплоя сужен — часть парка останется непроверенной"
    )


def test_a_dead_broker_at_worker_start_does_not_stop_the_worker(monkeypatch, app_log):
    """Брокер не принял прогон на старте — воркер всё равно поднимается.

    Сигнал выполняется внутри загрузки воркера, и исключение отсюда уронило бы
    сам воркер. Размен очевиден: без прогона на старте парк дождётся ближайшего
    слота, без воркера не работает вообще ничего — включая расписание.
    """

    def _broker_is_down(self, name, *args, **kwargs):
        raise OperationalError("Redis не отвечает")

    monkeypatch.setattr(Celery, "send_task", _broker_is_down)

    # Не должно бросить: исключение отсюда — это упавший воркер.
    celery_app_module.recheck_the_fleet_on_worker_start(sender="worker@test")

    assert any(
        rec.levelno == logging.WARNING and rec.name == celery_app_module.__name__
        for rec in app_log.records
    ), "провал публикации прошёл бесследно — «мониторинг молчит» не отличить от «брокер лёг»"
