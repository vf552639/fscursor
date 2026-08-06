# План: Мониторинг доступности серверов раз в 6 часов

**Дата:** 2026-08-06
**Связь с бизнесом:** продукт — «пульт управления инфраструктурой» для power-user'а,
ведущего десятки–сотни серверов (`.business/audience/`). Без фонового мониторинга статус
связи — это снимок на момент ручного клика «SSH Test», и упавший сервер обнаруживается
случайно. Автопинг раз в 6ч превращает «жив/упал» в живой сигнал: пользователь узнаёт о
падении, даже когда не смотрит на страницу.

## Что решили на этапе brainstorming

Развилки закрыты явно (см. рефлексию сессии):

1. **Что мониторим:** только **доступность** (TCP-порт 22), без пароля. Это обходит
   zero-knowledge стороной — пароль расшифровывается лишь в разблокированном десктопе, а
   TCP-проверка ключа не требует и потому может крутиться на бэкенде 24/7. Полный SSH-вход
   (проверка, что наши креды ещё работают) сознательно **не** делаем — он потребовал бы
   открытого десктопа.
2. **Механизм проверки:** `asyncio.open_connection(ip, ssh_port)` с таймаутом. НЕ ICMP-ping
   (режется файрволами → ложные «упал»). Открытый порт 22 = «по серверу реально можно
   работать».
3. **Где крутится:** существующий **Celery-beat** (`app/core/celery_app.py` уже настроен,
   воркер уже есть). НЕ заводим второй планировщик.
4. **Порог падения:** статус `down` только после **2 неудач подряд** + короткий ретрай
   внутри одной проверки. Гасит ложные тревоги от мгновенной сетевой икоты.
5. **Как доходит до пользователя:** запись в существующую систему **уведомлений** (колокольчик
   в UI + внешний диспатч) на **переходах** состояния (up→down, down→up) ПЛЮС цвет статуса на
   карточке сервера (фронт уже это рисует).
6. **Интервал:** ровно 6 часов.

## Задел, который уже есть в коде (не переписываем — заполняем)

- **Поля модели** `Server.last_check_at`, `last_check_ok`, `last_check_error`
  (`backend/app/models/server.py:63-65`) — уже в БД, в схеме `ServerResponse`
  (`backend/app/schemas/server.py:204-206`) и в типе фронта (`frontend/src/api/servers.ts:44-46`).
  Сейчас их **никто не заполняет**.
- **Фронт уже рисует результат:** `last_check_ok === false || status === "error"` → красная
  точка + `last_check_error` в тултипе (`frontend/src/pages/Servers.tsx:325`,
  `frontend/src/pages/ServerDetail.tsx:197`). То есть UI готов; нужен только источник данных.
- **Уведомления:** `notification_service.create_notification(...)` с `dedup_key`,
  `on_conflict_do_nothing` и диспатчем во внешние каналы
  (`backend/app/services/notification_service.py:114`).
- **Шаблон задачи:** `backend/app/tasks/renewal_task.py` — `asyncio.run(_impl())`,
  `AsyncSessionLocal`, обход сущностей, `TaskLog` в конце. Копируем структуру.
- **Beat:** `backend/app/core/celery_app.py:24` — добавляем одну запись расписания.

## Acceptance criteria (что значит «готово»)

- [ ] Раз в 6 часов Celery-beat запускает задачу проверки всех серверов с `user_id IS NOT NULL`.
- [ ] Проверка = TCP-connect на `ip_address:ssh_port` с таймаутом 5с и одним ретраем через ~2с.
- [ ] Успех: `last_check_ok=True`, `consecutive_failures=0`, `last_check_at=now`,
      `last_check_error=NULL`.
- [ ] Неудача: `consecutive_failures += 1`, `last_check_at=now`, `last_check_error`=текст.
      Статус `last_check_ok` роняется в `False` **только** при достижении 2 промахов подряд.
- [ ] Уведомление `server_down` создаётся ровно один раз на эпизод падения (переход
      «был жив → подтверждённо упал»), `server_up` — на переход «был упавшим → снова жив».
      Повторные прогоны в том же состоянии новых уведомлений НЕ плодят (дедуп).
- [ ] Проверки серверов идут параллельно с ограничением одновременности (не последовательно).
- [ ] Прогон пишет строку в `TaskLog` (`task_type="server_monitor"`): проверено / упало / поднялось.
- [ ] На карточке сервера видно «проверено N назад» из `last_check_at`.
- [ ] Юнит-тесты на логику переходов зелёные; настоящие TCP-соединения в тестах не открываются.

## Edge cases (продумать заранее)

- **Ноль серверов / только веб-серверы без user_id:** задача отрабатывает вхолостую, пишет
  `TaskLog` «checked 0», не падает.
- **Сотни серверов:** последовательные 5-секундные таймауты = минуты и риск `task_time_limit`
  (60 мин). Отсюда параллельность с semaphore (≈20 одновременно).
- **Мгновенная сетевая икота на воркере:** гасится ретраем + порогом 2 промаха. Одиночный
  промах не роняет статус и не шлёт уведомление.
- **Флаппинг (сервер то жив, то нет):** уведомления только на переходах + `dedup_key`,
  привязанный к эпизоду, — не даёт спамить каждые 6ч.
- **Идемпотентность/гонки:** beat не запускает вторую копию, пока первая идёт (обычная
  практика; при желании — `singleton`-lock, но для 6ч-интервала перекрытие маловероятно).
  Запись полей — простой `UPDATE` по `id`, без гонок между серверами.
- **Zero-knowledge:** проверка НЕ трогает пароль/блоб/keychain — только TCP-порт. Плейнтексту
  утекать неоткуда: его в этом пути просто нет. `last_check_error` содержит текст сетевой
  ошибки (`timeout`, `connection refused`), не секреты.
- **Смена IP/порта сервера:** проверка всегда читает актуальные `ip_address`/`ssh_port` из БД.
- **`consecutive_failures` на старых строках:** миграция ставит `DEFAULT 0 NOT NULL`, backfill
  нулём — существующие серверы стартуют как «промахов нет».

## Модель состояния (семантика полей)

| Ситуация | `consecutive_failures` | `last_check_ok` | Уведомление |
|---|---|---|---|
| Порт ответил | → 0 | → True | если было `False` → `server_up` |
| 1-й промах подряд | → 1 | без изменений | нет (статус не роняем) |
| 2-й промах подряд | → 2 | → False | если было не-`False` → `server_down` |
| 3-й+ промах | → 3,4… | остаётся False | нет (дедуп) |

`last_check_ok === False` = «подтверждённо упал» — ровно то, что фронт уже красит красным.
Первый транзиентный промах в это состояние не протекает.

## Фазы

### Фаза 1 — Миграция: поле-счётчик  `[x]`
- Alembic-миграция: `servers.consecutive_failures INT NOT NULL DEFAULT 0` (backfill 0).
- Добавить поле в `Server` (`backend/app/models/server.py`). В `ServerResponse` **не** тащим —
  фронту счётчик не нужен, он читает `last_check_ok`/`last_check_error`.
- Файлы: `backend/alembic/versions/016_server_consecutive_failures.py`, `backend/app/models/server.py`.
- Сделано 2026-08-06. Миграция накатана на dev-БД (`alembic current` → `016_...`), проверен и
  откат (`downgrade -1` → `upgrade head`). Вместе с миграцией обновлён
  `EXPECTED_ALEMBIC_HEAD` в `backend/app/main.py` — иначе страж lifespan роняет старт API
  (это ловит `tests/test_lifespan.py`).

### Фаза 2 — Проверка доступности (чистая функция)  `[x]`
- `backend/app/services/server_monitor.py`: `async def probe(host, port, timeout=5.0) -> tuple[bool, str|None]`
  на `asyncio.open_connection` + `asyncio.wait_for`; при неудаче — один ретрай через ~2с;
  корректно закрывает соединение; возвращает `(ok, error_text|None)`.
- Коннектор вынесен параметром/подменяемой функцией, чтобы тесты не открывали реальный сокет.
- Файлы: `backend/app/services/server_monitor.py`.
- Сделано 2026-08-06. Сигнатура:
  `probe(host, port, timeout=5.0, *, connect=asyncio.open_connection, retry_delay=2.0)`.
  Пауза ретрая тоже параметр — тесты гоняют её нулём, иначе прогон стоил бы 2 секунды на случай.

### Фаза 3 — Логика перехода на один сервер  `[x]`
- В `server_monitor.py`: `async def evaluate(session, server, ok, error) -> "up"|"down"|None`
  — применяет таблицу состояния (счётчик, `last_check_*`), возвращает произошедший переход.
- Уведомления через `notification_service.create_notification(...)`, тип `server_down`/`server_up`,
  `entity_type="server"`, `entity_id=server.id`, `user_id=server.user_id`,
  `dedup_key=f"server_{state}:{server.id}:{episode_marker}"` (маркер эпизода — например
  ISO `last_check_at` первого промаха эпизода), чтобы повторные прогоны не плодили дублей.
- Файлы: `backend/app/services/server_monitor.py`, точки в `notification_service` не меняем.
- Сделано 2026-08-06. Маркер эпизода — `last_check_at` **предыдущей** проверки, снятый до
  перезаписи: на втором промахе подряд это ровно момент первого промаха эпизода. Для `server_up`
  маркер — момент восстановления. `evaluate` не коммитит (это делает вызывающий из фазы 4);
  `create_notification` коммитит сам, когда уведомление реально создано. Сервер без `user_id`
  поля обновляет, но уведомление не шлёт — адресовать некому.

### Фаза 4 — Celery-задача + расписание  `[ ]`
- `backend/app/tasks/server_monitor_task.py` по образцу `renewal_task.py`: выбрать серверы с
  `user_id IS NOT NULL`, прогнать `probe`→`evaluate` **параллельно** (`asyncio.gather` +
  `asyncio.Semaphore(20)`), в конце `TaskLog(task_type="server_monitor", ...)`.
- Зарегистрировать в `app/tasks/__init__.py`.
- Beat: в `celery_app.py` добавить `"check-server-reachability-6h": {"task": "...", "schedule": crontab(minute=0, hour="*/6")}`.
- Файлы: `backend/app/tasks/server_monitor_task.py`, `backend/app/tasks/__init__.py`,
  `backend/app/core/celery_app.py`.

### Фаза 5 — Фронт: свежесть проверки  `[ ]`
- На карточке/детали сервера показать «проверено N назад» из `last_check_at` (относительное
  время). Красный статус и тултип ошибки уже работают — их не трогаем.
- Файлы: `frontend/src/pages/Servers.tsx`, `frontend/src/pages/ServerDetail.tsx` (мелкая правка).

### Фаза 6 — Тесты  `[~]` (частично: фазы 1–3 покрыты, задача из фазы 4 — нет)
- Юнит на `evaluate`: 0→1 промах не роняет и не шлёт; 1→2 роняет + `server_down`; восстановление
  шлёт `server_up`; повтор в том же состоянии — без новых уведомлений (дедуп); ретрай внутри
  `probe` считается одной проверкой.
- Коннектор мокается — реальный TCP не открываем.
- Файлы: `backend/tests/test_server_monitor.py`.
- Сделано 2026-08-06: 13 случаев на `probe` и `evaluate`, БД и сеть не трогаются
  (сессия и коннектор — заглушки). Отдельно проверены: сервер, который никогда не проверялся
  (`last_check_ok = None` не подменяется на `False` первым промахом), разные ключи дедупа у двух
  эпизодов падения, закрытие сокета, таймаут молчащего порта. Тесты прогнаны на мутациях
  реализации (снятый порог, снятый guard, убранный ретрай, незакрытый сокет) — каждая ловится.
- Осталось: тест на саму Celery-задачу (после фазы 4).

## Часть II — метрики «жизни сервера» (добавлено 2026-08-06)

Исполнение плана вскрыло вторую половину той же дыры. Пользователь видит на карточках
`No metrics yet` и прочерки в Uptime/SSD/CPU, а у старых серверов — окаменелости от
30.04.2026. Причина найдена в истории:

- Сбор метрик по SSH жил в `backend/app/services/server_metrics_service.py` и
  `backend/app/tasks/server_health_task.py` (коммит `b148a79`) и был **удалён** переездом на
  zero-knowledge (`5192372`): у бэкенда больше нет SSH-пароля — он лежит блобом под
  мастер-ключом. Собирать метрики с бэкенда теперь **невозможно в принципе**.
- Колонки (`uptime_seconds`, `cpu_usage_pct`, `ram_*`, `disk_*`, `os_pretty`, `kernel`,
  `metrics_collected_at`) остались в модели и в `ServerResponse`, фронт их рисует — но
  писать в них некому.
- `useRefreshMetrics` (`frontend/src/api/servers.ts:266`) до сих пор зовёт
  `POST /servers/{id}/refresh-metrics` — **такого роута на бэкенде нет** (один из «мёртвых
  роутов» из долга Спринта 3).

Отсюда единственная архитектурно допустимая схема (принцип №3 «desktop выполняет, web
смотрит»): **метрики собирает десктоп по SSH и пишет их обратно в бэкенд**. TCP-мониторинг
из части I остаётся независимым — он отвечает на «жив/упал» 24/7 без открытого десктопа,
а метрики появляются, когда пользователь в десктопе нажал «Refresh metrics».

Разделение ответственности, которое фронт обязан показывать раздельно:

| Сигнал | Кто пишет | Когда свеж | Поле |
|---|---|---|---|
| жив/упал | Celery-beat, TCP:22 | всегда, раз в 6ч | `last_check_ok`, `last_check_at` |
| метрики (uptime/CPU/RAM/SSD) | десктоп по SSH | когда открывали десктоп | `metrics_collected_at` |

### Фаза 7 — Бэкенд: приём метрик от десктопа  `[ ]`
- `POST /servers/{id}/metrics` в `backend/app/api/routes/servers.py`: принимает
  `ServerMetricsIn`, пишет поля метрик + `metrics_collected_at=now`, отдаёт `ServerResponse`.
- `ServerMetricsIn` в `backend/app/schemas/server.py` с `extra="forbid"` (как у остальных
  схем записи — см. фазу 2 Спринта 4): только числовые метрики и `os_pretty`/`kernel`/
  `fastpanel_version`. Никаких секретов, никакого `status` — статус пишет только мониторинг.
- Скоуп по `user_id` текущего пользователя, как у прочих роутов серверов; чужой id → 404.
- Диапазоны валидируются (`cpu_usage_pct` 0..100, остальное ≥ 0), иначе кривой парсинг с
  чужой машины уезжает в БД как есть.
- Файлы: `backend/app/api/routes/servers.py`, `backend/app/schemas/server.py`,
  `backend/app/services/server_service.py`.

### Фаза 8 — Десктоп: сбор метрик по SSH  `[ ]`
- `runCollectMetrics(server)` в `frontend/src/api/servers.ts` **по образцу `runSshTest`**:
  `requireDesktop` → `readSecretBlob(ssh_password_blob_id)` → `sshExecWithHostKeyRetry` с
  одной read-only shell-командой → парсинг → `apiPost('/servers/{id}/metrics')`.
- Команда сбора — экспортируемая константа (как `SSH_TEST_COMMAND`), строго read-only:
  `/proc/uptime`, `/proc/stat` или `top -bn1`, `free -m`, `df -B1G /`, `uname -r`,
  `/etc/os-release`. Никаких записей на чужую машину.
- Парсер — **чистая функция** `parseServerMetrics(output)`, тестируемая без SSH.
  Нераспознанное поле = `null`, а не 0: «не смогли снять» не должно выглядеть как «0%».
- Пароль не попадает ни в `variables`, ни в `data` мутации — ровно те же правила, что
  расписаны в JSDoc `runSshTest`.
- `useRefreshMetrics` переписать на этот путь; мёртвый `POST /servers/{id}/refresh-metrics`
  убрать.
- Файлы: `frontend/src/api/servers.ts`.

### Фаза 9 — Фронт: разделить «жив» и «метрики»  `[ ]`
- Кнопка «Refresh metrics» рядом с «SSH Test» в `ServerDetail.tsx` (десктоп-only,
  как соседние desktop-действия), с состояниями pending/ошибка.
- На карточке в `Servers.tsx`: `No metrics yet` только когда `metrics_collected_at === null`;
  если метрики есть — подпись «metrics: N назад», и она визуально отделена от
  «Last check» (мониторинг). Устаревшие метрики (> 24ч) помечены.
- Статус-бейдж не врёт: `last_check_ok === false` → `error` (уже есть), но при
  `last_check_at === null` показывать «не проверялся», а не зелёный `active`.
- Файлы: `frontend/src/pages/ServerDetail.tsx`, `frontend/src/pages/Servers.tsx`,
  `frontend/src/components/ui/Primitives.tsx` (при необходимости — относительное время).

### Фаза 10 — Тесты части II  `[ ]`
- Бэкенд: роут метрик — успех, чужой сервер → 404, лишнее поле → 422 `extra_forbidden`,
  `cpu_usage_pct=101` → 422.
- Фронт (vitest): `parseServerMetrics` на реальном выводе Ubuntu/Debian, на обрезанном
  выводе (частичный `null`), на мусоре; `runCollectMetrics` в вебе → отказ `requireDesktop`.
- Файлы: `backend/tests/test_server_metrics_endpoint.py`,
  `frontend/src/api/servers.metrics.test.ts`.

## Итог

- Реализован целиком: **нет** (в работе).
- Часть I (фазы 1–6) — TCP-мониторинг доступности раз в 6ч.
- Часть II (фазы 7–10) — сбор метрик десктопом и честное их отображение.
- `servercheck.md` в корне — дубль этого плана без части II; канонична версия в `plans/`.
