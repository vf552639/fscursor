import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import DesktopWorkspace from "./DesktopWorkspace";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Владелец результатов provision — `DesktopWorkspace`, и проверяется он здесь
 * целиком, а не через копию проводки: пароли БД и FTP существуют в единственном
 * экземпляре, и вопрос «куда они попадают» решается именно на этом уровне.
 *
 * Две гарантии владельца:
 * 1. Второй результат не затирает первый (очередь показов, а не один слот).
 * 2. Результат provision, запущенного по `sdmp://`-ссылке, тоже доходит до
 *    экрана: в вебе deep link — единственная кнопка provision, а FTP-аккаунт
 *    создаётся на каждом прогоне.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeSynced: vi.fn(),
  onOpenUrl: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Deep link: настоящий плагин в jsdom не работает, а обработчик ссылки нам
// нужен вживую — забираем его из `onOpenUrl`.
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: async () => [],
  onOpenUrl: mocks.onOpenUrl,
}));
vi.mock("../lib/tauri-invoke", () => ({ invokeIfTauri: vi.fn(async () => null) }));

// Соседние страницы воркспейса: к владению результатами provision отношения не
// имеют, а их деревья тянут пол-приложения.
vi.mock("./Dashboard", () => ({ default: () => null }));
vi.mock("./Servers", () => ({ default: () => null }));
vi.mock("./ServerDetail", () => ({ default: () => null }));
vi.mock("./Cloudflare", () => ({ default: () => null }));
vi.mock("./Activity", () => ({ default: () => null }));
vi.mock("./Notifications", () => ({ default: () => null }));
vi.mock("./Settings", () => ({ default: () => null }));
// Тяжёлые дети самой страницы Domains, которые этот сценарий не открывает.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/BulkSetupWizard", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));
vi.mock("../components/TaskProgressModal", () => ({ default: () => null }));
vi.mock("../components/MultiTaskProgressModal", () => ({ default: () => null }));

function domainRow(id: number, name: string) {
  return {
    id,
    domain_name: name,
    status: "new",
    registrar_id: null,
    server_id: 5,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    cloudflare_enabled: false,
    expiry_date: null,
    purchase_date: null,
    ns_status: "pending",
    ns_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function result(id: string, password: string) {
  return {
    domain_id: id,
    site_user: `site_${id}`,
    site_path: `/var/www/site_${id}`,
    ssl_issued: true,
    db: { db_name: `db_${id}`, db_user: `user_${id}`, db_password: password },
    ftp: { ftp_user: `ftp_${id}`, ftp_password: `${password}-ftp` },
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  };
  if (!on) {
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI_EVENT_PLUGIN_INTERNALS__;
    return;
  }
  // Не пустышка: воркспейс подписывается на четыре канала событий настоящим
  // `@tauri-apps/api/event` (замокать его не выходит — динамический импорт
  // внешнего пакета), а тот лезет в `transformCallback`/`invoke`, а на отписке
  // — в `unregisterListener`. Без заглушек подписки падают нераспознанными
  // rejection'ами и пачкают весь прогон.
  w.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async () => 1 };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

function renderWorkspace(rows: Array<{ id: number; name: string }>) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows.map((r) => domainRow(r.id, r.name));
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    if (String(url).includes("unread")) return { count: 0 };
    return {};
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DesktopWorkspace />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Запустить provision у строки конкретного домена. */
async function provisionRow(domain: string) {
  const row = (await screen.findByText(domain)).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Provision domain" }));
  fireEvent.click(await screen.findByLabelText(/Also create a database/i));
  fireEvent.click(screen.getByRole("button", { name: "Provision" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("sdmp_page", "domains");
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mocks.onOpenUrl.mockResolvedValue(() => {});
  setTauri(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe("DesktopWorkspace — владелец результатов provision", () => {
  it("показывает оба результата подряд, не затирая первый", async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};
    mocks.invokeSynced.mockImplementation(
      (_cmd: string, args: any) =>
        new Promise((resolve) => {
          resolvers[args.domainId] = resolve;
        }),
    );

    renderWorkspace([
      { id: 1, name: "a.com" },
      { id: 2, name: "b.com" },
    ]);

    await provisionRow("a.com");
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    await provisionRow("b.com");
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(2));

    resolvers["1"](result("1", "PW-A"));
    expect(await screen.findByText("PW-A")).toBeTruthy();

    resolvers["2"](result("2", "PW-B"));
    await waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .filter((m) => m.state.status === "success"),
      ).toHaveLength(2),
    );

    // Пароли `a.com` больше нигде не существуют: сервер их не знает, в кэше
    // мутаций их нет намеренно. Затереть = потерять навсегда, притом что БД и
    // FTP-аккаунт на сервере уже созданы.
    expect(screen.getByText("PW-A")).toBeTruthy();
    expect(screen.getByText("Provisioned a.com")).toBeTruthy();
    expect(screen.queryByText("PW-B")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("PW-B")).toBeTruthy();
    expect(screen.getByText("Provisioned b.com")).toBeTruthy();
  });

  it("показывает результат provision, запущенного по sdmp://-ссылке", async () => {
    mocks.invokeSynced.mockResolvedValue(result("42", "PW-LINK"));
    vi.stubGlobal("confirm", () => true);

    renderWorkspace([{ id: 42, name: "example.com" }]);
    await waitFor(() => expect(mocks.onOpenUrl).toHaveBeenCalled());
    const handler = mocks.onOpenUrl.mock.calls[0][0] as (urls: string[]) => void;

    handler(["sdmp://provision?domainId=42"]);

    // FTP-аккаунт создаётся на каждом не-`site_only` прогоне, и его пароль
    // возвращается только в этом ответе. Отбросить результат = оставить
    // пользователя с аккаунтом, войти в который он не сможет никогда.
    expect(await screen.findByText("PW-LINK-ftp")).toBeTruthy();
    expect(screen.getByText("PW-LINK")).toBeTruthy();
    expect(JSON.stringify(localStorage)).not.toContain("PW-LINK");
    expect(JSON.stringify(sessionStorage)).not.toContain("PW-LINK");
  });
});
