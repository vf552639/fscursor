import base64
import csv
import io
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_and_login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    from datetime import datetime, timezone

    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
        },
    )
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(key)},
    )


@pytest.mark.asyncio
async def test_user_a_cannot_see_user_b_domains():
    """Чужой домен не виден ни в списке, ни поштучно.

    404 у чужого подпёрт позитивным контролем URL: тот же путь под владельцем
    обязан дать 200. Иначе опечатка в пути (или переставленный роут) вернула бы
    ровно тот же 404, и тест зеленел бы там, где эндпоинта вовсе нет.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    a_email = f"a-{uuid.uuid4().hex[:8]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, a_email)
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201
        a_domain_id = r.json()["id"]
        await c.post("/api/auth/logout")
        await _register_and_login(c, f"b-{uuid.uuid4().hex[:8]}@example.com", key=b"\x99" * 32)
        r = await c.get("/api/domains")
        assert r.status_code == 200
        for item in r.json():
            assert item["id"] != a_domain_id
        r = await c.get(f"/api/domains/{a_domain_id}")
        assert r.status_code == 404

        await c.post("/api/auth/logout")
        await _register_and_login(c, a_email)
        r = await c.get(f"/api/domains/{a_domain_id}")
        assert r.status_code == 200, (
            f"этот же GET не работает и у владельца — 404 у чужого "
            f"ничего не доказывает: {r.text}"
        )
        assert r.json()["domain_name"] == dom


@pytest.mark.asyncio
async def test_user_b_failed_export_csv_shows_only_own_domains():
    """Выгрузка провалившихся доменов не показывает чужие строки.

    Роут `GET /api/domains/failed-export.csv` до этого спринта был затенён
    `GET /{domain_id}` и отвечал 422, то есть его скоупинг никогда не
    исполнялся по-настоящему. Раз путь открыли — фильтр `user_id` должен быть
    проверен так же, как у соседних чтений в этом файле.

    Позитивный контроль — собственный упавший домен B в той же выгрузке. Без
    него ассерт «чужого не видно» был бы зелен и на пустом CSV, и на роуте,
    который вообще ничего не отбирает.
    """
    a_dom = f"{uuid.uuid4().hex[:8]}.example.com"
    b_dom = f"{uuid.uuid4().hex[:8]}.example.com"
    a_err = f"a-secret-error-{uuid.uuid4().hex[:8]}"
    a_email = f"csv-a-{uuid.uuid4().hex[:8]}@example.com"
    b_email = f"csv-b-{uuid.uuid4().hex[:8]}@example.com"
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await _register_and_login(c, a_email)
            r = await c.post("/api/domains", json={"domain_name": a_dom})
            assert r.status_code == 201, r.text
            a_domain_id = r.json()["id"]
            r = await c.put(
                f"/api/domains/{a_domain_id}",
                json={"status": "failed", "last_provision_error": a_err},
            )
            assert r.status_code == 200, r.text

            await c.post("/api/auth/logout")
            await _register_and_login(c, b_email, key=b"\x99" * 32)
            r = await c.post("/api/domains", json={"domain_name": b_dom})
            assert r.status_code == 201, r.text
            r = await c.put(
                f"/api/domains/{r.json()['id']}",
                json={"status": "failed", "last_provision_error": "b-own-error"},
            )
            assert r.status_code == 200, r.text

            r = await c.get("/api/domains/failed-export.csv")
            assert r.status_code == 200, r.text
            names = [row[0] for row in list(csv.reader(io.StringIO(r.text)))[1:]]
            assert b_dom in names, (
                f"в выгрузке нет собственного упавшего домена — проверка ниже "
                f"холостая: {r.text}"
            )
            assert a_dom not in names, f"чужой домен виден в выгрузке: {r.text}"
            # И текст чужой ошибки тоже: он уехал бы вместе со строкой, но
            # отдельный ассерт ловит и случай, когда имя домена вдруг перестанут
            # писать первой колонкой.
            assert a_err not in r.text, "чужая ошибка провижининга видна в выгрузке"
    finally:
        # Своих пользователей тест убирает за собой — домены уедут следом по FK
        # CASCADE. База dev общая, а этот тест штампует по два `failed`-домена
        # за прогон: без уборки они копятся ровно в той выборке, которую роут и
        # отдаёт (урок `wb-*` из Спринта 4).
        async with AsyncSessionLocal() as s:
            await s.execute(sa_delete(User).where(User.email.in_([a_email, b_email])))
            await s.commit()
