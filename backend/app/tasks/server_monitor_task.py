"""Периодический прогон мониторинга: опросить серверы и записать результат.

Задача склеивает две половины из `services/server_monitor.py` — `probe`
(«порт ответил?») и `apply_check_result` («что это значит для состояния») — и
делает это в две явно разделённые фазы.

**Опрос — веером.** `probe` не трогает БД вообще, это чистая сеть, а её худший
случай — 12 секунд на молчащий сервер (таймаут + пауза + таймаут).
Последовательный обход сотни таких серверов занял бы двадцать минут, и лимит
задачи (`task_soft_time_limit` = 55 минут) держится только на параллельности.
Ширина веера ограничена семафором: без него прогон на сотнях серверов открыл
бы сотни сокетов разом и упёрся бы в лимит дескрипторов воркера.

**Запись — по одному, последовательно.** Соблазн раздать каждому серверу свою
сессию и писать так же веером здесь ведёт в тупик по двум причинам:

* `touch_entity_sync` берёт `SELECT … FOR UPDATE` на строку `sync_state`
  пользователя. Двадцать параллельных сессий одного владельца дрались бы за
  одну и ту же строку — в лучшем случае выстроились бы в очередь, в худшем
  переплелись бы блокировками;
* `apply_check_result` на переходе коммитит транзакцию и делает исходящие
  HTTP-запросы (вебхук, Telegram). В общей параллельной сессии такой коммит
  утаскивал бы в БД недописанные правки соседних серверов.

БД быстрая, писать тут нечего — выигрыш от параллельной записи нулевой, а
цена высокая. Поэтому цикл последовательный, и коммит идёт после каждого
сервера: сбой на одной строке откатывает только её.

Между фазами сессия закрывается намеренно. Держать её открытой через весь
опрос значило бы держать открытую транзакцию (`idle in transaction`) минутами
— через пулер Supabase это занятое серверное соединение и помеха вакууму.

Сбой одной проверки не должен ронять прогон остальных: фича существует ради
момента, когда что-то сломалось, и тишина вместо оповещения по всем машинам
из-за одной кривой строки — худший из возможных отказов. Поэтому и опрос
(`return_exceptions=True`), и запись (`try` вокруг каждого сервера) переживают
падение отдельного сервера, а число таких случаев уезжает в `TaskLog`.

Выборку можно сузить до конкретных владельцев (`user_ids`); расписание зовёт
без сужения, то есть по всем. Параметр заведён ради тестов, и почему это
защита, а не удобство — в `_load_targets`.
"""

import asyncio
import uuid
from typing import Awaitable, Callable, Optional, Sequence, Tuple, Union

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.celery_app import celery_app
from app.core.constants import TaskLogStatus
from app.core.database import AsyncSessionLocal
from app.models.server import Server
from app.models.task_log import TaskLog
from app.services import server_monitor
from app.sync.service import touch_entity_sync

# Сколько серверов опрашиваем одновременно.
PROBE_CONCURRENCY = 20

# `(id сервера, хост, порт)` — всё, что нужно опросу. ORM-объекты в фазу
# опроса не едут: сессия к этому моменту уже закрыта.
Target = Tuple[int, str, int]
ProbeResult = Tuple[bool, Optional[str]]
# Сама проверка вынесена параметром: тесты подменяют её заглушкой и не
# открывают реальных сокетов — тот же приём, что и у `probe` с её `connect`.
Prober = Callable[[str, int], Awaitable[ProbeResult]]


async def _load_targets(
    session: AsyncSession,
    user_ids: Optional[Sequence[uuid.UUID]] = None,
) -> list[Target]:
    """Кого опрашиваем: серверы с владельцем.

    Строка без `user_id` пропускается ещё до опроса: уведомление по ней
    адресовать некому, и чей `sync_version` бампить — тоже неизвестно.

    `user_ids` сужает прогон до перечисленных владельцев; `None` — все, и
    именно так задачу зовёт расписание. Параметр существует ради тестов, и это
    не удобство, а защита: тестовая БД общая с dev-окружением, прогон по
    умолчанию берёт ВСЕ серверы, включая живые чужие, и уже случилось —
    сорвавшийся тест записал трём настоящим машинам «упал» и разослал
    уведомления. Ограничение выборки делает чужие строки недостижимыми
    структурно, а не по счастливому стечению поведения проверяемого кода.
    """
    stmt = select(Server.id, Server.ip_address, Server.ssh_port).where(
        Server.user_id.isnot(None)
    )
    if user_ids is not None:
        stmt = stmt.where(Server.user_id.in_(user_ids))
    rows = (await session.execute(stmt)).all()
    return [(row.id, row.ip_address, row.ssh_port) for row in rows]


async def _probe_all(
    targets: Sequence[Target],
    *,
    probe: Prober,
    concurrency: int,
) -> dict[int, Union[ProbeResult, BaseException]]:
    """Опросить все серверы веером шириной `concurrency`.

    Результат — словарь по id сервера, а не список: раздавать исходы по
    порядку прибытия корутин нельзя, иначе живой сервер получит чужую ошибку
    и уедет в «упал».

    `probe` по контракту не бросает, но контракт держится на перехватах внутри
    неё; `return_exceptions=True` — страховка на случай, если там появится
    непойманный путь.
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def _one(host: str, port: int) -> ProbeResult:
        async with semaphore:
            return await probe(host, port)

    results = await asyncio.gather(
        *(_one(host, port) for _server_id, host, port in targets),
        return_exceptions=True,
    )
    return {target[0]: result for target, result in zip(targets, results)}


async def _apply_results(
    session: AsyncSession,
    results: dict[int, Union[ProbeResult, BaseException]],
) -> dict[str, int]:
    """Записать исходы опроса — последовательно, по одному коммиту на сервер.

    Строка перечитывается заново: между опросом и записью прошли минуты, за
    которые сервер могли удалить или лишить владельца. Записать такому
    результат некуда и некому — он уходит в `failed`.

    `touch_entity_sync` зовётся ДО `apply_check_result`, и причина узкая.
    В обычном ходе дел порядок не важен: бамп после тоже уехал бы в БД, просто
    следующим `commit()`. Ломается всё на переходе, где `apply_check_result`
    коммитит внутри себя (через `create_notification`), а СРАЗУ ПОСЛЕ того
    коммита зовёт `dispatch_notification` — чужой вебхук и Telegram. Исходящий
    HTTP бросить может, и тогда управление уходит в `except` ниже: поля
    сервера уже закоммичены внутренним коммитом, а бамп, стоящий после,
    не случится уже никогда. Строка навсегда выпадет из
    `/sync/changes?since=` (выборка идёт по `sync_version > since`), и десктоп
    останется с «сервер жив» в локальном кэше — при том что в БД он «упал».
    Бамп до вызова попадает в тот же внутренний коммит, что и поля.

    Проверять «а изменилось ли что-нибудь» не нужно: `apply_check_result`
    всегда двигает `last_check_at`, то есть применённый результат — это всегда
    изменение.
    """
    stats = {"checked": 0, "down": 0, "up": 0, "failed": 0}
    applicable = {
        server_id: result
        for server_id, result in results.items()
        if not isinstance(result, BaseException)
    }
    stats["failed"] = len(results) - len(applicable)

    # Сервер берётся по одному, а не пачкой одним `select`, и это следствие
    # обработчика ниже: `rollback()` помечает протухшими ВСЕ объекты сессии, и
    # заранее вычитанная пачка после первого же сбоя посыпалась бы
    # `MissingGreenlet` на первом же обращении к полю. `get` попутно
    # перечитывает строку прямо перед записью — между фазами прошли минуты.
    for server_id in sorted(applicable):
        ok, error = applicable[server_id]
        try:
            server = await session.get(Server, server_id)
            if server is None or server.user_id is None:
                # Строку удалили или лишили владельца, пока шёл опрос:
                # записывать результат некуда и некому. Считаем в `failed` —
                # проверка не записана, и молча выпасть из статистики она не
                # должна: тогда `checked + failed` перестало бы сходиться с
                # числом опрошенных, и по журналу нельзя было бы понять, куда
                # делись серверы.
                stats["failed"] += 1
                continue
            await touch_entity_sync(session, server.user_id, server)
            transition = await server_monitor.apply_check_result(session, server, ok, error)
            await session.commit()
        except Exception:
            # Сбой записи по одному серверу (отказ БД, не дождавшаяся
            # блокировка) не должен унести остальных. Откат обязателен:
            # без него Postgres отвергнет в этой транзакции всё подряд
            # («current transaction is aborted»), и один сбой превратится в
            # отказ мониторинга для всех оставшихся серверов.
            await session.rollback()
            stats["failed"] += 1
            continue
        stats["checked"] += 1
        if transition is not None:
            stats[transition] += 1
    return stats


def _task_log(stats: dict[str, int]) -> TaskLog:
    """Итог прогона одной строкой журнала.

    Это всё, что человек увидит о прогоне, поэтому в тексте числа, а не факт
    запуска. `failed` — «результат проверки не записан»: сюда попадают и
    упавший опрос, и отказ БД на записи, и сервер, удалённый между фазами.
    Упоминается только когда он есть: в норме он нулевой.
    """
    log_text = (
        f"checked {stats['checked']} servers: "
        f"{stats['down']} down, {stats['up']} up"
    )
    if stats["failed"]:
        log_text += f", {stats['failed']} not checked"
    return TaskLog(
        entity_type="system",
        entity_id=None,
        task_type="server_monitor",
        status=TaskLogStatus.SUCCESS if not stats["failed"] else TaskLogStatus.PARTIAL,
        log_text=log_text,
        user_id=None,
    )


async def _monitor_servers(
    *,
    probe: Prober = server_monitor.probe,
    user_ids: Optional[Sequence[uuid.UUID]] = None,
) -> dict[str, int]:
    """Один прогон целиком: кого опрашивать → опрос веером → запись и журнал.

    Сессия под выборку своя и закрывается до опроса — держать её открытой
    через минуты сетевых ожиданий значило бы держать открытую транзакцию.

    `user_ids` сужает прогон до перечисленных владельцев (см. `_load_targets`);
    расписание зовёт без него, то есть по всем.
    """
    async with AsyncSessionLocal() as session:
        targets = await _load_targets(session, user_ids)

    results = await _probe_all(targets, probe=probe, concurrency=PROBE_CONCURRENCY)

    async with AsyncSessionLocal() as session:
        stats = await _apply_results(session, results)
        session.add(_task_log(stats))
        await session.commit()
    return stats


@celery_app.task(name="app.tasks.server_monitor.check_server_reachability")
def check_server_reachability() -> dict[str, int]:
    return asyncio.run(_monitor_servers())
