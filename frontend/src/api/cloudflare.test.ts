import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useCloudflareZones, useZoneDetails, useZoneNameservers } from "./cloudflare";
import { useAuthStore } from "../store/auth";

/**
 * `useCloudflareZones`, `useZoneDetails` и `useZoneNameservers` — это три
 * `select` над ОДНОЙ записью кэша `cf_list_zones`. Абстракция дешёвая, но
 * неочевидная: сломать её можно, разведя queryKey, и никакой тест страницы
 * этого не заметит — счёт вызовов команды виден только здесь.
 */

const mocks = vi.hoisted(() => ({ invokeSynced: vi.fn() }));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const ZONES = [
  { id: "zone-a", name: "example.com", name_servers: ["ada.ns", "bob.ns"], status: "active" },
  { id: "zone-b", name: "second.com", name_servers: null, status: "pending" },
];

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function wrapperWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe("api/cloudflare — зоны на одном запросе", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTauri(true);
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
    mocks.invokeSynced.mockResolvedValue(ZONES);
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
  });

  it("три хука на одну зону дают ровно один cf_list_zones", async () => {
    const { wrapper } = wrapperWithClient();
    const { result } = renderHook(
      () => ({
        list: useCloudflareZones(5),
        zone: useZoneDetails(5, "zone-a"),
        ns: useZoneNameservers(5, "zone-a"),
      }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.zone.data).toBeTruthy());
    expect(result.current.list.data).toHaveLength(2);

    const listCalls = mocks.invokeSynced.mock.calls.filter((c: any[]) => c[0] === "cf_list_zones");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0][1]).toEqual({ userId: "user-1", accountId: "5" });
  });

  it("select выбирает нужную зону, а не первую попавшуюся", async () => {
    const { wrapper } = wrapperWithClient();
    const { result } = renderHook(
      () => ({
        first: useZoneDetails(5, "zone-a"),
        second: useZoneDetails(5, "zone-b"),
        ns: useZoneNameservers(5, "zone-b"),
      }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.second.data).toBeTruthy());
    expect(result.current.first.data?.name).toBe("example.com");
    expect(result.current.second.data?.name).toBe("second.com");
    expect(result.current.second.data?.status).toBe("pending");
    // `name_servers: null` — это зона без NS, а не отсутствующая зона.
    expect(result.current.ns.data).toEqual({ zone_id: "zone-b", name_servers: [] });
  });

  it("для чужого zone_id отдаёт null, а не выдуманный пустой ответ", async () => {
    const { wrapper } = wrapperWithClient();
    const { result } = renderHook(
      () => ({
        zone: useZoneDetails(5, "zone-of-another-account"),
        ns: useZoneNameservers(5, "zone-of-another-account"),
      }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.zone.isSuccess).toBe(true));
    expect(result.current.zone.data).toBeNull();
    // Пустой массив тут читался бы как «у зоны нет NS» — ответ не на тот вопрос.
    expect(result.current.ns.data).toBeNull();
  });

  it("вне десктопа список зон не запрашивается вовсе", async () => {
    setTauri(false);
    const { wrapper } = wrapperWithClient();
    const { result } = renderHook(() => useCloudflareZones(5), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(result.current.isPending).toBe(true);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });
});
