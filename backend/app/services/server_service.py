from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import FastPanelStatus, ServerStatus
from app.models.server import Server
from app.schemas.server import ServerCreate, ServerMetricsIn, ServerUpdate
from app.sync.service import touch_entity_sync


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


async def create(db: AsyncSession, data: ServerCreate, user_id: UUID) -> Server:
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
