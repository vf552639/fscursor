import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Servers from "./Servers";
import { setTauri, secretBlobLifecycle, putBlobCalls } from "../test/secretBlobKit";

/**
 * Хостинг-провайдер на странице серверов: подсказки в форме, колонка в таблице,
 * фильтр.
 *
 * Страница рендерится целиком, а не одна `AddServerModal`: подсказки формы
 * берутся из уже загруженного списка серверов, и «модалка умеет их показать»
 * ничего не значит, если страница их ей не передаёт. Проверяется именно связка.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// Тянет парсер CSV, к провайдеру отношения не имеет.
vi.mock("../components/ServerBulkImportDialog", () => ({ default: () => null }));

const BLANK_METRICS = {
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
  os_pretty: null,
  kernel: null,
  fastpanel_version: null,
  fastpanel_port: null,
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: true,
  last_check_error: null,
  has_ssh: true,
  ssh_port: 22,
  ssh_user: "root",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  purchase_date: null,
  expiry_date: null,
  status: "active",
  os: "Ubuntu 22.04",
};

const SERVERS = [
  { ...BLANK_METRICS, id: 1, name: "web-01", ip_address: "10.0.0.1", provider: "Hetzner" },
  { ...BLANK_METRICS, id: 2, name: "web-02", ip_address: "10.0.0.2", provider: "AWS" },
  // Провайдер не указан — законное состояние, поле необязательное.
  { ...BLANK_METRICS, id: 3, name: "web-03", ip_address: "10.0.0.3", provider: null },
  // Дубль имени: в подсказках и в фильтре провайдер обязан быть один.
  { ...BLANK_METRICS, id: 4, name: "web-04", ip_address: "10.0.0.4", provider: "Hetzner" },
  // Хвостовой пробел: сегодня схема такое обрезает при записи, но значение
  // приезжает с сервера, а не из нашей формы, и «AWS » не должно ни плодить
  // второй пункт в фильтре, ни выпадать из выборки по «AWS».
  { ...BLANK_METRICS, id: 5, name: "web-05", ip_address: "10.0.0.5", provider: "AWS " },
];

function renderServers() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/servers") return { items: SERVERS, total: SERVERS.length };
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Servers onNav={() => {}} />
    </QueryClientProvider>,
  );
}

async function showTable() {
  fireEvent.click(await screen.findByText("☰ Table"));
  return (await screen.findByRole("table")) as HTMLTableElement;
}

/** Ячейка строки по ЗАГОЛОВКУ колонки: индекс, вбитый числом, переживёт её удаление. */
function cellByHeader(table: HTMLTableElement, rowName: string, header: string): string {
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
    (th.textContent || "").trim(),
  );
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  const row = Array.from(table.querySelectorAll("tbody tr")).find((tr) =>
    within(tr as HTMLElement).queryByText(rowName),
  );
  if (!row) throw new Error(`строки «${rowName}» в таблице нет`);
  return ((row as HTMLTableRowElement).cells[idx].textContent || "").trim();
}

function tableNames(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll("tbody tr"))
    // В ячейке имени сидит ещё и подпись под ним, поэтому вытаскиваем имя, а не
    // берём весь текст ячейки.
    .map((tr) => ((tr as HTMLTableRowElement).cells[0]?.textContent || "").match(/web-\d+/)?.[0])
    .filter((n): n is string => Boolean(n));
}

function providerFilter() {
  return screen.getByLabelText("Filter by hosting provider") as HTMLSelectElement;
}

function fillProvider(value: string) {
  fireEvent.change(screen.getByPlaceholderText("e.g., Hetzner"), { target: { value } });
}

describe("Servers — колонка и фильтр по провайдеру", () => {
  secretBlobLifecycle();
  // После `vi.resetAllMocks` из `secretBlobLifecycle` — иначе `apiGet` остался
  // бы без реализации и страница не дождалась бы списка.
  beforeEach(() => renderServers());

  it("показывает провайдера в колонке, а его отсутствие — прочерком", async () => {
    const table = await showTable();
    expect(cellByHeader(table, "web-01", "Provider")).toBe("Hetzner");
    // Пустая ячейка выглядела бы как «данные не доехали»; прочерк — как у OS.
    expect(cellByHeader(table, "web-03", "Provider")).toBe("—");
  });

  it("фильтр знает только встречающиеся имена, каждое по разу", async () => {
    await screen.findByText("web-01");
    const options = Array.from(providerFilter().options);
    // Первый — «все»: без него из фильтра нет выхода. Его значение — пустая
    // строка, а не «All»: провайдер с именем «All» иначе показывал бы всех.
    expect(options[0].value).toBe("");
    expect(options[0].textContent).toContain("All");
    expect(options.slice(1).map((o) => o.value)).toEqual(["AWS", "Hetzner"]);
  });

  it("выбор провайдера сужает список, «All» возвращает всех", async () => {
    const table = await showTable();
    fireEvent.change(providerFilter(), { target: { value: "Hetzner" } });
    expect(tableNames(table)).toEqual(["web-01", "web-04"]);

    // Значение с хвостовым пробелом ловится тем же пунктом, а не выпадает.
    fireEvent.change(providerFilter(), { target: { value: "AWS" } });
    expect(tableNames(table)).toEqual(["web-02", "web-05"]);

    fireEvent.change(providerFilter(), { target: { value: "" } });
    expect(tableNames(table)).toEqual(["web-01", "web-02", "web-03", "web-04", "web-05"]);
  });

  it("фильтр складывается с поиском, а не подменяет его", async () => {
    // Оба условия живут в одной цепочке `filtered`: заведи провайдер вторую,
    // и поиск с фильтром показывали бы разные списки.
    const table = await showTable();
    fireEvent.change(providerFilter(), { target: { value: "Hetzner" } });
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "web-04" } });
    expect(tableNames(table)).toEqual(["web-04"]);

    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "web-02" } });
    // web-02 существует, но он AWS — пересечение пустое.
    expect(tableNames(table)).toEqual([]);
    expect(screen.getByText("No servers match the current filters.")).toBeTruthy();
  });

  it("в карточке grid провайдер стоит рядом с IP", async () => {
    // Фильтр работает в обоих видах, и в grid по нему тоже надо понимать,
    // почему сервер остался на экране.
    expect(await screen.findByText("10.0.0.1 · Hetzner")).toBeTruthy();
    expect(screen.getByText("10.0.0.3")).toBeTruthy();
  });
});

describe("AddServerModal — поле провайдера", () => {
  secretBlobLifecycle();

  async function openModal() {
    setTauri(true);
    renderServers();
    fireEvent.click(await screen.findByText("+ Add Server"));
    await screen.findByPlaceholderText("e.g., production-web-01");
  }

  function fillForm() {
    fireEvent.change(screen.getByPlaceholderText("e.g., production-web-01"), {
      target: { value: "srv-new" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g., 192.168.1.100"), {
      target: { value: "10.0.0.9" },
    });
    fireEvent.change(screen.getByPlaceholderText("••••••••"), { target: { value: "pw" } });
  }

  it("подсказывает уже введённых провайдеров", async () => {
    await openModal();

    const input = screen.getByPlaceholderText("e.g., Hetzner") as HTMLInputElement;
    // Именно привязка `list` → `<datalist>`: нарисованный, но не привязанный
    // список подсказок не показывает вовсе.
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();
    const list = document.getElementById(listId as string) as HTMLDataListElement;
    expect(Array.from(list.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "AWS",
      "Hetzner",
    ]);
  });

  it("сохраняет провайдера", async () => {
    mocks.apiPost.mockResolvedValue({ id: 9 });
    await openModal();
    fillForm();
    fillProvider("  Hetzner  ");
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    // Обрезанным: «Hetzner » дал бы в фильтре второго «того же самого».
    expect(mocks.apiPost.mock.calls[0][1].provider).toBe("Hetzner");
  });

  it("пустое поле уезжает как null, а не пустой строкой", async () => {
    mocks.apiPost.mockResolvedValue({ id: 9 });
    await openModal();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    // `""` в колонке означал бы «провайдер есть, и он пустой».
    expect(mocks.apiPost.mock.calls[0][1].provider).toBeNull();
  });

  it("слишком длинное имя ловится ДО записи блоба", async () => {
    await openModal();
    fillForm();
    // 65 символов — на один больше ширины колонки. Литералом, а не через
    // константу: сверка константы с самой собой зеленела бы при любой границе.
    fillProvider("x".repeat(65));
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));

    expect(await screen.findByText(/at most 64 characters/)).toBeTruthy();
    // Порядок «блоб → сервер»: провал ПОСЛЕ записи блоба оставил бы в хранилище
    // секрет, на который никто не ссылается.
    expect(putBlobCalls(mocks.invokeIfTauri).length).toBe(0);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
