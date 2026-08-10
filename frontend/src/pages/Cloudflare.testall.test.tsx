import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * «Проверить все токены»: кнопка в шапке вкладки. Смысл её в том, что протухший
 * токен иначе обнаруживается только тогда, когда что-то перестало работать, а
 * аккаунтов десятки. Отсюда и то, что здесь проверяется: прогон доходит до
 * КАЖДОГО аккаунта (а не до последнего, как было бы с общей мутацией и её
 * колбэками), идёт по одному, не врёт про область действия при активном фильтре
 * и оставляет после себя сводку, потому что полос итога в карточках при
 * десятках аккаунтов не видно разом.
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

// RevealSecret тянет argon2/libsodium и к проверке токенов отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const ACCOUNT = {
  id: 5,
  name: "Main CF",
  account_id: "cf-acc-1",
  is_active: true,
  api_token_blob_id: null,
  api_token_masked: "abc…xyz",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const SECOND_ACCOUNT = { ...ACCOUNT, id: 7, name: "Second CF", account_id: "cf-acc-2" };
const THIRD_ACCOUNT = { ...ACCOUNT, id: 9, name: "Backup CF", account_id: "cf-acc-3" };
const THREE = [ACCOUNT, SECOND_ACCOUNT, THIRD_ACCOUNT];

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function mockHttp(accounts: any[], domains: any[] = []) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

/**
 * `verify` отвечает за `cf_verify_token` и получает `accountId` строкой — ровно
 * так, как его шлёт `useTestCloudflareAccount`. По умолчанию все токены живые.
 */
function mockInvoke(verify: (accountId: string) => boolean | Promise<boolean> = () => true) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") return [];
    if (cmd === "cf_list_dns_records") return [];
    if (cmd === "cf_verify_token") return verify(args.accountId);
    throw new Error(`unexpected command ${cmd}`);
  });
}

/** Аккаунты, по которым прошёл прогон, в порядке вызовов. */
function verifiedIds(): string[] {
  return mocks.invokeSynced.mock.calls
    .filter(([cmd]) => cmd === "cf_verify_token")
    .map(([, args]) => args.accountId);
}

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Cloudflare />
    </QueryClientProvider>
  );
}

/** Кнопка прогона — по подписи-шаблону: число в ней и есть предмет проверки. */
const testAllBtn = () => screen.getByRole("button", { name: /^Test \d+ tokens?$/ });
const queryTestAllBtn = () => screen.queryByRole("button", { name: /^Test \d+ tokens?$/ });
/** Во время прогона подпись другая — это тот же контрол, но занятый. */
const runningBtn = () => screen.getByRole("button", { name: /^Testing \d+ of \d+/ });

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
  mockHttp(THREE);
  mockInvoke();
});

afterEach(() => {
  // vitest без `globals: true` не регистрирует авто-cleanup RTL.
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("Cloudflare — «проверить все токены»", () => {
  it("проходит по каждому аккаунту и подводит итог", async () => {
    setTauri(true);
    renderPage();
    await screen.findByText("Backup CF");

    fireEvent.click(testAllBtn());

    // Каждый, а не только последний: с общей мутацией и колбэками в `mutate`
    // итог доезжал бы ровно до одной карточки.
    await waitFor(() => expect(verifiedIds()).toEqual(["5", "7", "9"]));
    expect(await screen.findByText("3 tokens verified.")).toBeTruthy();
  });

  it("провалившийся токен виден в сводке поимённо и не обрывает прогон", async () => {
    setTauri(true);
    mockInvoke((accountId) => accountId !== "7");

    renderPage();
    await screen.findByText("Backup CF");

    fireEvent.click(testAllBtn());

    // Имя в сводке — потому что при десятках аккаунтов красную полосу в карточке
    // иначе пришлось бы искать скроллом.
    expect(await screen.findByText("1 of 3 tokens failed: Second CF.")).toBeTruthy();
    // Провал на втором не отменяет третьего: прогон затевают именно ради того,
    // чтобы узнать про ВСЕ протухшие токены разом.
    expect(verifiedIds()).toEqual(["5", "7", "9"]);
    // И сама карточка тоже держит свой итог — сводка её не заменяет.
    expect(screen.getByText("invalid token")).toBeTruthy();
  });

  it("проверяет по одной, а не залпом", async () => {
    setTauri(true);
    let release: (() => void) | null = null;
    mockInvoke(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return true;
    });

    renderPage();
    await screen.findByText("Backup CF");

    fireEvent.click(testAllBtn());

    // Пока первая проверка висит, второй вызов не ушёл: `cf_verify_token` — это
    // поход в Cloudflare с расшифровкой токена, и десяток разом мы не пускаем.
    await waitFor(() => expect(verifiedIds()).toEqual(["5"]));
    expect(runningBtn().textContent).toBe("Testing 1 of 3…");

    release!();
    await waitFor(() => expect(verifiedIds()).toEqual(["5", "7"]));
    expect(runningBtn().textContent).toBe("Testing 2 of 3…");

    release!();
    await waitFor(() => expect(verifiedIds()).toEqual(["5", "7", "9"]));
    release!();
    expect(await screen.findByText("3 tokens verified.")).toBeTruthy();
  });

  it("во время прогона повторный запуск не проходит", async () => {
    setTauri(true);
    let release: (() => void) | null = null;
    mockInvoke(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return true;
    });

    renderPage();
    await screen.findByText("Backup CF");

    fireEvent.click(testAllBtn());
    await waitFor(() => expect(verifiedIds()).toEqual(["5"]));

    fireEvent.click(runningBtn());
    fireEvent.click(runningBtn());

    // Отпускаем по одной: следующая проверка стартует только после предыдущей,
    // и до её старта резолвить нечего.
    release!();
    await waitFor(() => expect(verifiedIds()).toEqual(["5", "7"]));
    release!();
    await waitFor(() => expect(verifiedIds()).toEqual(["5", "7", "9"]));
    release!();
    expect(await screen.findByText("3 tokens verified.")).toBeTruthy();
    // Второй прогон удвоил бы список проверок — и итог по каждому аккаунту
    // приехал бы дважды.
    expect(verifiedIds()).toEqual(["5", "7", "9"]);
  });

  it("идёт по видимым аккаунтам, и подпись говорит по скольким", async () => {
    setTauri(true);
    renderPage();
    await screen.findByText("Backup CF");

    fireEvent.change(screen.getByLabelText("Search Cloudflare accounts"), {
      target: { value: "second" },
    });

    // Кнопка обещает ровно то, что сделает: фильтр стоит на том же экране, и
    // тихий поход по скрытым аккаунтам был бы не тем действием, что на подписи.
    expect(testAllBtn().textContent).toBe("Test 1 token");

    fireEvent.click(testAllBtn());

    await waitFor(() => expect(verifiedIds()).toEqual(["7"]));
    expect(await screen.findByText("1 token verified.")).toBeTruthy();
  });

  it("в вебе кнопки нет вовсе", async () => {
    setTauri(false);
    renderPage();
    await screen.findByText("Backup CF");

    // Токен расшифровывается на клиенте, и браузер проверить его не может в
    // принципе — как и сохранить, поэтому рядом нет и «+ Add Account».
    expect(queryTestAllBtn()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Testing / })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add Account" })).toBeNull();
  });

  it("на единственном аккаунте кнопки нет — это Test connection в его карточке", async () => {
    setTauri(true);
    mockHttp([ACCOUNT]);

    renderPage();
    await screen.findByText("Main CF");

    expect(queryTestAllBtn()).toBeNull();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
  });
});
