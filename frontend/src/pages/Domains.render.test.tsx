import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Сколько строк перерисовывается на одно действие пользователя.
 *
 * Про что тест на самом деле: список бывает на двести строк, а каждая строка —
 * это разбор двух сроков, статуса сервера и его возраста. До мемоизации буква,
 * набранная в поиске, перерисовывала ВСЕ строки, и это ощущается пальцами.
 *
 * Проверяется именно число рендеров, потому что мемоизация ломается молча и
 * двумя разными способами: значением, которое меняется само (страница читала
 * `Date.now()` на каждый рендер и раздавала его строкам пропсом), и колбэком,
 * созданным заново на каждый рендер таблицы. Оба выглядят безобидно в диффе.
 *
 * Считаем через `DomainStatusBadge`: он рендерится ровно один раз на строку и
 * не мемоизирован сам, то есть его вызовы и есть рендеры строк.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  rowRendered: vi.fn(),
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

vi.mock("../components/domains/DomainStatusBadge", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const Actual = actual.default;
  return {
    default: (props: any) => {
      mocks.rowRendered();
      return <Actual {...props} />;
    },
  };
});

vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const ROWS = 12;

const DOMAINS = Array.from({ length: ROWS }, (_, i) => ({
  id: i + 1,
  domain_name: `site-${String(i).padStart(2, "0")}.com`,
  status: "active",
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: "2027-01-01",
  purchase_date: null,
  ns_status: "ok",
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}));

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
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} onBulkProvisionError={() => {}} onCloudflareBindNotice={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

const rowRenders = () => mocks.rowRendered.mock.calls.length;
const searchBox = () => screen.getByPlaceholderText("Search domains…");
const rowCount = () => within(screen.getByRole("table")).getAllByRole("row").length - 1;

describe("Domains — цена одного действия в рендерах строк", () => {
  it("ввод в поиске, ничего не отфильтровавший, не перерисовывает ни одной строки", async () => {
    renderPage();
    await screen.findByRole("table");
    expect(rowCount()).toBe(ROWS);

    const before = rowRenders();
    // «com» есть у всех: набор строк тот же, а массив — новый, и таблица
    // перерендерится. Строкам от этого достаться ничего не должно.
    fireEvent.change(searchBox(), { target: { value: "com" } });
    expect(rowCount()).toBe(ROWS);
    expect(rowRenders() - before).toBe(0);
  });

  it("выделение строки перерисовывает ровно её одну", async () => {
    renderPage();
    await screen.findByRole("table");

    const before = rowRenders();
    const boxes = within(screen.getByRole("table")).getAllByRole("checkbox");
    // Нулевой — «выделить всё» в шапке; первый — первая строка.
    fireEvent.click(boxes[1]);
    expect(rowRenders() - before).toBe(1);
  });
});
