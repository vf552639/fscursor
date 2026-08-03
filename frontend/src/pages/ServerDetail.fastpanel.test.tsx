import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ServerDetail from "./ServerDetail";
import { useAuthStore } from "../store/auth";

/**
 * `POST /servers/{id}/install-fastpanel` НЕ существует на бэкенде и появиться не
 * должен: установка панели лезет по SSH на живой сервер, а это делает только
 * десктоп. Тесты держат обе границы — десктоп зовёт Tauri-команду, веб отдаёт
 * deep link, — и ZK-инвариант: пароль панели не уходит ни в HTTP, ни в storage.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("../api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
  http: { post: vi.fn() },
}));

vi.mock("../lib/localCache", () => ({
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// RevealSecret тянет argon2/libsodium и к установке панели отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 22,
  ssh_user: "root",
  os: "ubuntu-22.04",
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
  os_pretty: "Ubuntu 22.04",
  kernel: null,
  fastpanel_version: null,
  fastpanel_port: null,
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: true,
  last_check_error: null,
};

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function renderDetail(overrides: Partial<typeof SERVER> = {}, onFastpanelCreds?: (c: any) => void) {
  const server = { ...SERVER, ...overrides };
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ServerDetail
          server={{ id: server.id }}
          onBack={() => {}}
          onFastpanelCreds={onFastpanelCreds}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("ServerDetail — Install FastPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  });

  afterEach(() => {
    // vitest без `globals: true` не регистрирует авто-cleanup RTL: без этого
    // предыдущие рендеры остаются в document.body и getByText находит дубли.
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
  });

  it("в десктопе зовёт Tauri-команду install_fastpanel и не ходит по HTTP", async () => {
    setTauri(true);
    mocks.invokeSynced.mockResolvedValue({
      server_id: "7",
      url: "https://10.0.0.7:8888",
      user: "fastuser",
      password: "s3cr3t-panel-pw",
    });

    renderDetail();
    const btn = await screen.findByText("Install FastPanel");
    fireEvent.click(btn);

    await waitFor(() => expect(mocks.invokeSynced).toHaveBeenCalledTimes(1));
    expect(mocks.invokeSynced).toHaveBeenCalledWith("install_fastpanel", {
      userId: "user-1",
      serverId: "7",
      force: false,
    });
    // Ни одного POST: эндпоинта install-fastpanel нет и быть не должно.
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("отдаёт пароль панели наверх и нигде его не сохраняет", async () => {
    setTauri(true);
    const creds = {
      server_id: "7",
      url: "https://10.0.0.7:8888",
      user: "fastuser",
      password: "s3cr3t-panel-pw",
    };
    mocks.invokeSynced.mockResolvedValue(creds);
    const onCreds = vi.fn();

    const { container, client } = renderDetail({}, onCreds);
    fireEvent.click(await screen.findByText("Install FastPanel"));

    await waitFor(() => expect(onCreds).toHaveBeenCalledWith(creds));
    // Показ — задача единственной модалки в DesktopWorkspace; сама страница
    // пароль не рендерит и не оставляет его в storage.
    expect(container.innerHTML).not.toContain("s3cr3t-panel-pw");
    expect(JSON.stringify(localStorage)).not.toContain("s3cr3t-panel-pw");
    expect(JSON.stringify(sessionStorage)).not.toContain("s3cr3t-panel-pw");
    // И не оставляет его в стейте мутации: без reset() react-query держал бы
    // `data` с паролем до размонтирования страницы.
    await waitFor(() => {
      const states = client
        .getMutationCache()
        .getAll()
        .map((m) => m.state);
      expect(JSON.stringify(states)).not.toContain("s3cr3t-panel-pw");
    });
  });

  it("показывает ошибку команды, а не проглатывает её", async () => {
    setTauri(true);
    mocks.invokeSynced.mockRejectedValue(
      new Error("FastPanel already installed on this server (use force to reinstall)"),
    );

    renderDetail();
    fireEvent.click(await screen.findByText("Install FastPanel"));

    expect(
      await screen.findByText(/FastPanel already installed on this server/),
    ).toBeTruthy();
  });

  it("в вебе рендерит deep link sdmp://install-fastpanel и ничего не вызывает", async () => {
    setTauri(false);
    const { container } = renderDetail();
    await waitFor(() =>
      expect(container.querySelector('a[href^="sdmp://install-fastpanel"]')).toBeTruthy(),
    );

    const link = container.querySelector('a[href^="sdmp://install-fastpanel"]');
    expect(link?.getAttribute("href")).toBe("sdmp://install-fastpanel?serverId=7");
    expect(link?.textContent).toContain("Install FastPanel");
    // Кнопки — то есть пути в обход deep link — на вебе нет.
    expect(container.querySelector("button")?.textContent).not.toContain("Install FastPanel");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("не прячет кнопку у сервера, застрявшего в легаси-статусе installing", async () => {
    setTauri(true);
    renderDetail({ fastpanel_status: "installing" });
    expect(await screen.findByText("Install FastPanel")).toBeTruthy();
    // И ни одного опроса несуществующего /fastpanel-status.
    await waitFor(() =>
      expect(
        mocks.apiGet.mock.calls.some((c: any[]) => String(c[0]).includes("fastpanel-status")),
      ).toBe(false),
    );
  });
});
