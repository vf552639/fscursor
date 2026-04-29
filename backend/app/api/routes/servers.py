from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.server import Server
from app.models.task_log import TaskLog
from app.schemas.server import (
    FastpanelStatusResponse,
    InstallFastpanelResponse,
    ServerCreate,
    ServerBulkImportResponse,
    ServerListResponse,
    ServerResponse,
    ServerUpdate,
    SSHTestResponse,
)
from app.services import server_service
from app.services.bulk_import_service import get_errors_csv, process_server_bulk_import
from app.tasks.fastpanel_task import install_fastpanel

router = APIRouter(prefix="/servers", tags=["servers"])


@router.get("", response_model=ServerListResponse)
async def list_servers(db: AsyncSession = Depends(get_db)) -> ServerListResponse:
    items, total = await server_service.get_all(db)
    return ServerListResponse(
        items=[ServerResponse.model_validate(s) for s in items],
        total=total,
    )


@router.get("/{server_id}", response_model=ServerResponse)
async def get_server(server_id: int, db: AsyncSession = Depends(get_db)) -> ServerResponse:
    server = await server_service.get_by_id(db, server_id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    return ServerResponse.model_validate(server)


@router.post("", response_model=ServerResponse, status_code=status.HTTP_201_CREATED)
async def create_server(
    data: ServerCreate, db: AsyncSession = Depends(get_db)
) -> ServerResponse:
    server = await server_service.create(db, data)
    return ServerResponse.model_validate(server)


@router.put("/{server_id}", response_model=ServerResponse)
async def update_server(
    server_id: int, data: ServerUpdate, db: AsyncSession = Depends(get_db)
) -> ServerResponse:
    server = await server_service.update(db, server_id, data)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    return ServerResponse.model_validate(server)


@router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server(server_id: int, db: AsyncSession = Depends(get_db)) -> None:
    ok = await server_service.delete(db, server_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")


@router.post("/{server_id}/test-ssh", response_model=SSHTestResponse)
async def test_ssh(server_id: int, db: AsyncSession = Depends(get_db)) -> SSHTestResponse:
    ok, msg = await server_service.test_ssh_connection(db, server_id)
    return SSHTestResponse(success=ok, message=msg)


@router.post("/{server_id}/refresh-uptime", response_model=ServerResponse)
async def refresh_uptime(server_id: int, db: AsyncSession = Depends(get_db)) -> ServerResponse:
    server = await server_service.fetch_and_persist_uptime(db, server_id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    return ServerResponse.model_validate(server)


@router.post(
    "/{server_id}/install-fastpanel",
    response_model=InstallFastpanelResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def install_fastpanel_endpoint(
    server_id: int, db: AsyncSession = Depends(get_db)
) -> InstallFastpanelResponse:
    server = await server_service.get_by_id(db, server_id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")

    result = await db.execute(
        update(Server)
        .where(
            Server.id == server_id,
            Server.fastpanel_status.notin_(["pending", "installing", "updating"]),
        )
        .values(fastpanel_status="pending")
    )
    if (result.rowcount or 0) == 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "FastPanel installation already in progress",
        )
    await db.commit()

    async_result = install_fastpanel.delay(server_id)
    return InstallFastpanelResponse(task_id=async_result.id, server_id=server_id)


@router.get("/{server_id}/fastpanel-status", response_model=FastpanelStatusResponse)
async def fastpanel_status(
    server_id: int, db: AsyncSession = Depends(get_db)
) -> FastpanelStatusResponse:
    server = await server_service.get_by_id(db, server_id)
    if not server:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")

    result = await db.execute(
        select(TaskLog)
        .where(
            TaskLog.entity_type == "server",
            TaskLog.entity_id == server_id,
            TaskLog.task_type == "install_fastpanel",
        )
        .order_by(desc(TaskLog.id))
        .limit(1)
    )
    last = result.scalar_one_or_none()
    tail: list[str] = []
    if last and last.log_text:
        tail = [ln for ln in last.log_text.splitlines() if ln][-20:]

    return FastpanelStatusResponse(
        server_id=server.id,
        fastpanel_status=server.fastpanel_status,
        fastpanel_url=server.fastpanel_url,
        fastpanel_user=server.fastpanel_user,
        log_tail=tail,
    )


@router.post("/bulk-import", response_model=ServerBulkImportResponse)
async def bulk_import_servers(
    file: UploadFile = File(...),
    has_header: bool = Form(True),
    db: AsyncSession = Depends(get_db),
) -> ServerBulkImportResponse:
    raw = await file.read()
    created, skipped, errors, csv_url = await process_server_bulk_import(
        db,
        filename=file.filename or "servers.csv",
        content=raw,
        has_header=has_header,
    )
    return ServerBulkImportResponse(
        created=created,
        skipped=skipped,
        errors=errors,
        errors_csv_url=csv_url,
    )


@router.get("/bulk-import-errors/{token}")
async def bulk_import_servers_errors_csv(token: str) -> StreamingResponse:
    csv_text = get_errors_csv(token)
    if csv_text is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Errors CSV not found")
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=servers_bulk_import_errors.csv"},
    )
