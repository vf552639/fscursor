import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { setTauri, secretBlobLifecycle } from "../test/secretBlobKit";
import { desktopOnly } from "../lib/runtime";

/**
 * Переименование сервера с его же карточки. Имя задавалось один раз в «Add
 * Server» и после этого было неисправимо: опечатка в названии оставалась с
 * сервером навсегда.
 *
 * Как и правка провайдера, это обычная правка сущности (поле в PUT), а не путь
 * секретов — `useSecretSave`/`putSecretBlob` здесь не участвуют. Гейт «мутации
 * только в десктопе» участвует: на него отдельный тест внизу.
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

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тянет argon2/libsodium, к имени сервера отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  os: "ubuntu-22.04",
  provider: "Hetzner" as string | null,
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: "11111111-2222-4333-8444-555555555555" as string | null,
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

const OTHER = { ...SERVER, id: 8, name: "srv-8", provider: "AWS" };

function renderDetail(server: typeof SERVER = SERVER) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/servers") return { items: [server, OTHER], total: 2 };
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

/**
 * Карандаш у заголовка — по имени действия, а не по глифу: «✎» на этой
 * странице носят ещё и кнопки правки доменов, и поиск по тексту начал бы
 * находить несколько кнопок, стоило появиться первому домену.
 */
async function openRenameForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Rename server" }));
  return (await screen.findByPlaceholderText("e.g., production-web-01")) as HTMLInputElement;
}

/**
 * Левый блок шапки — тот, где имя сервера. Утверждения про веб-ветку меряются
 * им, а не всей страницей: заметка «Editing servers» есть и в карточке Server
 * Information, и поиск по документу проходил бы, даже если у имени не осталось
 * ВООБЩЕ ничего.
 */
function headerBlock(): HTMLElement {
  return screen.getByRole("heading", { name: "srv-7" }).parentElement!.parentElement!;
}

describe("ServerDetail — переименование сервера", () => {
  secretBlobLifecycle();

  it("правка шлёт ТОЛЬКО имя и подставляет текущее", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, name: "new-name" });

    renderDetail();
    const input = await openRenameForm();
    // Пустое поле в форме правки читается как «стереть» тем, кто открыл её
    // просто посмотреть.
    expect(input.value).toBe("srv-7");

    fireEvent.change(input, { target: { value: "  new-name  " } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    // Обрезанным: «new-name » и «new-name» — два разных имени в списке серверов.
    expect(body.name).toBe("new-name");
    // Ровно одно поле: PUT, собранный из всего состояния страницы, переписал бы
    // заодно ssh_user и ssh_port дефолтами формы SSH.
    expect(Object.keys(body)).toEqual(["name"]);

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("e.g., production-web-01")).toBeNull(),
    );
  });

  it("пустое имя не уходит на сервер", async () => {
    setTauri(true);
    renderDetail();
    const input = await openRenameForm();
    // Пробелы, а не пустая строка: `trim()` делает из них ту же пустоту, и
    // проверка «поле не пустое» их бы пропустила.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Server name is required")).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("отказ сервера показывает в форме, а форму не закрывает", async () => {
    setTauri(true);
    mocks.apiPut.mockRejectedValue(new Error("name: String should have at most 128 characters"));

    renderDetail();
    const input = await openRenameForm();
    fireEvent.change(input, { target: { value: "x".repeat(200) } });
    fireEvent.click(screen.getByText("Save"));

    // Закрытая форма выглядела бы как «сохранено», а сохранено не было.
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "name: String should have at most 128 characters",
    );
    expect(screen.getByPlaceholderText("e.g., production-web-01")).toBeTruthy();
  });

  it("в вебе правки нет вовсе — только объяснение", async () => {
    setTauri(false);
    renderDetail();

    // Имя видно (веб read-only), а карандаша нет: PUT из браузера — мутация, а
    // мутации живут в десктопе.
    expect(await screen.findByRole("heading", { name: "srv-7" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename server" })).toBeNull();
    // Именно у имени, а не где-нибудь на странице: молча исчезнувшая заметка
    // оставила бы веб-пользователя перед нередактируемым именем без единого
    // слова о том, почему. Формулировка — общая `desktopOnly`, чтобы экран не
    // сочинил своей.
    expect(within(headerBlock()).getByText(desktopOnly("Editing servers"))).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("чужая провалившаяся правка не встречает пользователя в форме имени", async () => {
    setTauri(true);
    mocks.apiPut.mockRejectedValue(new Error("provider: value is not a valid string"));

    renderDetail();
    // Провайдер сохраняется тем же `useUpdateServer`, что и имя. Роняем его.
    fireEvent.click(await screen.findByRole("button", { name: "Edit Provider" }));
    fireEvent.change(await screen.findByPlaceholderText("e.g., Hetzner"), {
      target: { value: "AWS" },
    });
    fireEvent.click(screen.getByText("Save"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Cancel"));

    const input = await openRenameForm();
    // Форма имени открывается чистой: ошибка живёт в `nameErr`, а не читается
    // из общего `updateServer.isError` — иначе провал СОСЕДНЕЙ правки встречал
    // бы здесь красным баннером про провайдера, которого никто не трогал.
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(input.value).toBe("srv-7");
  });
});
