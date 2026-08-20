# План: Привязка домена к серверу — карточка, массовое заведение, сверка по факту

**Дата:** 2026-08-20
**Связь с бизнесом:** массовое ведение десятков–сотен доменов (`.business/goals/`): связка
«домен → сервер» обязана ставиться до развёртывания и в тех же местах, где человек уже
работает пачками, иначе провижн падает на `domain has no server_id`.

## Зачем

Сегодня сервер домену назначается только в мастере «Add Domain», в массовом «Assign Server»
и в full-setup. Карточка домена держала поле read-only по решению плана
[2026-08-17](2026-08-17-kartochka-domena-svyazi-i-registrar.md) с подписью «A domain gets
its server when it is deployed».

**Это решение отменяется: подпись неверна.** Provision `server_id` не ставит, а **читает** и
без него падает ([provision.rs:1071](../desktop/src-tauri/src/commands/provision.rs#L1071)).
Связка обязана существовать ДО развёртывания, то есть read-only карточка не охраняла
инвариант, а блокировала нормальный путь. Инвариант к тому же уже нарушался: массовое
`bulk-assign-server` пишет `server_id` без проверок.

Смена `server_id` не переносит сайт, поэтому снимок `fp_facts` со старой машины обязан
обнуляться (иначе вкладка Server покажет FTP-логин старого сервера рядом с IP нового), а
выбор — проверяться по факту: A-запись Cloudflare и список сайтов FastPanel.

## Acceptance criteria (что значит «готово»)

- [x] `server_id` принимается массовым заведением (обе схемы) и попадает в аудит.
- [x] Смена `server_id` любым писателем обнуляет `fp_facts`, `fp_facts_at`, `fp_check_error`,
      `fp_checked_at`; тот же `server_id` снимок не трогает.
- [x] `/domains/bulk` и `/domains/bulk-structured` проверяют владение связками (`404` на чужой id).
- [ ] Карточка домена назначает и снимает сервер; ненайденный `server_id` удерживает значение
      и подписывается `not found`, а не падает в «— No server —».
- [ ] Расхождение с A-записью Cloudflare показано как подсказка, селект не блокируется.
- [ ] Bulk Add: селект сервера на обеих вкладках, третья колонка CSV резолвится по IP или имени,
      ненайденное значение блокирует отправку с номером исходной строки.
- [ ] Сверка на карточке сервера разделяет `unbound` / `unknown` и умеет привязать и завести.

## Edge cases (продумать заранее)

- Ноль серверов / отказ чтения списка — три состояния, а не «пусто» (правило `DomainRegistrarField`).
- Сотни доменов в пачке: сброс снимка — один UPDATE, сужен по `IS DISTINCT FROM`.
- Двойной клик по массовой привязке: `_set_links` идемпотентен по построению.
- Веб vs десктоп: чтение DNS и списка сайтов — десктоп-only; назначение сервера — метаданные (`PUT`), доступны везде.
- Zero-knowledge: новых секретов не появляется; сброс снимка, наоборот, убирает чужие реквизиты с экрана.

## Фазы

### Фаза 1 — бэкенд: `server_id` в массовом заведении и сброс снимка при переезде  `[x]`
- `schemas/domain.py`: `server_id` в `DomainBulkCreate` и `DomainBulkCreateItem` (без `server_ip` — резолв на фронте).
- `services/domain_service.py`: прокинуть `server_id` в оба `bulk_create*`; новая
  `_forget_facts_of_previous_server`; вызов из `update()`, `bulk_assign_server()`, `bulk_full_setup()`.
- `api/routes/domains.py`: `_ensure_links_owned` в обоих bulk-маршрутах; `server_id` в аудите `domain.bulk_create`.
- Тесты: `tests/test_domain_server_move.py`, дополнение `tests/test_domain_route_guards.py`.

**Как сделано (что уточнилось против спеки).**

- Четвёрка колонок снимка вынесена в модульную константу `_FORGOTTEN_FACTS`: её
  используют оба пути — и UPDATE в `_forget_facts_of_previous_server`, и патч в
  `update()`, — и разъехавшись, они дали бы «наполовину забытый» снимок.
- `Domain.server_id.is_distinct_from(...)` в SQLAlchemy 2.0.35 есть и компилируется в
  `IS DISTINCT FROM` (проверено на диалекте postgresql, в том числе с `NULL`).
- Своего `bump_version` у сброса нет намеренно: за ним ВСЕГДА идёт `_set_links` по тем же
  или более широким строкам в той же транзакции (обнулённая строка по определению не в
  целевом состоянии, значит она и в наборе `outdated`), и версию проставляет он. Решение
  запёрто тестом: `sync_version` переехавшего домена обязан вырасти.
- Гард в `/bulk-structured` — два прохода по УНИКАЛЬНЫМ id (`sorted`, ради определённости
  того, какая связка назовётся в 404). `registrar_name` не проверяется: он резолвится
  только по аккаунтам этого пользователя (`find_reg_id`), то есть чужого не найдёт.
- Тестов вышло больше, чем перечислено: сверх спеки закрыты отвязка (`server_id: null` —
  реализация через `patch.get()` прошла бы «смену сервера» и провалила бы отвязку), `PUT`
  вовсе без `server_id` (иначе `exclude_unset` прочитался бы как отвязка и стирал бы снимок
  на любой правке карточки) и третий писатель — `full-setup`, у которого заодно проверено,
  что сброс не разрушил идемпотентность повтора.
- Прогон `test_domain_server_move.py test_domain_route_guards.py test_bulk_audit.py
  test_domain_full_setup.py` — 33 passed (живая Supabase, ~10 мин).

### Фаза 2 — карточка домена: селект сервера и сверка с A-записью  `[ ]`
- Новый `lib/domainOriginCheck.ts` (`match` / `mismatch` / `no-a-record` / `unknown`), тестами вперёд.
- Новый `components/domains/DomainServerField.tsx` по образцу `DomainRegistrarField`.
- `DomainLinks.tsx`: `ServerLink` удаляется, проп `server` уходит; `DomainOverviewTab` перестаёт его принимать.
- Тесты: `DomainServerField.test.tsx`, `domainOriginCheck.test.ts`, правка тестов, запиравших read-only.

### Фаза 3 — Bulk Add: сервер на обеих вкладках и третья колонка CSV  `[ ]`
- Новый `lib/bulkCsv.ts` с `parseBulkCsv(text, { servers, defaultServerId })`.
- `BulkAddDialog.tsx`: пропы `servers`/`domains`, блок селектов наружу из ветки Plain Text,
  опции через `optionsByLoad`, ошибки строк блокируют отправку.
- `api/domains.ts`: `server_id` в обеих схемах.
- Тесты: `bulkCsv.test.ts`, `BulkAddDialog.test.tsx`.

### Фаза 4 — карточка сервера: привязка по факту FastPanel  `[ ]`
- `lib/serverSites.ts`: `compareServerSites` принимает все домены и id сервера, отдаёт
  `matched` / `unbound` / `unknown` / `onlyInSdmp`.
- `ServerDetail.tsx` + `SiteCompareBanner`: четыре колонки, кнопки «Привязать» (`bulk-assign-server`)
  и «Завести и привязать» (`bulk-structured` с `server_id`).
- Тесты: `serverSites.test.ts` под четыре группы, тест страницы на состав ids.

### Фаза 5 — документы  `[ ]`
- Приписка в `plans/2026-08-17-kartochka-domena-svyazi-i-registrar.md` об отмене решения.
- Ссылка в `plans/README.md`; правка `docs/ARCHITECTURE.md`, если там «сервер назначает развёртывание».

## Долг (вне объёма)

- **Файловый импорт** `POST /domains/bulk-import` остаётся двухколоночным (`domain, registrar_name`).
  Он делегирует в тот же `bulk_create_structured`, поэтому третья колонка туда дёшева — но это
  своя форма, свой парсер и свой отчёт об ошибках. Заодно найдено (фаза 1): гарда владения
  у него тоже нет — `default_registrar_id` из формы уезжает в `DomainBulkCreateItem` без
  `_ensure_links_owned`, то есть чужой id проходит молча. Ровно та же дыра, что закрыта в
  `/bulk` и `/bulk-structured`; закрывается тем же `_ensure_links_owned`, но у этого маршрута
  своё тело (`multipart`), свой тест и своя форма отчёта, поэтому в объём фазы не бралось.
- **Реальный перенос сайта** между серверами (SSH-миграция, удаление сироты на старом сервере).
  Эта работа переносит только запись — и говорит об этом прямо.
- **`DomainCloudflareField`** единственный молча падает в «— No Cloudflare account —» при
  ненайденном аккаунте. После этой работы правило «удерживать значение и назвать not found»
  будет в двух полях из трёх — перенос в третье становится очевидным долгом.

## Итог

- Реализован целиком: нет (в работе).
- Что осталось: фазы 2–5 (весь фронт и документы). Бэкенд фазы 1 готов и покрыт тестами.
