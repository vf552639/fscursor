# План: Settings → Registrars — выбор провайдера из списка или добавление своего

> **Для агента-исполнителя:** реализуй задачи по порядку через
> superpowers:subagent-driven-development или superpowers:executing-plans.
> Шаги отмечены чекбоксами (`- [ ]`) — это трекинг прогресса.

**Дата:** 2026-08-16
**Связь с бизнесом:** снижает трение подключения регистраторов — пользователь ведёт
домены у любого регистратора, а не только у двух зашитых в UI. Провайдер с API
(Hostiq/Namecheap) работает по API; остальные заводятся как «ручные» ярлыки, чтобы
раскладывать по ним домены (расширение охвата инфраструктуры, см. `.business/goals/`).

**Goal:** в форме добавления аккаунта провайдер выбирается из выпадашки с поиском
(API-провайдеры + ранее использованные) либо создаётся новый прямо вводом имени;
поля API User / API Key показываются только у провайдеров с рабочим API-клиентом.

**Архитектура:** чисто фронтовая работа. `provider` в БД уже свободная строка
`String(64)`, серверные схемы enum не навязывают, блобы секретов опциональны — **бэкенд
и Rust не трогаем**. Новый каталог `lib/registrarProviders.ts` — источник правды о
**показе** провайдера (метка, буква аватара, цвета) и о `needsClientIp`. Ответ на вопрос
«есть ли API» он **не даёт сам, а наследует** у уже существующего
`lib/registrarCaps.ts` (`registrarSupportsNsApi`) — см. отклонение в итоге Фазы 1. Тип
`RegistrarProvider` из строгого юниона становится `string`; способность проверяется
функцией `hasApi()`, а не типом. Разросшийся `pages/Settings.tsx` разгружаем, вынеся
селектор в отдельный компонент `ProviderCombobox`.

**Tech Stack:** React 18 + TypeScript + Vite, Vitest + Testing Library. Существующая
инфраструктура секретов: `useMultiSecretSave`, `putSecretBlob`, `secretBlobKit` (тесты).

---

## Acceptance criteria (что значит «готово»)

- [x] В форме добавления аккаунта провайдер — одно поле-комбобокс: поиск, элементы с
      бейджем `API`/`manual`, снизу «＋ Создать „<ввод>“» когда введённого имени нет в списке.
- [x] Список провайдеров = API-каталог (Hostiq, Namecheap) ∪ уникальные `provider` уже
      заведённых аккаунтов; дедуп без учёта регистра; API-провайдеры идут первыми.
- [x] Выбран провайдер с API (`hasApi`) → показываются API User + API Key (+ Client IP у
      Namecheap), вся прежняя логика секрет-блобов и валидации IP цела.
- [x] Выбран ручной провайдер → полей учётных данных нет; «Add Account» доступна при
      заполненном имени аккаунта и выбранном провайдере; аккаунт создаётся с обоими
      `*_blob_id = null`, `api_user = null`.
- [ ] Карточка аккаунта: аватар/цвет из каталога (для кастомных — сгенерированные, без «?»),
      бейдж `API`/`manual`, подпись `Provider · api_user` (API) или `Provider · manual`;
      кнопка «Test» — только у API-провайдеров.
- [ ] Правка аккаунта: провайдер показан read-only; у ручного — только имя, без полей
      секретов; у API — как сейчас.
- [ ] `npm test` зелёный; существующие тесты секрет-блобов сохранены (адаптирован только
      способ выбора провайдера, ассерты про блобы — без изменений).

## Edge cases (продумать заранее)

- **Ноль аккаунтов:** список провайдеров = только API-каталог; «создать своего» доступно.
- **Сотни аккаунтов у разных провайдеров:** дедуп по нормализованному ключу, список не
      разрастается повторами; выпадашка со скроллом и поиском.
- **Регистр/пробелы:** `"Hostiq"`, `"hostiq"`, `" hostiq "` — один пункт в списке
      (`normalizeProvider` тримит). Но **API-способным** `" hostiq "` не считается: десктоп
      пробелы не срезает — см. отклонение в Фазе 1. Отсюда требование тримить ввод в форме.
- **Ввод имени, совпадающего с существующим (в другом регистре):** «Создать» не предлагаем,
      подсвечиваем существующий вариант.
- **Двойной клик / уход во время сохранения:** не регрессируем — `secrets.saving` по-прежнему
      гасит переключатель провайдера и Cancel (`switchProvider`, `closeIfIdle`).
- **Zero-knowledge:** у ручного провайдера секрет-полей нет вовсе → лишних блобов не заводим;
      плейнтекст ключа при переключении API→manual сбрасывается (`secrets.reset()`), как сейчас
      сбрасывается при Hostiq↔Namecheap.
- **Ручной аккаунт и десктоп:** для него не зовём `registrar_test_connection`/`get_domains`
      (десктоп вернул бы `unknown provider`) — гейт кнопки «Test» на фронте по `hasApi`.

---

## Файловая структура

- **Создаём:** `frontend/src/lib/registrarProviders.ts` — каталог API-провайдеров,
      `hasApi`/`needsClientIp`/`normalizeProvider`, `providerMeta`, `buildProviderList`.
- **Создаём:** `frontend/src/lib/registrarProviders.test.ts` — юниты чистого модуля.
- **Создаём:** `frontend/src/components/settings/ProviderCombobox.tsx` — селектор.
- **Создаём:** `frontend/src/components/settings/ProviderCombobox.test.tsx` — тесты селектора.
- **Меняем:** `frontend/src/api/registrars.ts` — `RegistrarProvider` → `string`.
- **Меняем:** `frontend/src/pages/Settings.tsx` — Add/Edit модалки и карточки на новый
      каталог/селектор; удаляем локальные `usesClientIp`, `plMap`, зашитые ветки `provider==="hostiq"`.
- **Меняем:** `frontend/src/pages/Settings.registrarblob.test.tsx` — адаптируем способ выбора
      провайдера (комбобокс вместо карточек); ассерты про блобы не трогаем.

---

## Фазы

### Фаза 1 — Каталог провайдеров и API-способность  `[x]`

Чистый модуль без React — вся логика «кто по API, как показать, что в списке». Тестируется
юнитами, питает и форму, и карточки.

**Files:**
- Create: `frontend/src/lib/registrarProviders.ts`
- Test: `frontend/src/lib/registrarProviders.test.ts`

- [x] **Шаг 1: Падающий тест на каталог и способность**
- [x] **Шаг 2: Прогнать — тест падает (модуль не существует)**
- [x] **Шаг 3: Реализация модуля**
- [x] **Шаг 4: Прогнать — тест зелёный**
- [x] **Шаг 5: Коммит** — `67ab2b4`

Исходный текст модуля и теста здесь больше не дублируется: он разъехался бы с
реализацией при первой же правке, а один из вариантов уже успел это сделать (см.
отклонение ниже). Актуальный код — в самих файлах; ниже только решения.

#### Отклонение от исходной спеки: `hasApi` не тримит, а наследует предикат  `[x]`

Спека предписывала `hasApi("  Namecheap ")` → `true` и собственную проверку
`normalizeProvider(provider) in API_PROVIDERS`. Реализовано **иначе**, и это осознанно.

В проекте уже был `lib/registrarCaps.ts` с `registrarSupportsNsApi` — зеркало
`registrars::make_service` десктопа, которое схлопывает регистр, но **намеренно не
срезает пробелы** (у него есть тест на это, и парный тест в Rust держит `" namecheap "`
среди контрольных входов: `make_service` отвечает на такую строку `unknown provider`).
Свой предикат в новом каталоге означал бы, что строка `" hostiq "` в колонке
`registrar_accounts.provider` (чужой импорт, ручная правка в БД) получает в Settings
бейдж `API`, живую кнопку «Test» и поля секретов, а на карточке домена рядом —
выключенный «Set NS»; за кнопкой «Test» её ждал бы `unknown provider` от десктопа. Один
аккаунт, два ответа, и оптимистичный из них ложный — прямое нарушение принципа
«не рисуй незнание здоровьем» (CLAUDE.md §6) и той самой причины, ради которой
`registrarCaps.ts` заведён.

Принято:

- `hasApi(provider)` — одна строка: `return registrarSupportsNsApi(provider)`. Предикат
  в проекте один; расходиться нечему по конструкции, а не по договорённости.
- `normalizeProvider` **сохраняет** trim: это другой вопрос — ключ для дедупа и поиска в
  каталоге. `" hostiq "` и `"Hostiq"` в выпадашке — один пункт, а для десктопа это разные
  строки. Разница проговорена в JSDoc обеих функций, чтобы не читалась опечаткой.
- `providerMeta(...).api` и выбор ветки внутри `providerMeta` считаются **тем же**
  `hasApi`, иначе бейдж «API» разъедется с кнопкой «Test» внутри одного экрана.
  Следствие: `providerMeta(" hostiq ")` — ручной (метка `hostiq`, буква `H`, цвет из
  палитры). Честно: десктоп такую строку не знает.
- `needsClientIp` стоит за тем же гейтом: у непризнанного провайдера полей API не
  спрашивают вовсе.
- Каталог читается только через `catalogEntry()` с `Object.prototype.hasOwnProperty.call`.
  Исходный `in` по объектному литералу отвечал `true` на `constructor`/`__proto__`/
  `valueOf` — а имя провайдера здесь свободный ввод, и такое имя уходило бы в API-ветку
  с `label: undefined` в аватаре.
- Буква аватара берётся по кодовым точкам (`[...display][0]`), иначе имя с эмодзи давало
  бы половину суррогатной пары.
- **Тест согласия с десктопом** (`registrarProviders.test.ts`): тем же приёмом, что в
  `registrarCaps.test.ts` (чтение `desktop/src-tauri/src/registrars/mod.rs` с диска),
  проверяется, что у каждого провайдера десктопа есть запись в `API_PROVIDERS` и что
  каждый ключ каталога признаётся `hasApi`. Проверено мутациями: тест краснеет в обе
  стороны и не вырождается, если константу в `mod.rs` переименуют. Цепочка замкнута
  целиком: `make_service` ← Rust-тест → `NS_API_PROVIDERS` ← файл-к-файлу →
  `registrarCaps` ← согласие → `API_PROVIDERS`.

Коммит правок: `79d2a69`.

**Следствие для форм (учесть в фазах 3–4):** раз `hasApi` не тримит, вставленное из
буфера `" Namecheap "` завело бы ручной ярлык без полей секретов и без «Test» — молча и
с виду как настоящий Namecheap. Лечение — **trim ввода в форме до сохранения**, а не
смягчение предиката. `ProviderCombobox` уже отдаёт наружу `q = query.trim()` и
`o.key`/`o.label` (обе тримленные), так что путь через селектор закрыт; проверить это
тестом при реализации фазы 3.

**Известный остаток (не долг фазы):** аккаунт, у которого пробелы уже лежат в колонке
`provider`, теперь честно показывается ручным, а провайдер в правке read-only — из UI
такую строку не починить. Регрессии нет (провайдер и раньше не редактировался), но
знать об этом стоит: чинится только в БД.

---

### Фаза 2 — Тип `RegistrarProvider` → `string`  `[x]`

Строгий юнион `"hostiq" | "namecheap"` мешает произвольным провайдерам. Ослаблен до
`string`; способность к API проверяет `hasApi()`, а не тип.

**Files:**
- Modify: `frontend/src/api/registrars.ts`

- [x] **Шаг 1: Ослабить тип**

```ts
// Было: export type RegistrarProvider = "hostiq" | "namecheap";
// Провайдер — свободная строка: у Hostiq/Namecheap есть API-клиент, любой другой
// заводится как ручной ярлык. Способность к API проверяет `hasApi()` из
// `lib/registrarProviders`, а не этот тип. Алиас оставлен для читаемости сигнатур.
export type RegistrarProvider = string;
```

- [x] **Шаг 2: Проверка типов** — `cd frontend && npx tsc --noEmit`, чисто.
- [x] **Шаг 3: Коммит** — `c059b69`.

Попутно (в `79d2a69`): у `RegistrarAccount.provider` убран хвост `| string` — после
ослабления алиаса он читался как `string | string`; и поправлен JSDoc в
`registrarCaps.ts`, который цитировал устаревшую форму типа как обоснование сигнатуры.
---

### Фаза 3 — Компонент `ProviderCombobox`  `[x]`

Выпадашка с поиском: показывает выбранного провайдера, раскрывает список (поиск + бейджи),
позволяет создать нового вводом имени. Вынесена из `Settings.tsx`, чтобы не растить его.

**Files:**
- Create: `frontend/src/components/settings/ProviderCombobox.tsx`
- Test: `frontend/src/components/settings/ProviderCombobox.test.tsx`

- [x] **Шаг 1: Падающий тест на поведение селектора**
- [x] **Шаг 2: Прогнать — падает (компонент не существует)**
- [x] **Шаг 3: Реализация компонента**
- [x] **Шаг 4: Прогнать — зелёный**
- [x] **Шаг 5: Коммит** — `680153a`

Дословный код здесь не дублируется по той же причине, что в Фазе 1: он уже разошёлся с
реализацией. Актуальный — в самих файлах; ниже только решения.

#### Что уходит наружу в `onChange` — главный контракт компонента  `[x]`

Три маршрута, и все три отдают строку **без пробелов по краям** — это требование Фазы 1
(`hasApi` пробелы не срезает, и `" Namecheap "` завёл бы ручной ярлык, с виду
неотличимый от настоящего Namecheap):

- API-пункт → нормализованный ключ (`"namecheap"`);
- ручной пункт → метка как записана (`"GoDaddy"`) — ярлык, а не ключ: в БД должно лечь
  человеческое написание;
- «＋ Создать» → `query.trim()`.

Закреплено тестами, а не комментарием.

#### Отклонения от исходного кода спеки  `[x]`

- **`rootRef` убран.** Он объявлялся, но нигде не читался. Клика-снаружи-закрывает в
  требованиях нет, и оставленный ref был бы обещанием несуществующего поведения.
- **ARIA-дерево починено.** В спеке `role="listbox"` висел на всплывашке, внутри которой
  лежало ещё и поле поиска, — у listbox не может быть потомков, кроме `option`/`group`.
  Роль перенесена на контейнер строго с опциями; пункт «＋ Создать» получил
  `role="option"` (он и есть выбираемый пункт списка), заглушка «Ничего не найдено»
  вынесена за listbox. На кнопке добавлены `aria-haspopup="listbox"` и `aria-expanded`.
- **`listVisible = open && !disabled`** — именованное понятие вместо повтора условия в
  двух местах; им же питается `aria-expanded`, иначе атрибут врал бы о раскрытости во
  время сохранения. `open` при этом намеренно не сбрасывается: по возвращении из
  `saving` пользователь видит ровно то, что открывал.
- **`afterEach(cleanup)` в тесте.** В `frontend/vite.config.ts` нет `globals: true`, то
  есть авто-очистки Testing Library нет — конвенция репозитория, так делают и соседние
  тест-файлы. Без него второй `render` в файле ломал бы `getByText`.
- **Ветка «Ничего не найдено» оставлена, но помечена как недостижимая.** Инвариант:
  `providerMeta` строит `label` так, что `label.toLowerCase() === key` в обеих ветках,
  поэтому совпавшая по ключу опция всегда проходит и подстрочный фильтр — пустой
  `filtered` не бывает без `canCreate`. Три строки разметки оставлены страховкой от
  тупика (пустая коробка без единого действия), а тест пришпилен к самому инварианту
  («поиск без совпадений всегда оставляет пункт Создать»), а не к недостижимой ветке.
- **Текущее значение включено в список опций** (правка по ревью, коммит ниже):
  `buildProviderList([...accounts, { provider: value }])`. Без этого только что созданный
  свой провайдер не имел `aria-selected` ни на одной опции, а поиск по его же имени
  предлагал «Создать» то, что уже выбрано, — то есть первый же живой сценарий формы
  Фазы 4 приводил в это состояние. Дедуп по нормализованному ключу гарантирует, что
  каталожный `value` не задвоится.

#### Долг, осознанно перенесённый в Фазу 5  `[ ]`

- **`ApiTag` дублирует примитив `Badge`** (`components/ui/Primitives.tsx`) — тот же
  сигнал «API против manual» Фаза 5 рисует именно `Badge`, и в двух разных зелёных. Либо
  перевести `ApiTag` на `Badge`, либо сознательно оставить голый тег в плотной строке
  выпадашки и тогда использовать его же в карточке. Вразнобой оставлять нельзя.
- **`Avatar` просится в общий `ProviderAvatar({ m, size })`** рядом, в
  `components/settings/` (не импортом из комбобокса в страницу). Копий сегодня две, и
  после Фазы 5 обе будут питаться одним `ProviderMeta`, но рисоваться разным кодом.
- **Возврат фокуса на кнопку после выбора** — сейчас фокус приземляется на `body`. Одна
  строка через `ref`; в объёме фазы этого не было.

---

### Фаза 4 — `AddRegistrarModal` на новый селектор + условные поля  `[x]`

Две карточки заменены на `ProviderCombobox`; поля секретов показываются по `hasApi()`, а не
по зашитому `provider==="hostiq"`. Ручной провайдер → полей нет, «Add Account» доступна по
имени аккаунта.

**Files:**
- Modify: `frontend/src/pages/Settings.tsx` (удалён локальный `usesClientIp`, переписано тело
      `AddRegistrarModal`).
- Modify: `frontend/src/pages/Settings.registrarblob.test.tsx` (helper выбора провайдера + три
      новых кейса).

- [x] **Шаг 1: Обновить существующие тесты под новый выбор провайдера** — helper `openAddModal`
      и веб-тест ходят через комбобокс (`role="button" name=/provider/i` → `role="option"`);
      ассерты про блобы не тронуты.
- [x] **Шаг 2: Прогнать — падает** (7 из 15 кейсов: формы-комбобокса ещё нет).
- [x] **Шаг 3: Переписать `AddRegistrarModal`**
- [x] **Шаг 4: Тесты на ручного провайдера**
- [x] **Шаг 5: Прогнать — зелёный** (файл 15/15; весь набор 972/972, `tsc --noEmit` чист).
- [x] **Шаг 6: Коммит**

Дословный код здесь не дублируется — по той же причине, что в фазах 1 и 3. Актуальный код в
файлах; ниже только решения и отклонения от исходной спеки.

#### Отклонение: ручной провайдер идёт ЧЕРЕЗ хук, а не мимо него  `[x]`

Спека предлагала для `!hasApi(provider)` раннюю ветку в обход `secrets.saveAll`
(`createReg.mutateAsync` напрямую, `secrets.reset()` как guard на пустое имя). Реализовано
**иначе**: `handleAdd` — одна ветка через `saveAll`, а от `hasApi` зависит только состав
`secrets` (пустой объект у ручного) и тело POST.

Почему: ветка в обход теряла оба канала обратной связи на ту же кнопку — `saving` (кнопка не
гаснет, двойной клик заводит два аккаунта) и `error` (упавший POST бросал бы необработанное
исключение, пользователю не показывалось бы ничего). Ровно об этом предупреждает комментарий
в `EditRegistrarModal`. `secrets.reset()` как проверка имени — вдобавок бессмыслица: он стирает
плейнтексты, ничего не проверяя, и мёртв при выключенной кнопке.

Пустой `secrets` — штатный путь `useMultiSecretSave`: `changing` пуст, блобы не пишутся,
`persist` всё равно зовётся, `saving`/`error` работают как обычно. Тем же путём ходит
«переименование без секретов» в правке (покрыто тестом).

#### Прочие решения фазы  `[x]`

- **`api_user` у ручного провайдера — жёсткий `null`** в `persist`: поля на экране нет, и
      остаток от ранее выбранного API-провайдера не должен уезжать в аккаунт. Закреплено
      ассертом в тесте.
- **Обе ссылки на блобы уходят спредом** (`...(blobIds.apiKey ? {…} : {})`), а не значением:
      серверная схема `extra="forbid"`, и ключ со значением `undefined` — это уже ключ. У
      API-провайдера `apiKey` при этом есть всегда (объявлен на создании, пустой плейнтекст
      хук отбивает до первой записи), так что поведение прежнее.
- **`accounts` у `AddRegistrarModal` — необязательный проп с дефолтом `[]`.** Это обогащение
      списка («ранее использованные»), а не входные данные формы; пустой список — законное
      состояние (первый запуск). Веб-тест гвардов `isTauri()` рендерит форму НАПРЯМУЮ (иначе
      его утверждения вакуумны) и остаётся про гварды, а не про списки.
- **`switchProvider` сравнивает строго (`next === provider`), а не по `normalizeProvider`.**
      Провайдер — свободная строка и уезжает в колонку как есть, поэтому «GoDaddy» при текущем
      «godaddy» — другое значение, и записать надо новое. Отличаться регистром могут только
      ручные ярлыки (у каталожных пунктов комбобокс отдаёт нормализованный ключ), а у них полей
      секретов нет — лишний `secrets.reset()` стирать нечему.
- **`apiUser` при смене провайдера НЕ сбрасывается.** Это не секрет, а логин: он всегда виден
      в своём поле, когда поле показано, и незаметно утечь ему некуда (у ручного в POST уезжает
      `null`). Сбрасывать его значило бы наказывать за переключение Hostiq↔Namecheap.
- **`disabled={secrets.saving || !accName.trim()}`**: у ручного провайдера имя — единственное,
      что отличает заполненную форму от пустой (секретов, которые отбил бы хук, у него нет).
      Кнопка по-прежнему только под `isTauri()`: создание живёт в десктопе и для ручного тоже
      (CLAUDE.md §3).
- **`EditRegistrarModal` тронут одной строкой** — `usesClientIp` → `needsClientIp`: удалить
      локальный предикат, оставив его единственного вызывающего, было нельзя. Поведение
      идентично на всех входах; остальное тело правки — за Фазой 6.
- **Два поля Namecheap (ключ + IP) больше не стоят в грид-колонках, а идут в столбец** — как
      следствие единой ветки `hasApi`. Функционально ничего не меняет.

Новые тесты (сверх спеки): упавшее создание ручного аккаунта показывает `role="alert"` и не
закрывает форму (пришпиливает решение «через хук» — без него «упрощение» обратно в обход
осталось бы зелёным), и «Add Account» выключена без имени аккаунта.

Коммит: `0ff7a50`.

---

### Фаза 5 — Карточки аккаунтов: бейджи, гейтинг Test, ручной провайдер  `[ ]`

Аватар/подпись — из `providerMeta`; кнопка «Test» — только у API; для ручного подпись
`Provider · manual`.

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:135-153` (рендер карточек).

- [ ] **Шаг 1: Падающий тест на карточку ручного провайдера**

Добавить в `Settings.registrarblob.test.tsx`:

```tsx
  it("карточка ручного провайдера: подпись manual и без кнопки Test", async () => {
    setTauri(true);
    renderPage([{ id: 9, provider: "GoDaddy", name: "gd", api_user: null, is_active: true,
      api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);

    expect(await screen.findByText(/GoDaddy · manual/)).toBeTruthy();
    // У ручного провайдера Test недостижим (десктоп вернул бы unknown provider).
    expect(screen.queryByRole("button", { name: "🔌 Test" })).toBeNull();
  });

  it("карточка API-провайдера сохраняет кнопку Test и api_user", async () => {
    setTauri(true);
    renderPage(); // NAMECHEAP по умолчанию
    expect(await screen.findByText(/Namecheap ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "🔌 Test" })).toBeTruthy();
  });
```

- [ ] **Шаг 2: Прогнать — падает (старый рендер: `?`, Test у всех)**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: FAIL на новых кейсах.

- [ ] **Шаг 3: Переписать рендер карточки (замена строк 135-153)**

```tsx
      ) : registrars.map((r: any) => {
        const m = providerMeta(r.provider);
        return <Card key={r.id} style={{ marginBottom: 12 }}>
          <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 9, background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: m.color, flexShrink: 0 }}>{m.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: "#111" }}>{r.name}</span>
                <Badge variant={r.is_active ? "green" : "gray"}>{r.is_active ? "Active" : "Inactive"}</Badge>
                <Badge variant={m.api ? "green" : "gray"}>{m.api ? "API" : "manual"}</Badge>
              </div>
              <div style={{ fontSize: 12.5, color: "#6b7280" }}>
                {m.label}{m.api ? <> · <span style={{ fontFamily: "monospace" }}>{r.api_user}</span></> : " · manual"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {m.api && testRes[r.id] && <Badge variant={testRes[r.id] === "ok" ? "green" : "red"}>{testRes[r.id] === "ok" ? "✓ Connected" : "✕ Failed"}</Badge>}
              {m.api && <Btn size="sm" variant="secondary" onClick={() => handleTest(r.id)} disabled={testing[r.id]}>{testing[r.id] ? "Testing…" : "🔌 Test"}</Btn>}
              <Btn size="sm" variant="secondary" onClick={() => setEditingRegistrar(r)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger" onClick={async () => { if (!(await confirmAction(`Delete registrar ${r.name}?`))) return; deleteReg.mutate(r); }}>✕</Btn>
            </div>
          </div>
        </Card>;
      })}
```

Импорт `providerMeta` добавить к уже добавленным из `lib/registrarProviders` (Фаза 4).
Удалить более не нужные локальные `plMap`/`pl`.

- [ ] **Шаг 4: Прогнать — зелёный**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.registrarblob.test.tsx
git commit -m "feat(registrars): карточки — бейдж API/manual, Test только у API, метаданные из каталога"
```

---

### Фаза 6 — `EditRegistrarModal`: провайдер read-only, ручной без секретов  `[ ]`

Правка провайдера ломала бы привязку блобов — показываем его read-only. Для ручного —
только имя.

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:373-460` (тело `EditRegistrarModal`).

- [ ] **Шаг 1: Падающий тест на правку ручного провайдера**

Добавить в `Settings.registrarblob.test.tsx`:

```tsx
  it("правка ручного провайдера: только имя, без полей секретов", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ id: 9, provider: "GoDaddy", name: "gd2", api_user: null,
      is_active: true, api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

    renderPage([{ id: 9, provider: "GoDaddy", name: "gd", api_user: null, is_active: true,
      api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
    fireEvent.click(await screen.findByRole("button", { name: "✎ Edit" }));

    // Провайдер виден, но не редактируется; полей секретов нет.
    expect(screen.getByText(/GoDaddy/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Leave empty to keep current key")).toBeNull();

    fireEvent.change(screen.getByDisplayValue("gd"), { target: { value: "gd2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    expect(mocks.apiPut.mock.calls[0][1].name).toBe("gd2");
  });
```

- [ ] **Шаг 2: Прогнать — падает (сейчас поле ключа есть у всех)**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: FAIL — поле «Leave empty to keep current key» присутствует для GoDaddy.

- [ ] **Шаг 3: Правки `EditRegistrarModal`**

Заменить `const hasClientIp = usesClientIp(String(registrar.provider || ""));` на
`needsClientIp`; добавить флаг API:

```tsx
  const providerHasApi = hasApi(String(registrar.provider || ""));
  const hasClientIp = needsClientIp(String(registrar.provider || ""));
```

После поля `Name`, перед полями секретов, показать провайдера read-only (замена/дополнение
блока строк 428-430):

```tsx
      <div>
        <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>Provider</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, color: "#6b7280", fontSize: 13.5 }}>
          {providerMeta(registrar.provider).label}
          <Badge variant={providerHasApi ? "green" : "gray"}>{providerHasApi ? "API" : "manual"}</Badge>
        </div>
      </div>
```

Существующую разметку полей **не переписываем**, а оборачиваем в условие `providerHasApi`:
блок `API User` (текущие строки 430), блок `API Key (optional)` (433-440) и блок
`{hasClientIp && (…Client IP…)}` (441-450) целиком помещаются внутрь одного
`{providerHasApi && (<> … </>)}`. Сама разметка каждого поля (label + `Inp`/`DesktopOnlyNote`)
остаётся дословно как сейчас — меняется только внешняя обёртка-условие. Результат:

```tsx
      {providerHasApi && (
        <>
          {/* существующий блок «API User» — без изменений */}
          {/* существующий блок «API Key (optional)» — без изменений */}
          {/* существующий блок «{hasClientIp && (…Client IP…)}» — без изменений */}
        </>
      )}
```

> `touched`/`saveAll` остаются как есть: для ручного провайдера `secrets.values.*` пусты
> (полей нет), `touched` = false для обоих, `saveAll` уходит с пустым `secrets` и делает
> чистый PUT имени — тот же путь, что «переименование без секретов» (уже покрыт тестом).

- [ ] **Шаг 4: Прогнать — зелёный**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.registrarblob.test.tsx
git commit -m "feat(registrars): правка — провайдер read-only, ручной аккаунт без полей секретов"
```

---

### Фаза 7 — Полный прогон сюиты и чистка  `[ ]`

- [ ] **Шаг 1: Прогнать весь фронтовый набор**

Run: `cd frontend && npx vitest run`
Expected: PASS. Если падает другой тест, ссылающийся на старые карточки провайдера
(`getByText("Hostiq")` как на кнопку выбора) — адаптировать под комбобокс тем же приёмом
(`role="button" name=/provider/i` → `role="option"`).

- [ ] **Шаг 2: Проверка типов**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок. Убедиться, что `usesClientIp` и `plMap` больше нигде не упоминаются:

Run: `grep -rn "usesClientIp\|plMap" frontend/src`
Expected: пусто.

- [ ] **Шаг 3: Финальный коммит (если были правки)**

```bash
git add -A
git commit -m "test(registrars): зелёная сюита после перехода на выбор провайдера"
```

---

## Итог

- Реализован целиком: **нет** — план к исполнению.
- Что осталось: все фазы 1–7.
- Заметки на будущее (осознанно вне объёма):
  - **Ручной провайдер не хранит креды** (вариант 1 из брейншторма). Если позже понадобится
    хранить API-ключ «для справки» у провайдера без клиента — это отдельная фича.
  - **Универсальный конфиг API в UI** (вариант C брейншторма) не делаем — YAGNI.
  - Новый Rust-клиент регистратора = добавить запись в `API_PROVIDERS` **и** ветку в
    `registrars::make_service`; каталог на фронте специально держит это в одном месте.
