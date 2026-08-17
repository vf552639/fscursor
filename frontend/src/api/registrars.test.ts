import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useTestRegistrarConnection } from "./registrars";
import { useAuthStore } from "../store/auth";

/**
 * `POST /registrars/accounts/{id}/test` на бэкенде не существует: в
 * `routes/registrars.py` только CRUD аккаунтов, а ключ регистратора
 * расшифровывается на клиенте. Резервный HTTP-путь у этого хука был мёртвым — он
 * молча уходил в 404 и выглядел как «регистратор не отвечает». Веб обязан
 * говорить правду: это делает десктоп.
 *
 * Хука чтения NS здесь больше нет вовсе (и команды за ним тоже): «как есть»
 * спрашивают у реестра, см. `api/rdap.test.ts`.
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

  it("в десктопе зовёт свою Tauri-команду, а не HTTP", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue([true, "OK"]);

    const test = renderHook(() => useTestRegistrarConnection(), { wrapper: wrapper() });
    await expect(test.result.current.mutateAsync(3)).resolves.toEqual({
      success: true,
      message: "OK",
    });

    // Аккаунт целиком, без имени домена: поимённых вопросов к API регистратора у
    // фронта больше нет — их задают реестру.
    expect(mocks.invokeSynced.mock.calls).toEqual([
      ["registrar_test_connection", { userId: "user-1", accountId: "3" }],
    ]);
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
