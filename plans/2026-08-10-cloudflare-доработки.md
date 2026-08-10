# План: доработки вкладки Cloudflare (баги + UX + поиск/фильтр + чистка)

## Контекст

Сворачивание аккаунтов и счётчик доменов уже сделаны (ветка
`feat/cloudflare-collapse-count`, план
`plans/2026-08-10-cloudflare-сворачивание-и-счётчик.md`). Разбор кода вскрыл
ещё несколько проблем и пробелов на вкладке Cloudflare. Пользователь выбрал
все четыре направления; баннер синхронизации — убрать ложное предупреждение.

Основные файлы: `frontend/src/pages/Cloudflare.tsx`,
`frontend/src/api/cloudflare.ts`, `backend/app/services/cloudflare_service.py`,
`backend/app/schemas/cloudflare.py`, `desktop/src-tauri/src/cloudflare/client.rs`.

Исходная постановка — `task6.md` в корне. Здесь она оформлена по правилу
CLAUDE.md («одна функция = один план») и ведётся по фазам.

## Фаза 1 — Исправление багов  `[ ]`

**1.1 Ложный баннер «zone sync did not complete».**
Бэкенд нигде не делает синхронизацию зон, но `build_account_response`
жёстко зашивает `sync_result=None`/`sync_warning=None`
(`cloudflare_service.py:23-24`), из-за чего во фронте недостижима ветка успеха
(`Cloudflare.tsx:473`) и всегда показывается предупреждение
(`Cloudflare.tsx:481`).
- Фронт: в create-flow (`Cloudflare.tsx:~470-483`) убрать ветвление по
  `sync_result` и показывать честный success «Cloudflare account created».
- Backend + типы: удалить поля `sync_result`/`sync_warning` из
  `CloudflareAccountResponse` и из `build_account_response`, и из TS-типа
  `CloudflareAccount` (`cloudflare.ts`). (Сцеплено с Фазой 4 — чистка схем.)

**1.2 Вводящее в заблуждение поле «Token: ••••xxxx».**  `[x]`
Это хвост непрозрачного `api_token_blob_id`, а не токена.
- Убрать строку `Token: {api_token_masked}` из карточки аккаунта.
  `RevealSecret` для веба (по `api_token_blob_id`) оставить как есть.
- Сделано: строка и комментарий-долг убраны, блок целиком рисуется только в
  вебе и только при наличии блоба (иначе оставалась бы пустая полоса с кантом).
  Серверное поле `api_token_masked` не тронуто (вычистка — вне объёма).

**1.3 Потеря priority у MX/SRV при редактировании.**
`client::DnsRecord` (`client.rs:152`) не десериализует `priority`.
- Rust: `pub priority: Option<u16>` в `struct DnsRecord` (serde default).
- TS: `priority?: number` в интерфейсе `DnsRecord` (`cloudflare.ts:70`).
- Фронт: в `EditDnsRecordModal` префиллить `priority` из записи.

## Фаза 2 — Быстрые UX-победы  `[ ]`

**2.1 Бейдж статуса зоны (active/pending/moved).**
`CfZoneRef` теряет `Zone.status` при маппинге (`Cloudflare.tsx:146`).
- Добавить `status?: string | null` в `CfZoneRef`, прокинуть в маппинге,
  отрисовать `Badge` в строке зоны.

**2.2 Кнопки «копировать NS» и «копировать zone id».**
Переиспользовать `copyText` из `components/ui/Primitives.tsx:3`.

**2.3 Счётчик DNS-записей у зоны — ОТЛОЖЕНО (осознанно).**
Список зон Cloudflare не содержит числа записей; получение потребует
`cf_list_dns_records` на каждую зону (дорого при 100+ зонах).

## Фаза 3 — Поиск/фильтр при масштабе  `[ ]`

**3.1 Поиск по аккаунтам.** Поле над списком; фильтр по `name`/`account_id`.

**3.2 Поиск/сортировка зон внутри аккаунта.** Поле в развёрнутой `AccountCard`;
фильтр по имени + сортировка (имя / статус).

**3.3 «Проверить все токены».** Кнопка в шапке вкладки, переиспользует
`handleTest(accountId)` — только десктоп.

## Фаза 4 — Чистка техдолга  `[ ]`

**4.1 Мёртвые схемы backend.** Удалить неиспользуемые схемы в
`backend/app/schemas/cloudflare.py`.

**4.2 `staleTime` для зон.** Задать `staleTime` в `zonesQuery` (≈60с).  `[x]`
Сделано: `staleTime: 60_000` в `zonesQuery` — действует на все три хука над
этой записью кэша. Теста нет: глобальный дефолт (10с) в тестовом прогоне тоже
не протухает, и отличить 60с от 10с можно только подкруткой системных часов —
это проверка арифметики TanStack Query, а не нашего кода.

## Тесты

- Фронт (Vitest, рядом с `Cloudflare.dns.test.tsx`).
- Rust (`desktop/src-tauri`, тесты `client.rs`).
- Backend (pytest).

## Верификация

- `cd frontend && npm test && npm run build`
- `cd desktop/src-tauri && cargo test`
- `cd backend && pytest`

## Долг, выявленный по ходу

**Д1. `api_token_masked` больше не читает никто на фронте.** После 1.2 остались
только объявление типа (`frontend/src/api/cloudflare.ts:19`) и фикстуры четырёх
тестов. Вычистить поле из `CloudflareAccountResponse` и `build_account_response`
(`backend/app/services/cloudflare_service.py:16-24`) и из TS-типа. Сцеплено с 4.1
(чистка схем) — делать одним заходом. Адрес поля в схеме —
`backend/app/schemas/cloudflare.py:50`. Правка уронит
`backend/tests/test_cloudflare_account_response.py` (точный набор ключей ответа
и `assert response.api_token_masked == "••••eeee"`) — это не «я что-то сломал», а
часть работы Д1: гард держит «ответ не обещает того, чего сервер не делает».

**Д2. Протухшая строка allowlist**
`backend/tests/test_no_plaintext_secret_schemas.py:94` разрешает
`CloudflareAccountResponse.api_token_masked` с обоснованием «Токен, уже
замаскированный сервером (`****abcd`) для списка в UI». Оба утверждения ложны:
это хвост blob_id, а никакого списка в UI после 1.2 нет. Файл сам настаивает, что
каждая строка списка — «видимый в диффе акт», так что снять её надо вместе с Д1,
а не «когда-нибудь».

## Итог

Реализован: нет (в работе). Осталось: Фазы 1–4.
