import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { useAuthStore } from "../store/auth";

/**
 * DNS-редактор Cloudflare был написан, но нигде не монтировался: cf_*-команды
 * не имели ни одного вызывающего. Тесты держат границу «десктоп выполняет, веб
 * смотрит» и форму аргументов каждой команды.
 *
 * Всё, что про Cloudflare, идёт через Tauri: бэкенд знает только CRUD
 * аккаунтов (`backend/app/api/routes/cloudflare.py` — четыре роута), а токен
 * расшифровывается на клиенте. `/domains` — единственный HTTP тут: из него веб
 * берёт резервный список зон, потому что `cf_list_zones` ему недоступен.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  /** Только мутации: чтения разводит роутер в `mockInvoke`. */
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

const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
};

/** Зона, созданная в Cloudflare, но ещё не привязанная ни к одному домену. */
const UNLINKED_ZONE = { id: "zone-b", name: "brand-new.com", name_servers: null };

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
  // Домен без зоны — в резервном списке появляться не должен.
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

function mockHttp() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return [ACCOUNT];
    if (url === "/domains") return DOMAINS;
    throw new Error(`unexpected GET ${url}`);
  });
}

/**
 * Роутер `invokeSynced`: чтения отвечают фикстурами, всё остальное уходит в
 * `mocks.mutate`, чтобы тест мог задавать поведение мутации, не ломая чтения.
 */
function mockInvoke(
  reads: { zones?: any[]; zonesError?: Error; records?: any[]; recordsError?: Error } = {}
) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") {
      if (reads.zonesError) throw reads.zonesError;
      return reads.zones ?? [ZONE];
    }
    if (cmd === "cf_list_dns_records") {
      if (reads.recordsError) throw reads.recordsError;
      return reads.records ?? [RECORD];
    }
    return mocks.mutate(cmd, args);
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
async function openZone(zoneName = "example.com") {
  const row = (await screen.findByText(zoneName)).closest("div[data-zone-row]") as HTMLElement;
  fireEvent.click(within(row).getByText("Open DNS"));
  return await screen.findByText("🗑 Purge Cache");
}

function invokeArgs(cmd: string) {
  const call = mocks.invokeSynced.mock.calls.find((c: any[]) => c[0] === cmd);
  return call?.[1] as Record<string, any> | undefined;
}

function lastMutation() {
  const calls = mocks.mutate.mock.calls;
  return calls[calls.length - 1] as [string, Record<string, any>];
}

describe("Cloudflare — DNS-редактор зоны", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
    mockHttp();
    mockInvoke();
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

    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.queryByText("no-cf.com")).toBeNull();

    await openZone();
    expect(screen.getByText("zone-a")).toBeTruthy();
  });

  it("берёт список зон из cf_list_zones, а не из доменов", async () => {
    setTauri(true);
    // Зона, только что созданная в Cloudflare: ни один домен на неё ещё не
    // ссылается. Из доменного списка она бы не появилась.
    mockInvoke({ zones: [ZONE, UNLINKED_ZONE] });

    renderPage();

    expect(await screen.findByText("brand-new.com")).toBeTruthy();
    expect(invokeArgs("cf_list_zones")).toEqual({ userId: "user-1", accountId: "5" });
  });

  it("рисует записи из cf_list_dns_records", async () => {
    setTauri(true);
    mockInvoke({
      records: [RECORD, { ...RECORD, id: "rec-2", type: "MX", name: "mail.example.com", ttl: null }],
    });

    renderPage();
    await openZone();

    expect(await screen.findByText("www.example.com")).toBeTruthy();
    expect(screen.getByText("mail.example.com")).toBeTruthy();
    expect(invokeArgs("cf_list_dns_records")).toEqual({
      userId: "user-1",
      accountId: "5",
      zoneId: "zone-a",
    });
    // Роута под записи на бэкенде нет — ни одного GET мимо /domains и аккаунтов.
    expect(
      mocks.apiGet.mock.calls.some((c: any[]) => String(c[0]).includes("/dns"))
    ).toBe(false);
  });

  it("показывает nameservers из списка зон, без отдельного запроса", async () => {
    setTauri(true);
    renderPage();
    await openZone();

    fireEvent.click(screen.getByText("🔗 Nameservers"));
    expect(await screen.findByText("ada.ns.cloudflare.com")).toBeTruthy();
    // `Zone.name_servers` уже приехал со списком: второй команды быть не должно.
    expect(
      mocks.invokeSynced.mock.calls.some((c: any[]) => String(c[0]).includes("nameserver"))
    ).toBe(false);
  });

  it("создаёт запись через cf_create_dns_record и доносит proxied=false", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue({ ...RECORD, id: "rec-2", proxied: false });

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

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
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
    mocks.mutate.mockResolvedValue({ ...RECORD, id: "rec-3", type: "MX" });

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

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [, args] = lastMutation();
    expect(args.record.type).toBe("MX");
    expect(args.record.priority).toBe(20);
  });

  it("правит запись через cf_update_dns_record и доносит proxied", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue({ ...RECORD, proxied: false });

    const { container } = renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Edit DNS record"));
    const proxied = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(proxied.checked).toBe(true);
    fireEvent.click(proxied);
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
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
    mocks.mutate.mockResolvedValue(undefined);

    renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Delete DNS record"));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
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
    mocks.mutate.mockResolvedValue(undefined);

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
    expect(cmd).toBe("cf_purge_cache");
    expect(args).toEqual({ userId: "user-1", accountId: "5", zoneId: "zone-a" });
  });

  it("создаёт зону через cf_create_zone и показывает её nameservers", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue({
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

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
    expect(cmd).toBe("cf_create_zone");
    expect(args).toEqual({ userId: "user-1", accountId: "5", zoneName: "fresh.com" });
    expect(await screen.findByText(/ada\.ns\.cloudflare\.com/)).toBeTruthy();
  });

  it("проверяет токен через cf_verify_token, а не через несуществующий HTTP-роут", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);

    renderPage();
    fireEvent.click(await screen.findByText("Test connection"));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [cmd, args] = lastMutation();
    expect(cmd).toBe("cf_verify_token");
    expect(args).toEqual({ userId: "user-1", accountId: "5" });
    // Раньше здесь висел OpenInDesktop с action `test-cloudflare` — хостом,
    // которого parseDeepLinkAction не знает.
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("/test"))
    ).toBe(false);
  });

  it("показывает ошибку команды, а не проглатывает её", async () => {
    setTauri(true);
    mocks.mutate.mockRejectedValue(new Error("cloudflare: 9109 invalid token"));

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));

    expect(await screen.findByText(/9109 invalid token/)).toBeTruthy();
  });

  it("не оставляет ошибку прошлого действия поверх удавшегося следующего", async () => {
    setTauri(true);
    mocks.mutate
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

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    // Провалившаяся мутация держит свой error до следующего вызова — показывать
    // надо итог последнего действия, иначе красное висит над успехом.
    await waitFor(() => expect(screen.queryByText(/purge failed/)).toBeNull());
  });

  it("показывает отказ чтения списка записей, а не пустую таблицу", async () => {
    setTauri(true);
    mockInvoke({ recordsError: new Error("cloudflare: 6003 invalid request headers") });

    renderPage();
    await openZone();

    expect(await screen.findByText(/6003 invalid request headers/)).toBeTruthy();
  });

  it("при отказе cf_list_zones показывает ошибку и не теряет зоны из доменов", async () => {
    setTauri(true);
    mockInvoke({ zonesError: new Error("cloudflare: 9109 invalid token") });

    renderPage();

    expect(await screen.findByText(/9109 invalid token/)).toBeTruthy();
    // Резервный список из доменов остаётся: пользователь не заперт.
    expect(await screen.findByText("example.com")).toBeTruthy();
  });

  it("в вебе редактор только для чтения: ни одной sdmp-ссылки и ни одного вызова", async () => {
    setTauri(false);
    const { container } = renderPage();

    // Test connection на вебе не выполняется и deep link не подсовывает.
    const test = (await screen.findByText("Test connection")).closest("button") as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(container.querySelectorAll('a[href^="sdmp://"]').length).toBe(0);

    // Зоны веб всё же видит — из доменов.
    await openZone();
    expect(container.querySelectorAll('a[href^="sdmp://"]').length).toBe(0);
    expect(screen.getAllByText(/desktop app/i).length).toBeGreaterThan(0);

    const purge = screen.getByText("🗑 Purge Cache").closest("button") as HTMLButtonElement;
    expect(purge.disabled).toBe(true);
    const add = screen.getByText("+ Add Record").closest("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(purge);
    fireEvent.click(add);
    // requireDesktop срабатывает раньше invokeSynced — ни чтений, ни мутаций.
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(mocks.apiDelete).not.toHaveBeenCalled();
  });

  it("в вебе объясняет, почему список записей пуст", async () => {
    setTauri(false);
    renderPage();
    await openZone();

    expect(await screen.findByText(/Reading DNS records runs in the SDMP desktop app/)).toBeTruthy();
  });
});
