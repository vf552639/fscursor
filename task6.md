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

## Фаза 1 — Исправление багов  `[ ]`

**1.1 Ложный баннер «zone sync did not complete».**
Бэкенд нигде не делает синхронизацию зон, но `build_account_response`
жёстко зашивает `sync_result=None`/`sync_warning=None`
(`cloudflare_service.py:23-24`), из-за чего во фронте недостижима ветка успеха
(`Cloudflare.tsx:473`) и всегда показывается предупреждение
(`Cloudflare.tsx:481`) — это жёлтый баннер со скриншота.
- Фронт: в create-flow (`Cloudflare.tsx:~470-483`) убрать ветвление по
  `sync_result` и показывать честный success «Cloudflare account created».
- Backend + типы: удалить поля `sync_result`/`sync_warning` из
  `CloudflareAccountResponse` и из `build_account_response`, и из TS-типа
  `CloudflareAccount` (`cloudflare.ts`). (Сцеплено с Фазой 4 — чистка схем.)

**1.2 Вводящее в заблуждение поле «Token: ••••xxxx».**
Это хвост непрозрачного `api_token_blob_id`, а не токена (`Cloudflare.tsx`,
блок строки токена; долг зафиксирован в комментарии там же).
- Убрать строку `Token: {api_token_masked}` из карточки аккаунта (десктоп
  верифицирует токен кнопкой Test; сверять хвост blob-id бесполезно).
  `RevealSecret` для веба (по `api_token_blob_id`) оставить как есть.

**1.3 Потеря priority у MX/SRV при редактировании.**
`client::DnsRecord` (`client.rs:152`) не десериализует `priority`, поэтому
список записей его не возвращает, и форма правки MX/SRV стартует с пустым
полем (`Cloudflare.tsx:867-869`, placeholder «leave empty to keep current»).
- Rust: добавить `pub priority: Option<u16>` в `struct DnsRecord`
  (serde default; Cloudflare отдаёт его только для MX/SRV/URI).
- TS: добавить `priority?: number` в интерфейс `DnsRecord` (`cloudflare.ts:70`,
  снять комментарий-долг на :79).
- Фронт: в `EditDnsRecordModal` префиллить `priority` из записи, чтобы текущее
  значение было видно и не терялось.

## Фаза 2 — Быстрые UX-победы  `[ ]`

**2.1 Бейдж статуса зоны (active/pending/moved).**
Данные уже приходят (`Zone.status`, `cloudflare.ts:66`), но `CfZoneRef`
(`Cloudflare.tsx:30`) их теряет при маппинге (`:146`).
- Добавить `status?: string | null` в `CfZoneRef`, прокинуть в маппинге,
  отрисовать `Badge` в строке зоны (зелёный для `active`, серый/жёлтый для
  `pending`/прочего). Переиспользовать примитив `Badge`.

**2.2 Кнопки «копировать NS» и «копировать zone id».**
Переиспользовать `copyText` из `components/ui/Primitives.tsx:3`.
- В строке зоны: кнопка копирования `z.id`.
- Там, где показываются nameservers зоны (строка зоны и/или модалка NS в
  `CloudflareZoneView`, `Cloudflare.tsx:~555`, `~764`): кнопка «Copy NS»,
  копирующая `nameServers.join("\n")`.

**2.3 Счётчик DNS-записей у зоны — ОТЛОЖЕНО (осознанно).**
Список зон Cloudflare не содержит числа записей; получение потребует по
запросу `cf_list_dns_records` на каждую зону (дорого при 100+ зонах). Число
записей уже видно внутри зоны (StatCard «Records» в `CloudflareZoneView`).
В этот заход не делаем; зафиксировать как возможное будущее (ленивая
подгрузка/кэш).

## Фаза 3 — Поиск/фильтр при масштабе  `[ ]`

**3.1 Поиск по аккаунтам.** Поле поиска над списком в компоненте
`Cloudflare` (default export); фильтр `cfAccounts` по `name`/`account_id`.

**3.2 Поиск/сортировка зон внутри аккаунта.** Небольшое поле поиска в
`AccountCard` (видно, когда карточка развёрнута); фильтр массива `zones` по
имени + сортировка (имя / статус). Список зон уже локальный, доп. запросов нет.

**3.3 «Проверить все токены».** Кнопка в шапке вкладки, которая проходит по
аккаунтам и переиспользует существующий `handleTest(accountId)`
(`Cloudflare.tsx:309`) — только десктоп (`isTauri()`), с учётом уже
имеющегося `testState` per-account.

## Фаза 4 — Чистка техдолга  `[ ]`

**4.1 Мёртвые схемы backend.** В `backend/app/schemas/cloudflare.py` удалить
не используемые нигде схемы: `CloudflareSyncResponse`, `CloudflareTestResponse`,
`ZoneResponse`, `DnsRecordBase/Create/Update/Response`, `NameserversResponse`,
`PurgeResponse`, `CloudflareRaw` (предварительно подтвердить grep’ом отсутствие
импортов). Роут `cloudflare.py` использует только `CloudflareAccount*`.

**4.2 `staleTime` для зон.** `zonesQuery`/`useCloudflareZones`
(`cloudflare.ts:~189`) не задаёт свой `staleTime` → берёт глобальные 10с, и
возврат из DNS-редактора рефетчит зоны всех аккаунтов. Задать разумный
`staleTime` (напр. 60с), чтобы не гонять `cf_list_zones` по всем аккаунтам.

## Тесты

- Фронт (`frontend/`, Vitest, рядом с `Cloudflare.dns.test.tsx`): create-flow
  показывает честный success без warning; статус-бейдж зоны рендерится по
  `Zone.status`; кнопки копирования зовут `copyText`; поиск аккаунтов/зон
  фильтрует; префилл priority в `EditDnsRecordModal`.
- Rust (`desktop/src-tauri`): тест, что `DnsRecord` десериализует `priority`
  из ответа Cloudflare (расширить существующие тесты в `client.rs`).
- Backend (`backend/`, pytest): создание аккаунта возвращает ответ без
  `sync_*`; smoke на схемы после удаления мёртвого кода.

## Верификация

- `cd frontend && npm test && npm run build`.
- `cd desktop/src-tauri && cargo test` (тесты клиента Cloudflare).
- `cd backend && pytest` (или целевые тесты роутов/схем Cloudflare).
- Ручная десктоп-проверка: создать аккаунт → баннер честный, без ложного
  предупреждения; у зон видны статусы; копирование NS/zone id работает; поиск
  аккаунтов/зон фильтрует; «проверить все токены» проходит по всем; правка MX
  показывает текущий priority.

## Порядок и конвенции

- Фазы независимы; рекомендую порядок 1 → 2 → 4 → 3 (баги и дешёвые победы
  раньше; поиск — самый объёмный кусок).
- Первым шагом реализации завести план функции по правилу CLAUDE.md:
  `plans/2026-08-10-cloudflare-доработки.md`, вести статусы фаз, в конце —
  рефлексия в `.business/история/`.
- Прежний `cloudflare-merry-cerf` (сворачивание+счётчик) закрыт отдельной
  веткой; здесь его не дублируем.

## Итог

Реализован: нет (план готов к утверждению). Осталось: Фазы 1–4 (счётчик
DNS-записей на уровне списка осознанно отложен).
