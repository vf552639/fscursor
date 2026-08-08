"""Мониторинг доступности серверов: TCP-проверка и таблица переходов.

Тесты юнитовые и без БД намеренно. Предмет проверки — решение, а не запись:
`apply_check_result` меняет поля ORM-объекта и решает, случился ли переход, и именно это
решение стоит денег пользователя. Строка в `servers` и `notifications` — забота
слоя, который вызывает `apply_check_result` (фаза 4 плана), у него будет свой
тест.

Реальный TCP не открывается ни в одном случае: коннектор подменяется
заглушкой. Иначе тест зависел бы от сети машины, где он бежит, и «упал» в нём
означало бы что угодно.

Коннектор-заглушка отдаёт исходы по очереди и **падает `AssertionError`**, если
у неё запросили попытку сверх ожидаемых: без этого «один ретрай» превратился бы
в цикл, а тест на две попытки остался бы зелёным.
"""

import asyncio
import inspect
import uuid
from typing import Optional

import pytest

from app.models.server import Server
from app.services import server_monitor


class _FakeSession:
    """Сессия-заглушка без единого метода.

    Так и задумано: `apply_check_result` не должна ходить в БД сама — она
    меняет поля объекта и передаёт сессию дальше, в уведомления. Любой новый
    вызов вроде `flush()`/`commit()` тут же обвалится `AttributeError`, то
    есть станет видимым решением, а не тихой добавкой.
    """


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
        self.writer_cls: type[_FakeWriter] = _FakeWriter

    async def __call__(self, host: str, port: int):
        self.calls.append((host, port))
        assert self._outcomes, "probe полез на попытку сверх ожидаемых"
        outcome = self._outcomes.pop(0)
        if outcome is not None:
            raise outcome
        writer = self.writer_cls()
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
        calls.append({"db": db, **kwargs})
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

    transition = await server_monitor.apply_check_result(session, srv, False, "connection refused")

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

    await server_monitor.apply_check_result(session, srv, False, "connection refused")
    first_miss_at = srv.last_check_at

    transition = await server_monitor.apply_check_result(session, srv, False, "connection refused")

    assert transition == "down"
    assert srv.consecutive_failures == 2
    assert srv.last_check_ok is False
    assert len(sent) == 1, sent
    note = sent[0]
    assert note["db"] is session, "уведомление ушло мимо переданной сессии"
    assert note["type"] == "server_down"
    assert note["entity_type"] == "server"
    assert note["entity_id"] == srv.id
    assert note["user_id"] == srv.user_id
    assert note["dedup_key"] == f"server_down:{srv.id}:{first_miss_at.isoformat()}"
    assert "connection refused" in note["message"], "в уведомлении нет причины падения"


@pytest.mark.asyncio
async def test_the_notification_shows_a_clean_address(sent):
    """Адрес в письме без обрамляющих пробелов.

    `probe` их срезает перед опросом, а текст уведомления собирается из
    колонки как есть — и `Port  203.0.113.10 :22 did not answer` читается как
    опечатка отправителя. Уведомление и так приходит в плохую минуту.
    """
    srv = _server(ip_address="  203.0.113.10 ", last_check_ok=True)
    session = _FakeSession()

    for _ in range(2):
        await server_monitor.apply_check_result(session, srv, False, "timeout")

    assert "203.0.113.10:22" in sent[0]["message"], sent[0]["message"]


@pytest.mark.asyncio
async def test_further_misses_stay_silent(sent):
    """3-й и 4-й промахи: счётчик растёт, статус держится, новых писем нет."""
    srv = _server(last_check_ok=True)
    session = _FakeSession()
    for _ in range(2):
        await server_monitor.apply_check_result(session, srv, False, "timeout")
    sent.clear()

    for expected in (3, 4):
        transition = await server_monitor.apply_check_result(session, srv, False, "timeout")
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
        await server_monitor.apply_check_result(session, srv, False, "timeout")
    sent.clear()

    transition = await server_monitor.apply_check_result(session, srv, True, None)

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

    assert await server_monitor.apply_check_result(session, srv, True, None) is None
    assert await server_monitor.apply_check_result(session, srv, True, None) is None
    assert sent == []


@pytest.mark.asyncio
async def test_first_successful_check_of_a_fresh_server_is_not_a_recovery(sent):
    """Порт ответил у сервера, который ни разу не проверялся, — это не «поднялся».

    Переход вверх бывает только из подтверждённого падения (`last_check_ok is
    False`). Стоит ослабить условие до «было не `True`» — и каждый только что
    заведённый сервер получит `server_up` на первой же проверке: уведомление
    ни о чём, и так на каждом сервере при заведении. Остальные успешные
    случаи стартуют с `last_check_ok = True` и такую подмену не заметят,
    поэтому случай нужен отдельным.
    """
    srv = _server(last_check_ok=None)
    session = _FakeSession()

    transition = await server_monitor.apply_check_result(session, srv, True, None)

    assert transition is None, "первая успешная проверка выдана за восстановление"
    assert srv.last_check_ok is True
    assert sent == []


@pytest.mark.asyncio
async def test_success_after_a_single_miss_resets_the_counter_quietly(sent):
    """Икота, пережившая один прогон: счётчик обнуляется, тишина.

    Порог должен считать промахи **подряд**: без обнуления два промаха с
    полугодом жизни между ними сложились бы в «падение».
    """
    srv = _server(last_check_ok=True)
    session = _FakeSession()
    await server_monitor.apply_check_result(session, srv, False, "timeout after 5s")

    transition = await server_monitor.apply_check_result(session, srv, True, None)

    assert transition is None
    assert srv.consecutive_failures == 0
    assert srv.last_check_error is None
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

    assert await server_monitor.apply_check_result(session, srv, False, "timeout") is None
    assert srv.last_check_ok is None, "первый промах подменил «не проверялся» на «упал»"
    assert await server_monitor.apply_check_result(session, srv, False, "timeout") == "down"
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
            await server_monitor.apply_check_result(session, srv, False, "timeout")
        await server_monitor.apply_check_result(session, srv, True, None)

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
        await server_monitor.apply_check_result(session, srv, False, "timeout")

    assert srv.last_check_ok is False
    assert srv.consecutive_failures == 2
    assert sent == []


# --- probe -------------------------------------------------------------------


def test_probe_defaults_are_the_ones_the_spec_asks_for():
    """Дефолты: таймаут 5с, пауза перед ретраем 2с.

    Проверяются явно, потому что во всех остальных случаях они подменены
    нулём и малыми числами ради скорости прогона. Без этого утверждения
    `retry_delay` мог бы уехать в 0 и в проде — и ретрай мгновенно повторял
    бы ровно ту же сетевую икоту, ради которой он и заведён.
    """
    params = inspect.signature(server_monitor.probe).parameters

    assert server_monitor.DEFAULT_TIMEOUT_SECONDS == 5.0
    assert server_monitor.RETRY_DELAY_SECONDS == 2.0
    assert params["timeout"].default == server_monitor.DEFAULT_TIMEOUT_SECONDS
    assert params["retry_delay"].default == server_monitor.RETRY_DELAY_SECONDS


@pytest.mark.asyncio
async def test_probe_actually_waits_before_the_retry():
    """Между попытками действительно ждём.

    Ретрай без паузы бессмыслен: он попадает в ту же миллисекунду сетевого
    сбоя, из-за которого промахнулась первая попытка, и порог из двух
    промахов подряд начинает набираться на ровном месте. Пауза здесь
    крошечная, но проверка ловит именно её отсутствие.
    """
    delay = 0.05
    connect = _Connector(ConnectionRefusedError(61, "Connection refused"), None)
    loop = asyncio.get_running_loop()

    started = loop.time()
    await server_monitor.probe("203.0.113.10", 22, connect=connect, retry_delay=delay)
    elapsed = loop.time() - started

    assert len(connect.calls) == 2
    assert elapsed >= delay * 0.9, f"ретрай ушёл без паузы: {elapsed:.4f}s"


@pytest.mark.asyncio
async def test_probe_truncates_a_monstrous_error_text():
    """Гигантский текст ошибки обрезается.

    Текст приходит с чужой стороны (сообщение резолвера, ответ прокси), а у
    колонки `last_check_error` тип `Text` — верхней границы нет. Простыня
    осела бы и в БД, и в тултипе карточки сервера.

    Обрезка помечается многоточием: молча усечённый текст в тултипе не
    отличить от полного, и читатель поверит оборванной фразе.
    """
    huge = "x" * 5000
    connect = _Connector(OSError(huge), OSError(huge))

    ok, error = await server_monitor.probe(
        "203.0.113.10", 22, connect=connect, retry_delay=0
    )

    assert ok is False
    assert error is not None
    assert len(error) == server_monitor.MAX_ERROR_LEN, "текст ошибки не обрезан"
    assert error.endswith(server_monitor.TRUNCATION_MARK), "обрезка не помечена"


@pytest.mark.asyncio
async def test_probe_keeps_a_short_error_text_intact():
    """Обычная ошибка не трогается: ни обрезки, ни лишнего многоточия.

    Граница проверяется с двух сторон — иначе «обрезка» могла бы клеить
    многоточие ко всем ошибкам подряд, и каждая выглядела бы неполной.
    """
    connect = _Connector(
        ConnectionRefusedError(61, "Connection refused"),
        ConnectionRefusedError(61, "Connection refused"),
    )

    _ok, error = await server_monitor.probe(
        "203.0.113.10", 22, connect=connect, retry_delay=0
    )

    assert error == "[Errno 61] Connection refused"


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

    Ретрай не должен доезжать до `apply_check_result` отдельным промахом, иначе порог в
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

    Текст сверяется целиком, вместе с числом: так видно, что ждали именно
    переданный таймаут, а не какой-то свой.
    """

    async def _hangs(host: str, port: int):
        await asyncio.sleep(3600)

    ok, error = await server_monitor.probe(
        "203.0.113.10", 22, timeout=0.01, connect=_hangs, retry_delay=0
    )

    assert ok is False
    assert error == "timeout after 0.01s"


@pytest.mark.asyncio
async def test_probe_survives_a_unicode_error_from_the_resolver():
    """Кривой адрес вроде `10.0.0..5` — это «недоступен», а не обвал прогона.

    На пустой метке имени IDNA-кодек резолвера бросает `UnicodeError`, и он
    **не** наследник `OSError`, то есть мимо обычного перехвата отказов сети.
    А попасть в БД такой адрес может: `ServerBase.ip_address` не валидируется
    вообще. Прогон фазы 4 идёт циклом по серверам пользователя — исключение
    отсюда молча выключило бы мониторинг всех остальных машин, что для фичи
    «узнать, что сервер упал» худший из отказов.
    """
    connect = _Connector(
        UnicodeError("label empty or too long"),
        UnicodeError("label empty or too long"),
    )

    ok, error = await server_monitor.probe("10.0.0..5", 22, connect=connect, retry_delay=0)

    assert ok is False
    assert error and "label empty" in error


@pytest.mark.asyncio
async def test_probe_refuses_an_empty_address_instead_of_asking_the_resolver():
    """Пустой адрес — сразу отказ, резолвер не зовём.

    `getaddrinfo("", 22)` разрешается в `127.0.0.1`/`::1`, то есть в сам
    воркер. Сервер с пустым `ip_address` и портом, который на воркере занят,
    отчитался бы `up`, ни разу не будучи опрошенным: мониторинг доложил бы
    «жив» о машине, которую вообще не трогал.
    """
    for host in ("", "   "):
        connect = _Connector()  # ни одного исхода: любая попытка уронит тест

        ok, error = await server_monitor.probe(host, 22, connect=connect, retry_delay=0)

        assert (ok, error) == (False, server_monitor.NO_ADDRESS_ERROR)
        assert connect.calls == [], "пустой адрес всё-таки уехал в резолвер"


@pytest.mark.asyncio
async def test_probe_strips_padding_around_the_address():
    """Пробелы вокруг адреса срезаются, а не уезжают в резолвер.

    `" 203.0.113.10 "` попадает в БД из CSV-импорта, и это валидный адрес
    валидной машины. Отданный резолверу как есть, он даёт «имя не
    разрешилось» — то есть мониторинг двумя прогонами позже разбудит
    владельца живого сервера. Ложное «упал» — самый дорогой исход этой фичи:
    после пары таких писем перестают верить и настоящим.
    """
    connect = _Connector(None)

    ok, error = await server_monitor.probe(
        "  203.0.113.10\n", 22, connect=connect, retry_delay=0
    )

    assert (ok, error) == (True, None)
    assert connect.calls == [("203.0.113.10", 22)], "в резолвер уехал адрес с пробелами"


@pytest.mark.asyncio
async def test_probe_survives_a_socket_that_throws_on_close():
    """Порт ответил — проверка успешна, даже если закрытие сокета бросило.

    Настоящий `StreamWriter.wait_closed()` бросает вполне буднично
    (`ConnectionResetError` на RST от той стороны), и без перехвата успешная
    проверка живого сервера обвалила бы весь прогон.
    """

    class _RudeOnWait(_FakeWriter):
        async def wait_closed(self) -> None:
            raise ConnectionResetError(54, "Connection reset by peer")

    class _RudeOnClose(_FakeWriter):
        def close(self) -> None:
            raise OSError(9, "Bad file descriptor")

    for writer_cls in (_RudeOnWait, _RudeOnClose):
        connect = _Connector(None)
        connect.writer_cls = writer_cls

        result = await server_monitor.probe(
            "203.0.113.10", 22, connect=connect, retry_delay=0
        )

        assert result == (True, None), f"{writer_cls.__name__} испортил успешную проверку"


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
