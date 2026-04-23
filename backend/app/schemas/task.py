from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class TaskLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_type: str
    entity_id: Optional[int]
    task_type: str
    status: str
    log_text: Optional[str]
    created_at: datetime
    updated_at: datetime
