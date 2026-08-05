import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { b64ToU8 } from "../lib/b64";
import {
  setTauri,
  UUID_V4,
  putBlobArgs,
  putBlobCalls,
  expectBlobsGoneAfterEntity,
  secretBlobLifecycle,
  DESKTOP_NOTE,
} from "../test/secretBlobKit";

/**
 * Правка SSH-доступа — это перезапись СУЩЕСТВУЮЩЕГО блоба: id ведёт сущность, а
 * версии внутри id ведёт сервер. Новый id на правке компилируется, показывает
 * «сохранено» и оставляет сервер со ссылкой на прежний пароль — поэтому тест
 * смотрит именно на `blobId`, уехавший в `vault_put_blob`.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  invokeIfTauri: vi.fn(),
  confirmAction: vi.fn(),
}));

// Вопрос «удалять?» задаёт нативный диалог Tauri, которого в jsdom нет: без
// мока `confirmAction` поймала бы отсутствие плагина и вернула `false` — тест
// проверял бы отказ, а не удаление.
vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
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

const EXISTING_BLOB = "11111111-2222-4333-8444-555555555555";
const NEW_PW = "new-ssh-pw";
const FP_BLOB = "99999999-8888-4777-8666-555555555555";

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
  ssh_password_blob_id: EXISTING_BLOB as string | null,
  // Тип, а не значение: фикстура с паролем панели живёт в тесте на удаление.
  fastpanel_password_blob_id: null as string | null,
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
  secretBlobLifecycle();

  it("правка перезаписывает ТОТ ЖЕ блоб и шлёт только его id", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER });

    renderDetail();
    const pw = await openSshForm("Изменить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

    const blob = putBlobArgs(mocks.invokeIfTauri);
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
    const blob = putBlobArgs(mocks.invokeIfTauri);
    expect(blob.blobId).toMatch(UUID_V4);
    expect(mocks.apiPut.mock.calls[0][1].ssh_password_blob_id).toBe(blob.blobId);
  });

  it("закрытие формы забывает набранный пароль", async () => {
    setTauri(true);

    renderDetail();
    const pw = await openSshForm("Изменить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    // ✕ и клик по оверлею — единственные выходы из формы, Cancel в ней нет.
    // Страница смонтирована всё время, так что незачищенный плейнтекст лежал бы
    // в памяти до ухода с неё.
    fireEvent.click(screen.getByText("✕"));

    const reopened = await openSshForm("Изменить SSH");
    expect(reopened.value).toBe("");
  });

  it("второй клик в окне записи блоба не пишет второй блоб", async () => {
    setTauri(true);
    // Кнопка обязана быть мёртвой всё время записи блоба И сохранения сервера:
    // между ними нет кадра, где оба флага ложны.
    let releaseBlob: () => void = () => {};
    mocks.invokeIfTauri.mockReturnValue(new Promise<void>((r) => { releaseBlob = () => r(); }));
    mocks.apiPut.mockResolvedValue({ ...SERVER });

    renderDetail();
    const pw = await openSshForm("Изменить SSH");
    fireEvent.change(pw, { target: { value: NEW_PW } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1));
    const saving = (await screen.findByText("Saving...")).closest("button") as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    fireEvent.click(saving);

    releaseBlob();
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(1);
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

    expect(await screen.findByText("SSH password is required")).toBeTruthy();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("удаление сервера снимает и его блобы — после самого удаления", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiDelete.mockResolvedValue(undefined);
    const withFp = { ...SERVER, fastpanel_password_blob_id: FP_BLOB };

    renderDetail(withFp);
    fireEvent.click(await screen.findByText("✕ Delete"));

    await expectBlobsGoneAfterEntity({
      apiDelete: mocks.apiDelete,
      invokeIfTauri: mocks.invokeIfTauri,
      url: "/servers/7",
      blobIds: [EXISTING_BLOB, FP_BLOB],
    });
  });

  it.each([
    ["без SSH — баннер", SERVER_NO_SSH, "Добавить SSH"],
    ["с SSH — шапка карточки", SERVER, "Изменить SSH"],
  ])("в вебе (%s) форма не открывается, а объяснение — общей фразой", async (_name, fixture, label) => {
    setTauri(false);
    const { container } = renderDetail(fixture as typeof SERVER);

    expect(await screen.findByText(DESKTOP_NOTE)).toBeTruthy();
    // Не OpenInDesktop: хоста `server-ssh` parseDeepLinkAction не знает —
    // ссылка вела бы в {handled:false} и только тостила бы сама себя.
    expect(container.querySelectorAll('a[href^="sdmp://server-ssh"]').length).toBe(0);
    // И не кнопка: набирать пароль там, где его физически нельзя сохранить,
    // пользователю не предлагаем — объясняем это до ввода, а не после.
    expect(screen.queryByText(label as string)).toBeNull();
    expect(screen.queryByPlaceholderText("••••••••")).toBeNull();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});
