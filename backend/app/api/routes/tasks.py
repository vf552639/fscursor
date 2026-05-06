import asyncio
import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import AsyncSessionLocal, get_db
from app.models.task_log import TaskLog
from app.schemas.task import TaskLogResponse

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.get("", response_model=List[TaskLogResponse])
async def list_tasks(
    limit: int = 50,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(TaskLog)
        .where(TaskLog.user_id == user.id)
        .order_by(TaskLog.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/{task_id}", response_model=TaskLogResponse)
async def get_task(
    task_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    task = await db.get(TaskLog, task_id)
    if not task or task.user_id != user.id:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/stream")
async def stream_task(task_id: int, user: User = Depends(get_current_user_or_401)):
    async def events():
        last_log = ""
        while True:
            async with AsyncSessionLocal() as session:
                task = await session.get(TaskLog, task_id)
            if not task or task.user_id != user.id:
                yield 'event: error\ndata: {"message":"Task not found"}\n\n'
                break
            payload = {
                "id": task.id,
                "status": task.status,
                "log_text": task.log_text or "",
                "updated_at": task.updated_at.isoformat() if task.updated_at else None,
            }
            current_log = payload["log_text"]
            if current_log != last_log:
                last_log = current_log
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            if task.status in {"success", "failed"}:
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(events(), media_type="text/event-stream")
