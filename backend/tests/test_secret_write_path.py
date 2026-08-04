"""Путь записи секрета: плейнтекст → блоб → ссылка на блоб у сущности.

Проверка идёт **по БД и по расшифровке**, а не по тексту ответа. В Спринте 3
ZK-тест утверждал `secret not in response.text` и был зелёным только потому,
что в схеме ответа не было поля под секрет: он остался бы зелёным и в мире, где
рядом живёт плейнтекст-колонка и в неё только что записали пароль. Поэтому
здесь: строка `blob_storage`, строка `servers` целиком (по всем колонкам
маппера, а не по паре запомнившихся имён) и обратное расшифрование блоба.

Шифруем PyNaCl'ом — это та же libsodium `crypto_secretbox_easy`
(XSalsa20-Poly1305) и та же раскладка `nonce (24) || mac (16) || ciphertext`,
что у десктопа (`desktop/src-tauri/src/crypto/aead.rs`). Независимая
реализация того же примитива заодно перепроверяет раскладку.

Чего этот файл НЕ проверяет: что плейнтекст-поле `ssh_password` в теле запроса
отвергается. Сегодня схемы живут с `extra="ignore"` и молча его глотают;
громкий отказ (`extra="forbid"`) — фаза 2 плана
`plans/2026-08-04-sprint4-secret-write-path.md`.

Где кончается автоматика: доказано всё до «десктоп получил обратно исходный
пароль» (вторая половина — в Rust-тестах `sync/http.rs` и `commands/creds.rs`).
Собственно **успешный SSH-коннект этим паролем** автотестом не проверяется —
для него нужен живой сервер, это ручной шаг из чек-листа приёмки в конце
`plans/2026-08-04-sprint4-secret-write-path.md`. Имитацию SSH за приёмку не
выдаём.
"""

import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from nacl.secret import SecretBox
from nacl.utils import random as nacl_random
from sqlalchemy import delete as sa_delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select, update

from app.auth.models import User
from app.blobs.models import BlobStorage
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.server import Server

BLOB_KIND = "ssh_password"


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def seal(plaintext: str, key: bytes) -> bytes:
    """Зашифровать так же, как это делает `vault_put_blob` в десктопе.

    `SecretBox.encrypt` возвращает `nonce || secretbox_easy(...)` — байт в байт
    та раскладка, которую собирает `crypto::aead::encrypt`. Разойдись они —
    десктоп не расшифровал бы то, что лежит на сервере, а тест бы этого не
    заметил.
    """
    return bytes(SecretBox(key).encrypt(plaintext.encode(), nacl_random(SecretBox.NONCE_SIZE)))


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


async def _purge(server_ids: list[int], blob_ids: list[str]) -> None:
    """Убрать за собой напрямую в БД.

    База тестов общая с dev-окружением, а упавший ассерт обрывает тест на
    середине — чистка через API в этот момент сама получила бы 404. Сервер
    удаляем первым: он ссылается на блоб внешним ключом.
    """
    async with AsyncSessionLocal() as s:
        for sid in server_ids:
            await s.execute(sa_delete(Server).where(Server.id == sid))
        for bid in blob_ids:
            await s.execute(sa_delete(BlobStorage).where(BlobStorage.id == uuid.UUID(bid)))
        await s.commit()


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
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    key = nacl_random(SecretBox.KEY_SIZE)
    ciphertext = seal(secret, key)
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
                stored = bytes(blob.ciphertext)
                assert secret.encode() not in stored, "плейнтекст доехал до blob_storage"
                assert stored == ciphertext, "сервер переписал шифротекст — блоб не расшифруется"
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

            # Обратный ход: то, что сервер отдаёт по GET, расшифровывается
            # тем же ключом в исходный пароль. Иначе хранилище «непрозрачно»
            # и для владельца тоже.
            r = await c.get(f"/api/blobs/{blob_id}")
            assert r.status_code == 200, r.text
            returned = base64.b64decode(r.json()["ciphertext_b64"])
            assert returned == ciphertext
            assert SecretBox(key).decrypt(returned).decode() == secret
        finally:
            await _purge(server_ids, [blob_id])


@pytest.mark.asyncio
async def test_has_ssh_flips_only_because_the_blob_id_is_set():
    """`has_ssh` — это ровно «ссылка на блоб не NULL», и ничто иное.

    Флаг рисует в UI зелёную галочку и разрешает SSH-действия. Если он начнёт
    зависеть от чего-то ещё (или от плейнтекст-поля, которое сервер молча
    проглотил), пользователь увидит «пароль есть» там, где десктопу нечего
    расшифровывать.
    """
    secret = f"S3cr3t-{uuid.uuid4().hex}"
    key = nacl_random(SecretBox.KEY_SIZE)
    blob_id = str(uuid.uuid4())
    server_ids: list[int] = []

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"swp-hs-{uuid.uuid4().hex[:8]}@example.com")
        try:
            r = await c.put(
                f"/api/blobs/{blob_id}",
                json={"blob_kind": BLOB_KIND, "ciphertext_b64": b64(seal(secret, key))},
            )
            assert r.status_code == 200, r.text

            base = {"ip_address": "203.0.113.21"}
            r = await c.post(
                "/api/servers", json={**base, "name": f"srv-no-{uuid.uuid4().hex[:6]}"}
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

            # Отличие между двумя серверами ровно одно — и оно в БД.
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
