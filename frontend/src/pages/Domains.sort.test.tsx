import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { domainsKeys } from "../api/domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Выбранный порядок строк переживает подмену таблицы.
 *
 * Про что тест на самом деле: страница показывает вместо таблицы три разных
 * экрана — ошибку загрузки, ожидание и «доменов нет вовсе». Пока порядок жил
 * внутри `DomainTable`, каждая такая подмена молча возвращала его к умолчанию,
 * причём первая наступает БЕЗ действий пользователя: react-query держит
 * прежние `data` и переводит `status` в `error`, когда фоновый рефетч исчерпал
 * ретраи. То есть сетевая икота на открытой странице сбрасывала колонку, по
 * которой человек только что отсортировал две сотни доменов, — и заметить это
 * можно было только глазами.
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

vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const domainRow = (id: number, name: string, created: string) => ({
  id,
  domain_name: name,
  status: "active",
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "ok",
  ns_updated_at: null,
  created_at: created,
  updated_at: created,
});

// Порядок по имени (умолчание) и порядок по дате заведения намеренно разные:
// иначе «порядок сохранился» неотличимо от «порядок сбросился».
const DOMAINS = [
  domainRow(1, "alpha.com", "2026-03-01T00:00:00Z"),
  domainRow(2, "beta.com", "2026-01-01T00:00:00Z"),
  domainRow(3, "gamma.com", "2026-02-01T00:00:00Z"),
];

function serveDomains(rows: unknown[]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
}

function renderPage() {
  serveDomains(DOMAINS);
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

const header = (label: string) => screen.getByRole("columnheader", { name: new RegExp(label) });
const sortBtn = (label: string) => screen.getByRole("button", { name: `Sort by ${label}` });

/** Имена доменов в том порядке, в каком их видит пользователь. */
function orderedNames(): string[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((r) => r.querySelector("button")?.textContent ?? "");
}

describe("Domains — порядок строк переживает подмену таблицы", () => {
  it("сетевая икота показывает экран ошибки и не сбрасывает сортировку", async () => {
    renderPage();
    await screen.findByRole("table");

    fireEvent.click(sortBtn("Added"));
    expect(orderedNames()).toEqual(["beta.com", "gamma.com", "alpha.com"]);

    // Фоновый рефетч падает: `data` остаются, `status` уходит в `error` — и
    // страница подменяет таблицу экраном ошибки.
    serveDomains([]);
    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === "/domains") throw new Error("network is down");
      return url === "/servers" ? { items: [], total: 0 } : [];
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: domainsKeys.all }).catch(() => {});
    });
    // `findBy`, а не `getBy`: react-query разносит уведомления наблюдателей
    // через `setTimeout(0)`, и синхронная проверка успевает раньше рендера.
    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByRole("table")).toBeNull();

    // Сеть вернулась.
    serveDomains(DOMAINS);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: domainsKeys.all });
    });
    await screen.findByRole("table");
    await waitFor(() => expect(header("Added").getAttribute("aria-sort")).toBe("ascending"));
    expect(orderedNames()).toEqual(["beta.com", "gamma.com", "alpha.com"]);
  });

  it("опустевший и снова наполнившийся список не сбрасывает сортировку", async () => {
    renderPage();
    await screen.findByRole("table");

    fireEvent.click(sortBtn("Domain"));
    expect(header("Domain").getAttribute("aria-sort")).toBe("descending");
    expect(orderedNames()).toEqual(["gamma.com", "beta.com", "alpha.com"]);

    // Удалили все домены: вместо таблицы — приглашение завести первый.
    act(() => {
      queryClient.setQueryData(domainsKeys.list(), []);
    });
    await screen.findByText("No domains yet");
    expect(screen.queryByRole("table")).toBeNull();

    act(() => {
      queryClient.setQueryData(domainsKeys.list(), DOMAINS);
    });
    await screen.findByRole("table");
    expect(header("Domain").getAttribute("aria-sort")).toBe("descending");
    expect(orderedNames()).toEqual(["gamma.com", "beta.com", "alpha.com"]);
  });
});
