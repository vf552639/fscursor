"""Полный реестр ORM-моделей — один на все процессы.

Этот файл существует не ради удобных импортов, а ради инварианта: **метаданные
`Base` обязаны быть полными у любого процесса, который трогает хоть одну
модель**. Держится инвариант на том, что Python импортирует пакет раньше его
подмодуля: `from app.models.server import Server` сначала выполняет вот этот
`__init__`, а значит тянет за собой все модели разом. Отдельно вспоминать о
реестре не приходится ни воркеру, ни beat, ни alembic, ни скрипту — они его
получают уже полным, просто импортировав нужную модель.

Почему это вообще важно, стоило шести серверов и нескольких месяцев тишины.
SQLAlchemy разрешает `ForeignKey("blob_storage.id")` не в момент объявления
класса, а лениво — когда кому-то понадобится связать таблицы. У ORM это
происходит на flush: unit of work сортирует таблицы по зависимостям
(`metadata.sorted_tables`) и падает `NoReferencedTableError`, если целевой
таблицы в метаданных нет. Пять моделей (`server`, `domain`,
`cloudflare_account`, `registrar_account`) ссылаются на `blob_storage`, а сам
`BlobStorage` объявлен в `app/blobs/models.py` и в этот пакет не входил.

Веб-процесс беды не знал: он грузит роуты, а те импортируют `blobs`, `auth` и
`audit` попутно. Воркер роуты не грузит **никогда** — его цепочка
`app/tasks/__init__.py` → `server_monitor_task` → `app.models.server`. Реестр у
него был неполон, и мониторинг доступности не смог записать **ни одной**
проверки за всё время своего существования: выборка проходила, опрос проходил,
а запись падала на каждом сервере. Пользователь видел `unchecked` и «Last check:
never» и считал, что функция сломана, — так и было, только не там, где искали.

Отсюда правило: **новая модель добавляется сюда**, где бы ни лежал её модуль.
Модели живут в трёх пакетах помимо этого (`auth`, `blobs`, `audit`), и это не
беспорядок, а разделение по доменам; беспорядком было бы, если бы принадлежность
к реестру зависела от того, в каком пакете модель лежит.

Проверяется инвариант тестом `tests/test_model_registry.py`: он поднимает чистый
интерпретатор с импортом, доступным воркеру, и требует, чтобы реестр там был уже
полным. Внутри общего прогона такую проверку не сделать — к тому моменту роуты
давно импортированы соседними тестами, и она зеленела бы всегда.
"""

from app.audit.models import AuditLog
from app.auth.models import RecoveryBlob, Session, SyncState, User
from app.blobs.models import BlobStorage
from app.models.activity_log import ActivityLog
from app.models.cloudflare_account import CloudflareAccount
from app.models.domain import Domain
from app.models.notification import Notification
from app.models.registrar_account import RegistrarAccount
from app.models.server import Server
from app.models.system_config import SystemConfig
from app.models.task_log import TaskLog

__all__ = [
    "ActivityLog",
    "AuditLog",
    "BlobStorage",
    "CloudflareAccount",
    "Domain",
    "Notification",
    "RecoveryBlob",
    "RegistrarAccount",
    "Server",
    "Session",
    "SyncState",
    "SystemConfig",
    "TaskLog",
    "User",
]
