from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db
from app.schemas.server import (
    ServerBulkImportResponse,
    ServerCreate,
    ServerListResponse,
    ServerResponse,
    ServerUpdate,
)
from app.services import server_service
from app.services.bulk_import_service import get_errors_csv, process_server_bulk_import

router = APIRouter(prefix="/servers", tags=["servers"])


@router.get("", response_model=ServerListResponse)
async def list_servers(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ServerListResponse:
    items, total = await server_service.get_all(db, user.id)
    return ServerListResponse(
        items=[ServerResponse.model_validate(s) for s in items],
        total=total,
    )


@router.get("/{server_id}", response_model=ServerResponse)
async def get_server(
    server_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ServerResponse:
    server = await server_service.get_by_id(db, server_id, user.id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    return ServerResponse.model_validate(server)


@router.post("", response_model=ServerResponse, status_code=status.HTTP_201_CREATED)
async def create_server(
    data: ServerCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ServerResponse:
    server = await server_service.create(db, data, user.id)
    await audit_service.log(
        db,
        user_id=user.id,
        action="server.create",
        target_type="server",
        target_id=str(server.id),
    )
    await db.commit()
    return ServerResponse.model_validate(server)


@router.put("/{server_id}", response_model=ServerResponse)
async def update_server(
    server_id: int,
    data: ServerUpdate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ServerResponse:
    server = await server_service.update(db, server_id, data, user.id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="server.update",
        target_type="server",
        target_id=str(server_id),
    )
    await db.commit()
    return ServerResponse.model_validate(server)


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server(
    server_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    ok = await server_service.delete(db, server_id, user.id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="server.delete",
        target_type="server",
        target_id=str(server_id),
    )
    await db.commit()


@router.post("/bulk-import", response_model=ServerBulkImportResponse)
async def bulk_import_servers(
    user: User = Depends(get_current_user_or_401),
    file: UploadFile = File(...),
    has_header: bool = Form(True),
    db: AsyncSession = Depends(get_db),
) -> ServerBulkImportResponse:
    raw = await file.read()
    created, skipped, errors, csv_url = await process_server_bulk_import(
        db,
        user_id=user.id,
        filename=file.filename or "servers.csv",
        content=raw,
        has_header=has_header,
    )
    return ServerBulkImportResponse(
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
