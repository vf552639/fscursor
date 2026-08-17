"""Путь записи секрета: плейнтекст → блоб → ссылка на блоб у сущности.

Проверка идёт **по БД**, а не по тексту ответа. В Спринте 3 ZK-тест утверждал
`secret not in response.text` и был зелёным только потому, что в схеме ответа
не было поля под секрет: он остался бы зелёным и в мире, где рядом живёт
плейнтекст-колонка и в неё только что записали пароль. Поэтому здесь смотрим
строку `blob_storage` и строку `servers` целиком — по всем колонкам маппера, а
не по паре запомнившихся имён.

Чтобы этот перебор мог провалиться, плейнтекст-пароль **кладётся в тело
запроса**. Без него ни одна правка сервера физически не смогла бы посадить
секрет в колонку, и ассерт был бы нефальсифицируем — в том числе ровно тогда,
когда завтра заведут ту колонку, ради которой он написан.

Криптографии здесь намеренно нет. Блоб — это `os.urandom` нужной длины: всё,
что бэкенд-тест вправе утверждать, — что сервер хранит и отдаёт непрозрачные
байты, ничего в них не понимая. Половина «расшифровывается обратно в исходный
пароль» доказывается там, где ключ реально живёт, — в Rust
(`commands/creds.rs`, `sync/http.rs`, `commands/vault.rs`). Тащить в бэкенд
libsodium-биндинг было бы вдвойне плохо: ассерт вышел бы круговым (тест
расшифровывает то, что сам же и зашифровал, о сервере не узнавая ничего), а
`requirements.txt` кормит прод-образ — примитив расшифровки оказался бы в одном
`import` от сервиса, чей весь контракт «он не умеет расшифровывать».

Фаза 2 включена: схемы `ServerCreate/Update`, `CloudflareAccount*` и
`RegistrarAccount*` живут с `extra="forbid"`, и плейнтекст-поле в теле — это
`422 {"detail":[{"type":"extra_forbidden","loc":["body","ssh_password"],…}]}`,
а не тихо проглоченное поле. Доказывает это `test_plaintext_secret_field_is_*`
ниже — по одному случаю на каждую из шести схем: `forbid` наследованием не
раздаётся, снятие его с одной схемы должен ловить отдельный ассерт.

Что осталось от перебора колонок после `forbid`. Утверждение про отказ несут
ассерты на 422 и `loc`; перебор колонок провалить теперь нечем — плейнтекст
физически не доходит до сервиса. Он остаётся сеткой на будущие пути записи
(колонку с секретом могут завести завтра, и пойдёт она уже не отсюда), и это
всё, чем он является. В частности, СНЯТЫЙ `forbid` он не ловит: первым упадёт
ассерт на 422 строкой выше, тест оборвётся, до перебора исполнение не дойдёт.
Ловят снятие `forbid` шесть случаев `test_plaintext_secret_field_is_*`.

**Не удаляй строку `"ssh_password": secret` из тела запроса** и не превращай
отвергнутый POST в чистый: тогда исчезнет ровно то утверждение, ради которого
написан файл.

Где кончается автоматика: доказано всё до «десктоп получил обратно исходный
пароль». Собственно **успешный SSH-коннект этим паролем** автотестом не
проверяется — для него нужен живой сервер, это ручной шаг из чек-листа приёмки
в конце `plans/2026-08-04-sprint4-secret-write-path.md`. Имитацию SSH за
приёмку не выдаём.
"""

import asyncio
import base64
import json
import os
import pathlib
import re
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select, update

from app.auth.models import User
from app.blobs.models import BlobStorage
from app.core.database import AsyncSessionLocal
from app.main import (
    SECRET_NAME_MARKERS,
    _input_is_unsafe_to_echo,
    _without_unrenderable_input,
    app,
)
from app.models.registrar_account import RegistrarAccount
from app.models.server import Server

BLOB_KIND = "ssh_password"

# Обвязка десктопного `crypto::aead` — nonce (24) + mac (16). Числа тут только
# ради правдоподобного размера блоба и контрактом НЕ являются: рассинхрон с
# десктопом здесь не диагностируется — поменяй там раскладку, и ни один ассерт
# этого файла не шелохнётся.
FRAMING_LEN = 24 + 16


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def opaque_blob_for(plaintext_len: int) -> bytes:
    """Блоб такого же размера, какой прислал бы десктоп, — и не более того.

    Случайные байты, а не шифротекст: бэкенду нечем их отличить, и в этом вся
    суть — он обязан хранить и возвращать их байт в байт, не понимая ничего.
    """
    return os.urandom(FRAMING_LEN + plaintext_len)


# Пользователи, заведённые текущим тестом. Уборка сущностей тут принцип (см.
# шапку), но пользователи из него выпадали: каждый тест регистрирует своего, а
# удалять его было некому — в общей dev-БД накопились сотни `swp-*`/`forbid-*`.
# Спринт поднял цену прогона файла с 5 строк до 13, так что это уже не мелочь.
_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — всё их хозяйство уедет по FK CASCADE.

    Уборка в teardown, а не в `finally` каждого теста: тестов в файле уже
    третий десяток, и забыть `finally` в новом куда легче, чем не заметить
    пропавшую фикстуру. Что она работает — утверждает
    `test_purging_a_test_user_takes_everything_it_owned_with_it`.

    `asyncio.run` в синхронной фикстуре безопасен: пул — `NullPool`, соединение
    заводится под текущий цикл и им же закрывается (см. `core/database`).
    Все FK на `users` объявлены `ondelete="CASCADE"`, поэтому одного DELETE
    хватает: сессии, устройства, аудит, блобы и сущности уедут следом.
    """
    _REGISTERED_EMAILS.clear()
    yield
    emails = list(_REGISTERED_EMAILS)
    _REGISTERED_EMAILS.clear()
    if emails:
        asyncio.run(_purge_users(emails))


async def _purge_users(emails: list[str]) -> None:
    async with AsyncSessionLocal() as s:
        await s.execute(sa_delete(User).where(User.email.in_(emails)))
        await s.commit()


async def _register_and_login(client: AsyncClient, email: str) -> None:
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
        },
    )
    assert r.status_code in (201, 409), r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )
    assert r.status_code == 200, r.text


async def _purge_registrars(account_ids: list[int], blob_ids: list[str]) -> None:
    """То же, что `_purge`, но для аккаунтов регистратора."""
    async with AsyncSessionLocal() as s:
        for aid in account_ids:
            await s.execute(sa_delete(RegistrarAccount).where(RegistrarAccount.id == aid))
        for bid in blob_ids:
            await s.execute(sa_delete(BlobStorage).where(BlobStorage.id == uuid.UUID(bid)))
        await s.commit()


async def _purge(server_ids: list[int], blob_ids: list[str]) -> None:
    """Убрать за собой напрямую в БД.

    База тестов общая с dev-окружением, а упавший ассерт обрывает тест на
    середине — чистка через API в этот момент сама получила бы 404. Порядок
    удаления роли не играет: FK объявлен `ondelete="SET NULL"`, так что и
    блоб-первым Postgres просто обнулил бы `ssh_password_blob_id`.
    """
    async with AsyncSessionLocal() as s:
        for sid in server_ids:
            await s.execute(sa_delete(Server).where(Server.id == sid))
        for bid in blob_ids:
            await s.execute(sa_delete(BlobStorage).where(BlobStorage.id == uuid.UUID(bid)))
        await s.commit()


def _extra_forbidden_locs(response) -> list[list[str]]:
    """`loc` всех ошибок «лишнее поле» из тела 422.

    Смотрим именно на `loc`, а не на статус целиком: 422 схема отдаёт и за
    десяток других причин (нет `name`, кривой UUID), и тест, довольный любым
    422, зеленел бы на опечатке в теле запроса.
    """
    return [
        list(err["loc"])
        for err in response.json()["detail"]
        if err.get("type") == "extra_forbidden"
    ]


def _leaks(value: object, secret: str) -> bool:
    """Видно ли секрет в значении колонки — хоть текстом, хоть байтами."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return secret.encode() in bytes(value)
    return secret in str(value)


@pytest.mark.asyncio
async def test_ssh_password_reaches_the_server_only_as_ciphertext():
    """PUT блоба + POST сервера: в БД лежит шифротекст и ссылка на него.

    Это и есть дефект, который чинит спринт: до него формы слали плейнтекст в
    поле, которого нет в схеме, сервер молча его игнорировал, а
    `ssh_password_blob_id` оставался NULL — и любая SSH-команда десктопа
    падала с «server has no ssh_password_blob_id».

    Тот же плейнтекст-POST проверяется здесь и как отказ (`extra="forbid"`):
    сервер обязан ответить 422 и ничего не создать.
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    ciphertext = opaque_blob_for(len(secret))
    blob_id = str(uuid.uuid4())
    server_ids: list[int] = []

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"swp-{uuid.uuid4().hex[:8]}@example.com")
        try:
            r = await c.put(
                f"/api/blobs/{blob_id}",
                json={"blob_kind": BLOB_KIND, "ciphertext_b64": b64(ciphertext)},
            )
            assert r.status_code == 200, r.text

            # Ровно то тело, которое слали старые формы. С `extra="forbid"`
            # это громкий отказ, а не 201 с NULL в колонке.
            r = await c.post(
                "/api/servers",
                json={
                    "name": f"srv-{uuid.uuid4().hex[:6]}",
                    "ip_address": "203.0.113.20",
                    "ssh_password_blob_id": blob_id,
                    "ssh_password": secret,
                },
            )
            # Если `forbid` снимут, POST пройдёт — заберём id, чтобы `finally`
            # убрал строку из общей dev-БД, и только потом упадём.
            if r.status_code < 300:
                server_ids.append(r.json()["id"])
            assert r.status_code == 422, r.text
            assert _extra_forbidden_locs(r) == [["body", "ssh_password"]], r.text

            # А так, как шлёт форма сегодня, — 201. Дальше перебор колонок; он
            # сторожит будущие пути записи (колонку с секретом могут завести
            # завтра), но снятый `forbid` НЕ ловит: ассерт на 422 выше упадёт
            # первым, и сюда исполнение не дойдёт. За снятый `forbid` отвечают
            # шесть случаев `test_plaintext_secret_field_is_rejected_loudly`.
            r = await c.post(
                "/api/servers",
                json={
                    "name": f"srv-{uuid.uuid4().hex[:6]}",
                    "ip_address": "203.0.113.20",
                    "ssh_password_blob_id": blob_id,
                },
            )
            assert r.status_code == 201, r.text
            server_id = r.json()["id"]
            server_ids.append(server_id)

            async with AsyncSessionLocal() as s:
                blob = (
                    await s.execute(
                        select(BlobStorage).where(BlobStorage.id == uuid.UUID(blob_id))
                    )
                ).scalar_one()
                # Байт в байт то, что прислал клиент. Ассерта вида
                # `secret not in stored` тут нет намеренно: он был бы той же
                # формы, что осуждаемый в шапке `secret not in r.text`, —
                # байты сгенерированы до запроса и с секретом не связаны, так
                # что провалить его могла бы только подмена содержимого, а её
                # строго сильнее ловит равенство.
                assert bytes(blob.ciphertext) == ciphertext, (
                    "сервер переписал блоб — десктоп его не расшифрует"
                )
                assert blob.blob_kind == BLOB_KIND

                server = (
                    await s.execute(select(Server).where(Server.id == server_id))
                ).scalar_one()
                assert str(server.ssh_password_blob_id) == blob_id, (
                    "ссылка на блоб не сохранилась — десктоп не найдёт пароль"
                )

                # Перебор по мапперу, а не по паре знакомых имён: колонку с
                # секретом могут завести завтра, и тест обязан это увидеть.
                leaked = [
                    attr.key
                    for attr in sa_inspect(Server).mapper.column_attrs
                    if _leaks(getattr(server, attr.key), secret)
                ]
                assert leaked == [], f"плейнтекст виден в колонках servers: {leaked}"

            # Обратный ход: GET отдаёт ровно те же байты. Переставь сервер в
            # них хоть один байт «для нормализации» — десктоп получил бы
            # `AeadError::Decrypt` вместо пароля.
            r = await c.get(f"/api/blobs/{blob_id}")
            assert r.status_code == 200, r.text
            assert base64.b64decode(r.json()["ciphertext_b64"]) == ciphertext
        finally:
            await _purge(server_ids, [blob_id])


@pytest.mark.asyncio
async def test_has_ssh_flips_only_because_the_blob_id_is_set():
    """`has_ssh` — это ровно «ссылка на блоб не NULL», и ничто иное.

    Флаг рисует в UI зелёную галочку и разрешает SSH-действия. Если он начнёт
    зависеть от чего-то ещё, пользователь увидит «пароль есть» там, где
    десктопу нечего расшифровывать.
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    blob_id = str(uuid.uuid4())
    server_ids: list[int] = []

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"swp-hs-{uuid.uuid4().hex[:8]}@example.com")
        try:
            r = await c.put(
                f"/api/blobs/{blob_id}",
                json={"blob_kind": BLOB_KIND, "ciphertext_b64": b64(opaque_blob_for(len(secret)))},
            )
            assert r.status_code == 200, r.text

            base = {"ip_address": "203.0.113.21"}
            # Плейнтекст-пароль вместо ссылки на блоб — это отказ: сервер с
            # ним не заводится вовсе. Раньше он заводился и рисовал
            # `has_ssh: false` — «сохранено» там, где десктопу нечего
            # расшифровывать, и пользователь узнавал об этом на середине
            # provision.
            r = await c.post(
                "/api/servers",
                json={
                    **base,
                    "name": f"srv-no-{uuid.uuid4().hex[:6]}",
                    "ssh_password": secret,
                },
            )
            if r.status_code < 300:
                server_ids.append(r.json()["id"])
            assert r.status_code == 422, r.text
            assert _extra_forbidden_locs(r) == [["body", "ssh_password"]], r.text

            # Без ссылки на блоб и без плейнтекста `has_ssh` обязан быть False:
            # флаг рисует в UI зелёную галочку и разрешает SSH-действия.
            r = await c.post(
                "/api/servers",
                json={**base, "name": f"srv-no-{uuid.uuid4().hex[:6]}"},
            )
            assert r.status_code == 201, r.text
            without_blob = r.json()["id"]
            server_ids.append(without_blob)
            assert r.json()["has_ssh"] is False

            r = await c.post(
                "/api/servers",
                json={
                    **base,
                    "name": f"srv-yes-{uuid.uuid4().hex[:6]}",
                    "ssh_password_blob_id": blob_id,
                },
            )
            assert r.status_code == 201, r.text
            with_blob = r.json()["id"]
            server_ids.append(with_blob)
            assert r.json()["has_ssh"] is True

            # Причина расхождения — в БД, а не в ответе: у одного ссылка на
            # блоб есть, у другого NULL.
            async with AsyncSessionLocal() as s:
                rows = {
                    row.id: row.ssh_password_blob_id
                    for row in (
                        await s.execute(
                            select(Server).where(Server.id.in_([without_blob, with_blob]))
                        )
                    ).scalars()
                }
            assert rows[without_blob] is None
            assert str(rows[with_blob]) == blob_id
        finally:
            await _purge(server_ids, [blob_id])


@pytest.mark.asyncio
async def test_registrar_response_carries_both_blob_ids():
    """Аккаунт регистратора отдаёт `api_key_blob_id` и `api_secret_blob_id`.

    Здесь ассерт по ОТВЕТУ, а не по БД, — в отличие от остального файла, и это
    осознанно: проверяется ровно форма ответа. Форма правки берёт id
    перезаписываемого блоба из отрисованной сущности; нет id в ответе — форма
    заведёт новый блоб, а `*_blob_id` аккаунта останется прежним: «сохранено»,
    а в API регистратора поедет старый ключ. Ассерт по БД этого не увидел бы —
    колонки-то заполнены с самого создания.

    Чтобы это не было проверкой эха запроса, id читаются из GET списка: его
    строки сервер собирает из БД, а не из тела POST. Секретом сами id не
    являются — это непрозрачные ссылки, и `ServerResponse` с
    `CloudflareAccountResponse` свои отдают давно (в десктопном
    `audit_redact.rs` суффикс `_blob_id` внесён в исключения явным списком).
    """
    key_blob_id = str(uuid.uuid4())
    secret_blob_id = str(uuid.uuid4())
    account_ids: list[int] = []

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"reg-blob-{uuid.uuid4().hex[:8]}@example.com")
        try:
            for bid, kind in ((key_blob_id, "registrar_api_key"), (secret_blob_id, "registrar_api_secret")):
                r = await c.put(
                    f"/api/blobs/{bid}",
                    json={"blob_kind": kind, "ciphertext_b64": b64(opaque_blob_for(32))},
                )
                assert r.status_code == 200, r.text

            r = await c.post(
                "/api/registrars/accounts",
                json={
                    "provider": "hostiq",
                    "name": f"reg-{uuid.uuid4().hex[:6]}",
                    "api_key_blob_id": key_blob_id,
                    "api_secret_blob_id": secret_blob_id,
                },
            )
            assert r.status_code == 201, r.text
            created = r.json()
            account_ids.append(created["id"])
            assert created.get("api_key_blob_id") == key_blob_id
            assert created.get("api_secret_blob_id") == secret_blob_id

            r = await c.get("/api/registrars/accounts")
            assert r.status_code == 200, r.text
            listed = next(a for a in r.json() if a["id"] == created["id"])
            assert listed.get("api_key_blob_id") == key_blob_id, (
                "форма правки не узнает, какой блоб перезаписывать"
            )
            assert listed.get("api_secret_blob_id") == secret_blob_id
        finally:
            await _purge_registrars(account_ids, [key_blob_id, secret_blob_id])


# Заведомо несуществующий id для PUT'ов ниже. Тело схема разбирает до того,
# как роут пойдёт искать сущность, так что заводить её незачем: с `forbid`
# ответ — 422, без него — 404, и разница видна.
MISSING_ID = 2_000_000_000

# Шесть схем — шесть случаев. `extra="forbid"` стоит на каждом Create/Update
# отдельно: на Base его вешать МОЖНО, но тогда снятие одной правкой гасит
# ловушку у всех шести разом (см. `ServerCreate` в `schemas/server.py`).
# Поэтому и снятие с одной схемы обязано ронять свой отдельный случай: одного
# теста «на все шесть» не хватило бы — он зеленел бы, пока `forbid` остаётся
# хоть где-то.
FORBID_CASES = [
    pytest.param(
        "POST", "/api/servers",
        {"name": "srv-forbid", "ip_address": "203.0.113.22"},
        "ssh_password",
        id="ServerCreate",
    ),
    pytest.param(
        "PUT", f"/api/servers/{MISSING_ID}",
        {"fastpanel_user": "fp"},
        "fastpanel_password",
        id="ServerUpdate",
    ),
    pytest.param(
        "POST", "/api/cloudflare/accounts",
        {"name": "cf-forbid"},
        "api_token",
        id="CloudflareAccountCreate",
    ),
    pytest.param(
        "PUT", f"/api/cloudflare/accounts/{MISSING_ID}",
        {"name": "cf-forbid"},
        "api_token",
        id="CloudflareAccountUpdate",
    ),
    pytest.param(
        "POST", "/api/registrars/accounts",
        {"provider": "hostiq", "name": "reg-forbid"},
        "api_key",
        id="RegistrarAccountCreate",
    ),
    pytest.param(
        "PUT", f"/api/registrars/accounts/{MISSING_ID}",
        {"api_user": "u"},
        "api_secret",
        id="RegistrarAccountUpdate",
    ),
    # Плюс два случая, где вместе с плейнтекстом не хватает ОБЯЗАТЕЛЬНОГО
    # поля, — регрессировавшая форма запросто пришлёт и то, и другое разом
    # (переименовали поле, перепутали вкладку). У ошибки `missing` pydantic
    # кладёт в `input` не значение поля, а РОДИТЕЛЯ — всё тело запроса
    # целиком, вместе с плейнтекстом. Первые шесть случаев эту дыру не видят:
    # у них тела полные, ошибка `missing` не возникает, и ассерт «секрета нет
    # в ответе» зеленеет, ничего не проверяя.
    pytest.param(
        "POST", "/api/servers",
        {"ip_address": "203.0.113.23"},  # нет обязательного `name`
        "ssh_password",
        id="ServerCreate-missing-required",
    ),
    pytest.param(
        "POST", "/api/registrars/accounts",
        {"name": "reg-forbid"},  # нет обязательного `provider`
        "api_key",
        id="RegistrarAccountCreate-missing-required",
    ),
]


@pytest.mark.parametrize("method,path,body,plaintext_field", FORBID_CASES)
@pytest.mark.asyncio
async def test_plaintext_secret_field_is_rejected_loudly(
    method: str, path: str, body: dict, plaintext_field: str
):
    """Незнакомое поле в теле — 422 с `loc`, а не тихо выброшенный секрет.

    Дефект, ради которого написан весь файл, держался на `extra="ignore"`:
    форма слала плейнтекст в поле, которого нет в схеме, сервер молча его
    выбрасывал и отвечал 2xx с `*_blob_id = NULL`. Секрет исчезал бесследно,
    а пользователь видел «сохранено». С `forbid` та же регрессия падает в
    лицо ещё на валидации.

    Ассерт по `loc`, а не по статусу: 422 схема отдаёт и за десяток других
    причин, и тест, довольный любым 422, зеленел бы на опечатке в теле.
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    payload = {**body, plaintext_field: secret}
    # Имена уникальны на прогон: если `forbid` снимут, запрос пройдёт и
    # создаст сущность — не хочется ловить ещё и конфликт имён поверх.
    if "name" in payload:
        payload["name"] = f"{payload['name']}-{uuid.uuid4().hex[:6]}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"forbid-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.request(method, path, json=payload)
        # Снятый `forbid` пропустит POST — прибираем созданное, чтобы падение
        # не оставляло мусор в общей dev-БД, и только потом утверждаем.
        if r.status_code < 300 and method == "POST":
            cleanup = await c.delete(f"{path}/{r.json()['id']}")
            # Уборка обязана сработать: молча промахнувшийся DELETE (поменяли
            # форму пути) заметен был бы не красным тестом, а мусором в БД.
            assert cleanup.status_code in (204, 404), cleanup.text

        assert r.status_code == 422, r.text
        assert _extra_forbidden_locs(r) == [["body", plaintext_field]], r.text

        # Отказ громкий по ИМЕНИ поля, но не по его содержимому. Дефолтный
        # обработчик FastAPI кладёт в 422 ключ `input` — то есть сам пароль
        # (у `extra_forbidden`) или всё тело с ним внутри (у `missing`).
        # Оттуда он уезжает в `ApiError.details` (`api/client.ts` кладёт туда
        # тело ответа целиком), в состояние ошибки React Query и в логи; в
        # ТЕКСТ ошибки — нет, `String(data.detail)` от массива даёт
        # `"[object Object]"`. Ассерт по тексту здесь уместен, в отличие от
        # осуждаемого в шапке файла: предметом проверки и является само тело
        # ответа, и без `validation_error_without_secret_input` (`app/main.py`)
        # секрет в нём лежит буквально.
        assert secret not in r.text, "422 вернул сам секрет — он уедет в details и в логи"


@pytest.mark.parametrize(
    "shape",
    [
        # Тело-список: `input` — контейнер.
        pytest.param("list", id="тело-список"),
        # Тело-строка: двойная сериализация (`JSON.stringify` поверх тела,
        # которое axios сериализует сам). `input` тут СКАЛЯР, поэтому признак
        # «контейнер» его не ловит — ловит только «ошибка про корень тела».
        pytest.param("str", id="тело-строка"),
    ],
)
@pytest.mark.asyncio
async def test_422_does_not_echo_a_body_it_could_not_even_parse(shape: str):
    """Тело, до полей которого валидация не дошла, не возвращается целиком.

    Отдельно от параметризованного теста выше, потому что механизм другой: не
    объект вместо объекта — это `model_attributes_type` на `loc == ["body"]`,
    и ошибки `extra_forbidden` здесь не возникает ВООБЩЕ (полей никто не
    разбирал). Признак «снимаем `input` у `extra_forbidden`» такое тело
    пропускает, и вместе с ним — весь плейнтекст, который в нём был.

    Оба вида тела нужны порознь: список ловится ещё и признаком «`input` —
    контейнер», а строка — только признаком «ошибка про корень тела», и без
    неё он был бы ничем не подпёрт.
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    inner = {"name": "srv", "ip_address": "203.0.113.25", "ssh_password": secret}
    body = [inner] if shape == "list" else json.dumps(inner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"forbid-body-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/servers", json=body)

        assert r.status_code == 422, r.text
        # Именно эта ошибка, а не случайный 422 по другой причине.
        assert [e["type"] for e in r.json()["detail"]] == ["model_attributes_type"], r.text
        assert secret not in r.text, "422 вернул тело запроса целиком — вместе с секретом"


# Поля, которые схема ОБЪЯВЛЯЕТ, но значение которых всё равно секрет. Довод
# «объявленным полям доверяем» тут не работает: признаки редактирования
# существуют именно потому, что клиенту не доверяют.
#
# `/api/auth/register` — без сессии вовсе, и это единственные во всём
# приложении поля с ограничением длины (`auth/schemas.py`), то есть
# единственные, способные дать `string_too_*` с эхом; материал в них —
# ключ входа и recovery-фраза. `ssh_password_blob_id` — та самая опечатка
# `api_token_blob_id: token` вместо `blobId`, ради которой всё и затевалось:
# UUID не разобрался, а в `input` лежит пароль.
DECLARED_SECRET_FIELD_CASES = [
    pytest.param(
        "/api/auth/register",
        lambda secret: {
            "email": f"leak-{uuid.uuid4().hex[:8]}@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": secret,
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
        },
        ["body", "auth_key_b64"],
        "string_too_short",
        id="auth_key_b64",
    ),
    pytest.param(
        "/api/auth/register",
        lambda secret: {
            "email": f"leak-{uuid.uuid4().hex[:8]}@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": secret,
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
        },
        ["body", "recovery_blob_b64"],
        "string_too_short",
        id="recovery_blob_b64",
    ),
    pytest.param(
        "/api/servers",
        lambda secret: {
            "name": f"srv-{uuid.uuid4().hex[:6]}",
            "ip_address": "203.0.113.26",
            "ssh_password_blob_id": secret,
        },
        ["body", "ssh_password_blob_id"],
        "uuid_parsing",
        id="ssh_password_blob_id",
    ),
]


@pytest.mark.parametrize("path,make_body,loc,error_type", DECLARED_SECRET_FIELD_CASES)
@pytest.mark.asyncio
async def test_422_does_not_echo_the_value_of_a_secret_named_field(
    path: str, make_body, loc: list, error_type: str
):
    """Значение секретоподобного поля не возвращается, даже если поле своё."""
    # Нарочно короткий: `auth_key_b64` и `recovery_blob_b64` объявлены с
    # `min_length`, и `string_too_short` — единственная их ошибка, которая
    # вообще доносит значение до ответа. Длинный секрет прошёл бы валидацию, и
    # тест проверял бы уже не эхо, а разбор base64 в самом роуте.
    secret = f"S3cr3t-{uuid.uuid4().hex[:8]}"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        if path != "/api/auth/register":
            await _register_and_login(c, f"leak-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(path, json=make_body(secret))

        assert r.status_code == 422, r.text
        err = next(e for e in r.json()["detail"] if list(e["loc"]) == loc)
        # Ошибка та самая: иначе тест зеленел бы на 422 по другой причине,
        # где секрет и не мог бы появиться.
        assert err["type"] == error_type, r.text
        assert secret not in r.text, "422 вернул значение секретного поля"


@pytest.mark.asyncio
async def test_422_still_shows_what_was_wrong_with_a_declared_field():
    """У ошибок несекретных объявленных полей `input` остаётся на месте.

    Обратная сторона тестов выше, и без неё они толкают к «починке» вида
    «снять `input` вообще»: тогда 422 перестал бы говорить, ЧТО именно
    прислали в порт, и разбор кривого запроса стал бы гаданием.

    `ssh_port` взят не случайно: это поле, которому нечего скрывать. У полей с
    секретоподобным ИМЕНЕМ значение снимается — см.
    `test_422_does_not_echo_the_value_of_a_secret_named_field`.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"forbid-diag-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers",
            json={
                "name": f"srv-{uuid.uuid4().hex[:6]}",
                "ip_address": "203.0.113.24",
                "ssh_port": "not-an-int",
            },
        )
        assert r.status_code == 422, r.text
        err = next(e for e in r.json()["detail"] if e["loc"] == ["body", "ssh_port"])
        assert err["type"] == "int_parsing", r.text
        assert err["input"] == "not-an-int", "422 больше не говорит, что именно прислали"


# ---------------------------------------------------------------------------
# Юниты на сам предикат `_input_is_unsafe_to_echo`.
#
# Тесты выше проверяют признаки по эффекту — через живой запрос, а это round
# trip плюс поход в БД на регистрацию. Признаков стало четыре, комбинаций у
# них больше, чем разумно гонять через сеть, и юнит здесь не замена
# эндпоинт-тестам, а их дешёвое дополнение: форму ошибок, на которых он
# считает, задаёт pydantic, и все эти формы взяты из ответов живого API
# (см. случаи выше), а не придуманы.
# ---------------------------------------------------------------------------

UNSAFE_ERRORS = [
    pytest.param(
        {"type": "extra_forbidden", "loc": ["body", "ssh_password"], "input": "S3cr3t"},
        id="лишнее-поле-значение-и-есть-секрет",
    ),
    pytest.param(
        {"type": "missing", "loc": ["body", "name"], "input": {"ssh_password": "S3cr3t"}},
        id="missing-в-input-всё-тело",
    ),
    pytest.param(
        {"type": "model_attributes_type", "loc": ["body"], "input": [{"ssh_password": "S"}]},
        id="корень-тела-список",
    ),
    pytest.param(
        {"type": "model_attributes_type", "loc": ["body"], "input": '{"ssh_password":"S"}'},
        id="корень-тела-строка",
    ),
    pytest.param(
        {"type": "string_too_short", "loc": ["body", "auth_key_b64"], "input": "hunter2"},
        id="секретное-имя-_b64",
    ),
    pytest.param(
        {"type": "uuid_parsing", "loc": ["body", "ssh_password_blob_id"], "input": "S3cr3t"},
        id="секретное-имя-_blob_id",
    ),
    pytest.param(
        {"type": "string_type", "loc": ["body", "api_key"], "input": 1},
        id="секретное-имя-из-десктопной-конвенции",
    ),
    pytest.param(
        {"type": "string_type", "loc": ["body", "creds", "db_password"], "input": 1},
        id="секретное-имя-вложенное",
    ),
    # `token`/`secret` — маркеры на вырост: плейнтекст-полей с такими именами
    # схемы не объявляют, `ConfirmEmailRequest.token` живёт без `min_length`,
    # и утечки сегодня нет. Она открылась бы молча в день, когда `min_length`
    # там появится, — а `api_token`/`api_secret` до сих пор держались на одном
    # признаке `extra_forbidden`.
    pytest.param(
        {"type": "string_too_short", "loc": ["body", "token"], "input": "e30fa1"},
        id="секретное-имя-token",
    ),
    pytest.param(
        {"type": "string_type", "loc": ["body", "api_secret"], "input": 1},
        id="секретное-имя-secret",
    ),
    # Имя не секретное — секретно то, из-за чего поле отвергают: валидатор
    # `fastpanel_url` срабатывает ровно на userinfo в URL, то есть на пароле
    # панели внутри значения (долг №10).
    pytest.param(
        {
            "type": "value_error",
            "loc": ["body", "fastpanel_url"],
            "input": "https://admin:S3cr3t@1.2.3.4:8888/",
        },
        id="url-панели-с-кредами-внутри",
    ),
]

SAFE_ERRORS = [
    pytest.param(
        {"type": "int_parsing", "loc": ["body", "ssh_port"], "input": "not-an-int"},
        id="порт-строкой",
    ),
    pytest.param(
        {"type": "int_parsing", "loc": ["path", "server_id"], "input": "abc"},
        id="path-параметр",
    ),
    pytest.param(
        {"type": "string_type", "loc": ["body", "name"], "input": 5},
        id="имя-сервера-числом",
    ),
    pytest.param(
        {"type": "missing", "loc": ["body", "ip_address"], "input": None},
        id="missing-без-родителя-в-input",
    ),
]


@pytest.mark.parametrize("err", UNSAFE_ERRORS)
def test_predicate_hides_input(err: dict):
    assert _input_is_unsafe_to_echo(err) is True


@pytest.mark.parametrize("err", SAFE_ERRORS)
def test_predicate_keeps_input(err: dict):
    """Иначе «починка» вида «снять input вообще» прошла бы незамеченной."""
    assert _input_is_unsafe_to_echo(err) is False


# ---------------------------------------------------------------------------
# Юниты на второй фильтр того же ответа — `_without_unrenderable_input`.
#
# Он про другое, чем предикат выше: не «нельзя показывать», а «физически не
# отдаётся». Живут они здесь вместе потому, что применяются к одному и тому же
# словарю ошибки и композируются — редакция секретов вырезает `input`, а этот
# отрабатывает поверх её результата.
#
# Значения ниже не придуманы: каждое доезжает до `input` через живой запрос на
# `POST /servers/{id}/metrics` (`json.loads` в FastAPI принимает `NaN` и
# `Infinity`, а одиночный суррогат — законный `\\uXXXX`-эскейп), и на каждом
# `JSONResponse.render` падает, то есть 500 вместо собранного 422.
# ---------------------------------------------------------------------------

UNRENDERABLE_INPUTS = [
    pytest.param("A\ud800B", id="одиночный-суррогат"),
    pytest.param(float("nan"), id="nan"),
    pytest.param(float("inf"), id="infinity"),
]

RENDERABLE_INPUTS = [
    pytest.param("Ubuntu 22.04.4 LTS", id="обычная-строка"),
    pytest.param(42, id="число"),
    pytest.param(None, id="none"),
    pytest.param({"nested": "value"}, id="словарь"),
]


@pytest.mark.parametrize("value", UNRENDERABLE_INPUTS)
def test_unrenderable_input_is_dropped(value):
    err = {"type": "finite_number", "loc": ["body", "cpu_usage_pct"], "input": value}
    assert "input" not in _without_unrenderable_input(err)
    # Остальные ключи обязаны выжить: без `type`/`loc` клиент не поймёт, что
    # именно не так, и 422 станет бесполезен.
    assert _without_unrenderable_input(err)["type"] == "finite_number"


@pytest.mark.parametrize("value", RENDERABLE_INPUTS)
def test_renderable_input_is_kept(value):
    """Позитивный контроль: фильтр, режущий всё подряд, тоже прошёл бы верхний."""
    err = {"type": "int_parsing", "loc": ["body", "ssh_port"], "input": value}
    assert _without_unrenderable_input(err) == err


def test_guard_repeats_the_renderer_flag_for_flag():
    """Гард обязан повторять рендер точно, иначе мимо него едет 500.

    Проверяется не «правильные ли флаги написаны» (это была бы копия кода), а
    следствие: то, что гард пропустил, обязано отрендериться настоящим
    `JSONResponse`. Ровно этим тестом ловится расхождение любого флага —
    именно на `allow_nan` гард и разошёлся с рендером в прошлый раз.
    """
    for value in ("A\ud800B", float("nan"), float("inf"), "ok", 42, None):
        err = {"type": "x", "loc": ["body", "f"], "input": value}
        kept = _without_unrenderable_input(err)
        payload = jsonable_encoder({"detail": [kept]})
        # Не должно бросать ни на одном из случаев.
        JSONResponse(content=payload).render(payload)


# Расхождения `SECRET_NAME_MARKERS` с десктопным `SECRET_KEY_MARKERS`, которые
# разрешены и расписаны в комментарии у самого кортежа (`app/main.py`).
# Меняешь состав списка — обнови и этот набор, и тот комментарий: тест краснеет
# ровно затем, чтобы правка не прошла мимо объяснения.
DOCUMENTED_MARKER_DIVERGENCES = frozenset({"_b64", "_blob_id", "fastpanel_url"})

_DESKTOP_REDACT_RS = (
    pathlib.Path(__file__).resolve().parents[2]
    / "desktop"
    / "src-tauri"
    / "src"
    / "audit_redact.rs"
)


def test_marker_lists_diverge_exactly_as_documented():
    """Два списка секретоподобных имён расходятся ровно на задокументированное.

    Комментарий у `SECRET_NAME_MARKERS` перечисляет расхождения по пунктам и
    называет их число. Держался этот счёт на внимательности, и дважды её не
    хватило: сначала список разъехался с десктопным, потом фаза 2 добавила
    восьмой маркер и оставила в шапке «их два». Тест переводит перечень из
    обещания в проверяемое утверждение.

    Читается именно Rust-исходник, а не копия списка в тесте: копия разъехалась
    бы с оригиналом тем же способом, каким разъезжается комментарий.

    Skip, если десктопного дерева рядом нет (бэкенд собирают и отдельно от
    него). Это единственная уступка: сравнивать не с чем, а падать из-за
    отсутствия чужого каталога — значит научить команду игнорировать этот тест.
    """
    if not _DESKTOP_REDACT_RS.exists():
        pytest.skip("рядом нет десктопного дерева — сравнивать не с чем")

    source = _DESKTOP_REDACT_RS.read_text(encoding="utf-8")
    match = re.search(r"const SECRET_KEY_MARKERS[^=]*=\s*\[([^\]]*)\]", source)
    assert match, "в audit_redact.rs больше нет SECRET_KEY_MARKERS — тест ослеп"
    desktop = frozenset(re.findall(r'"([^"]+)"', match.group(1)))
    assert desktop, "список маркеров в audit_redact.rs разобран пустым"

    backend = frozenset(SECRET_NAME_MARKERS)
    assert backend - desktop == DOCUMENTED_MARKER_DIVERGENCES, (
        "состав расхождений с десктопным списком изменился — обнови набор здесь "
        "и перечень в комментарии у SECRET_NAME_MARKERS (app/main.py)"
    )
    # Обратное направление — своё утверждение, а не следствие: маркер, живущий
    # только в десктопе, означал бы, что имя глушится в аудите, но эхом в 422
    # возвращается.
    assert desktop - backend == frozenset(), (
        "в десктопном списке появился маркер, которого нет на бэкенде: "
        "имя глушится в аудите, но его значение вернётся клиенту в 422"
    )


@pytest.mark.asyncio
async def test_purging_a_test_user_takes_everything_it_owned_with_it():
    """Уборка пользователей работает — и уносит его хозяйство по FK CASCADE.

    Сама фикстура `_purge_users_registered_by_this_test` ничего не утверждает:
    она чистит в teardown, и её поломка проявилась бы не красным тестом, а
    ростом числа строк в общей dev-БД — то есть примерно никогда. Поэтому
    механизм проверяется здесь явно, на живой строке.
    """
    email = f"purge-{uuid.uuid4().hex[:8]}@example.com"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, email)
        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.27"},
        )
        assert r.status_code == 201, r.text
        server_id = r.json()["id"]

    await _purge_users([email])

    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == email))).scalar_one_or_none()
        assert user is None, "пользователь остался в общей dev-БД"
        server = (await s.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
        assert server is None, "сервер пережил владельца — CASCADE не отработал"
