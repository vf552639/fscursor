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
    DomainFactsIn,
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


async def _ensure_links_owned(
    db: AsyncSession,
    user: User,
    *,
    server_id: Optional[int] = None,
    cloudflare_account_id: Optional[int] = None,
    registrar_id: Optional[int] = None,
) -> None:
    """Все три связки домена принадлежат этому пользователю — или 404.

    Проверка нужна каждому пути записи связок, потому что FK принимает чужую
    строку молча: домены уезжали к чужому серверу по угаданному id, а экран
    показывал связку с сущностью, которой у пользователя нет. Второй эффект
    важнее косметики: несуществующий id иначе доходил до драйвера и возвращался
    нарушением FK, то есть 500 на самом обычном вводе из мастера.

    `None` — легальное «не трогать» / «отвязать», проверять там нечего.
    """
    if server_id is not None:
        if await server_service.get_by_id(db, server_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Server not found")
    if cloudflare_account_id is not None:
        if await cloudflare_service.get_account(db, cloudflare_account_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloudflare account not found")
    if registrar_id is not None:
        if await registrar_service.get_account(db, registrar_id, user.id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Registrar account not found")


def _name_conflict(taken: domain_service.DomainNameTaken) -> HTTPException:
    """409 на занятое имя домена — с телом, которое не рассказывает про чужое.

    `domains.domain_name` уникален ГЛОБАЛЬНО, а не в пределах пользователя
    (модель, миграция `001_initial`), поэтому занятым имя бывает и чужой
    строкой. Обе ветки отвечают 409, но текстом — по-разному:

    * Факт «имя занято» скрыть отсюда нельзя в принципе: его делает
      наблюдаемым сам глобальный UNIQUE, и прежний 500 сообщал ровно тот же
      бит — только вдобавок выглядел поломкой и тащил имя домена в текст
      ошибки драйвера. Закрывается это не формулировкой, а уникальностью по
      паре (user_id, domain_name), то есть миграцией — записано долгом.
    * Своей строке можно назвать всё: она и так видна пользователю в списке.
      Чужой — только «занято»: ни владельца, ни id, ни намёка. Разница в
      тексте нового бита не выдаёт (свои домены пользователь знает и без нас),
      зато первый случай перестаёт быть тупиком.

    Id уже заведённого своего домена в тело не кладётся намеренно: у мастера
    список доменов уже есть на руках, и находить в нём строку по имени дешевле,
    чем разбирать id из текста ошибки.
    """
    return HTTPException(
        status.HTTP_409_CONFLICT,
        "domain already exists" if taken.existing_id else "domain name is already taken",
    )


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


@router.post("/{domain_id}/facts", response_model=DomainResponse)
async def submit_domain_facts(
    domain_id: int,
    data: DomainFactsIn,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> DomainResponse:
    """Принять снимок состояния домена, прочитанный десктопом по SSH.

    Зеркало `POST /servers/{id}/metrics`. Сервер тут только получатель: после
    переезда на zero-knowledge он на машину зайти не может (принцип №3), а
    десктоп читает состояние домена и шлёт результат сюда, чтобы он лёг в БД и
    стал виден в read-only вебе. Что именно принимается и почему тело описывает
    ровно один из двух исходов — в docstring `DomainFactsIn`; как присланное
    ложится в колонки и почему два времени держатся врозь — в
    `domain_service.apply_facts`.

    Владение доменом проверяется тем же путём, что и у остальных роутов домена
    (`apply_facts` зовёт `get_by_id`, отбивающий чужой id как отсутствующий):
    чужой домен — 404, и ни одна его колонка не меняется. Идентификаторы
    доменов последовательны, то есть угадываются, и роут без проверки владельца
    позволил бы заполнять чужие карточки.

    Запись в аудит — по общему правилу репозитория (каждый мутирующий роут
    оставляет след; молча меняющий строку пользователя приём фактов был бы
    единственным исключением). Значений снимка в metadata нет намеренно: это
    свободные строки с чужой машины, читать их надо через API, а гард
    `test_mutation_audit.py` смотрит на ИМЕНА ключей. Оговорка про автосбор — та
    же, что у `submit_server_metrics`: запись оправдана, пока проверку запускает
    человек кнопкой; появится расписание — аудит здесь пересматривать вместе с ним.

    Размещён этот POST выше `GET /{domain_id}`, но порядок для него, в отличие от
    статик-GET-ов, не несущий: методы разные, и Starlette при несовпадении
    метода продолжает перебор. Граница ниже — про GET, её смысл он не задевает.
    """
    domain = await domain_service.apply_facts(db, domain_id, data, user.id)
    if not domain:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Domain not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="domain.read_facts",
        target_type="domain",
        target_id=str(domain_id),
    )
    await db.commit()
    return DomainResponse.model_validate(domain)


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

    Связки мастер передаёт полями этого запроса, а в `POST /domains/full-setup`
    за ними больше не идёт: тот роут делает ровно то же присваивание, то есть
    второй вызов добавлял бы точку отказа между «домен создан» и «домен
    настроен». Дальше мастер уходит в десктоп — за зоной и NS.

    Поэтому здесь единственная поверхность, на которой пользователь узнаёт об
    отказе, и «уже заведён» на ней — не экзотика, а обычный ход событий:
    отвечать на него 500 нельзя, разбор отказа — в `_name_conflict`.
    """
    await _ensure_links_owned(
        db,
        user,
        server_id=data.server_id,
        cloudflare_account_id=data.cloudflare_account_id,
        registrar_id=data.registrar_id,
    )
    try:
        domain = await domain_service.create(db, data, user.id)
    except domain_service.DomainNameTaken as taken:
        raise _name_conflict(taken) from taken
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
    """Массовая заливка списком имён. Связки — одни на всю пачку.

    Гарда владения у этого маршрута (и у `/bulk-structured` ниже) не было
    ВОВСЕ, хотя он стоял на всех остальных путях записи связок: чужой
    `registrar_id` в теле проходил молча, и сотня доменов заводилась со ссылкой
    на чужой аккаунт. `server_id` в теле появился той же правкой, что закрыла
    дыру, поэтому проверяются оба.
    """
    await _ensure_links_owned(
        db, user, server_id=data.server_id, registrar_id=data.registrar_id
    )
    created, skipped = await domain_service.bulk_create(
        db, user.id, data.domains_text, data.registrar_id, server_id=data.server_id
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
            # Связка, с которой домены заведены, — рядом с регистратором: без
            # неё по журналу не понять, откуда у пачки взялся сервер.
            "server_id": data.server_id,
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
    """Массовая заливка построчно: у каждого домена своя пара связок.

    Владение проверяется по МНОЖЕСТВУ уникальных id, а не по элементу: пачка
    бывает на сотни строк с одним и тем же сервером, и проверка на элемент
    означала бы сотни одинаковых SELECT-ов. Проверяются все уникальные, а не
    первый попавшийся: чужой id в сто первой строке — тот же чужой id.

    `registrar_name` проверять нечего и не в чем: он резолвится (`find_reg_id`)
    только по аккаунтам этого пользователя, то есть чужого попросту не найдёт.

    Какой именно из чужих id вызвал отказ, ответ НЕ говорит: `_ensure_links_owned`
    поднимает фиксированное «Server not found» без id, одинаковое на любой чужой
    сервер. Поэтому и порядок обхода множества здесь ничего не решает. Указать
    виновную строку CSV этот отказ не поможет — форма отказа общая на все
    маршруты записи связок, и менять её надо там, а не тут.

    В аудит связки этого маршрута не идут — в отличие от `/bulk`, где они одни
    на всю пачку. Здесь они построчные: двести строк могут нести двести разных
    серверов, одно поле `server_id` в metadata было бы про них неправдой, а их
    перечень — тем самым списком сущностей, которого дисциплина аудита в этом
    файле не допускает. По той же причине там нет и регистратора — так было с
    самого начала.

    Почему гарда здесь раньше не было и что через это проходило — в docstring
    `bulk_create` выше.
    """
    for server_id in {i.server_id for i in data.items if i.server_id is not None}:
        await _ensure_links_owned(db, user, server_id=server_id)
    for registrar_id in {i.registrar_id for i in data.items if i.registrar_id is not None}:
        await _ensure_links_owned(db, user, registrar_id=registrar_id)
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
    """Правка домена — тот же путь записи имени и связок, что и заведение.

    Поэтому здесь те же два отказа, что у `create_domain`: чужая связка — 404,
    занятое имя — 409 (переименование в имя, которое уже кем-то занято,
    отвечало 500 из `IntegrityError`). Разбор текстов конфликта — там же.
    """
    await _ensure_links_owned(
        db,
        user,
        server_id=data.server_id,
        cloudflare_account_id=data.cloudflare_account_id,
        registrar_id=data.registrar_id,
    )
    try:
        domain = await domain_service.update(db, domain_id, data, user.id)
    except domain_service.DomainNameTaken as taken:
        raise _name_conflict(taken) from taken
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
    await _ensure_links_owned(db, user, server_id=data.server_id)
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
    await _ensure_links_owned(db, user, cloudflare_account_id=data.cloudflare_account_id)
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

    Владение всеми тремя привязками проверяется до записи — общим для всех
    путей записи связок `_ensure_links_owned`.
    """
    await _ensure_links_owned(
        db,
        user,
        server_id=data.server_id,
        cloudflare_account_id=data.cloudflare_account_id,
        registrar_id=data.registrar_id,
    )
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
