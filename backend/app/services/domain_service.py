from datetime import datetime, timezone
from typing import Final, Optional
from uuid import UUID

from sqlalchemy import select, update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_domain, normalize_domain
from app.models.domain import Domain
from app.models.registrar_account import RegistrarAccount
from app.schemas.domain import (
    DomainBulkCreateItem,
    DomainCreate,
    DomainFactsIn,
    DomainUpdate,
    FullSetupDomain,
)
from app.sync.service import bump_version, touch_entity_sync


def _normalize(name: str) -> str:
    return normalize_domain(name)


# Всё, что домен знает про КОНКРЕТНУЮ машину, — обнулённое целиком. Это не
# свойства домена, а состояние сайта на сервере: домен переезжает, состояние
# остаётся там, и provision на новом сервере всё это перепишет заново.
#
# Список начинался с четырёх `fp_*` и был НЕПОЛНЫМ — на этом и поймали. Снимок
# по SSH гасился, а колонки provision переезд переживали и становились
# ЕДИНСТВЕННЫМ содержимым вкладки Server: «Host 10.0.0.9» (новая машина) рядом
# с «Login oldbox_usr» и кнопкой «Show FTP password» (старая машина), под
# подписью «на сервере не проверено» — хотя проверено оно было, просто на
# ДРУГОМ сервере. Ровно та беда, ради которой правило и заводилось. Поэтому
# граница здесь одна и проходит она не по происхождению колонки (SSH-снимок
# против записи provision), а по вопросу «это про домен или про машину?».
#
# Гасить `site_user` не гигиена, а исправность: десктоп читает эту колонку как
# `site_user_existing` и по ней решает, переиспользовать ли существующий сайт
# (`provision.rs`). Оставленная от старой машины, она заставила бы провижининг
# на новой целиться в сайт, которого там нет.
#
# Чего здесь НЕТ и почему:
#
# * `status` — жизненный цикл домена, а не машины, и колонка `NOT NULL`;
# * `nginx_override` / `nginx_presets` — это ВЫБОР ЧЕЛОВЕКА, а не наблюдение за
#   сервером: четыре флажка конфига и сниппет, которые пользователь задал сам, а
#   десктоп лишь разворачивает и ставит на машину (`fastpanel.rs`
#   `render_nginx_snippet`, `apply_nginx_override`). С новой машины их не
#   восстановить ничем, поэтому переезд их не касается;
# * `ns_status` / `ns_updated_at`, `cloudflare_*`, даты регистрации — про
#   регистратора и зону, к серверу отношения не имеют.
#
# `ssl_status` гасится в NULL, а не в дефолтное `SslStatus.NONE`: «none» — это
# утверждение «сертификата нет», которого мы про новую машину не делали, а NULL
# — «ничего не записано», что после переезда и есть правда (принцип №6).
# Рисуются оба одинаково («— No SSL», серый), и `Domain` во фронте уже объявляет
# колонку `string | null`.
#
# `php_handler` сегодня не пишет никто (колонка зарезервирована под будущий
# SQL-фильтр, см. `DomainResponse`), то есть его сброс — no-op. Он здесь
# нарочно: колонка про сайт на машине, и в день, когда её начнут заполнять из
# снимка, правило уже будет полным, а не отстанет на одну колонку.
_FORGOTTEN_ON_MOVE: Final[dict[str, None]] = {
    # Снимок, прочитанный десктопом по SSH (`apply_facts`). Обе отметки времени
    # и ошибка чтения — вместе со снимком: оставленные, они датировали бы
    # пустоту или показывали ошибку чтения с сервера, которого у домена нет.
    "fp_facts": None,
    "fp_facts_at": None,
    "fp_check_error": None,
    "fp_checked_at": None,
    # Сайт, заведённый provision на той машине.
    "site_user": None,
    "site_path": None,
    "php_version": None,
    "php_handler": None,
    # Учётка FTP того сайта — и ссылка на блоб с её паролем. Показанный после
    # переезда, этот пароль выглядит паролем новой машины, а открывает старую.
    "ftp_user": None,
    "ftp_password_blob_id": None,
    # База того сайта — и ссылка на блоб с паролем, по той же причине.
    "db_name": None,
    "db_user": None,
    "db_password_blob_id": None,
    # Сертификат живёт на машине: его выпускал certbot ТАМ, на новой его нет.
    "ssl_status": None,
    "ssl_expires_at": None,
    "ssl_issuer": None,
    "ssl_email_used": None,
    # Отчёт о ПРОШЛОЙ попытке на ПРЕЖНЕЙ машине: к новой привязке он не
    # относится ничем. Осознанное следствие: домен, стоявший в `failed`, до
    # следующего прогона покажет красный бейдж при пустой причине — состояние
    # некрасивое (`provision.rs` его прямо называет нежелательным) и здесь
    # выбрано меньшим злом. Приписать провал старой машины новой хуже, чем
    # временно не назвать причину; следующий прогон перепишет обе колонки разом.
    "last_provision_error": None,
}


async def get_all(
    db: AsyncSession,
    *,
    user_id: UUID,
    server_id: Optional[int] = None,
    registrar_id: Optional[int] = None,
    cf_account_id: Optional[int] = None,
    status: Optional[str] = None,
    ns_status: Optional[str] = None,
) -> list[Domain]:
    stmt = select(Domain).where(Domain.user_id == user_id).order_by(Domain.id.desc())
    if server_id is not None:
        stmt = stmt.where(Domain.server_id == server_id)
    if registrar_id is not None:
        stmt = stmt.where(Domain.registrar_id == registrar_id)
    if cf_account_id is not None:
        stmt = stmt.where(Domain.cloudflare_account_id == cf_account_id)
    if status is not None:
        stmt = stmt.where(Domain.status == status)
    if ns_status is not None:
        stmt = stmt.where(Domain.ns_status == ns_status)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_by_id(db: AsyncSession, domain_id: int, user_id: UUID) -> Optional[Domain]:
    domain = (
        await db.execute(select(Domain).where(Domain.id == domain_id))
    ).scalar_one_or_none()
    if domain is None or domain.user_id != user_id:
        return None
    return domain


async def get_by_name(db: AsyncSession, name: str, user_id: UUID) -> Optional[Domain]:
    return (
        await db.execute(
            select(Domain).where(Domain.domain_name == name, Domain.user_id == user_id)
        )
    ).scalar_one_or_none()


async def _get_existing_domain_names(db: AsyncSession, names: list[str]) -> set[str]:
    """Занятые имена — по ВСЕЙ таблице, а не по доменам этого пользователя.

    `domains.domain_name` уникален глобально (модель, миграция `001_initial`),
    поэтому сужение по `user_id` здесь было не безопасностью, а слепотой:
    имя, заведённое другим пользователем, пролетало мимо предпроверки прямо в
    `IntegrityError` на общем коммите — и валился ВЕСЬ пакет, включая уже
    подготовленные строки. Пропуск такого имени (`skipped` / «Duplicate or
    exists») говорит ровно то же, что и глобальный UNIQUE: имя занято. Кем —
    не говорит.
    """
    if not names:
        return set()
    result = await db.execute(
        select(Domain.domain_name).where(Domain.domain_name.in_(names))
    )
    return set(result.scalars().all())


class DomainNameTaken(Exception):
    """Имя домена уже занято.

    `existing_id` — id СВОЕЙ строки, если имя занято ею; `None`, если строка
    чужая. Разделение нужно маршруту: своему домену можно назвать id (он и так
    виден в списке), чужому — нельзя ничего, кроме факта занятости, который
    глобальный UNIQUE и без того делает наблюдаемым.
    """

    def __init__(self, existing_id: Optional[int] = None) -> None:
        super().__init__("domain name is taken")
        self.existing_id = existing_id


async def create(db: AsyncSession, data: DomainCreate, user_id: UUID) -> Domain:
    payload = data.model_dump()
    payload["domain_name"] = _normalize(payload["domain_name"])
    mine = await get_by_name(db, payload["domain_name"], user_id)
    if mine is not None:
        raise DomainNameTaken(existing_id=mine.id)

    domain = Domain(**payload, user_id=user_id)
    await touch_entity_sync(db, user_id, domain)
    db.add(domain)
    await _commit_unique_name(db)
    await db.refresh(domain)
    return domain


async def _commit_unique_name(db: AsyncSession) -> None:
    """Коммит записи имени: конфликт — `DomainNameTaken`, а не 500.

    Сюда приходит и чужой домен (UNIQUE глобальный, а предпроверки у
    вызывающих — свои), и гонка двух вкладок. Без этого перехвата и заведение,
    и переименование отвечали 500 на самом обычном сценарии — «домен уже
    заведён».
    """
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_unique_violation(exc):
            # `existing_id` здесь неизвестен, и на своей же строке (гонка двух
            # вкладок одного пользователя) текст выйдет как у чужой —
            # «занято» вместо «уже заведено». Идти за id ещё одним запросом
            # ради текста в гонке, которая длится миллисекунды, дороже, чем
            # эта неточность.
            raise DomainNameTaken() from exc
        # Прочие нарушения целостности (FK на несуществующую строку и т.п.) —
        # не про имя, и выдавать их за конфликт имени значило бы врать.
        raise


def _is_unique_violation(exc: IntegrityError) -> bool:
    """Нарушение UNIQUE, а не любая целостность.

    Разбор по `sqlstate` драйвера (`23505`), а не по тексту сообщения: текст
    зависит от локали сервера БД, код — нет.
    """
    return getattr(exc.orig, "sqlstate", None) == "23505"


async def update(
    db: AsyncSession, domain_id: int, data: DomainUpdate, user_id: UUID
) -> Optional[Domain]:
    domain = await get_by_id(db, domain_id, user_id)
    if not domain:
        return None
    patch = data.model_dump(exclude_unset=True)
    if patch.get("domain_name"):
        patch["domain_name"] = _normalize(patch["domain_name"])
        # Переименование в занятое имя — тот же конфликт, что и заведение.
        # Сравнение с `domain_id` обязательно: `PUT` с текущим именем — не
        # конфликт, а обычный no-op, и 409 на нём был бы дефектом.
        mine = await get_by_name(db, patch["domain_name"], user_id)
        if mine is not None and mine.id != domain_id:
            raise DomainNameTaken(existing_id=mine.id)
    # Переезд на другой сервер (в том числе отвязка) забывает всё, что домен
    # знал про старую машину, — общее правило всех писателей `server_id`,
    # разобранное в `_forget_state_of_previous_server`. Здесь оно исполняется
    # без отдельного UPDATE: объект уже прочитан, сравнить старое с новым дешевле
    # в Python, а `None` доедут до строки тем же циклом `setattr` ниже.
    #
    # Проверка `in patch`, а не `patch.get(...)`: `patch` собран с
    # `exclude_unset`, и «поле не прислали» отличается от «прислали null».
    # Спутав их, любая правка карточки (`{"site_user": ...}`) выглядела бы
    # отвязкой сервера и стирала бы состояние.
    #
    # ПРИ КОНФЛИКТЕ ПОБЕЖДАЕТ СБРОС, а не присланное клиентом, и проигравшую
    # сторону надо назвать прямо: `PUT {"server_id": X, "site_user": "u"}`
    # запишет `site_user = NULL`, молча уронив присланное «u». Десять колонок
    # сброса объявлены и в `DomainUpdate` (`site_user`, `site_path`, `ssl_*`,
    # `db_*`, оба `*_blob_id`, `last_provision_error`), так что тело такое
    # собрать можно. Выбор осознанный:
    #
    # * комбинированное тело семантически пусто по построению — прислать
    #   состояние сайта на машине, на которую домен только что переехал и где
    #   провижининг ещё не запускался, неоткуда;
    # * обратный порядок сделал бы гарантию условной: «после переезда карточка
    #   не показывает данные старой машины — если в том же запросе не прислали
    #   колонку». Такую гарантию нельзя ни сформулировать, ни проверить, а она
    #   тут ради того, чтобы чужие реквизиты не выглядели рабочими;
    # * реальных отправителей такого тела нет: `DomainWriteBack` десктопа поля
    #   `server_id` не имеет вовсе (`sync/http.rs`), а карточка шлёт смену
    #   сервера одна (`DomainServerField`). То есть сегодня правило ни у кого
    #   ничего не отнимает.
    #
    # Порядок держится `dict.update` — сброс кладётся ПОВЕРХ патча. Переставите
    # местами — выиграет клиент, и это будет другое решение, а не рефакторинг.
    if "server_id" in patch and patch["server_id"] != domain.server_id:
        patch.update(_FORGOTTEN_ON_MOVE)
    # Версия синхронизации — ДО правки полей, и это не косметика порядка.
    # `bump_version` внутри делает SELECT, а любой запрос по грязной сессии
    # запускает autoflush: с новым именем, уже проставленным в объект, конфликт
    # вылетал бы из `touch_entity_sync`, то есть мимо `_commit_unique_name`, и
    # переименование в занятое имя снова отвечало бы 500. Правило простое: между
    # правкой имени и коммитом запросов нет.
    await touch_entity_sync(db, user_id, domain)
    for k, v in patch.items():
        setattr(domain, k, v)
    await _commit_unique_name(db)
    await db.refresh(domain)
    return domain


async def apply_facts(
    db: AsyncSession, domain_id: int, data: DomainFactsIn, user_id: UUID
) -> Optional[Domain]:
    """Записать снимок состояния домена с сервера и отметить время попытки.

    Два времени держатся врозь намеренно — в этом весь смысл конструкции.
    `fp_checked_at` двигается ВСЕГДА: это «когда в последний раз пробовали
    прочитать». `fp_facts_at` двигается только на успехе: «когда в последний раз
    получилось». Провал (`data.error` задан) пишет ошибку и время попытки, но
    снимок (`fp_facts`/`fp_facts_at`) не трогает — иначе одна сетевая икота либо
    стёрла бы последний хороший снимок, либо выдала бы его недельную давность за
    свежесть (принцип №6 CLAUDE.md).

    Исход выбирается по наличию `error`, а не `facts`: непустой `error` — это
    неудача, что бы ни лежало рядом. Успех дополнительно ОБНУЛЯЕТ
    `fp_check_error`: иначе домен, однажды не ответивший, выглядел бы сломанным
    и после того, как чтение снова заработало.

    Время ставит сервер: у клиента оно означало бы «когда прочитали по мнению
    часов удалённой машины», а колонка нужна ради «насколько свежо то, что мы
    показываем». Схема `DomainFactsIn` полей времени не имеет вовсе.

    `touch_entity_sync` обязателен по той же причине, что и у `apply_metrics`:
    факты — пользовательские данные, которые десктоп добирает инкрементально по
    `sync_version > since`; без бампа read-only веб и второй десктоп остались бы
    с прочерком при полной колонке в БД.
    """
    domain = await get_by_id(db, domain_id, user_id)
    if not domain:
        return None

    now = datetime.now(timezone.utc)
    domain.fp_checked_at = now
    if data.error is not None:
        domain.fp_check_error = data.error
        # Снимок остаётся прежним — ни `fp_facts`, ни `fp_facts_at`.
    else:
        domain.fp_facts = data.facts
        domain.fp_facts_at = now
        domain.fp_check_error = None

    await touch_entity_sync(db, user_id, domain)
    await db.commit()
    await db.refresh(domain)
    return domain


async def delete(db: AsyncSession, domain_id: int, user_id: UUID) -> bool:
    domain = await get_by_id(db, domain_id, user_id)
    if not domain:
        return False
    await db.delete(domain)
    await db.commit()
    return True


async def bulk_create(
    db: AsyncSession,
    user_id: UUID,
    domains_text: str,
    registrar_id: Optional[int] = None,
    server_id: Optional[int] = None,
) -> tuple[list[Domain], list[str]]:
    names: list[str] = []
    seen: set[str] = set()
    for raw in domains_text.splitlines():
        n = _normalize(raw)
        if not n or n in seen:
            continue
        seen.add(n)
        names.append(n)

    created: list[Domain] = []
    skipped: list[str] = []
    existing_names = await _get_existing_domain_names(db, names)
    for name in names:
        if not is_valid_domain(name):
            skipped.append(name)
            continue
        if name in existing_names:
            skipped.append(name)
            continue
        domain = Domain(
            domain_name=name,
            registrar_id=registrar_id,
            server_id=server_id,
            user_id=user_id,
        )
        await touch_entity_sync(db, user_id, domain)
        db.add(domain)
        created.append(domain)
    if created:
        await db.commit()
        for d in created:
            await db.refresh(d)
    return created, skipped


async def bulk_create_structured(
    db: AsyncSession, user_id: UUID, items: list[DomainBulkCreateItem]
) -> tuple[list[Domain], list[str]]:
    result = await db.execute(
        select(RegistrarAccount).where(RegistrarAccount.user_id == user_id)
    )
    registrars = result.scalars().all()

    def find_reg_id(item: DomainBulkCreateItem) -> Optional[int]:
        if item.registrar_id:
            return item.registrar_id
        if item.registrar_name:
            q = item.registrar_name.lower()
            for r in registrars:
                if r.name.lower() == q or r.provider.lower() == q:
                    return r.id
        return None

    created: list[Domain] = []
    skipped: list[str] = []
    normalized_names = [_normalize(item.domain_name) for item in items]
    existing_names = await _get_existing_domain_names(db, normalized_names)

    for item in items:
        name = _normalize(item.domain_name)
        if not name or not is_valid_domain(name):
            skipped.append(item.domain_name)
            continue

        if name in existing_names:
            skipped.append(item.domain_name)
            continue

        reg_id = find_reg_id(item)
        # Сервер — только по id: имени, которое надо было бы резолвить, у
        # элемента нет (см. `DomainBulkCreateItem`).
        domain = Domain(
            domain_name=name,
            registrar_id=reg_id,
            server_id=item.server_id,
            user_id=user_id,
        )
        await touch_entity_sync(db, user_id, domain)
        db.add(domain)
        created.append(domain)

    if created:
        await db.commit()
        for d in created:
            await db.refresh(d)
    return created, skipped


async def _set_links(
    db: AsyncSession, user_id: UUID, domain_ids: list[int], values: dict[str, Optional[int]]
) -> int:
    """Проставить связки пачке доменов одним UPDATE. Без коммита.

    Коммит оставлен вызывающему: full-setup читает состояние доменов и пишет
    его в одной транзакции, и промежуточный коммит разорвал бы её пополам.
    Сужение по `user_id` — часть запроса, а не проверка снаружи: без него
    массовый UPDATE менял бы чужие строки по угаданному id.

    ОСТОРОЖНО: одна колонка тут с побочным обязательством. `server_id` в
    `values` — сначала `_forget_state_of_previous_server` по тем же id: всё, что
    домен знает про сайт (снимок по SSH, учётка FTP с паролем, база, сертификат,
    пути), снято со СТАРОЙ машины и переезд переживёт, оставив на вкладке Server
    FTP-логин прежнего сервера рядом с IP нового. Сеттер универсальный и сам за
    этим не следит, поэтому следующий писатель `server_id` прочитает про правило
    здесь — или не прочитает нигде.
    """
    ver = await bump_version(db, user_id)
    result = await db.execute(
        sa_update(Domain)
        .where(Domain.id.in_(domain_ids), Domain.user_id == user_id)
        .values(**values, sync_version=ver)
    )
    return result.rowcount or 0


async def _forget_state_of_previous_server(
    db: AsyncSession, user_id: UUID, domain_ids: list[int], server_id: Optional[int]
) -> None:
    """Забыть состояние старой машины у тех, кто переезжает. Без коммита.

    Смена `server_id` — это запись метаданных, а НЕ перенос сайта: файлы,
    пользователь FTP и база остаются на старой машине. Всё, что домен про них
    знает, оттуда же и снято, и оставленное на месте показывает вкладке Server
    FTP-логин прежнего сервера рядом с IP нового — реквизиты, которые выглядят
    рабочими и не работают ни там, ни там. Пустые колонки честнее: они говорят
    «состояние неизвестно», что после переезда и есть правда (принцип №6).

    Что именно гасится и, главное, что НЕ гасится (`status`, конфиг nginx) — в
    комментарии к `_FORGOTTEN_ON_MOVE`. Граница проходит по вопросу «это про
    домен или про машину?», и первая редакция этого правила её провела неверно:
    гасила снимок по SSH и оставляла колонки provision.

    Одна функция на всех писателей `server_id`, а не правило в каждом из них:
    три экрана про сервер в этом проекте уже разъезжались ровно так — правило
    жило в вызывающем, вызывающих стало трое, и один отстал. Писателей ровно
    три — `update`, `bulk_assign_server`, `bulk_full_setup`; заведение
    (`bulk_create`, `bulk_create_structured`) в этот список не входит и войти не
    может: у только что созданной строки состояния ещё нет.

    Сюда, впрочем, приходят двое из трёх: `update` работает по уже прочитанному
    объекту и дописывает те же `_FORGOTTEN_ON_MOVE` прямо в патч, чтобы не слать
    второй UPDATE ради одной строки (там же разобрано, почему при конфликте с
    присланным клиентом побеждает сброс). Общая у всех троих — константа, и
    именно она держит правило целым.

    Зовётся ДО присвоения нового `server_id`, пока в строках ещё старый: сузить
    по «сервер отличается» после записи было бы нечем.

    `IS DISTINCT FROM`, а не `!=`: у неразвёрнутого домена `server_id` — NULL, и
    `!=` на нём даёт NULL, то есть строка тихо выпала бы из UPDATE и увезла
    состояние с собой. Сужение здесь не оптимизация, а смысл: домен, УЖЕ стоящий
    на целевом сервере, никуда не едет и терять реквизиты не должен.

    Сужение по `user_id` — часть запроса, как в `_set_links`: без него массовый
    UPDATE тянулся бы к чужим строкам по угаданному id.

    Своего `bump_version` здесь нет намеренно. Оба вызывающих ставят её перед
    `_set_links` в той же транзакции, и каждая ОБНУЛЁННАЯ строка попадает и в
    его набор: раз `server_id` у неё отличается, она не в целевом состоянии.
    Версию синхронизации ей проставляет он.
    Второй бамп сжёг бы номер и не добавил бы ничего. Правило запёрто тестом:
    `sync_version` переехавшего домена обязан вырасти.
    """
    if not domain_ids:
        return
    await db.execute(
        sa_update(Domain)
        .where(
            Domain.id.in_(domain_ids),
            Domain.user_id == user_id,
            Domain.server_id.is_distinct_from(server_id),
        )
        .values(**_FORGOTTEN_ON_MOVE)
    )


async def bulk_assign_server(
    db: AsyncSession, user_id: UUID, domain_ids: list[int], server_id: Optional[int]
) -> int:
    if not domain_ids:
        return 0
    await _forget_state_of_previous_server(db, user_id, domain_ids, server_id)
    # Счётчик считает `_set_links`, а он, в отличие от сброса, не сужен по «а
    # менялось ли»: `updated` означает «сколько строк тронули», как и раньше.
    updated = await _set_links(db, user_id, domain_ids, {"server_id": server_id})
    await db.commit()
    return updated


async def bulk_assign_cloudflare(
    db: AsyncSession,
    user_id: UUID,
    domain_ids: list[int],
    cloudflare_account_id: Optional[int],
) -> int:
    if not domain_ids:
        return 0
    updated = await _set_links(
        db, user_id, domain_ids, {"cloudflare_account_id": cloudflare_account_id}
    )
    await db.commit()
    return updated


async def bulk_full_setup(
    db: AsyncSession,
    user_id: UUID,
    domain_ids: list[int],
    *,
    server_id: int,
    cloudflare_account_id: int,
    registrar_id: Optional[int] = None,
) -> tuple[list[FullSetupDomain], list[int]]:
    """Связки full-setup пачке доменов. Возвращает (обработанные, пропущенные).

    Без коммита — его делает маршрут, вместе с записью аудита: чтение
    состояния, UPDATE и аудит обязаны быть одной транзакцией.

    Идемпотентность здесь конструкцией, а не журналом ключей. Повторный вызов
    с теми же аргументами не трогает НИ ОДНОГО домена: строки, уже стоящие в
    целевом состоянии, из UPDATE выпадают, поэтому не двигается ни
    `sync_version`, ни `updated_at`, а ответ выходит тот же. (Запись в аудит
    маршрут при этом делает и на повторе — так и надо: аудит фиксирует
    попытку, а не изменение строки.) Журнал ключей (как у `provision_bulk`)
    здесь и не нужен: там ключ сторожит долгую внешнюю работу по SSH, здесь —
    присваивание трёх колонок, повтор которого по определению даёт то же
    состояние.

    Речь именно о ПОВТОРЕ — тех же аргументах. Два одновременных прогона с
    РАЗНЫМИ связками по одному домену этим не упорядочиваются: побеждает
    последний UPDATE, а «связано» будет сказано обоим. Журнал ключей такого
    тоже не ловит (ключи-то разные); ловит блокировка строки, и заводить её
    здесь незачем — конкурирующий прогон означает, что человек в двух окнах
    сам выбрал разные цели.

    Отсутствующий (или чужой) id — строка отчёта, а не отказ всей пачки. Пачка
    приходит из выделения на экране, и домен, удалённый в другой вкладке между
    открытием списка и нажатием кнопки, — обычная гонка, а не повод не связать
    остальные 199. Владение чужой строкой при этом не раскрывается: «нет у
    тебя» и «нет вообще» неотличимы.

    Читаем колонками, а не ORM-объектами, намеренно: маршрут строит ответ уже
    ПОСЛЕ `commit()`, а ORM-объекты к тому моменту протухают, и обращение к их
    полям в async-сессии — не лишний SELECT, а исключение.
    """
    values: dict[str, Optional[int]] = {
        "server_id": server_id,
        "cloudflare_account_id": cloudflare_account_id,
    }
    if registrar_id is not None:
        values["registrar_id"] = registrar_id

    # Колонки состояния берутся из ключей `values`, а не перечисляются рядом:
    # ниже по ним же идёт сравнение через `getattr`, и разъехавшись, эти два
    # списка дали бы `AttributeError` на ровном месте.
    rows = (
        await db.execute(
            select(Domain.id, Domain.domain_name, *(getattr(Domain, k) for k in values))
            .where(Domain.id.in_(domain_ids), Domain.user_id == user_id)
            .order_by(Domain.id)
        )
    ).all()

    found = {row.id for row in rows}
    # `dict.fromkeys` — дедупликация с сохранением порядка запроса: дубль id в
    # теле не должен давать дубль строки в отчёте.
    skipped = [d for d in dict.fromkeys(domain_ids) if d not in found]

    outdated = [
        row.id for row in rows if any(getattr(row, k) != v for k, v in values.items())
    ]
    # ДО `_set_links` — пока в строках ещё старый сервер. Кто из них едет, а
    # кто уже стоит на целевом, решает сама функция, и решает в SQL: вывести
    # тот же предикат здесь заново значило бы завести ему вторую редакцию —
    # ровно то, ради чего правило и вынесено в одну функцию.
    await _forget_state_of_previous_server(
        db, user_id, [row.id for row in rows], server_id
    )
    if outdated:
        await _set_links(db, user_id, outdated, values)

    return [FullSetupDomain(id=row.id, domain_name=row.domain_name) for row in rows], skipped
