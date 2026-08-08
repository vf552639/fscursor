import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import FastPanelStatus, ServerStatus
from app.models.server import Server
from app.schemas.server import ServerCreate, ServerMetricsIn, ServerUpdate
from app.sync.service import touch_entity_sync
from app.tasks.server_monitor_task import check_server_reachability

logger = logging.getLogger(__name__)


async def get_all(db: AsyncSession, user_id: UUID) -> tuple[list[Server], int]:
    result = await db.execute(
        select(Server).where(Server.user_id == user_id).order_by(Server.id.desc())
    )
    items = list(result.scalars().all())
    total = (
        await db.execute(select(func.count(Server.id)).where(Server.user_id == user_id))
    ).scalar_one()
    return items, int(total)


async def get_by_id(db: AsyncSession, server_id: int, user_id: UUID) -> Optional[Server]:
    server = (await db.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
    if server is None or server.user_id != user_id:
        return None
    return server


def _publish_reachability_check(user_id: UUID) -> None:
    """Опубликовать задачу мониторинга — так, чтобы её провал никого не задел.

    `retry=False` отключает штатный `task_publish_retry` (по умолчанию три
    попытки): здесь публикация — удобство, и растягивать её отказ на несколько
    таймаутов подключения к брокеру не за что. Верхняя граница ожидания
    остаётся за `broker_connection_timeout` — одна попытка, а не три.

    Исключение наружу не выпускается вовсе. Постановка проверки не входит в
    контракт создания сервера: с мёртвым Redis сервер обязан создаться и
    вернуть 201, а статуса человек дождётся на ближайшем прогоне по расписанию.
    Но и молчать нельзя — иначе «мониторинг не сработал» никак не отличить от
    «брокер лежит вторые сутки», поэтому провал уходит в лог предупреждением с
    трейсом.
    """
    try:
        check_server_reachability.apply_async(
            kwargs={"user_ids": [str(user_id)]},
            retry=False,
        )
    except Exception:
        logger.warning(
            "server_service: немедленная проверка серверов владельца %s не поставлена "
            "в очередь — статус появится на ближайшем прогоне по расписанию",
            user_id,
            exc_info=True,
        )


async def enqueue_reachability_check(user_id: UUID) -> None:
    """Поставить немедленную проверку доступности серверов этого владельца.

    Зачем вообще: расписание бьёт по слотам 00/06/12/18 UTC, и сервер, заведённый
    в 06:05, до полудня стоял бы с `unchecked` и «Last check: never». Проверка
    занимает секунды — держать в незнании шесть часов незачем.

    Прогон сужен до владельца новой строки. Задача по умолчанию берёт ВСЕ
    серверы всех пользователей, и чужой парк к чужому событию отношения не
    имеет (разбор — в `_load_targets`); заодно это единственное, что делает
    вызов безопасным в общей с dev-окружением базе.

    Публикация уезжает в поток, потому что kombu пишет в брокер синхронно.
    Прямой вызов из корутины на мёртвом Redis подвесил бы весь event loop на
    таймаут подключения — то есть один недоступный брокер тормозил бы не запрос
    создания сервера, а вообще все запросы процесса.
    """
    await asyncio.to_thread(_publish_reachability_check, user_id)


async def create(
    db: AsyncSession, data: ServerCreate, user_id: UUID, *, check_now: bool = True
) -> Server:
    """Завести сервер и (по умолчанию) сразу поставить ему проверку доступности.

    `check_now=False` нужен пакетному импорту: он зовёт `create` в цикле, и
    задача на каждую строку означала бы сотню прогонов по одному и тому же
    парку — сотню лишних вееров сокетов и сотню претендентов на `FOR UPDATE`
    по одной строке `sync_state`. Импорт ставит одну проверку на всю пачку сам.
    """
    payload = data.model_dump(
        exclude={"ssh_password_blob_id", "fastpanel_password_blob_id"},
    )
    server = Server(**payload, user_id=user_id)
    if data.fastpanel_status == FastPanelStatus.INSTALLED.value:
        server.status = ServerStatus.ACTIVE.value
    server.ssh_password_blob_id = data.ssh_password_blob_id
    server.fastpanel_password_blob_id = data.fastpanel_password_blob_id
    await touch_entity_sync(db, user_id, server)
    db.add(server)
    await db.commit()
    await db.refresh(server)
    # Строго после коммита: задача читает сервер из своей сессии и не увидела
    # бы его, встань она в очередь раньше, — быстрый воркер успел бы отработать
    # по ещё не существующей строке.
    if check_now:
        await enqueue_reachability_check(user_id)
    return server


async def update(
    db: AsyncSession, server_id: int, data: ServerUpdate, user_id: UUID
) -> Optional[Server]:
    server = await get_by_id(db, server_id, user_id)
    if not server:
        return None

    patch = data.model_dump(
        exclude_unset=True,
        exclude={"ssh_password_blob_id", "fastpanel_password_blob_id"},
    )
    for k, v in patch.items():
        setattr(server, k, v)

    if data.ssh_password_blob_id is not None:
        server.ssh_password_blob_id = data.ssh_password_blob_id
    if data.fastpanel_password_blob_id is not None:
        server.fastpanel_password_blob_id = data.fastpanel_password_blob_id

    await touch_entity_sync(db, user_id, server)
    await db.commit()
    await db.refresh(server)
    return server


async def apply_metrics(
    db: AsyncSession, server_id: int, data: ServerMetricsIn, user_id: UUID
) -> Optional[Server]:
    """Записать снимок метрик, снятый десктопом, и отметить время приёма.

    `metrics_collected_at` означает **«когда сервер в последний раз принял
    показания»**, а не «когда снято каждое поле по отдельности». Разница
    существенна, и вся конструкция ниже — про то, как их удержать вместе.

    **Контракт сборщика: снимок присылается целиком.** `runCollectMetrics` в
    десктопе (фаза 8) шлёт все поля разом, а то, что парсер не разобрал,
    передаёт явным `null` — «не смогли снять» не должно выглядеть как «0%».
    При соблюдении контракта отметка и все показания относятся к одному
    моменту, и вопрос «а это число какой давности?» не возникает.

    `exclude_unset` разводит две разные вещи (тот же приём и по тем же мотивам
    описан в `tests/test_provision_writeback.py`):

    * **явный `null` затирает.** Иначе прошлое значение осталось бы лежать под
      свежей отметкой: карточка сказала бы «снято минуту назад: диск 190 ГБ»,
      где число недельной давности. Протухшая цифра хуже прочерка — она
      выглядит правдой;
    * **неприсланное поле не трогается.** Это узкий законный случай —
      дозапись одного показания, а не снимок: например, версия панели,
      известная сразу после её установки, когда остального никто не мерил.
      Стирать при этом память и диск было бы хуже, чем их сохранить.

    Честная цена второго случая: после частичного тела отметка относится к
    последнему приёму, а несколько полей под ней — старше её. Ответственность
    за это на клиенте, и потому граница проведена там, где смысла не остаётся
    совсем: тело без единого поля не дозаписывает ничего и только омолаживает
    прошлый снимок — его отвергает схема (`ServerMetricsIn`), 422.

    Время ставит сервер: у клиента оно означало бы «когда сняли по мнению часов
    удалённой машины», а колонка нужна ради «насколько свежее то, что мы
    показываем».

    `touch_entity_sync` обязателен. Метрики — пользовательские данные, которые
    десктоп держит в локальном SQLCipher-кэше и добирает через
    `GET /sync/changes?since=` по условию `sync_version > since`. Без бампа
    строка в инкрементальную выдачу не попадёт, и второй десктоп (как и первый
    после перезапуска) будет показывать прочерки при полной колонке в БД.
    """
    server = await get_by_id(db, server_id, user_id)
    if not server:
        return None

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(server, field, value)
    server.metrics_collected_at = datetime.now(timezone.utc)

    await touch_entity_sync(db, user_id, server)
    await db.commit()
    await db.refresh(server)
    return server


async def delete(db: AsyncSession, server_id: int, user_id: UUID) -> bool:
    server = await get_by_id(db, server_id, user_id)
    if not server:
        return False
    await db.delete(server)
    await db.commit()
    return True
