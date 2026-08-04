# Спринт 4 — путь записи блоба секрета (разблокировка фазы A)

Источник: `sprint4.md` в корне. Долг Спринта 3 (12 пунктов) —
`plans/2026-08-03-sprint3-ui-reachability-writeback.md`, итоговый блок.

## Проблема

Пути записи блоба секрета не существует нигде: `encryptBlob` без вызовов,
`vault_put_blob`/`vault_delete_blob` только зарегистрированы, формы шлют плейнтекст в поля,
которых нет в схемах (`extra="ignore"` по умолчанию) → 200 OK и `*_blob_id = NULL`. Ни одна
из 26 Tauri-команд не может отработать.

## Принятые решения (зафиксированы до старта)

1. **Шифрует Rust, не браузер.** `vault_put_blob(user_id, blob_id, blob_kind, plaintext_b64)`
   уже принимает **плейнтекст** и шифрует его `aead::encrypt` мастер-ключом из keychain
   (`commands/vault.rs:29-48`). В `sprint4.md` описан вариант с `encryptBlob` во фронте —
   он расходится с реальной сигнатурой. Берём существующую: плейнтекст не покидает машину
   (Tauri IPC), ключ живёт только в keychain десктопа, во фронт мастер-ключ тянуть не надо.
   `encryptBlob` в `crypto.ts` остаётся тестовым хелпером паритета с Rust.
2. **Секреты вводятся только в десктопе.** Вне Tauri форма с секретом упирается в
   `requireDesktop(...)` — тот же текст, что у остальных «только десктоп» действий.
3. **Baseline тестов на старте спринта:** pytest 51 passed / 1 failed
   (`test_mutation_audit.py::test_config_key_owned_by_another_user_cannot_be_overwritten` —
   падал **до** спринта), vitest 165 passed, cargo 112 passed.
4. **Реальный SSH-коннект в приёмке — ручной шаг.** Автотесты доказывают эффект по БД
   (ciphertext в `blobs`, `*_blob_id` заполнен, расшифровка возвращает исходный секрет);
   подключение к живому серверу проверяет человек по чек-листу в конце плана.
5. Фаза 6 (`долг №7–12`) вынесена в отдельный cleanup-спринт — по решению `sprint4.md`.

## Фазы

- [ ] **1a. Тонкий срез: SSH-пароль сервера.**
  - [x] T1 — `frontend/src/lib/secretBlob.ts`: `putSecretBlob` / `deleteSecretBlob` + юнит-тесты.
        Коммиты `ac18338`, `40821e2`, `e9309e2`. Оба ревью пройдены (spec + качество).
  - [x] T2 — проводка SSH-пароля: `pages/Servers.tsx` (вкладка install), `pages/ServerDetail.tsx`.
        Коммиты `ed658d6`, `ee14b86`, `c208165`. Spec-ревью пройдено дважды;
        **финальное ре-ревью качества по `c208165` не проводилось** — начать с него.
  - [x] T3 — приёмка по эффекту: backend-тест (ciphertext в БД, `ssh_password_blob_id`
        заполнен) + Rust-тест круга шифрования блоба. Мутационная проверка.
        Коммиты `e0f7cf2`, `8c293d9`. Попутно вскрыта и закрыта дыра: мутация
        `let ct = pt.clone()` в `vault.rs` оставляла все 115 Rust-тестов зелёными —
        шаг шифрования разъят в `put_blob_encrypted` и теперь покрыт.
- [ ] **1b. Развернуть паттерн** — `fastpanel_password`, регистратор (`api_key`/`api_secret`),
      Cloudflare (`api_token`); правка секрета = перезапись того же `blob_id`, удаление
      сущности → `vault_delete_blob`.
  - [x] 1b-1 (фундамент) — коммиты `dc06d06`, `5cc8a5a`. `useMultiSecretSave`/`saveAll` на
        несколько секретов под один POST; `persist` сужен до `Promise<void>`;
        `RegistrarAccountResponse` отдаёт `api_key_blob_id`/`api_secret_blob_id` (без них
        форма правки не знала бы, какой блоб перезаписывать). **Spec-ревью пройдено с
        находкой, находка закрыта; ре-ревью по `5cc8a5a` и ревью качества не проводились —
        начинать с них.**
  - [ ] 1b-2 (проводка форм) — вкладка connect в `Servers.tsx` (`fastpanel_password`),
        `Settings.tsx` (регистратор), `Cloudflare.tsx` (`api_token`); удаление сущности →
        `vault_delete_blob`; заодно вычистить ставшие мёртвыми плейнтекст-поля из TS-типов.
- [ ] **2. Громкий провал** — `extra="forbid"` на `ServerCreate/Update`, `CloudflareAccount*`,
      `RegistrarAccount*`; плейнтекст-поля вон из TS-типов и тел запросов.
  - [ ] Обязательно вместе с этим: `tests/test_secret_write_path.py` — оба теста шлют
        `ssh_password` и ждут `201`; после `forbid` это станет `422`. Менять на ассерт
        `422` + `loc == ["body","ssh_password"]`, а НЕ убирать поле из тела: без замены
        ассерта перебор колонок станет нефальсифицируемым — тот самый холостой тест,
        против которого написан весь файл.
- [ ] **3. Опасные пути** — `sdmp://bulk-provision` через гейт подтверждения с возвратом
      результата (№3); проверки существования БД/FTP-аккаунта до создания (№5).
- [ ] **4. Видимость упавшего provision** — писать `last_provision_error` до раннего возврата,
      показать в UI (№4).
- [ ] **5. Честность ZK-тестов** — проверка по БД вместо `secret not in r.text`, позитивный
      контроль URL для кросс-юзерных 404, мутационная проверка (№6).

## Чек-лист ручной приёмки (сквозной сценарий)

Завести сервер с SSH-паролем → Install FastPanel → завести домен → CF DNS-редактор
(A-запись) → Set NS → Provision с `withDb` → повтор (гарды `site_exists`/`ssl_exists`/
«уже установлено») → упавший provision виден как «Last error». В БД плейнтекст-секретов нет,
`*_blob_id` заполнены, blob'ы расшифровываются.

## Что построено к паузе (T1 + T2)

- `frontend/src/lib/secretBlob.ts` — `putSecretBlob({plaintext, blobKind, existingBlobId})` и
  `deleteSecretBlob`. `blobKind` — union `BlobKind`, `existingBlobId` обязателен и nullable:
  перепутать соседние `string`-аргументы было нельзя допустить, иначе пароль уехал бы в
  `blob_storage.blob_kind` и в `audit_log.metadata`.
- `frontend/src/hooks/useSecretSave.ts` — общая церемония для всех форм с секретом: плейнтекст
  живёт в хуке (не в стейте страницы), порядок «блоб → сущность», единый текст ошибки,
  `saving` держится по промису `mutateAsync`. Фаза 1b обязана переиспользовать его, а не
  копировать код форм.
- `frontend/src/components/DesktopOnlyNote.tsx` — один вид у фразы `desktopOnly(...)`.
- `frontend/src/test/secretBlobKit.ts` — общие тестовые хелперы (`setTauri`, `putBlobArgs`).
- SSH-пароль проведён в `pages/Servers.tsx` (вкладка install) и `pages/ServerDetail.tsx`;
  `ssh_password` удалён из `ServerCreate`/`ServerUpdate` — теперь это ошибка типа.

Тесты на паузе: vitest **193 passed** (было 165 на старте спринта); pytest и cargo не
трогались с baseline.

### Новый долг, найденный по дороге (в cleanup-спринт)

- `npm run build` (`tsc && vite build`) **уже красный** от 51 предсуществующей ошибки
  (`Cloudflare.tsx` 14, `Settings.tsx` 9, `Servers.tsx` 9, `lib/crypto.ts` 9,
  `ServerDetail.tsx` 7, `Notifications.tsx` 2, `UnlockModal.tsx` 1 — в основном `TS7006`).
  Следствие: типовые гарды не роняют сборку, потому что ронять нечего. Нужен зелёный
  `tsc` и отдельный скрипт `typecheck`.
- `registrar_service.py:57-67` применяет `api_*_blob_id` только при `not None`, а
  `exclude_unset` делает явный `null` в PUT неотличимым от отсутствия поля → снять секрет
  регистратора через PUT нельзя. Всплывёт в 1b-2, если форме понадобится «убрать секрет».
- Во `frontend/` нет eslint вообще (ни `eslint.config.*`, ни `.eslintrc*`, ни секции в
  `package.json`) — значит `no-floating-promises` и подобные страховки не работают. Отсюда
  рантайм-гвард на вложенный `save` вместо расчёта на линтер.
- Мёртвые deep link'и, предсуществующие: `add-server`, `ssh-test`, `refresh-metrics`,
  `sync-domains`, `delete-server` в `ServerDetail.tsx`/`Servers.tsx` и вся
  `BulkActionToolbar.tsx` — хосты, которых `parseDeepLinkAction` не знает: ссылка ведёт в
  `{handled:false}` и только тостит.

## Итог

_Заполняется по завершении спринта._
