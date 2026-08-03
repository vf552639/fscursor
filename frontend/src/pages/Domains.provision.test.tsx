import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Provision из строки таблицы. Три отдельные гарантии, которые легко спутать:
 *
 * 1. Опциональная БД достижима из UI: чекбокс диалога доезжает до `invoke`
 *    аргументом `withDb`, причём в обе стороны (включённый и выключенный).
 * 2. Пароли БД и FTP не оседают в MutationCache: `mutationFn` отдаёт их
 *    колбэком, а наружу возвращает только несекретный минимум.
 * 3. Результат не теряется при размонтировании страницы: колбэк захвачен
 *    замыканием `mutationFn`, а не передан per-call через `mutate(…, {onSuccess})`,
 *    который react-query глушит через `hasListeners()`.
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

// Тяжёлые соседи страницы, которых этот сценарий не открывает вовсе. Их деревья
// (crypto, argon2, поллинг задач) к provision отношения не имеют, а импорт стоит
// времени всему прогону — файл и так поднимает страницу целиком.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));
vi.mock("../components/BulkSetupWizard", () => ({ default: () => null }));
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));
vi.mock("../components/TaskProgressModal", () => ({ default: () => null }));
vi.mock("../components/MultiTaskProgressModal", () => ({ default: () => null }));

const DB_PASSWORD = "db-pw-Nx9-secret";
const FTP_PASSWORD = "ftp-pw-Qz4-secret";

const PROVISION_RESULT = {
  domain_id: "42",
  site_user: "example_com",
  site_path: "/var/www/example_com",
  ssl_issued: true,
  db: { db_name: "example_db", db_user: "example_user", db_password: DB_PASSWORD },
  ftp: { ftp_user: "example_ftp", ftp_password: FTP_PASSWORD },
};

function domainRow() {
  return {
    id: 42,
    domain_name: "example.com",
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

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderPage(onProvisionResult: (r: any) => void = vi.fn()) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return [domainRow()];
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  // Страницу рендерим на СИНГЛТОНЕ `queryClient`: именно его инвалидируют хуки
  // и в нём же лежат мутации, за которыми следит `useMutationState`. Со своим
  // клиентом утверждения про кэш мутаций были бы зелены вхолостую.
  const ui = (
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={onProvisionResult} />
    </QueryClientProvider>
  );
  // `remount` — уход со страницы и возврат: тот же клиент, новый `Domains`.
  const remount = () => {
    cleanup();
    return render(ui);
  };
  return { remount, ...render(ui) };
}

/** Открыть диалог provision у единственной строки таблицы. */
async function openProvisionDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Provision domain" }));
  return (await screen.findByLabelText(/Also create a database/i)) as HTMLInputElement;
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
});

afterEach(() => {
  // vitest без `globals: true` не регистрирует авто-cleanup RTL.
  cleanup();
  queryClient.clear();
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("Domains — provision: чекбокс withDb", () => {
  it("с включённым чекбоксом шлёт withDb: true", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);

    renderPage();
    const cb = await openProvisionDialog();
    expect(cb.checked).toBe(false); // БД — осознанный выбор, а не умолчание
    fireEvent.click(cb);
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    // Полная форма аргументов: проверять «вызвано» мало — флаг терялся именно
    // между UI и аргументами.
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_domain", {
      userId: "user-1",
      domainId: "42",
      siteOnly: false,
      withDb: true,
    });
  });

  it("с выключенным чекбоксом шлёт withDb: false", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({ ...PROVISION_RESULT, db: undefined });

    renderPage();
    await openProvisionDialog();
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect(mocks.invokeSynced).toHaveBeenCalledWith("provision_domain", {
      userId: "user-1",
      domainId: "42",
      siteOnly: false,
      withDb: false,
    });
  });

  it("не помнит прошлый выбор: диалог открывается с выключенной БД", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);

    renderPage();
    const cb = await openProvisionDialog();
    fireEvent.click(cb);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const again = await openProvisionDialog();
    expect(again.checked).toBe(false);
  });
});

describe("Domains — provision: пароли", () => {
  it("отдаёт результат наверх и не оставляет паролей в кэше мутаций", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue(PROVISION_RESULT);
    const onResult = vi.fn();

    const { container } = renderPage(onResult);
    const cb = await openProvisionDialog();
    fireEvent.click(cb);
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ domain: "example.com", result: PROVISION_RESULT }),
    );
    // Показывает креды единственная модалка показа-один-раз, которой владеет
    // DesktopWorkspace, — сама страница их не рендерит и не сохраняет.
    expect(container.innerHTML).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(localStorage)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(sessionStorage)).not.toContain(FTP_PASSWORD);
    expect(window.location.href).not.toContain(DB_PASSWORD);

    // `return result` из mutationFn положил бы пароли в `data` MutationCache,
    // откуда их не убирает даже reset(): они жили бы там ещё gcTime.
    await waitFor(() =>
      expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe("success"),
    );
    const states = queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state);
    expect(JSON.stringify(states)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(states)).not.toContain(FTP_PASSWORD);
  });

  it("доставляет результат даже если страницу успели размонтировать", async () => {
    setTauri(true);
    let finish: (r: unknown) => void = () => {};
    mocks.invokeSynced.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onResult = vi.fn();

    renderPage(onResult);
    await openProvisionDialog();
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    // Пользователь ушёл со страницы, пока шёл provision (минуты SSH и certbot).
    cleanup();
    finish(PROVISION_RESULT);

    // Пароли БД и FTP существуют только в этом ответе: на сервере их нет по
    // определению. Потерянный колбэк = потерянные навсегда пароли.
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ domain: "example.com", result: PROVISION_RESULT }),
    );
  });
});

describe("Domains — provision: повторный запуск", () => {
  it("после ухода со страницы и возврата не даёт запустить второй provision", async () => {
    setTauri(true);
    mocks.invokeSynced.mockReturnValue(new Promise(() => {}));

    const { remount } = renderPage();
    await openProvisionDialog();
    fireEvent.click(screen.getByRole("button", { name: "Provision" }));
    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));

    remount();

    // Летящую мутацию новая страница находит по mutationKey в MutationCache:
    // без ключа перемонтированный observer её не видит, и второй клик запустил
    // бы вторую SSH-сессию с create_site/create_ftp_account/certbot.
    const btn = (await screen.findByRole("button", { name: "Provisioning…" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
  });
});

describe("Domains — provision: web", () => {
  it("в вебе отдаёт deep link sdmp://provision и ничего не вызывает", async () => {
    setTauri(false);
    const { container } = renderPage();

    const link = await waitFor(() => {
      const el = container.querySelector('a[href^="sdmp://provision"]');
      expect(el).toBeTruthy();
      return el!;
    });
    // Ровно тот адрес, который умеет разобрать parseDeepLinkAction: у хоста
    // `provision` есть только `domainId`, лишний параметр десктоп молча
    // проглотит — то есть чекбокс в вебе врал бы.
    expect(link.getAttribute("href")).toBe("sdmp://provision?domainId=42");
    expect(screen.queryByRole("button", { name: "Provision domain" })).toBeNull();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(
      mocks.apiPost.mock.calls.some((c: any[]) => String(c[0]).includes("provision")),
    ).toBe(false);
  });
});
