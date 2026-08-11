import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Карточка домена получает строку пропсом, а не запросом. Пока это был снимок,
 * взятый в момент клика, поверхность, которая ВЫПОЛНЯЕТ смену NS, была
 * единственной, которая её не показывала: «NS status: pending» держался до
 * закрытия и повторного открытия карточки — ровно та ложь, ради устранения
 * которой заведён write-back `ns_status`.
 *
 * Инвалидация `domainsKeys.detail` этого не чинила: у `useDomain` нет ни одного
 * вызывающего, так что сбрасывать по этому ключу нечего.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  mutate: vi.fn(),
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
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

// Тяжёлые соседи страницы, которые в этом сценарии не рендерятся вовсе (они за
// выключенными флагами). Тянуть их дерево ради вкладки NS незачем: этот файл и
// так единственный, который поднимает страницу целиком, и лишний импорт тут
// замедляет весь прогон.
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  status: "pending",
};

function domainRow(nsStatus: string) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: 9,
    server_id: null,
    cloudflare_account_id: 7,
    cloudflare_zone_id: "zone-a",
    cloudflare_enabled: true,
    expiry_date: null,
    purchase_date: null,
    ns_status: nsStatus,
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} onBulkProvisionError={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
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
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("карточка домена после смены NS", () => {
  it("показывает свежий ns_status, не дожидаясь закрытия карточки", async () => {
    setTauri(true);
    // Сервер начинает с `pending`, а после write-back'а команды отдаёт `ok`.
    let nsStatus = "pending";
    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === "/domains") return [domainRow(nsStatus)];
      if (url === "/servers") return { items: [], total: 0 };
      if (url === "/registrars/accounts") {
        return [{ id: 9, provider: "namecheap", name: "NC", api_user: null, is_active: true, created_at: "", updated_at: "" }];
      }
      if (url === "/cloudflare/accounts") return [{ id: 7, name: "CF", account_id: null, is_active: true, created_at: "", updated_at: "" }];
      // Карточка тянет ещё креды БД и nginx-override — до них дела нет.
      return {};
    });
    mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "cf_list_zones") return [ZONE];
      if (cmd === "registrar_set_nameservers") {
        // Write-back внутри команды — то, из-за чего сервер начинает отвечать
        // `ok`. Здесь он ровно этим и моделируется.
        nsStatus = "ok";
        return true;
      }
      return mocks.mutate(cmd, args);
    });

    renderPage();

    fireEvent.click(await screen.findByText("example.com"));
    fireEvent.click(await screen.findByText("NS"));
    expect(await screen.findByText("pending")).toBeTruthy();

    const btn = (await screen.findByText(/Set NS/)).closest("button") as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);

    // Пропс карточки берётся из живого списка, а список инвалидируется в
    // `onSettled`, — поэтому статус доезжает без переоткрытия.
    expect(await screen.findByText("ok")).toBeTruthy();
    expect(screen.queryByText("pending")).toBeNull();
  });
});
