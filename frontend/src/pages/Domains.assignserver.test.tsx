import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Массовое «Assign Server» из панели выделенных.
 *
 * Проверяется то, из-за чего вопрос здесь вообще появился: смена `server_id`
 * сбрасывает на бэкенде снимок `fp_facts`, а сайт при этом никуда не переезжает
 * — то есть у домена, которому меняют сервер, пропадают прочитанные с прежней
 * машины факты. Панель выделенных — самый дорогой из трёх путей записи
 * (сотни доменов за клик) и до этой правки была единственным молчащим.
 *
 * Отдельно проверяется счёт: спрашивать надо про тех, кого привязка ПЕРЕВЕЗЁТ,
 * а не про весь набор — домен без сервера ничего не теряет, а стоящий на том же
 * сервере не двигается вовсе.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  confirmAction: vi.fn(),
}));

vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Тяжёлые соседи страницы, которых этот сценарий не открывает.
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

function domainRow(id: number, name: string, serverId: number | null = null) {
  return {
    id,
    domain_name: name,
    status: "new",
    registrar_id: null,
    server_id: serverId,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const SERVERS = [
  { id: 5, name: "web-01", ip_address: "1.1.1.1", status: "active" },
  { id: 6, name: "web-02", ip_address: "2.2.2.2", status: "active" },
];

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/**
 * Набор по умолчанию: один домен без сервера, один на ЧУЖОМ сервере (его и
 * перевезёт) и один уже на целевом. Три разных судьбы за один клик — ровно то,
 * о чём вопрос обязан говорить числом, а не общим «привязать 3».
 */
function renderPage(
  rows = [domainRow(1, "a.com", null), domainRow(2, "b.com", 6), domainRow(3, "c.com", 5)],
) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
    if (url === "/servers") return { items: SERVERS, total: SERVERS.length };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  mocks.invokeSynced.mockResolvedValue([]);
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains
        onProvisionResult={vi.fn()}
        onBulkProvisionResult={vi.fn()}
        onBulkProvisionError={vi.fn()}
        onCloudflareBindNotice={vi.fn()}
        onFullSetupNotice={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/** Открыть диалог назначения из панели выделенных. */
async function openAssignDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Assign Server" }));
  // Селект ищем по его собственной пустой опции: имена серверов есть и в
  // фильтрах страницы, и по ним найдётся не тот select.
  return (await screen.findByRole("option", { name: "— Select Server —" })).closest(
    "select",
  ) as HTMLSelectElement;
}

/** Выбрать сервер в открытом диалоге и нажать «Assign». */
async function assignTo(serverId: number) {
  const sel = await openAssignDialog();
  fireEvent.change(sel, { target: { value: String(serverId) } });
  fireEvent.click(screen.getByRole("button", { name: "Assign" }));
}

/** Текст вопроса, заданного `confirmAction`. */
function askedText(): string {
  expect(mocks.confirmAction).toHaveBeenCalledTimes(1);
  return mocks.confirmAction.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  setTauri(true);
  mocks.apiPost.mockResolvedValue({ updated: 3 });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — массовое назначение сервера", () => {
  it("спрашивает до записи и на отказ не отправляет ничего", async () => {
    mocks.confirmAction.mockResolvedValue(false);
    const { container } = renderPage();
    await screen.findByText("a.com");
    fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);

    await assignTo(5);

    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalledTimes(1));
    // Отказ обязан быть настоящим отказом: до этой правки клик уезжал в
    // мутацию сразу, и «передумал» не существовало как состояния.
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("называет переезд и считает только тех, кого перевезёт", async () => {
    mocks.confirmAction.mockResolvedValue(true);
    const { container } = renderPage();
    await screen.findByText("a.com");
    fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);

    await assignTo(5);

    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalled());
    const text = askedText();
    // Привязка уедет по всем трём, и вопрос называет три.
    expect(text).toContain("Привязать 3 домена к web-01?");
    // А переезжает один — тот, что стоит на web-02. Домен без сервера ничего не
    // теряет, домен уже на web-01 не двигается: посчитай их движением, и цена
    // операции в вопросе оказалась бы втрое больше настоящей.
    expect(text).toContain("У 1 из них сейчас стоит другой сервер");
    expect(text).toContain("FTP-доступ");

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith("/domains/bulk-assign-server", {
        domain_ids: [1, 2, 3],
        server_id: 5,
      }),
    );
  });

  it("молчит про переезд, когда никто не переезжает, и склоняет счётчик", async () => {
    mocks.confirmAction.mockResolvedValue(true);
    const { container } = renderPage([domainRow(1, "a.com", null)]);
    await screen.findByText("a.com");
    fireEvent.click(container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement);

    // Подпись самого диалога склоняется тем же правилом: «для 1 доменов» тут и
    // стояло.
    await openAssignDialog();
    expect(screen.getByText("Назначить сервер для 1 домен:")).toBeTruthy();

    await assignTo(5);

    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalled());
    const text = askedText();
    // «1 доменов» — опечатка, живущая вечно; ради неё `domainWord` и вынесен
    // в `lib/format`.
    expect(text).toBe("Привязать 1 домен к web-01?");
  });
});
