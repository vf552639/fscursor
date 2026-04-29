from typing import Optional

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_domain, normalize_domain
from app.models.domain import Domain
from app.models.registrar_account import RegistrarAccount
from app.schemas.domain import DomainCreate, DomainUpdate, DomainBulkCreateItem


def _normalize(name: str) -> str:
    return normalize_domain(name)


async def get_all(
    db: AsyncSession,
    *,
    server_id: Optional[int] = None,
    registrar_id: Optional[int] = None,
    cf_account_id: Optional[int] = None,
    status: Optional[str] = None,
    ns_status: Optional[str] = None,
) -> list[Domain]:
    stmt = select(Domain).order_by(Domain.id.desc())
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


async def get_by_id(db: AsyncSession, domain_id: int) -> Optional[Domain]:
    return (
        await db.execute(select(Domain).where(Domain.id == domain_id))
    ).scalar_one_or_none()


async def get_by_name(db: AsyncSession, name: str) -> Optional[Domain]:
    return (
        await db.execute(select(Domain).where(Domain.domain_name == name))
    ).scalar_one_or_none()


async def _get_existing_domain_names(db: AsyncSession, names: list[str]) -> set[str]:
    if not names:
        return set()
    result = await db.execute(
        select(Domain.domain_name).where(Domain.domain_name.in_(names))
    )
    return set(result.scalars().all())


async def create(db: AsyncSession, data: DomainCreate) -> Domain:
    payload = data.model_dump()
    payload["domain_name"] = _normalize(payload["domain_name"])
    domain = Domain(**payload)
    db.add(domain)
    await db.commit()
    await db.refresh(domain)
    return domain


async def update(db: AsyncSession, domain_id: int, data: DomainUpdate) -> Optional[Domain]:
    domain = await get_by_id(db, domain_id)
    if not domain:
        return None
    patch = data.model_dump(exclude_unset=True)
    if "domain_name" in patch and patch["domain_name"]:
        patch["domain_name"] = _normalize(patch["domain_name"])
    for k, v in patch.items():
        setattr(domain, k, v)
    await db.commit()
    await db.refresh(domain)
    return domain


async def delete(db: AsyncSession, domain_id: int) -> bool:
    domain = await get_by_id(db, domain_id)
    if not domain:
        return False
    await db.delete(domain)
    await db.commit()
    return True


async def bulk_create(
    db: AsyncSession, domains_text: str, registrar_id: Optional[int] = None
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
        domain = Domain(domain_name=name, registrar_id=registrar_id)
        db.add(domain)
        created.append(domain)
    if created:
        await db.commit()
        for d in created:
            await db.refresh(d)
    return created, skipped


async def bulk_create_structured(
    db: AsyncSession, items: list[DomainBulkCreateItem]
) -> tuple[list[Domain], list[str]]:
    # 1. Fetch all registrars to avoid N+1
    result = await db.execute(select(RegistrarAccount))
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
        domain = Domain(domain_name=name, registrar_id=reg_id)
        db.add(domain)
        created.append(domain)

    if created:
        await db.commit()
        for d in created:
            await db.refresh(d)
    return created, skipped


async def bulk_assign_server(
    db: AsyncSession, domain_ids: list[int], server_id: Optional[int]
) -> int:
    if not domain_ids:
        return 0
    result = await db.execute(
        sa_update(Domain).where(Domain.id.in_(domain_ids)).values(server_id=server_id)
    )
    await db.commit()
    return result.rowcount or 0


async def bulk_assign_cloudflare(
    db: AsyncSession, domain_ids: list[int], cloudflare_account_id: Optional[int]
) -> int:
    if not domain_ids:
        return 0
    result = await db.execute(
        sa_update(Domain)
        .where(Domain.id.in_(domain_ids))
        .values(cloudflare_account_id=cloudflare_account_id)
    )
    await db.commit()
    return result.rowcount or 0


async def attach_cloudflare_to_existing(
    db: AsyncSession, domain_name: str, cf_account_id: int, zone_id: str
) -> Optional[Domain]:
    normalized = _normalize(domain_name)
    existing = await get_by_name(db, normalized)
    if not existing:
        return None
    existing.cloudflare_account_id = cf_account_id
    existing.cloudflare_zone_id = zone_id
    existing.cloudflare_enabled = True
    await db.flush()
    return existing
