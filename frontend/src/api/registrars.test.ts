import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useRegistrarDomains, useTestRegistrarConnection } from "./registrars";
import { useAuthStore } from "../store/auth";

/**
 * `POST /registrars/accounts/{id}/test` и `GET /registrars/accounts/{id}/domains`
 * на бэкенде не существуют: в `routes/registrars.py` только CRUD аккаунтов, а
 * ключ регистратора расшифровывается на клиенте. Резервный HTTP-путь у этих двух
 * хуков был мёртвым — он молча уходил в 404 и выглядел как «регистратор не
 * отвечает». Веб обязан говорить правду: это делает десктоп.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe("api/registrars — веб не ходит по несуществующим роутам", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setTauri(false);
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
  });

  it("проверка подключения объясняет, а не уходит в 404", async () => {
    const { result } = renderHook(() => useTestRegistrarConnection(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(3)).rejects.toThrow(/desktop app/i);
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("список доменов регистратора объясняет, а не уходит в 404", async () => {
    const { result } = renderHook(() => useRegistrarDomains(3), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error?.message)).toMatch(/desktop app/i);
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("в десктопе оба хука зовут свои Tauri-команды", async () => {
    setTauri(true);
    mocks.invokeSynced.mockImplementation(async (cmd: string) =>
      cmd === "registrar_test_connection" ? [true, "OK"] : []
    );

    const test = renderHook(() => useTestRegistrarConnection(), { wrapper: wrapper() });
    await expect(test.result.current.mutateAsync(3)).resolves.toEqual({
      success: true,
      message: "OK",
    });

    const list = renderHook(() => useRegistrarDomains(3), { wrapper: wrapper() });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    expect(mocks.invokeSynced.mock.calls.map((c: any[]) => c[0]).sort()).toEqual([
      "registrar_get_domains",
      "registrar_test_connection",
    ]);
    for (const [, args] of mocks.invokeSynced.mock.calls as any[]) {
      expect(args).toEqual({ userId: "user-1", accountId: "3" });
    }
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
