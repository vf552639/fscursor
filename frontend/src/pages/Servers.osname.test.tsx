import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Servers from "./Servers";
import { secretBlobLifecycle } from "../test/secretBlobKit";

/**
 * Имя ОС в списке серверов: короткое и с приоритетом ручного выбора.
 *
 * Оба свойства даёт `serverOsName` (`lib/osName`), и до этих тестов ни одно из
 * них на этом экране не стереглось: возврат ячейки к прежнему
 * `s.os_pretty || s.os || null` — то есть отмена и укорачивания, и приоритета —
 * не красил ни одного теста во всём проекте. Юнит самой функции лежит в
 * `lib/osName.test.ts`; здесь проверяется, что экран её ЗОВЁТ.
 *
 * Проверяются оба представления списка (карточки и таблица): значение считается
 * один раз в `useMemo` страницы, но читают его две разные ветки разметки, и
 * разъехаться они умеют.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// Тянет парсер CSV, к имени ОС отношения не имеет.
vi.mock("../components/ServerBulkImportDialog", () => ({ default: () => null }));

const BLANK = {
  uptime_seconds: null,
  cpu_usage_pct: null,
  cpu_count: null,
  ram_used_mb: null,
  ram_total_mb: null,
  disk_used_gb: null,
  disk_total_gb: null,
  net_in_kbps: null,
  net_out_kbps: null,
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
  status: "active",
  provider: null as string | null,
};

const SERVERS = [
  // Только автоопределение по SSH — во всю длину, как его отдаёт
  // `/etc/os-release`.
  {
    ...BLANK,
    id: 1,
    name: "web-01",
    ip_address: "10.0.0.1",
    os: null as string | null,
    os_pretty: "Ubuntu 22.04.6 LTS (Jammy Jellyfish)",
  },
  // Человек выбрал одно, машина ответила другое. Ровно то состояние, в котором
  // установка FastPanel идёт не тем пакетным менеджером, — и показать список
  // обязан ВЫБОР человека.
  {
    ...BLANK,
    id: 2,
    name: "web-02",
    ip_address: "10.0.0.2",
    os: "CentOS",
    os_pretty: "Ubuntu 22.04.6 LTS (Jammy Jellyfish)",
  },
  // Ни того, ни другого: сервер без SSH, заведённый до появления выбора ОС.
  { ...BLANK, id: 3, name: "web-03", ip_address: "10.0.0.3", os: null, os_pretty: null },
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

/** Ячейка колонки «OS» по имени сервера — индекс колонки берётся из заголовка. */
function osCell(table: HTMLTableElement, serverName: string): string {
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
    (th.textContent || "").trim(),
  );
  const idx = headers.indexOf("OS");
  expect(idx).toBeGreaterThanOrEqual(0);
  const row = Array.from(table.querySelectorAll("tbody tr")).find((tr) =>
    within(tr as HTMLElement).queryByText(serverName),
  );
  if (!row) throw new Error(`строки «${serverName}» в таблице нет`);
  return ((row as HTMLTableRowElement).cells[idx].textContent || "").trim();
}

/** Карточка сервера в представлении «плитки» — по имени сервера. */
function card(serverName: string): HTMLElement {
  return screen.getByText(serverName).closest("div[style*='border-radius']") as HTMLElement;
}

async function showTable(): Promise<HTMLTableElement> {
  fireEvent.click(await screen.findByText("☰ Table"));
  return (await screen.findByRole("table")) as HTMLTableElement;
}

describe("Servers — имя ОС в списке", () => {
  secretBlobLifecycle();

  it("в таблице стоит короткое имя, а не строка из /etc/os-release", async () => {
    renderServers();
    const table = await showTable();

    // «Ubuntu 22.04.6 LTS (Jammy Jellyfish)» в колонке рядом с процентами и
    // гигабайтами — это ширина колонки на полэкрана ради версии, которой на
    // этом экране нечего решать.
    expect(osCell(table, "web-01")).toBe("Ubuntu");
  });

  it("в таблице ручной выбор перекрывает автоопределение", async () => {
    renderServers();
    const table = await showTable();

    // Выбор человека — решение, автоопределение — догадка десктопа (см. JSDoc
    // `serverOsName`). Перевёрнутый приоритет показывал бы Ubuntu там, где
    // пользователь выбрал CentOS.
    expect(osCell(table, "web-02")).toBe("CentOS");
  });

  it("нет ни выбора, ни автоопределения — прочерк, а не пустая ячейка", async () => {
    renderServers();
    const table = await showTable();

    expect(osCell(table, "web-03")).toBe("—");
  });

  it("в карточках — то же имя, что в таблице", async () => {
    renderServers();
    // Плитки — представление по умолчанию, переключать ничего не нужно.
    await screen.findByText("web-01");

    // Бейдж на карточке читает то же вычисленное поле; разъехаться с таблицей он
    // может только если ветка разметки соберёт значение сама.
    expect(within(card("web-01")).getByText("Ubuntu")).toBeTruthy();
    expect(within(card("web-02")).getByText("CentOS")).toBeTruthy();
  });
});
