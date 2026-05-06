import csv
import io
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.constants import DomainStatus
from app.core.database import get_db
from app.models.domain import Domain
from app.schemas.domain import (
    DomainBulkAssignCloudflare,
    DomainBulkAssignResponse,
    DomainBulkAssignServer,
    DomainBulkCreate,
    DomainBulkCreateResponse,
    DomainBulkImportResponse,
    DomainBulkStructuredCreate,
    DomainCreate,
    DomainResponse,
    DomainUpdate,
)
from app.services import domain_service
from app.services.bulk_import_service import get_errors_csv, process_bulk_import

router = APIRouter(prefix="/domains", tags=["domains"])


@router.get("", response_model=list[DomainResponse])
async def list_domains(
    server_id: Optional[int] = Query(None),
    registrar_id: Optional[int] = Query(None),
    cf_account_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    ns_status: Optional[str] = Query(None),
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> list[DomainResponse]:
    items = await domain_service.get_all(
        db,
        user_id=user.id,
        server_id=server_id,
        registrar_id=registrar_id,
        cf_account_id=cf_account_id,
        status=status,
        ns_status=ns_status,
    )
    return [DomainResponse.model_validate(d) for d in items]


@router.get("/{domain_id}", response_model=DomainResponse)
async def get_domain(
    domain_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainResponse:
    domain = await domain_service.get_by_id(db, domain_id, user.id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    return DomainResponse.model_validate(domain)


@router.post("", response_model=DomainResponse, status_code=status.HTTP_201_CREATED)
async def create_domain(
    data: DomainCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainResponse:
    domain = await domain_service.create(db, data, user.id)
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.create",
        target_type="domain",
        target_id=str(domain.id),
    )
    await db.commit()
    return DomainResponse.model_validate(domain)


@router.post(
    "/bulk",
    response_model=DomainBulkCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def bulk_create(
    data: DomainBulkCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkCreateResponse:
    created, skipped = await domain_service.bulk_create(
        db, user.id, data.domains_text, data.registrar_id
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
    data: DomainBulkStructuredCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkCreateResponse:
    created, skipped = await domain_service.bulk_create_structured(db, user.id, data.items)
    return DomainBulkCreateResponse(
        created=[DomainResponse.model_validate(d) for d in created],
        skipped=skipped,
    )


@router.put("/{domain_id}", response_model=DomainResponse)
async def update_domain(
    domain_id: int,
    data: DomainUpdate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainResponse:
    domain = await domain_service.update(db, domain_id, data, user.id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.update",
        target_type="domain",
        target_id=str(domain_id),
    )
    await db.commit()
    return DomainResponse.model_validate(domain)


@router.delete("/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_domain(
    domain_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    ok = await domain_service.delete(db, domain_id, user.id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.delete",
        target_type="domain",
        target_id=str(domain_id),
    )
    await db.commit()


@router.post("/bulk-assign-server", response_model=DomainBulkAssignResponse)
async def bulk_assign_server(
    data: DomainBulkAssignServer,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkAssignResponse:
    updated = await domain_service.bulk_assign_server(
        db, user.id, data.domain_ids, data.server_id
    )
    return DomainBulkAssignResponse(updated=updated)


@router.post("/bulk-assign-cloudflare", response_model=DomainBulkAssignResponse)
async def bulk_assign_cloudflare(
    data: DomainBulkAssignCloudflare,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkAssignResponse:
    updated = await domain_service.bulk_assign_cloudflare(
        db, user.id, data.domain_ids, data.cloudflare_account_id
    )
    return DomainBulkAssignResponse(updated=updated)


@router.get("/failed-export.csv")
async def export_failed_domains_csv(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    result = await db.execute(
        select(Domain)
        .where(Domain.user_id == user.id, Domain.status == DomainStatus.FAILED.value)
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


@router.post("/bulk-import", response_model=DomainBulkImportResponse)
async def bulk_import_domains(
    user: User = Depends(get_current_user_or_401),
    file: UploadFile = File(...),
    has_header: bool = Form(True),
    default_registrar_id: Optional[int] = Form(None),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkImportResponse:
    raw = await file.read()
    created, skipped, errors, csv_url = await process_bulk_import(
        db,
        user_id=user.id,
        filename=file.filename or "domains.csv",
        content=raw,
        has_header=has_header,
        default_registrar_id=default_registrar_id,
    )
    return DomainBulkImportResponse(
        created=created, skipped=skipped, errors=errors, errors_csv_url=csv_url
    )


@router.get("/bulk-import-errors/{token}")
async def bulk_import_errors_csv(token: str) -> StreamingResponse:
    csv_text = get_errors_csv(token)
    if csv_text is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Errors CSV not found")
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=bulk_import_errors.csv"},
    )
