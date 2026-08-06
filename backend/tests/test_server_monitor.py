"""Мониторинг доступности серверов: TCP-проверка и таблица переходов.

Тесты юнитовые и без БД намеренно. Предмет проверки — решение, а не запись:
`evaluate` меняет поля ORM-объекта и решает, случился ли переход, и именно это
решение стоит денег пользователя. Строка в `servers` и `notifications` — забота
слоя, который вызывает `evaluate` (фаза 4 плана), у него будет свой тест.

Реальный TCP не открывается ни в одном случае: коннектор подменяется
заглушкой. Иначе тест зависел бы от сети машины, где он бежит, и «упал» в нём
означало бы что угодно.

Коннектор-заглушка отдаёт исходы по очереди и **падает `AssertionError`**, если
у неё запросили попытку сверх ожидаемых: без этого «один ретрай» превратился бы
в цикл, а тест на две попытки остался бы зелёным.
"""

import asyncio
import uuid
from typing import Optional

import pytest

from app.models.server import Server
from app.services import server_monitor


class _FakeSession:
    """Сессия-заглушка: `evaluate` от неё нужен только `flush()`."""

    def __init__(self) -> None:
        self.flushes = 0

    async def flush(self) -> None:
        self.flushes += 1


class _FakeWriter:
    """`StreamWriter`-заглушка: помнит, закрыли ли соединение."""

    def __init__(self) -> None:
        self.closed = False
        self.awaited_close = False

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        self.awaited_close = True


class _Connector:
    """Коннектор с заранее заданными исходами попыток.

    Исход `None` — соединение установлено, исключение — попытка провалилась.
    Попытка сверх списка роняет тест: «один ретрай» обязан означать ровно две.
    """

    def __init__(self, *outcomes: Optional[BaseException]) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[tuple[str, int]] = []
        self.writers: list[_FakeWriter] = []

    async def __call__(self, host: str, port: int):
        self.calls.append((host, port))
        assert self._outcomes, "probe полез на попытку сверх ожидаемых"
        outcome = self._outcomes.pop(0)
        if outcome is not None:
            raise outcome
        writer = _FakeWriter()
        self.writers.append(writer)
        return object(), writer


def _server(**overrides) -> Server:
    """Сервер в памяти: до INSERT питоновские `default` не применяются."""
    fields = dict(
        id=42,
        user_id=uuid.uuid4(),
        name="srv-1",
        ip_address="203.0.113.10",
        ssh_port=22,
        consecutive_failures=0,
        last_check_at=None,
        last_check_ok=None,
        last_check_error=None,
    )
    fields.update(overrides)
    return Server(**fields)


@pytest.fixture
def sent(monkeypatch) -> list[dict]:
    """Перехват `create_notification`: сам сервис уведомлений не трогаем."""
    calls: list[dict] = []

    async def _fake_create_notification(db, **kwargs) -> bool:
        calls.append(kwargs)
        return True

    monkeypatch.setattr(
        server_monitor.notification_service,
        "create_notification",
        _fake_create_notification,
    )
    return calls


# --- таблица состояния -------------------------------------------------------


@pytest.mark.asyncio
async def test_single_miss_neither_drops_the_status_nor_notifies(sent):
    """1-й промах подряд: счётчик растёт, статус остаётся прежним, тишина.

    Это вся защита от сетевой икоты: `last_check_ok = False` фронт красит
    красным, и одиночный промах в это состояние протекать не должен.
    """
    srv = _server(last_check_ok=True)
    session = _FakeSession()

    transition = await server_monitor.evaluate(session, srv, False, "connection refused")

    assert transition is None
    assert srv.consecutive_failures == 1
    assert srv.last_check_ok is True, "одиночный промах уронил статус"
    assert srv.last_check_at is not None
    assert srv.last_check_error == "connection refused"
    assert sent == [], "уведомление ушло на первом же промахе"


@pytest.mark.asyncio
async def test_second_miss_in_a_row_confirms_the_outage_and_notifies(sent):
    """2-й промах подряд: статус в `False` и ровно одно `server_down`.

    Ключ дедупа проверяется целиком: маркер эпизода — момент **первого**
    промаха, а не текущий. Ключ, привязанный к серверу целиком, погасил бы
    второе падение через месяц; ключ от текущего момента — наоборот, дал бы
    новое уведомление на каждый прогон.
    """
    srv = _server(last_check_ok=True)
    session = _FakeSession()

    await server_monitor.evaluate(session, srv, False, "connection refused")
    first_miss_at = srv.last_check_at

    transition = await server_monitor.evaluate(session, srv, False, "connection refused")

    assert transition == "down"
    assert srv.consecutive_failures == 2
    assert srv.last_check_ok is False
    assert len(sent) == 1, sent
    note = sent[0]
    assert note["type"] == "server_down"
    assert note["entity_type"] == "server"
    assert note["entity_id"] == srv.id
    assert note["user_id"] == srv.user_id
    assert note["dedup_key"] == f"server_down:{srv.id}:{first_miss_at.isoformat()}"
    assert "connection refused" in note["message"], "в уведомлении нет причины падения"


@pytest.mark.asyncio
async def test_further_misses_stay_silent(sent):
    """3-й и 4-й промахи: счётчик растёт, статус держится, новых писем нет."""
    srv = _server(last_check_ok=True)
    session = _FakeSession()
    for _ in range(2):
        await server_monitor.evaluate(session, srv, False, "timeout")
    sent.clear()

    for expected in (3, 4):
        transition = await server_monitor.evaluate(session, srv, False, "timeout")
        assert transition is None
        assert srv.consecutive_failures == expected
        assert srv.last_check_ok is False

    assert sent == [], "повторный промах в том же состоянии прислал уведомление"


@pytest.mark.asyncio
async def test_recovery_notifies_and_clears_the_error(sent):
    """Порт ответил после падения: `server_up`, счётчик и ошибка обнулены."""
    srv = _server(last_check_ok=True)
    session = _FakeSession()
    for _ in range(2):
        await server_monitor.evaluate(session, srv, False, "timeout")
    sent.clear()

    transition = await server_monitor.evaluate(session, srv, True, None)

    assert transition == "up"
    assert srv.consecutive_failures == 0
    assert srv.last_check_ok is True
    assert srv.last_check_error is None
    assert len(sent) == 1, sent
    assert sent[0]["type"] == "server_up"
    assert sent[0]["entity_id"] == srv.id
    assert sent[0]["dedup_key"].startswith(f"server_up:{srv.id}:")


@pytest.mark.asyncio
async def test_repeated_success_stays_silent(sent):
    """Живой сервер, проверенный дважды: ни перехода, ни уведомления."""
    srv = _server(last_check_ok=True)
    session = _FakeSession()

    assert await server_monitor.evaluate(session, srv, True, None) is None
    assert await server_monitor.evaluate(session, srv, True, None) is None
    assert sent == []


@pytest.mark.asyncio
async def test_never_checked_server_goes_down_only_after_two_misses(sent):
    """Сервер без единой проверки (`last_check_ok = None`) — правило то же.

    Пограничный случай ровно потому, что `None` — это «не проверялся», а не
    «жив»: проверка на `is not False` обязана считать его не-`False` и на
    втором промахе прислать `server_down`.
    """
    srv = _server(last_check_ok=None)
    session = _FakeSession()

    assert await server_monitor.evaluate(session, srv, False, "timeout") is None
    assert srv.last_check_ok is None, "первый промах подменил «не проверялся» на «упал»"
    assert await server_monitor.evaluate(session, srv, False, "timeout") == "down"
    assert [n["type"] for n in sent] == ["server_down"]


@pytest.mark.asyncio
async def test_each_outage_episode_gets_its_own_dedup_key(sent):
    """Второе падение после восстановления — новое уведомление, не дубль.

    Тот самый случай, который ломает ключ вида `server_down:{id}`: эпизод
    через месяц был бы съеден `on_conflict_do_nothing` и пользователь узнал бы
    о падении только глазами.
    """
    srv = _server(last_check_ok=True)
    session = _FakeSession()

    async def _one_outage_and_recovery() -> None:
        for _ in range(2):
            await server_monitor.evaluate(session, srv, False, "timeout")
        await server_monitor.evaluate(session, srv, True, None)

    await _one_outage_and_recovery()
    await _one_outage_and_recovery()

    down_keys = [n["dedup_key"] for n in sent if n["type"] == "server_down"]
    assert len(down_keys) == 2, sent
    assert down_keys[0] != down_keys[1], "второй эпизод падения получил ключ первого"


@pytest.mark.asyncio
async def test_server_without_owner_is_tracked_but_nobody_is_notified(sent):
    """Строка без `user_id`: поля обновляем, уведомление адресовать некому."""
    srv = _server(user_id=None, last_check_ok=True)
    session = _FakeSession()

    for _ in range(2):
        await server_monitor.evaluate(session, srv, False, "timeout")

    assert srv.last_check_ok is False
    assert srv.consecutive_failures == 2
    assert sent == []


# --- probe -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_probe_succeeds_on_the_first_attempt_and_closes_the_socket():
    """Порт ответил: одна попытка, `(True, None)` и закрытое соединение.

    Закрытие проверяется, потому что мониторинг ходит по сотням серверов раз в
    6 часов: незакрытые сокеты копятся в воркере, а на чужой машине висят
    полуоткрытыми соединениями.
    """
    connect = _Connector(None)

    ok, error = await server_monitor.probe("203.0.113.10", 22, connect=connect, retry_delay=0)

    assert (ok, error) == (True, None)
    assert connect.calls == [("203.0.113.10", 22)]
    assert connect.writers[0].closed and connect.writers[0].awaited_close


@pytest.mark.asyncio
async def test_probe_retry_is_still_a_single_check():
    """Промах, потом успех — это одна проверка с исходом «жив».

    Ретрай не должен доезжать до `evaluate` отдельным промахом, иначе порог в
    два промаха подряд набирался бы за один прогон и икота роняла бы статус.
    """
    connect = _Connector(ConnectionRefusedError(61, "Connection refused"), None)

    ok, error = await server_monitor.probe("203.0.113.10", 22, connect=connect, retry_delay=0)

    assert (ok, error) == (True, None), "ретрай не засчитан как успех проверки"
    assert len(connect.calls) == 2


@pytest.mark.asyncio
async def test_probe_reports_the_error_when_the_retry_fails_too():
    """Обе попытки мимо: `(False, текст)` и ровно две попытки."""
    connect = _Connector(
        ConnectionRefusedError(61, "Connection refused"),
        ConnectionRefusedError(61, "Connection refused"),
    )

    ok, error = await server_monitor.probe("203.0.113.10", 22, connect=connect, retry_delay=0)

    assert ok is False
    assert error and "Connection refused" in error
    assert len(connect.calls) == 2


@pytest.mark.asyncio
async def test_probe_reports_a_hung_port_as_timeout():
    """Порт молчит (пакеты дропает файрвол) — это таймаут, а не зависание.

    Без `wait_for` проверка висела бы до системного таймаута TCP, и прогон по
    сотне серверов не уложился бы в лимит задачи.
    """

    async def _hangs(host: str, port: int):
        await asyncio.sleep(3600)

    ok, error = await server_monitor.probe(
        "203.0.113.10", 22, timeout=0.01, connect=_hangs, retry_delay=0
    )

    assert ok is False
    assert error and "timeout" in error.lower()


@pytest.mark.asyncio
async def test_probe_reports_an_unresolvable_host_instead_of_raising():
    """DNS не разрешился — тоже штатный «недоступен», а не исключение наружу.

    `gaierror` прилетает не из сокета, а из резолвера, и незакрытый обработчик
    ронял бы весь прогон целиком, а не одну строку.
    """
    connect = _Connector(
        OSError(8, "nodename nor servname provided"),
        OSError(8, "nodename nor servname provided"),
    )

    ok, error = await server_monitor.probe("no-such.host", 22, connect=connect, retry_delay=0)

    assert ok is False
    assert error and "nodename" in error
