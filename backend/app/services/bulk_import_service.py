import csv
import io
import uuid
from typing import Optional

from openpyxl import load_workbook
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_domain, normalize_domain
from app.schemas.domain import DomainBulkCreateItem, DomainBulkImportError
from app.services import domain_service

_ERROR_EXPORTS: dict[str, str] = {}


def _parse_csv(raw: bytes, has_header: bool) -> list[tuple[int, str, Optional[str]]]:
    text = raw.decode("utf-8", errors="ignore")
    reader = csv.reader(io.StringIO(text))
    rows: list[tuple[int, str, Optional[str]]] = []
    for idx, row in enumerate(reader, start=1):
        if has_header and idx == 1:
            continue
        if not row:
            continue
        domain = (row[0] or "").strip()
        registrar_name = (row[1] or "").strip() if len(row) > 1 else None
        rows.append((idx, domain, registrar_name or None))
    return rows


def _parse_xlsx(raw: bytes, has_header: bool) -> list[tuple[int, str, Optional[str]]]:
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = wb.active
    rows: list[tuple[int, str, Optional[str]]] = []
    for idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if has_header and idx == 1:
            continue
        if not row:
            continue
        domain = str(row[0] or "").strip()
        registrar_name = str(row[1] or "").strip() if len(row) > 1 and row[1] else None
        if not domain:
            continue
        rows.append((idx, domain, registrar_name))
    return rows


def build_errors_csv(errors: list[DomainBulkImportError]) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["row", "domain", "reason"])
    for e in errors:
        w.writerow([e.row, e.domain, e.reason])
    return out.getvalue()


def store_errors_csv(csv_text: str) -> str:
    token = uuid.uuid4().hex
    _ERROR_EXPORTS[token] = csv_text
    return token


def get_errors_csv(token: str) -> Optional[str]:
    return _ERROR_EXPORTS.get(token)


async def process_bulk_import(
    db: AsyncSession,
    *,
    filename: str,
    content: bytes,
    has_header: bool,
    default_registrar_id: Optional[int] = None,
) -> tuple[int, int, list[DomainBulkImportError], Optional[str]]:
    name = filename.lower()
    if name.endswith(".xlsx"):
        rows = _parse_xlsx(content, has_header)
    else:
        rows = _parse_csv(content, has_header)

    valid_items: list[DomainBulkCreateItem] = []
    errors: list[DomainBulkImportError] = []
    for row_num, domain, registrar_name in rows:
        norm = normalize_domain(domain)
        if not is_valid_domain(norm):
            errors.append(
                DomainBulkImportError(row=row_num, domain=domain, reason="Invalid domain format")
            )
            continue
        valid_items.append(
            DomainBulkCreateItem(
                domain_name=norm,
                registrar_id=default_registrar_id,
                registrar_name=registrar_name,
            )
        )

    created_list, skipped = await domain_service.bulk_create_structured(db, valid_items)
    skipped_set = set(skipped)
    for row_num, domain, _ in rows:
        norm = normalize_domain(domain)
        if norm in skipped_set:
            errors.append(
                DomainBulkImportError(row=row_num, domain=domain, reason="Duplicate or exists")
            )

    csv_url = None
    if errors:
        token = store_errors_csv(build_errors_csv(errors))
        csv_url = f"/domains/bulk-import-errors/{token}"

    return len(created_list), len(skipped), errors, csv_url
