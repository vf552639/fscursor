from typing import Optional
from uuid import UUID

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_domain, normalize_domain
from app.models.domain import Domain
from app.models.registrar_account import RegistrarAccount
from app.schemas.domain import (
    DomainBulkCreateItem,
    DomainCreate,
    DomainUpdate,
    FullSetupDomain,
)
from app.sync.service import bump_version, touch_entity_sync


def _normalize(name: str) -> str:
    return normalize_domain(name)


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


async def _get_existing_domain_names(
    db: AsyncSession, user_id: UUID, names: list[str]
) -> set[str]:
    if not names:
        return set()
    result = await db.execute(
        select(Domain.domain_name).where(
            Domain.domain_name.in_(names), Domain.user_id == user_id
        )
    )
    return set(result.scalars().all())


async def create(db: AsyncSession, data: DomainCreate, user_id: UUID) -> Domain:
    payload = data.model_dump()
    payload["domain_name"] = _normalize(payload["domain_name"])
    domain = Domain(**payload, user_id=user_id)
    await touch_entity_sync(db, user_id, domain)
    db.add(domain)
    await db.commit()
    await db.refresh(domain)
    return domain


async def update(
    db: AsyncSession, domain_id: int, data: DomainUpdate, user_id: UUID
) -> Optional[Domain]:
    domain = await get_by_id(db, domain_id, user_id)
    if not domain:
        return None
    patch = data.model_dump(exclude_unset=True)
    if "domain_name" in patch and patch["domain_name"]:
        patch["domain_name"] = _normalize(patch["domain_name"])
    for k, v in patch.items():
        setattr(domain, k, v)
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
    existing_names = await _get_existing_domain_names(db, user_id, names)
    for name in names:
        if not is_valid_domain(name):
            skipped.append(name)
            continue
        if name in existing_names:
            skipped.append(name)
            continue
        domain = Domain(domain_name=name, registrar_id=registrar_id, user_id=user_id)
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
    existing_names = await _get_existing_domain_names(db, user_id, normalized_names)

    for item in items:
        name = _normalize(item.domain_name)
        if not name or not is_valid_domain(name):
            skipped.append(item.domain_name)
            continue

        if name in existing_names:
            skipped.append(item.domain_name)
            continue

        reg_id = find_reg_id(item)
        domain = Domain(domain_name=name, registrar_id=reg_id, user_id=user_id)
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
    """
    ver = await bump_version(db, user_id)
    result = await db.execute(
        sa_update(Domain)
        .where(Domain.id.in_(domain_ids), Domain.user_id == user_id)
        .values(**values, sync_version=ver)
    )
    return result.rowcount or 0


async def bulk_assign_server(
    db: AsyncSession, user_id: UUID, domain_ids: list[int], server_id: Optional[int]
) -> int:
    if not domain_ids:
        return 0
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
    с теми же аргументами не пишет НИЧЕГО: строки, уже стоящие в целевом
    состоянии, из UPDATE выпадают, поэтому не двигается ни `sync_version`, ни
    `updated_at`, а ответ выходит тот же. Журнал ключей (как у `provision_bulk`)
    здесь и не нужен: там ключ сторожит долгую внешнюю работу по SSH, здесь —
    присваивание трёх колонок, повтор которого по определению даёт то же
    состояние.

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

    rows = (
        await db.execute(
            select(
                Domain.id,
                Domain.domain_name,
                Domain.server_id,
                Domain.cloudflare_account_id,
                Domain.registrar_id,
            )
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
    if outdated:
        await _set_links(db, user_id, outdated, values)

    return [FullSetupDomain(id=row.id, domain_name=row.domain_name) for row in rows], skipped
