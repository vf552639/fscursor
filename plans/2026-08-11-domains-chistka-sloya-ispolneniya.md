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
`bulk-import-errors/{token}`. Больше ничего. `apiPost` (`api/client.ts`) —
чистый axios, не Tauri-aware, значит эти хуки бьют по HTTP всегда и всегда
получают 404.

Рабочая Tauri-реализация массового provision **есть** —
`runBulkProvisionDomains` (`api/domains.ts:761`) → команда `provision_bulk`,
но зовётся только из deep-link `sdmp://bulk-provision` (`lib/deepLink.ts:192`),
а не из кнопки тулбара.

## Acceptance criteria (что значит «готово»)

- [ ] Ни одна кнопка вкладки Domains и её модалок не бьёт в несуществующий роут.
- [ ] Кнопка «Provision» тулбара в десктопе идёт через Tauri `provision_bulk`
      (`runBulkProvisionDomains`), с тем же подоменным гейтом и с показом отчёта
      через ту же очередь показов, что у одиночного provision.
- [ ] Пароли FTP/БД из массового отчёта не оседают нигде, кроме показа один раз
      (не в `MutationCache.data`, не в localStorage, не в логах).
- [ ] `DomainDetailModal` — ровно 2 вкладки: `overview` (read-only) и `ns`.
- [ ] Мёртвый `EditDomainModal` и его состояние удалены целиком.
- [ ] Хуки-фикции удалены из `api/domains.ts`; grep не находит их импортов.
- [ ] Компоненты без вызывающих удалены (проверено grep'ом, не на глаз).
- [ ] `cd frontend && npm test` — прогон Domains/provision-тестов зелёный.
- [ ] `npx tsc --noEmit` во `frontend` без ошибок.

## Edge cases (продумать заранее)

- **Ноль выделенных доменов** — тулбар и так не рендерится при `selectedCount<=0`.
- **Домен уже провижинится** — `runBulkProvisionDomains` бросает
  `Provisioning of #N is already running.`; кнопка не должна глотать эту ошибку
  молча, текст обязан доехать до пользователя.
- **Двойной клик по «Provision»** — гейт подоменный (`PROVISION_DOMAIN_KEY` в
  `MutationCache`), плюс собственный `isPending` кнопки.
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
- Локальное состояние «идёт массовый прогон» (`useState`) для `disabled`
  кнопки: `pending` у `BulkActionToolbar` больше не может читаться из мутации.
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

### Фаза 4 — Вычистить мёртвые хуки из `api/domains.ts`  `[ ]`

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

### Фаза 5 — Тесты и верификация  `[ ]`

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

- Реализован целиком: нет. Сделаны фазы 1–3.
  - Кнопка «Provision» тулбара идёт через `runBulkProvisionDomains` →
    `provision_bulk`; отчёт уходит новым обязательным пропом
    `onBulkProvisionResult` в `DesktopWorkspace`, который раскладывает его по
    уже существующим очередям (`provisionQueue` — пароли, `bulkReportQueue` —
    итог) общей функцией `deliverBulkProvision` — той же, что обслуживает
    deep link. Отказ запуска показывается баннером `role="alert"` над тулбаром.
  - Из тулбара и страницы удалены «Refresh SSL» и «Full Setup» вместе с
    `BulkSetupWizard.tsx`, `MultiTaskProgressModal.tsx` и ветками
    `TaskProgressModal`/`MultiTaskProgressModal` (сам `TaskProgressModal`
    оставлен — его использует `pages/Activity.tsx`).
  - `DomainDetailModal` — две вкладки; `runAction`/`actionErrors` удалены как
    выродившиеся (действие осталось одно), свойство «отказ Set NS переживает
    закрытие карточки» сохранено (`setNsError` из `MutationCache`).
  - Тесты: добавлен `pages/Domains.bulkprovision.test.tsx` (7 кейсов), из
    `DomainDetailModal.setns.test.tsx` убраны кейсы про удалённые вкладки и
    добавлен кейс «две вкладки вместо пяти». `npx tsc --noEmit` чист,
    `npm test` — 65 файлов / 619 тестов зелёные.
- Что осталось: фаза 4 (удалить мёртвые хуки и осиротевшие типы из
  `api/domains.ts` — их определения ещё на месте, вызывающих нет) и остаток
  фазы 5 (финальные grep-проверки после фазы 4).
