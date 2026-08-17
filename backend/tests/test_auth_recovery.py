"""Recovery требует доказательства владения recovery-фразой.

До этого спринта `POST /api/auth/recovery/finish` принимал только email и новые
ключи: любой, кто знал зарегистрированный адрес, перезаписывал salt,
auth_key_hash и recovery-блоб — владелец терял вход, а блобы в `blob_storage`
оставались зашифрованными на старом мастер-ключе, то есть данные не
восстанавливал уже никто. Теперь клиент обязан предъявить `recovery_auth_key`
(Argon2id от фразы, контекст "sdmp-recovery-key-v1"), сервер держит его
bcrypt-хеш в `recovery_blob.recovery_auth_key_hash` и сверяет ДО любой мутации.

Второй слой — ключ хранилища (VK). Блобы шифруются им, а пароль лишь
оборачивает его (`users.wrapped_vault_key` = aead(VK, KEK)), поэтому
восстановление обязано принести обёртку VK на новом пароле: без неё поворот
соли и пароля по-прежнему отрезал бы владельца от собственных секретов. Отсюда
и требование, и его форма — поле обязательное, чтобы клиент, который о нём не
знает, получил 422, а не тихо добил аккаунт.
"""

import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.auth.models import RecoveryBlob, Session as DbSession, User
from app.core.database import AsyncSessionLocal
from app.main import app

from conftest import _REGISTERED_EMAILS

# База тестов общая с dev-окружением, поэтому за собой убирают все файлы. Свой
# `register_and_login` из conftest тут не подходит: половине случаев нужен
# пользователь БЕЗ живой сессии (они сами считают сессии до и после), поэтому
# заведение осталось локальным, а в общий реестр уборки оно только дописывается.
# Импорт именно `from conftest`, не `from tests.conftest` — иначе реестр будет
# второй копией и уборка не выполнится (подробности — в шапке `conftest.py`).
pytestmark = pytest.mark.usefixtures("purge_test_users")


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


AUTH_KEY = b"\x01" * 32
BLOB = b"\x02" * 96
REC_KEY = b"\x03" * 32
WRONG_REC_KEY = b"\x99" * 32
# aead(VK, KEK): nonce 24 + тег 16 + ключ 32.
WRAPPED_VK = b"\x04" * 72
NEW_WRAPPED_VK = b"\x13" * 72


async def _register_and_confirm(c: AsyncClient, email: str, rec_key: bytes = REC_KEY) -> None:
    _REGISTERED_EMAILS.append(email)
    r = await c.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(AUTH_KEY),
            "recovery_blob_b64": b64(BLOB),
            "recovery_auth_key_b64": b64(rec_key),
            "wrapped_vault_key_b64": b64(WRAPPED_VK),
        },
    )
    assert r.status_code == 201, r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(
                email_confirmed_at=datetime.now(timezone.utc),
                email_confirm_token_hash=None,
            )
        )
        await s.commit()


async def _snapshot(email: str) -> dict:
    """Всё, что recovery/finish имеет право менять."""
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        rb = await s.get(RecoveryBlob, user.id)
        sessions = (
            (await s.execute(select(DbSession.id).where(DbSession.user_id == user.id)))
            .scalars()
            .all()
        )
        return {
            "salt": bytes(user.salt),
            "auth_key_hash": bytes(user.auth_key_hash),
            "wrapped_vault_key": (
                bytes(user.wrapped_vault_key) if user.wrapped_vault_key is not None else None
            ),
            "ciphertext": bytes(rb.ciphertext),
            "recovery_auth_key_hash": (
                bytes(rb.recovery_auth_key_hash) if rb.recovery_auth_key_hash is not None else None
            ),
            "session_ids": sorted(str(x) for x in sessions),
        }


async def _clear_recovery_hash(email: str) -> None:
    """Состояние пользователя, зарегистрированного до миграции 014."""
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        await s.execute(
            update(RecoveryBlob)
            .where(RecoveryBlob.user_id == user.id)
            .values(recovery_auth_key_hash=None)
        )
        await s.commit()


async def _clear_wrapped_vault_key(email: str) -> None:
    """Состояние аккаунта, заведённого до перехода на ключ хранилища."""
    async with AsyncSessionLocal() as s:
        await s.execute(update(User).where(User.email == email).values(wrapped_vault_key=None))
        await s.commit()


async def _wrapped_vault_key(email: str) -> bytes | None:
    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one()
        return bytes(user.wrapped_vault_key) if user.wrapped_vault_key is not None else None


def _finish_body(email: str, rec_key: bytes, **extra) -> dict:
    body = {
        "email": email,
        "recovery_auth_key_b64": b64(rec_key),
        "new_salt_b64": b64(b"\x10" * 16),
        "new_auth_key_b64": b64(b"\x11" * 32),
        "new_recovery_blob_b64": b64(b"\x12" * 96),
        "new_wrapped_vault_key_b64": b64(NEW_WRAPPED_VK),
    }
    body.update(extra)
    return body


@pytest.mark.asyncio
async def test_recovery_changes_master_password():
    email = f"rec-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)

        r = await c.post("/api/auth/recovery/start", json={"email": email})
        assert r.status_code == 200

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 200, r.text

        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 401

        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(b"\x11" * 32)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_finish_wrong_key_rejected_and_mutates_nothing():
    email = f"recbad-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        # Живая сессия: rejected-попытка не должна разлогинивать владельца.
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        before = await _snapshot(email)
        assert len(before["session_ids"]) == 1

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, WRONG_REC_KEY))
        assert r.status_code == 401, r.text

        assert await _snapshot(email) == before
        # Сессия жива, старый пароль по-прежнему рабочий.
        r = await c.get("/api/auth/me")
        assert r.status_code == 200
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_finish_without_key_is_rejected():
    """`recovery_auth_key_b64` обязателен — и забор стоит вокруг схемы.

    Снимок «до» тут не мог измениться: Pydantic отбивает запрос до хендлера. Тест
    и сторожит не хендлер, а обязательность поля: сделай его опциональным — и
    вернётся ровно та дыра, с которой начата шапка файла (кто знает email, тот
    поворачивает пароль).
    """
    email = f"recnokey-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        before = await _snapshot(email)
        r = await c.post(
            "/api/auth/recovery/finish",
            json={
                "email": email,
                "new_salt_b64": b64(b"\x10" * 16),
                "new_auth_key_b64": b64(b"\x11" * 32),
                "new_recovery_blob_b64": b64(b"\x12" * 96),
            },
        )
        assert r.status_code == 422, r.text
        assert await _snapshot(email) == before


@pytest.mark.asyncio
async def test_recovery_finish_unknown_email_returns_401_like_wrong_key():
    """Эндпоинт не подтверждает существование адреса."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/recovery/finish",
            json=_finish_body(f"ghost-{uuid.uuid4().hex[:10]}@example.com", REC_KEY),
        )
        assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_recovery_finish_refuses_when_hash_not_configured():
    """Пользователь до миграции 014: отказ, а не разовый пропуск."""
    email = f"reclegacy-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_recovery_hash(email)
        before = await _snapshot(email)
        assert before["recovery_auth_key_hash"] is None

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 409, r.text
        assert "sign in" in r.json()["detail"]
        assert await _snapshot(email) == before

        # Старый пароль по-прежнему пускает: ничего не сломано.
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_setup_restores_ability_to_recover():
    """Единственный выход для NULL-хеша: переустановить recovery из-под сессии."""
    email = f"recsetup-{uuid.uuid4().hex[:10]}@example.com"
    new_rec_key = b"\x44" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_recovery_hash(email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text

        # Неверный текущий пароль — отказ.
        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(b"\x77" * 32),
                "recovery_blob_b64": b64(b"\x55" * 96),
                "recovery_auth_key_b64": b64(new_rec_key),
            },
        )
        assert r.status_code == 401, r.text
        async with AsyncSessionLocal() as s:
            user = (await s.execute(select(User).where(User.email == email))).scalar_one()
            rb = await s.get(RecoveryBlob, user.id)
            assert rb.recovery_auth_key_hash is None
            assert bytes(rb.ciphertext) == BLOB

        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(AUTH_KEY),
                "recovery_blob_b64": b64(b"\x55" * 96),
                "recovery_auth_key_b64": b64(new_rec_key),
            },
        )
        assert r.status_code == 200, r.text

        # Старый ключ не подходит, новый — работает.
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 401, r.text
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, new_rec_key))
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_recovery_setup_requires_session():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(AUTH_KEY),
                "recovery_blob_b64": b64(BLOB),
                "recovery_auth_key_b64": b64(REC_KEY),
            },
        )
        assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_recovery_finish_rotates_hash_when_new_key_supplied():
    """Клиент выдал новую фразу в процессе восстановления — хеш едет следом."""
    email = f"recrot-{uuid.uuid4().hex[:10]}@example.com"
    rotated = b"\x66" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post(
            "/api/auth/recovery/finish",
            json=_finish_body(email, REC_KEY, new_recovery_auth_key_b64=b64(rotated)),
        )
        assert r.status_code == 200, r.text

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 401, r.text
        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, rotated))
        assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_successful_recovery_kills_sessions_and_rewrites_blob():
    email = f"recok-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        assert len((await _snapshot(email))["session_ids"]) == 1

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 200, r.text

        after = await _snapshot(email)
        assert after["session_ids"] == []
        assert after["salt"] == b"\x10" * 16
        assert after["ciphertext"] == b"\x12" * 96
        # Фраза не менялась — хеш остался прежним.
        assert after["recovery_auth_key_hash"] is not None
        r = await c.get("/api/auth/me")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_recovery_finish_rewraps_vault_key_for_the_new_password():
    """Обёртка VK едет на новый пароль — иначе блобы после восстановления мертвы."""
    email = f"recvk-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        assert await _wrapped_vault_key(email) == WRAPPED_VK

        r = await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        assert r.status_code == 200, r.text
        assert await _wrapped_vault_key(email) == NEW_WRAPPED_VK


@pytest.mark.asyncio
async def test_recovery_finish_without_wrapped_vault_key_is_rejected():
    """Обёртка обязательна — и забор стоит вокруг схемы, а не вокруг хендлера.

    Снимок «до» измениться и не мог: Pydantic отбивает запрос раньше хендлера.
    Ценность теста в другом — дай `new_wrapped_vault_key_b64` значение по
    умолчанию, и билд, не знающий про VK, вместо 422 молча повернёт соль с
    паролем и оставит владельца с блобами, которые больше нечем открыть.
    """
    email = f"recnovk-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        before = await _snapshot(email)

        body = _finish_body(email, REC_KEY)
        del body["new_wrapped_vault_key_b64"]
        r = await c.post("/api/auth/recovery/finish", json=body)
        assert r.status_code == 422, r.text
        assert await _snapshot(email) == before


@pytest.mark.asyncio
async def test_vault_key_init_fills_null_column_and_never_overwrites():
    """Ленивая миграция срабатывает один раз, и второй вызов ничего не портит.

    Перезапись обёртки — это потеря всех секретов аккаунта: VK достаётся только
    из неё. Поэтому пришедший с ДРУГИМИ байтами (проигравший гонку двух устройств
    или чужая сессия) обязан получить 409, а лежащая в колонке обёртка —
    остаться прежней; проверяется именно значение, код ответа тут ничего не
    гарантирует.
    """
    email = f"vkinit-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_wrapped_vault_key(email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        assert r.json()["wrapped_vault_key_b64"] is None

        r = await c.post(
            "/api/auth/vault-key/init", json={"wrapped_vault_key_b64": b64(WRAPPED_VK)}
        )
        assert r.status_code == 200, r.text
        assert await _wrapped_vault_key(email) == WRAPPED_VK

        r = await c.post(
            "/api/auth/vault-key/init", json={"wrapped_vault_key_b64": b64(NEW_WRAPPED_VK)}
        )
        assert r.status_code == 409, r.text
        assert await _wrapped_vault_key(email) == WRAPPED_VK


@pytest.mark.asyncio
async def test_vault_key_init_retried_with_the_same_wrapper_is_ok():
    """Ретрай теми же байтами — не конфликт, а потерянный ответ.

    Самый частый повтор этого вызова — не гонка двух устройств, а первый запрос,
    который дошёл до сервера, но чей ответ не вернулся: клиент шлёт ровно те же
    байты. Состояние уже целевое, и 409 тут отправил бы его чинить несломанное —
    в худшем случае заводить второй VK поверх рабочего.
    """
    email = f"vkretry-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_wrapped_vault_key(email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text

        for _ in range(2):
            r = await c.post(
                "/api/auth/vault-key/init", json={"wrapped_vault_key_b64": b64(WRAPPED_VK)}
            )
            assert r.status_code == 200, r.text
            assert await _wrapped_vault_key(email) == WRAPPED_VK

        # Идемпотентность — только для совпадающих байтов: чужая обёртка
        # по-прежнему упирается в 409.
        r = await c.post(
            "/api/auth/vault-key/init", json={"wrapped_vault_key_b64": b64(NEW_WRAPPED_VK)}
        )
        assert r.status_code == 409, r.text
        assert await _wrapped_vault_key(email) == WRAPPED_VK


@pytest.mark.asyncio
async def test_login_and_me_hand_out_the_wrapper():
    """Клиенту нужен `wrapped_vault_key`, иначе он не развернёт VK.

    `/auth/me` отдаёт вместе с обёрткой и соль: вебу этого хватает одним
    аутентифицированным вызовом, без анонимного `/auth/login/start`.
    """
    email = f"vkme-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text
        assert r.json()["wrapped_vault_key_b64"] == b64(WRAPPED_VK)

        me = (await c.get("/api/auth/me")).json()
        assert me["wrapped_vault_key_b64"] == b64(WRAPPED_VK)
        assert me["salt_b64"] == b64(b"\x00" * 16)


@pytest.mark.asyncio
async def test_recovery_start_never_hands_out_the_wrapper():
    """Анонимный эндпоинт обёртку не отдаёт — иначе это оракул для перебора пароля.

    `recovery/start` спрашивают, зная один лишь email. Отдай он `wrapped_vault_key`
    — и любой желающий получил бы возможность подбирать пароль оффлайн: угадал KEK,
    развернулась обёртка, значит пароль верный. Проверять же нечего: VK и так
    достаётся законному владельцу из recovery-блоба, который здесь и лежит.

    Инвариант отрицательный, и потому его легко потерять, добавляя поле «за
    компанию» с `/auth/me` — этот тест и есть тот гвоздь.
    """
    email = f"recstart-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        r = await c.post("/api/auth/recovery/start", json={"email": email})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "wrapped_vault_key_b64" not in body
        # Не только по имени поля: самих байтов обёртки в ответе быть не должно
        # ни под каким ключом.
        assert b64(WRAPPED_VK) not in r.text


@pytest.mark.asyncio
async def test_vault_key_init_requires_session():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/vault-key/init", json={"wrapped_vault_key_b64": b64(WRAPPED_VK)}
        )
        assert r.status_code == 401, r.text


@pytest.mark.asyncio
async def test_me_reports_recovery_configured_in_step_with_finish():
    """`recovery_configured` — это предсказание ответа recovery/finish.

    Тест намеренно сверяет флаг не с колонкой, а с поведением самого эндпоинта:
    иначе UI сможет тихо разойтись с бэкендом и показывать «всё в порядке»
    аккаунту, который на деле не восстановится.
    """
    email = f"recme-{uuid.uuid4().hex[:10]}@example.com"
    new_rec_key = b"\x66" * 32
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_confirm(c, email)
        await _clear_recovery_hash(email)
        r = await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(AUTH_KEY)},
        )
        assert r.status_code == 200, r.text

        # Легаси-аккаунт: флаг снят, и finish действительно отдаёт 409.
        assert (await c.get("/api/auth/me")).json()["recovery_configured"] is False
        assert (
            await c.post("/api/auth/recovery/finish", json=_finish_body(email, REC_KEY))
        ).status_code == 409

        r = await c.post(
            "/api/auth/recovery/setup",
            json={
                "auth_key_b64": b64(AUTH_KEY),
                "recovery_blob_b64": b64(b"\x55" * 96),
                "recovery_auth_key_b64": b64(new_rec_key),
            },
        )
        assert r.status_code == 200, r.text
        assert (await c.get("/api/auth/me")).json()["recovery_configured"] is True
