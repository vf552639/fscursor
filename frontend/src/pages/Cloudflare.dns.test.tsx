import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { useAuthStore } from "../store/auth";

/**
 * DNS-редактор Cloudflare был написан, но нигде не монтировался: пять cf_*
 * команд не имели ни одного вызывающего. Тесты держат границу «десктоп
 * выполняет, веб смотрит» и форму аргументов каждой команды.
 *
 * ВАЖНО про `apiGet`: бэкенд НЕ отдаёт ни зон, ни DNS-записей (в
 * `backend/app/api/routes/cloudflare.py` есть только четыре роута про аккаунты).
 * Список зон страница поэтому строит из `/domains` — это настоящие серверные
 * метаданные. А список DNS-записей читать неоткуда: `useDnsRecords` бьётся в
 * несуществующий роут. Здесь он замокан, чтобы проверить редактирование
 * записей; отдельный тест проверяет, что реальный отказ чтения виден в UI.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
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

// RevealSecret тянет argon2/libsodium и к DNS отношения не имеет.
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

const DOMAINS = [
  {
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
  },
  // Домен без зоны — в списке зон появляться не должен.
  {
    id: 2,
    domain_name: "no-cf.com",
    status: "new",
    registrar_id: null,
    server_id: null,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: null,
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const RECORD = {
  id: "rec-1",
  type: "A",
  name: "www.example.com",
  content: "1.2.3.4",
  ttl: 1,
  proxied: true,
  zone_id: "zone-a",
};

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function mockReads(opts: { dnsFails?: boolean } = {}) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return [ACCOUNT];
    if (url === "/domains") return DOMAINS;
    if (url === "/cloudflare/accounts/5/zones/zone-a/dns") {
      if (opts.dnsFails) throw new Error("Request failed with status code 404");
      return [RECORD];
    }
    if (url === "/cloudflare/accounts/5/zones/zone-a/nameservers") {
      return { zone_id: "zone-a", name_servers: ["ns1.cf.com", "ns2.cf.com"] };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Cloudflare />
      </QueryClientProvider>
    ),
  };
}

/** Дойти со страницы аккаунтов до DNS-редактора зоны example.com. */
async function openZone() {
  const row = (await screen.findByText("example.com")).closest("div[data-zone-row]") as HTMLElement;
  fireEvent.click(within(row).getByText("Open DNS"));
  return await screen.findByText("🗑 Purge Cache");
}

function lastInvoke() {
  const calls = mocks.invokeSynced.mock.calls;
  return calls[calls.length - 1] as [string, Record<string, any>];
}

describe("Cloudflare — DNS-редактор зоны", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
    mockReads();
  });

  afterEach(() => {
    // vitest без `globals: true` не регистрирует авто-cleanup RTL.
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
    vi.unstubAllGlobals();
  });

  it("даёт дойти от списка аккаунтов до DNS-редактора зоны", async () => {
    setTauri(true);
    renderPage();

    // Зоны берутся из доменов: домен без cloudflare_zone_id в списке не нужен.
    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.queryByText("no-cf.com")).toBeNull();

    await openZone();
    expect(screen.getByText("zone-a")).toBeTruthy();
    expect(await screen.findByText("www.example.com")).toBeTruthy();
  });

  it("создаёт запись через cf_create_dns_record и доносит proxied=false", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ ...RECORD, id: "rec-2", proxied: false });

    const { container } = renderPage();
    await openZone();
    fireEvent.click(screen.getByText("+ Add Record"));

    fireEvent.change(screen.getByPlaceholderText("@ or subdomain"), {
      target: { value: "www" },
    });
    fireEvent.change(screen.getByPlaceholderText("IP address or value"), {
      target: { value: "1.2.3.4" },
    });
    const proxied = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(proxied.checked).toBe(true);
    fireEvent.click(proxied);

    fireEvent.click(screen.getByText("Add Record"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastInvoke();
    expect(cmd).toBe("cf_create_dns_record");
    expect(args.userId).toBe("user-1");
    expect(args.accountId).toBe("5");
    expect(args.zoneId).toBe("zone-a");
    expect(args.record.type).toBe("A");
    expect(args.record.name).toBe("www");
    expect(args.record.content).toBe("1.2.3.4");
    expect(args.record.ttl).toBe(1);
    // Спринт 1: галка «Proxied» молча терялась по дороге до команды.
    expect(args.record.proxied).toBe(false);
    // Для A-записи приоритет Cloudflare не принимает — не шлём.
    expect(args.record.priority).toBeUndefined();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("шлёт priority для MX и прячет поле для остальных типов", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ ...RECORD, id: "rec-3", type: "MX" });

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("+ Add Record"));

    // Для A поля приоритета нет.
    expect(screen.queryByPlaceholderText("10")).toBeNull();

    const typeSel = screen.getAllByRole("combobox")[0];
    fireEvent.change(typeSel, { target: { value: "MX" } });

    fireEvent.change(screen.getByPlaceholderText("@ or subdomain"), { target: { value: "@" } });
    fireEvent.change(screen.getByPlaceholderText("IP address or value"), {
      target: { value: "mx.example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("10"), { target: { value: "20" } });

    fireEvent.click(screen.getByText("Add Record"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [, args] = lastInvoke();
    expect(args.record.type).toBe("MX");
    expect(args.record.priority).toBe(20);
  });

  it("правит запись через cf_update_dns_record и доносит proxied", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ ...RECORD, proxied: false });

    const { container } = renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Edit DNS record"));
    const proxied = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(proxied.checked).toBe(true);
    fireEvent.click(proxied);
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastInvoke();
    expect(cmd).toBe("cf_update_dns_record");
    expect(args.recordId).toBe("rec-1");
    expect(args.zoneId).toBe("zone-a");
    expect(args.patch.proxied).toBe(false);
    expect(args.patch.type).toBe("A");
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("удаляет запись через cf_delete_dns_record", async () => {
    setTauri(true);
    vi.stubGlobal("confirm", vi.fn(() => true));
    mocks.invokeSynced.mockResolvedValue(undefined);

    renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Delete DNS record"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastInvoke();
    expect(cmd).toBe("cf_delete_dns_record");
    expect(args).toEqual({
      userId: "user-1",
      accountId: "5",
      zoneId: "zone-a",
      recordId: "rec-1",
    });
    expect(mocks.apiDelete).not.toHaveBeenCalled();
  });

  it("сбрасывает кэш через cf_purge_cache", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(undefined);

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastInvoke();
    expect(cmd).toBe("cf_purge_cache");
    expect(args).toEqual({ userId: "user-1", accountId: "5", zoneId: "zone-a" });
  });

  it("создаёт зону через cf_create_zone и показывает её nameservers", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      id: "zone-new",
      name: "fresh.com",
      name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });

    renderPage();
    fireEvent.click(await screen.findByText("+ Add Zone"));
    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "fresh.com" },
    });
    fireEvent.click(screen.getByText("Create Zone"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastInvoke();
    expect(cmd).toBe("cf_create_zone");
    expect(args).toEqual({ userId: "user-1", accountId: "5", zoneName: "fresh.com" });
    expect(await screen.findByText(/ada\.ns\.cloudflare\.com/)).toBeTruthy();
  });

  it("показывает ошибку команды, а не проглатывает её", async () => {
    setTauri(true);
    mocks.invokeSynced.mockRejectedValue(new Error("cloudflare: 9109 invalid token"));

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));

    expect(await screen.findByText(/9109 invalid token/)).toBeTruthy();
  });

  it("не оставляет ошибку прошлого действия поверх удавшегося следующего", async () => {
    setTauri(true);
    mocks.invokeSynced
      .mockRejectedValueOnce(new Error("cloudflare: purge failed"))
      .mockResolvedValueOnce({ ...RECORD, id: "rec-9" });

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));
    expect(await screen.findByText(/purge failed/)).toBeTruthy();

    fireEvent.click(screen.getByText("+ Add Record"));
    fireEvent.change(screen.getByPlaceholderText("@ or subdomain"), { target: { value: "a" } });
    fireEvent.change(screen.getByPlaceholderText("IP address or value"), {
      target: { value: "1.1.1.1" },
    });
    fireEvent.click(screen.getByText("Add Record"));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(2));
    // Провалившаяся мутация держит свой error до следующего вызова — показывать
    // надо итог последнего действия, иначе красное висит над успехом.
    await waitFor(() => expect(screen.queryByText(/purge failed/)).toBeNull());
  });

  it("показывает отказ чтения списка записей, а не пустую таблицу", async () => {
    setTauri(true);
    mockReads({ dnsFails: true });

    renderPage();
    await openZone();

    expect(await screen.findByText(/status code 404/)).toBeTruthy();
  });

  it("в вебе редактор только для чтения: ни одной sdmp-ссылки и ни одного вызова", async () => {
    setTauri(false);
    const { container } = renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    // Deep link для DNS не выдумываем: parseDeepLinkAction знает три хоста,
    // и sdmp://-ссылка с полем записи в query вела бы в никуда.
    expect(container.querySelectorAll('a[href^="sdmp://"]').length).toBe(0);
    expect(screen.getByText(/desktop app/i)).toBeTruthy();

    const purge = screen.getByText("🗑 Purge Cache").closest("button") as HTMLButtonElement;
    expect(purge.disabled).toBe(true);
    const add = screen.getByText("+ Add Record").closest("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect((screen.getByTitle("Edit DNS record") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("Delete DNS record") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(purge);
    fireEvent.click(add);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(mocks.apiDelete).not.toHaveBeenCalled();
  });
});
