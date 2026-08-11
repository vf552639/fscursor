import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Автопривязка домена к зоне Cloudflare по имени.
 *
 * Проверяется то, что видит пользователь: домен, заведённый в десктопе,
 * оказывается привязанным сам; в вебе тот же ввод работает ровно как раньше и
 * ни в какой Cloudflare не ходит (зон там нет вовсе — их читает Tauri-команда);
 * кнопка по выделенным доменам отчитывается числами, а не молчит.
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

// Тяжёлые соседи страницы, которых этот сценарий не открывает.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

function domainRow(id: number, name: string, cfAccount: number | null = null) {
  return {
    id,
    domain_name: name,
    status: "new",
    registrar_id: null,
    server_id: null,
    cloudflare_account_id: cfAccount,
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

const CF_ACCOUNT = {
  id: 7,
  name: "main",
  account_id: null,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Зоны, которыми отвечает `cf_list_zones`. Имя — в нижнем регистре, как у Cloudflare. */
function zonesAre(zones: Array<{ id: string; name: string }>) {
  mocks.invokeSynced.mockImplementation(async (cmd: string) => {
    if (cmd !== "cf_list_zones") throw new Error(`unexpected command ${cmd}`);
    return zones.map((z) => ({ ...z, name_servers: [], status: "active" }));
  });
}

/**
 * Куда уезжает итог, если страницы уже нет. Тот же приём, что у
 * `onBulkProvisionError`: пока страница жива, отчёт живёт её баннером.
 */
const onNotice = vi.fn();

function renderPage(rows = [domainRow(1, "a.com")]) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [CF_ACCOUNT];
    return {};
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains
        onProvisionResult={vi.fn()}
        onBulkProvisionResult={vi.fn()}
        onBulkProvisionError={vi.fn()}
        onCloudflareBindNotice={onNotice}
      />
    </QueryClientProvider>,
  );
}

/** Завести домен через «+ Add Domain». */
async function addDomain(name: string) {
  fireEvent.click(await screen.findByText("+ Add Domain"));
  const field = await screen.findByPlaceholderText("e.g., example.com");
  fireEvent.change(field, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Add Domain" }));
}

/** Выделить все строки и вернуть кнопку привязки (в вебе её нет). */
async function selectAll(container: HTMLElement) {
  const all = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(all);
  return screen.queryByRole("button", { name: /Match Cloudflare zones/ }) as HTMLButtonElement | null;
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
  mocks.apiPut.mockResolvedValue({});
  mocks.confirmAction.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — автопривязка при создании", () => {
  it("привязывает созданный домен к одноимённой зоне и говорит об этом", async () => {
    setTauri(true);
    zonesAre([{ id: "zone-a", name: "new.com" }]);
    mocks.apiPost.mockResolvedValue(domainRow(9, "New.com"));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("New.com");

    // Регистр ввода значения не имеет: Cloudflare хранит имена зон в нижнем.
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith("/domains/9", {
        cloudflare_account_id: 7,
        cloudflare_zone_id: "zone-a",
      }),
    );
    // Действие изменило данные, не спросив, — значит обязано о себе сказать.
    expect((await screen.findByRole("status")).textContent).toContain("1 of 1 linked");
  });

  it("не перезаписывает домен, которому аккаунт выбрали руками", async () => {
    setTauri(true);
    zonesAre([{ id: "zone-a", name: "new.com" }]);
    // Форма «Add Domain» позволяет выбрать аккаунт CF — и этот выбор чужой.
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com", 42));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPut).not.toHaveBeenCalled();
    // И молчим: сказать «привязано 0 из 0» не о чем.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("привязывает домены, заведённые пачкой", async () => {
    setTauri(true);
    zonesAre([
      { id: "zone-x", name: "x.com" },
      { id: "zone-y", name: "y.com" },
    ]);
    mocks.apiPost.mockResolvedValue({
      created: [domainRow(11, "x.com"), domainRow(12, "y.com"), domainRow(13, "z.com")],
      skipped: [],
    });

    renderPage();
    await screen.findByText("a.com");
    fireEvent.click(screen.getByText("⊕ Bulk Add"));
    fireEvent.change(await screen.findByPlaceholderText(/example.com/), {
      target: { value: "x.com\ny.com\nz.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import Domains" }));

    // Пачка — главный сценарий продукта: сотня доменов заводится разом, и
    // сотня одинаковых кликов «привязать» после этого и есть та работа,
    // которую эта функция убирает.
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(2));
    expect(mocks.apiPut.mock.calls.map((c: any[]) => c[0])).toEqual(["/domains/11", "/domains/12"]);
    expect((await screen.findByRole("status")).textContent).toContain("2 of 3 linked");
  });

  it("провал привязки не выдаёт создание домена за неудачу", async () => {
    setTauri(true);
    zonesAre([{ id: "zone-a", name: "new.com" }]);
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));
    mocks.apiPut.mockRejectedValue(new Error("500 server error"));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");

    // Домен создан — это главный результат, и он состоялся. Модалка закрыта,
    // а про незаписанную привязку сказано отдельной строкой.
    await waitFor(() => expect(screen.queryByText("Add Domain")).toBeNull());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 could not be saved");
  });
});

describe("Domains — автопривязка в вебе", () => {
  it("создание домена не ходит за зонами и не падает", async () => {
    setTauri(false);
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));

    renderPage();
    await screen.findByText("a.com");
    await addDomain("new.com");

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith("/domains", expect.anything()));
    // Зоны живут только в десктопе: в вебе шага привязки нет вовсе — ни
    // команды, ни записи, ни сообщения о том, чего не было.
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("кнопки привязки в вебе нет вовсе", async () => {
    setTauri(false);

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    expect(await selectAll(container)).toBeNull();
    // И ссылки в десктоп тоже: хоста под неё в `parseDeepLinkAction` нет, а
    // ссылка в неразбираемый хост — это тот же 404, который мы только что убрали.
    expect(container.querySelectorAll('a[href^="sdmp://match-cf"]').length).toBe(0);
  });
});

describe("Domains — кнопка «Match Cloudflare zones»", () => {
  it("привязывает выделенные и отчитывается числами", async () => {
    setTauri(true);
    zonesAre([{ id: "zone-a", name: "a.com" }]);

    const { container } = renderPage([
      domainRow(1, "a.com"),
      domainRow(2, "b.com"),
      domainRow(3, "c.com", 42),
    ]);
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(mocks.apiPut).toHaveBeenCalledWith("/domains/1", {
      cloudflare_account_id: 7,
      cloudflare_zone_id: "zone-a",
    });
    // Все три исхода названы: привязали, совпадения нет, уже привязан.
    const notice = (await screen.findByRole("status")).textContent ?? "";
    expect(notice).toContain("1 of 2 linked");
    expect(notice).toContain("1 already linked");
  });

  it("про неоднозначность говорит и ничего не пишет", async () => {
    setTauri(true);
    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === "/domains") return [domainRow(1, "a.com")];
      if (url === "/servers") return { items: [], total: 0 };
      if (url === "/registrars/accounts") return [];
      if (url === "/cloudflare/accounts") return [CF_ACCOUNT, { ...CF_ACCOUNT, id: 9, name: "second" }];
      return {};
    });
    mocks.invokeSynced.mockImplementation(async (_cmd: string, args: any) => [
      {
        id: args.accountId === "7" ? "zone-a" : "zone-x",
        name: "a.com",
        name_servers: [],
        status: "active",
      },
    ]);

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Domains
          onProvisionResult={vi.fn()}
          onBulkProvisionResult={vi.fn()}
          onBulkProvisionError={vi.fn()}
          onCloudflareBindNotice={onNotice}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);

    // Угадав аккаунт, продукт увёл бы домен в чужую зону — а вкладка NS потом
    // прописала бы регистратору её nameservers.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 matched in more than one account");
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("второй клик не запускает второй проход", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    const btn = (await selectAll(container))!;
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Кнопка гаснет на время прогона, но полагаться только на неё нельзя:
    // между двумя кликами в одном тике перерисовки не будет.
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });

  it("не проглатывает автопривязку домена, заведённого во время прогона", async () => {
    setTauri(true);
    let releaseZones: (zones: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { releaseZones = resolve; }));
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com"));

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    await addDomain("new.com");
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    releaseZones([
      { id: "zone-a", name: "a.com", name_servers: [], status: "active" },
      { id: "zone-n", name: "new.com", name_servers: [], status: "active" },
    ]);

    // Гейт «один прогон за раз» — только у кнопки. Распространив его на
    // автопривязку, мы получили бы домен, молча оставшийся без зоны, то есть
    // ровно тот «домен, которому нечем прописать NS», ради которого функция и
    // сделана. Зоны при этом читаются один раз: запрос общий.
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledWith("/domains/9", {
      cloudflare_account_id: 7,
      cloudflare_zone_id: "zone-n",
    }));
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });

  it("не оставляет прежний итог стоять над новым, промолчавшим прогоном", async () => {
    setTauri(true);
    zonesAre([{ id: "zone-a", name: "a.com" }]);

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);
    expect((await screen.findByRole("status")).textContent).toContain("1 of 1 linked");

    // Следующее действие привязывать нечего (аккаунт выбран руками), и в
    // режиме `auto` о таком прогоне не сообщают. Прежняя строка, оставшись на
    // экране, читалась бы как отчёт об этом, последнем действии.
    mocks.apiPost.mockResolvedValue(domainRow(9, "new.com", 42));
    await addDomain("new.com");

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("итог, доехавший после ухода со страницы, уходит наверх, а не пропадает", async () => {
    setTauri(true);
    let releaseZones: (zones: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { releaseZones = resolve; }));

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // На пачке в двести доменов прогон идёт десятками секунд (вычитка зон с
    // пагинацией плюс двести PUT по четыре за раз), и уход со страницы за это
    // время — обычное дело. Привязка изменила данные, НЕ спросив: молчание о
    // ней неотличимо от тихой правки за спиной у пользователя.
    cleanup();
    releaseZones([{ id: "zone-a", name: "a.com", name_servers: [], status: "active" }]);

    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
    expect(onNotice.mock.calls[0][0]).toEqual({
      kind: "info",
      text: "Cloudflare: 1 of 1 linked.",
    });
  });

  it("не гасит соседние массовые действия", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage([domainRow(1, "a.com")]);
    await screen.findByText("a.com");
    fireEvent.click((await selectAll(container))!);

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Assign Server" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Provision" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
