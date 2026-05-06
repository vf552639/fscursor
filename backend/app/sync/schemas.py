from typing import Any

from pydantic import BaseModel


class ChangeRow(BaseModel):
    table: str
    id: str
    version: int
    deleted: bool
    fields: dict[str, Any] | None = None


class SyncChangesResponse(BaseModel):
    version: int
    rows: list[ChangeRow]
    blob_ids: list[str]


class SyncSnapshotResponse(BaseModel):
    version: int
    rows: list[ChangeRow]
    blob_ids: list[str]
