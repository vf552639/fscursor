# Plan: Purchase date + 9-month renewal notifications for domains

## Context

На данный момент модель `Domain` не хранит дату покупки домена. У регистраторов нет единообразного API для получения этой информации, поэтому пользователь должен вводить её вручную. Нужно:

1. Добавить поле **purchase_date** в домены (аналогично тому, как оно уже есть на `Server`).
2. Автоматически рассчитывать дату "purchase_date + 9 месяцев" и в тот момент создавать уведомление "домен нужно продлить".
3. Показывать уведомления в UI: отдельная страница **Notifications** + счётчик непрочитанных на иконке 🔔 в топбаре.

Одно уведомление на каждую пару `(domain_id, purchase_date)` — если пользователь обновит дату покупки (продлил), будет сгенерировано новое. Порог 9 месяцев фиксирован в коде как константа `RENEWAL_NOTICE_MONTHS = 9`.

Стек: FastAPI + SQLAlchemy (async) + Alembic + Celery + Redis + React + TanStack Query. Для периодической проверки будет добавлен **Celery Beat** (новый сервис в docker-compose), т.к. сейчас Celery используется только для on-demand задач.

---

## Backend

### 1. Модель + миграция

**Файл:** [backend/app/models/domain.py](backend/app/models/domain.py)
- Добавить поле после `expiry_date` (строка 28):
  ```python
  purchase_date: Mapped[Optional[date]] = mapped_column(Date)
  ```

**Новый файл:** [backend/app/models/notification.py](backend/app/models/notification.py)
```python
class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)          # "domain_renewal"
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)   # "domain"
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)        # domain.id
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[Optional[str]] = mapped_column(Text)
    dedup_key: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    # dedup_key = f"domain_renewal:{domain_id}:{purchase_date.isoformat()}"
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
```
Зарегистрировать в [backend/app/models/__init__.py](backend/app/models/__init__.py).

**Новая миграция:** `backend/alembic/versions/002_domain_purchase_and_notifications.py`
- `ALTER TABLE domains ADD COLUMN purchase_date DATE`
- Создать таблицу `notifications` со всеми колонками выше + индексами (`ix_notifications_is_read`, `ix_notifications_entity`).

### 2. Pydantic-схемы

**Файл:** [backend/app/schemas/domain.py](backend/app/schemas/domain.py)
- Добавить `purchase_date: Optional[date] = None` в `DomainBase` (строка 14), `DomainUpdate` (строка 29), соответственно пройдёт в `DomainResponse` по наследованию.

**Новый файл:** [backend/app/schemas/notification.py](backend/app/schemas/notification.py)
- `NotificationResponse` (id, type, entity_type, entity_id, title, message, is_read, read_at, created_at).
- `NotificationMarkReadRequest` — список `ids` (или все если пустой).
- `UnreadCountResponse(count: int)`.

### 3. Сервис и роуты для уведомлений

**Новый файл:** [backend/app/services/notification_service.py](backend/app/services/notification_service.py)
- `list_notifications(db, is_read=None, limit=50)` — отсортировано по `created_at desc`.
- `count_unread(db)` — `SELECT count(*) WHERE is_read=false`.
- `mark_read(db, ids)` и `mark_all_read(db)`.
- `upsert_renewal_notification(db, domain)` — создаёт запись, полагаясь на unique-constraint `dedup_key` (`ON CONFLICT DO NOTHING` через `insert(...).on_conflict_do_nothing` из `sqlalchemy.dialects.postgresql`). Возвращает `True`, если создано.

**Новый файл:** [backend/app/api/routes/notifications.py](backend/app/api/routes/notifications.py)
- `GET /notifications?is_read=` → список.
- `GET /notifications/unread-count` → `{count}`.
- `POST /notifications/mark-read` body `{ids: []}` или пусто → mark_all_read.
- `DELETE /notifications/{id}` (опционально — удалить из списка).

Зарегистрировать роутер в [backend/app/api/routes/__init__.py](backend/app/api/routes/__init__.py).

### 4. Периодическая проверка (Celery Beat)

**Изменить:** [backend/app/core/celery_app.py](backend/app/core/celery_app.py)
- Добавить `beat_schedule`:
  ```python
  celery_app.conf.beat_schedule = {
      "check-domain-renewals-daily": {
          "task": "app.tasks.renewal.check_domain_renewals",
          "schedule": crontab(hour=9, minute=0),  # раз в сутки, 09:00 UTC
      },
  }
  ```

**Новый файл:** [backend/app/tasks/renewal_task.py](backend/app/tasks/renewal_task.py)
- Константа `RENEWAL_NOTICE_MONTHS = 9`.
- `_check_renewals()`:
  1. Вычислить `threshold = today - relativedelta(months=9)` (через `dateutil.relativedelta`, добавить в `requirements.txt`).
  2. `SELECT domains WHERE purchase_date IS NOT NULL AND purchase_date <= threshold`.
  3. Для каждого: `notification_service.upsert_renewal_notification(db, domain)`. Благодаря unique `dedup_key`, повторный запуск не создаст дубликаты. Если пользователь обновит `purchase_date` — `dedup_key` другой, создастся новое уведомление.
  4. Писать итоговую строку (`created N reminders`) в `TaskLog(entity_type="system", task_type="renewal_check")` для аудита.
- Celery-обёртка:
  ```python
  @celery_app.task(name="app.tasks.renewal.check_domain_renewals")
  def check_domain_renewals() -> dict:
      asyncio.run(_check_renewals())
  ```
- Импортировать в [backend/app/tasks/__init__.py](backend/app/tasks/__init__.py).

**Изменить:** [docker-compose.yml](docker-compose.yml)
- Добавить сервис `beat` (идентичен `worker`, но команда `celery -A app.core.celery_app.celery_app beat --loglevel=info`). Это единственный процесс beat — запускать в одном экземпляре.

**Изменить:** [backend/requirements.txt](backend/requirements.txt)
- `python-dateutil==2.9.0`.

### 5. Manual trigger (для тестирования / админ-кнопки, опционально)

В [backend/app/api/routes/notifications.py](backend/app/api/routes/notifications.py) добавить:
- `POST /notifications/check-renewals` → вызывает `check_domain_renewals.delay()`. Удобно тестировать сразу, не дожидаясь beat.

---

## Frontend

### 6. API-клиент

**Изменить:** [frontend/src/api/domains.ts](frontend/src/api/domains.ts)
- Добавить `purchase_date: string | null` в `Domain` (строка 15), `DomainCreate` (строка 29), `DomainUpdate` (строка 40).

**Новый файл:** [frontend/src/api/notifications.ts](frontend/src/api/notifications.ts)
- Интерфейс `Notification` (id, type, entity_type, entity_id, title, message, is_read, created_at).
- Хуки: `useNotifications(isRead?)`, `useUnreadCount()` (refetchInterval: 60_000 для polling), `useMarkNotificationsRead()`, `useDeleteNotification()`.

### 7. Страница Notifications

**Новый файл:** [frontend/src/pages/Notifications.tsx](frontend/src/pages/Notifications.tsx)
- Пример за основу взять из [frontend/src/pages/Activity.tsx](frontend/src/pages/Activity.tsx) — тот же макет со StatCard + фильтры + таблица.
- Колонки: `#`, `Type`, `Title`, `Message`, `Status (read/unread badge)`, `Created`, действия (`Mark read`, `Delete`).
- Кнопка "Mark all read" сверху справа.
- Фильтр `All / Unread`.
- Использовать `fmtDT` из [frontend/src/components/ui/Primitives.tsx](frontend/src/components/ui/Primitives.tsx).

### 8. Навигация + badge

**Изменить:** [frontend/src/App.tsx](frontend/src/App.tsx)
- Добавить в сайдбар (строка 69-75) пункт:
  ```js
  { key: "notifications", label: "Notifications", icon: "🔔" },
  ```
- Подключить роут: `{page === "notifications" && <Notifications />}` (строка 110).
- Иконка 🔔 в топбаре (строка 95) — сделать кликабельной (`onClick={() => nav("notifications")}`) и навесить badge с числом непрочитанных:
  - Использовать `useUnreadCount()`;
  - Если count > 0 — показать красный кружок в правом верхнем углу кнопки.

### 9. Форма Add Domain / Edit

**Изменить:** [frontend/src/pages/Domains.tsx](frontend/src/pages/Domains.tsx)
- В `AddDomainModal` (строки 28-56) добавить поле `purchase_date` через `<input type="date">` (после Domain Name, перед Assign Server).
- Передать `purchase_date: pDate || null` в `create.mutate(...)` (строка 36-41).
- В таблице доменов (строки 247-249) добавить колонку "Purchase" с `fmtDate(d.purchase_date)` — позволит визуально отслеживать дату.
- Также — добавить Edit Domain modal (сейчас нет — только ActionIcons-заглушка на строке 264). Это отдельный подмасштабный блок, но нужный, чтобы указывать `purchase_date` существующим доменам. Минимальная версия: модалка с двумя полями (domain_name, purchase_date) + `useUpdateDomain`.

---

## Verification

### Ручное end-to-end тестирование:
1. `docker-compose up -d db redis` и `docker-compose run --rm backend alembic upgrade head` → проверить, что миграция 002 применилась (в psql: `\d domains` показывает `purchase_date`, `\d notifications` существует).
2. `docker-compose up -d backend worker beat frontend nginx`.
3. Открыть UI (http://localhost:8080), создать домен с `purchase_date` = 10 месяцев назад (например, 2025-06-23).
4. Вручную дёрнуть `POST /api/notifications/check-renewals` (через curl или через админ-кнопку на странице Notifications) → задача уйдёт в Celery worker.
5. Обновить страницу Notifications — должна появиться запись "Domain X needs renewal". На иконке 🔔 должен появиться красный badge с цифрой 1.
6. Повторить вызов `/check-renewals` — дубликат не должен появиться (проверка `dedup_key`).
7. Обновить `purchase_date` у того же домена на другую дату (например, сегодня - 10 мес.) и снова вызвать check → должно создаться новое уведомление.
8. Mark read → счётчик пропал.
9. Создать домен с `purchase_date` = 3 месяца назад → check не создаёт для него уведомление (не прошло 9 мес.).

### Автоматическая проверка Celery Beat:
- `docker-compose logs beat` — через сутки должна появиться строка `"check-domain-renewals-daily: task sent"`. Для ускорения теста временно поставить `schedule=60.0` (каждую минуту) и наблюдать за TaskLog / notifications.

### Критичные файлы для правки:
- [backend/app/models/domain.py](backend/app/models/domain.py)
- [backend/app/models/notification.py](backend/app/models/notification.py) (новый)
- [backend/app/models/__init__.py](backend/app/models/__init__.py)
- [backend/alembic/versions/002_domain_purchase_and_notifications.py](backend/alembic/versions/002_domain_purchase_and_notifications.py) (новый)
- [backend/app/schemas/domain.py](backend/app/schemas/domain.py)
- [backend/app/schemas/notification.py](backend/app/schemas/notification.py) (новый)
- [backend/app/services/notification_service.py](backend/app/services/notification_service.py) (новый)
- [backend/app/api/routes/notifications.py](backend/app/api/routes/notifications.py) (новый)
- [backend/app/api/routes/__init__.py](backend/app/api/routes/__init__.py)
- [backend/app/tasks/renewal_task.py](backend/app/tasks/renewal_task.py) (новый)
- [backend/app/tasks/__init__.py](backend/app/tasks/__init__.py)
- [backend/app/core/celery_app.py](backend/app/core/celery_app.py)
- [backend/requirements.txt](backend/requirements.txt)
- [docker-compose.yml](docker-compose.yml)
- [frontend/src/api/domains.ts](frontend/src/api/domains.ts)
- [frontend/src/api/notifications.ts](frontend/src/api/notifications.ts) (новый)
- [frontend/src/pages/Notifications.tsx](frontend/src/pages/Notifications.tsx) (новый)
- [frontend/src/pages/Domains.tsx](frontend/src/pages/Domains.tsx)
- [frontend/src/App.tsx](frontend/src/App.tsx)

### Использование существующих утилит:
- `TimestampMixin` из [backend/app/models/base.py](backend/app/models/base.py) для created_at/updated_at.
- Паттерн async Celery-таски — [backend/app/tasks/ns_task.py](backend/app/tasks/ns_task.py) (sessions, log).
- `fmtDate`, `fmtDT`, `Badge`, `Card`, `Btn`, `Modal`, `Sel`, `Inp` из [frontend/src/components/ui/Primitives.tsx](frontend/src/components/ui/Primitives.tsx).
- Структура страницы — [frontend/src/pages/Activity.tsx](frontend/src/pages/Activity.tsx).
