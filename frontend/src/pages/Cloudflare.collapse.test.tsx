import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Шапка карточки аккаунта: счётчик доменов и сворачивание. Оба про одно —
 * страница с десятками аккаунтов, у каждого из которых всегда раскрыт полный
 * список зон, читается только скроллом.
 *
 * Счётчик доменов и «Zones (N)» — РАЗНЫЕ показатели: домены живут в нашей БД,
 * зоны отдаёт сам Cloudflare. Тесты держат их порознь.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  /** Только мутации: чтения разводит роутер в `mockInvoke`. */
  mutate: vi.fn(),
  confirmAction: vi.fn(),
}));

// Вопрос «удалять?» задаёт нативный диалог Tauri, которого в jsdom нет.
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

// RevealSecret тянет argon2/libsodium и к шапке карточки отношения не имеет.
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

const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  status: "active",
};

function domain(over: Record<string, unknown>) {
  return {
    id: 1,
    domain_name: "example.com",
    status: "active",
    registrar_id: null,
    server_id: null,
    cloudflare_account_id: 5,
    cloudflare_zone_id: "zone-a",
    cloudflare_enabled: true,
    expiry_date: null,
    purchase_date: null,
    ns_status: null,
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function mockHttp(accounts: any[], domains: any[]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

/** Чтения отвечают фикстурой, всё прочее уходит в `mocks.mutate`. */
function mockInvoke(zones: any[] = [ZONE]) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") return zones;
    if (cmd === "cf_list_dns_records") return [];
    return mocks.mutate(cmd, args);
  });
}

/**
 * Рендерим на ТОМ ЖЕ `queryClient`, что и приложение (`main.tsx`): инвалидация
 * хуков идёт по этому синглтону, с локальным клиентом она уходила бы мимо.
 */
function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Cloudflare />
    </QueryClientProvider>
  );
}

/**
 * Левый блок шапки карточки: шеврон, имя и бейджи лежат в одном flex-ряду.
 * Скоуп нужен, чтобы при двух аккаунтах счётчик привязывался к своей карточке,
 * а не просто «где-то на странице есть такой текст».
 */
function headerOf(accName: string): HTMLElement {
  return screen.getByText(accName).parentElement!.parentElement as HTMLElement;
}

function chevronOf(accName: string) {
  return screen.getByLabelText(`Свернуть/развернуть аккаунт ${accName}`);
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
  mockHttp([ACCOUNT], [domain({})]);
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

describe("Cloudflare — счётчик доменов в шапке аккаунта", () => {
  it("считает домены своего аккаунта и не считает чужие", async () => {
    setTauri(true);
    mockHttp(
      [ACCOUNT, SECOND_ACCOUNT],
      [
        domain({ id: 1, domain_name: "example.com" }),
        domain({ id: 2, domain_name: "second.example.com" }),
        // Чужой аккаунт и домен вообще без Cloudflare — в счёт первого не идут.
        domain({ id: 3, domain_name: "other.com", cloudflare_account_id: 7, cloudflare_zone_id: "zone-b" }),
        domain({ id: 4, domain_name: "no-cf.com", cloudflare_account_id: null, cloudflare_zone_id: null }),
      ]
    );

    renderPage();

    await screen.findByText("Main CF");
    expect(within(headerOf("Main CF")).getByText("2 domains")).toBeTruthy();
    expect(within(headerOf("Second CF")).getByText("1 domains")).toBeTruthy();
  });

  it("не смешивает счётчик доменов с числом живых зон", async () => {
    setTauri(true);
    // Домен один, а зон у аккаунта в Cloudflare три: показатели независимы.
    mockInvoke([ZONE, { ...ZONE, id: "zone-b", name: "b.com" }, { ...ZONE, id: "zone-c", name: "c.com" }]);

    renderPage();

    await screen.findByText("Main CF");
    expect(within(headerOf("Main CF")).getByText("1 domains")).toBeTruthy();
    expect(await screen.findByText("Zones (3)")).toBeTruthy();
  });
});

describe("Cloudflare — сворачивание карточки аккаунта", () => {
  it("по умолчанию карточка развёрнута", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(1));
    expect(screen.getByText(/^Token:/)).toBeTruthy();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("true");
  });

  it("шеврон прячет зоны и строку токена, повторный клик возвращает", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(1));

    fireEvent.click(chevronOf("Main CF"));

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(screen.queryByText(/^Token:/)).toBeNull();
    expect(screen.queryByText(/^Zones \(/)).toBeNull();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("false");
    // Шапка остаётся видимой всегда — иначе свёрнутую карточку нечем опознать.
    expect(screen.getByText("Main CF")).toBeTruthy();
    expect(within(headerOf("Main CF")).getByText("1 domains")).toBeTruthy();

    fireEvent.click(chevronOf("Main CF"));

    expect(screen.getAllByTestId("zone-row").length).toBe(1);
    expect(screen.getByText(/^Token:/)).toBeTruthy();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("true");
  });

  it("клик по имени аккаунта переключает так же, как по шеврону", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(1));

    fireEvent.click(screen.getByText("Main CF"));

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("false");
  });

  it("шеврон переключается с клавиатуры — Enter и пробелом", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(1));

    fireEvent.keyDown(chevronOf("Main CF"), { key: "Enter" });
    expect(screen.queryAllByTestId("zone-row").length).toBe(0);

    fireEvent.keyDown(chevronOf("Main CF"), { key: " " });
    expect(screen.getAllByTestId("zone-row").length).toBe(1);
  });

  it("сворачивает только свою карточку, соседнюю не трогает", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT], [domain({})]);

    renderPage();

    await screen.findByText("Second CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(2));

    fireEvent.click(chevronOf("Main CF"));

    expect(screen.getAllByTestId("zone-row").length).toBe(1);
    expect(chevronOf("Second CF").getAttribute("aria-expanded")).toBe("true");
  });

  it("кнопки Test/Edit/✕ не сворачивают карточку", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);
    // Удаление отклоняем: тест про сворачивание, а не про исчезновение карточки.
    mocks.confirmAction.mockResolvedValue(false);

    renderPage();
    await screen.findByText("Main CF");
    await waitFor(() => expect(screen.getAllByTestId("zone-row").length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("zone-row").length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "✎ Edit" }));
    expect(screen.getAllByTestId("zone-row").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("zone-row").length).toBe(1);
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("true");
  });
});
