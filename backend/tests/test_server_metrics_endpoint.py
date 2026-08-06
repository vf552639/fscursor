"""`POST /api/servers/{id}/metrics` — приёмник метрик, снятых десктопом.

Метрики собирает десктоп (у него есть мастер-ключ и SSH), сервер их только
принимает: после переезда на zero-knowledge бэкенд не может залогиниться на
чужую машину, а колонки `servers.uptime_seconds … fastpanel_version` остались
и в модели, и в `ServerResponse`, и в UI. Этот роут — недостающий писатель.

Утверждения идут **по колонкам БД**, а не по телу ответа. Урок записан в шапке
`test_server_provider.py`: ассерт `r.json()["cpu_usage_pct"] == 37` зеленеет от
одного эха запроса и молчит, когда значение до колонки не доехало. Тело ответа
проверяется отдельно и ровно там, где предметом является оно само, — карточка
сервера читает `ServerResponse`, и метрика, правильно лежащая в БД, но не
попавшая в ответ, для UI не существует.

У отказов смотреть в колонку тем более обязательно: 422 сам по себе доказывает
только то, что схема чем-то недовольна. Что записи при этом НЕ произошло —
видно исключительно в БД, и здесь это главное: отвергнутый снимок не вправе
ни переписать прошлый, ни сдвинуть `metrics_collected_at`.
"""

import asyncio
import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update

from app.audit.models import AuditLog
from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.core.validators import (
    FASTPANEL_VERSION_MAX_LEN,
    KERNEL_MAX_LEN,
    OS_PRETTY_MAX_LEN,
    PG_BIGINT_MAX,
    PG_INT_MAX,
)
from app.main import app
from app.models.server import Server

# Снимок целиком — ровно те поля, что умеет прислать десктоп.
FULL_METRICS = {
    "uptime_seconds": 987654,
    "cpu_usage_pct": 37,
    "cpu_count": 8,
    "ram_used_mb": 2048,
    "ram_total_mb": 16384,
    "disk_used_gb": 40,
    "disk_total_gb": 200,
    "net_in_kbps": 120,
    "net_out_kbps": 45,
    "os_pretty": "Ubuntu 22.04.4 LTS",
    "kernel": "5.15.0-105-generic",
    "fastpanel_version": "2.3.1",
}

_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — серверы уедут за ними по FK CASCADE.

    База тестов общая с dev-окружением, а упавший ассерт обрывает тест на
    середине, поэтому уборка живёт в teardown, а не в `finally` каждого случая.
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


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(key)},
    )
    assert r.status_code == 200, r.text


async def _register_and_login(
    client: AsyncClient, email: str, key: bytes = b"\x01" * 32
) -> None:
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
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
    await _login(client, email, key)


async def _create_server(c: AsyncClient, ip: str = "203.0.113.40") -> int:
    r = await c.post(
        "/api/servers",
        json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": ip},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _login_and_create(c: AsyncClient, prefix: str) -> int:
    await _register_and_login(c, f"{prefix}-{uuid.uuid4().hex[:8]}@example.com")
    return await _create_server(c)


# Колонки, за которыми следит файл: сами метрики плюс отметка времени снимка.
METRIC_COLUMNS = tuple(FULL_METRICS) + ("metrics_collected_at",)


async def _stored(server_id: int) -> dict:
    """Значения колонок метрик — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        server = (
            await s.execute(select(Server).where(Server.id == server_id))
        ).scalar_one()
        return {name: getattr(server, name) for name in METRIC_COLUMNS}


async def _stored_sync_version(server_id: int) -> int:
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(Server.sync_version).where(Server.id == server_id))
        ).scalar_one()


def _error_locs(response, field: str) -> list[list[str]]:
    """`loc` ошибок валидации именно про это поле.

    Смотрим на `loc`, а не на голый статус: 422 схема отдаёт и за десяток
    других причин, и тест, довольный любым 422, зеленел бы на опечатке в теле.
    """
    return [list(e["loc"]) for e in response.json()["detail"] if list(e["loc"])[-1] == field]


def _error_types(response) -> set[str]:
    return {e["type"] for e in response.json()["detail"]}


@pytest.mark.asyncio
async def test_metrics_land_in_the_columns_and_come_back_in_the_response():
    """Снимок доезжает до колонок, время ставит сервер, ответ отдаёт свежее.

    Три утверждения в одном месте намеренно: это один и тот же переход, и
    порознь каждое из них нефальсифицируемо. Значения в БД без ответа не видит
    UI; ответ без значений в БД — эхо запроса; и то и другое без
    `metrics_collected_at` означает карточку, которая вечно пишет
    «No metrics yet» поверх свежих чисел.
    """
    before = datetime.now(timezone.utc)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-ok")
        assert (await _stored(server_id))["metrics_collected_at"] is None

        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text

        stored = await _stored(server_id)
        for name, value in FULL_METRICS.items():
            assert stored[name] == value, f"{name}: {stored[name]!r} != {value!r}"

        # Отметку времени ставит сервер, а не клиент: `datetime.now(timezone.utc)`
        # в момент записи. Границы с запасом — тест не про точность часов, а про
        # то, что значение свежее, а не из прошлого прогона.
        collected = stored["metrics_collected_at"]
        assert collected is not None, "сервер не проставил metrics_collected_at"
        assert before - timedelta(minutes=1) <= collected <= datetime.now(timezone.utc) + timedelta(
            minutes=1
        ), collected

        body = r.json()
        for name, value in FULL_METRICS.items():
            assert body[name] == value, f"ответ: {name} = {body[name]!r} != {value!r}"
        assert datetime.fromisoformat(body["metrics_collected_at"]) == collected


@pytest.mark.asyncio
async def test_metrics_of_another_users_server_are_rejected_with_404():
    """Чужой сервер — 404, и ни одна его колонка не меняется.

    С позитивным контролем URL: тот же метод, путь и тело под владельцем
    обязаны дать 200. Без него 404 у чужого не доказывает ничего — его же
    вернула бы опечатка в пути или незарегистрированный роут, и тест «чужому
    нельзя» был бы зелен в мире, где эндпоинта нет вовсе.
    """
    a_email = f"met-a-{uuid.uuid4().hex[:8]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, a_email)
        server_id = await _create_server(c)

        await c.post("/api/auth/logout")
        await _register_and_login(c, f"met-b-{uuid.uuid4().hex[:8]}@example.com", key=b"\x99" * 32)
        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 404, r.text

        stored = await _stored(server_id)
        assert stored["metrics_collected_at"] is None, "чужой снимок всё-таки записался"
        assert stored["cpu_usage_pct"] is None

        await c.post("/api/auth/logout")
        await _login(c, a_email)
        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, (
            f"этот же POST не работает и у владельца — 404 у чужого "
            f"ничего не доказывает: {r.text}"
        )


@pytest.mark.parametrize(
    "extra_field",
    [
        # Время снимка ставит сервер. Присланное клиентом означало бы, что
        # «когда сняли» диктует та же машина, чьи часы могут врать.
        pytest.param("metrics_collected_at", id="metrics_collected_at"),
        # Статус сервера пишет мониторинг, а не сборщик метрик: снявшийся
        # снимок ничего не говорит о том, жив ли сервер по мнению проверки.
        pytest.param("status", id="status"),
        # Инвариант ZK: плейнтекст-секрету в теле запроса делать нечего.
        pytest.param("ssh_password", id="ssh_password"),
    ],
)
@pytest.mark.asyncio
async def test_unknown_field_in_the_body_is_a_refusal_not_silence(extra_field: str):
    """Незнакомое поле — 422 `extra_forbidden`, и снимок не пишется целиком.

    История правила записана в `ServerCreate`: с дефолтным `extra="ignore"`
    форма присылала `ssh_password` плейнтекстом, pydantic молча выбрасывал
    поле, а API отвечал 200 — пользователь видел «сохранено», секрет исчезал.

    Отказ обязан быть полным: остальные поля того же тела валидны, и запись
    «всего кроме лишнего» дала бы снимок, о котором клиент думает одно, а БД
    хранит другое.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-extra")

        r = await c.post(
            f"/api/servers/{server_id}/metrics",
            json={**FULL_METRICS, extra_field: "2026-08-06T10:00:00Z"},
        )
        assert r.status_code == 422, r.text
        assert _error_locs(r, extra_field) == [["body", extra_field]], r.text
        assert _error_types(r) == {"extra_forbidden"}, r.text

        stored = await _stored(server_id)
        assert stored["metrics_collected_at"] is None, "отвергнутый снимок записался"
        assert stored["cpu_usage_pct"] is None


@pytest.mark.parametrize(
    "field,value",
    [
        # Загрузка процессора — доля, а не абсолютная величина: 101% означает
        # промах парсера на чужой машине, а не занятый сервер.
        pytest.param("cpu_usage_pct", 101, id="cpu-выше-100"),
        pytest.param("cpu_usage_pct", -1, id="cpu-отрицательный"),
        # Отрицательных ядер, мегабайт и килобит не бывает: это разбор мусора.
        pytest.param("cpu_count", -1, id="ядра-отрицательные"),
        pytest.param("ram_used_mb", -1, id="память-отрицательная"),
        pytest.param("disk_total_gb", -1, id="диск-отрицательный"),
        pytest.param("net_in_kbps", -1, id="трафик-отрицательный"),
        pytest.param("uptime_seconds", -1, id="аптайм-отрицательный"),
        # Верхняя граница — ширина колонки, а не вкус: `Integer` в Postgres
        # 32-битный, и 2**31 вернулся бы `NumericValueOutOfRange`, то есть 500
        # «внутренняя ошибка» вместо внятного 422 с именем поля.
        pytest.param("ram_total_mb", PG_INT_MAX + 1, id="память-не-влезает-в-int32"),
        pytest.param("uptime_seconds", PG_BIGINT_MAX + 1, id="аптайм-не-влезает-в-int64"),
    ],
)
@pytest.mark.asyncio
async def test_out_of_range_metric_never_reaches_the_column(field: str, value: int):
    """Значение вне диапазона — 422, и прошлый снимок остаётся нетронутым.

    Ассерт по колонке, а не по коду ответа: у отказа проверяется именно то, что
    записи не случилось. Прошлый снимок кладётся до отказа нарочно — «колонка
    пустая» была бы зелёной и в мире, где запись просто не дошла ни разу.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-range")
        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text
        good = await _stored(server_id)

        r = await c.post(f"/api/servers/{server_id}/metrics", json={**FULL_METRICS, field: value})
        assert r.status_code == 422, r.text
        assert _error_locs(r, field) == [["body", field]], r.text

        assert await _stored(server_id) == good, "отвергнутый снимок переписал колонки"


@pytest.mark.parametrize(
    "field,value",
    [
        # Ровно то, что колонка ещё вмещает. Аптайм в секундах у машины,
        # не перезагружавшейся годами, — уже сотни миллионов, так что верхняя
        # граница обязана пропускать настоящие показания, а не только мелкие.
        pytest.param("cpu_usage_pct", 100, id="cpu-ровно-100"),
        pytest.param("ram_total_mb", PG_INT_MAX, id="int32-максимум"),
        pytest.param("uptime_seconds", PG_BIGINT_MAX, id="int64-максимум"),
    ],
)
@pytest.mark.asyncio
async def test_largest_value_the_column_can_hold_is_accepted(field: str, value: int):
    """Верхняя граница чисел проверена и со стороны приёма, не только отказа.

    Соседний тест ловит выход за границу, но зелен и при границе, ужатой до
    абсурда: все числа в `FULL_METRICS` мелкие, и `le=1000` вместо
    `le=PG_INT_MAX` не уронил бы ни одного случая. У строк такая симметрия
    есть с самого начала — здесь она была только с одной стороны.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-max")
        r = await c.post(f"/api/servers/{server_id}/metrics", json={field: value})
        assert r.status_code == 200, r.text
        assert (await _stored(server_id))[field] == value


@pytest.mark.parametrize(
    "field,value,max_len",
    [
        pytest.param("os_pretty", "x", OS_PRETTY_MAX_LEN, id="os_pretty"),
        pytest.param("kernel", "y", KERNEL_MAX_LEN, id="kernel"),
        pytest.param("fastpanel_version", "z", FASTPANEL_VERSION_MAX_LEN, id="fastpanel_version"),
    ],
)
@pytest.mark.asyncio
async def test_free_text_metric_is_bounded_by_the_column_width(
    field: str, value: str, max_len: int
):
    """Ровно ширина колонки проходит, на символ длиннее — 422.

    Граница проверяется с обеих сторон: без верхнего случая проверка длины
    могла бы отвергать вообще всё, без нижнего — лишний символ дошёл бы до
    Postgres и вернулся `StringDataRightTruncation`, то есть 500 вместо 422.
    Строки эти приезжают с чужой машины (`/etc/os-release`, `uname -r`) — там
    ровно та же свободная строка, за которую платил `provider` (долг №10).
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-len")

        exact = value * max_len
        r = await c.post(f"/api/servers/{server_id}/metrics", json={field: exact})
        assert r.status_code == 200, r.text
        assert (await _stored(server_id))[field] == exact

        r = await c.post(f"/api/servers/{server_id}/metrics", json={field: value * (max_len + 1)})
        assert r.status_code == 422, r.text
        assert _error_locs(r, field) == [["body", field]], r.text
        assert (await _stored(server_id))[field] == exact, "слишком длинное значение записалось"


@pytest.mark.asyncio
async def test_control_character_in_free_text_metric_never_reaches_the_column():
    """`\\n` в строковой метрике — 422.

    Значение уезжает в колонку и в UI, а перевод строки внутри него рвёт
    строку лога надвое, и вторая половина выглядит настоящей записью. Ровно
    тот же запрет и по той же причине, что у `provider` и логина панели.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-ctrl")

        r = await c.post(
            f"/api/servers/{server_id}/metrics",
            json={"os_pretty": "Ubuntu 22.04\nDebian 12", "kernel": "5.15.0"},
        )
        assert r.status_code == 422, r.text
        assert _error_locs(r, "os_pretty") == [["body", "os_pretty"]], r.text
        stored = await _stored(server_id)
        assert stored["os_pretty"] is None and stored["kernel"] is None


@pytest.mark.asyncio
async def test_lone_surrogate_in_free_text_metric_is_refused_not_crashed():
    """`"A\\ud800B"` — 422, а не 500 из драйвера.

    Одиночный суррогат — законный JSON (`\\uXXXX`-эскейп), декодер Python его
    пропускает, длина и управляющие символы к нему не придираются. Падает он
    уже внутри запроса: `asyncpg.DataError: surrogates not allowed` — то есть
    после всех проверок, необработанным исключением, 500 с трейсом. Ровно тот
    случай, ради которого границы и заводились.

    Отправляется как `\\ud800` в сыром JSON-теле: `json=` в httpx сериализует
    строку обратно в эскейп, но заголовок и кодирование тела надёжнее задать
    явно — иначе тест зависел бы от того, как именно клиент кодирует
    суррогат.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-surr")

        r = await c.post(
            f"/api/servers/{server_id}/metrics",
            content=b'{"os_pretty": "A\\ud800B"}',
            headers={"content-type": "application/json"},
        )
        assert r.status_code == 422, r.text
        assert _error_locs(r, "os_pretty") == [["body", "os_pretty"]], r.text
        assert (await _stored(server_id))["os_pretty"] is None


@pytest.mark.parametrize(
    "value",
    [pytest.param("", id="пустая"), pytest.param("   ", id="одни-пробелы")],
)
@pytest.mark.asyncio
async def test_blank_free_text_metric_is_refused(value: str):
    """Строка без содержимого — 422, а не `''` в колонке.

    Обоснование (почему отказ, а не тихий `NULL`, как у `provider`) — в
    `ServerMetricsIn._validate_text_metric`. Проверка по колонке: `''` и `NULL`
    в JSON различимы, но в UI «показания есть, и они пустые» и «показаний нет»
    выглядят одинаково, а означают разное.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-blank")

        r = await c.post(f"/api/servers/{server_id}/metrics", json={"kernel": value})
        assert r.status_code == 422, r.text
        assert _error_locs(r, "kernel") == [["body", "kernel"]], r.text
        assert (await _stored(server_id))["kernel"] is None

        # Позитивный контроль: та же форма тела с содержательной строкой
        # проходит — значит 422 выше про пустоту, а не про поле целиком.
        r = await c.post(f"/api/servers/{server_id}/metrics", json={"kernel": "6.1.0-21-amd64"})
        assert r.status_code == 200, r.text
        assert (await _stored(server_id))["kernel"] == "6.1.0-21-amd64"


@pytest.mark.asyncio
async def test_explicit_null_clears_the_metric_but_an_omitted_field_survives():
    """Явный `null` гасит метрику, отсутствующее поле — не трогает.

    Обоснование обеих половин — в `server_service.apply_metrics`, там же
    контракт сборщика; здесь проверяется, что код ему следует. Различение
    повторяет уже принятое в проекте решение по write-back'у provision
    (`test_provision_writeback.py`): сервис патчит
    `model_dump(exclude_unset=True)`.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-null")
        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text

        r = await c.post(
            f"/api/servers/{server_id}/metrics",
            json={"cpu_usage_pct": None, "os_pretty": None},
        )
        assert r.status_code == 200, r.text

        stored = await _stored(server_id)
        assert stored["cpu_usage_pct"] is None, "явный null не погасил протухшее число"
        assert stored["os_pretty"] is None, "явный null не погасил протухшую строку"
        assert stored["ram_used_mb"] == FULL_METRICS["ram_used_mb"], (
            "неприсланное поле затёрлось — клиент, снявший часть метрик, "
            "стирает то, чего не измерял"
        )
        assert stored["kernel"] == FULL_METRICS["kernel"]


@pytest.mark.asyncio
async def test_body_without_a_single_metric_is_refused():
    """Пустое тело — 422, отметка времени на месте. Частичное — законно.

    Почему пустое тело отвергается — в `ServerMetricsIn._at_least_one_metric`;
    почему частичное остаётся законным и что при этом значит отметка — в
    `server_service.apply_metrics`. Обе ветки здесь вместе, потому что они и
    есть граница между этими двумя решениями.

    Частичное тело служит заодно позитивным контролем: без него 422 могло бы
    приходить от чего угодно, вплоть до незарегистрированного роута, и первая
    половина теста была бы зелёной в мире, где эндпоинт не работает вовсе.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-empty")
        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text
        after_full = await _stored(server_id)

        r = await c.post(f"/api/servers/{server_id}/metrics", json={})
        assert r.status_code == 422, r.text
        assert [list(e["loc"]) for e in r.json()["detail"]] == [["body"]], r.text
        assert await _stored(server_id) == after_full, (
            "пустое тело сдвинуло отметку времени — протухшие числа "
            "выглядят снятыми только что"
        )

        r = await c.post(f"/api/servers/{server_id}/metrics", json={"fastpanel_version": "2.4.0"})
        assert r.status_code == 200, (
            f"частичное тело не работает — 422 выше ничего не доказывает: {r.text}"
        )
        stored = await _stored(server_id)
        assert stored["fastpanel_version"] == "2.4.0"
        assert stored["ram_used_mb"] == FULL_METRICS["ram_used_mb"], "дозапись стёрла соседей"
        assert stored["metrics_collected_at"] > after_full["metrics_collected_at"], (
            "приём показаний не обновил отметку времени"
        )


@pytest.mark.asyncio
async def test_metrics_for_a_nonexistent_server_are_404():
    """Несуществующий id — 404, а не 500 из-под `setattr` по `None`.

    Соседний случай с чужим сервером этого не покрывает: там строка есть, и
    отсекает её проверка владельца, а здесь строки нет вовсе.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-gone")
        r = await c.post(f"/api/servers/{server_id + 10_000_000}/metrics", json=FULL_METRICS)
        assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_anonymous_request_is_rejected():
    """Без сессии — 401: снимок пишет владелец, а не кто угодно с id сервера.

    Идентификаторы серверов последовательные, то есть угадываются с первой
    попытки. Роут без зависимости `get_current_user_or_401` позволил бы
    заполнять чужие карточки произвольными числами.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as owner:
        server_id = await _login_and_create(owner, "met-anon")

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as guest:
            r = await guest.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
            assert r.status_code == 401, r.text

        assert (await _stored(server_id))["metrics_collected_at"] is None


@pytest.mark.asyncio
async def test_snapshot_touches_only_its_own_server():
    """Снимок одного сервера не задевает соседний сервер того же пользователя.

    Скоуп по `user_id` про это молчит: оба сервера принадлежат одному
    владельцу, и потерянный `WHERE id = ...` (или запись через `update()` по
    всей выборке пользователя) прошёл бы проверку владельца целиком.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        target_id = await _login_and_create(c, "met-iso")
        neighbour_id = await _create_server(c, ip="203.0.113.41")

        r = await c.post(f"/api/servers/{target_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text

        assert (await _stored(target_id))["cpu_usage_pct"] == FULL_METRICS["cpu_usage_pct"]
        neighbour = await _stored(neighbour_id)
        assert neighbour == dict.fromkeys(METRIC_COLUMNS), (
            f"снимок задел соседний сервер: {neighbour}"
        )


@pytest.mark.asyncio
async def test_metrics_are_handed_to_incremental_sync():
    """Снимок поднимает `sync_version` — иначе десктоп его не увидит.

    Метрики живут в локальном SQLCipher-кэше десктопа, а наполняет его
    `GET /sync/changes?since=`, отбирающий строки по `sync_version > since`.
    Без бампа второй десктоп (и первый после перезапуска) остался бы с
    прочерками при полной колонке в БД.

    Проверка через сам роут синхронизации, а не через сравнение чисел: предмет
    здесь — «строка попала в инкрементальную выдачу», и версия — лишь способ.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-sync")
        version_before = await _stored_sync_version(server_id)

        r = await c.get(f"/api/sync/changes?since={version_before}")
        assert r.status_code == 200, r.text
        assert not [row for row in r.json()["rows"] if row["id"] == str(server_id)], (
            "сервер виден в выдаче ещё до снимка — проверка ниже холостая"
        )

        r = await c.post(f"/api/servers/{server_id}/metrics", json=FULL_METRICS)
        assert r.status_code == 200, r.text

        r = await c.get(f"/api/sync/changes?since={version_before}")
        assert r.status_code == 200, r.text
        row = next((x for x in r.json()["rows"] if x["id"] == str(server_id)), None)
        assert row is not None, "снимок не поднял sync_version — десктоп его не получит"
        assert row["fields"]["cpu_usage_pct"] == FULL_METRICS["cpu_usage_pct"]


@pytest.mark.asyncio
async def test_metrics_leave_an_audit_trail_without_the_values():
    """Приём снимка пишется в аудит, но без самих значений.

    Аудит здесь по общему правилу репозитория: каждый мутирующий роут
    оставляет запись (`server.create/update/delete/bulk_import` — все четыре).
    Роут, молча меняющий строку пользователя, был бы единственным исключением.

    Значений в metadata нет намеренно: `os_pretty`/`kernel` — свободные строки
    с чужой машины, и в аудит-логе им делать нечего. Прочитать их и так можно
    через API, а гард `test_mutation_audit.py` смотрит на ИМЕНА ключей и такой
    ключ пропустил бы.
    """
    marker = f"Ubuntu 22.04 build-{uuid.uuid4().hex}"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id = await _login_and_create(c, "met-audit")
        r = await c.post(
            f"/api/servers/{server_id}/metrics",
            json={**FULL_METRICS, "os_pretty": marker},
        )
        assert r.status_code == 200, r.text

        async with AsyncSessionLocal() as s:
            rows = (
                (
                    await s.execute(
                        select(AuditLog).where(
                            AuditLog.target_type == "server",
                            AuditLog.target_id == str(server_id),
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert any(row.action == "server.metrics" for row in rows), (
            f"приём метрик не оставил следа в аудите: {[r.action for r in rows]}"
        )
        assert all(marker not in str(row.metadata_ or {}) for row in rows), (
            "значение метрики уехало в metadata аудита"
        )
