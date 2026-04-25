import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.cloudflare import (
    CloudflareAccountCreate,
    CloudflareAccountResponse,
    CloudflareTestResponse,
    CloudflareAccountUpdate,
    DnsRecordCreate,
    DnsRecordResponse,
    DnsRecordUpdate,
    NameserversResponse,
    PurgeResponse,
    ZoneResponse,
)
from app.services import cloudflare_service
from app.services.cloudflare_service import CloudflareError

router = APIRouter(prefix="/cloudflare", tags=["cloudflare"])
logger = logging.getLogger(__name__)


def _dns_record(data: dict) -> DnsRecordResponse:
    return DnsRecordResponse(
        id=data.get("id", ""),
        type=data.get("type", ""),
        name=data.get("name", ""),
        content=data.get("content", ""),
        ttl=int(data.get("ttl", 1)),
        proxied=bool(data.get("proxied", False)),
        zone_id=data.get("zone_id"),
    )


def _zone(data: dict) -> ZoneResponse:
    return ZoneResponse(
        id=data.get("id", ""),
        name=data.get("name", ""),
        status=data.get("status"),
        name_servers=data.get("name_servers") or [],
        original_name_servers=data.get("original_name_servers") or [],
        paused=data.get("paused"),
    )


@router.get("/accounts", response_model=list[CloudflareAccountResponse])
async def list_accounts(db: AsyncSession = Depends(get_db)):
    items = await cloudflare_service.list_accounts(db)
    return [cloudflare_service.build_account_response(a) for a in items]


@router.post(
    "/accounts",
    response_model=CloudflareAccountResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_account(
    data: CloudflareAccountCreate, db: AsyncSession = Depends(get_db)
):
    account = await cloudflare_service.create_account(db, data)
    sync_result = None
    sync_warning = None
    try:
        sync_result = await cloudflare_service.sync_zones_to_domains(db, account)
    except Exception as exc:
        await db.rollback()
        logger.exception("Cloudflare zone sync failed for account_id=%s", account.id)
        sync_warning = str(exc)
    return cloudflare_service.build_account_response(
        account, sync_result=sync_result, sync_warning=sync_warning
    )


@router.put("/accounts/{account_id}", response_model=CloudflareAccountResponse)
async def update_account(
    account_id: int,
    data: CloudflareAccountUpdate,
    db: AsyncSession = Depends(get_db),
):
    account = await cloudflare_service.update_account(db, account_id, data)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    return cloudflare_service.build_account_response(account)


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(account_id: int, db: AsyncSession = Depends(get_db)):
    ok = await cloudflare_service.delete_account(db, account_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")


@router.post("/accounts/{account_id}/test", response_model=CloudflareTestResponse)
async def test_account(account_id: int, db: AsyncSession = Depends(get_db)):
    account = await cloudflare_service.get_account(db, account_id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    try:
        verify = await cloudflare_service.verify_token(account)
        token_info = verify.get("result") or {}
        status_value = token_info.get("status")
        if status_value and status_value != "active":
            return CloudflareTestResponse(
                success=False,
                message=f"Token status is {status_value}",
            )
        return CloudflareTestResponse(
            success=True,
            message="Token verified",
            account_email=token_info.get("account", {}).get("email"),
        )
    except CloudflareError as exc:
        return CloudflareTestResponse(success=False, message=str(exc))


@router.get(
    "/accounts/{account_id}/zones", response_model=list[ZoneResponse]
)
async def list_zones(account_id: int, db: AsyncSession = Depends(get_db)):
    try:
        zones = await cloudflare_service.list_zones(db, account_id)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return [_zone(z) for z in zones]


@router.get(
    "/accounts/{account_id}/zones/{zone_id}/dns",
    response_model=list[DnsRecordResponse],
)
async def list_dns(
    account_id: int, zone_id: str, db: AsyncSession = Depends(get_db)
):
    try:
        records = await cloudflare_service.list_dns_records(db, account_id, zone_id)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return [_dns_record(r) for r in records]


@router.post(
    "/accounts/{account_id}/zones/{zone_id}/dns",
    response_model=DnsRecordResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_dns(
    account_id: int,
    zone_id: str,
    record: DnsRecordCreate,
    db: AsyncSession = Depends(get_db),
):
    try:
        created = await cloudflare_service.create_dns_record(db, account_id, zone_id, record)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return _dns_record(created)


@router.put(
    "/accounts/{account_id}/zones/{zone_id}/dns/{record_id}",
    response_model=DnsRecordResponse,
)
async def update_dns(
    account_id: int,
    zone_id: str,
    record_id: str,
    record: DnsRecordUpdate,
    db: AsyncSession = Depends(get_db),
):
    try:
        updated = await cloudflare_service.update_dns_record(
            db, account_id, zone_id, record_id, record
        )
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return _dns_record(updated)


@router.delete(
    "/accounts/{account_id}/zones/{zone_id}/dns/{record_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_dns(
    account_id: int,
    zone_id: str,
    record_id: str,
    db: AsyncSession = Depends(get_db),
):
    try:
        await cloudflare_service.delete_dns_record(db, account_id, zone_id, record_id)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))


@router.post(
    "/accounts/{account_id}/zones/{zone_id}/purge", response_model=PurgeResponse
)
async def purge(account_id: int, zone_id: str, db: AsyncSession = Depends(get_db)):
    try:
        await cloudflare_service.purge_cache(db, account_id, zone_id)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return PurgeResponse(success=True, message="Cache purged")


@router.get(
    "/accounts/{account_id}/zones/{zone_id}/nameservers",
    response_model=NameserversResponse,
)
async def nameservers(
    account_id: int, zone_id: str, db: AsyncSession = Depends(get_db)
):
    try:
        ns = await cloudflare_service.get_nameservers(db, account_id, zone_id)
    except CloudflareError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return NameserversResponse(zone_id=zone_id, name_servers=ns)
