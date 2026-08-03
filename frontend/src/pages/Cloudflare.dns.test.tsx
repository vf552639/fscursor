import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { queryClient } from "../api/queryClient";
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
  status: "active",
};

/** Зона, созданная в Cloudflare, но ещё не привязанная ни к одному домену. */
const UNLINKED_ZONE = {
  id: "zone-b",
  name: "brand-new.com",
  name_servers: null,
  status: "pending",
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

const DOMAINS = [
  domain({}),
  // Домен без зоны — в резервном списке появляться не должен.
  domain({ id: 2, domain_name: "no-cf.com", cloudflare_account_id: null, cloudflare_zone_id: null }),
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

function mockHttp(domains = DOMAINS) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return [ACCOUNT];
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

/**
 * Роутер `invokeSynced`: чтения отвечают фикстурами, всё остальное уходит в
 * `mocks.mutate`, чтобы тест мог задавать поведение мутации, не ломая чтения.
 * `zones` можно передать функцией — тогда тест видит эффект инвалидации.
 */
function mockInvoke(
  reads: {
    zones?: any[] | (() => any[]);
    zonesError?: Error;
    records?: any[];
    recordsError?: Error;
  } = {}
) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") {
      if (reads.zonesError) throw reads.zonesError;
      const z = reads.zones ?? [ZONE];
      return typeof z === "function" ? z() : z;
    }
    if (cmd === "cf_list_dns_records") {
      if (reads.recordsError) throw reads.recordsError;
      return reads.records ?? [RECORD];
    }
    return mocks.mutate(cmd, args);
  });
}

/**
 * Рендерим на ТОМ ЖЕ `queryClient`, что и приложение (`main.tsx`), а не на
 * свежем: `onSuccess` хуков зовёт `invalidateQueries` именно на этом синглтоне.
 * С локальным клиентом любая проверка «после мутации список обновился» проходила
 * бы вхолостую — инвалидация уходила бы в другой кэш.
 */
function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Cloudflare />
    </QueryClientProvider>
  );
}

/** Дойти со страницы аккаунтов до DNS-редактора зоны. */
async function openZone(zoneName = "example.com") {
  await screen.findByText(zoneName);
  const row = screen
    .getAllByTestId("zone-row")
    .find((r) => within(r).queryByText(zoneName)) as HTMLElement;
  fireEvent.click(within(row).getByText("Open DNS"));
  return await screen.findByText("🗑 Purge Cache");
}

function invokeArgs(cmd: string) {
  const call = mocks.invokeSynced.mock.calls.find((c: any[]) => c[0] === cmd);
  return call?.[1] as Record<string, any> | undefined;
}

function invokeCount(cmd: string) {
  return mocks.invokeSynced.mock.calls.filter((c: any[]) => c[0] === cmd).length;
}

function lastMutation() {
  const calls = mocks.mutate.mock.calls;
  return calls[calls.length - 1] as [string, Record<string, any>];
}

beforeEach(() => {
  // Именно reset, а не clear: `clearAllMocks` — это mockClear, он стирает
  // историю вызовов, но ОСТАВЛЯЕТ реализацию. Из-за этого «зависший»
  // `mockReturnValue(new Promise(() => {}))` из теста про удаление доживал до
  // следующих тестов и подвесил бы первый же, который не задаёт свою.
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  // Клиент общий на весь файл — вычищаем, чтобы тесты не подглядывали друг
  // другу в кэш. Ретраи глушим поверх продовых дефолтов, а не вместо них:
  // `setDefaultOptions` заменяет объект целиком, и без спреда из-под теста
  // молча уехал бы `staleTime`.
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mockHttp();
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

describe("Cloudflare — достижимость и чтения", () => {
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

  it("рисует записи из cf_list_dns_records и не врёт про TTL", async () => {
    setTauri(true);
    mockInvoke({
      records: [
        RECORD,
        { ...RECORD, id: "rec-2", type: "MX", name: "mail.example.com", ttl: null },
        { ...RECORD, id: "rec-3", type: "A", name: "api.example.com", ttl: 900 },
      ],
    });

    renderPage();
    await openZone();

    expect(await screen.findByText("www.example.com")).toBeTruthy();
    expect(invokeArgs("cf_list_dns_records")).toEqual({
      userId: "user-1",
      accountId: "5",
      zoneId: "zone-a",
    });

    // TTL: 1 — «Auto», отсутствующий — «—», прочий — секунды. Без этих проверок
    // регресс до `${r.ttl}s` рисовал бы «nulls», и тест бы не заметил.
    const ttlOf = (name: string) => {
      const row = screen.getByText(name).closest("tr") as HTMLElement;
      return row.querySelectorAll("td")[3].textContent;
    };
    expect(ttlOf("www.example.com")).toBe("Auto");
    expect(ttlOf("mail.example.com")).toBe("—");
    expect(ttlOf("api.example.com")).toBe("900s");

    // Роута под записи на бэкенде нет — ни одного GET мимо /domains и аккаунтов.
    expect(mocks.apiGet.mock.calls.some((c: any[]) => String(c[0]).includes("/dns"))).toBe(false);
  });

  it("показывает nameservers из списка зон, без второго запроса", async () => {
    setTauri(true);
    renderPage();
    await openZone();
    expect(invokeCount("cf_list_zones")).toBe(1);

    fireEvent.click(screen.getByText("🔗 Nameservers"));
    expect(await screen.findByText("ada.ns.cloudflare.com")).toBeTruthy();
    // `Zone.name_servers` уже приехал со списком: за NS второй раз не ходим.
    expect(invokeCount("cf_list_zones")).toBe(1);
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

  it("именует зону апексом, а не первым попавшимся поддоменом", async () => {
    setTauri(false);
    // Порядок нарочно «плохой»: поддомен идёт первым.
    mockHttp([
      domain({ id: 3, domain_name: "blog.example.com" }),
      domain({ id: 1, domain_name: "example.com" }),
    ]);

    renderPage();

    expect(await screen.findByText("example.com")).toBeTruthy();
    expect(screen.queryByText("blog.example.com")).toBeNull();
  });
});

describe("Cloudflare — мутации в десктопе", () => {
  it("создаёт запись через cf_create_dns_record и доносит proxied=false", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue({ ...RECORD, id: "rec-2", proxied: false });

    const { container } = renderPage();
    await openZone();
    fireEvent.click(screen.getByText("+ Add Record"));

    fireEvent.change(screen.getByPlaceholderText("@ or subdomain"), { target: { value: "www" } });
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

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "MX" } });

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
    // Пресетный TTL обязан доехать как есть: ветка `ttlOptionsFor` без «— (not
    // set)» и без своей опции — единственная, на которую не было проверки.
    expect(args.patch.ttl).toBe(1);
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("не переписывает отсутствующий TTL в Auto при простом сохранении", async () => {
    setTauri(true);
    mockInvoke({ records: [{ ...RECORD, ttl: null }] });
    mocks.mutate.mockResolvedValue({ ...RECORD, ttl: null });

    renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Edit DNS record"));
    // Ничего не трогаем — только сохраняем.
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const [, args] = lastMutation();
    // `String(record.ttl || 1)` превращал «нет TTL» в Auto у всех, кто просто
    // открыл запись и нажал Save.
    expect(args.patch.ttl).toBeUndefined();
  });

  it("показывает нестандартный TTL, а не пустой селект", async () => {
    setTauri(true);
    mockInvoke({ records: [{ ...RECORD, ttl: 900 }] });

    renderPage();
    await openZone();
    await screen.findByText("www.example.com");

    fireEvent.click(screen.getByTitle("Edit DNS record"));
    const ttlSel = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    expect(ttlSel.value).toBe("900");
    expect(within(ttlSel).getByText("900s")).toBeTruthy();
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

  it("во время удаления гасит крестик только у своей строки", async () => {
    setTauri(true);
    vi.stubGlobal("confirm", vi.fn(() => true));
    mockInvoke({ records: [RECORD, { ...RECORD, id: "rec-2", name: "api.example.com" }] });
    // Удаление «зависает»: мутация остаётся pending.
    mocks.mutate.mockReturnValue(new Promise(() => {}));

    renderPage();
    await openZone();
    await screen.findByText("api.example.com");

    const deletes = screen.getAllByTitle("Delete DNS record") as HTMLButtonElement[];
    fireEvent.click(deletes[0]);

    await waitFor(() => expect(deletes[0].disabled).toBe(true));
    // Мутация одна на всю таблицу: без сверки с `variables` погасли бы все.
    expect(deletes[1].disabled).toBe(false);
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

  it("создаёт зону через cf_create_zone и сразу показывает её в списке", async () => {
    setTauri(true);
    const created = {
      id: "zone-new",
      name: "fresh.com",
      name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      status: "pending",
    };
    let zones = [ZONE];
    mockInvoke({ zones: () => zones });
    mocks.mutate.mockImplementation(async () => {
      zones = [ZONE, created];
      return created;
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
    // NS показываем сразу: второй раз Cloudflare их не отдаст.
    expect(await screen.findByText(/ada\.ns\.cloudflare\.com/)).toBeTruthy();

    fireEvent.click(screen.getByText("Done"));

    // Ровно то, ради чего фаза существует: зона создана — и она в списке.
    // Без инвалидации `cloudflareKeys.zones` её не было бы до ухода со страницы.
    await waitFor(() => {
      const rows = screen.getAllByTestId("zone-row");
      expect(rows.some((r) => within(r).queryByText("fresh.com"))).toBe(true);
    });
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
    expect(mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("/test"))).toBe(false);
  });
});

describe("Cloudflare — судьба ошибок", () => {
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

  it("не съедает ошибку мутации, которая в момент закрытия ещё летела", async () => {
    setTauri(true);
    let failPurge: (e: Error) => void = () => {};
    mocks.mutate.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failPurge = reject; })
    );

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));

    // Purge ещё летит — на экране пусто, гасить нечего. Но «+ Add Record» во
    // время его полёта НЕ заблокирована, и открытие формы двигало отметку
    // «уже видел» на сам летящий purge: `T > T` → его провал не показывался.
    fireEvent.click(screen.getByText("+ Add Record"));
    fireEvent.click(screen.getByText("Cancel"));

    failPurge(new Error("cloudflare: purge failed"));

    expect(await screen.findByText(/purge failed/)).toBeTruthy();
  });

  it("даёт закрыть баннер: сообщение не живёт вечно", async () => {
    setTauri(true);
    mocks.mutate.mockRejectedValue(new Error("cloudflare: purge failed"));

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🗑 Purge Cache"));

    const banner = await screen.findByRole("alert");
    fireEvent.click(within(banner).getByText("✕"));
    await waitFor(() => expect(screen.queryByText(/purge failed/)).toBeNull());
  });
});

describe("Cloudflare — веб только смотрит", () => {
  it("редактор только для чтения: ни одной sdmp-ссылки и ни одного вызова", async () => {
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

  it("объясняет, почему список записей пуст", async () => {
    setTauri(false);
    renderPage();
    await openZone();

    expect(await screen.findByText(/Reading DNS records runs in the SDMP desktop app/)).toBeTruthy();
  });
});
