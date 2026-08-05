import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { runSshTest } from "../api/servers";
import { u8ToB64 } from "../lib/b64";
import { setTauri, secretBlobLifecycle, BLOB_USER_ID } from "../test/secretBlobKit";

/**
 * «SSH Test» — первая точка входа во `vault_decrypt_blob` из фронта. Проверяем
 * не «мутация отработала», а весь путь секрета: блоб → плейнтекст → `ssh_exec`
 * → и обратно в никуда. Последнее — половина смысла файла: пароль от живого
 * сервера не должен осесть ни в кэше мутаций (react-query держит `variables` и
 * `data` ещё gcTime после `reset()`), ни в DOM, ни в хранилищах браузера.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

// Мокаем транспорт, а не `secretBlob`/`sshHostKey`: сборка аргументов команд
// (camelCase, id блоба, host/port/user) — часть проверяемого пути.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const SSH_BLOB = "11111111-2222-4333-8444-555555555555";
const SSH_PW = "s3cret-ssh-pw";

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
  ssh_password_blob_id: SSH_BLOB as string | null,
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

// `has_ssh` на бэкенде и есть `ssh_password_blob_id is not None` — фикстура без
// секрета обязана быть без обоих, иначе она учила бы состоянию, которого нет.
const SERVER_NO_SSH = { ...SERVER, has_ssh: false, ssh_password_blob_id: null };

function renderDetail(server: typeof SERVER = SERVER) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/domains") return [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ServerDetail server={{ id: server.id }} onBack={() => {}} onFastpanelCreds={() => {}} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Аргументы единственного вызова команды. */
function argsOf(cmd: string): Record<string, any> {
  const calls = mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === cmd);
  if (calls.length !== 1) throw new Error(`${cmd} вызвана ${calls.length} раз, ожидался 1`);
  return calls[0][1] as Record<string, any>;
}

function sshOk(pw = SSH_PW) {
  mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
    if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(pw));
    if (cmd === "ssh_exec") return [0, "sdmp-ssh-ok\n"];
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe("ServerDetail — SSH Test через десктоп", () => {
  secretBlobLifecycle();

  it("расшифровывает блоб и идёт по SSH этим паролем, не оставляя его нигде", async () => {
    setTauri(true);
    sshOk();

    const { client } = renderDetail();
    fireEvent.click(await screen.findByText("SSH Test"));

    expect(await screen.findByText(/deploy@10\.0\.0\.7:2222 responded/)).toBeTruthy();

    // camelCase: с `user_id`/`blob_id` команда падает «invalid args».
    expect(argsOf("vault_decrypt_blob")).toEqual({ userId: BLOB_USER_ID, blobId: SSH_BLOB });
    const exec = argsOf("ssh_exec");
    expect(exec.host).toBe("10.0.0.7");
    expect(exec.port).toBe(2222);
    expect(exec.user).toBe("deploy");
    expect(exec.password).toBe(SSH_PW);
    // Литерал, а НЕ импортированная `SSH_TEST_COMMAND`: сверка константы с
    // самой собой — тавтология, при которой `rm -rf /tmp/x; echo sdmp-ssh-ok`
    // проезжает зелёным на живой сервер. Команда — часть контракта («безобидная»
    // = ничего не меняющая), и записана она здесь ровно один раз.
    expect(exec.command).toBe("echo sdmp-ssh-ok");

    // Пароль живёт ровно до вызова. Кэш мутаций — главный подозреваемый:
    // `variables` и `data` он держит ещё gcTime и после `reset()`.
    const cache = JSON.stringify(client.getMutationCache().getAll().map((m) => m.state));
    expect(cache).not.toContain(SSH_PW);
    expect(document.body.textContent ?? "").not.toContain(SSH_PW);
    expect(JSON.stringify(localStorage)).not.toContain(SSH_PW);
    expect(JSON.stringify(sessionStorage)).not.toContain(SSH_PW);
  });

  it("упавший коннект показывает причину, а не молчит", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      // Так выглядит ошибка команды после разворачивания в `formatInvokeError`.
      throw new Error("api: ssh: connect: connection refused");
    });

    renderDetail();
    fireEvent.click(await screen.findByText("SSH Test"));

    expect(await screen.findByText(/connection refused/)).toBeTruthy();
  });

  it("ненулевой код возврата — это не успех", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      return [127, "sh: echo: not found"];
    });

    renderDetail();
    fireEvent.click(await screen.findByText("SSH Test"));

    expect(await screen.findByText(/exit 127/)).toBeTruthy();
  });

  it("нулевой код без нашего маркера успехом не считается", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      // Так выглядит оборванный канал: `ssh_exec` отдаёт код `-1`, когда сервер
      // закрыл его, не прислав ExitStatus (ssh/client.rs), а на пустой строке и
      // `0` ничего не доказывает. Отличить «связь есть» от «канал схлопнулся»
      // можно только по вернувшейся строке.
      return [0, ""];
    });

    renderDetail();
    fireEvent.click(await screen.findByText("SSH Test"));

    const banner = await screen.findByText(/SSH Test:/);
    expect(banner.textContent).toMatch(/no output/);
    expect(banner.textContent).not.toMatch(/responded/);
  });

  it("в вебе кнопки нет — вместо неё общая фраза продукта", async () => {
    setTauri(false);
    renderDetail();

    expect(await screen.findByText("Testing SSH runs in the SDMP desktop app.")).toBeTruthy();
    expect(screen.queryByText("SSH Test")).toBeNull();
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("у сервера без пароля кнопки нет, а причина названа баннером", async () => {
    setTauri(true);
    renderDetail(SERVER_NO_SSH);

    expect(await screen.findByText(/SSH-доступ не настроен/)).toBeTruthy();
    expect(screen.queryByText("SSH Test")).toBeNull();
    await waitFor(() => expect(screen.getByText("Добавить SSH")).toBeTruthy());
  });
});

describe("runSshTest — отказы до выхода на сервер", () => {
  secretBlobLifecycle();

  /**
   * Функция экспортирована, и звать её из веба будет не только кнопка, которой
   * там нет. Запрет должен стоять в САМОЙ функции и объясняться её же словами:
   * без него отказ приезжал бы из `readSecretBlob` («Reading secrets…»), то
   * есть пользователь читал бы про чтение секретов вместо проверки SSH.
   */
  it("в вебе не выполняется вовсе и объясняет это фразой про SSH", async () => {
    setTauri(false);

    await expect(
      runSshTest({
        ip_address: "10.0.0.7",
        ssh_port: 22,
        ssh_user: "root",
        ssh_password_blob_id: SSH_BLOB,
      }),
    ).rejects.toThrow("Testing SSH runs in the SDMP desktop app.");
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  /**
   * Такого сервера кнопка не показывает (`has_ssh` = «блоб есть»), но тип поля
   * nullable, и путь достижим из любого нового места вызова. Внятная фраза
   * здесь — вместо `vault_decrypt_blob(blobId: undefined)` и «invalid args» на
   * экране.
   */
  it("объясняет, что пароль не задан, и никуда не ходит", async () => {
    setTauri(true);

    await expect(
      runSshTest({ ip_address: "10.0.0.7", ssh_port: 22, ssh_user: "root", ssh_password_blob_id: null }),
    ).rejects.toThrow(/no SSH password/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });
});
