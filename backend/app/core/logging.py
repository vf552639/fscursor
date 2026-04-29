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
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error", "sqlalchemy", "celery"):
        target = logging.getLogger(name)
        target.handlers = [intercept]
        target.propagate = False
