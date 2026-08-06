"""Мониторинг доступности серверов: TCP-проверка порта и переходы состояния.

Модуль намеренно не знает ни про SSH-логин, ни про секреты. Пароль сервера
лежит на бэкенде непрозрачным блобом под мастер-ключом пользователя (принцип
zero-knowledge), расшифровать его может только разблокированный десктоп — а
вопрос «сервер вообще жив?» надо задавать круглосуточно, в том числе когда
десктоп закрыт. Поэтому проверка — это TCP-коннект на `ip_address:ssh_port` и
ничего больше: ответивший порт 22 означает «по серверу реально можно
работать». ICMP-ping не используется: его режут файрволы, и молчание в ответ
означало бы «упал» для половины живых машин.

Секретам в этом пути взяться неоткуда, и `last_check_error` содержит только
текст сетевой ошибки (`timeout after 5s`, `Connection refused`).

Здесь живут две половины проверки, а не одна: `probe` отвечает на вопрос
«порт ответил?», `evaluate` — «что это значит для состояния сервера и надо ли
будить пользователя». Задача Celery (фаза 4 плана) склеивает их и коммитит.
"""

import asyncio
from datetime import datetime, timezone
from typing import Awaitable, Callable, Literal, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.server import Server
from app.services import notification_service

# Сколько ждём ответа порта. Пять секунд — заметно больше любого живого
# хендшейка и достаточно мало, чтобы сотня молчащих серверов не съела лимит
# времени задачи.
DEFAULT_TIMEOUT_SECONDS = 5.0

# Пауза перед единственным ретраем: гасит мгновенную сетевую икоту на воркере,
# не превращая проверку в долбёжку.
RETRY_DELAY_SECONDS = 2.0

# Промахов подряд, после которых падение считается подтверждённым.
FAILURE_THRESHOLD = 2

# Потолок для текста ошибки: он уезжает в БД и в тултип карточки, и простыня
# из чужого исключения там не нужна.
MAX_ERROR_LEN = 300

Transition = Literal["up", "down"]

# Коннектор вынесен параметром: тесты подменяют его заглушкой и не открывают
# реальных сокетов.
Connector = Callable[[str, int], Awaitable[Tuple[object, object]]]


async def probe(
    host: str,
    port: int,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    *,
    connect: Connector = asyncio.open_connection,
    retry_delay: float = RETRY_DELAY_SECONDS,
) -> Tuple[bool, Optional[str]]:
    """Одна проверка доступности порта: `(ok, текст ошибки | None)`.

    Ретрай — часть **одной** проверки, а не вторая проверка: наружу уезжает
    единственный исход. Иначе икота набирала бы порог из двух промахов за один
    прогон и роняла статус живого сервера.
    """
    error = await _attempt(host, port, timeout, connect)
    if error is None:
        return True, None

    await asyncio.sleep(retry_delay)
    error = await _attempt(host, port, timeout, connect)
    return error is None, error


async def evaluate(
    session: AsyncSession,
    server: Server,
    ok: bool,
    error: Optional[str],
) -> Optional[Transition]:
    """Применить исход проверки к серверу; вернуть случившийся переход.

    Возвращает `"down"`, `"up"` или `None` (состояние не изменилось). Поля
    сервера меняются всегда, уведомление уходит только на переходе.

    Порог в два промаха живёт здесь, а не в `probe`, потому что он про
    состояние между прогонами: `last_check_ok = False` фронт красит красным,
    и одиночный промах в это состояние протекать не должен.

    Транзакцию закрывает вызывающий: сюда сервер приходит пачкой, и коммит
    на каждую строку — не наше решение. `create_notification` коммитит сам,
    когда уведомление действительно создано.
    """
    now = datetime.now(timezone.utc)
    previous_ok = server.last_check_ok
    # Значение `last_check_at` ДО перезаписи. Для второго промаха подряд это
    # момент первого промаха, то есть начало эпизода падения, — он и служит
    # маркером эпизода в ключе дедупа.
    previous_check_at = server.last_check_at

    server.last_check_at = now
    if ok:
        server.consecutive_failures = 0
        server.last_check_ok = True
        server.last_check_error = None
        # Переход вверх — только из подтверждённого падения: `None`
        # («не проверялся») сообщать пользователю не о чем.
        transition: Optional[Transition] = "up" if previous_ok is False else None
        episode_marker = now
    else:
        failures = (server.consecutive_failures or 0) + 1
        server.consecutive_failures = failures
        server.last_check_error = error
        if failures >= FAILURE_THRESHOLD and previous_ok is not False:
            server.last_check_ok = False
            transition = "down"
        else:
            transition = None
        episode_marker = previous_check_at or now

    await session.flush()
    if transition is not None:
        await _notify(session, server, transition, episode_marker)
    return transition


async def _attempt(host: str, port: int, timeout: float, connect: Connector) -> Optional[str]:
    """Одна попытка коннекта: `None` — порт ответил, иначе текст ошибки."""
    try:
        _reader, writer = await asyncio.wait_for(connect(host, port), timeout)
    except asyncio.TimeoutError:
        # Ловится раньше OSError: начиная с 3.11 `asyncio.TimeoutError` — это
        # встроенный `TimeoutError`, а он наследник `OSError`.
        return f"timeout after {timeout:g}s"
    except OSError as exc:
        # Сюда же приходит `socket.gaierror` (не разрешилось имя) — для
        # мониторинга это такой же «недоступен», а не повод ронять прогон.
        return _error_text(exc)

    await _close(writer)
    return None


async def _close(writer) -> None:
    """Закрыть соединение, не позволив ошибке закрытия испортить исход.

    Проверка ходит по сотням серверов раз в 6 часов: незакрытые сокеты
    копятся в воркере, а на чужой машине висят полуоткрытыми соединениями.
    """
    try:
        writer.close()
        await writer.wait_closed()
    except Exception:  # noqa: BLE001 — порт уже ответил, исход проверки решён
        pass


def _error_text(exc: BaseException) -> str:
    """Короткий человекочитаемый текст ошибки для колонки и тултипа."""
    text = str(exc).strip() or exc.__class__.__name__
    return text[:MAX_ERROR_LEN]


async def _notify(
    session: AsyncSession,
    server: Server,
    transition: Transition,
    episode_marker: datetime,
) -> None:
    """Уведомить владельца о переходе.

    Ключ дедупа привязан к эпизоду, а не к серверу: `server_down:{id}` съел бы
    `on_conflict_do_nothing`-ом второе падение того же сервера через месяц, и
    пользователь узнал бы о нём только глазами.
    """
    if server.user_id is None:
        return  # строка без владельца — уведомление адресовать некому

    where = f"{server.ip_address}:{server.ssh_port}"
    if transition == "down":
        title = f"Server {server.name} is unreachable"
        message = (
            f"Port {where} did not answer {FAILURE_THRESHOLD} checks in a row. "
            f"Last error: {server.last_check_error}."
        )
    else:
        title = f"Server {server.name} is reachable again"
        message = f"Port {where} answers again."

    await notification_service.create_notification(
        session,
        user_id=server.user_id,
        type=f"server_{transition}",
        entity_type="server",
        entity_id=server.id,
        title=title,
        message=message,
        dedup_key=f"server_{transition}:{server.id}:{episode_marker.isoformat()}",
    )
