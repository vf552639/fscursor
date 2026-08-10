import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import Cloudflare from "./Cloudflare";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Шапка карточки аккаунта: счётчик зон и сворачивание. Оба про одно — страница
 * с десятками аккаунтов, у каждого из которых раскрыт полный список зон,
 * читается только скроллом.
 *
 * Число в шапке — то же самое, что в заголовке «Zones (N)». Смысл дубля в том,
 * что у свёрнутой карточки блока зон не видно, а знать, сколько их, надо.
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
const EMPTY_ACCOUNT = { ...ACCOUNT, id: 9, name: "Empty CF", account_id: "cf-acc-3" };

const ZONE = {
  id: "zone-a",
  name: "example.com",
  name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
  status: "active",
};

const ZONE_B = { ...ZONE, id: "zone-b", name: "second.com" };

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/**
 * Доменов у аккаунтов в этих тестах нет вовсе — и это осмысленно: счётчик в
 * шапке считает зоны из Cloudflare, а не строки нашей базы. Пустой `/domains`
 * держит эту границу: будь счётчик снова доменным, все числа стали бы нулями.
 */
function mockHttp(accounts: any[], domains: any[] = []) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/cloudflare/accounts") return accounts;
    if (url === "/domains") return domains;
    throw new Error(`unexpected GET ${url}`);
  });
}

/**
 * Чтения отвечают фикстурой, всё прочее уходит в `mocks.mutate`. `zones` можно
 * задать функцией от `accountId` — тогда у соседних карточек разное число зон.
 */
function mockInvoke(zones: any[] | ((accountId: string) => any[]) = [ZONE]) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === "cf_list_zones") return typeof zones === "function" ? zones(args.accountId) : zones;
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
 * Левый блок шапки: шеврон, имя и бейджи лежат в одном flex-ряду. Скоуп нужен,
 * чтобы при двух аккаунтах счётчик привязывался к своей карточке, а не просто
 * «где-то на странице есть такой текст». Поднимаемся `closest`, а не счётом
 * `parentElement`: счёт ступеней ломается от любой новой обёртки.
 */
function headerOf(accName: string): HTMLElement {
  const header = screen.getByText(accName).closest('[data-testid="account-header"]');
  if (!header) throw new Error(`шапки аккаунта «${accName}» на экране нет`);
  return header as HTMLElement;
}

/**
 * Сама шапка (`CHd`) — мишень «клик по пустому месту»: она раскладывает
 * содержимое `space-between`, и промежуток между бейджами и кнопками
 * принадлежит именно ей, а не вложенным блокам.
 */
function cardHeaderOf(accName: string): HTMLElement {
  return headerOf(accName).parentElement as HTMLElement;
}

function chevronOf(accName: string) {
  return screen.getByLabelText(`Свернуть/развернуть аккаунт ${accName}`);
}

/** Число зон в бейдже шапки: ждём живой список, до него там фолбэк. */
async function expectBadge(accName: string, text: string) {
  await waitFor(() => expect(within(headerOf(accName)).getByText(text)).toBeTruthy());
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

describe("Cloudflare — счётчик в шапке аккаунта", () => {
  it("показывает число зон, а не строк из нашей базы", async () => {
    setTauri(true);
    // Ровно расхождение, которое увидел пользователь: доменов в базе нет, а зон
    // в Cloudflare две — в шапке должна стоять двойка, а не ноль.
    mockInvoke([ZONE, ZONE_B]);

    renderPage();

    await screen.findByText("Main CF");
    await expectBadge("Main CF", "2 domains");

    // И это ТО ЖЕ число, что в заголовке блока зон: два показателя разъезжаться
    // не должны, иначе непонятно, какому верить.
    fireEvent.click(chevronOf("Main CF"));
    expect(await screen.findByText("Zones (2)")).toBeTruthy();
  });

  it("единственная зона — без «-s», ни одной — «0 domains»", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, EMPTY_ACCOUNT]);
    mockInvoke((accountId) => (accountId === "9" ? [] : [ZONE]));

    renderPage();

    await screen.findByText("Main CF");
    // «1 domains» на самом видном месте карточки читается опечаткой продукта.
    await expectBadge("Main CF", "1 domain");
    await expectBadge("Empty CF", "0 domains");
  });
});

describe("Cloudflare — сворачивание карточки аккаунта", () => {
  it("по умолчанию карточка свёрнута: видна только шапка", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    await expectBadge("Main CF", "1 domain");

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(screen.queryByText(/^Token:/)).toBeNull();
    expect(screen.queryByText(/^Zones \(/)).toBeNull();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("false");
  });

  it("шеврон разворачивает ровно одним кликом и сворачивает обратно", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");

    // «Ровно одним»: клик по шеврону всплывает в шапку, у которой тот же
    // обработчик. Без stopPropagation переключений было бы два, и карточка
    // осталась бы свёрнутой — мишень выглядела бы сломанной.
    fireEvent.click(chevronOf("Main CF"));

    expect((await screen.findAllByTestId("zone-row")).length).toBe(1);
    expect(screen.getByText(/^Token:/)).toBeTruthy();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(chevronOf("Main CF"));

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(screen.queryByText(/^Token:/)).toBeNull();
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("false");
    // Шапка видна всегда — иначе свёрнутую карточку нечем опознать.
    expect(screen.getByText("Main CF")).toBeTruthy();
  });

  it("клик по пустому месту шапки разворачивает карточку", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");
    fireEvent.click(cardHeaderOf("Main CF"));

    expect((await screen.findAllByTestId("zone-row")).length).toBe(1);
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("true");
  });

  it("выделение текста в шапке не переключает карточку", async () => {
    setTauri(true);
    // `account_id` выделяют мышью, чтобы скопировать, а mouseup после выделения
    // тоже даёт click: без проверки выделения id нельзя было бы скопировать, не
    // развернув карточку.
    vi.stubGlobal("getSelection", () => ({ toString: () => "cf-acc-1" }));

    renderPage();

    await screen.findByText("Main CF");
    fireEvent.click(cardHeaderOf("Main CF"));

    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
    expect(chevronOf("Main CF").getAttribute("aria-expanded")).toBe("false");
  });

  it("шеврон переключается с клавиатуры — Enter и пробелом", async () => {
    setTauri(true);
    renderPage();

    await screen.findByText("Main CF");

    fireEvent.keyDown(chevronOf("Main CF"), { key: "Enter" });
    expect((await screen.findAllByTestId("zone-row")).length).toBe(1);

    // Событие создаём вручную, чтобы проверить `preventDefault`: без него пробел
    // на шевроне ещё и прокручивает страницу, а обычный `fireEvent.keyDown`
    // остался бы зелёным и без него — то есть ничего бы не стерёг.
    const space = createEvent.keyDown(chevronOf("Main CF"), { key: " " });
    fireEvent(chevronOf("Main CF"), space);
    expect(space.defaultPrevented).toBe(true);
    expect(screen.queryAllByTestId("zone-row").length).toBe(0);
  });

  it("разворачивает только свою карточку, соседнюю не трогает", async () => {
    setTauri(true);
    mockHttp([ACCOUNT, SECOND_ACCOUNT]);

    renderPage();

    await screen.findByText("Second CF");
    fireEvent.click(chevronOf("Main CF"));

    expect((await screen.findAllByTestId("zone-row")).length).toBe(1);
    expect(chevronOf("Second CF").getAttribute("aria-expanded")).toBe("false");
  });

  it("кнопки Test/Edit/✕ не сворачивают развёрнутую карточку", async () => {
    setTauri(true);
    mocks.mutate.mockResolvedValue(true);
    // Удаление отклоняем: тест про сворачивание, а не про исчезновение карточки.
    mocks.confirmAction.mockResolvedValue(false);

    renderPage();
    await screen.findByText("Main CF");
    fireEvent.click(chevronOf("Main CF"));
    expect((await screen.findAllByTestId("zone-row")).length).toBe(1);

    // Кнопки лежат ВНУТРИ шапки, у которой теперь свой onClick: без остановки
    // всплытия каждый клик по ним сворачивал бы карточку.
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
