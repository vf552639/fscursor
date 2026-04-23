from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.task_log import TaskLog
from app.schemas.task import TaskLogResponse

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.get("", response_model=List[TaskLogResponse])
async def list_tasks(limit: int = 50, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskLog).order_by(TaskLog.created_at.desc()).limit(limit))
    return result.scalars().all()


@router.get("/{task_id}", response_model=TaskLogResponse)
async def get_task(task_id: int, db: AsyncSession = Depends(get_db)):
    task = await db.get(TaskLog, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task
