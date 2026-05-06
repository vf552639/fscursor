import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class BlobUpsert(BaseModel):
    blob_kind: str = Field(min_length=1, max_length=64)
    ciphertext_b64: str
    device_id: uuid.UUID | None = None


class BlobResponse(BaseModel):
    id: uuid.UUID
    blob_kind: str
    ciphertext_b64: str
    version: int
    updated_at: datetime
    deleted: bool
