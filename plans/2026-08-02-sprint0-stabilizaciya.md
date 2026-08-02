# Спринт 0 — Стабилизация и гигиена: план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-НАВЫК — используй
> `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`,
> чтобы выполнять этот план задача-за-задачей. Шаги отмечаются чекбоксами (`- [ ]`).

**Goal:** Довести базу проекта до состояния «зелёные тесты + чистый `git status` + честные
доки», чтобы дальнейшие спринты (ядро исполнения, ZK-инварианты) шли по стабильному фундаменту.

**Architecture:** Спринт не меняет продуктовое поведение. Он: (1) пересоздаёт Python-venv на
3.12, (2) чинит один падающий backend-тест под loguru-intercept, (3) фиксирует накопленный WIP
атомарными коммитами, (4) убирает вводящий в заблуждение крипто-алиас и приводит крипто-доки
в соответствие с реализацией, (5) актуализирует статус-доки. Никаких новых фич.

**Tech Stack:** Python 3.12 + pytest/pytest-asyncio + loguru (backend); Vite + Vitest
(frontend); Cargo (desktop). Крипто — libsodium `crypto_secretbox` (XSalsa20-Poly1305) +
Argon2id (`t=3, m=64MiB, p=1`), web↔desktop байт-совместимо.

**Критерий приёмки всего спринта:** `pytest` (из `backend/`) зелёный; `npm test` (из
`frontend/`) зелёный; `cargo test` (из `desktop/src-tauri/`) зелёный; `git status` чистый.

---

## Карта файлов

| Файл | Что делаем |
|---|---|
| `.venv/` (корень) | Пересоздать на Python 3.12 (сейчас 3.9.6, ломает `enum.StrEnum`) |
| `backend/tests/test_auth_email.py` | Переписать под loguru-sink (сейчас падает на `caplog`) |
| `backend/app/core/logging.py` | Закоммитить WIP как есть (продуктовое поведение сохраняем) |
| `frontend/src/lib/queryError.ts` (+`.test.ts`) | Закоммитить WIP |
| `frontend/src/pages/{Domains,Servers,Settings}.tsx` | Закоммитить WIP (потребители `queryError`) |
| `frontend/vite.config.ts` | Закоммитить WIP (alias `argon2-browser` для прод-сборки) |
| `.gitignore` | Закоммитить WIP (`.business/`) + добавить `celerybeat-schedule` |
| `backend/celerybeat-schedule` | Убрать из git (`git rm --cached`), это runtime-артефакт |
| `desktop/src-tauri/tauri.conf.json` + `gen/schemas/*` | Закоммитить WIP |
| `frontend/src/lib/crypto.ts` | Удалить misnomer-алиас `decryptBlobXChaCha` (нигде не используется) |
| `plan.md` | Привести крипто-спеку к факту (XSalsa20 secretbox, p=1) |
| `docs/CURRENT_STATUS.md` | Пометить как замещённый `AUDIT_2026-08-02.md` |
| `docs/PROJECT_OVERVIEW.md`, `docs/ARCHITECTURE.md` | Баннер «устарело: описывает server-side модель» |

**Важно про порядок:** Задача 1 (venv) — фундамент, без неё не запускается backend-suite.
Задача 2 идёт до фиксации WIP, потому что `logging.py` (WIP) и есть причина падения теста —
их коммитим вместе, зелёными.

---

## Задача 1: Пересоздать `.venv` на Python 3.12

Корневой `.venv` собран на Python 3.9.6 (`.venv/pyvenv.cfg` → `version = 3.9.6`). Код
использует `enum.StrEnum` (`backend/app/core/constants.py`), доступный только с 3.11+. В системе
есть `python3.12` (3.12.2). Все тест-зависимости уже в `backend/requirements.txt` (`pytest==8.3.3`,
`pytest-asyncio==0.24.0`, `loguru==0.7.2`, `httpx==0.27.2`).

**Files:**
- Modify: `.venv/` (пересоздание, в git не входит)

- [x] **Шаг 1: Убедиться, что `python3.12` доступен**

Run: `python3.12 --version`
Expected: `Python 3.12.x`

- [x] **Шаг 2: Удалить старый venv и создать новый на 3.12**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
rm -rf .venv
python3.12 -m venv .venv
```

- [x] **Шаг 3: Установить backend-зависимости**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r backend/requirements.txt
```

Expected: установка без ошибок, в конце `Successfully installed ...`

- [x] **Шаг 4: Проверить версию интерпретатора venv**

Run: `./.venv/bin/python --version`
Expected: `Python 3.12.2`

- [x] **Шаг 5: Проверить, что pytest собирает backend-тесты (импорт `StrEnum` не падает)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/backend
../.venv/bin/python -m pytest --collect-only -q
```

Expected: список тестов без `ImportError` / `SyntaxError`. Возможен `SUPABASE_DB_URL`-warning —
это ок для collect-only.

- [x] **Шаг 6: Коммит не требуется** — `.venv/` не в git. Переходим к Задаче 2.

---

## Задача 2: Починить `test_auth_email.py` под loguru-intercept

**Причина падения.** WIP-правка `backend/app/core/logging.py` добавляет логгер `"app"` в
loguru-intercept с `propagate = False`. `send_confirmation_email` пишет через
`logging.getLogger("app.auth.email")`; из-за `propagate=False` на узле `app` запись не доходит
до корневого логгера, а именно туда pytest-фикстура `caplog` вешает свой хендлер. Значит
`caplog.records` пуст → `assert any("u@example.com" ...)` падает. Продуктовое поведение (роутинг
`app`-логов в loguru, чтобы в dev-режиме был виден confirmation-link) — **правильное, сохраняем**.
Чинить надо тест: перехватывать не через `caplog`, а через временный loguru-sink.

**Files:**
- Modify (WIP, коммитим как есть): `backend/app/core/logging.py`
- Rewrite: `backend/tests/test_auth_email.py`

- [x] **Шаг 1: Воспроизвести падение (red baseline)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/backend
../.venv/bin/python -m pytest tests/test_auth_email.py -v
```

Expected: `test_send_falls_back_to_log_in_dev` — **FAILED** (assert по `caplog.records` не проходит).

- [x] **Шаг 2: Переписать тест на loguru-sink**

Полностью заменить содержимое `backend/tests/test_auth_email.py` на:

```python
import pytest
from loguru import logger as loguru_logger

from app.auth.email import send_confirmation_email
from app.core.config import settings


@pytest.mark.asyncio
async def test_send_falls_back_to_log_in_dev(monkeypatch):
    # В dev-режиме (нет RESEND_API_KEY) письмо не уходит по HTTP, а логируется.
    # logging.py роутит логгер "app" в loguru с propagate=False, поэтому pytest
    # caplog его не видит — перехватываем через временный loguru-sink.
    monkeypatch.setattr(settings, "RESEND_API_KEY", None)

    captured: list[str] = []
    sink_id = loguru_logger.add(lambda m: captured.append(str(m)), level="INFO")
    try:
        ok = await send_confirmation_email("u@example.com", "tok123")
    finally:
        loguru_logger.remove(sink_id)

    assert ok
    assert any("u@example.com" in line for line in captured)
```

- [x] **Шаг 3: Прогнать этот тест — должен пройти**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/backend
../.venv/bin/python -m pytest tests/test_auth_email.py -v
```

Expected: `test_send_falls_back_to_log_in_dev` — **PASSED**.

- [x] **Шаг 4: Прогнать весь backend-suite — должен быть полностью зелёным**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/backend
../.venv/bin/python -m pytest -q
```

Expected: `22 passed` (ранее было `21 passed, 1 failed`). Если какой-то тест требует
`SUPABASE_DB_URL` и падает по отсутствию БД — это отдельный инфраструктурный пропуск, отметь его
в итоговом блоке; целевой `test_auth_email` должен быть зелёным.

- [x] **Шаг 5: Коммит (logging.py WIP + починенный тест вместе)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add backend/app/core/logging.py backend/tests/test_auth_email.py
git commit -m "fix(backend): route app logs to loguru; adapt email test to sink

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 3: Закоммитить frontend WIP (`queryError` + страницы)

`frontend/src/lib/queryError.ts` (+`queryError.test.ts`) завершён и консистентен; страницы
`Domains.tsx`, `Servers.tsx`, `Settings.tsx` — его потребители (импортируют `describeQueryError`).
Коммитим одной логической единицей.

**Files:**
- Add: `frontend/src/lib/queryError.ts`, `frontend/src/lib/queryError.test.ts`
- Modify: `frontend/src/pages/Domains.tsx`, `frontend/src/pages/Servers.tsx`, `frontend/src/pages/Settings.tsx`

- [x] **Шаг 1: Прогнать frontend-тесты (зелёный baseline)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/frontend
npm test
```

Expected: все тесты **passed** (включая `queryError.test.ts`).

- [x] **Шаг 2: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add frontend/src/lib/queryError.ts frontend/src/lib/queryError.test.ts \
        frontend/src/pages/Domains.tsx frontend/src/pages/Servers.tsx frontend/src/pages/Settings.tsx
git commit -m "feat(frontend): accurate query-error copy by HTTP status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 4: Закоммитить build-config WIP и убрать `celerybeat-schedule` из git

`vite.config.ts` — обоснованный alias: `argon2-browser` в прод-сборке подменяется на bundled-min
(инлайнит wasm), под vitest остаётся дефолт. `.gitignore` — WIP добавляет `.business/`. Плюс
`backend/celerybeat-schedule` сейчас **отслеживается** git и постоянно меняется как runtime-артефакт
(мешает чистому `git status`) — убираем из индекса и игнорируем.

**Files:**
- Modify: `frontend/vite.config.ts` (WIP как есть)
- Modify: `.gitignore` (WIP `.business/` + добавить `celerybeat-schedule`)
- Untrack: `backend/celerybeat-schedule`

- [x] **Шаг 1: Добавить `celerybeat-schedule` в `.gitignore`**

Дописать в конец `/Users/andrey/Documents/Python/FS_cursor/.gitignore` строку (если её ещё нет):

```gitignore
# Celery beat runtime state — не должен коммититься
backend/celerybeat-schedule
```

- [x] **Шаг 2: Убрать артефакт из индекса git (файл на диске остаётся)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git rm --cached backend/celerybeat-schedule
```

Expected: `rm 'backend/celerybeat-schedule'`.

- [x] **Шаг 3: Проверить, что frontend-тесты не сломались (vite-alias — только для прод-сборки)**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/frontend
npm test
```

Expected: все тесты **passed** (под vitest `process.env.VITEST` истинно → alias пустой).

- [x] **Шаг 4: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add .gitignore frontend/vite.config.ts
git commit -m "chore: prod argon2-browser alias, ignore .business/ and celerybeat-schedule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 5: Закоммитить desktop WIP (Tauri config + ACL-схемы)

`desktop/src-tauri/tauri.conf.json` (правка путей `../frontend`) и сгенерированные
`gen/schemas/*` (ACL для deep-link плагина) — завершённый WIP.

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`
- Modify: `desktop/src-tauri/gen/schemas/acl-manifests.json`, `capabilities.json`, `desktop-schema.json`, `macOS-schema.json`

- [x] **Шаг 1: Убедиться, что desktop компилируется и тесты зелёные**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/desktop/src-tauri
cargo test
```

Expected: `24 passed; 1 ignored` (ignored — keychain roundtrip, нужен реальный OS keychain),
компиляция без ошибок.

- [x] **Шаг 2: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add desktop/src-tauri/tauri.conf.json desktop/src-tauri/gen/schemas/
git commit -m "chore(desktop): fix frontend paths in tauri.conf, refresh ACL schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 6: Удалить misnomer-алиас `decryptBlobXChaCha`

`frontend/src/lib/crypto.ts:93-94` экспортирует `decryptBlobXChaCha = decryptBlob`. Имя вводит
в заблуждение: под капотом `crypto_secretbox` (XSalsa20-Poly1305), а не XChaCha20. Алиас нигде
не используется (`grep` по `frontend/src` и `desktop` даёт только само определение) — безопасно
удалить.

**Files:**
- Modify: `frontend/src/lib/crypto.ts:93-94`

- [x] **Шаг 1: Подтвердить, что алиас не используется**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
grep -rn "decryptBlobXChaCha" frontend/src desktop
```

Expected: единственное совпадение — `frontend/src/lib/crypto.ts:94` (определение). Если есть
другие — не удалять, а переименовать точки вызова; здесь других нет.

- [x] **Шаг 2: Удалить две последние строки файла**

Удалить из `frontend/src/lib/crypto.ts` строки:

```typescript

/** Alias for callers that followed the Stage 4 plan name; same as `decryptBlob`. */
export const decryptBlobXChaCha = decryptBlob;
```

Файл должен заканчиваться на закрывающую `}` функции `encryptBlob`.

- [x] **Шаг 3: Проверить типы и тесты**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/frontend
npx tsc --noEmit && npm test
```

Expected: `tsc` без ошибок, все vitest-тесты **passed**.

- [x] **Шаг 4: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add frontend/src/lib/crypto.ts
git commit -m "refactor(frontend): drop misleading decryptBlobXChaCha alias

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 7: Привести крипто-спеку к факту реализации (`plan.md`)

Спека в `plan.md` заявляет XChaCha20-Poly1305 и `p=4`. Реальность (подтверждена кросс-парити
фикстурой в аудите): libsodium `crypto_secretbox` = **XSalsa20-Poly1305**, layout
`nonce(24) || mac(16) || ciphertext`, Argon2id `t=3, m=64MiB, **p=1**`. Крипто корректна и
web↔desktop совместима — менять AEAD нельзя (сломает совместимость без выигрыша). **Решение:
обновляем доки под факт.**

**Files:**
- Modify: `plan.md` (строки про `kdf.rs`, `aead.rs`, и упоминание XChaCha20 в списке зависимостей)

- [x] **Шаг 1: Исправить описание `kdf.rs` (parallelism)**

В `plan.md` заменить:

```markdown
   - `kdf.rs` — Argon2id wrapper (`t=3, m=64MiB, p=4`); two contexts (`auth` and `enc`) derived via per-context label appended to password, hashed independently.
```

на:

```markdown
   - `kdf.rs` — Argon2id wrapper (`t=3, m=64MiB, p=1`); two contexts (`auth` and `enc`) derived via per-context label appended to password, hashed independently. (Реализация: `p=1`, согласовано web↔desktop; ранее в спеке ошибочно стояло `p=4`.)
```

- [x] **Шаг 2: Исправить описание `aead.rs` (AEAD + layout)**

В `plan.md` заменить:

```markdown
   - `aead.rs` — XChaCha20-Poly1305 encrypt/decrypt; per-blob random 24-byte nonce; layout `nonce || ciphertext || tag`.
```

на:

```markdown
   - `aead.rs` — libsodium `crypto_secretbox` (XSalsa20-Poly1305) encrypt/decrypt; per-blob random 24-byte nonce; layout `nonce(24) || mac(16) || ciphertext`. (Реализация использует secretbox, не XChaCha20; форматы web↔desktop совпадают побайтно.)
```

- [x] **Шаг 3: Поправить упоминание XChaCha20 в списке зависимостей**

В `plan.md` заменить:

```markdown
4. **Pin dependencies:** `tauri = "2"`, `sodiumoxide` or `dryoc` (libsodium binding for XChaCha20-Poly1305 + Argon2id), `russh = "0.45"`, `keyring = "3"`, `tiny-bip39 = "1"`, `rusqlite = "0.32"` with `bundled-sqlcipher` feature (encrypted local cache), `tokio`, `serde`, `reqwest`.
```

на:

```markdown
4. **Pin dependencies:** `tauri = "2"`, `sodiumoxide` or `dryoc` (libsodium binding for `crypto_secretbox` XSalsa20-Poly1305 + Argon2id), `russh = "0.45"`, `keyring = "3"`, `tiny-bip39 = "1"`, `rusqlite = "0.32"` with `bundled-sqlcipher` feature (encrypted local cache), `tokio`, `serde`, `reqwest`.
```

- [x] **Шаг 4: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add plan.md
git commit -m "docs: correct crypto spec to match impl (secretbox XSalsa20, Argon2id p=1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 8: Актуализировать статус-доки

`docs/CURRENT_STATUS.md` датирован 2026-05-06 и застрял на «Stage 0», хотя реальность —
Stage 4 (источник истины — `docs/AUDIT_2026-08-02.md`). `docs/PROJECT_OVERVIEW.md` и
`docs/ARCHITECTURE.md` описывают старую server-side модель (до разворота на zero-knowledge).
Не переписываем содержимое целиком — вешаем честные баннеры-предупреждения вверху.

**Files:**
- Modify: `docs/CURRENT_STATUS.md` (баннер после заголовка)
- Modify: `docs/PROJECT_OVERVIEW.md` (баннер-предупреждение вверху)
- Modify: `docs/ARCHITECTURE.md` (баннер-предупреждение вверху)

- [x] **Шаг 1: Баннер в `docs/CURRENT_STATUS.md`**

Вставить сразу после первой строки (`# CURRENT STATUS`) блок:

```markdown

> ⚠️ **Замещено `docs/AUDIT_2026-08-02.md`.** Этот файл застрял на Stage 0 (обновлён 2026-05-06),
> тогда как код прошёл Stage 4. Актуальное состояние готовности MVP, прогон тестов и список
> пробелов — в `docs/AUDIT_2026-08-02.md`. Текущий план работ — `plans/`.
```

- [x] **Шаг 2: Баннер в `docs/PROJECT_OVERVIEW.md`**

Вставить в самое начало файла (перед первой строкой) блок:

```markdown
> ⚠️ **Устарело.** Документ описывает раннюю server-side модель. Проект развёрнут на
> **zero-knowledge** архитектуру (секреты шифруются на клиенте, сервер хранит только блобы;
> выполнение — в desktop). Актуально: `CLAUDE.md`, `plan.md`, `docs/AUDIT_2026-08-02.md`.

```

- [x] **Шаг 3: Баннер в `docs/ARCHITECTURE.md`**

Вставить в самое начало файла (перед первой строкой) блок:

```markdown
> ⚠️ **Устарело.** Описывает server-side архитектуру до разворота на zero-knowledge.
> Целевая архитектура (desktop выполняет, web read-only, сервер «слепой») — в `plan.md`
> и `docs/AUDIT_2026-08-02.md`.

```

- [x] **Шаг 4: Коммит**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git add docs/CURRENT_STATUS.md docs/PROJECT_OVERVIEW.md docs/ARCHITECTURE.md
git commit -m "docs: flag stale status/overview/architecture, point to AUDIT_2026-08-02

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Задача 9: Финальная верификация спринта

- [x] **Шаг 1: Backend — зелёный**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/backend
../.venv/bin/python -m pytest -q
```

Expected: `22 passed` (без падений; инфраструктурные пропуски по отсутствию `SUPABASE_DB_URL`, если есть, зафиксировать в итоге).

- [x] **Шаг 2: Frontend — зелёный**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/frontend
npm test
```

Expected: все тесты **passed**.

- [x] **Шаг 3: Desktop — зелёный**

```bash
cd /Users/andrey/Documents/Python/FS_cursor/desktop/src-tauri
cargo test
```

Expected: `24 passed; 1 ignored`.

- [x] **Шаг 4: `git status` чистый**

```bash
cd /Users/andrey/Documents/Python/FS_cursor
git status
```

Expected: `nothing to commit, working tree clean` (кроме, возможно, свежесозданного файла
рефлексии сессии и самого этого плана — их коммитим отдельно по правилам `CLAUDE.md`).

- [x] **Шаг 5: Записать рефлексию сессии**

По правилам `CLAUDE.md` создать `.business/история/2026-08-02-sprint0-stabilizaciya.md`
(задача / как решал / решено да-нет-частично / эффективность / было→стало) и обновить
итоговый блок этого плана.

---

## Итоговый блок

**Статус:** ☑ реализован целиком (2026-08-02).

**Что сделано:**

1. `.venv` пересоздан на Python 3.12.2, зависимости из `backend/requirements.txt` установлены;
   `pytest --collect-only` собирает 22 теста без `ImportError` на `enum.StrEnum`.
2. `backend/tests/test_auth_email.py` переписан на временный loguru-sink (red baseline
   воспроизведён и закрыт); backend-сьют — **22 passed**. Коммит `a801589`.
3. Frontend WIP (`queryError.ts` + `.test.ts` + `Domains/Servers/Settings.tsx`) закоммичен —
   `c2ade89`; vitest — **6 файлов / 16 тестов passed**.
4. `.gitignore` дополнен `backend/celerybeat-schedule`, сам артефакт убран из индекса
   (`git rm --cached`); `vite.config.ts` закоммичен — `a703143`.
5. Desktop WIP (`tauri.conf.json` + `gen/schemas/*`) закоммичен — `8a7a1c7`;
   `cargo test` — **26 passed; 1 ignored**.
6. Misnomer-алиас `decryptBlobXChaCha` удалён из `frontend/src/lib/crypto.ts` — `4ed2f29`.
7. Крипто-спека в `plan.md` приведена к факту (secretbox XSalsa20-Poly1305, `p=1`,
   layout `nonce(24) || mac(16) || ciphertext`) — `e584ca3`.
8. Баннеры «устарело / замещено» проставлены в `docs/CURRENT_STATUS.md`,
   `docs/PROJECT_OVERVIEW.md`, `docs/ARCHITECTURE.md` — `4696fc4`.
9. Финальная верификация зелёная по всем трём сьютам; `git status` доведён до чистого
   отдельным коммитом документации (`CLAUDE.md`, `design-brief.md`, `docs/AUDIT_2026-08-02.md`,
   `plans/`, `stage4.md`, `stage5.md`, `.claude/settings.json`), `.claude/worktrees/` внесён
   в `.gitignore`.

**Что осталось:** ничего из объёма спринта.

**Отклонения от плана (в большую сторону, все безопасные):**

- `cargo test` даёт **26 passed; 1 ignored** вместо ожидавшихся планом 24 — тестов в desktop
  стало больше, все зелёные.
- Плана не хватало на «чистый `git status`»: untracked `CLAUDE.md`, `design-brief.md`,
  `docs/AUDIT_2026-08-02.md`, `plans/`, `stage4.md`, `stage5.md`, `.claude/` задачами 1–8 не
  покрывались. Закоммичены отдельно; активные worktree-чекауты `.claude/worktrees/`
  заигнорены (коммитить их нельзя).
- Коммиты подписаны `Co-Authored-By: Claude Opus 5 (1M context)` вместо указанного в плане
  `Claude Opus 4.8` — по фактической модели исполнителя.

**Открытые вопросы / инфраструктурные пропуски:**

- **`npx tsc --noEmit` падает: 64 строки ошибок.** Это pre-existing долг, не связанный со
  спринтом — проверено сравнением до/после правки `crypto.ts` (64 строки в обоих случаях).
  Природа: `noImplicitAny` на inline-обработчиках (`Cloudflare.tsx`, `Settings.tsx`,
  `Servers.tsx`, `ServerDetail.tsx`, `Notifications.tsx`, `UnlockModal.tsx`), отсутствие
  `@types/node` и декларации модуля `argon2-browser` (`crypto.ts`), а также рассинхрон типов
  `Domain[] / TaskLog[]` против `.items` в `Dashboard.tsx` и `Activity.tsx`. Шаг 3 задачи 6
  ожидал «tsc без ошибок» — это ошибочная посылка плана. **Кандидат в отдельный спринт:
  типизационная гигиена frontend.**
- Backend-тесты, требующие живого `SUPABASE_DB_URL`, не пропускались: все 22 прошли
  (сьют занимает ~2 минуты).
