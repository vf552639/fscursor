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

У этой изоляции есть вырожденный случай, и он однажды дорого обошёлся: когда
падают ВСЕ цели, «сбой не уносит прогон» превращается в «задача зелёная, хотя не
сделано ничего». Так неполный реестр моделей в воркере прожил незамеченным всё
время существования фичи. Поэтому прогон, не проверивший ни одной цели из
непустого списка, поднимает `ServerMonitorRunFailed` — разбор условия в
`_monitor_servers`.

**Журнал — по строке на владельца, а не одной общей.** Обе двери, за которыми
человек видит `task_logs`, фильтруют по владельцу: `GET /tasks` — условием
`user_id = :current_user`, `/sync/changes` — тем же полем. Общая строка с
`user_id = NULL` не видна поэтому никому: ни пользователю, ни оператору
(админского интерфейса к таблице в продукте нет). Прогон, честно
посчитавший «checked 12: 1 down», отчитывался бы в пустоту, а весь UI под
статус `partial` на странице Activity был бы мёртвым кодом по построению.
Статистика в строке — по серверам её адресата: «checked 12» имеет смысл
только про свои машины. Итог по всем владельцам сразу нужен не человеку в UI,
а оператору в момент разбора, и уходит он туда, где оператор и смотрит, — в
лог воркера (`logger.info` в `_monitor_servers`).

Выборку можно сузить до конкретных владельцев (`user_ids`). Расписание и
сигнал старта воркера зовут без сужения — им нужен весь парк; заведение нового
сервера, наоборот, сужает прогон до его владельца. Тот же параметр держит
изоляцию тестов, и почему это защита, а не удобство, — в `_load_targets`.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Sequence, Tuple, Union

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.celery_app import SERVER_REACHABILITY_TASK, celery_app
from app.core.constants import TaskLogStatus
from app.core.database import AsyncSessionLocal
from app.models.server import Server
from app.models.task_log import TaskLog
from app.services import server_monitor
from app.sync.service import touch_entity_sync

logger = logging.getLogger(__name__)

# Сколько серверов опрашиваем одновременно.
PROBE_CONCURRENCY = 20

# Сколько символов чужой ошибки уносим в `log_text`. Трейс уходит в stdout
# воркера через штатный логгер (`logger.exception` ниже), здесь нужен только
# опознавательный знак.
MAX_LOGGED_ERROR_LEN = 120

# `(id сервера, хост, порт, владелец)` — всё, что нужно опросу и адресации
# журнала. ORM-объекты в фазу опроса не едут: сессия к этому моменту уже
# закрыта. Владелец берётся здесь же, потому что журнал пишется по строке на
# владельца, а к моменту записи строки сервера может уже не быть.
Target = Tuple[int, str, int, uuid.UUID]
ProbeResult = Tuple[bool, Optional[str]]
# Сама проверка вынесена параметром: тесты подменяют её заглушкой и не
# открывают реальных сокетов — тот же приём, что и у `probe` с её `connect`.
Prober = Callable[[str, int], Awaitable[ProbeResult]]


class ServerMonitorRunFailed(RuntimeError):
    """Прогон не проверил ни одной цели — задача обязана покраснеть.

    Отдельный класс, а не голый `RuntimeError`, чтобы этот исход отличался в
    трейсбеках и в результате Celery от случайного сбоя внутри прогона: здесь
    ошибка не «что-то упало», а «упало всё», и различать их — половина смысла.
    Условие, при котором она поднимается, разобрано в `_monitor_servers`.
    """


async def _load_targets(
    session: AsyncSession,
    user_ids: Optional[Sequence[uuid.UUID]] = None,
) -> list[Target]:
    """Кого опрашиваем: серверы с владельцем.

    Строка без `user_id` пропускается ещё до опроса: уведомление по ней
    адресовать некому, и чей `sync_version` бампить — тоже неизвестно.

    `user_ids` сужает прогон до перечисленных владельцев; `None` — все, и
    именно так задачу зовут расписание и сигнал старта воркера. У параметра два
    смысла, и оба настоящие.

    Продуктовый: заведение сервера ставит немедленную проверку и сужает её до
    владельца новой строки. Чужой парк к этому событию отношения не имеет, а
    опрашивать его на каждое чужое добавление значило бы разменивать одну новую
    строку на сотни лишних сокетов и на драку за `sync_state` всех
    пользователей разом.

    Защитный: тестовая БД общая с dev-окружением, прогон по умолчанию берёт ВСЕ
    серверы, включая живые чужие, и уже случилось — сорвавшийся тест записал
    трём настоящим машинам «упал» и разослал уведомления. Ограничение выборки
    делает чужие строки недостижимыми структурно, а не по счастливому стечению
    поведения проверяемого кода.
    """
    stmt = select(Server.id, Server.ip_address, Server.ssh_port, Server.user_id).where(
        Server.user_id.isnot(None)
    )
    if user_ids is not None:
        stmt = stmt.where(Server.user_id.in_(user_ids))
    rows = (await session.execute(stmt)).all()
    return [(row.id, row.ip_address, row.ssh_port, row.user_id) for row in rows]


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

    outcomes = await asyncio.gather(
        *(_one(host, port) for _server_id, host, port, _owner in targets),
        return_exceptions=True,
    )
    server_ids = [server_id for server_id, _host, _port, _owner in targets]
    return dict(zip(server_ids, outcomes))


async def _safe_rollback(session: AsyncSession) -> None:
    """Откатить, не позволив самому откату унести прогон.

    `rollback()` ходит в БД и вполне может бросить — если сбой был обрывом
    соединения, то бросит именно он. Голый `rollback()` в обработчике отдал бы
    это исключение наружу мимо всех перехватов и унёс бы и остаток прогона, и
    запись `TaskLog`, то есть ровно тот инвариант, ради которого обработчик и
    написан.
    """
    try:
        await session.rollback()
    except Exception:
        logger.exception("server_monitor: откат транзакции не удался")


async def _check_landed(
    session: AsyncSession, server_id: int, attempted_at: datetime
) -> bool:
    """Доехала ли проверка до БД, несмотря на исключение.

    Вопрос не праздный: на переходе `create_notification` коммитит поля
    сервера и уведомление и только ПОСЛЕ этого зовёт доставку. Упавшая
    доставка выглядит для нас как сбой записи, хотя проверка записана —
    и записать её в «не проверено» значило бы соврать в журнале про ту самую
    строку, ради которой всё и затевалось.

    Признак — свежесть `last_check_at`: `apply_check_result` ставит туда
    момент проверки, и он новее, чем начало попытки.
    """
    try:
        landed_at = (
            await session.execute(
                select(Server.last_check_at).where(Server.id == server_id)
            )
        ).scalar_one_or_none()
    except Exception:
        logger.exception("server_monitor: не удалось проверить, записан ли сервер %s", server_id)
        return False
    return landed_at is not None and landed_at >= attempted_at


def _empty_stats() -> dict[str, int]:
    """Нулевые счётчики одного прогона — заводятся на каждого владельца."""
    return {"checked": 0, "down": 0, "up": 0, "undelivered": 0, "failed": 0}


def _totals(stats: dict[uuid.UUID, dict[str, int]]) -> dict[str, int]:
    """Сумма счётчиков по всем владельцам — итог прогона для оператора."""
    totals = _empty_stats()
    for owner_stats in stats.values():
        for key, value in owner_stats.items():
            totals[key] += value
    return totals


async def _apply_results(
    session: AsyncSession,
    results: dict[int, Union[ProbeResult, BaseException]],
    targets: Sequence[Target],
) -> Tuple[dict[uuid.UUID, dict[str, int]], dict[uuid.UUID, list[str]]]:
    """Записать исходы опроса — последовательно, по одному коммиту на сервер.

    Строка перечитывается заново: между опросом и записью прошли минуты, за
    которые сервер могли удалить, лишить владельца или переписать ему адрес.

    Смена адреса особенно коварна: в строке была опечатка в IP и один промах,
    пользователь чинит адрес прямо во время опроса — и устаревший `False`
    добирает второй промах подряд, объявляет живую машину упавшей, а в письме
    стоит НОВЫЙ адрес, которого никто не опрашивал. Поэтому результат сверяется
    с адресом перечитанной строки и при расхождении считается протухшим.

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

    Счётчики и ошибки — по владельцу, потому что журнал пишется по строке на
    владельца (см. шапку файла). Адресат берётся из `targets`, то есть тот, чьим
    сервер был на момент выборки, а не на момент записи: строки к этому времени
    может уже не быть (удалили, лишили владельца), а прогон затевался для того,
    кому она принадлежала, — и «checked + failed» сходится с числом опрошенных
    только при таком счёте. Поля же сервера пишутся, как и раньше, по
    перечитанной строке: журнал и данные отвечают на разные вопросы.
    """
    owner_of = {server_id: owner for server_id, _host, _port, owner in targets}
    # Заводится на КАЖДОГО владельца из выборки, а не по мере первой удачи:
    # прогон, у которого всё сломалось, обязан оставить своему человеку строку
    # именно об этом, а не промолчать.
    stats = {owner: _empty_stats() for owner in owner_of.values()}
    errors: dict[uuid.UUID, list[str]] = {owner: [] for owner in owner_of.values()}
    probed_address = {
        server_id: (server_monitor.clean_host(host), port)
        for server_id, host, port, _owner in targets
    }

    applicable: dict[int, ProbeResult] = {}
    for server_id, result in results.items():
        if isinstance(result, BaseException):
            # `probe` по контракту не бросает, так что сюда попадает баг, а не
            # штатный отказ сети. Одним числом в журнале такое не опознать —
            # нужен трейс.
            logger.error(
                "server_monitor: опрос сервера %s упал", server_id, exc_info=result
            )
            errors[owner_of[server_id]].append(_error_label(result))
            stats[owner_of[server_id]]["failed"] += 1
        else:
            applicable[server_id] = result

    # Порядок обработки задан явно и намеренно: он делает прогон
    # воспроизводимым (журнал и уведомления идут в одном и том же порядке от
    # запуска к запуску), а тест на изоляцию сбоев опирается на то, что
    # соседи «до» и «после» — это соседи по id.
    #
    # Сервер берётся по одному, а не пачкой одним `select`, и это следствие
    # обработчика ниже: `rollback()` помечает протухшими ВСЕ объекты сессии, и
    # заранее вычитанная пачка после первого же сбоя посыпалась бы
    # `MissingGreenlet` на первом же обращении к полю.
    for server_id in sorted(applicable):
        ok, error = applicable[server_id]
        # Счётчики этого сервера — счётчики его владельца по выборке (см.
        # разбор выше). Достаются один раз на итерацию: ниже к ним обращаются
        # из полудюжины мест, и вложенный `stats[owner_of[...]][...]` в каждом
        # читался бы хуже, чем считался.
        owner_stats = stats[owner_of[server_id]]
        attempted_at = datetime.now(timezone.utc)
        try:
            server = await session.get(Server, server_id)
            if server is None or server.user_id is None:
                # Строку удалили или лишили владельца, пока шёл опрос:
                # записывать результат некуда и некому. Считаем в `failed` —
                # молча выпасть из статистики она не должна, иначе
                # `checked + failed` перестанет сходиться с числом опрошенных
                # и по журналу будет не понять, куда делись серверы.
                owner_stats["failed"] += 1
                continue
            current_address = (server_monitor.clean_host(server.ip_address), server.ssh_port)
            if current_address != probed_address[server_id]:
                # Адрес переписали, пока шёл опрос: результат относится к
                # прежнему адресу и о нынешнем не говорит ничего.
                owner_stats["failed"] += 1
                continue

            await touch_entity_sync(session, server.user_id, server)
            transition = await server_monitor.apply_check_result(session, server, ok, error)
            await session.commit()

            owner_stats["checked"] += 1
            # Переходы разложены явно, а не через `owner_stats[transition]`: тот
            # молча связывал бы ключи статистики с `Literal`-значениями из
            # `server_monitor`, и переименование перехода дало бы `KeyError`
            # вместо промаха в одной строке.
            if transition == "down":
                owner_stats["down"] += 1
            elif transition == "up":
                owner_stats["up"] += 1
        except Exception as exc:
            # Сбой по одному серверу не должен унести остальных.
            logger.exception("server_monitor: сервер %s не обработан", server_id)
            errors[owner_of[server_id]].append(_error_label(exc))
            # Откат обязателен: без него Postgres отвергнет в этой транзакции
            # всё подряд («current transaction is aborted»), и один сбой
            # превратится в отказ мониторинга для всех оставшихся серверов.
            await _safe_rollback(session)
            if await _check_landed(session, server_id, attempted_at):
                # Проверка записана, сорвалось то, что после неё (почти всегда
                # — доставка уведомления). Считать такую строку «не
                # проверенной» нельзя: в БД она проверена.
                owner_stats["checked"] += 1
                owner_stats["undelivered"] += 1
            else:
                owner_stats["failed"] += 1

    return stats, errors


def _error_label(exc: BaseException) -> str:
    """Опознавательный знак ошибки для `log_text`; трейс — в stdout воркера."""
    return f"{type(exc).__name__}: {exc}"[:MAX_LOGGED_ERROR_LEN]


def _build_task_log(
    stats: dict[str, int], errors: Sequence[str] = (), *, user_id: uuid.UUID
) -> TaskLog:
    """Итог прогона по серверам ОДНОГО владельца — строкой его журнала.

    Это всё, что этот человек увидит о прогоне на странице Activity, поэтому в
    тексте числа, а не факт запуска, и числа — только про его машины. Адресат
    обязателен: строка без `user_id` не проходит ни через `GET /tasks`, ни
    через `/sync/changes` (оба фильтруют по владельцу), то есть не существует
    ни для кого — разбор в шапке файла.

    Три счётчика значат разное и потому не сливаются в один:

    * `checked` — результат проверки записан в БД;
    * `undelivered` — записан, но строку не удалось довести до конца (почти
      всегда упала доставка уведомления, уже после коммита проверки). Такие
      входят и в `checked`, но в разбивку по переходам не попадают: до
      возврата перехода дело не дошло, а сам переход виден в созданном
      уведомлении;
    * `failed` — результата в БД нет вовсе: упал опрос, отказала запись, или
      строка исчезла либо сменила адрес между фазами.

    Класс первой ошибки уносится в текст: прогон, написавший «200 not checked»
    без единого слова о причине, ничем не поможет — а трейсы к тому моменту
    лежат в stdout воркера вперемешку со всем остальным.
    """
    log_text = f"checked {stats['checked']} servers: {stats['down']} down, {stats['up']} up"
    if stats["undelivered"]:
        log_text += f", {stats['undelivered']} undelivered"
    if stats["failed"]:
        log_text += f", {stats['failed']} not checked"
    if errors:
        log_text += f" (first error: {errors[0]})"
    degraded = stats["failed"] or stats["undelivered"]
    return TaskLog(
        entity_type="system",
        entity_id=None,
        task_type="server_monitor",
        status=TaskLogStatus.PARTIAL if degraded else TaskLogStatus.SUCCESS,
        log_text=log_text,
        user_id=user_id,
    )


async def _write_task_logs(
    stats: dict[uuid.UUID, dict[str, int]],
    errors: dict[uuid.UUID, list[str]],
) -> None:
    """Записать журнал — по строке на каждого затронутого владельца.

    Сессия своя, отдельно от фазы записи. Та же означала бы, что журнал
    теряется ровно тогда, когда он нужнее всего: сессию мог убить обрыв
    соединения на середине фазы записи, и тогда прогон, не сумевший проверить
    ни одного сервера, не оставил бы о себе и следа.

    Кому строки не будет: тому, у кого серверов нет. Ключи `stats` приходят из
    выборки, и человека без машин там нет по построению — а «checked 0 servers:
    0 down, 0 up» четыре раза в сутки в пустом аккаунте это не журнал, а шум,
    ради которого страницу Activity перестают открывать.

    Коммит на строку, а не один на всех: строки независимы, и падение одной
    (владельца удалили между фазами — FK на `users`) не должно уносить журнал
    остальных.

    `touch_entity_sync` — потому что `task_logs` входит в `SCOPED_MODELS`
    синхронизации, а `/sync/changes?since=` выбирает по `sync_version > since`.
    Без бампа строка добралась бы только до веба, а десктоп увидел бы её лишь
    при полной пересинхронизации, то есть, возможно, никогда.
    """
    try:
        async with AsyncSessionLocal() as session:
            # Порядок фиксирован, чтобы прогон был воспроизводим — тот же довод,
            # что у сортировки серверов по id в фазе записи.
            for user_id in sorted(stats, key=str):
                try:
                    log = _build_task_log(stats[user_id], errors[user_id], user_id=user_id)
                    await touch_entity_sync(session, user_id, log)
                    session.add(log)
                    await session.commit()
                except Exception:
                    logger.exception(
                        "server_monitor: итог прогона не записан в журнал пользователя %s",
                        user_id,
                    )
                    await _safe_rollback(session)
    except Exception:
        logger.exception("server_monitor: журнал прогона не записан вовсе")


async def _monitor_servers(
    *,
    probe: Prober = server_monitor.probe,
    user_ids: Optional[Sequence[uuid.UUID]] = None,
) -> dict[str, int]:
    """Один прогон целиком: кого опрашивать → опрос веером → запись и журнал.

    Сессия под выборку своя и закрывается до опроса — держать её открытой
    через минуты сетевых ожиданий значило бы держать открытую транзакцию.

    `user_ids` сужает прогон до перечисленных владельцев (см. `_load_targets`);
    расписание и сигнал старта воркера зовут без него, то есть по всем.

    Возвращается итог по ВСЕМ владельцам разом — это ответ задачи Celery и
    предмет разбора для оператора, а не то, что видит человек в UI: ему
    адресованы отдельные строки журнала со своими числами.
    """
    async with AsyncSessionLocal() as session:
        targets = await _load_targets(session, user_ids)

    results = await _probe_all(targets, probe=probe, concurrency=PROBE_CONCURRENCY)

    async with AsyncSessionLocal() as session:
        stats, errors = await _apply_results(session, results, targets)

    await _write_task_logs(stats, errors)

    totals = _totals(stats)
    # Итог по всем владельцам сразу — вопрос оператора, а не пользователя.
    # Общей строкой в `task_logs` его писать некуда: `user_id = NULL` не
    # проходит ни один из двух фильтров чтения, а админского интерфейса к
    # таблице в продукте нет — такая строка была бы записью в никуда. Поэтому
    # итог идёт туда, куда оператор и смотрит: в лог воркера (он же — ответ
    # задачи в результате Celery, но за ним надо идти по id прогона).
    logger.info(
        "server_monitor: прогон по %s владельцам — %s",
        len(stats),
        ", ".join(f"{k} {v}" for k, v in totals.items()),
    )

    first_errors = [errs[0] for errs in errors.values() if errs]
    if targets and totals["checked"] == 0 and first_errors:
        # Прогон, у которого не выжила ни одна цель, — это провал задачи, а не
        # её успех, и молчать об этом нельзя.
        #
        # Цена молчания уже заплачена. Изоляция сбоев («один сервер не уносит
        # остальных») спроектирована верно, но у неё есть вырожденный случай:
        # когда падают ВСЕ, наверх всё равно уходит `succeeded`. Именно так
        # прожил незамеченным неполный реестр моделей в воркере — записи
        # валились с `NoReferencedTableError` на каждом из шести серверов,
        # задача светилась зелёным, и наружу не шло ни одного сигнала. Ошибки
        # были только в логах воркера, куда никто не смотрит, пока что-нибудь
        # не покраснеет. Это ровно «рисовать незнание здоровьем», только не на
        # экране сервера, а на уровне задачи.
        #
        # Условие узкое намеренно, чтобы не поднимать ложную тревогу:
        #
        # * `targets` непуст — пустой прогон (аккаунт без серверов) это штатное
        #   «нечего делать», а не отказ;
        # * `checked == 0` — в БД не доехало НИЧЕГО. Частичный провал уже виден
        #   человеку статусом `partial` в его строке журнала, и дублировать его
        #   красной задачей незачем;
        # * ошибка реально была. `failed` растёт и от безобидных гонок — строку
        #   удалили или ей сменили адрес, пока шёл опрос, — а там ронять нечего:
        #   система отработала правильно, просто записывать оказалось нечего.
        #   Исключения же в `errors` попадают только от настоящих сбоев.
        #
        # Журнал к этому моменту уже записан: человек увидит свою строку
        # («0 checked, N not checked») независимо от того, чем кончится задача.
        raise ServerMonitorRunFailed(
            f"ни одна из {len(targets)} целей не проверена; "
            f"первая ошибка — {first_errors[0]}"
        )

    return totals


@celery_app.task(name=SERVER_REACHABILITY_TASK)
def check_server_reachability(user_ids: Optional[Sequence[str]] = None) -> dict[str, int]:
    """Прогон мониторинга: по всему парку или по перечисленным владельцам.

    Владельцы приезжают **строками**, а не `uuid.UUID`, и это не небрежность:
    брокер настроен на `task_serializer="json"` (`core/celery_app.py`), а
    `UUID` в JSON не сериализуется — задача с таким аргументом не уехала бы в
    очередь вовсе, причём отказ случился бы на стороне того, кто ставит задачу.
    Обратная сторона в том, что строку нельзя отдать в `WHERE user_id IN (…)`
    как есть, поэтому разбор стоит прямо на входе.
    """
    owners = None if user_ids is None else [uuid.UUID(str(value)) for value in user_ids]
    return asyncio.run(_monitor_servers(user_ids=owners))
