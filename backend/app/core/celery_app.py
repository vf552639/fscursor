from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery(
    "app",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_track_started=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    task_time_limit=60 * 60,
    task_soft_time_limit=55 * 60,
    worker_prefetch_multiplier=1,
)

celery_app.conf.beat_schedule = {
    "check-domain-renewals-daily": {
        "task": "app.tasks.renewal.check_domain_renewals",
        "schedule": crontab(hour=9, minute=0),
    },
    "check-servers-uptime": {
        "task": "app.tasks.server_health.check_all_servers_uptime",
        "schedule": crontab(minute="*/15"),
    },
}
