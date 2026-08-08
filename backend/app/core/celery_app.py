import logging

from celery import Celery
from celery.schedules import crontab
from celery.signals import celeryd_after_setup

from app.core.config import settings

logger = logging.getLogger(__name__)

# Имя задачи мониторинга живёт здесь, а не строкой в трёх местах: на неё
# ссылаются расписание, сигнал старта воркера и сама задача, а промах в имени
# ничего не ломает громко — он превращает вызов в беззвучный no-op.
SERVER_REACHABILITY_TASK = "app.tasks.server_monitor.check_server_reachability"

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
    # Раз в 6 часов: чаще незачем (TCP-проверка ловит падение, а не секунды
    # простоя), реже — и о падении узнаёшь на следующий рабочий день.
    "check-server-reachability-6h": {
        "task": SERVER_REACHABILITY_TASK,
        "schedule": crontab(minute=0, hour="*/6"),
    },
}


@celeryd_after_setup.connect
def recheck_the_fleet_on_worker_start(sender=None, instance=None, **kwargs) -> None:
    """Поднялся воркер — один прогон мониторинга, не дожидаясь слота.

    Расписание бьёт по слотам 00/06/12/18 UTC, и попадание в слот зависит от
    того, когда случился деплой. Воркер, поднятый в 06:09, промахивается мимо
    слота на девять минут и до полудня не проверяет ничего; ровно так в
    продакшене и вышло — у всех серверов стоял `last_check_at = NULL`, и
    продукт честно, но бесполезно писал «Last check: never». Прогон на старте
    закрывает эту дыру: после любого деплоя парк переопрашивается сразу.

    **Без сужения по владельцу, и это осознанно.** Смысл триггера — весь парк,
    а не чей-то один: неизвестно состояние всех машин, а не только тех, чей
    хозяин что-то сделал.

    Задача зовётся по имени, а не импортом: модуль задачи импортирует этот, и
    обратный импорт замкнул бы круг. Имя берётся из общей константы, так что
    разъехаться с реальной задачей ему негде.

    Сигнал `celeryd_after_setup` — воркерный. Beat-контейнер его не поднимает,
    значит второго прогона на тот же деплой не будет, а несколько воркеров дали
    бы несколько прогонов — но повторный прогон в том же состоянии
    идемпотентен и уведомлений не плодит (дедуп по эпизоду).

    Публикация не имеет права уронить старт воркера: если брокер в этот момент
    капризничает, парк дождётся ближайшего слота — это хуже, но не смертельно,
    а воркер, не стартовавший из-за необязательного удобства, смертельно.
    """
    try:
        celery_app.send_task(SERVER_REACHABILITY_TASK)
    except Exception:
        logger.warning(
            "celery: прогон мониторинга на старте воркера не поставлен в очередь — "
            "парк дождётся ближайшего слота расписания",
            exc_info=True,
        )
