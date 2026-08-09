# План: доработки вкладки Server

Источник спеки — `task2.md` в корне. Здесь — рабочий план исполнения с фазами.

## Зачем

Выбор «поставить новую панель FastPanel» / «подключить существующую» сейчас сделан
на этапе **добавления** сервера (две вкладки в `Add Server`). Это неудобно: решение
по панели принимается позже, а переключатель загромождает форму. Плюс у сервера нет
способа сменить имя после создания.

Итог: `Add Server` = завести сервер (SSH); на странице сервера без панели — две
кнопки «Install FastPanel» и «Connect Existing FastPanel»; рядом с именем — «✎».

**Бэкенд и `desktop/` не трогаем** — только фронт. `PUT /api/servers/{id}` и
`ServerUpdate` уже поддерживают всё нужное.

## Фазы

- [x] **Фаза 1 — Переименование сервера** (`frontend/src/pages/ServerDetail.tsx`)
  Кнопка «✎» рядом с `<h1>{s.name}</h1>`, модалка «Rename server» с полем Name.
  По образцу provider-модалки: `useUpdateServer`, тело PUT — **только** `name`,
  ошибка в своё состояние (`nameErr`), не в `updateServer.isError`. В вебе вместо
  кнопки — `<DesktopOnlyNote what="Editing servers" />`.
  Тесты: `frontend/src/pages/ServerDetail.rename.test.tsx`.

- [x] **Фаза 2 — Подключение существующей панели** (`frontend/src/pages/ServerDetail.tsx`)
  Вторая кнопка «Connect Existing» в блоке «FastPanel Installation» (при
  `!isFPInstalled`), модалка с полями Fastpanel URL / Login / Password.
  Переиспользуем `fastpanelUrlError`/`fastpanelUserError`, `useSecretSave`,
  `BLOB_KIND.serverFastpanelPassword`. Порядок «блоб → сущность» через
  `fpPassword.save({ ..., persist: updateServer.mutateAsync })`. Префилл URL из
  `s.ip_address`. В вебе — `<DesktopOnlyNote what="Saving secrets" />`.
  Тесты: `frontend/src/pages/ServerDetail.fastpanelconnect.test.tsx`.

- [x] **Фаза 3 — Упростить `Add Server`** (`frontend/src/pages/Servers.tsx`)
  Убрать переключатель вкладок и всю ветку `connect`: состояние `tab`,
  `handleTabChange`, connect-логику `handleIpChange`, `fastpanelPassword`,
  `fastpanelUrl`, импорт `fastpanelUrlError`/`fastpanelUserError` (переезжает
  в `ServerDetail.tsx`), развилку `secret`. Форма создаёт «голый» сервер
  (`fastpanel_status` не шлётся — на бэкенде дефолт `not_installed`).
  Обновить затронутые тесты: `Servers.fastpanelblob.test.tsx` (удаляется — его
  покрытие переезжает в тест Фазы 2), `Servers.sshblob.test.tsx`,
  `Servers.provider.test.tsx`.

## Проверка

- `npm test` во `frontend/` — зелёный (baseline: 53 файла / 478 тестов).
- `npm run build` во `frontend/` — без «висящих» импортов после чистки.
- Ручная проверка в десктопе: rename → имя обновилось в заголовке, хлебных
  крошках, строке «Name» и в списке; Connect Existing → бейдж «FASTPANEL», блок
  установки сменился карточкой «FastPanel Access» с верным URL и логином;
  Add Server → без вкладок, сервер создаётся с `fastpanel_status = not_installed`.
- В вебе на странице сервера у обеих правок — `DesktopOnlyNote`, а не кнопка;
  там же (и только там) пароль панели читается через `RevealSecret`.

## Итог

**Реализовано целиком.** Три фазы, три коммита на ветке `feat/server-tab-improvements`:

- `3e48ba7` — Фаза 1, переименование сервера;
- `efb622e` — Фаза 2, подключение существующей панели;
- `e9cc514` — Фаза 3, упрощение `Add Server`.

Каждая фаза прошла ревью на соответствие спеке и ревью качества кода (с повторным
прогоном после правок), плюс финальное ревью всей ветки целиком. Отклонений от
спеки `task2.md` нет; сверх спеки добавлены только тесты — по практике проекта.

`npm test` во `frontend/` — **54 файла / 490 тестов** зелёные (было 53 / 478 на
`master`: +12 = +5 rename, +12 fastpanelconnect, +1 sshblob Servers, −5 удалённый
`Servers.fastpanelblob.test.tsx`, −1 provider). `npm run build` (`tsc && vite build`)
проходит. Бэкенд и `desktop/` не тронуты: диф — 10 файлов, все под `frontend/src/`.

### Долг, вскрытый этой работой (кода ветки не касается)

1. **Карточка «FastPanel Access» врёт про подключённую панель.** `fastpanel_port`
   не принимается на правку (его нет ни в `ServerUpdate`, ни в `ServerCreate` —
   только дефолт модели и write-back-схема), поэтому панель, подключённая на
   `https://host:9999`, показывает «Port 8888» прямо под своим же URL. Тем же
   порядком: бейдж версии даёт «v—», а «Protocol: HTTPS» захардкожен, хотя
   `fastpanelUrlError` разрешает и `http://`. Чинится полем на бэкенде.
2. **У подключённой панели нет ни правки кред, ни отмены.** Форма подключения
   достижима только из блока установки (`!isFPInstalled`), а у карточки доступа
   из действий одна «Open FastPanel». Опечатка в URL или логине панели, как и
   подключение не той панели, из интерфейса неисправимы — вернуться в
   `not_installed` нечем. Осознанная YAGNI-граница этой работы (пользователь
   просил только «подключить»), но логичный кандидат в следующую фазу.
3. **`RevealSecret` пароля панели недостижим в десктопе.** Гард
   `f.pw && !isTauri() && s.fastpanel_password_blob_id` показывает его только в
   вебе; в десктопе — единственном месте, где пароль панели можно сохранить, —
   поле отдаёт литерал `"encrypted (hidden)"`, и глазок с `CopyBtn` открывают и
   копируют именно эту строку. Унаследовано от `master`.
4. **Пре-существующее в `Servers.tsx`**: валидация смотрит на `ip.trim()`, а в
   тело POST уезжает сырой `ip` (IP с хвостовым пробелом пройдёт и запишется с
   ним); импорты `CHd`/`CTi`/`CBo` не используются.
5. **`closeSshModal` не стережётся тестом**: `openSshModal` тоже зовёт `reset()`,
   поэтому тест «закрытие забывает пароль» остаётся зелёным и без сброса при
   закрытии. У формы подключения (Фаза 2) та же граница названа вслух
   комментарием; у SSH-формы — нет.
