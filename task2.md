# План: фикс переходов UI + развитие проекта SDMP

## Context

SDMP — внутренняя панель инфраструктуры (FastAPI + Celery + React SPA без react-router, навигация через `nav(pg, ctx?)` в [frontend/src/App.tsx](frontend/src/App.tsx)). Модульно всё на месте (auth, servers, domains, cloudflare, fastpanel, hostiq, activity, settings, notifications), но на уровне UX много «мертвых» кнопок: иконки и модалки нарисованы, но не подключены. Также на уровне платформы остаются долги из `docs/Bugs.md` и `docs/Roadmap.md` (миграции, тесты, production-grade интеграции).

Документ делится на две части: **(A) Фикс переходов** — минимум, чтобы каждый клик вёл куда должен; **(B) Развитие проекта** — фазы на продакшен-готовность.

---

## A. Фикс переходов — что и где сломано

Принципиальный источник большинства проблем — универсальный компонент [ActionIcons](frontend/src/components/ui/Primitives.tsx:105) принимает только массив иконок, но не onClick-обработчики. Он используется в 3 таблицах и везде работает как картинка.

### A1. Базовая инфраструктура: `ActionIcons` → `RowActions`

**Файл:** [frontend/src/components/ui/Primitives.tsx:105](frontend/src/components/ui/Primitives.tsx:105)

- Расширить сигнатуру: принимать массив объектов `{icon, title, onClick, variant?: 'default'|'danger'}`.
- Сохранить обратную совместимость: если передан `icons: string[]` — рендерить «мёртво», но пометить `data-stub` (визуально не менять).
- Добавить `title`/`aria-label` для доступности.

Альтернатива (чище): сделать новый `RowActions` и удалить старый после миграции вызовов. Рекомендуется.

**Затрагиваемые места использования:** [Domains.tsx:264](frontend/src/pages/Domains.tsx:264), [ServerDetail.tsx:172](frontend/src/pages/ServerDetail.tsx:172), [Cloudflare.tsx:167](frontend/src/pages/Cloudflare.tsx:167).

### A2. Domains — ряд «Edit / Delete»

**Файл:** [frontend/src/pages/Domains.tsx](frontend/src/pages/Domains.tsx)

- Импортировать `useUpdateDomain` и `useDeleteDomain` из [frontend/src/api/domains.ts](frontend/src/api/domains.ts).
- Реализовать `EditDomainModal` (domain_name, purchase_date, expiry_date, server_id, cf_zone_id) по шаблону `AddDomainModal` (строки 28-56). Это задача дублирует п. 9 из [task1.md](task1.md).
- В таблице (строка 264) подключить `RowActions` с `✎ → setEdit(d)` и `✕ → confirm() → del.mutate(d.id)`.
- Сигнатура страницы: добавить проп `onNav?: (pg: string, ctx?: any) => void` + пробросить из [App.tsx:123](frontend/src/App.tsx:123).

### A3. ServerDetail — список доменов на сервере

**Файл:** [frontend/src/pages/ServerDetail.tsx:172](frontend/src/pages/ServerDetail.tsx:172)

- Подключить `RowActions`: `✎` → открыть `EditDomainModal` (тот же, что в Domains), `✕` → удалить домен.
- После успеха — `queryClient.invalidateQueries(['domains', 'server', id])`.

### A4. Cloudflare — account Edit/Delete

**Файл:** [frontend/src/pages/Cloudflare.tsx:24](frontend/src/pages/Cloudflare.tsx:24)

- Кнопки `✎ Edit` и `✕` в строке аккаунта — пустые. Добавить:
  - `EditCfAccountModal` (label, api_token); повторяет структуру `AddCfAccountModal`.
  - `useUpdateCfAccount`, `useDeleteCfAccount` в [frontend/src/api/cloudflare.ts](frontend/src/api/cloudflare.ts) (если не реализованы — добавить).
- Проверить, что бекенд-ручки существуют: [backend/app/api/routes/cloudflare.py](backend/app/api/routes/cloudflare.py) (`PATCH /cloudflare/accounts/{id}`, `DELETE /cloudflare/accounts/{id}`). Если нет — добавить.

### A5. Cloudflare — DNS record Add/Edit/Delete

**Файл:** [frontend/src/pages/Cloudflare.tsx:153-186](frontend/src/pages/Cloudflare.tsx:153)

- Кнопка `🔗 Nameservers` (строка 153) — без обработчика. Вынести в модалку «Nameservers for {zone}» со списком NS-хостов из CF API.
- `Add Record` модалка (строки 166-186): все `<input>` без state, кнопка без onClick. Привязать `useState` для type/name/content/ttl, вызвать `useCreateDnsRecord` (в [frontend/src/api/cloudflare.ts](frontend/src/api/cloudflare.ts)).
- `ActionIcons` строки 167 → `RowActions` с edit/delete по паттерну из A1.

### A6. Settings — Registrars и System Config

**Файл:** [frontend/src/pages/Settings.tsx](frontend/src/pages/Settings.tsx)

- Строки 81-82: `Edit/Delete` registrar — добавить модалку `EditRegistrarModal` + `useUpdateRegistrar`/`useDeleteRegistrar` в [frontend/src/api/hostiq.ts](frontend/src/api/hostiq.ts).
- Строка 135: `Edit` в System Configuration — подключить к API `/settings/config/{key}` (проверить существование в [backend/app/api/routes/settings.py](backend/app/api/routes/settings.py)).

### A7. Topbar

**Файл:** [frontend/src/App.tsx:96, 110, 111](frontend/src/App.tsx:96)

- `Поисковая строка` (стр. 96) — либо подключить к глобальному поиску (фильтровать Servers/Domains/Zones), либо скрыть до реализации. В рамках **A** рекомендуется **скрыть** и оставить на фазу D.
- `☀/🌙` (стр. 110) — дарк-мод. В рамках **A** сделать заглушку: при клике показывать toast «Dark mode coming soon», чтобы не выглядело битым. Полная реализация — фаза D.
- `User dropdown` (стр. 111) — минимально: меню с `Logout` → очистить JWT из localStorage и перезагрузить на login. Остальное (profile, preferences) — фаза D.

### A8. Недостающие `onNav` пропсы

Страницы `Domains` и `Cloudflare` вызываются без `onNav` ([App.tsx:123-124](frontend/src/App.tsx:123)). Добавить проп и пробрасывать — это открывает следующий пункт.

### A9. Переходы из Dashboard/Servers в Domains с фильтром

- Dashboard: на карточке «Domains» при клике — `onNav("domains")`. Проверить, работает ли. Если нет — добавить.
- ServerDetail → «N domains on this server» должен вести в `Domains` с фильтром `?server_id=X`. Сейчас список домен внутри ServerDetail, но связь в обратную сторону отсутствует. Добавить query-param механизм: второй аргумент `nav("domains", {serverId})` и чтение в Domains через проп `ctx`.

### A10. Notifications — кликабельность уведомления

**Файл:** [frontend/src/pages/Notifications.tsx](frontend/src/pages/Notifications.tsx)

Уведомление `domain_renewal` имеет `entity_type=domain, entity_id=X`. Сейчас клик по строке ничего не делает. Добавить переход: `onClick={() => onNav?.("domains", {domainId: n.entity_id})}` + отметить как прочитанное.

### Verification для части A

1. `docker compose up -d` и открыть http://localhost:8080.
2. Пройти по чек-листу для каждой таблицы: `+ Add`, ряд `✎ Edit`, ряд `✕ Delete`, top-level `Bulk*` — все нажимаются и завершаются тостом/перерисовкой.
3. Тост «Dark mode coming soon» при клике на ☀/🌙.
4. Клик по 🔔 → Notifications page; клик по строке уведомления → Domains с подсвеченной записью.
5. Топбар Logout очищает localStorage и отправляет на /login.
6. Ни одной консольной ошибки в DevTools при навигации по всем страницам.

### Критические файлы для правки (часть A)

- [frontend/src/components/ui/Primitives.tsx](frontend/src/components/ui/Primitives.tsx) — `ActionIcons` → `RowActions`.
- [frontend/src/App.tsx](frontend/src/App.tsx) — пропсы `onNav`, Logout, скрытие поиска, toast для темы.
- [frontend/src/pages/Domains.tsx](frontend/src/pages/Domains.tsx) — EditDomainModal + RowActions.
- [frontend/src/pages/ServerDetail.tsx](frontend/src/pages/ServerDetail.tsx) — RowActions.
- [frontend/src/pages/Cloudflare.tsx](frontend/src/pages/Cloudflare.tsx) — EditCfAccountModal, NameserversModal, DNS Add/Edit/Delete.
- [frontend/src/pages/Settings.tsx](frontend/src/pages/Settings.tsx) — EditRegistrarModal, SystemConfig edit.
- [frontend/src/pages/Notifications.tsx](frontend/src/pages/Notifications.tsx) — клик-to-navigate.
- [frontend/src/api/cloudflare.ts](frontend/src/api/cloudflare.ts), [frontend/src/api/hostiq.ts](frontend/src/api/hostiq.ts) — недостающие `useUpdate*`/`useDelete*` хуки.
- [backend/app/api/routes/cloudflare.py](backend/app/api/routes/cloudflare.py), [backend/app/api/routes/settings.py](backend/app/api/routes/settings.py) — добавить PATCH/DELETE если отсутствуют.

### Оценка трудозатрат A

- A1 (RowActions инфра): 0.5 дня.
- A2 (Domains Edit+Delete): 0.5 дня.
- A3 (ServerDetail actions): 0.25 дня.
- A4 (CF account CRUD): 0.5 дня.
- A5 (CF DNS CRUD): 1 день.
- A6 (Settings CRUD): 0.5 дня.
- A7 (Topbar cleanup+logout): 0.25 дня.
- A8+A9 (onNav + фильтры по ctx): 0.5 дня.
- A10 (Notifications click): 0.25 дня.
- **Итого: ~4 рабочих дня** (один разработчик).

---

## B. План развития проекта

Фазы привязаны к `docs/Roadmap.md` (мы сейчас в Phase C) и учитывают открытые пункты из `docs/Bugs.md`.

### B1. Stabilization (Phase C — сейчас) — 1–2 недели

Цель: убрать риски в БД и базовое качество.

1. **Миграции Alembic для всех текущих моделей** ([docs/Bugs.md#1](docs/Bugs.md)):
   - Сгенерировать baseline `001_init.py` из текущих моделей (offline, без `create_all`).
   - Миграция `002_domain_purchase_and_notifications` уже спланирована в [task1.md](task1.md) — встроить её после baseline.
   - В [backend/app/main.py](backend/app/main.py) убрать `Base.metadata.create_all` из startup и заменить на проверку «последняя миграция применена».
2. **Smoke-тесты API** (pytest + httpx): регистрация, логин, CRUD по servers/domains/cloudflare, заказ задачи hostiq. Запуск в Docker-stage.
3. **CI pipeline** (GitHub Actions или GitLab CI): lint (ruff, eslint), typecheck (mypy, tsc --noEmit), backend tests, `npm run build` в контейнере node:20 ([docs/Bugs.md#4](docs/Bugs.md)).
4. **Docker compose runbook**: документ в [docs/](docs/) с командами `up`, `alembic upgrade head`, `create superuser`, troubleshooting.
5. Весь блок **A** (переходы) реализовать здесь же.

### B2. Product Hardening (Phase D) — 3–4 недели

Цель: довести интеграции до production-grade и UX-завершить.

1. **FastPanel real integration** ([docs/Bugs.md#2](docs/Bugs.md)):
   - Из scaffold-метода `install()` и `add_domain()` в [backend/app/services/fastpanel_service.py] (проверить точное имя) сделать реальные команды по SSH (используя существующий `ssh_service`).
   - Idempotent — повторный install на том же сервере не ломает.
   - Структурированные статусы в TaskLog.
2. **HostIQ real browser automation**:
   - Playwright-сценарий: логин → выбор домена → смена NS → подтверждение. Запуск в worker-контейнере с Xvfb/headless.
   - Retry-policy, skip-if-already-set.
3. **Frontend UX v2**:
   - Toast system: расширить существующий `toast` state в App.tsx → dedicated `ToastProvider` + API `toast.success/error/info`. Покрыть все мутации.
   - Валидация форм: zod или react-hook-form — как минимум на Add Server/Domain/CF.
   - Пагинация и server-side фильтры/поиск на таблицах Domains (сейчас в БД может быть тысячи записей — рендерится всё).
   - Edit-модалки (результат из части A) унифицировать как `<ResourceEditModal>`-компонент.
4. **Notifications полный цикл** (уже частично по [task1.md](task1.md)):
   - Добавить типы уведомлений: `server_unreachable` (из SSH-пинга), `cf_sync_failed`, `task_failed`.
   - Web Push (опционально) — на фазе E.
5. **Dashboard live-данные**:
   - Заменить оставшиеся заглушечные карточки на реальные агрегаты (`/stats` endpoint).
   - Charts — счётчики за 7/30 дней (`activity_log`).

### B3. Production Readiness (Phase E) — 2–3 недели

Цель: готовность к эксплуатации.

1. **Security review** ([docs/Roadmap.md#phase-e](docs/Roadmap.md)):
   - CORS whitelist по env.
   - Secrets: проверить, что `SECRET_KEY`, `DB_PASSWORD`, `FERNET_KEY` только из env, не в репо.
   - Rate-limit на `/auth/login` (slowapi).
   - Аудит JWT: refresh-токены, rotation, httpOnly cookie опция.
   - Запустить `/security-review` скилл на всех роутах.
2. **Observability**:
   - Structured logs (JSON) в stdout; сбор через Loki или CloudWatch.
   - `/healthz` и `/readyz` с проверками БД и Redis.
   - Опционально: Prometheus-экспорт из FastAPI и Celery.
3. **Deployment**:
   - Prod docker-compose c отдельным nginx + TLS (certbot sidecar или внешний).
   - Runbook: deploy, rollback, backup/restore БД, rotate secrets.
4. **E2E тесты**: Playwright-сценарий auth → create server → assign domain → check NS — один happy-path.
5. **Multi-user / role enforcement audit**: проверить, что `admin/user/viewer` реально ограничивают ручки, не только UI.

### B4. Продуктовые расширения (Phase F, бэклог) — по приоритету

Кандидаты, ещё не в roadmap:

- **Domain expiry auto-fetch** от регистраторов, где есть API (WHOIS fallback).
- **Bulk CSV-экспорт** для domains/servers/activity.
- **Audit log** действий пользователя (кто/когда/что).
- **Webhooks / API-ключи** для внешних интеграций.
- **Мультитенантность** (workspace model) — если планируется shared-deploy.
- **Мобильная вёрстка** (сейчас desktop-first).

### Verification для части B

Каждая фаза — отдельный PR-набор; перед мерджем:

- `docker compose up` на чистом volume поднимает стек с нуля через миграции.
- CI зелёный (lint + typecheck + tests + build).
- Ручной прогон smoke-сценария из фазы.
- Для B3 — запуск `security-review` и фиксация ревью.

---

## Приоритизация на ближайший спринт (рекомендация)

**Неделя 1:** A1–A10 (переходы) + B1.1 (миграции) + B1.3 (CI заготовка).
**Неделя 2:** B1.2 (smoke-тесты), B1.4 (runbook), B2.3 (toast + валидация) — параллельно.
**Неделя 3+:** B2.1/B2.2 (fastpanel+hostiq), B2.4 (расширение notifications).
**После релиза:** B3.
