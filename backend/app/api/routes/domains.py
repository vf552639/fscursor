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
    BulkFullSetupRequest,
    BulkFullSetupResponse,
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
from app.services import (
    cloudflare_service,
    domain_service,
    registrar_service,
    server_service,
)
from app.services.bulk_import_service import get_errors_csv, process_bulk_import

router = APIRouter(prefix="/domains", tags=["domains"])

# Имя файла приходит от пользователя и в аудит попадает обрезанным: это
# единственный полезный идентификатор события импорта, но не повод класть в
# JSONB строку произвольной длины.
MAX_LOGGED_FILENAME = 255


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


# ВНИМАНИЕ: маршрут обязан быть объявлен ВЫШЕ `GET /{domain_id}`.
# Starlette перебирает маршруты в порядке объявления, поэтому динамический
# `/{domain_id}` перехватил бы `/failed-export.csv` первым: строка не парсится
# в `int`, и вместо CSV клиент получал 422. Не «прибирайте» файл, складывая
# GET-и вместе, — порядок здесь несущий.
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


# ГРАНИЦА: ниже этой строки новый GET с постоянным путём (`/stats`,
# `/export.csv`, …) объявлять нельзя — его перехватит `/{domain_id}` и клиент
# получит 422 вместо ответа. Все статик-GET-и идут выше, рядом с
# `failed-export.csv`. Про методы, отличные от GET, речи нет: при несовпадении
# метода Starlette продолжает перебор, поэтому POST-маршруты ниже безопасны.
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
    """Завести домен. Он же — одиночный вход мастера full-setup.

    Мастер сначала создаёт домен здесь, потом идёт с полученным `id` в
    `POST /domains/full-setup`. Поэтому «уже заведён» — не экзотика, а обычный
    ход событий, и отвечать на него 500 нельзя.

    `domains.domain_name` уникален ГЛОБАЛЬНО, а не в пределах пользователя
    (модель, миграция `001_initial`), поэтому занятым имя может оказаться и
    чужой строкой. Обе ветки отвечают 409 — и вот почему одинаково по коду,
    но по-разному по тексту:

    * Факт «имя занято» скрыть отсюда нельзя в принципе: его делает
      наблюдаемым сам глобальный UNIQUE, и сегодняшний 500 сообщал ровно тот
      же бит — только вдобавок выглядел поломкой и тащил имя домена в текст
      ошибки драйвера. Закрывается это не формулировкой, а уникальностью по
      паре (user_id, domain_name), то есть миграцией — записано долгом.
    * Своей строке можно назвать всё: она и так видна пользователю в списке.
      Чужой — только «занято»: ни владельца, ни id, ни намёка. Разница в
      тексте нового бита не выдаёт (свои домены пользователь и без нас знает),
      зато первый случай перестаёт быть тупиком.

    Id уже заведённого своего домена в ответе не возвращается намеренно: у
    мастера список доменов уже есть на руках, и находить в нём строку по имени
    дешевле, чем разбирать id из текста ошибки.
    """
    try:
        domain = await domain_service.create(db, data, user.id)
    except domain_service.DomainNameTaken as taken:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "domain already exists" if taken.existing_id else "domain name is already taken",
        ) from taken
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
    # Пишем счётчики, а не список имён: массовая заливка — это сотни доменов,
    # им не место в JSONB-поле аудита. `mode` отличает этот маршрут от
    # /bulk-structured, которое логируется тем же действием.
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.bulk_create",
        target_type="domain",
        metadata={
            "mode": "text",
            "created": len(created),
            "skipped": len(skipped),
            "registrar_id": data.registrar_id,
        },
    )
    await db.commit()
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
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.bulk_create",
        target_type="domain",
        metadata={
            "mode": "structured",
            "requested": len(data.items),
            "created": len(created),
            "skipped": len(skipped),
        },
    )
    await db.commit()
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
    # Владение целью — до записи. Без этой проверки свои домены привязывались
    # к чужому серверу по угаданному id: FK такую строку принимает, а экран
    # потом показывает связку с сущностью, которой у пользователя нет.
    # `None` — легальное «отвязать», проверять нечего.
    if data.server_id is not None:
        if await server_service.get_by_id(db, data.server_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    updated = await domain_service.bulk_assign_server(
        db, user.id, data.domain_ids, data.server_id
    )
    # Полезная запись здесь — цель переноса (сервер) и объём, а не перечень
    # доменов: 500-элементный массив id в аудите бесполезен и раздувает JSONB.
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.bulk_assign_server",
        target_type="server",
        target_id=str(data.server_id) if data.server_id is not None else None,
        metadata={
            "server_id": data.server_id,
            "domains_requested": len(data.domain_ids),
            "domains_updated": updated,
        },
    )
    await db.commit()
    return DomainBulkAssignResponse(updated=updated)


@router.post("/bulk-assign-cloudflare", response_model=DomainBulkAssignResponse)
async def bulk_assign_cloudflare(
    data: DomainBulkAssignCloudflare,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainBulkAssignResponse:
    # См. `bulk_assign_server` выше: та же проверка и по той же причине.
    if data.cloudflare_account_id is not None:
        if await cloudflare_service.get_account(db, data.cloudflare_account_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloudflare account not found")
    updated = await domain_service.bulk_assign_cloudflare(
        db, user.id, data.domain_ids, data.cloudflare_account_id
    )
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.bulk_assign_cloudflare",
        target_type="cloudflare_account",
        target_id=(
            str(data.cloudflare_account_id)
            if data.cloudflare_account_id is not None
            else None
        ),
        metadata={
            "cloudflare_account_id": data.cloudflare_account_id,
            "domains_requested": len(data.domain_ids),
            "domains_updated": updated,
        },
    )
    await db.commit()
    return DomainBulkAssignResponse(updated=updated)


@router.post("/full-setup", response_model=BulkFullSetupResponse)
async def full_setup(
    data: BulkFullSetupRequest,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BulkFullSetupResponse:
    """Связки пачке доменов: сервер + аккаунт Cloudflare (+ регистратор).

    Половина full-setup, которой не нужен токен. Вторую половину — завести
    зону, записать `cloudflare_zone_id`, по флагу прописать NS — делает
    десктоп: ключи Cloudflare и регистратора сервер не видит и видеть не
    должен. Поэтому здесь нет ни одного исходящего вызова, а ответ — это
    входные данные для десктопа (`id` + имя домена), а не id задач.

    Владение всеми тремя привязками проверяется до записи: иначе домены
    уехали бы на чужой сервер по угаданному id, а экран показал бы связку с
    сущностью, которой у пользователя нет. Соседние `bulk-assign-*` этой
    проверки не делают — это их долг, а не образец.
    """
    if await server_service.get_by_id(db, data.server_id, user.id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    if await cloudflare_service.get_account(db, data.cloudflare_account_id, user.id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloudflare account not found")
    if data.registrar_id is not None:
        if await registrar_service.get_account(db, data.registrar_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Registrar account not found")

    domains, skipped = await domain_service.bulk_full_setup(
        db,
        user.id,
        data.domain_ids,
        server_id=data.server_id,
        cloudflare_account_id=data.cloudflare_account_id,
        registrar_id=data.registrar_id,
    )
    # Счётчики, а не перечни: full-setup ходит по сотням доменов, и списку id
    # в JSONB аудита не место (та же дисциплина, что у bulk-assign выше).
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.full_setup",
        target_type="domain",
        metadata={
            "server_id": data.server_id,
            "cloudflare_account_id": data.cloudflare_account_id,
            "registrar_id": data.registrar_id,
            "domains_requested": len(data.domain_ids),
            "domains_linked": len(domains),
            "domains_skipped": len(skipped),
        },
    )
    await db.commit()
    return BulkFullSetupResponse(domains=domains, skipped_ids=skipped)


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
    # Логируем только исход: количество ошибок, но не сам список `errors` —
    # он построчно повторяет содержимое загруженного файла. И тем более не
    # `csv_url`: в нём токен, по которому CSV с ошибками отдаётся без
    # аутентификации, класть такой токен в долгоживущую запись нельзя.
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.bulk_import",
        target_type="domain",
        metadata={
            "filename": (file.filename or "domains.csv")[:MAX_LOGGED_FILENAME],
            "created": created,
            "skipped": skipped,
            "errors": len(errors),
            "default_registrar_id": default_registrar_id,
        },
    )
    await db.commit()
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
