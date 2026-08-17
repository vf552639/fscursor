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
и Rust не трогаем**. Источник правды об «API-способности» на фронте — новый каталог
`lib/registrarProviders.ts`, зеркалящий `registrars::make_service` десктопа. Тип
`RegistrarProvider` из строгого юниона становится `string`; способность проверяется
функцией `hasApi()`, а не типом. Разросшийся `pages/Settings.tsx` разгружаем, вынеся
селектор в отдельный компонент `ProviderCombobox`.

**Tech Stack:** React 18 + TypeScript + Vite, Vitest + Testing Library. Существующая
инфраструктура секретов: `useMultiSecretSave`, `putSecretBlob`, `secretBlobKit` (тесты).

---

## Acceptance criteria (что значит «готово»)

- [ ] В форме добавления аккаунта провайдер — одно поле-комбобокс: поиск, элементы с
      бейджем `API`/`manual`, снизу «＋ Создать „<ввод>“» когда введённого имени нет в списке.
- [ ] Список провайдеров = API-каталог (Hostiq, Namecheap) ∪ уникальные `provider` уже
      заведённых аккаунтов; дедуп без учёта регистра; API-провайдеры идут первыми.
- [ ] Выбран провайдер с API (`hasApi`) → показываются API User + API Key (+ Client IP у
      Namecheap), вся прежняя логика секрет-блобов и валидации IP цела.
- [ ] Выбран ручной провайдер → полей учётных данных нет; «Add Account» доступна при
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
- **Регистр/пробелы:** `"Hostiq"`, `"hostiq"`, `" hostiq "` — один провайдер (нормализация).
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

### Фаза 1 — Каталог провайдеров и API-способность  `[ ]`

Чистый модуль без React — вся логика «кто по API, как показать, что в списке». Тестируется
юнитами, питает и форму, и карточки.

**Files:**
- Create: `frontend/src/lib/registrarProviders.ts`
- Test: `frontend/src/lib/registrarProviders.test.ts`

- [ ] **Шаг 1: Падающий тест на каталог и способность**

```ts
// frontend/src/lib/registrarProviders.test.ts
import { describe, it, expect } from "vitest";
import {
  hasApi,
  needsClientIp,
  normalizeProvider,
  providerMeta,
  buildProviderList,
} from "./registrarProviders";

describe("registrarProviders — API-способность", () => {
  it("hasApi: только каталожные провайдеры, без учёта регистра и пробелов", () => {
    expect(hasApi("hostiq")).toBe(true);
    expect(hasApi("  Namecheap ")).toBe(true);
    expect(hasApi("godaddy")).toBe(false);
    expect(hasApi("")).toBe(false);
  });

  it("needsClientIp: только Namecheap", () => {
    expect(needsClientIp("namecheap")).toBe(true);
    expect(needsClientIp("HOSTIQ")).toBe(false);
    expect(needsClientIp("godaddy")).toBe(false);
  });

  it("normalizeProvider: нижний регистр и trim", () => {
    expect(normalizeProvider("  Hostiq ")).toBe("hostiq");
  });
});

describe("registrarProviders — метаданные показа", () => {
  it("API-провайдер: метка и флаг из каталога", () => {
    const m = providerMeta("namecheap");
    expect(m.label).toBe("Namecheap");
    expect(m.api).toBe(true);
    expect(m.icon).toBe("N");
  });

  it("ручной провайдер: метка = ввод, буква = первая, api=false, без '?'", () => {
    const m = providerMeta("GoDaddy");
    expect(m.label).toBe("GoDaddy");
    expect(m.api).toBe(false);
    expect(m.icon).toBe("G");
  });

  it("ручной провайдер: цвет детерминирован по имени", () => {
    expect(providerMeta("GoDaddy").bg).toBe(providerMeta("godaddy").bg);
  });
});

describe("registrarProviders — список для выпадашки", () => {
  it("сначала API-каталог, затем уникальные ручные из аккаунтов", () => {
    const list = buildProviderList([
      { provider: "GoDaddy" },
      { provider: "godaddy" }, // дубль по регистру — не повторяем
      { provider: "hostiq" },  // уже в каталоге — не повторяем
    ]);
    const keys = list.map((o) => o.key);
    expect(keys.slice(0, 2)).toEqual(["hostiq", "namecheap"]); // каталог первым
    expect(keys.filter((k) => k === "godaddy").length).toBe(1);
    expect(list.find((o) => o.key === "godaddy")?.api).toBe(false);
  });

  it("ноль аккаунтов: только API-каталог", () => {
    expect(buildProviderList([]).map((o) => o.key)).toEqual(["hostiq", "namecheap"]);
  });
});
```

- [ ] **Шаг 2: Прогнать — тест падает (модуль не существует)**

Run: `cd frontend && npx vitest run src/lib/registrarProviders.test.ts`
Expected: FAIL — `Cannot find module './registrarProviders'`.

- [ ] **Шаг 3: Реализация модуля**

```ts
// frontend/src/lib/registrarProviders.ts

/**
 * Провайдеры со встроенным Rust-клиентом в десктопе. Зеркалит
 * `registrars::make_service` (desktop/src-tauri/src/registrars/mod.rs): у кого
 * здесь есть запись — у того реально работают test_connection / get_domains /
 * set_nameservers. Всё остальное — «ручной» провайдер: хранится ярлыком, API нет.
 *
 * ЕДИНСТВЕННЫЙ источник правды об API-способности на фронте. Добавляя новый
 * Rust-клиент, добавь запись СЮДА — иначе форма не покажет ему поля секретов, а
 * карточка — кнопку Test.
 */
export const API_PROVIDERS = {
  hostiq: { label: "Hostiq", icon: "H", bg: "#fff7ed", color: "#ea580c", needsClientIp: false },
  namecheap: { label: "Namecheap", icon: "N", bg: "#fef2f2", color: "#dc2626", needsClientIp: true },
} as const;

export type ApiProviderKey = keyof typeof API_PROVIDERS;

/** В БД `provider` — свободная строка; "Hostiq"/" hostiq " — один провайдер. */
export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Есть ли у провайдера рабочий API-клиент. Не в каталоге → ручной. */
export function hasApi(provider: string): boolean {
  return normalizeProvider(provider) in API_PROVIDERS;
}

/** Нужно ли поле Client IP (сегодня — только Namecheap). */
export function needsClientIp(provider: string): boolean {
  const meta = API_PROVIDERS[normalizeProvider(provider) as ApiProviderKey];
  return !!meta && meta.needsClientIp;
}

export interface ProviderMeta {
  key: string;   // нормализованный ключ (для дедупа и сравнения)
  label: string; // человекочитаемое имя
  icon: string;  // одна буква для аватара
  bg: string;    // фон аватара
  color: string; // цвет буквы
  api: boolean;  // есть ли API-клиент
}

/**
 * Палитра для ручных провайдеров: детерминированный цвет по имени, чтобы список
 * не был серым и один провайдер всегда красился одинаково (а не «?» на сером,
 * как раньше давал неизвестный provider на карточке).
 */
const MANUAL_PALETTE = [
  { bg: "#eef2ff", color: "#4f46e5" },
  { bg: "#ecfeff", color: "#0891b2" },
  { bg: "#f0fdf4", color: "#16a34a" },
  { bg: "#fef3c7", color: "#b45309" },
  { bg: "#fce7f3", color: "#be185d" },
  { bg: "#f3f4f6", color: "#374151" },
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Метаданные показа: API — из каталога, ручной — из палитры по хешу имени. */
export function providerMeta(provider: string): ProviderMeta {
  const key = normalizeProvider(provider);
  const api = API_PROVIDERS[key as ApiProviderKey];
  if (api) {
    return { key, label: api.label, icon: api.icon, bg: api.bg, color: api.color, api: true };
  }
  const display = provider.trim() || "?";
  const pal = MANUAL_PALETTE[hashIndex(key || "?", MANUAL_PALETTE.length)];
  return { key, label: display, icon: (display[0] || "?").toUpperCase(), bg: pal.bg, color: pal.color, api: false };
}

/**
 * Список для выпадашки: сначала API-каталог (частый кейс сверху), затем
 * уникальные провайдеры уже заведённых аккаунтов (ручные). Без повторов по
 * нормализованному ключу. Отдельной таблицы провайдеров нет — «ранее
 * использованные» выводятся из списка аккаунтов, который и так грузится на вкладке.
 */
export function buildProviderList(accounts: { provider: string }[]): ProviderMeta[] {
  const seen = new Set<string>();
  const out: ProviderMeta[] = [];
  for (const key of Object.keys(API_PROVIDERS)) {
    out.push(providerMeta(key));
    seen.add(key);
  }
  for (const acc of accounts) {
    const key = normalizeProvider(acc.provider);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(providerMeta(acc.provider));
  }
  return out;
}
```

- [ ] **Шаг 4: Прогнать — тест зелёный**

Run: `cd frontend && npx vitest run src/lib/registrarProviders.test.ts`
Expected: PASS (все кейсы).

- [ ] **Шаг 5: Коммит**

```bash
git add frontend/src/lib/registrarProviders.ts frontend/src/lib/registrarProviders.test.ts
git commit -m "feat(registrars): каталог провайдеров и API-способность (чистый модуль)"
```

---

### Фаза 2 — Тип `RegistrarProvider` → `string`  `[ ]`

Строгий юнион `"hostiq" | "namecheap"` мешает произвольным провайдерам. Ослабляем до
`string`; способность к API теперь проверяет `hasApi()`, а не тип.

**Files:**
- Modify: `frontend/src/api/registrars.ts:14` (тип), затрагиваемые места создания.

- [ ] **Шаг 1: Ослабить тип**

В `frontend/src/api/registrars.ts` заменить строку 14:

```ts
// Было: export type RegistrarProvider = "hostiq" | "namecheap";
// Провайдер — свободная строка: у Hostiq/Namecheap есть API-клиент, любой другой
// заводится как ручной ярлык. Способность к API проверяет `hasApi()` из
// `lib/registrarProviders`, а не этот тип. Алиас оставлен для читаемости сигнатур.
export type RegistrarProvider = string;
```

- [ ] **Шаг 2: Убедиться, что типы всё ещё компилируются**

Run: `cd frontend && npx tsc --noEmit`
Expected: без новых ошибок (алиас = string, все прежние присваивания валидны).

- [ ] **Шаг 3: Коммит**

```bash
git add frontend/src/api/registrars.ts
git commit -m "refactor(registrars): RegistrarProvider как свободная строка"
```

---

### Фаза 3 — Компонент `ProviderCombobox`  `[ ]`

Выпадашка с поиском: показывает выбранного провайдера, раскрывает список (поиск + бейджи),
позволяет создать нового вводом имени. Выносим из `Settings.tsx`, чтобы не растить его.

**Files:**
- Create: `frontend/src/components/settings/ProviderCombobox.tsx`
- Test: `frontend/src/components/settings/ProviderCombobox.test.tsx`

- [ ] **Шаг 1: Падающий тест на поведение селектора**

```tsx
// frontend/src/components/settings/ProviderCombobox.test.tsx
import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderCombobox } from "./ProviderCombobox";

function Harness({ accounts = [] as { provider: string }[], onChange = vi.fn() }) {
  const [value, setValue] = useState("hostiq");
  return (
    <ProviderCombobox
      value={value}
      accounts={accounts}
      onChange={(p) => { setValue(p); onChange(p); }}
    />
  );
}

describe("ProviderCombobox", () => {
  it("показывает выбранного провайдера и бейдж API", () => {
    render(<Harness />);
    expect(screen.getByText("Hostiq")).toBeTruthy();
    expect(screen.getByText("API")).toBeTruthy();
  });

  it("выбор существующего провайдера из списка зовёт onChange с ключом", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(onChange).toHaveBeenCalledWith("namecheap");
  });

  it("ранее использованный ручной провайдер попадает в список", () => {
    render(<Harness accounts={[{ provider: "GoDaddy" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    expect(screen.getByRole("option", { name: /GoDaddy/ })).toBeTruthy();
    // помечен manual, а не API
    const opt = screen.getByRole("option", { name: /GoDaddy/ });
    expect(opt.textContent).toContain("manual");
  });

  it("ввод неизвестного имени предлагает создать и отдаёт его как есть", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "Porkbun" } });
    fireEvent.click(screen.getByText(/Создать/));
    expect(onChange).toHaveBeenCalledWith("Porkbun");
  });

  it("ввод существующего имени (в другом регистре) не предлагает создать", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "HOSTIQ" } });
    expect(screen.queryByText(/Создать/)).toBeNull();
  });
});
```

- [ ] **Шаг 2: Прогнать — падает (компонент не существует)**

Run: `cd frontend && npx vitest run src/components/settings/ProviderCombobox.test.tsx`
Expected: FAIL — `Cannot find module './ProviderCombobox'`.

- [ ] **Шаг 3: Реализация компонента**

```tsx
// frontend/src/components/settings/ProviderCombobox.tsx
import React, { useMemo, useRef, useState } from "react";
import {
  buildProviderList,
  providerMeta,
  normalizeProvider,
  type ProviderMeta,
} from "../../lib/registrarProviders";

interface Props {
  value: string;
  onChange: (provider: string) => void;
  accounts: { provider: string }[];
  /** Во время записи блобов/POST переключать провайдера нельзя (см. AddRegistrarModal). */
  disabled?: boolean;
}

function Avatar({ m }: { m: ProviderMeta }) {
  return (
    <div style={{ width: 28, height: 28, borderRadius: 7, background: m.bg, color: m.color,
      display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
      {m.icon}
    </div>
  );
}

function ApiTag({ api }: { api: boolean }) {
  return api ? (
    <span style={{ background: "#dcfce7", color: "#166534", fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>API</span>
  ) : (
    <span style={{ color: "#9ca3af", fontSize: 11 }}>manual</span>
  );
}

export function ProviderCombobox({ value, onChange, accounts, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => buildProviderList(accounts), [accounts]);
  const selected = providerMeta(value);

  const q = query.trim();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    : options;
  // Предлагаем «создать», только если введённого имени нет среди опций по
  // нормализованному ключу — иначе плодили бы дубль существующего провайдера.
  const exists = options.some((o) => o.key === normalizeProvider(q));
  const canCreate = q.length > 0 && !exists;

  const pick = (provider: string) => {
    onChange(provider);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Provider"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
          border: "2px solid #2563eb", borderRadius: 8, background: "#fff", cursor: disabled ? "default" : "pointer" }}
      >
        <Avatar m={selected} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#111" }}>{selected.label}</span>
        <ApiTag api={selected.api} />
        <span style={{ marginLeft: "auto", color: "#9ca3af" }}>▾</span>
      </button>

      {open && !disabled && (
        <div role="listbox" style={{ position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, right: 0,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.08)", overflow: "hidden" }}>
          <div style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск провайдера…"
              style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {filtered.map((o) => (
              <div key={o.key} role="option" aria-selected={o.key === selected.key} onClick={() => pick(o.api ? o.key : o.label)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer",
                  background: o.key === selected.key ? "#eff4ff" : "#fff" }}>
                <Avatar m={o} />
                <span style={{ fontSize: 13, color: "#111" }}>{o.label}</span>
                <span style={{ marginLeft: "auto" }}><ApiTag api={o.api} /></span>
              </div>
            ))}
            {canCreate && (
              <div onClick={() => pick(q)} style={{ padding: "9px 12px", cursor: "pointer", color: "#2563eb",
                fontSize: 13, borderTop: filtered.length ? "1px solid #f1f5f9" : "none" }}>
                ＋ Создать «{q}»
              </div>
            )}
            {!filtered.length && !canCreate && (
              <div style={{ padding: "10px 12px", color: "#9ca3af", fontSize: 13 }}>Ничего не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Шаг 4: Прогнать — зелёный**

Run: `cd frontend && npx vitest run src/components/settings/ProviderCombobox.test.tsx`
Expected: PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add frontend/src/components/settings/ProviderCombobox.tsx frontend/src/components/settings/ProviderCombobox.test.tsx
git commit -m "feat(registrars): ProviderCombobox — выбор из списка или создание своего"
```

---

### Фаза 4 — `AddRegistrarModal` на новый селектор + условные поля  `[ ]`

Заменяем две карточки на `ProviderCombobox`; поля секретов показываем по `hasApi()`, а не по
зашитому `provider==="hostiq"`. Ручной провайдер → полей нет, «Add Account» доступна по имени.

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:31-36` (удаляем локальный `usesClientIp`),
      `:246-371` (тело `AddRegistrarModal`).
- Modify: `frontend/src/pages/Settings.registrarblob.test.tsx` (helper выбора провайдера).

- [ ] **Шаг 1: Обновить существующие тесты под новый выбор провайдера (сначала падают)**

В `Settings.registrarblob.test.tsx` заменить helper `openAddModal` (строки 88-94) и
прямой клик по карточке в веб-тесте (строка 320):

```tsx
async function openAddModal(provider: "hostiq" | "namecheap") {
  fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);
  if (provider === "namecheap") {
    // Комбобокс вместо карточек: открыть и выбрать опцию.
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
  }
  fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), {
    target: { value: "reg-new" },
  });
}
```

В тесте «сама форма в вебе…» (строка ~320) заменить `fireEvent.click(screen.getByText("Namecheap"))` на:

```tsx
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
```

- [ ] **Шаг 2: Прогнать — часть тестов падает (форма ещё на карточках)**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: FAIL на кейсах Namecheap (нет `role="option"`, т.к. форма ещё старая).

- [ ] **Шаг 3: Переписать `AddRegistrarModal`**

Удалить локальный `usesClientIp` (строки 33-36) — используем `needsClientIp` из модуля.
Заменить тело формы. Импорты в шапке `Settings.tsx`:

```tsx
import { hasApi, needsClientIp } from "../lib/registrarProviders";
import { ProviderCombobox } from "../components/settings/ProviderCombobox";
```

Селектор провайдера (замена блока строк 302-314):

```tsx
      <div>
        <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 8 }}>Provider</label>
        <ProviderCombobox value={provider} accounts={registrars} disabled={secrets.saving} onChange={switchProvider} />
      </div>
```

`registrars` пробрасываем в `AddRegistrarModal` пропсом (список для «ранее использованных»).
Сигнатура: `export function AddRegistrarModal({ onClose, accounts }: { onClose: () => void; accounts: { provider: string }[] })`.
Вызов (строка 154) заменить на:

```tsx
      {showAdd && <AddRegistrarModal onClose={() => setSA(false)} accounts={registrars} />}
```

Внутри комбобокса источник списка — этот проп: `<ProviderCombobox ... accounts={accounts} />`.

Условные поля (замена блока строк 315-355) — ветвление по `hasApi`, а не по имени:

```tsx
      {hasApi(provider) ? (
        <>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>API User{needsClientIp(provider) ? "" : " (email)"}</label>
            <Inp value={apiUser} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiUser((e.target as any).value)} placeholder={needsClientIp(provider) ? "your_namecheap_username" : "admin@hostiq.ua"} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>API Key</label>
            {isTauri() ? (
              <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => secrets.setValue("apiKey", e.target.value.trim())} placeholder={needsClientIp(provider) ? "••••••••" : "••••••••••••••••"} />
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
          {needsClientIp(provider) && (
            <>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>Client IP</label>
                {isTauri() ? (
                  <Inp value={secrets.values.apiSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>) => secrets.setValue("apiSecret", e.target.value.trim())} placeholder="127.0.0.1" />
                ) : (
                  <DesktopOnlyNote what="Saving secrets" />
                )}
              </div>
              <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: -6 }}>Namecheap accepts API calls only from IPs whitelisted in your account.</div>
            </>
          )}
        </>
      ) : null}
```

> ВНИМАНИЕ на два плейсхолдера ключа: тесты `Settings.registrarblob.test.tsx` ищут поле по
> `"••••••••"` (Namecheap) и `"••••••••••••••••"` (Hostiq). Сохрани ровно эти строки —
> они различают два поля в тестах.

`handleAdd` уже ветвит объявление блобов по `usesClientIp(provider)` — заменить на
`needsClientIp(provider)` (строки 263, а также любые вхождения `usesClientIp`). Логика
«ключ объявляется всегда» остаётся для API-провайдеров; для ручного `hasApi` = false, но
секрет-полей нет — пользователь не наберёт ключ. Чтобы ручной аккаунт создавался с
`null`-блобами, `handleAdd` для не-API идёт мимо секретов:

```tsx
  const handleAdd = async () => {
    // Ручной провайдер: полей секретов нет, создаём ярлык с null-блобами. Мимо
    // `saveAll` — иначе он потребовал бы объявленный `apiKey`, которого тут нет.
    if (!hasApi(provider)) {
      if (!accName.trim()) { secrets.reset(); return; } // имя обязательно
      await createReg.mutateAsync({ provider, name: accName, api_user: null });
      onClose();
      return;
    }
    const ok = await secrets.saveAll({
      secrets: {
        apiKey: { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: null },
        ...(needsClientIp(provider)
          ? { apiSecret: { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: null } }
          : {}),
      },
      persist: async (blobIds) => {
        await createReg.mutateAsync({
          provider,
          name: accName,
          api_user: apiUser,
          api_key_blob_id: blobIds.apiKey,
          ...(blobIds.apiSecret ? { api_secret_blob_id: blobIds.apiSecret } : {}),
        });
      },
    });
    if (ok) onClose();
  };
```

Кнопка «Add Account» сейчас видна только в `isTauri()`. Для ручного провайдера её надо
показывать и без десктопа? — Нет: создание аккаунта живёт только в десктопе (веб read-only),
как и для API. Оставляем условие `isTauri()` как есть; для ручного провайдера внутри Tauri
кнопка активна по заполненному имени. Заменить `disabled={secrets.saving}` на
`disabled={secrets.saving || !accName.trim()}`.

`switchProvider` (строки 288-292) — тип аргумента уже `string` (алиас), логика цела:
`setProvider(next); secrets.reset();`.

- [ ] **Шаг 4: Тест на ручной провайдер (падающий → зелёный)**

Добавить в `Settings.registrarblob.test.tsx`:

```tsx
  it("ручной провайдер: без полей секретов, создаётся с null-блобами", async () => {
    setTauri(true);
    mocks.apiPost.mockResolvedValue({ id: 9, provider: "GoDaddy", name: "gd", api_user: null,
      is_active: true, api_key_blob_id: null, api_secret_blob_id: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

    renderPage([]);
    fireEvent.click((await screen.findAllByRole("button", { name: "+ Add Registrar" }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /provider/i }));
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "GoDaddy" } });
    fireEvent.click(screen.getByText(/Создать/));
    fireEvent.change(screen.getByPlaceholderText("e.g., Hostiq Main"), { target: { value: "gd" } });

    // Полей секретов нет вовсе.
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(screen.queryByPlaceholderText("••••••••••••••••")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    // Ни одного блоба; тело без ссылок на секреты.
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/registrars/accounts");
    expect(body.provider).toBe("GoDaddy");
    expect(body).not.toHaveProperty("api_key_blob_id");
    expect(body).not.toHaveProperty("api_secret_blob_id");
  });
```

- [ ] **Шаг 5: Прогнать весь файл — зелёный**

Run: `cd frontend && npx vitest run src/pages/Settings.registrarblob.test.tsx`
Expected: PASS (старые кейсы через комбобокс + новый про ручного).

- [ ] **Шаг 6: Коммит**

```bash
git add frontend/src/pages/Settings.tsx frontend/src/pages/Settings.registrarblob.test.tsx
git commit -m "feat(registrars): комбобокс провайдера и условные поля секретов в AddRegistrarModal"
```

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
