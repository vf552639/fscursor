import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore } from "../store/auth";

/**
 * Правка SSH-доступа — это перезапись СУЩЕСТВУЮЩЕГО блоба: id ведёт сущность, а
 * версии внутри id ведёт сервер. Новый id на правке компилируется, показывает
 * «сохранено» и оставляет сервер со ссылкой на прежний пароль — поэтому тест
 * смотрит именно на `blobId`, уехавший в `vault_put_blob`.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

// Транспорт, а не `secretBlob`: см. Servers.sshblob.test.tsx.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium и к правке SSH отношения не имеет.
vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXISTING_BLOB = "11111111-2222-4333-8444-555555555555";
const NEW_PW = "new-ssh-pw";

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  os: "ubuntu-22.04",
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: EXISTING_BLOB,
  fastpanel_password_blob_id: null,
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

// Сервер без секрета: `has_ssh` на бэкенде и есть `ssh_password_blob_id is not
// None`, поэтому «нет SSH» обязано означать пустой blob_id — иначе фикстура
// учила бы состоянию, которого не бывает.
const SERVER_NO_SSH = { ...SERVER, has_ssh: false, ssh_password_blob_id: null };

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function putBlobArgs(): Record<string, any> {
  const calls = mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "vault_put_blob");
  if (calls.length !== 1) throw new Error(`vault_put_blob вызвана ${calls.length} раз, ожидался 1`);
  return calls[0][1] as Record<string, any>;
}

function renderDetail(server: typeof SERVER | typeof SERVER_NO_SSH = SERVER) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ServerDetail server={{ id: server.id }} onBack={() => {}} onFastpanelCreds={() => {}} />
    </QueryClientProvider>,
  );
}

async function openSshForm(label: string) {
  fireEvent.click(await screen.findByText(label));
  return (await screen.findByPlaceholderText("••••••••")) as HTMLInputElement;
}

describe("ServerDetail — SSH-пароль через блоб", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
    useAuthStore.getState().clear();
  });

  it("правка перезаписывает ТОТ ЖЕ блоб и шлёт только его id", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER });

    renderDetail();
    const pw = await openSshForm("Изменить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs();
    // Новый id здесь = сущность продолжает указывать на старый пароль.
    expect(blob.blobId).toBe(EXISTING_BLOB);
    expect(blob.blobKind).toBe("server_ssh_password");
    expect(new TextDecoder().decode(b64ToU8(blob.plaintextB64))).toBe(NEW_PW);

    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    expect(body.ssh_password_blob_id).toBe(EXISTING_BLOB);
    expect(body).not.toHaveProperty("ssh_password");
    expect(JSON.stringify(body)).not.toContain(NEW_PW);
    // Поля берутся у сервера, а не из дефолтов формы: иначе правка пароля
    // заодно переписала бы пользователя на "root" и порт на 22.
    expect(body.ssh_user).toBe("deploy");
    expect(body.ssh_port).toBe(2222);

    // Модалка закрылась — плейнтекст в форме не остался.
    await waitFor(() => expect(screen.queryByPlaceholderText("••••••••")).toBeNull());
  });

  it("первому SSH-паролю выдаёт новый blob_id", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER });

    renderDetail(SERVER_NO_SSH);
    const pw = await openSshForm("Добавить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const blob = putBlobArgs();
    expect(blob.blobId).toMatch(UUID_V4);
    expect(mocks.apiPut.mock.calls[0][1].ssh_password_blob_id).toBe(blob.blobId);
  });

  it("упавшая запись блоба не трогает сервер и показывает ошибку", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockRejectedValue(new Error("keychain locked"));

    renderDetail();
    const pw = await openSshForm("Изменить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    fireEvent.click(screen.getByText("Save"));

    // PUT со ссылкой на несуществующий блоб — это 200 OK и мёртвый SSH.
    expect(await screen.findByText(/keychain locked/)).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("пустой пароль не пишет блоб из нуля байт", async () => {
    setTauri(true);

    renderDetail(SERVER_NO_SSH);
    await openSshForm("Добавить SSH");
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Введите SSH-пароль")).toBeTruthy();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("в вебе форма не открывается вовсе — только deep link в десктоп", async () => {
    setTauri(false);
    const { container } = renderDetail(SERVER_NO_SSH);

    const link = (await waitFor(() => {
      const a = container.querySelector('a[href^="sdmp://server-ssh"]');
      expect(a).toBeTruthy();
      return a;
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("sdmp://server-ssh?serverId=7");
    expect(link.textContent).toContain("Добавить SSH");

    // Кнопки — то есть пути в обход десктопа — нет: набирать пароль там, где
    // его физически нельзя сохранить, пользователю не предлагаем.
    fireEvent.click(link);
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});
