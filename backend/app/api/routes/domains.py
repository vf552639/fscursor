import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.constants import DomainStatus
from app.models.domain import Domain
from app.models.task_log import TaskLog
from app.schemas.domain import (
    BulkSetNSRequest,
    BulkSetNSResponse,
    BulkProvisionRequest,
    BulkProvisionResponse,
    DomainFtpCredentials,
    DomainBulkAssignCloudflare,
    DomainBulkAssignResponse,
    DomainBulkAssignServer,
    DomainBulkCreate,
    DomainBulkCreateResponse,
    DomainBulkStructuredCreate,
    DomainCreate,
    DomainResponse,
    DomainUpdate,
    ProvisionResponse,
    SetNSResponse,
)
from app.services.encryption_service import decrypt
from app.services import domain_service
from app.tasks.ns_task import set_nameservers
from app.tasks.provision_task import provision_domain

router = APIRouter(prefix="/domains", tags=["domains"])


@router.get("", response_model=list[DomainResponse])
async def list_domains(
    server_id: Optional[int] = Query(None),
    registrar_id: Optional[int] = Query(None),
    cf_account_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    ns_status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
) -> list[DomainResponse]:
    items = await domain_service.get_all(
        db,
        server_id=server_id,
        registrar_id=registrar_id,
        cf_account_id=cf_account_id,
        status=status,
        ns_status=ns_status,
    )
    return [DomainResponse.model_validate(d) for d in items]


@router.get("/{domain_id}", response_model=DomainResponse)
async def get_domain(domain_id: int, db: AsyncSession = Depends(get_db)) -> DomainResponse:
    domain = await domain_service.get_by_id(db, domain_id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    return DomainResponse.model_validate(domain)


@router.post("", response_model=DomainResponse, status_code=status.HTTP_201_CREATED)
async def create_domain(
    data: DomainCreate, db: AsyncSession = Depends(get_db)
) -> DomainResponse:
    domain = await domain_service.create(db, data)
    return DomainResponse.model_validate(domain)


@router.post(
    "/bulk",
    response_model=DomainBulkCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bulk_create(
    data: DomainBulkCreate, db: AsyncSession = Depends(get_db)
) -> DomainBulkCreateResponse:
    created, skipped = await domain_service.bulk_create(
        db, data.domains_text, data.registrar_id
    )
    return DomainBulkCreateResponse(
        created=[DomainResponse.model_validate(d) for d in created],
        skipped=skipped,
    )


@router.post(
    "/bulk-structured",
    response_model=DomainBulkCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bulk_create_structured(
    data: DomainBulkStructuredCreate, db: AsyncSession = Depends(get_db)
) -> DomainBulkCreateResponse:
    created, skipped = await domain_service.bulk_create_structured(db, data.items)
    return DomainBulkCreateResponse(
        created=[DomainResponse.model_validate(d) for d in created],
        skipped=skipped,
    )


@router.put("/{domain_id}", response_model=DomainResponse)
async def update_domain(
    domain_id: int, data: DomainUpdate, db: AsyncSession = Depends(get_db)
) -> DomainResponse:
    domain = await domain_service.update(db, domain_id, data)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    return DomainResponse.model_validate(domain)


@router.delete("/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_domain(domain_id: int, db: AsyncSession = Depends(get_db)) -> None:
    ok = await domain_service.delete(db, domain_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")


@router.post("/bulk-assign-server", response_model=DomainBulkAssignResponse)
async def bulk_assign_server(
    data: DomainBulkAssignServer, db: AsyncSession = Depends(get_db)
) -> DomainBulkAssignResponse:
    updated = await domain_service.bulk_assign_server(db, data.domain_ids, data.server_id)
    return DomainBulkAssignResponse(updated=updated)


@router.post("/bulk-assign-cloudflare", response_model=DomainBulkAssignResponse)
async def bulk_assign_cloudflare(
    data: DomainBulkAssignCloudflare, db: AsyncSession = Depends(get_db)
) -> DomainBulkAssignResponse:
    updated = await domain_service.bulk_assign_cloudflare(
        db, data.domain_ids, data.cloudflare_account_id
    )
    return DomainBulkAssignResponse(updated=updated)


@router.post(
    "/{domain_id}/set-ns",
    response_model=SetNSResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def set_ns(domain_id: int, db: AsyncSession = Depends(get_db)) -> SetNSResponse:
    domain = await domain_service.get_by_id(db, domain_id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    result = set_nameservers.delay(domain_id)
    return SetNSResponse(task_id=result.id, domain_id=domain_id)


@router.post(
    "/bulk-set-ns",
    response_model=BulkSetNSResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def bulk_set_ns(data: BulkSetNSRequest) -> BulkSetNSResponse:
    task_ids = [set_nameservers.delay(did).id for did in data.domain_ids]
    return BulkSetNSResponse(task_ids=task_ids)


@router.post(
    "/{domain_id}/provision",
    response_model=ProvisionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def provision_single(
    domain_id: int, db: AsyncSession = Depends(get_db)
) -> ProvisionResponse:
    domain = await domain_service.get_by_id(db, domain_id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    if not domain.server_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Domain has no assigned server")
    task_log = TaskLog(
        entity_type="domain",
        entity_id=domain_id,
        task_type="provision_domain",
        status="pending",
        log_text="",
    )
    db.add(task_log)
    await db.commit()
    await db.refresh(task_log)
    async_result = provision_domain.delay(domain_id, task_log.id)
    return ProvisionResponse(
        task_id=async_result.id,
        task_log_id=task_log.id,
        domain_id=domain_id,
    )


@router.post(
    "/bulk-provision",
    response_model=BulkProvisionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def bulk_provision(
    data: BulkProvisionRequest, db: AsyncSession = Depends(get_db)
) -> BulkProvisionResponse:
    task_ids: list[str] = []
    for did in data.domain_ids:
        task_log = TaskLog(
            entity_type="domain",
            entity_id=did,
            task_type="provision_domain",
            status="pending",
            log_text="",
        )
        db.add(task_log)
        await db.flush()
        task_ids.append(provision_domain.delay(did, task_log.id).id)
    await db.commit()
    return BulkProvisionResponse(task_ids=task_ids)


@router.get("/{domain_id}/ftp-credentials", response_model=DomainFtpCredentials)
async def get_ftp_credentials(
    domain_id: int, db: AsyncSession = Depends(get_db)
) -> DomainFtpCredentials:
    domain = await domain_service.get_by_id(db, domain_id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    ftp_password = None
    if domain.ftp_password_encrypted:
        ftp_password = decrypt(domain.ftp_password_encrypted)
    return DomainFtpCredentials(
        domain_id=domain.id,
        ftp_user=domain.ftp_user,
        ftp_password=ftp_password,
    )


@router.get("/failed-export.csv")
async def export_failed_domains_csv(db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    result = await db.execute(
        select(Domain)
        .where(Domain.status == DomainStatus.FAILED.value)
        .order_by(Domain.updated_at.desc())
    )
    rows = result.scalars().all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["domain_name", "status", "last_provision_error", "updated_at"])
    for row in rows:
        writer.writerow(
            [
                row.domain_name,
                row.status,
                row.last_provision_error or "",
                row.updated_at.isoformat(),
            ]
        )
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=failed_domains.csv"},
    )
