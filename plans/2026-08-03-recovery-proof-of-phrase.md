# Recovery: доказательство владения recovery-фразой

> Найдено ZK-sweep'ом Спринта 2. Вариант починки выбран пользователем: **доказательство
> recovery-фразы** (не почтовый токен, не отключение эндпоинта).

**Статус:** [~] фазы 1–4 сделаны, фаза 5 — автотесты прогнаны, ручной прогон не выполнен

## Проблема

`POST /api/auth/recovery/finish` (`backend/app/auth/routes.py:193`) принимает
`RecoveryFinishRequest = { email, new_salt_b64, new_auth_key_b64, new_recovery_blob_b64 }`
(`backend/app/auth/schemas.py:48`) — **и больше ничего**. Ни зависимости аутентификации, ни
доказательства владения recovery-фразой, ни rate-limit (`@limiter.limit` в этом файле стоит
только на `login/finish`, строка 97).

Обработчик находит пользователя по email и безусловно перезаписывает `salt`, `auth_key_hash`,
ciphertext recovery-блоба, затем удаляет все сессии.

**Последствие:** любой, кто знает зарегистрированный email, навсегда лишает владельца входа
**и уничтожает recovery-блоб**. Блобы в `blob_storage` остаются зашифрованными на старом
мастер-ключе — данные не восстановит уже никто, включая владельца. Это не кража доступа
(прочитать данные атакующий не сможет), а необратимое уничтожение.

Существующий тест `backend/tests/test_auth_recovery.py:44-53` выполняет ровно этот вызов без
каких-либо учётных данных и ожидает 200 — то есть уязвимость зафиксирована как ожидаемое поведение.

## Решение

Клиент выводит из recovery-фразы отдельный `recovery_auth_key` (Argon2id с доменным разделением,
по образцу существующих `sdmp-auth-key-v1` / `sdmp-master-key-v1` в
`desktop/src-tauri/src/crypto/kdf.rs:40`). Сервер хранит только его bcrypt-хеш и требует
предъявить ключ при `recovery/finish`. Zero-knowledge сохраняется: сервер по-прежнему не может
ни расшифровать блоб, ни восстановить фразу, но провести восстановление может только тот, кто
фразой владеет.

## Фазы

- [x] **Фаза 1 — модель и миграция.** Колонка `recovery_blob.recovery_auth_key_hash`
      (BYTEA, nullable) — не на `users`: креденшл и блоб, который он авторизует, живут
      одной строкой, создаются/переписываются/удаляются вместе, «recovery настроен» —
      одно условие, а не инвариант на две таблицы. Миграция
      `014_recovery_auth_key` поверх `013_drop_ssl_email_pool`; `EXPECTED_ALEMBIC_HEAD`
      поднят в том же коммите. **`alembic upgrade head` на dev-БД ещё не выполнен.**
- [x] **Фаза 2 — установка ключа.** `recovery_auth_key_b64` обязателен в
      `POST /auth/register`. Добавлен `POST /auth/recovery/setup` (сессия +
      текущий `auth_key_b64` как step-up) — единственный способ для NULL-хеша снова
      получить право на восстановление; без него сообщение «переустановите recovery»
      было бы враньём. Политика для NULL-хеша: `recovery/finish` отвечает **409** с
      инструкцией, разового пропуска нет.
- [x] **Фаза 3 — проверка при восстановлении.** `recovery/finish` требует
      `recovery_auth_key_b64`, сверяет bcrypt'ом (`verify_auth_key`) **до первой мутации**;
      неизвестный email и неверный ключ дают одинаковый 401 (плюс фиктивный bcrypt для
      выравнивания тайминга), NULL-хеш — 409. Rate-limit: `finish` 5/минуту,
      `start` 10/минуту (он же — неаутентифицированная выдача salt и блоба).
      `test_auth_recovery.py` переписан: успех, 401 на неверный ключ с проверкой, что
      salt/auth_key_hash/блоб/сессии не изменились, 422 без ключа, 401 на чужой email,
      409 на NULL-хеш, ротация хеша через `new_recovery_auth_key_b64`, setup-флоу.
- [x] **Фаза 4 — клиенты.** Вывод ключа: `kdf::derive_recovery_auth_key` +
      `normalize_recovery_phrase` (Rust) и `deriveRecoveryAuthKey` +
      `normalizeRecoveryPhrase` (TS) — Argon2id, фиксированная соль `sdmp-recovery-v1`,
      контекст `sdmp-recovery-key-v1`. Паритет зафиксирован фикстурой в обоих тестах:
      фраза `abandon ×23 art` → `reJBXXNBI6uFBH1umkSAzylaw8qSkV8PA2GPnlSBa+k=`.
      `http.rs`: `recovery_auth_key_b64` в register и recovery/finish (+
      `new_recovery_auth_key_b64: null`, фраза при восстановлении не меняется), новый
      `recovery_setup()`. `commands/auth.rs`: `auth_register`/`auth_recovery` шлют ключ,
      добавлена команда `auth_recovery_setup(password)` (зарегистрирована в `lib.rs`).
      Коды 401/404+409/429 переводятся в понятный текст в Rust
      (`describe_recovery_error`) и в TS (`lib/recoveryError.ts`); там же чинится
      `[object Object]` — Tauri отдаёт `CommandError` как `{"Api": "…"}`, а страницы
      печатали `String(e)`.
      **UI-пути для `recovery/setup` нет**: `RecoverySetup.tsx` — экран «запишите фразу»
      после регистрации, серверных вызовов не делает; команда `auth_recovery_setup`
      готова, но её никто не вызывает — экран для ~360 легаси-аккаунтов (NULL-хеш) ещё
      нужно сделать, иначе текст 409 «настройте recovery заново» некуда вести.
- [~] **Фаза 5 — приёмка.** Автотесты: `cargo test` 75 passed / 1 ignored (было 67/1),
      `npx vitest run` 61 passed в 10 файлах (было 53 в 9), `npx tsc --noEmit` 51 ошибка
      (ровно преэкзистующий долг), backend не трогали (45 passed). Ручной прогон
      (настроить recovery → выйти → восстановиться по фразе → войти новым паролем)
      **не выполнен**.

## Итоговый блок

Реализовано целиком по бэкенду и клиентам (фазы 1–4). Осталось:

1. UI для `POST /auth/recovery/setup` — без него легаси-аккаунты с NULL-хешем не могут
   вернуть себе право на восстановление, а команда `auth_recovery_setup` остаётся
   невызванной.
2. Ручной сквозной прогон восстановления (фаза 5).
