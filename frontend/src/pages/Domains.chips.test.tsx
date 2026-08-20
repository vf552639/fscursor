import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Чипы-фильтры вкладки Domains: по какому списку они считают.
 *
 * Про что тест на самом деле: счётчики обязаны считаться по ПОЛНОМУ списку, а
 * не по тому, что осталось после фильтра. Иначе выбранный чип обнуляет соседей
 * — «Failed 3» после клика по «Active» становится «Failed 0», — и вернуться к
 * ним некуда: ряд перестаёт быть картой списка и превращается в описание
 * текущего среза, то есть в тавтологию.
 *
 * Почему это отдельный файл, а не строчка в соседнем: правка
 * `domains={domains}` → `domains={filters.filtered}` в `pages/Domains.tsx`
 * выглядит очевидным улучшением («зачем считать по всему, если показываем
 * срез») и не роняла НИ ОДНОГО из трёхсот сорока тестов вкладки. Решение,
 * которому посвящён абзац в истории, не охранялось ничем.
 *
 * Проверяется именно страница, а не компонент чипов в одиночку: обнулить
 * счётчики можно и не трогая сам компонент — достаточно передать ему другой
 * список, и мимо теста на компонент такая правка прошла бы молча.
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

// Тяжёлые соседи страницы, к чипам отношения не имеющие.
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));

const domainRow = (id: number, name: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  domain_name: name,
  status,
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "ok",
  ssl_status: "active",
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

/**
 * Набор с РАЗНЫМИ числами на каждом чипе: 2 новых, 3 активных, 1 провал и один
 * промежуточный. Одинаковые числа сделали бы тест зелёным и у реализации,
 * которая считает по срезу, — совпадение приняли бы за правду.
 */
const DOMAINS = [
  domainRow(1, "new-a.com", "new"),
  domainRow(2, "new-b.com", "new"),
  domainRow(3, "live-a.com", "active"),
  domainRow(4, "live-b.com", "active"),
  domainRow(5, "live-c.com", "active"),
  domainRow(6, "broken.com", "failed", { ns_status: "error", ssl_status: "error" }),
  domainRow(7, "midway.com", "ns_ok", { ns_status: "pending" }),
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
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} onBulkProvisionError={() => {}} onCloudflareBindNotice={() => {}} onFullSetupNotice={() => {}} />
    </QueryClientProvider>,
  );
}

/** Чип — кнопка, подписанная словом и счётчиком: «Failed 1». */
const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
const countOn = (label: string) => within(chip(label)).getAllByText(/^\d+$/)[0].textContent;
const rowNames = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("td")?.parentElement?.textContent ?? "");

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
  // на весь файл: без сброса тест, потрогавший чип, задавал бы стартовый срез
  // всем следующим.
  window.history.replaceState({}, "", "/");
  renderPage();
  await screen.findByRole("table");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

describe("Domains — чипы считают по полному списку", () => {
  it("до выбора показывают срез всего списка", () => {
    expect(countOn("All")).toBe("7");
    expect(countOn("Active")).toBe("3");
    expect(countOn("New")).toBe("2");
    expect(countOn("Failed")).toBe("1");
  });

  it("выбранный чип не обнуляет соседей — их числа те же", () => {
    fireEvent.click(chip("Active"));
    // Таблица действительно сузилась: без этого утверждения тест был бы зелёным
    // и у чипа, который вовсе не фильтрует, — а тогда «счётчики не изменились»
    // не значит ничего.
    expect(rowNames().length).toBe(3);

    // И при этом ряд остался картой ВСЕГО списка: считай он по срезу, здесь
    // стояли бы «All 3, New 0, Failed 0» — то есть человек, кликнувший
    // «Active», терял бы из виду и провалы, и новые домены разом.
    expect(countOn("All")).toBe("7");
    expect(countOn("New")).toBe("2");
    expect(countOn("Failed")).toBe("1");
    expect(countOn("Active")).toBe("3");
  });

  it("строка NS-деталей тоже считает по полному списку", () => {
    // Тот же вопрос ко второй половине компонента: «In progress» и NS-срез
    // живут за кнопкой и посчитаны тем же вызовом, но проверить это дешевле,
    // чем однажды обнаружить, что срез уехал только у чипов.
    fireEvent.click(chip("Active"));
    fireEvent.click(screen.getByRole("button", { name: "NS details" }));

    expect(screen.getByText("In progress: 1")).toBeTruthy();
    expect(screen.getByText("NS Errors: 1")).toBeTruthy();
    expect(screen.getByText("Failed at SSL: 1")).toBeTruthy();
  });

  it("повторный клик по нажатому чипу снимает срез", () => {
    // Кнопка с `aria-pressed` обещает, что нажатое отжимается повторным
    // нажатием. Обещание надо либо выполнить, либо не давать.
    fireEvent.click(chip("Active"));
    expect(rowNames().length).toBe(3);
    expect(chip("Active").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("Active"));
    expect(rowNames().length).toBe(7);
    expect(chip("Active").getAttribute("aria-pressed")).toBe("false");
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
  });
});
