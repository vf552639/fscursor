# План: Вкладка Domains — чистка мёртвого слоя исполнения (404)

**Дата:** 2026-08-11
**Источник:** `task7.md`, план №1 роадмапа (аудит вкладки Domains).
**Связь с бизнесом:** принцип продукта №3 «Desktop выполняет, web только смотрит».
Кнопка, которая всегда даёт 404, — это обещание функции, которой нет; для
power-user'а с сотнями доменов такая кнопка дороже отсутствующей.

## Контекст

После миграции на zero-knowledge исполнение переехало в Tauri-команды, а старый
HTTP-слой исполнения во фронте не убрали и местами оставили подключённым к UI.
Подтверждено кодом: в `backend/app/api/routes/domains.py` объявлены только
list, `failed-export.csv`, get/{id}, create, `bulk`, `bulk-structured`, put/{id},
delete/{id}, `bulk-assign-server`, `bulk-assign-cloudflare`, `bulk-import`,
`bulk-import-errors/{token}`. Больше ничего — значит эти хуки всегда получают
404.

**Поправка к аудиту (внесена по итогам фазы 4).** `task7.md` объяснял это тем,
что `apiPost` (`api/client.ts`) — «чистый axios, не Tauri-aware». Это неверно:
`apiGet/apiPost/apiPut/apiPatch/apiDelete` начинаются с
`if (isTauri()) return tauriRequest(...)`, а `tauriRequest` зовёт Tauri-команду
`api_request` (`client.ts:105–157`). Вывод от этого не меняется: `api_request`
проксирует к тому же REST API, где этих роутов нет, — 404 одинаково в вебе и в
десктопе. Но механизм в аудите описан неправильно, и читатель `task7.md` сделал
бы из него ложный вывод, будто HTTP-хуки этого файла вообще не доходят до
десктопного транспорта.

Рабочая Tauri-реализация массового provision **есть** —
`runBulkProvisionDomains` (`api/domains.ts:761`) → команда `provision_bulk`,
но зовётся только из deep-link `sdmp://bulk-provision` (`lib/deepLink.ts:192`),
а не из кнопки тулбара.

## Acceptance criteria (что значит «готово»)

- [x] Ни одна кнопка вкладки Domains и её модалок не бьёт в несуществующий роут.
- [x] Кнопка «Provision» тулбара в десктопе идёт через Tauri `provision_bulk`
      (`runBulkProvisionDomains`), с тем же подоменным гейтом и с показом отчёта
      через ту же очередь показов, что у одиночного provision.
- [x] Пароли FTP/БД из массового отчёта не оседают нигде, кроме показа один раз
      (не в `MutationCache.data`, не в localStorage, не в логах).
- [x] `DomainDetailModal` — ровно 2 вкладки: `overview` (read-only) и `ns`.
- [x] Мёртвый `EditDomainModal` и его состояние удалены целиком.
- [x] Хуки-фикции удалены из `api/domains.ts`; grep не находит их импортов.
- [x] Компоненты без вызывающих удалены (проверено grep'ом, не на глаз).
- [x] `cd frontend && npm test` — прогон Domains/provision-тестов зелёный.
- [x] `npx tsc --noEmit` во `frontend` без ошибок.

## Edge cases (продумать заранее)

- **Ноль выделенных доменов** — тулбар и так не рендерится при `selectedCount<=0`.
- **Домен уже провижинится** — `runBulkProvisionDomains` бросает
  `Provisioning of #N is already running.`; кнопка не должна глотать эту ошибку
  молча, текст обязан доехать до пользователя.
- **Двойной клик по «Provision»** — гейт подоменный (`PROVISION_DOMAIN_KEY` в
  `MutationCache`); он же даёт кнопке признак «идёт прогон». Отдельно закрыто
  окно до старта: пока висит диалог подтверждения, кнопка ничем не занята, и
  второй клик гасится ref'ом (иначе второй диалог → «already running» поверх
  прекрасно идущего прогона).
- **Веб (не Tauri)** — исполнения нет; остаётся CTA `sdmp://bulk-provision`
  (`OpenInDesktop` уже так и устроен). Кнопка не должна пытаться исполнять.
- **`already_ran`** — отчёт про идемпотентность обязан доехать до пользователя
  ровно тем текстом, что даёт `summarizeBulkProvision` (различает `running`/`done`).
- **Прогон падает на середине** — `release()` гейта обязан отработать на любом
  исходе (в `runBulkProvisionDomains` он уже в `finally`).
- Zero-knowledge: возврат `mutationFn` не должен содержать паролей — путь bulk
  идёт не через мутацию, а прямым `await`, результат уходит в очередь показов.

## Фазы

### Фаза 1 — Bulk «Provision» тулбара переводится на Tauri  `[x]`

Файлы: `frontend/src/pages/Domains.tsx`, `frontend/src/pages/DesktopWorkspace.tsx`.

- В `Domains.tsx` заменить `useBulkProvisionDomains()` + `handleBulkProvision`
  на путь `runBulkProvisionDomains(userId, ids)`:
  - `userId` берётся из `useAuthStore.getState().userId` (как в
    `useSetNameservers`); нет userId → внятная ошибка, не тишина.
  - `ids` — `Array.from(sel).map(String)` (команда принимает строки).
  - Образец вызова — `lib/deepLink.ts:181–193`.
- Результат (`BulkProvisionOutcome`) отдать наверх новым обязательным пропом
  `onBulkProvisionResult: (outcome: BulkProvisionOutcome) => void`, по образцу
  уже существующего `onProvisionResult`. Причина та же и она проверяемая: в
  отчёте лежат пароли FTP каждого домена, а страница размонтируется при уходе
  пользователя. `DesktopWorkspace` уже держит `bulkReportQueue`
  (`useShowOnceQueue<BulkProvisionOutcome>`) и `BulkProvisionReportModal` —
  подключаемся к ним, второй очереди не заводим.
- Признак «идёт массовый прогон» для `disabled` кнопки: из мутации его больше не
  прочитать. Изначально планировался локальный `useState` — по ревью заменён на
  чтение `MutationCache` по маркеру `bulkGateClaim` (`isBulkGateClaim`):
  `useState` не переживает размонтирование страницы, а оно случается на любой
  навигации, и кнопка воскресала бы живой посреди прогона. Гасит признак ТОЛЬКО
  свою кнопку (`provisionPending`): «Assign Server»/«Assign CF» он держал бы
  мёртвыми весь прогон, в том числе запущенный ссылкой по чужим доменам.
- Ошибку запуска (`already running`, `desktopOnly`, отказ команды) показать —
  не проглатывать. Достаточно того же канала, что уже используется на странице
  (баннер/тост); не изобретать третий.
- Кнопку «Provision» в тулбаре под `!isTauri()` оставить как CTA
  `sdmp://bulk-provision` (так уже устроен `OpenInDesktop`) — исполнять в вебе
  нечем, а ссылка ведёт в рабочий путь.

### Фаза 2 — Удалить фикцию из тулбара и страницы  `[x]`

Файлы: `frontend/src/pages/Domains.tsx`, `frontend/src/components/BulkActionToolbar.tsx`.

- Убрать «Refresh SSL»: проп `onBulkRefreshSsl` у `BulkActionToolbar`,
  `handleBulkRefreshSsl`, `useRefreshSsl` со страницы.
- Убрать «Full Setup»: проп `onFullSetup`, `showFullSetup`, ветку
  `<BulkSetupWizard>`, `useBulkFullSetup`, а также `progressTaskId`/
  `progressTaskIds` и ветки `TaskProgressModal`/`MultiTaskProgressModal` на этой
  странице (их единственный поставщик — `bulkFullSetup.onSuccess`).
  Решение пользователя: возврат Full Setup — отдельный будущий план, не здесь.
- Удалить файл `frontend/src/components/BulkSetupWizard.tsx` и
  `frontend/src/components/MultiTaskProgressModal.tsx`, если grep не находит
  других вызывающих. **`TaskProgressModal.tsx` НЕ удалять** — его использует
  `pages/Activity.tsx`.
- Почистить `vi.mock` удалённых компонентов в тестах, где они станут висеть на
  несуществующие модули.

### Фаза 3 — `DomainDetailModal`: 5 вкладок → 2  `[x]`

Файл: `frontend/src/components/DomainDetailModal.tsx`.

- Удалить вкладки `db`, `ssl`, `nginx` и кнопку «Create Site» на `overview`.
- Тип `Tab` сузить до `"overview" | "ns"`.
- Удалить всё, что обслуживало удалённые вкладки: `snippet`, `presets`,
  соответствующие `useEffect`, `sslLabel`, хуки
  `useCreateSite/useCreateDb/useDbCredentials/useRequestSsl/useCancelSsl/`
  `useRefreshSsl/useSetNginxOverride/useGetNginxOverride`.
- `runAction` и `actionErrors` пересмотреть: после удаления остаётся одно
  действие (Set NS) на одной вкладке. Если механизм «ошибка на своей вкладке»
  выродился в один слот — упростить честно, но **не потерять** свойство
  «отказ Set NS переживает закрытие карточки» (`setNsError` из `MutationCache`,
  см. JSDoc на месте — его смысл сохранить).
- Вкладку `ns` не трогать функционально: она работает через Tauri
  `registrar_set_nameservers`.
- `overview` остаётся read-only-информацией (обогащение полями — план №2).

### Фаза 4 — Вычистить мёртвые хуки из `api/domains.ts`  `[x]`

Файл: `frontend/src/api/domains.ts`.

- Удалить: `useBulkProvisionDomains`, `useBulkFullSetup`, `useCreateSite`,
  `useCreateDb`, `useDbCredentials`, `useRequestSsl`, `useCancelSsl`,
  `useRefreshSsl`, `useSetNginxOverride`, `useGetNginxOverride`.
- Удалить осиротевшие типы: `ProvisionResponse`, `DomainDbCredentials`,
  `NginxOverridePayload`, `NginxOverrideResponse`, `BulkProvisionResponse`,
  `BulkFullSetupPayload`, `BulkFullSetupResponse` — **каждый** предварительно
  проверить grep'ом на других потребителей (в т.ч. в тестах).
- Оставить `SetNsResponse`, только если у него остались потребители.
- По образцу уже существующего комментария про `useMarkNsSet`/`useCheckNs`
  (строки 877–883) оставить одну короткую запись: что удалено и почему замены
  сегодня нет. Не переписывать историю, а зафиксировать причину.

### Фаза 5 — Тесты и верификация  `[x]`

- Обновить/починить тесты, ссылающиеся на удалённое:
  `Domains.provision.test.tsx`, `Domains.provisionerror.test.tsx`,
  `Domains.setns.test.tsx`, `Domains.serverstatus.test.tsx`,
  `DesktopWorkspace.provision.test.tsx`, `DomainDetailModal.setns.test.tsx`.
- Добавить тест на новое поведение: клик «Provision» в тулбаре под `isTauri()`
  зовёт `provision_bulk` (а не HTTP), и отчёт уходит в `onBulkProvisionResult`.
- Прогнать:
  - `cd frontend && npx tsc --noEmit`
  - `cd frontend && npm test`
  - grep-проверки:
    `grep -rn "bulk-provision\|bulk-full-setup\|create-site\|refresh-ssl\|ssl-request\|ssl-cancel\|create-db\|nginx-override" frontend/src`
    — живых `apiPost`/`apiGet` не остаётся (только `sdmp://`-CTA и тексты).

## Что НЕ трогаем

- Одиночный `useProvisionDomain` и диалог provision — работают.
- Вкладка `ns`, `useSetNameservers` — работает через Tauri.
- Bulk-assign server/CF, bulk-import, create/bulk-create — реальные роуты.
- `TaskProgressModal` — нужен `pages/Activity.tsx`.
- Бэкенд не трогаем вовсе.

## Явно откладываем

Возврат гранулярных операций (Create Site / Create DB / Request SSL /
Refresh SSL / nginx-override) через новые Tauri-команды + SSH-логику, и возврат
Full Setup через связку assign → `cf_create_zone` → `registrar_set_nameservers`.
Оба — фичи со своими планами, а не чистка. Решение пользователя от 2026-08-11.

## Итог

- Реализован целиком: да (фазы 1–5, все acceptance criteria закрыты).
  - Кнопка «Provision» тулбара идёт через `runBulkProvisionDomains` →
    `provision_bulk`. Перед запуском спрашивается подтверждение
    (`describeBulkProvision` — экспортируемая чистая функция: считает домены,
    называет их именами, длинный список урезает после 20): один клик стартует
    часы необратимой работы, остановить прогон нечем, а идемпотентность потом
    пометит набор отработавшим. Второй клик, пока висит диалог, гасится ref'ом.
  - Отчёт уходит новым обязательным пропом `onBulkProvisionResult` в
    `DesktopWorkspace`, который раскладывает его по уже существующим очередям
    (`provisionQueue` — пароли, `bulkReportQueue` — итог) общей функцией
    `deliverBulkProvision` — той же, что обслуживает deep link. Выделение
    снимается только при `status === "ok"`: у оборвавшегося прогона хвост
    `skipped` назван поимённо ради повтора по нему.
  - Отказ запуска показывается баннером `role="alert"` над тулбаром и гаснет
    вместе с изменением набора, к которому относился. Если экземпляр страницы,
    запустивший прогон, уже размонтирован, отказ уходит вторым новым
    обязательным пропом `onBulkProvisionError` в тост воркспейса — тем же, что
    сообщает об отказе этой же операции по `sdmp://`-ссылке.
  - «Идёт массовый прогон» читается из `MutationCache` по маркеру
    `bulkGateClaim` (`isBulkGateClaim` в `api/domains.ts`), а не из `useState`:
    страница размонтируется на любой навигации, и локальный флаг воскресал бы в
    `false`. Обе выборки из кэша (⚙ по домену и признак прогона) — одна подписка.
  - Из тулбара и страницы удалены «Refresh SSL» и «Full Setup» вместе с
    `BulkSetupWizard.tsx`, `MultiTaskProgressModal.tsx` и ветками
    `TaskProgressModal`/`MultiTaskProgressModal` (сам `TaskProgressModal`
    оставлен — его использует `pages/Activity.tsx`).
  - `DomainDetailModal` — две вкладки; `runAction`/`actionErrors` удалены как
    выродившиеся (действие осталось одно), свойство «отказ Set NS переживает
    закрытие карточки» сохранено (`setNsError` из `MutationCache`).
  - Тесты: добавлен `pages/Domains.bulkprovision.test.tsx` (18 кейсов),
    в `DesktopWorkspace.provision.test.tsx` — сквозной «клик тулбара → очереди
    воркспейса» и тост неудачи, из `DomainDetailModal.setns.test.tsx` убраны
    кейсы про удалённые вкладки и добавлен кейс «две вкладки вместо пяти».
  - Фаза 4: из `api/domains.ts` удалены все десять хуков HTTP-исполнения и
    семь осиротевших типов ответа. `SetNsResponse` тоже удалён — его последними
    потребителями были ровно эти хуки (`useCreateDb`, `useRequestSsl`,
    `useCancelSsl`, `useSetNginxOverride`); одноимённая схема на бэкенде
    (`SetNSResponse` в `schemas/domain.py`) не тронута, JSDoc `useSetNameservers`
    говорит именно про неё. `useUpdateDomain` оставлен — у него живой вызывающий
    (`ServerDetail`, действие «Edit domain»), и им же будет писаться привязка к
    зоне Cloudflare (план №3); над ним оставлена строчка, чтобы его не
    «прибрали». На месте удалённого — одна запись в стиле соседней записи про
    `useMarkNsSet`/`useCheckNs`: что удалено, почему это всегда был 404 и почему
    замены сегодня нет (гранулярные операции требуют новых Tauri-команд и
    SSH-логики — в `lib.rs` таких команд нет).
  - Удалён недостижимый `EditDomainModal` (167 строк) вместе с
    `EditDomainModalProps`, состоянием `editingDomain` и веткой рендера; из
    `Domains.tsx` ушли осиротевшие импорты `useUpdateDomain`,
    `useSetNameservers`, `MIN_NAMESERVERS`, `NS_DESKTOP_NOTE`, `useZoneDetails`,
    `useZoneNameservers`. Сами хуки оставлены, но по разным основаниям:
    `useSetNameservers`, `MIN_NAMESERVERS`, `NS_DESKTOP_NOTE` и
    `useZoneNameservers` зовёт `DomainDetailModal`, `useUpdateDomain` —
    `ServerDetail`, а `useZoneDetails` не зовёт больше никто (см. долг ниже).
    Тестов у модалки не было: открыть её было нечем.
  - Фаза 5: `npx tsc --noEmit` чист, `npm test` — 65 файлов / 633 теста
    зелёные (удалённое покрыто не было). Grep по
    `bulk-provision|bulk-full-setup|create-site|refresh-ssl|ssl-request|`
    `ssl-cancel|create-db|nginx-override` во `frontend/src` даёт только
    `sdmp://`-CTA, разбор deep link'ов, их тесты и объясняющие комментарии —
    ни одного живого `apiPost`/`apiGet`/`apiPut`. Grep по именам удалённых
    хуков и компонентов — только эти же комментарии. В
    `Domains.setns.test.tsx` поправлен комментарий, обещавший запросы кред БД и
    nginx-override: этих запросов нет с фазы 3.
  - Поправлена посылка исходного аудита: `apiPost` НЕ «чистый axios» — в Tauri
    он уходит в команду `api_request`. Подробности — в «Контексте» выше; та же
    поправка вписана в запись на месте удалённых хуков (`api/domains.ts`),
    потому что ложный механизм пережил бы план, а комментарий читают чаще.
  - Удаление `EditDomainModal` сделало ложным чужой комментарий —
    `api/cloudflare.ts` (у флага `isTauri()` в `useCloudflareZones`): он
    обосновывал «не выравнивать три хука под один флаг» тем, что `Domains.tsx`
    рисует по `useZoneDetails`/`useZoneNameservers` красное «Failed to load».
    Такой строки во фронте больше нет ни одной. Комментарий переписан по факту:
    у `useDnsRecords` ошибка — это объяснение для веба; у `useZoneNameservers`
    её читает вкладка NS карточки домена, но только под `isTauri()` (в вебе
    блок заменён одной строкой про «десктоп выполняет»), то есть флаг там
    ничего бы не изменил.
  - По итогам сквозного ревью ветки: `pending` тулбара разделён
    (`provisionPending` гасит только «Provision» — общий флаг держал бы «Assign
    Server»/«Assign CF» мёртвыми весь прогон, включая запущенный ссылкой по
    чужим доменам); тост воркспейса получил вариант неудачи (с общей зелёной
    галочкой он произносил «✓ keychain is locked», а для отказа прогона с уже
    покинутой страницы это единственная поверхность); заявкам гейта и самому
    provision проставлен `networkMode: "always"` (на «оффлайне» браузера
    react-query ставил заявку в `pending`, не запуская `mutationFn`, — она
    никогда не дожидалась `release()` и держала ⚙ «Provisioning…» бесконечно);
    очередь итога сужена до `BulkProvisionReport`, чтобы пароли не лежали в
    стейте воркспейса даже структурно; из `DomainUI` убраны поля `cf_zone_id` и
    `ns_updated_at`, осиротевшие с удалением `EditDomainModal`.
- Что осталось: ничего в объёме плана. Отложенное осознанно — в разделе «Явно
  откладываем» (гранулярные операции по домену и Full Setup через Tauri).
- Долг, заведённый этой чисткой: `useZoneDetails` (`api/cloudflare.ts:205`)
  остался БЕЗ производственных вызывающих — его единственным был удалённый
  `EditDomainModal`, сегодня хук зовёт только `api/cloudflare.test.ts`.
  Удалять не стали осознанно, и это отличается от десяти удалённых хуков: те
  всегда были 404, а этот рабочий (Tauri, `cf_list_zones`) и просто лишился UI.
  Его естественный потребитель — план №2 (обогащение read-only-обзора полями
  зоны). Если план №2 им не воспользуется, хук надо будет удалить там же.
