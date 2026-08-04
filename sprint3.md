# SDMP — Спринт 3: дотянуть UI + write-back (фаза «для себя»)

## Context

**Зачем этот план и что изменилось.** Пользователь попросил изучить проект и сказать, что
делать дальше. Первичный план воспроизводил Спринты 0–2, но сверка с **реальным кодом**
показала: они **уже исполнены** (`plans/2026-08-02-sprint{0,1,2}.md` = «выполнен», рабочее
дерево чистое, миграции до `014`). Аудит `docs/AUDIT_2026-08-02.md`, на который опирался
первичный план, устарел — код ушёл вперёд.

Что реально готово (проверено по коду, не по докам):
- `install_fastpanel` полностью реализован (`commands/provision.rs`), не заглушка.
- Все 9 Cloudflare/registrar-команд зарегистрированы (`lib.rs:51-59`).
- provision — полный цикл site+FTP+DB+SSL с идемпотентностью, DNS-гейтом, firewall-preflight.
- Dashboard подключён к реальным данным; blob-мутации логируются в audit; `server.notes` и
  SSL-email-pool удалены миграциями; TOTP-компромисс оформлен ADR; крипто приведено к факту
  (XSalsa20-Poly1305).

**Настоящее узкое место.** Ядро исполнения написано, но до него **не дотянуты кнопки в UI**,
а результаты исполнения **не сохраняются обратно** на сервер. Пользователь выбрал: собрать
план вокруг этого. Цель спринта — приложение реально юзабельно «для себя» end-to-end.

**Урок из прошлых спринтов** (из их же итоговых блоков): снипеты в планах систематически
расходились с реальным кодом, и задачи «сделай команду» закрывались, не двигая продукт, потому
что не было кнопки-вызова. Поэтому **явный критерий приёмки каждой задачи — «есть ли в UI
элемент, который это вызывает, и дошёл ли результат до сервера»**, а не «команда существует».

---

## Группа A — Точки входа в UI для уже готовых команд

Rust-команды написаны и протестированы; задача — сделать их достижимыми из интерфейса.
В Tauri — прямой `invoke`; в web — `OpenInDesktop`/`sdmp://` fallback (паттерн уже есть).

1. **Кнопка «Install FastPanel».** `ServerDetail.tsx` ведёт на несуществующий
   `POST /servers/{id}/install-fastpanel`. Перевести на Tauri-команду `install_fastpanel`
   (web → deep link `sdmp://install-fastpanel`). Прогресс — из события `fastpanel:progress`;
   вернувшийся пароль панели показать один раз по образцу `RevealSecret`.
2. **Отрендерить `CloudflareZoneView`.** Компонент написан, но нигде не монтируется → DNS-
   редактор недоступен, у 4 CF-команд нет вызывающих. Встроить в Cloudflare-страницу / деталь
   домена; подключить действия к `cf_create_zone`, `cf_create_dns_record`,
   `cf_update_dns_record`, `cf_delete_dns_record`, `cf_purge_cache`. Проверить, что `proxied`
   доходит до записи (в Спринте 1 это уже был баг).
3. **Кнопка «Set NS».** Ведёт на несуществующий `POST /domains/{id}/set-ns`. Перевести на
   Tauri-команду `registrar_set_nameservers`.
4. **Чекбокс `withDb` в provision.** Флаг проброшен до Rust (`provision_domain(with_db)`), но
   в UI (BulkSetupWizard / диалог provision) переключателя нет — опциональная БД недостижима.

Критические файлы: `frontend/src/pages/ServerDetail.tsx`,
`frontend/src/pages/Cloudflare.tsx` (+ где живёт `CloudflareZoneView`),
`frontend/src/pages/Domains.tsx`, `frontend/src/components/OpenInDesktop.tsx`,
`frontend/src/lib/deepLink.ts`, `desktop/src-tauri/src/lib.rs` (реестр команд — для сверки имён).

---

## Группа B — Write-back результатов исполнения (архитектурный, критичный)

**Проблема.** Sync односторонний: результаты исполнения (`site_user`, `ssl_*`, `db_name`,
`db_user`, `fastpanel_status`) не пишутся обратно на сервер, а `DomainUpdate`/`ServerUpdate`
этих полей не имеют. Следствие: гарды идемпотентности (`ssl_exists`, «FastPanel уже
установлен») читают поля, **которые никто не заполняет** — выглядят рабочими, но не срабатывают.

**Что сделать.**
- Расширить схемы `DomainUpdate`/`ServerUpdate` (`backend/app/schemas/`) полями результата:
  `site_user`, `site_path`, `ssl_status`/`ssl_expires_at`/`ssl_issuer`, `db_name`, `db_user`,
  `fastpanel_status`, `fastpanel_url`, `fastpanel_user`.
- После успешного provision/install в Rust — записать эти **несекретные** поля обратно через
  `ApiClient`/`api_request` (по образцу существующего `audit_log`).
- **Инвариант ZK:** пароли (`db_password`, `ftp_password`, пароль панели) **не** пишутся на
  сервер — остаются только на клиенте (`RevealSecret`, показ один раз). Write-back — метаданные,
  не секреты. Свериться с `audit_redact.rs` и redaction-guard в `sync/http.rs`.

Критические файлы: `backend/app/schemas/{domain.py,server.py}`,
`backend/app/api/routes/{domains.py,servers.py}`,
`desktop/src-tauri/src/commands/provision.rs`, `desktop/src-tauri/src/sync/http.rs`.

---

## Группа C — Сбор метрик серверов (опционально в рамках спринта)

Коллектора метрик нет нигде; Dashboard уже корректно показывает «—» при отсутствии данных
(не блокирует provisioning). Если войдёт в объём: собрать CPU/RAM/диск/uptime по SSH в Rust
(есть `ssh/client.rs`), сохранить через write-back (Группа B), добавить кнопку «Refresh» на
`ServerDetail`. Иначе — вынести в отдельный план. **Рекомендация: не тянуть в этот спринт**,
т.к. на юзабельность provisioning не влияет.

---

## Проверка (end-to-end в desktop-приложении)

Сквозной сценарий на тестовом сервере:
1. Добавить сервер → нажать **Install FastPanel** (кнопка, не deep link) → пройти прогресс →
   пароль панели показан один раз.
2. Добавить домен → открыть **CF DNS-редактор** → создать A-запись (проверить `proxied`).
3. **Set NS** через регистратора.
4. **Provision с включённым `withDb`** → получить site+FTP+DB+SSL, пароли БД/FTP показаны один раз.
5. **Повторный provision/install** → срабатывают гарды (`ssl_exists`, «уже установлен») —
   значит write-back (Группа B) реально пишет поля.
6. В БД сервера — нет ни одного пароля (ZK-инвариант); действия видны в Activity/audit.

Тесты: `pytest` (backend), `cargo test` (desktop), `vitest` (frontend) — зелёные;
`tsc` — не хуже преэкзистующего долга (51 ошибка).

Оформление: по правилам репозитория новый план кладётся в
`plans/2026-08-03-sprint3-ui-reachability-writeback.md` с фазами `[ ]/[x]` и итоговым блоком.

---

## Отложено (следующими спринтами, не сейчас)

**Спринт 4 — Безопасность (перенос из Спринта 2, 6 пунктов):**
- Нет серверного guard'а метаданных аудита от секретов (защищают только тесты, 3 из ~18 мест).
- `GET /{domains,servers}/bulk-import-errors/{token}` — без аутентификации, без TTL, без
  проверки владения; токены взаимно подходят к обоим эндпоинтам.
- Audit-строка коммитится отдельной транзакцией от самой мутации (расходятся факт и запись).
- 5 auth-роутов без аудита.
- Ручной сквозной прогон recovery (фаза 5 плана `2026-08-03-recovery-proof-of-phrase.md`).

**Фаза B «продукт» — Stage 5 (launch prep), не начата:**
- Пересобрать план деплоя под **Supabase + Railway** (в `stage5.md` — устаревший Hetzner/Caddy).
- CI `.github/workflows/release.yml`, подписанные мультиплатформенные сборки Tauri.
- Playwright e2e; доки INSTALL/SECURITY/RECOVERY; status page; email через Resend.

**Исключено:** миграция данных из старой БД (ручной ввод — по решению пользователя);
редизайн UI (`design-brief.md`) — отдельным треком после Фазы A.
