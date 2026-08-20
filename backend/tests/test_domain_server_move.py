"""Переезд домена на другой сервер обязан забыть снимок со старой машины.

Смена `server_id` — это запись метаданных, а НЕ перенос сайта. Снимок
`fp_facts` при этом остаётся снятым со старой машины, и оставленный на месте он
показывает вкладке Server FTP-логин прежнего сервера рядом с IP нового —
реквизиты, которые выглядят рабочими и не работают ни там, ни там. Поэтому
любой писатель `server_id` обнуляет всю четвёрку `fp_facts`, `fp_facts_at`,
`fp_check_error`, `fp_checked_at`.

Писателей три (`PUT /domains/{id}`, `bulk-assign-server`, `full-setup`), и
правило у них общее — одна функция `_forget_facts_of_previous_server`: три
экрана про сервер в этом проекте уже разъезжались, когда правило жило в
вызывающем. Отсюда и форма тестов — не «сервис обнулил», а «каждый из трёх
входов обнулил».

Обратная половина правила не менее важна: тот же сервер (и `PUT`, вовсе не
упоминающий `server_id`) снимок НЕ трогает. Иначе любая правка карточки
стирала бы последнее известное состояние домена и подменяла бы знание
прочерком — то самое, что запрещает принцип №6 («не рисуй незнание
здоровьем», только наоборот).

Заготовка (регистрация, уборка, заведение сервера) — общая, в `conftest.py`.
"""

import uuid
from typing import Optional

import pytest
from conftest import (
    b64,
    create_cf_account,
    create_server,
    domain_name,
    register_and_login,
)
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update as sa_update

from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain

pytestmark = pytest.mark.usefixtures("purge_test_users")

# Снимок формой повторяет то, что кладёт десктоп: важны здесь не значения, а
# то, что в нём есть реквизиты старой машины (`ftp_accounts`) — ради них
# правило и заведено.
FACTS = {
    "site": {"path": "/var/www/example", "user": "example_usr"},
    "ftp_accounts": [{"login": "example_usr", "home": "/var/www/example"}],
    "php_version": "8.2",
}

FACT_COLUMNS = ("fp_facts", "fp_facts_at", "fp_check_error", "fp_checked_at")

EMPTY_SNAPSHOT = dict.fromkeys(FACT_COLUMNS)

# Всё, что домен знает про КОНКРЕТНУЮ машину, и что переезд обязан забыть.
#
# Список выписан здесь ДОСЛОВНО и намеренно не импортируется из
# `domain_service._FORGOTTEN_ON_MOVE`: импортированный, он ужимался бы вместе с
# реализацией — выкинули колонку из правила, ожидание теста сжалось следом, и
# тест остался зелёным ровно там, где обязан краснеть. Первая редакция правила
# гасила только четыре `fp_*`, и поймал её не тест, а человек, открывший карточку.
MACHINE_COLUMNS = (
    # Снимок, прочитанный десктопом по SSH.
    "fp_facts",
    "fp_facts_at",
    "fp_check_error",
    "fp_checked_at",
    # Сайт, заведённый provision на той машине.
    "site_user",
    "site_path",
    "php_version",
    "php_handler",
    # Учётка FTP и ссылка на блоб с её паролем.
    "ftp_user",
    "ftp_password_blob_id",
    # База и ссылка на блоб с её паролем.
    "db_name",
    "db_user",
    "db_password_blob_id",
    # Сертификат, выпущенный certbot на той машине.
    "ssl_status",
    "ssl_expires_at",
    "ssl_issuer",
    "ssl_email_used",
    # Причина провала ПРОШЛОГО прогона на ПРЕЖНЕЙ машине.
    "last_provision_error",
)

EMPTY_MACHINE_STATE = dict.fromkeys(MACHINE_COLUMNS)

# Колонки, которые переезд трогать НЕ вправе, и почему. `status` — жизненный
# цикл домена (и `NOT NULL`); конфиг nginx — выбор человека, который с новой
# машины не восстановить ничем; `ns_status` — про регистратора, не про сервер.
SURVIVORS = {
    "status": "failed",
    "nginx_override": "# set by hand",
    "nginx_presets": {"force_https": True},
    "ns_status": "ok",
}


async def _facts(domain_id: int) -> dict:
    """Колонки снимка — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        domain = (
            await s.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one()
        return {name: getattr(domain, name) for name in FACT_COLUMNS}


async def _sync_version(domain_id: int) -> int:
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(Domain.sync_version).where(Domain.id == domain_id))
        ).scalar_one()


async def _domain_with_snapshot(c: AsyncClient, server_id: Optional[int]) -> int:
    """Домен на сервере `server_id`, у которого уже есть снимок.

    Снимок ставится тем же путём, что и в жизни, — `POST /domains/{id}/facts`:
    писать колонки в обход роута значило бы проверять правило на состоянии,
    которого продукт не производит.

    `server_id=None` — тоже законное состояние, а не выдумка теста: приёмник
    фактов привязки не требует и не проверяет (снимок читает десктоп по SSH и
    шлёт сюда), так что снимок при пустом `server_id` продукт производит сам —
    например, когда домен отвязали в другой вкладке между чтением и отправкой.
    """
    r = await c.post(
        "/api/domains", json={"domain_name": domain_name(), "server_id": server_id}
    )
    assert r.status_code == 201, r.text
    domain_id = r.json()["id"]
    r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
    assert r.status_code == 200, r.text
    assert (await _facts(domain_id))["fp_facts"] == FACTS
    return domain_id


@pytest.mark.asyncio
async def test_put_to_another_server_forgets_the_snapshot():
    """`PUT` с другим сервером обнуляет всю четвёрку — и в БД, и в ответе.

    Ответ проверяется отдельно от БД: карточка перерисовывается по телу `PUT`,
    и снимок, оставшийся в нём, показал бы старые реквизиты до перезагрузки
    страницы, даже если в БД уже пусто.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-put")
        old_server = await create_server(c)
        new_server = await create_server(c)
        domain_id = await _domain_with_snapshot(c, old_server)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": new_server})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        body = r.json()
        assert body["server_id"] == new_server
        assert all(body[col] is None for col in FACT_COLUMNS), body


@pytest.mark.asyncio
async def test_put_that_unbinds_the_server_forgets_the_snapshot_too():
    """Отвязка (`server_id: null`) — тот же переезд: сервера больше нет.

    Отдельным случаем, а не частью предыдущего: сравнение «отличается ли» здесь
    идёт с `None`, и реализация, написанная через `if patch.get("server_id")`,
    прошла бы тест выше и провалила бы этот.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-unbind")
        server_id = await create_server(c)
        domain_id = await _domain_with_snapshot(c, server_id)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": None})
        assert r.status_code == 200, r.text
        assert r.json()["server_id"] is None
        assert await _facts(domain_id) == EMPTY_SNAPSHOT


@pytest.mark.asyncio
async def test_put_with_the_same_server_or_without_it_keeps_the_snapshot():
    """Тот же сервер — не переезд; `PUT` без `server_id` — тем более.

    Второй случай ловит самую вероятную ошибку реализации: «поле не прислали»
    (`exclude_unset`) прочитанное как `server_id = None` превратило бы любую
    правку карточки в отвязку и стёрло бы снимок.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-same")
        server_id = await create_server(c)
        domain_id = await _domain_with_snapshot(c, server_id)
        before = await _facts(domain_id)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": server_id})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == before, "тот же сервер стёр снимок"

        r = await c.put(f"/api/domains/{domain_id}", json={"site_user": "example_usr"})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == before, "правка без server_id стёрла снимок"


@pytest.mark.asyncio
async def test_bulk_assign_server_forgets_only_of_those_who_moved():
    """Массовая привязка обнуляет снимок ровно у переехавших.

    Сброс сужен по `IS DISTINCT FROM`, `_set_links` — нет, и это намеренно:
    счётчик `updated` продолжает означать «сколько строк тронули». Домен, уже
    стоявший на целевом сервере, в счётчик входит, а снимок сохраняет.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-bulk")
        old_server = await create_server(c)
        target = await create_server(c)
        moving = await _domain_with_snapshot(c, old_server)
        staying = await _domain_with_snapshot(c, target)
        staying_before = await _facts(staying)
        moving_version = await _sync_version(moving)

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [moving, staying], "server_id": target},
        )
        assert r.status_code == 200, r.text
        assert r.json()["updated"] == 2

        assert await _facts(moving) == EMPTY_SNAPSHOT
        assert await _facts(staying) == staying_before, "снимок стёрт у никуда не ехавшего"
        # Своего `bump_version` у сброса нет — версию обнулённым строкам ставит
        # идущий следом `_set_links`. Если это когда-нибудь разъедется, десктоп
        # и read-only веб останутся со снимком, которого в БД уже нет.
        assert await _sync_version(moving) > moving_version


@pytest.mark.asyncio
async def test_bulk_assign_server_to_null_forgets_the_snapshot_too():
    """Массовая ОТВЯЗКА (`server_id: null`) тоже забывает снимок.

    Путь живой и своей ветки заслуживает: `server_id` в
    `DomainBulkAssignServer` объявлен `Optional`, маршрут отдельно разбирает
    `None` в аудите, а оставшийся после отвязки снимок — это FTP-логин машины,
    к которой домен больше не привязан.

    Отдельным тестом, а не хвостом `..._only_of_those_who_moved`: там к моменту
    отвязки снимок уже пуст, и проверка выродилась бы в тавтологию.

    Что этот тест НЕ доказывает — выбор `IS DISTINCT FROM`: SQLAlchemy
    переписывает `!= None` в `IS NOT NULL`, поэтому наивный `!=` его прошёл бы.
    Оператор запирает следующий тест.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-bulk-null")
        server_id = await create_server(c)
        domain_id = await _domain_with_snapshot(c, server_id)

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": None},
        )
        assert r.status_code == 200, r.text
        assert r.json()["updated"] == 1
        assert await _facts(domain_id) == EMPTY_SNAPSHOT


@pytest.mark.asyncio
async def test_binding_an_unbound_domain_forgets_its_stale_snapshot():
    """Привязка домена БЕЗ сервера тоже забывает снимок — и это про оператор.

    Здесь и только здесь наблюдаема разница `IS DISTINCT FROM` против `!=`.
    У непривязанного домена `server_id` — NULL, и в SQL `NULL != 5` даёт NULL,
    то есть строка тихо выпадает из UPDATE и увозит снимок с собой: карточка
    показала бы реквизиты, снятые до привязки, как состояние новой машины.
    `IS DISTINCT FROM` трактует NULL как значение и строку берёт.

    Зеркальный случай (`5 != NULL`, отвязка) этого не ловит: SQLAlchemy
    переписывает `!= None` в `IS NOT NULL`, и наивная реализация там ведёт себя
    правильно по случайности. Проверено подменой оператора: под `!=` красный
    ровно этот тест.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-bind")
        target = await create_server(c)
        domain_id = await _domain_with_snapshot(c, None)

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": target},
        )
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT


@pytest.mark.asyncio
async def test_full_setup_forgets_the_snapshot_of_a_moved_domain():
    """Третий писатель `server_id` — full-setup, и правило у него то же.

    Повтор с тем же сервером здесь заодно проверяет, что сброс не разрушил
    идемпотентность: заново обнулять нечего, снимок (уже пустой) не двигается.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-fs")
        old_server = await create_server(c)
        target = await create_server(c)
        cf_id = await create_cf_account(c)
        domain_id = await _domain_with_snapshot(c, old_server)

        body = {
            "domain_ids": [domain_id],
            "server_id": target,
            "cloudflare_account_id": cf_id,
        }
        r = await c.post("/api/domains/full-setup", json=body)
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        version_after = await _sync_version(domain_id)

        r = await c.post("/api/domains/full-setup", json=body)
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        assert await _sync_version(domain_id) == version_after, "повтор тронул строку"


async def _machine_state(domain_id: int) -> dict:
    """Все колонки «про машину» — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        domain = (
            await s.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one()
        return {name: getattr(domain, name) for name in MACHINE_COLUMNS}


async def _survivors(domain_id: int) -> dict:
    async with AsyncSessionLocal() as s:
        domain = (
            await s.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one()
        return {name: getattr(domain, name) for name in SURVIVORS}


async def _provisioned_domain(c: AsyncClient, server_id: int) -> int:
    """Домен на сервере, у которого заполнено ВСЁ, что знают про машину.

    Заполняется тремя путями, и разные они не от лени:

    * `POST /domains/{id}/facts` — снимок по SSH, путь десктопа;
    * `PUT /domains/{id}` — то, что умеет `DomainUpdate`. Это дословно путь
      write-back провижининга (`DomainWriteBack` в десктопе шлёт сюда же);
    * прямая запись в БД — `ftp_user`, `php_version`, `php_handler`,
      `ssl_email_used`. Их сегодня не пишет НИ ОДИН маршрут: колонки достались
      от досхемного (до zero-knowledge) провижининга, который ходил на сервер
      сам. Заполнять их через продуктовый путь не через что, но забывать при
      переезде правило обязано и их — иначе на карточке останется FTP-логин
      старой машины, а это ровно исходная жалоба.

    Пароли лежат блобами: `PUT /api/blobs/{uuid}` — тот же путь, которым их
    кладёт фронт, и без настоящей строки в `blob_storage` FK не пустил бы id
    в домен.
    """
    r = await c.post(
        "/api/domains", json={"domain_name": domain_name(), "server_id": server_id}
    )
    assert r.status_code == 201, r.text
    domain_id = r.json()["id"]

    # Успех, а следом провал: так заполняются ВСЕ четыре `fp_*` разом. Успех
    # один оставил бы `fp_check_error` пустым (он его гасит), провал один — не
    # положил бы снимка. Состояние это не выдуманное, а самое обычное: последний
    # удачный снимок и более поздняя неудачная попытка перечитать.
    r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
    assert r.status_code == 200, r.text
    r = await c.post(f"/api/domains/{domain_id}/facts", json={"error": "ssh: timeout"})
    assert r.status_code == 200, r.text

    blob_ids = []
    for kind in ("domain_ftp_password", "domain_db_password"):
        blob_id = str(uuid.uuid4())
        r = await c.put(
            f"/api/blobs/{blob_id}",
            json={"blob_kind": kind, "ciphertext_b64": b64(b"\x07" * 48)},
        )
        assert r.status_code == 200, r.text
        blob_ids.append(blob_id)

    r = await c.put(
        f"/api/domains/{domain_id}",
        json={
            "site_user": "oldbox_usr",
            "site_path": "/var/www/oldbox",
            "ssl_status": "active",
            "ssl_expires_at": "2027-01-01T00:00:00Z",
            "ssl_issuer": "Let's Encrypt",
            "db_name": "oldbox_db",
            "db_user": "oldbox_dbu",
            "last_provision_error": "ssl step failed on the old box",
            "ftp_password_blob_id": blob_ids[0],
            "db_password_blob_id": blob_ids[1],
            **SURVIVORS,
        },
    )
    assert r.status_code == 200, r.text

    async with AsyncSessionLocal() as s:
        await s.execute(
            sa_update(Domain)
            .where(Domain.id == domain_id)
            .values(
                ftp_user="oldbox_ftp",
                php_version="8.2",
                php_handler="php-fpm",
                ssl_email_used="admin@example.com",
            )
        )
        await s.commit()

    filled = await _machine_state(domain_id)
    empty = [k for k, v in filled.items() if v is None]
    assert not empty, f"заготовка не заполнила колонки, тест был бы пустым: {empty}"
    assert await _survivors(domain_id) == SURVIVORS
    return domain_id


async def _move(c: AsyncClient, how: str, domain_id: int, target: int) -> None:
    """Переезд домена на `target` одним из трёх писателей `server_id`."""
    if how == "put":
        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": target})
    elif how == "bulk-assign-server":
        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": target},
        )
    elif how == "full-setup":
        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": [domain_id],
                "server_id": target,
                "cloudflare_account_id": await create_cf_account(c),
            },
        )
    else:  # pragma: no cover - опечатка в параметризации
        raise AssertionError(how)
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("how", ["put", "bulk-assign-server", "full-setup"])
async def test_moving_forgets_everything_about_the_previous_machine(how: str):
    """Переезд гасит ВСЕ колонки про старую машину, а не только снимок по SSH.

    Первая редакция правила гасила четыре `fp_*` — и этого мало. Колонки
    provision переезд переживали и оставались ЕДИНСТВЕННЫМ содержимым вкладки
    Server: «Host» новой машины рядом с «Login oldbox_usr», кнопкой «Show FTP
    password» и путём `/var/www/oldbox` — реквизиты СТАРОЙ машины под подписью
    «на сервере не проверено», хотя проверены они были, просто на другом
    сервере.

    Все три писателя `server_id` проверяются одним телом теста намеренно:
    расхождение между ними — главное, чего это правило боится, и «у одного из
    трёх отстало» обязано быть красным, а не незамеченным.

    Обратная половина — `SURVIVORS`: переезд не вправе трогать ни жизненный
    цикл домена, ни конфиг nginx, который человек написал руками и с новой
    машины не восстановит.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, f"move-all-{how[:6]}")
        old_server = await create_server(c)
        target = await create_server(c)
        domain_id = await _provisioned_domain(c, old_server)

        await _move(c, how, domain_id, target)

        assert await _machine_state(domain_id) == EMPTY_MACHINE_STATE
        assert await _survivors(domain_id) == SURVIVORS, "переезд снёс не своё"


@pytest.mark.asyncio
@pytest.mark.parametrize("how", ["put", "bulk-assign-server"])
async def test_assigning_the_same_server_keeps_everything(how: str):
    """Тот же сервер — не переезд: ни одна колонка про машину не гаснет.

    Половина правила, без которой вторая опасна: реализация, гасящая колонки
    безусловно, прошла бы тест выше целиком и стирала бы состояние сайта на
    каждой массовой привязке, которую человек нажал дважды.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, f"move-same-{how[:6]}")
        server_id = await create_server(c)
        domain_id = await _provisioned_domain(c, server_id)
        before = await _machine_state(domain_id)

        await _move(c, how, domain_id, server_id)

        assert await _machine_state(domain_id) == before
        assert await _survivors(domain_id) == SURVIVORS


@pytest.mark.asyncio
async def test_a_move_in_the_same_put_beats_the_values_sent_with_it():
    """Смена сервера и колонка про машину в ОДНОМ теле: побеждает сброс.

    Решение осознанное, и проигравшую сторону тест называет: присланные в том
    же `PUT` `site_user` / `db_name` / `last_provision_error` записаны НЕ будут,
    их затрут `NULL`-ы сброса. Основания — в `domain_service.update`, коротко:
    прислать состояние сайта на машине, куда домен только что переехал и где
    провижининг ещё не запускался, неоткуда, а обратный порядок сделал бы
    гарантию условной («карточка не показывает данные старой машины — если в
    том же запросе не прислали колонку»).

    Реальных отправителей такого тела сегодня нет: у `DomainWriteBack` десктопа
    поля `server_id` не существует вовсе, а карточка шлёт смену сервера одна.
    Тест держит именно РЕШЕНИЕ — чтобы обратный порядок стал видимым изменением
    поведения, а не тихим рефакторингом.

    Поля, к машине не относящиеся (`nginx_override`), в том же теле проходят
    как обычно: сброс их не касается.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-combined")
        old_server = await create_server(c)
        target = await create_server(c)
        domain_id = await _provisioned_domain(c, old_server)

        r = await c.put(
            f"/api/domains/{domain_id}",
            json={
                "server_id": target,
                "site_user": "newbox_usr",
                "db_name": "newbox_db",
                "last_provision_error": "sent along with the move",
                "nginx_override": "# edited in the same request",
            },
        )
        assert r.status_code == 200, r.text

        state = await _machine_state(domain_id)
        assert state == EMPTY_MACHINE_STATE, "присланное в том же теле пережило переезд"
        # И в ответе тоже: карточка перерисовывается по нему.
        body = r.json()
        assert body["site_user"] is None and body["db_name"] is None
        assert body["server_id"] == target
        # Не про машину — записалось, как и всякий обычный патч.
        assert body["nginx_override"] == "# edited in the same request"
