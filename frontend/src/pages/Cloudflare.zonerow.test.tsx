import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Строка зоны: бейдж статуса и копирование id/NS.
 *
 * Главное здесь — не «бейдж рисуется», а какое утверждение он делает: цвет
 * ступени и отсутствие бейджа у зоны без статуса. Почему так — у
 * `ZONE_STATUS_VARIANT` в `Cloudflare.tsx`.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  mutate: vi.fn(),
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

// RevealSecret тянет argon2/libsodium и к строке зоны отношения не имеет.
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

/** Зона, чьи NS ещё не делегированы на Cloudflare, — жёлтая ступень. */
const PENDING_ZONE = { ...ZONE, id: "zone-b", name: "fresh.com", status: "pending" };

/** Зона, которую Cloudflare только заводит, — вторая жёлтая ступень. */
const INITIALIZING_ZONE = { ...ZONE, id: "zone-d", name: "new.com", status: "initializing" };

/** Зона, уехавшая из этого аккаунта: статус вне известных нам ступеней. */
const MOVED_ZONE = { ...ZONE, id: "zone-c", name: "moved.com", status: "moved" };

/**
 * Цвета текста бейджей из палитры `Badge` (`components/ui/Primitives.tsx`),
 * как их отдаёт jsdom. Именами, а не литералами по месту: три ступени
 * различаются ТОЛЬКО цветом, и «rgb(217, 119, 6)» в ассерте ничего не говорит
 * о том, жёлтый это или ещё какой.
 */
const GREEN = "rgb(22, 163, 74)"; // Badge variant="green", #16a34a
const YELLOW = "rgb(217, 119, 6)"; // Badge variant="yellow", #d97706
const GRAY = "rgb(55, 65, 81)"; // Badge variant="gray", #374151

const DOMAIN = {
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
};

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/**
 * `navigator.clipboard` в jsdom нет вовсе, а `copyText` зовёт его через `?.` —
 * без подмены копирование было бы молчаливым no-op, и тест проходил бы, даже
 * если кнопка ни к чему не подключена.
 */
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function mockHttp(domains: any[] = []) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return [ACCOUNT];
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

function mockInvoke(zones: any[] = [ZONE], records: any[] = []) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") return zones;
    if (cmd === "cf_list_dns_records") return records;
    return mocks.mutate(cmd, args);
  });
}

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Cloudflare />
    </QueryClientProvider>
  );
}

/** Карточка аккаунта приезжает свёрнутой — см. `Cloudflare.collapse.test`. */
async function expandAccounts() {
  const chevrons = await screen.findAllByLabelText(/^Свернуть\/развернуть аккаунт/);
  chevrons
    .filter((c) => c.getAttribute("aria-expanded") === "false")
    .forEach((c) => fireEvent.click(c));
}

async function zoneRow(zoneName: string): Promise<HTMLElement> {
  await screen.findByText(zoneName);
  const row = screen
    .getAllByTestId("zone-row")
    .find((r) => within(r).queryByText(zoneName));
  if (!row) throw new Error(`строки зоны «${zoneName}» на экране нет`);
  return row as HTMLElement;
}

async function openZone(zoneName = "example.com") {
  await expandAccounts();
  const row = await zoneRow(zoneName);
  fireEvent.click(within(row).getByText("Open DNS"));
  return await screen.findByText("🗑 Purge Cache");
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
  mockHttp();
  mockInvoke();
});

afterEach(() => {
  // vitest без `globals: true` не регистрирует авто-cleanup RTL.
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
  delete (window.navigator as any).clipboard;
  vi.unstubAllGlobals();
});

describe("Cloudflare — бейдж статуса зоны", () => {
  it("показывает статус из cf_list_zones, красит каждую ступень своим цветом", async () => {
    setTauri(true);
    mockInvoke([ZONE, PENDING_ZONE, INITIALIZING_ZONE, MOVED_ZONE]);

    renderPage();
    await expandAccounts();

    const badge = async (zoneName: string, status: string) =>
      within(await zoneRow(zoneName)).getByText(status);

    // Три РАЗНЫХ утверждения, поэтому и три точных цвета, а не «не зелёный»:
    // зелёный говорит «делегирование доехало» и заслужен только `active`;
    // жёлтый у `pending` и `initializing` — зона ещё не работает, и позеленить
    // эту ступень значит нарисовать здоровье там, где его никто не подтверждал;
    // серый — «состояние знает Cloudflare, а мы нет», туда же уходит незнакомое.
    // Оба жёлтых значения судятся поимённо: у каждого своя строка в
    // `ZONE_STATUS_VARIANT`, и одна проверка стерегла бы только одну из них.
    expect((await badge("example.com", "active")).style.color).toBe(GREEN);
    expect((await badge("fresh.com", "pending")).style.color).toBe(YELLOW);
    expect((await badge("new.com", "initializing")).style.color).toBe(YELLOW);
    expect((await badge("moved.com", "moved")).style.color).toBe(GRAY);
  });

  it("у зоны без статуса бейджа нет вовсе — веб не знает о делегировании", async () => {
    setTauri(false);
    mockHttp([DOMAIN]);

    renderPage();
    await expandAccounts();

    const row = await zoneRow("example.com");
    // Ни «active», ни выдуманного «pending»: резервный список собран из наших
    // доменов, статуса в них нет и взяться ему неоткуда.
    expect(within(row).queryByText(/^(active|pending|moved|unknown)$/i)).toBeNull();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });
});

describe("Cloudflare — копирование id и NS", () => {
  it("копирует id зоны из её строки", async () => {
    setTauri(true);
    const writeText = stubClipboard();
    mockInvoke([ZONE, MOVED_ZONE]);

    renderPage();
    await expandAccounts();

    // Подпись адресная: кнопок на экране столько же, сколько зон, и без имени
    // зоны они неотличимы — ни скринридеру, ни тесту.
    const row = await zoneRow("moved.com");
    fireEvent.click(within(row).getByRole("button", { name: "Copy zone ID for moved.com" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("zone-c"));
  });

  it("копирует все NS зоны одной строкой на строку", async () => {
    setTauri(true);
    const writeText = stubClipboard();

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🔗 Nameservers"));
    await screen.findByText("ada.ns.cloudflare.com");

    // По роли и доступному имени, а не по `title`: имя — это то, ради чего
    // проп и заводился, а тултип его лишь один из источников.
    fireEvent.click(screen.getByRole("button", { name: "Copy nameservers" }));

    // Через `\n`: NS вбивают у регистратора списком, и склейка через запятую
    // потребовала бы чистить вставленное руками.
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("ada.ns.cloudflare.com\nbob.ns.cloudflare.com")
    );
  });

  it("не предлагает копировать NS, которых нет", async () => {
    setTauri(false);
    mockHttp([DOMAIN]);

    renderPage();
    await openZone();
    fireEvent.click(screen.getByText("🔗 Nameservers"));

    // В вебе NS не приезжают вовсе — кнопка копировала бы пустую строку и
    // молча «успевала».
    expect(await screen.findByText(/Nameservers come from Cloudflare/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy nameservers" })).toBeNull();
  });
});
