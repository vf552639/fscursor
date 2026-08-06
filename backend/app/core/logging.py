import logging
import os
import sys

from loguru import logger


class _InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = logger.level(record.levelname).name
        except Exception:
            level = record.levelno
        logger.opt(depth=6, exception=record.exc_info).log(level, record.getMessage())


def configure_logging() -> None:
    """Sinks for the API process, and only for it.

    Called from `app/main.py` at module level, so `logs/app.log` and
    `logs/errors.log` exist for whoever imports the FastAPI app. The Celery
    worker and beat start as `celery -A app.core.celery_app.celery_app` and
    never import `app.main`, so those two files say nothing about background
    tasks — their output goes to the worker's stdout via Celery's own logging.
    Anything referring a reader to `logs/errors.log` for a task traceback would
    be sending them to a file that does not have it.

    Wiring these sinks into the worker as well is not the cheap fix it looks
    like: it needs `add_loguru_intercept_handler` too (without it stdlib records
    from `app.tasks.*` never reach loguru), and then three processes — api,
    worker, beat — rotate the same two files behind each other's back, which
    loses log lines rather than gaining them.
    """
    os.makedirs("logs", exist_ok=True)
    logger.remove()
    logger.add(
        sys.stdout,
        level="INFO",
        colorize=True,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}:{function}:{line}</cyan> - <level>{message}</level>",
    )
    logger.add("logs/app.log", rotation="10 MB", retention=5, level="INFO")
    logger.add("logs/errors.log", rotation="10 MB", retention=10, level="ERROR")


def add_loguru_intercept_handler() -> None:
    intercept = _InterceptHandler()
    # "app" covers our own modules; without it their logger.info() goes nowhere,
    # which silently swallows the dev-mode email confirmation link.
    for name in ("app", "uvicorn", "uvicorn.access", "uvicorn.error", "sqlalchemy", "celery"):
        target = logging.getLogger(name)
        target.handlers = [intercept]
        target.propagate = False
        if name == "app":
            target.setLevel(logging.INFO)
