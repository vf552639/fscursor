import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { setTauri, secretBlobLifecycle, DESKTOP_NOTE } from "../test/secretBlobKit";

/**
 * Хостинг-провайдер на карточке сервера: видно и можно поправить.
 *
 * «Поправить» здесь — обычная правка сущности, а не путь секретов: провайдер
 * едет полем в PUT, `useSecretSave`/`putSecretBlob` в этом не участвуют. Зато
 * гейт «мутации только в десктопе» участвует — на него отдельный тест внизу.
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

// Тянет argon2/libsodium, к провайдеру отношения не имеет.
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

// Соседи по списку — источник подсказок: имя, уже введённое на другом сервере,
// не должно набираться руками во второй раз (и во второй раз с другой буквы).
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
 * Значение строки «Provider» в карточке Server Information.
 *
 * Кнопки из ячейки значения выбрасываются: у правимых строк `InfoRow` рисует
 * там же карандаш, и его глиф «✎» приклеился бы к значению без разделителя
 * («Hetzner✎»). Убираем сам элемент, а не подчищаем строку от глифа: подгонка
 * ожидания под мусор скрыла бы и настоящий мусор в значении.
 */
function infoRowValue(label: string): string {
  const key = screen.getByText(label);
  const row = key.parentElement as HTMLElement;
  const cell = (row.children[1] as HTMLElement).cloneNode(true) as HTMLElement;
  cell.querySelectorAll("button").forEach((b) => b.remove());
  return (cell.textContent || "").trim();
}

/**
 * Правку открывает карандаш в самой строке «Provider» — по имени действия, а не
 * по глифу: «✎» на этой странице носят ещё три строки карточки и кнопки правки
 * доменов.
 */
async function openProviderForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit Provider" }));
  return (await screen.findByPlaceholderText("e.g., Hetzner")) as HTMLInputElement;
}

describe("ServerDetail — хостинг-провайдер", () => {
  secretBlobLifecycle();

  it("показывает провайдера в карточке сервера", async () => {
    renderDetail();
    await screen.findByText("Provider");
    expect(infoRowValue("Provider")).toBe("Hetzner");
  });

  it("не заполненного показывает прочерком, а не пустотой", async () => {
    renderDetail({ ...SERVER, provider: null });
    await screen.findByText("Provider");
    expect(infoRowValue("Provider")).toBe("—");
  });

  it("правка шлёт ТОЛЬКО провайдера и подставляет текущее значение", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, provider: "AWS" });

    renderDetail();
    const input = await openProviderForm();
    // Пустое поле в форме правки значило бы «стереть» для того, кто просто
    // открыл её посмотреть.
    expect(input.value).toBe("Hetzner");

    fireEvent.change(input, { target: { value: "  AWS  " } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    // Обрезанным: «AWS » дал бы в фильтре второго «того же самого».
    expect(body.provider).toBe("AWS");
    // Ровно одно поле: PUT, тянущий за собой ssh_user/ssh_port из состояния
    // формы, переписал бы их дефолтами — на этой же странице такое уже было.
    expect(Object.keys(body)).toEqual(["provider"]);

    await waitFor(() => expect(screen.queryByPlaceholderText("e.g., Hetzner")).toBeNull());
  });

  it("очищенное поле уезжает как null, а не пустой строкой", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, provider: null });

    renderDetail();
    const input = await openProviderForm();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    // `""` в колонке — это «провайдер есть, и он пустой»: фильтр и подсказки
    // считали бы его отдельным провайдером.
    expect(mocks.apiPut.mock.calls[0][1].provider).toBeNull();
  });

  it("подсказывает провайдеров с других серверов", async () => {
    setTauri(true);
    renderDetail();
    const input = await openProviderForm();
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();
    const list = document.getElementById(listId as string) as HTMLDataListElement;
    expect(Array.from(list.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "AWS",
      "Hetzner",
    ]);
  });

  it("слишком длинное имя не уходит на сервер — 422 в форме нечитаем", async () => {
    setTauri(true);
    renderDetail();
    const input = await openProviderForm();
    // 65 символов — на один больше ширины колонки; литералом, не константой.
    fireEvent.change(input, { target: { value: "x".repeat(65) } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText(/at most 64 characters/)).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("отказ сервера показывает в форме, а форму не закрывает", async () => {
    setTauri(true);
    mocks.apiPut.mockRejectedValue(new Error("provider: value is not a valid string"));

    renderDetail();
    const input = await openProviderForm();
    fireEvent.change(input, { target: { value: "AWS" } });
    fireEvent.click(screen.getByText("Save"));

    // Закрытая форма выглядела бы как «сохранено», а сохранено не было.
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "provider: value is not a valid string",
    );
    expect(screen.getByPlaceholderText("e.g., Hetzner")).toBeTruthy();
  });

  it("в вебе правки нет вовсе — только объяснение", async () => {
    setTauri(false);
    renderDetail();

    // Значение видно (веб read-only), а кнопки правки нет: PUT из браузера —
    // мутация, а мутации живут в десктопе.
    expect(await screen.findByText("Provider")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Provider" })).toBeNull();
    expect(screen.getAllByText(DESKTOP_NOTE).length).toBeGreaterThan(0);
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});
