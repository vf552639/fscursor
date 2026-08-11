import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Кнопка «Provision» панели массовых действий.
 *
 * Она била в `POST /domains/bulk-provision`, которого на бэкенде нет, — то есть
 * всегда возвращала 404, а `apiPost` не Tauri-aware и подменить его нечем.
 * Рабочий путь один и он же у ссылки `sdmp://bulk-provision`: Tauri-команда
 * `provision_bulk` через `runBulkProvisionDomains`.
 *
 * Проверяется ровно то, что ломалось: вызов уходит командой, а не по HTTP;
 * отчёт (в нём пароли FTP каждого домена) доезжает наверх, а не оседает на
 * размонтирующейся странице; отказ запуска произносится словами.
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

// Тяжёлые соседи страницы, которых этот сценарий не открывает вовсе.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const FTP_PASSWORD_1 = "ftp-pw-A1-secret";
const FTP_PASSWORD_2 = "ftp-pw-B2-secret";

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

function doneItem(id: string, password: string) {
  return {
    domain_id: id,
    outcome: "done" as const,
    result: {
      domain_id: id,
      site_user: `site_${id}`,
      site_path: `/var/www/site_${id}`,
      ssl_issued: true,
      ftp: { status: "created" as const, ftp_user: `ftp_${id}`, ftp_password: password },
    },
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderPage(onBulkProvisionResult: (r: any) => void = vi.fn()) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return [domainRow(1, "a.com"), domainRow(2, "b.com")];
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  // Страницу рендерим на СИНГЛТОНЕ `queryClient`: в нём живёт подоменный гейт
  // (`PROVISION_DOMAIN_KEY` в MutationCache), который занимает и читает массовый
  // прогон. Со своим клиентом утверждения про гейт были бы зелены вхолостую.
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={vi.fn()} onBulkProvisionResult={onBulkProvisionResult} />
    </QueryClientProvider>,
  );
}

/** Выделить оба домена шапочным чекбоксом и вернуть кнопку «Provision» тулбара. */
async function selectAllAndFindProvision(container: HTMLElement) {
  await screen.findByText("a.com");
  const all = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(all);
  await screen.findByText("2 selected");
  return screen.getByRole("button", { name: "Provision" }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — массовый provision из тулбара", () => {
  it("зовёт команду provision_bulk, а не несуществующий HTTP-роут", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    // Полная форма аргументов: id команда принимает СТРОКАМИ, а `userId` нужен
    // ей, чтобы расшифровать креды серверов.
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_bulk", {
      userId: "user-1",
      domainIds: ["1", "2"],
    });
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });

  it("отдаёт отчёт наверх и не оставляет паролей ни на странице, ни в кэше мутаций", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));

    // Пароль FTP каждого домена существует ТОЛЬКО в этом ответе: сервер их не
    // знает. Показывает их не страница (она размонтируется при уходе), а
    // очередь показов воркспейса — значит отчёт обязан доехать до пропа целиком.
    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    const outcome = onBulk.mock.calls[0][0];
    expect(outcome.status).toBe("ok");
    expect(outcome.idempotencyKey).toBe("key-1");
    expect(outcome.results.map((r: any) => r.domain)).toEqual(["#1", "#2"]);
    expect(outcome.results[0].result.ftp.ftp_password).toBe(FTP_PASSWORD_1);

    // Путь намеренно не идёт через `mutate`: возврат `mutationFn` осел бы в
    // `data` MutationCache, откуда его не убирает даже `reset()`.
    const cacheDump = JSON.stringify(
      queryClient.getMutationCache().getAll().map((m) => m.state),
    );
    for (const secret of [FTP_PASSWORD_1, FTP_PASSWORD_2]) {
      expect(container.innerHTML).not.toContain(secret);
      expect(cacheDump).not.toContain(secret);
      expect(JSON.stringify(localStorage)).not.toContain(secret);
      expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    }

    // Набор сбрасывается: те же домены во второй раз — это `already_ran`.
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
  });

  it("доставляет отчёт даже если страницу успели размонтировать", async () => {
    setTauri(true);
    let finish: (r: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onBulk = vi.fn();

    const { container } = renderPage(onBulk);
    fireEvent.click(await selectAllAndFindProvision(container));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Прогон идёт минутами на КАЖДЫЙ домен — уход со страницы за это время
    // обычное дело. Отчёт уезжает наверх прямым вызовом пропа, а не через
    // per-call коллбэк мутации, который react-query глушит при размонтировании.
    cleanup();
    finish({
      idempotency_key: "key-1",
      status: "ok",
      items: [doneItem("1", FTP_PASSWORD_1), doneItem("2", FTP_PASSWORD_2)],
    });

    await waitFor(() => expect(onBulk).toHaveBeenCalledTimes(1));
    expect(onBulk.mock.calls[0][0].results).toHaveLength(2);
  });

  it("показывает отказ запуска, а не проглатывает его", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage();
    const btn = await selectAllAndFindProvision(container);
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Гейт подоменный и живёт в MutationCache: пока первый прогон висит, второй
    // по тем же доменам не стартует. Молчащая кнопка неотличима от сломанной —
    // текст обязан доехать до пользователя.
    cleanup();
    const second = renderPage();
    fireEvent.click(await selectAllAndFindProvision(second.container));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already running/i);
    expect(alert.textContent).toMatch(/#1/);
    // И по SSH второй раз никто не пошёл.
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });

  it("без userId не зовёт команду и говорит почему", async () => {
    setTauri(true);
    useAuthStore.getState().clear();

    const { container } = renderPage();
    fireEvent.click(await selectAllAndFindProvision(container));

    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in/i);
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });
});

describe("Domains — массовый provision: веб", () => {
  it("отдаёт deep link sdmp://bulk-provision и ничего не исполняет", async () => {
    setTauri(false);

    const { container } = renderPage();
    await screen.findByText("a.com");
    const all = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(all);
    await screen.findByText("2 selected");

    const link = container.querySelector('a[href^="sdmp://bulk-provision"]');
    expect(link?.getAttribute("href")).toBe("sdmp://bulk-provision?ids=1,2");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });

  it("не предлагает Refresh SSL и Full Setup — роутов под ними нет", async () => {
    for (const tauri of [false, true]) {
      setTauri(tauri);
      const { container, unmount } = renderPage();
      await screen.findByText("a.com");
      fireEvent.click(container.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
      await screen.findByText("2 selected");

      // `POST /domains/{id}/refresh-ssl` и `/domains/bulk-full-setup` на бэкенде
      // не существуют, а `sdmp://refresh-ssl` и `sdmp://bulk-full-setup` не
      // разбирает parseDeepLinkAction — обе кнопки вели в никуда в обеих средах.
      expect(screen.queryByText("Refresh SSL")).toBeNull();
      expect(screen.queryByText("Full Setup")).toBeNull();
      expect(container.querySelectorAll('a[href^="sdmp://refresh-ssl"]').length).toBe(0);
      expect(container.querySelectorAll('a[href^="sdmp://bulk-full-setup"]').length).toBe(0);
      unmount();
    }
  });
});
