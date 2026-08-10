import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { cloudflareKeys } from "../api/cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Поиск при масштабе: фильтр аккаунтов на странице и фильтр/сортировка зон
 * внутри карточки. Экран рассчитан на десятки аккаунтов и сотни зон, и главное
 * здесь — не «поле рисуется», а что именно оно утверждает: общие счётчики от
 * фильтра не едут, «ничего не нашлось» не выдаёт себя за «ничего нет», а зона
 * без статуса не всплывает наверх при сортировке по статусу.
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

// RevealSecret тянет argon2/libsodium и к поиску отношения не имеет.
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
/** Аккаунт без `account_id`: поле в схеме nullable, и фильтр обязан это пережить. */
const NO_ID_ACCOUNT = { ...ACCOUNT, id: 9, name: "Backup CF", account_id: null };

const zone = (name: string, status: string | null = "active") => ({
  id: `id-${name}`,
  name,
  name_servers: ["ada.ns.cloudflare.com"],
  status,
});

/**
 * Ровно порог показа поиска зон (`ZONE_SEARCH_MIN`). Порядок фикстуры НАРОЧНО
 * перемешан: заданная по алфавиту, она делала бы любое утверждение о порядке
 * тавтологией — список приезжал бы на экран уже правильным, и сортировку можно
 * было бы удалить целиком, не покраснев ни одним тестом.
 */
const EIGHT_ZONES = [
  zone("f-active.com"),
  zone("c-moved.com", "moved"),
  zone("h-active.com"),
  zone("a-pending.com", "pending"),
  zone("e-none.com", null),
  zone("g-active.com"),
  zone("b-init.com", "initializing"),
  zone("d-active.com"),
];

/** Имена `EIGHT_ZONES` по алфавиту — то, что даёт сортировка по умолчанию. */
const BY_NAME = [
  "a-pending.com", "b-init.com", "c-moved.com", "d-active.com",
  "e-none.com", "f-active.com", "g-active.com", "h-active.com",
];

const domain = (id: number, name: string, zoneId: string) => ({
  id,
  domain_name: name,
  status: "active",
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: ACCOUNT.id,
  cloudflare_zone_id: zoneId,
  cloudflare_enabled: true,
  expiry_date: null,
  purchase_date: null,
  ns_status: null,
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Домены нужны только вебу: там зоны собираются из них, а не из Cloudflare. */
function mockHttp(accounts: any[], domains: any[] = []) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

function mockInvoke(zones: any[] = []) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") return zones;
    if (cmd === "cf_list_dns_records") return [];
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

const accountSearch = () => screen.getByLabelText("Search Cloudflare accounts");

/**
 * Подписи контролов зон — точными строками, вместе с `account_id`: он в них не
 * украшение, а единственное, чем различаются подписи у аккаунтов-тёзок (имена
 * вида «Main CF» — та самая причина, по которой фильтр ищет и по id).
 */
const ZONE_SEARCH_LABEL = "Search zones in Main CF (cf-acc-1)";
const ZONE_SORT_LABEL = "Sort zones in Main CF (cf-acc-1)";

/** Карточка аккаунта приезжает свёрнутой — см. `Cloudflare.collapse.test`. */
async function expandAccounts() {
  const chevrons = await screen.findAllByLabelText(/^Свернуть\/развернуть аккаунт/);
  chevrons
    .filter((c) => c.getAttribute("aria-expanded") === "false")
    .forEach((c) => fireEvent.click(c));
}

/**
 * Имена зон в порядке, в каком они стоят на экране. Читаем их из подписи кнопки
 * копирования — она адресная и по одной на строку; счёт вложенных узлов ломался
 * бы от любой новой обёртки в разметке строки.
 */
function zoneNames(): string[] {
  return screen
    .getAllByRole("button", { name: /^Copy zone ID for / })
    .map((b) => (b.getAttribute("aria-label") || "").replace("Copy zone ID for ", ""));
}

/**
 * Левый блок шапки карточки: там стоит бейдж со счётчиком зон. Скоуп нужен,
 * чтобы утверждение было про СВОЮ карточку, а не «где-то на странице есть такой
 * текст». Поднимаемся `closest`, а не счётом `parentElement`: счёт ступеней
 * ломается от любой новой обёртки.
 */
function headerOf(accName: string): HTMLElement {
  const header = screen.getByText(accName).closest('[data-testid="account-header"]');
  if (!header) throw new Error(`шапки аккаунта «${accName}» на экране нет`);
  return header as HTMLElement;
}

/** Имена аккаунтов на экране — из подписи шеврона, по той же причине. */
function accountNames(): string[] {
  return screen
    .getAllByLabelText(/^Свернуть\/развернуть аккаунт /)
    .map((c) => (c.getAttribute("aria-label") || "").replace("Свернуть/развернуть аккаунт ", ""));
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
  mockHttp([ACCOUNT]);
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

describe("Cloudflare — поиск по аккаунтам", () => {
  it("сужает список по имени", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT, NO_ID_ACCOUNT]);

    renderPage();
    await screen.findByText("Second CF");

    fireEvent.change(accountSearch(), { target: { value: "second" } });

    expect(accountNames()).toEqual(["Second CF"]);
  });

  it("ищет по account_id независимо от регистра и переживает его отсутствие", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT, NO_ID_ACCOUNT]);

    renderPage();
    await screen.findByText("Backup CF");

    // Ни одного имени аккаунта в этом запросе нет: совпасть он может только по
    // `account_id`. Аккаунт с `account_id: null` стоит рядом — на нём фильтр
    // и падал бы, если бы читал его без сторожа.
    fireEvent.change(accountSearch(), { target: { value: "ACC-2" } });

    expect(accountNames()).toEqual(["Second CF"]);
  });

  it("«ничего не нашлось» — не то же, что «аккаунтов нет»", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT]);

    renderPage();
    await screen.findByText("Main CF");

    fireEvent.change(accountSearch(), { target: { value: "нетакого" } });

    // Аккаунты есть, и предлагать завести ещё один в ответ на неудачный поиск —
    // совет мимо задачи. Единственное осмысленное действие здесь — снять запрос.
    expect(screen.getByText("No accounts match your search")).toBeTruthy();
    expect(screen.queryByText("No Cloudflare accounts yet")).toBeNull();
    expect(screen.queryAllByTestId("account-header").length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(accountNames()).toEqual(["Main CF", "Second CF"]);
  });

  it("когда аккаунтов нет вовсе — пустое состояние с «+ Add Account» и без поля поиска", async () => {
    setTauri(true);
    mockHttp([]);

    renderPage();

    expect(await screen.findByText("No Cloudflare accounts yet")).toBeTruthy();
    // Искать не в чем: поле над пустым экраном обещало бы список, которого нет.
    expect(screen.queryByLabelText("Search Cloudflare accounts")).toBeNull();
    expect(screen.queryByText("No accounts match your search")).toBeNull();
    expect(screen.getAllByRole("button", { name: "+ Add Account" }).length).toBeGreaterThan(0);
  });

  it("общие счётчики от фильтра не едут, а число найденного стоит у самого поля", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT, NO_ID_ACCOUNT]);

    renderPage();
    await screen.findByText("3 accounts connected");

    fireEvent.change(accountSearch(), { target: { value: "second" } });

    // «Подключено» и «Total Accounts» описывают инвентарь, а не то, что сейчас
    // на экране: поехав за фильтром, они молча сменили бы смысл.
    expect(screen.getByText("3 accounts connected")).toBeTruthy();
    const total = screen.getByText("Total Accounts").parentElement as HTMLElement;
    expect(within(total).getByText("3")).toBeTruthy();
    // А вот у поля число именно про фильтр — и оно там появляется. Роль
    // `status` не украшение: список меняется молча, и без объявления скринридер
    // узнаёт об этом, только уйдя проверять его руками.
    expect(screen.getByRole("status").textContent).toBe("1 of 3");
  });
});

describe("Cloudflare — поиск и сортировка зон в карточке", () => {
  it("фильтрует зоны по имени и отличает «не нашлось» от «зон нет»", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES);

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    const field = screen.getByLabelText(ZONE_SEARCH_LABEL);
    fireEvent.change(field, { target: { value: "ACTIVE" } });

    expect(zoneNames()).toEqual(["d-active.com", "f-active.com", "g-active.com", "h-active.com"]);
    // Заголовок остаётся общим — это то же число, что в бейдже шапки; сколько
    // осталось от запроса, говорит счётчик у поля.
    expect(screen.getByText("Zones (8)")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("4 of 8");

    fireEvent.change(field, { target: { value: "нетакой" } });

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(screen.getByText(/No zones match/)).toBeTruthy();
    // «Зон нет» на месте «ни одна не подошла» читалось бы как «зоны пропали».
    expect(screen.queryByText(/No zones linked to this account yet/)).toBeNull();
  });

  it("бейдж шапки от фильтра зон не едет — это тот же показатель, что «Zones (N)»", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES);

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    fireEvent.change(screen.getByLabelText(ZONE_SEARCH_LABEL), { target: { value: "active" } });
    expect(zoneNames().length).toBe(4);

    // Бейдж и заголовок объявлены ОДНИМ показателем: разъехавшись («Zones (8)»
    // против «4 domains»), они заставили бы гадать, какому верить. Тем более что
    // бейдж виден и у свёрнутой карточки, где заголовка рядом нет вовсе.
    expect(within(headerOf("Main CF")).getByText("8 domains")).toBeTruthy();
    expect(screen.getByText("Zones (8)")).toBeTruthy();
  });

  it("список, ужавшийся ниже порога, не остаётся отфильтрован невидимым запросом", async () => {
    setTauri(true);
    let zones = EIGHT_ZONES;
    mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "cf_list_zones") return zones;
      if (cmd === "cf_list_dns_records") return [];
      return mocks.mutate(cmd, args);
    });

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    fireEvent.change(screen.getByLabelText(ZONE_SEARCH_LABEL), { target: { value: "active" } });
    expect(zoneNames()).toEqual(["d-active.com", "f-active.com", "g-active.com", "h-active.com"]);

    // Зону удалили (здесь — Cloudflare отдаёт список без неё), и число зон ушло
    // ниже порога: поле поиска пропало вместе с ним. Запрос при этом остался в
    // стейте карточки — снять его пользователю уже нечем.
    zones = EIGHT_ZONES.filter((z) => z.name !== "d-active.com");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: cloudflareKeys.zones(ACCOUNT.id) });
    });
    await waitFor(() => expect(screen.queryByLabelText(ZONE_SEARCH_LABEL)).toBeNull());

    // Поэтому фильтр действует ровно тогда, когда поле видно: иначе на экране
    // осталось бы три зоны из семи, и почему — не сказано ничем.
    expect(zoneNames()).toEqual(BY_NAME.filter((n) => n !== "d-active.com"));
  });

  it("сортировка по статусу поднимает ждущее действия и оставляет зону без статуса внизу", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES);

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    // По умолчанию — по имени, и это не даровое совпадение с порядком ответа
    // Cloudflare: фикстура приезжает перемешанной.
    expect(zoneNames()).toEqual(BY_NAME);

    fireEvent.change(screen.getByLabelText(ZONE_SORT_LABEL), { target: { value: "status" } });

    // Сверху — то, что ждёт человека (`pending` → пропиши NS, `initializing` →
    // Cloudflare ещё заводит зону), затем незнакомое (`moved`: не «в порядке»,
    // но и не задача), затем `active`, с которым делать нечего. Зона БЕЗ
    // статуса — в самом низу: её состояния мы не знаем, и поднять незнание в
    // начало списка важного значило бы выдать его за проблему.
    expect(zoneNames()).toEqual([
      "a-pending.com", "b-init.com", "c-moved.com",
      "d-active.com", "f-active.com", "g-active.com", "h-active.com",
      "e-none.com",
    ]);
  });

  it("ниже порога поля поиска нет, но порядок по имени всё равно наведён", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES.slice(0, 7));

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    // Семь имён проглядывают глазами быстрее, чем набирают запрос.
    expect(screen.queryByLabelText(ZONE_SEARCH_LABEL)).toBeNull();
    // А порядок наводится и здесь: иначе один и тот же аккаунт раскладывал бы
    // зоны по-разному по разные стороны порога.
    expect(zoneNames()).toEqual(BY_NAME.filter((n) => n !== "d-active.com"));
  });

  it("от восьми зон появляется поле поиска", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES);

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    expect(screen.getByLabelText(ZONE_SEARCH_LABEL)).toBeTruthy();
  });

  it("селектор сортировки появляется уже у двух зон — поиска там ещё нет", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES.slice(0, 2));

    renderPage();
    await expandAccounts();
    await screen.findByText("c-moved.com");

    // Порог у сортировки свой и низкий: селектор стоит один тег в уже
    // существующем ряду, а поиск требует набрать запрос, чтобы окупиться.
    expect(screen.getByLabelText(ZONE_SORT_LABEL)).toBeTruthy();
    expect(screen.queryByLabelText(ZONE_SEARCH_LABEL)).toBeNull();
  });

  it("у единственной зоны сортировать нечего — селектора нет", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES.slice(0, 1));

    renderPage();
    await expandAccounts();
    await screen.findByText("f-active.com");

    expect(screen.queryByLabelText(ZONE_SORT_LABEL)).toBeNull();
  });

  it("в вебе пункта «Sort: status» нет — статуса не знает ни одна зона", async () => {
    setTauri(false);
    mockHttp([ACCOUNT], [domain(1, "ccc.com", "z-3"), domain(2, "aaa.com", "z-1"), domain(3, "bbb.com", "z-2")]);

    renderPage();
    await expandAccounts();
    await screen.findByText("aaa.com");

    // Список собран из наших доменов: сортировка по статусу дала бы ровно тот
    // же порядок, что и по имени, — мёртвый пункт на каждой карточке веба.
    expect(screen.getByLabelText(ZONE_SORT_LABEL)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: name" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Sort: status" })).toBeNull();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  it("со статусами пункт «Sort: status» на месте", async () => {
    setTauri(true);
    mockInvoke(EIGHT_ZONES);

    renderPage();
    await expandAccounts();
    await screen.findByText("a-pending.com");

    expect(screen.getByRole("option", { name: "Sort: status" })).toBeTruthy();
  });
});
