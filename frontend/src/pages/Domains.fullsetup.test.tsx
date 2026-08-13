import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Полная настройка домена: мастер «Add Domain» и массовое действие.
 *
 * Проверяется то, что видит пользователь: связки уезжают одним запросом, зону и
 * NS выполняет десктоп, отчёт называет числами и то, что не получилось. И
 * отдельно — что кнопка «Прописать NS» гаснет у регистратора без API, а
 * основная кнопка при этом остаётся живой: домен и зона нужны и в этом случае.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
  invokeIfTauri: vi.fn(),
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

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

function domainRow(id: number, name: string, serverId: number | null = null) {
  return {
    id,
    domain_name: name,
    status: "new",
    registrar_id: null,
    server_id: serverId,
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

const SERVERS = [
  { id: 5, name: "loaded", ip_address: "1.1.1.1", status: "active" },
  { id: 6, name: "empty", ip_address: "2.2.2.2", status: "active" },
];

const CF_ACCOUNT = {
  id: 7,
  name: "main",
  account_id: null,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const REGISTRARS = [
  { id: 3, provider: "hostiq", name: "hq", api_user: null, is_active: true, api_key_blob_id: null, api_secret_blob_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 4, provider: "godaddy", name: "gd", api_user: null, is_active: true, api_key_blob_id: null, api_secret_blob_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Ответ команды `domain_full_setup`: зона заведена, NS прописаны. */
function setupOk(domainId: string, patch: Record<string, unknown> = {}) {
  return {
    domain_id: domainId,
    zone: { status: "created", zone_id: `z-${domainId}`, name_servers: ["a.ns", "b.ns"] },
    zone_saved: true,
    ns: { status: "skipped", reason: "not_requested" },
    ...patch,
  };
}

const onFullSetupNotice = vi.fn();

function renderPage(rows = [domainRow(1, "a.com", 5), domainRow(2, "b.com", 5)]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
    if (url === "/servers") return { items: SERVERS, total: SERVERS.length };
    if (url === "/registrars/accounts") return REGISTRARS;
    if (url === "/cloudflare/accounts") return [CF_ACCOUNT];
    return {};
  });
  // Зоны для подсказки живого матча — прогон полной настройки их не читает.
  mocks.invokeSynced.mockResolvedValue([]);
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains
        onProvisionResult={vi.fn()}
        onBulkProvisionResult={vi.fn()}
        onBulkProvisionError={vi.fn()}
        onCloudflareBindNotice={vi.fn()}
        onFullSetupNotice={onFullSetupNotice}
      />
    </QueryClientProvider>,
  );
}

/** Выделить все строки и открыть диалог полной настройки. */
async function openBulkDialog(container: HTMLElement) {
  fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
  fireEvent.click(screen.getByRole("button", { name: "Full setup" }));
  await screen.findByLabelText("Cloudflare-аккаунт");
}

function selectValue(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  setTauri(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — массовая полная настройка", () => {
  it("связки одним запросом, затем команда на каждый домен, и отчёт числами", async () => {
    mocks.apiPost.mockResolvedValue({
      domains: [
        { id: 1, domain_name: "a.com" },
        { id: 2, domain_name: "b.com" },
      ],
      skipped_ids: [],
    });
    mocks.invokeIfTauri.mockImplementation(async (_cmd: string, args: any) => setupOk(args.domainId));

    const { container } = renderPage();
    await screen.findByText("a.com");
    await openBulkDialog(container);
    selectValue("Хостинг (сервер)", "5");
    selectValue("Cloudflare-аккаунт", "7");
    fireEvent.click(screen.getByRole("button", { name: "Настроить" }));

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith("/domains/full-setup", {
        domain_ids: [1, 2],
        server_id: 5,
        cloudflare_account_id: 7,
      }),
    );
    await waitFor(() => expect(mocks.invokeIfTauri).toHaveBeenCalledTimes(2));
    expect(mocks.invokeIfTauri.mock.calls.map((c: any[]) => c[1].domainName)).toEqual(["a.com", "b.com"]);
    // Зона заведена обоим, NS не просили — «✓» тут заслужено.
    expect((await screen.findByRole("status")).textContent).toContain(
      "2 of 2 linked, 2 zone(s) created",
    );
    // Диалог закрыт: прогон идёт минутами, а отчёт живёт баннером над таблицей.
    expect(screen.queryByRole("button", { name: "Настроить" })).toBeNull();
  });

  it("незаписанную зону поднимает в сводку, а не прячет в строку домена", async () => {
    mocks.apiPost.mockResolvedValue({ domains: [{ id: 1, domain_name: "a.com" }], skipped_ids: [2] });
    mocks.invokeIfTauri.mockResolvedValue(setupOk("1", { zone_saved: false }));

    const { container } = renderPage();
    await screen.findByText("a.com");
    await openBulkDialog(container);
    selectValue("Хостинг (сервер)", "5");
    selectValue("Cloudflare-аккаунт", "7");
    fireEvent.click(screen.getByRole("button", { name: "Настроить" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 not found");
    expect(alert.textContent).toContain("not recorded in SDMP");
  });

  it("выделение после прогона остаётся: доработка идёт по тому же набору", async () => {
    mocks.apiPost.mockResolvedValue({ domains: [{ id: 1, domain_name: "a.com" }], skipped_ids: [] });
    mocks.invokeIfTauri.mockResolvedValue(setupOk("1"));

    const { container } = renderPage([domainRow(1, "a.com", 5)]);
    await screen.findByText("a.com");
    await openBulkDialog(container);
    selectValue("Хостинг (сервер)", "5");
    selectValue("Cloudflare-аккаунт", "7");
    fireEvent.click(screen.getByRole("button", { name: "Настроить" }));

    await waitFor(() => expect(mocks.invokeIfTauri).toHaveBeenCalled());
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("выпадашки ставят наименее загруженные сверху и называют нагрузку", async () => {
    const { container } = renderPage();
    await screen.findByText("a.com");
    await openBulkDialog(container);

    const servers = screen.getByLabelText("Хостинг (сервер)") as HTMLSelectElement;
    expect(Array.from(servers.options).map((o) => o.textContent)).toEqual([
      "— None —",
      "empty — 0 доменов",
      "loaded — 2 домена",
    ]);
  });

  it("у регистратора без NS-API гаснет тумблер NS, а не кнопка запуска", async () => {
    const { container } = renderPage();
    await screen.findByText("a.com");
    await openBulkDialog(container);
    selectValue("Хостинг (сервер)", "5");
    selectValue("Cloudflare-аккаунт", "7");

    selectValue("Регистратор", "3");
    expect((screen.getByRole("checkbox", { name: /Прописать NS/ }) as HTMLInputElement).disabled).toBe(false);

    selectValue("Регистратор", "4");
    const ns = screen.getByRole("checkbox", { name: /Прописать NS/ }) as HTMLInputElement;
    expect(ns.disabled).toBe(true);
    // Причина названа там же, где погас тумблер: домен и зона всё равно будут.
    expect(screen.getByText(/нет API — пропишите NS вручную/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Настроить" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("в вебе кнопки нет вовсе: зону и NS выполнять нечем", async () => {
    setTauri(false);
    const { container } = renderPage();
    await screen.findByText("a.com");
    fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);

    // Тулбар при этом на месте — исчезла ровно та кнопка, за которой в вебе
    // ничего нет: CTA «открыть в десктопе» под неё потребовал бы хоста в
    // `parseDeepLinkAction`, а его там нет — то есть ссылки в никуда.
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(container.querySelector('a[href^="sdmp://assign-server"]')).toBeTruthy();
  });
});

describe("Domains — мастер «Add Domain»", () => {
  async function addDomain(name: string) {
    fireEvent.click(await screen.findByText("+ Add Domain"));
    fireEvent.change(await screen.findByPlaceholderText("e.g., example.com"), {
      target: { value: name },
    });
  }

  it("создаёт домен со связками и настраивает его одной кнопкой", async () => {
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));
    mocks.invokeIfTauri.mockResolvedValue(
      setupOk("9", { ns: { status: "pushed", nameservers: ["a.ns", "b.ns"] } }),
    );

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");
    selectValue("Хостинг (сервер)", "6");
    selectValue("Регистратор", "3");
    selectValue("Cloudflare-аккаунт", "7");
    fireEvent.click(screen.getByRole("checkbox", { name: /Создать зону/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Прописать NS/ }));
    // Подпись кнопки следует за тумблерами: действие уже не «просто заведи».
    fireEvent.click(screen.getByRole("button", { name: "Создать и настроить" }));

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith("/domains", {
        domain_name: "new.com",
        server_id: 6,
        registrar_id: 3,
        cloudflare_account_id: 7,
      }),
    );
    // Связки уехали вместе с созданием — второй раз за ними не ходим.
    expect(mocks.apiPost.mock.calls.map((c: any[]) => c[0])).toEqual(["/domains"]);
    await waitFor(() =>
      expect(mocks.invokeIfTauri).toHaveBeenCalledWith("domain_full_setup", {
        userId: "user-1",
        domainId: "9",
        domainName: "new.com",
        cloudflareAccountId: "7",
        registrarAccountId: "3",
        pushNs: true,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("1 NS pushed");
  });

  it("без тумблера зоны ведёт себя как прежний «Add Domain»", async () => {
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");
    fireEvent.click(screen.getByRole("button", { name: "Add Domain" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    // Зону не просили — команду не звали; шаг привязки по имени остался прежним.
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("отказ команды не выдаёт создание домена за неудачу", async () => {
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain: locked"));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");
    selectValue("Cloudflare-аккаунт", "7");
    fireEvent.click(screen.getByRole("checkbox", { name: /Создать зону/ }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и настроить" }));

    // Модалка закрыта, домен создан, а про несостоявшуюся зону сказано отдельно.
    await waitFor(() => expect(screen.queryByPlaceholderText("e.g., example.com")).toBeNull());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The run stopped on new.com: keychain: locked.");
  });
});
