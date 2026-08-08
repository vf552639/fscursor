def pytest_configure(config) -> None:
    import os

    os.environ.setdefault("USE_MEMORY_RATE_LIMIT", "1")


from typing import NamedTuple

import pytest


@pytest.fixture(autouse=True)
def _disable_rate_limit_except_rate_tests(request: pytest.FixtureRequest) -> None:
    from app.main import app

    lim = app.state.limiter
    if "test_rate_limit" in request.node.nodeid:
        lim.enabled = True
        yield
        return
    lim.enabled = False
    yield
    lim.enabled = True


@pytest.fixture
def app_log(caplog):
    """Записи логгеров `app.*` — сам по себе `caplog` их не видит.

    `add_loguru_intercept_handler` (зовётся при импорте `app.main`, то есть в
    каждом тесте) вешает логгеру `app` собственный handler и снимает
    `propagate`. Handler `caplog` сидит на root, до которого ничего уже не
    доходит, — и любой тест про «в логах должно быть предупреждение» падал бы
    не потому, что предупреждения нет, а потому, что его некому услышать.
    Поэтому handler подключается к `app` напрямую и снимается в teardown.
    """
    import logging

    target = logging.getLogger("app")
    previous_level = target.level
    target.addHandler(caplog.handler)
    target.setLevel(logging.DEBUG)
    yield caplog
    target.removeHandler(caplog.handler)
    target.setLevel(previous_level)


class PublishedTask(NamedTuple):
    """Задача, которую тест попытался отправить в брокер."""

    name: str
    args: tuple
    kwargs: dict


class _NotPublishedResult:
    """Заглушка `AsyncResult`: у неё есть `id`, и больше ничего нет.

    `id` нужен по-настоящему — роут `/notifications/check-renewals` уносит его
    в audit log. Всё остальное (`get`, `state`) намеренно отсутствует: задача
    не поставлена, ждать её результата в тесте нечего, и падение на атрибуте
    честнее, чем правдоподобный ответ ни о чём.
    """

    id = "not-published-in-tests"


@pytest.fixture(autouse=True)
def published_tasks(monkeypatch) -> list[PublishedTask]:
    """Ни один тест не публикует задачу в брокер — конструкцией, а не уговором.

    Причина не в чистоте, а в уже случившемся: тестовая БД общая с
    dev-окружением, и прогон мониторинга без сужения по владельцу однажды
    записал трём настоящим машинам «упал» и разослал их владельцу уведомления
    (разбор — в шапке `test_server_monitor_task.py`). После того как заведение
    сервера начало ставить проверку само, эта мина перезарядилась: `POST
    /api/servers` дёргают около двух десятков тестов, и каждый из них при живом
    локальном Redis отправил бы воркеру настоящую работу по настоящей базе.

    Поэтому перехват стоит не у одной задачи, а у обеих дверей публикации —
    `Task.apply_async` (через неё же идёт и `delay`) и `Celery.send_task`, — и
    делает это autouse, то есть распространяется на весь набор тестов. Забыть
    его негде: чтобы отправить что-то в брокер, тесту пришлось бы обойти обе
    двери руками.

    Перехваченное не выбрасывается, а складывается в список: факт постановки
    задачи — это поведение, и тесты про немедленную проверку сервера проверяют
    именно его (имя задачи и сужение по владельцу). Тест, которому нужен
    сломанный брокер, доопределяет перехват своим `monkeypatch` поверх этого.
    """
    from celery import Celery
    from celery.app.task import Task

    published: list[PublishedTask] = []

    def _record_apply_async(self, args=None, kwargs=None, **options):
        published.append(PublishedTask(self.name, tuple(args or ()), dict(kwargs or {})))
        return _NotPublishedResult()

    def _record_send_task(self, name, args=None, kwargs=None, **options):
        published.append(PublishedTask(name, tuple(args or ()), dict(kwargs or {})))
        return _NotPublishedResult()

    monkeypatch.setattr(Task, "apply_async", _record_apply_async)
    monkeypatch.setattr(Celery, "send_task", _record_send_task)
    return published
