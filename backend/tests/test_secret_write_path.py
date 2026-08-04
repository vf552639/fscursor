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
ниже — по шести схемам, по одной на каждую: `forbid` наследованием не
раздаётся, снятие его с одной схемы должен ловить отдельный ассерт.

Что осталось от перебора колонок после `forbid`. Провалить его независимо
теперь нечем: плейнтекст физически не доходит до сервиса ни при какой правке
сервиса или модели. Он остаётся дешёвой регрессионной сеткой на случай, если
`forbid` кто-то снимет (тогда POST снова пройдёт — и сетка увидит, куда сел
секрет), а доказывает отказ ассерт на 422 и `loc`. **Не удаляй строку
`"ssh_password": secret` из тела запроса** и не превращай отвергнутый POST в
чистый: тогда исчезнет ровно то утверждение, ради которого написан файл.

Где кончается автоматика: доказано всё до «десктоп получил обратно исходный
пароль». Собственно **успешный SSH-коннект этим паролем** автотестом не
проверяется — для него нужен живой сервер, это ручной шаг из чек-листа приёмки
в конце `plans/2026-08-04-sprint4-secret-write-path.md`. Имитацию SSH за
приёмку не выдаём.
"""

import base64
import os
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select, update

from app.auth.models import User
from app.blobs.models import BlobStorage
from app.core.database import AsyncSessionLocal
from app.main import app
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


async def _register_and_login(client: AsyncClient, email: str) -> None:
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
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

            # А так, как шлёт форма сегодня, — 201. Дальше перебор колонок:
            # провалить его теперь может только сервер, который сам достанет
            # плейнтекст (или снятый `forbid` — тогда красным станет ассерт
            # выше, а этот покажет, куда именно сел секрет).
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
# отдельно (на Base его вешать нельзя: ту же базу наследуют `*Response`,
# которые собираются из ORM-объекта), поэтому и снятие его с одной схемы
# обязано ронять свой отдельный случай. Одного теста «на все шесть» не
# хватило бы: он зеленел бы, пока `forbid` остаётся хоть где-то.
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
            await c.delete(f"{path}/{r.json()['id']}")

        assert r.status_code == 422, r.text
        assert _extra_forbidden_locs(r) == [["body", plaintext_field]], r.text

        # Отказ громкий по ИМЕНИ поля, но не по его содержимому. Дефолтный
        # обработчик FastAPI кладёт в 422 ключ `input` — то есть сам пароль,
        # который фронт подставляет в текст ошибки (`api/client.ts`), а тот
        # уходит в тост и в кэш мутаций. Ассерт по тексту здесь уместен, в
        # отличие от осуждаемого в шапке файла: предметом проверки и является
        # само тело ответа, и без `validation_error_without_extra_input`
        # (`app/main.py`) секрет в нём лежит буквально.
        assert secret not in r.text, "422 вернул сам секрет — он уедет в тост и в логи"
