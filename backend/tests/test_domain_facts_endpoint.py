"""`POST /api/domains/{id}/facts` — приёмник снимка состояния домена с сервера.

Зеркало `test_server_metrics_endpoint.py`, и по тем же причинам. Снимок снимает
десктоп по SSH (у него мастер-ключ и доступ к серверу), бэкенд после переезда
на zero-knowledge залогиниться на машину не может — он только принимает готовый
результат и раскладывает его по колонкам.

Ключевой инвариант этого роута — ДВА времени, а не одно. `fp_checked_at` —
«когда в последний раз ПРОБОВАЛИ прочитать», двигается всегда. `fp_facts_at` —
«когда в последний раз ПОЛУЧИЛОСЬ», двигается только на успехе. Провалившаяся
попытка (`{"error": ...}`) обязана обновить `fp_checked_at` и записать
`fp_check_error`, но НЕ имеет права ни стереть последний хороший снимок
(`fp_facts`), ни омолодить его (`fp_facts_at`). Это прямая реализация принципа
№6 CLAUDE.md — «не рисуй незнание здоровьем».

Утверждения идут по колонкам БД, а не по телу ответа: 200/422 сам по себе
доказывает только, что схема чем-то (не)довольна, а что запись случилась (или
не случилась) видно исключительно в колонке. Урок записан в шапке
`test_server_metrics_endpoint.py`.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.audit.models import AuditLog
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain
from tests.conftest import register_and_login

pytestmark = pytest.mark.usefixtures("purge_test_users")

# Правдоподобный снимок: ровно та форма, что пришлёт десктоп (без секретов и без
# сырого вывода команд). Содержимое для этого теста непрозрачно — предмет здесь
# не разбор фактов, а то, что снимок целиком доехал до JSON-колонки.
FACTS = {
    "site": {"path": "/var/www/example", "user": "example_usr"},
    "ssl": {"state": "valid", "issuer": "Let's Encrypt"},
    "ftp_accounts": [{"login": "example_usr", "home": "/var/www/example"}],
    "php_version": "8.2",
    "php_handler": "php-fpm",
    "databases": ["example_db"],
    "logs": [{"path": "/var/log/nginx/example.access.log", "exists": True, "size_bytes": 1024}],
}

# Колонки, за которыми следит файл.
FACT_COLUMNS = ("fp_checked_at", "fp_check_error", "fp_facts", "fp_facts_at")


async def _create_domain(c: AsyncClient) -> int:
    name = f"{uuid.uuid4().hex[:10]}.example.com"
    r = await c.post("/api/domains", json={"domain_name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _stored(domain_id: int) -> dict:
    """Значения колонок фактов — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        domain = (
            await s.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one()
        return {name: getattr(domain, name) for name in FACT_COLUMNS}


def _error_locs(response, field: str) -> list[list[str]]:
    return [list(e["loc"]) for e in response.json()["detail"] if list(e["loc"])[-1] == field]


def _error_types(response) -> set[str]:
    return {e["type"] for e in response.json()["detail"]}


@pytest.mark.asyncio
async def test_facts_land_in_the_columns_and_time_is_set_by_the_server():
    """Успех: снимок в колонке, оба времени поставил сервер, ошибка обнулена.

    `fp_facts` доезжает до JSON-колонки; `fp_facts_at` и `fp_checked_at` ставит
    сервер `datetime.now(utc)` в момент записи (клиент времени не шлёт вовсе);
    `fp_check_error` после успеха — `NULL`.
    """
    before = datetime.now(timezone.utc)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-ok")
        domain_id = await _create_domain(c)
        assert (await _stored(domain_id))["fp_checked_at"] is None

        r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
        assert r.status_code == 200, r.text

        stored = await _stored(domain_id)
        assert stored["fp_facts"] == FACTS
        assert stored["fp_check_error"] is None
        for col in ("fp_checked_at", "fp_facts_at"):
            ts = stored[col]
            assert ts is not None, f"сервер не проставил {col}"
            assert before - timedelta(minutes=1) <= ts <= datetime.now(timezone.utc) + timedelta(
                minutes=1
            ), f"{col}={ts!r}"

        # Тело ответа тоже отдаёт свежее — иначе для read-only веба снимка нет.
        body = r.json()
        assert body["fp_facts"] == FACTS
        assert body["fp_check_error"] is None
        assert datetime.fromisoformat(body["fp_facts_at"]) == stored["fp_facts_at"]


@pytest.mark.asyncio
async def test_failed_attempt_records_error_but_keeps_the_last_good_snapshot():
    """Провал двигает `fp_checked_at` и пишет ошибку, но НЕ трогает снимок.

    Главный тест файла. Сначала кладём хороший снимок, затем шлём провал —
    прошлый `fp_facts`/`fp_facts_at` обязаны остаться дословно прежними, а
    `fp_check_error` — появиться. Проверка по колонкам: «снимок на месте» —
    это про конкретные значения, а не про 200 в ответе.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-fail")
        domain_id = await _create_domain(c)

        r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
        assert r.status_code == 200, r.text
        good = await _stored(domain_id)
        assert good["fp_facts"] == FACTS and good["fp_facts_at"] is not None

        r = await c.post(
            f"/api/domains/{domain_id}/facts",
            json={"error": "SSH: connection refused"},
        )
        assert r.status_code == 200, r.text

        after = await _stored(domain_id)
        assert after["fp_check_error"] == "SSH: connection refused"
        assert after["fp_facts"] == good["fp_facts"], "провал стёр последний хороший снимок"
        assert after["fp_facts_at"] == good["fp_facts_at"], "провал омолодил снимок"
        assert after["fp_checked_at"] >= good["fp_checked_at"], (
            "провал не отметил время попытки"
        )


@pytest.mark.asyncio
async def test_success_after_failure_clears_the_error():
    """Успех после провала обнуляет `fp_check_error` — иначе ошибка «залипает».

    Позитивный контроль к тесту выше: раз провал ошибку пишет, успех обязан её
    снять, иначе домен вечно выглядит сломанным после одной сетевой икоты.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-recover")
        domain_id = await _create_domain(c)

        r = await c.post(f"/api/domains/{domain_id}/facts", json={"error": "timeout"})
        assert r.status_code == 200, r.text
        assert (await _stored(domain_id))["fp_check_error"] == "timeout"

        r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
        assert r.status_code == 200, r.text
        stored = await _stored(domain_id)
        assert stored["fp_check_error"] is None
        assert stored["fp_facts"] == FACTS


@pytest.mark.asyncio
async def test_facts_of_another_users_domain_are_rejected_with_404():
    """Чужой домен — 404, ни одна его колонка не меняется. С позитивным контролем.

    Без контроля под владельцем 404 у чужого не доказывает ничего — его же
    вернула бы опечатка в пути или незарегистрированный роут.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-owner")
        domain_id = await _create_domain(c)

        await c.post("/api/auth/logout")
        await register_and_login(c, "facts-stranger", key=b"\x99" * 32)
        r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
        assert r.status_code == 404, r.text
        assert (await _stored(domain_id))["fp_checked_at"] is None, "чужой снимок записался"

        # Позитивный контроль: тот же POST по СВОЕМУ домену этого пользователя —
        # 200. Без него 404 у чужого ничего не доказывает (его вернула бы и
        # опечатка в пути).
        own_id = await _create_domain(c)
        r = await c.post(f"/api/domains/{own_id}/facts", json={"facts": FACTS})
        assert r.status_code == 200, (
            f"этот же POST не работает и у владельца — 404 у чужого ничего "
            f"не доказывает: {r.text}"
        )


@pytest.mark.asyncio
async def test_nonexistent_domain_is_404():
    """Несуществующий id — 404, а не 500 из-под записи по `None`."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-gone")
        domain_id = await _create_domain(c)
        r = await c.post(
            f"/api/domains/{domain_id + 10_000_000}/facts", json={"facts": FACTS}
        )
        assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_empty_body_is_refused():
    """Тело без `facts` и без `error` — 422: попытка ни о чём двигала бы только

    `fp_checked_at`, из-за чего протухший снимок начал бы выглядеть свежим.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-empty")
        domain_id = await _create_domain(c)

        r = await c.post(f"/api/domains/{domain_id}/facts", json={})
        assert r.status_code == 422, r.text
        assert (await _stored(domain_id))["fp_checked_at"] is None, (
            "пустое тело сдвинуло время попытки"
        )


@pytest.mark.parametrize(
    "extra_field",
    [
        # Время снимка ставит сервер. Присланное клиентом означало бы, что «когда
        # прочитали» диктуют часы удалённой машины.
        pytest.param("fp_facts_at", id="fp_facts_at"),
        pytest.param("fp_checked_at", id="fp_checked_at"),
        # Инвариант ZK: плейнтекст-секрету в теле делать нечего.
        pytest.param("ftp_password", id="ftp_password"),
    ],
)
@pytest.mark.asyncio
async def test_unknown_field_in_the_body_is_a_refusal(extra_field: str):
    """Незнакомое поле (в т.ч. время от клиента) — 422 `extra_forbidden`.

    Схема `DomainFactsIn` стоит на `extra="forbid"`, поэтому подсунуть время
    снимка или секрет через лишнее поле нельзя — и снимок не пишется целиком.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-extra")
        domain_id = await _create_domain(c)

        r = await c.post(
            f"/api/domains/{domain_id}/facts",
            json={"facts": FACTS, extra_field: "2026-08-16T10:00:00Z"},
        )
        assert r.status_code == 422, r.text
        assert _error_locs(r, extra_field) == [["body", extra_field]], r.text
        assert _error_types(r) == {"extra_forbidden"}, r.text
        assert (await _stored(domain_id))["fp_checked_at"] is None, "отвергнутый снимок записался"


@pytest.mark.asyncio
async def test_anonymous_request_is_rejected():
    """Без сессии — 401: снимок пишет владелец, а не кто угодно с id домена."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as owner:
        await register_and_login(owner, "facts-anon")
        domain_id = await _create_domain(owner)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as guest:
            r = await guest.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
            assert r.status_code == 401, r.text

        assert (await _stored(domain_id))["fp_checked_at"] is None


@pytest.mark.asyncio
async def test_facts_leave_an_audit_trail():
    """Приём снимка пишется в аудит под `domain.read_facts`.

    Аудит по общему правилу репозитория: каждый мутирующий роут оставляет след
    (см. `test_server_metrics_endpoint`). `audit_service.log` бросает
    `ValueError` на действие вне allow-list, поэтому без строки в `SAFE_ACTIONS`
    роут отвечал бы 500 — гард на allow-list в `test_audit_actions.py`.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "facts-audit")
        domain_id = await _create_domain(c)
        r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
        assert r.status_code == 200, r.text

        async with AsyncSessionLocal() as s:
            rows = (
                (
                    await s.execute(
                        select(AuditLog).where(
                            AuditLog.target_type == "domain",
                            AuditLog.target_id == str(domain_id),
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert any(row.action == "domain.read_facts" for row in rows), (
            f"приём фактов не оставил следа в аудите: {[r.action for r in rows]}"
        )
