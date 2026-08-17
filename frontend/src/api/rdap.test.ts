import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useRegistryNameservers,
  rdapKeys,
  foldRegistryNameservers,
  type RegistryNameservers,
} from "./rdap";

/**
 * RDAP-ответ ходит из десктопа и доезжает до фронта ТРЕМЯ различимыми
 * состояниями. Здесь проверяется именно это: что хук зовёт свою команду с
 * именем домена и что ни одно из трёх состояний не схлопывается по дороге в
 * «пусто» — на чём и держится правило «не рисуй незнание здоровьем».
 */

const mocks = vi.hoisted(() => ({ invokeIfTauri: vi.fn() }));

vi.mock("../lib/tauri-invoke", () => ({ invokeIfTauri: mocks.invokeIfTauri }));

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

describe("api/rdap — делегирование из реестра", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setTauri(false);
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
  });

  it("в вебе объясняет, а не молчит", async () => {
    const { result } = renderHook(() => useRegistryNameservers("betify2.com"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error?.message)).toMatch(/desktop app/i);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("в десктопе спрашивает реестр про имя домена", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockResolvedValue({
      state: "registered",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });

    const { result } = renderHook(() => useRegistryNameservers("betify2.com"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.invokeIfTauri).toHaveBeenCalledWith("domain_registry_nameservers", {
      domain: "betify2.com",
    });
    // Ни `userId`, ни `accountId`: реестру всё равно, чей это домен и есть ли у
    // нас доступ к аккаунту регистратора — в этом весь смысл источника.
    expect(Object.keys(mocks.invokeIfTauri.mock.calls[0][1])).toEqual(["domain"]);
    expect(result.current.data).toEqual({
      state: "registered",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
  });

  /**
   * Три состояния обязаны доезжать до потребителя различимыми. Схлопни их хук в
   * массив или в ошибку — и бейдж делегирования показал бы «NS не прописаны» на
   * домене, про который мы просто не смогли спросить.
   */
  it.each([
    ["зарегистрирован, но не делегирован", { state: "registered", nameservers: [] }],
    ["домена нет в реестре", { state: "not_registered" }],
    ["спросить не удалось", { state: "unavailable", reason: "timeout" }],
  ])("отдаёт состояние «%s» как есть", async (_name, answer) => {
    setTauri(true);
    mocks.invokeIfTauri.mockResolvedValue(answer);

    const { result } = renderHook(() => useRegistryNameservers("betify2.com"), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(answer);
  });

  it("без домена не спрашивает никого", async () => {
    setTauri(true);
    const { result } = renderHook(() => useRegistryNameservers(null), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("ключ кэша — на домен, а не на аккаунт регистратора", () => {
    expect(rdapKeys.nameservers("betify2.com")).toEqual(["rdap", "nameservers", "betify2.com"]);
  });

  /**
   * Хелпер существует затем, чтобы потребитель не смог отмахнуться от двух
   * состояний одним `else`. Проверяется, что каждое из трёх попадает в СВОЮ
   * ветку — в том числе `registered` с пустым списком, который обязан остаться
   * ответом «не делегирован», а не съехать к «не знаем».
   */
  it("развод состояний ведёт каждое в свою ветку", () => {
    const label = (answer: RegistryNameservers) =>
      foldRegistryNameservers(answer, {
        registered: (ns) => `registered:${ns.length}`,
        notRegistered: () => "not-registered",
        unavailable: (reason) => `unavailable:${reason}`,
      });

    expect(label({ state: "registered", nameservers: ["a.ns", "b.ns"] })).toBe("registered:2");
    expect(label({ state: "registered", nameservers: [] })).toBe("registered:0");
    expect(label({ state: "not_registered" })).toBe("not-registered");
    expect(label({ state: "unavailable", reason: "timeout" })).toBe("unavailable:timeout");
  });

  /**
   * Ответ незнакомого состояния не должен молча стать «пусто»: так выглядел бы
   * рассинхрон с Rust (новый вариант енума приехал, фронт не пересобран).
   * Компилятор такое ловит только при пересборке, поэтому в рантайме — бросок.
   */
  it("незнакомое состояние не проходит молча", () => {
    const alien = { state: "no_such_state" } as unknown as RegistryNameservers;
    expect(() =>
      foldRegistryNameservers(alien, {
        registered: () => "x",
        notRegistered: () => "x",
        unavailable: () => "x",
      }),
    ).toThrow(/unhandled registry answer/);
  });
});
