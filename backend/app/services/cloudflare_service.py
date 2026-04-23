from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloudflare_account import CloudflareAccount
from app.schemas.cloudflare import (
    CloudflareAccountCreate,
    CloudflareAccountUpdate,
    DnsRecordCreate,
    DnsRecordUpdate,
)
from app.services.encryption_service import decrypt, encrypt

CF_API = "https://api.cloudflare.com/client/v4"


class CloudflareError(Exception):
    pass


async def _get_account(db: AsyncSession, account_id: int) -> Optional[CloudflareAccount]:
    return (
        await db.execute(
            select(CloudflareAccount).where(CloudflareAccount.id == account_id)
        )
    ).scalar_one_or_none()


async def _call(
    account: CloudflareAccount,
    method: str,
    path: str,
    *,
    params: Optional[dict] = None,
    json: Optional[dict] = None,
) -> dict[str, Any]:
    if not account.api_token_encrypted:
        raise CloudflareError("API token is not set")
    token = decrypt(account.api_token_encrypted)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(base_url=CF_API, timeout=30.0) as client:
            resp = await client.request(method, path, params=params, json=json, headers=headers)
    finally:
        token = None  # type: ignore[assignment]
    data = resp.json() if resp.content else {}
    if resp.status_code >= 400 or not data.get("success", True):
        errors = data.get("errors") or [{"message": resp.text}]
        raise CloudflareError(f"CF API error: {errors}")
    return data


async def list_accounts(db: AsyncSession) -> list[CloudflareAccount]:
    result = await db.execute(select(CloudflareAccount).order_by(CloudflareAccount.id.desc()))
    return list(result.scalars().all())


async def get_account(db: AsyncSession, account_id: int) -> Optional[CloudflareAccount]:
    return await _get_account(db, account_id)


async def create_account(db: AsyncSession, data: CloudflareAccountCreate) -> CloudflareAccount:
    account = CloudflareAccount(
        name=data.name,
        account_id=data.account_id,
        api_token_encrypted=encrypt(data.api_token),
        is_active=data.is_active,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def update_account(
    db: AsyncSession, account_id: int, data: CloudflareAccountUpdate
) -> Optional[CloudflareAccount]:
    account = await _get_account(db, account_id)
    if not account:
        return None
    patch = data.model_dump(exclude_unset=True, exclude={"api_token"})
    for k, v in patch.items():
        setattr(account, k, v)
    if data.api_token is not None:
        account.api_token_encrypted = encrypt(data.api_token)
    await db.commit()
    await db.refresh(account)
    return account


async def delete_account(db: AsyncSession, account_id: int) -> bool:
    account = await _get_account(db, account_id)
    if not account:
        return False
    await db.delete(account)
    await db.commit()
    return True


async def list_zones(db: AsyncSession, account_id: int) -> list[dict]:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    data = await _call(account, "GET", "/zones", params={"per_page": 50})
    return data.get("result") or []


async def get_zone(db: AsyncSession, account_id: int, zone_id: str) -> dict:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    data = await _call(account, "GET", f"/zones/{zone_id}")
    return data.get("result") or {}


async def list_dns_records(
    db: AsyncSession, account_id: int, zone_id: str
) -> list[dict]:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    data = await _call(
        account, "GET", f"/zones/{zone_id}/dns_records", params={"per_page": 100}
    )
    return data.get("result") or []


async def create_dns_record(
    db: AsyncSession, account_id: int, zone_id: str, record: DnsRecordCreate
) -> dict:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    payload = record.model_dump(exclude_none=True)
    data = await _call(account, "POST", f"/zones/{zone_id}/dns_records", json=payload)
    return data.get("result") or {}


async def update_dns_record(
    db: AsyncSession,
    account_id: int,
    zone_id: str,
    record_id: str,
    record: DnsRecordUpdate,
) -> dict:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    payload = record.model_dump(exclude_unset=True, exclude_none=True)
    data = await _call(
        account, "PATCH", f"/zones/{zone_id}/dns_records/{record_id}", json=payload
    )
    return data.get("result") or {}


async def delete_dns_record(
    db: AsyncSession, account_id: int, zone_id: str, record_id: str
) -> bool:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    await _call(account, "DELETE", f"/zones/{zone_id}/dns_records/{record_id}")
    return True


async def purge_cache(db: AsyncSession, account_id: int, zone_id: str) -> bool:
    account = await _get_account(db, account_id)
    if not account:
        raise CloudflareError("Account not found")
    await _call(
        account,
        "POST",
        f"/zones/{zone_id}/purge_cache",
        json={"purge_everything": True},
    )
    return True


async def get_nameservers(db: AsyncSession, account_id: int, zone_id: str) -> list[str]:
    zone = await get_zone(db, account_id, zone_id)
    return zone.get("name_servers") or []
