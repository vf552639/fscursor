import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Сроки, сортировка и срез по статусам в списке доменов.
 *
 * Про что тест на самом деле: продукт заведён затем, чтобы про истечение домена
 * и сертификата человек узнавал от него, а не от клиента. Поэтому проверяется не
 * «в ячейке есть текст», а три правила:
 *   1) незнание срока рисуется прочерком, а не молчанием и не «всё хорошо»;
 *   2) битая дата даёт тот же прочерк, а не «NaN» и не падение страницы;
 *   3) при сортировке по сроку домены с НЕИЗВЕСТНЫМ сроком уходят в конец при
 *      ЛЮБОМ направлении — иначе оба вопроса («что горит», «что дальше всего»)
 *      заслоняют те, про кого ответа нет вовсе.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
// Тяжёлый сосед страницы, к срокам отношения не имеющий (та же преамбула, что в
// Domains.serverstatus.test.tsx, и по той же причине).
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Дата, отстоящая от «сейчас» на `ms`. Час сверху у вызывающих — не суеверие:
 * страница читает свои часы на несколько миллисекунд позже фикстуры, и ровно
 * суточное смещение перескакивало бы через границу полных суток то в одну
 * сторону, то в другую.
 */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const domainRow = (id: number, name: string, extra: Record<string, unknown>) => ({
  id,
  domain_name: name,
  status: "new",
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "pending",
  ns_updated_at: null,
  ssl_status: null,
  ssl_expires_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...extra,
});

/**
 * Имена подобраны так, что алфавит НЕ совпадает ни с порядком по сроку, ни с
 * порядком по статусу: иначе тест зеленел бы и на сортировке, которая ничего не
 * делает.
 */
const DOMAINS = [
  domainRow(1, "alpha.com", {
    status: "active",
    expiry_date: at(200 * DAY),
    ssl_status: "active",
    ssl_expires_at: at(40 * DAY + HOUR),
  }),
  // Срока нет вовсе — самый частый случай: домен, заведённый вручную.
  domainRow(2, "bravo.com", { status: "new" }),
  domainRow(3, "charlie.com", { status: "failed", expiry_date: at(-3 * DAY - HOUR) }),
  // Дата, которую не разобрать. Приезжает с сервера, и падать от неё нельзя.
  domainRow(4, "delta.com", { status: "ns_ok", expiry_date: "not-a-date" }),
  domainRow(5, "echo.com", { status: "site_created", expiry_date: at(10 * DAY + HOUR) }),
];

function renderPage() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return DOMAINS;
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} onBulkProvisionError={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  // Фильтр статуса страница зеркалит в адрес (`?status=`), а адрес в jsdom один
  // на весь файл: без сброса тест, потрогавший фильтр, задавал бы стартовый
  // фильтр всем следующим — и они не находили бы половину фикстур.
  window.history.replaceState({}, "", "/");
  renderPage();
  await screen.findByText("alpha.com");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

/** Строки таблицы (без шапки) в том порядке, в каком они на экране. */
function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0);
}

/** Имена доменов сверху вниз — то, что и есть «порядок» для пользователя. */
function rowNames(): string[] {
  return bodyRows().map((r) => within(r).getAllByRole("cell")[1].textContent?.trim() ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = bodyRows().find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`строки «${name}» в таблице нет`);
  return row;
}

const cell = (name: string, testId: string) => within(rowOf(name)).getByTestId(testId);

const header = (label: string) => screen.getByRole("button", { name: label }).closest("th") as HTMLElement;

const RED = "rgb(220, 38, 38)";
const AMBER = "rgb(217, 119, 6)";
const DIM = "rgb(156, 163, 175)";

describe("Domains — колонка Expires", () => {
  it("близкий срок называет и красит, просроченный — тоже", () => {
    const soon = cell("echo.com", "expiry-cell");
    expect(within(soon).getByText("in 10 days")).toBeTruthy();
    expect((within(soon).getByText("in 10 days") as HTMLElement).style.color).toBe(AMBER);

    const gone = cell("charlie.com", "expiry-cell");
    expect(within(gone).getByText("expired 3 days ago")).toBeTruthy();
    expect((within(gone).getByText("expired 3 days ago") as HTMLElement).style.color).toBe(RED);
  });

  it("отсутствие срока — прочерк, а не пустота и не «ok»", () => {
    // Правило продукта №6: незнание — отдельное состояние. Пустая ячейка
    // читается как «показывать нечего, значит порядок», то есть наоборот.
    const unknown = cell("bravo.com", "expiry-cell");
    expect(unknown.textContent?.trim()).toBe("—");
    expect((within(unknown).getByText("—") as HTMLElement).style.color).toBe(DIM);
  });

  it("нечитаемая дата даёт тот же прочерк, а не «Invalid Date»", () => {
    expect(cell("delta.com", "expiry-cell").textContent?.trim()).toBe("—");
  });

  it("срок сертификата стоит в колонке SSL — второй колонки под него нет", () => {
    const ssl = cell("alpha.com", "ssl-cell");
    expect(within(ssl).getByText("SSL active")).toBeTruthy();
    expect(within(ssl).getByText("in 40 days")).toBeTruthy();
    // «Сертификата нет» и «срок сертификата неизвестен» — оба про то, что даты
    // перевыпуска у нас нет, и молчать об этом нельзя.
    const none = cell("bravo.com", "ssl-cell");
    expect(within(none).getByText("— No SSL")).toBeTruthy();
    expect(within(none).getByText("—")).toBeTruthy();
  });
});

describe("Domains — сортировка по клику на заголовок", () => {
  it("по умолчанию — по имени, и направление видно в заголовке", () => {
    expect(rowNames()).toEqual(["alpha.com", "bravo.com", "charlie.com", "delta.com", "echo.com"]);
    expect(header("Domain").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Expires").getAttribute("aria-sort")).toBe("none");
  });

  it("клик по Expires ставит первым самый горящий домен", () => {
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    expect(rowNames().slice(0, 3)).toEqual(["charlie.com", "echo.com", "alpha.com"]);
    expect(header("Expires").getAttribute("aria-sort")).toBe("ascending");
  });

  it("повторный клик переворачивает порядок", () => {
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    expect(rowNames().slice(0, 3)).toEqual(["alpha.com", "echo.com", "charlie.com"]);
    expect(header("Expires").getAttribute("aria-sort")).toBe("descending");
  });

  it("домены без известного срока — в конце при ОБОИХ направлениях", () => {
    // Ни «в начале списка горящего», ни «в начале списка дальнего» им не место:
    // это не ответ на вопрос, а его отсутствие. Нечитаемая дата (delta) здесь
    // приравнена к отсутствующей (bravo) — пользователю разницы нет.
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    expect(rowNames().slice(-2)).toEqual(["bravo.com", "delta.com"]);
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    expect(rowNames().slice(-2)).toEqual(["bravo.com", "delta.com"]);
  });

  it("статус сортируется по жизненному циклу, а не по алфавиту", () => {
    // По алфавиту вышло бы «active, failed, new, ns_ok, site_created» — порядок
    // букв, из которого не видно, что доделано, а что нет.
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(rowNames()).toEqual(["bravo.com", "delta.com", "echo.com", "alpha.com", "charlie.com"]);
    // Второй клик поднимает наверх failed — то, что ищут вторым кликом.
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(rowNames()[0]).toBe("charlie.com");
  });

  it("сортировка идёт ПОСЛЕ фильтра, а не вместо него", () => {
    fireEvent.click(screen.getByRole("button", { name: "Expires" }));
    fireEvent.change(screen.getByDisplayValue("All Statuses"), { target: { value: "failed" } });
    expect(rowNames()).toEqual(["charlie.com"]);
  });

  it("клик по заголовку не отбирает у него фокус", () => {
    // Вторая сортировка — это ВТОРОЙ клик по тому же заголовку, на нём держится
    // вся функция. Пока `Th` объявлялся внутри компонента страницы, каждый
    // рендер создавал новый тип компонента, React перемонтировал ячейки шапки,
    // и фокус после первого нажатия уезжал на `body`: клавиатурному
    // пользователю, чтобы перевернуть порядок, приходилось протабливаться до
    // заголовка заново. Мышью это не видно вовсе.
    const btn = screen.getByRole("button", { name: "Expires" });
    btn.focus();
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Expires" })).toBe(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("у чекбокса и колонки действий сортировки нет", () => {
    // Кликабельный заголовок над кнопками обещал бы порядок, которого у них не
    // бывает.
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
    expect(within(headers[0]).queryByRole("button")).toBeNull();
    expect(within(headers[headers.length - 1]).queryByRole("button")).toBeNull();
  });
});

describe("Domains — срез по статусам и рассинхрон ns_ok", () => {
  it("второй ряд карточек показывает жизненный цикл и сходится с Total", () => {
    const card = (label: string) => screen.getByText(label).closest("div")?.parentElement as HTMLElement;
    expect(within(card("New")).getByText("1")).toBeTruthy();
    // ns_ok и site_created — оба «в работе»: перечислением статусов их легко
    // потерять, поэтому счётчик считается остатком и всегда сходится с Total.
    expect(within(card("In progress")).getByText("2")).toBeTruthy();
    expect(within(card("Active")).getByText("1")).toBeTruthy();
    expect(within(card("Failed")).getByText("1")).toBeTruthy();
  });

  it("ns_ok есть и в фильтре, и в бейдже — и бейдж не серый фолбэк", () => {
    // Ровно этот рассинхрон и держался: статус существует на бэкенде, а на
    // фронте его не было ни в списке фильтра, ни в карте бейджа.
    const filter = screen.getByDisplayValue("All Statuses");
    expect(within(filter).getByRole("option", { name: "NS_OK" })).toBeTruthy();

    const badge = within(rowOf("delta.com")).getByText("NS_OK");
    // Синий, а не серый (`#9ca3af` фолбэка) и не зелёный: NS проставлены — это
    // пройденная ступень, а не готовый домен.
    expect(badge.style.color).toBe("rgb(37, 99, 235)");
  });
});
