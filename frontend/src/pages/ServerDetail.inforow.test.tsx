import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { setTauri, secretBlobLifecycle } from "../test/secretBlobKit";
import { desktopOnly } from "../lib/runtime";

/**
 * Правка полей сервера прямо из строк карточки «Server Information».
 *
 * До этого правились только два поля и двумя разными способами: имя — карандашом
 * у заголовка, провайдер — кнопкой «✎ Provider» в шапке карточки (которая ещё и
 * не говорила, какое из девяти полей правит). IP и OS не правились вовсе.
 * Теперь у каждого правимого поля карандаш стоит в его собственной строке.
 *
 * Всё это — обычные поля сущности (одно поле в PUT), а не путь секретов:
 * `useSecretSave`/`putSecretBlob` здесь не участвуют. Гейт «мутации только в
 * десктопе» участвует — на него отдельные тесты.
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

// Тянет argon2/libsodium, к полям карточки отношения не имеет.
vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));

const SERVER = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  os: "Ubuntu" as string | null,
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
  os_pretty: "Ubuntu 22.04" as string | null,
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

/** Строка карточки целиком — по её подписи (`InfoRow`). */
function infoRow(label: string): HTMLElement {
  return screen.getByText(label).parentElement!;
}

/** Шапка карточки «Server Information» — там раньше жила кнопка «✎ Provider». */
function cardHeader(): HTMLElement {
  return screen.getByText("🖥 Server Information").parentElement!;
}

async function openIpForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit IP address" }));
  return (await screen.findByPlaceholderText("e.g., 192.168.1.100")) as HTMLInputElement;
}

async function openOsForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit operating system" }));
  return (await screen.findByRole("combobox")) as HTMLSelectElement;
}

describe("ServerDetail — правка полей из строк карточки", () => {
  secretBlobLifecycle();

  it("в десктопе правимые строки несут карандаш, а измеряемые — нет", async () => {
    setTauri(true);
    renderDetail();
    await screen.findByText("Name");

    // Имена действий, а не глифы: «✎» на странице носят ещё и кнопки правки
    // доменов. «IP address» и «operating system» — словами: аббревиатуры «IP» и
    // «OS» скринридер читает по буквам.
    for (const name of ["Edit Name", "Edit IP address", "Edit Provider", "Edit operating system"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // Аптайм, возраст снимка и дата заведения человеком не правятся: их двигают
    // сбор метрик и сама база, и карандаш обещал бы правку, которой нет.
    for (const label of ["Uptime", "Metrics", "Last check", "Added"]) {
      expect(within(infoRow(label)).queryAllByRole("button")).toEqual([]);
    }
  });

  it("в вебе карандашей нет вовсе — только значения и объяснение", async () => {
    setTauri(false);
    renderDetail();

    // Значения видны (веб read-only), а правки нет: PUT из браузера — мутация,
    // а мутации живут в десктопе.
    expect(await screen.findByText("10.0.0.7")).toBeTruthy();
    for (const name of ["Edit Name", "Edit IP address", "Edit Provider", "Edit operating system"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // Заметка в шапке карточки остаётся: строчных карандашей в вебе нет, и без
    // неё карточка молчала бы о том, почему её значения нередактируемы.
    expect(within(cardHeader()).getByText(desktopOnly("Editing servers"))).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("кнопки «✎ Provider» в шапке карточки больше нет", async () => {
    setTauri(true);
    renderDetail();
    await screen.findByText("Provider");

    // Точка входа переехала в строку: кнопка в заголовке не говорила, какое из
    // девяти полей она правит.
    expect(screen.queryByText("✎ Provider")).toBeNull();
    expect(within(cardHeader()).queryAllByRole("button")).toEqual([]);
  });

  it("карандаш строки Name открывает форму переименования", async () => {
    setTauri(true);
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Name" }));
    // Та же форма, что у карандаша заголовка: второй точке входа не положено
    // заводить вторую форму со своим поведением.
    const input = (await screen.findByPlaceholderText(
      "e.g., production-web-01",
    )) as HTMLInputElement;
    expect(input.value).toBe("srv-7");
  });

  it("карандаш строки Provider открывает форму провайдера", async () => {
    setTauri(true);
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Provider" }));
    const input = (await screen.findByPlaceholderText("e.g., Hetzner")) as HTMLInputElement;
    expect(input.value).toBe("Hetzner");
  });

  it("правка IP шлёт ТОЛЬКО адрес и подставляет текущий", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, ip_address: "10.0.0.9" });

    renderDetail();
    const input = await openIpForm();
    // Пустое поле в форме правки читается как «стереть» тем, кто открыл её
    // просто посмотреть.
    expect(input.value).toBe("10.0.0.7");

    fireEvent.change(input, { target: { value: "  10.0.0.9  " } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    // Обрезанным: пробел в адресе — это адрес, по которому не постучаться.
    expect(body.ip_address).toBe("10.0.0.9");
    // Ровно одно поле: PUT, собранный из всего состояния страницы, переписал бы
    // заодно ssh_user и ssh_port дефолтами SSH-формы.
    expect(Object.keys(body)).toEqual(["ip_address"]);

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("e.g., 192.168.1.100")).toBeNull(),
    );
  });

  it("непохожее на адрес не уходит на сервер", async () => {
    setTauri(true);
    renderDetail();
    const input = await openIpForm();
    fireEvent.change(input, { target: { value: "192.168.один.1" } });
    fireEvent.click(screen.getByText("Save"));

    // Формулировка — та же, что в «Add Server»: требование одно, и объяснять
    // его двумя фразами нельзя.
    expect(await screen.findByText("Invalid IP address format")).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("пустой адрес не уходит на сервер", async () => {
    setTauri(true);
    renderDetail();
    const input = await openIpForm();
    // Пробелы, а не пустая строка: `trim()` делает из них ту же пустоту, и
    // проверка «поле не пустое» их бы пропустила.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("IP address is required")).toBeTruthy();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("IPv6 принимается — у заведённого сервера адрес мог смениться", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, ip_address: "2a01:4f8:c17:b8f::1" });

    renderDetail();
    const input = await openIpForm();
    fireEvent.change(input, { target: { value: "2a01:4f8:c17:b8f::1" } });
    fireEvent.click(screen.getByText("Save"));

    // Форма правки, отвергающая настоящий адрес сервера, оставила бы человека
    // без способа его записать.
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(mocks.apiPut.mock.calls[0][1]).toEqual({ ip_address: "2a01:4f8:c17:b8f::1" });
  });

  it("чужая провалившаяся правка не встречает пользователя в форме адреса", async () => {
    setTauri(true);
    mocks.apiPut.mockRejectedValue(new Error("provider: value is not a valid string"));

    renderDetail();
    // Провайдер сохраняется тем же `useUpdateServer`, что и адрес. Роняем его.
    fireEvent.click(await screen.findByRole("button", { name: "Edit Provider" }));
    fireEvent.change(await screen.findByPlaceholderText("e.g., Hetzner"), {
      target: { value: "AWS" },
    });
    fireEvent.click(screen.getByText("Save"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Cancel"));

    const input = await openIpForm();
    // Форма адреса открывается чистой: ошибка живёт в `ipErr`, а не читается из
    // общего `updateServer.isError` — иначе провал СОСЕДНЕЙ правки встречал бы
    // здесь красным баннером про провайдера, которого никто не трогал.
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(input.value).toBe("10.0.0.7");
  });

  it("отказ сервера показывает в форме адреса, а форму не закрывает", async () => {
    setTauri(true);
    mocks.apiPut.mockRejectedValue(new Error("ip_address: value is not a valid IPv4 address"));

    renderDetail();
    const input = await openIpForm();
    fireEvent.change(input, { target: { value: "10.0.0.9" } });
    fireEvent.click(screen.getByText("Save"));

    // Закрытая форма выглядела бы как «сохранено», а сохранено не было.
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "ip_address: value is not a valid IPv4 address",
    );
    expect(screen.getByPlaceholderText("e.g., 192.168.1.100")).toBeTruthy();
  });

  it("список ОС — те же пять значений, что и в «Add Server»", async () => {
    setTauri(true);
    renderDetail();
    const select = await openOsForm();

    // Литералами, а не импортом `OS_OPTIONS`: это снимок контракта с Rust
    // (`update_command` выбирает по имени пакетный менеджер), а сверка
    // константы с самой собой прошла бы при любом её изменении.
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "Debian",
      "Ubuntu",
      "CentOS",
      "AlmaLinux",
      "Rocky Linux",
    ]);
  });

  it("правка OS шлёт ТОЛЬКО os", async () => {
    setTauri(true);
    mocks.apiPut.mockResolvedValue({ ...SERVER, os: "AlmaLinux" });

    renderDetail();
    const select = await openOsForm();
    fireEvent.change(select, { target: { value: "AlmaLinux" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPut.mock.calls[0];
    expect(url).toBe("/servers/7");
    expect(body.os).toBe("AlmaLinux");
    // Ровно одно поле — тот же довод, что у адреса выше.
    expect(Object.keys(body)).toEqual(["os"]);

    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("легаси-значение с версией не показывает в форме чужую ОС", async () => {
    setTauri(true);
    // Так `os` выглядит у серверов, заведённых до закрытого списка.
    renderDetail({ ...SERVER, os: "Ubuntu 22.04 LTS (x86_64)" });
    const select = await openOsForm();

    // Значение вне опций `<select>` показало бы первый пункт — человек увидел бы
    // «Debian» там, где стоит Ubuntu, и сохранил бы это одним кликом.
    expect(select.value).toBe("Ubuntu");
  });

  it("ручной выбор перекрывает автоопределение и в форме тоже", async () => {
    setTauri(true);
    // Десктоп вычитал по SSH Debian, человек до этого выбрал руками CentOS.
    renderDetail({ ...SERVER, os: "CentOS", os_pretty: "Debian GNU/Linux 12 (bookworm)" });
    const select = await openOsForm();

    expect(select.value).toBe("CentOS");
  });

  it("семейство вне списка — первый пункт как отправная точка, а не молчаливая правка", async () => {
    setTauri(true);
    // Fedora опознаётся (`osShortName`), но пункта под неё в форме нет и не
    // будет — это не серверный дистрибутив.
    renderDetail({ ...SERVER, os: null, os_pretty: "Fedora Linux 39 (Server Edition)" });
    const select = await openOsForm();

    // Показать нечего честнее, но подменить сущность может только явное
    // «Save» — при открытии формы на сервер не уходит ничего.
    expect(select.value).toBe("Debian");
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});
