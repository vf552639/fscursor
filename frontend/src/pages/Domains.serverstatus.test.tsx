import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Состояние сервера в колонке «Server» списка доменов — четвёртый и последний
 * экран, где оно рисуется. Разбор здесь был свой и до `last_check_*` не доходил
 * вовсе (`status === "active" ? "healthy"`), то есть подтверждённо упавшая
 * машина стояла зелёной точкой в списке, на который смотрят чаще, чем на
 * деталь сервера. Тестов на это не было ни одного — потому баг и держался.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
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
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

vi.mock("../components/RevealSecret", () => ({ RevealSecret: () => <span>reveal</span> }));
// Тяжёлые соседи страницы, к колонке сервера отношения не имеющие (см.
// Domains.setns.test.tsx — там та же преамбула и по той же причине).
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const SERVER_BASE = {
  ssh_port: 22,
  ssh_user: "root",
  has_ssh: true,
  os: null,
  os_pretty: null,
  provider: null,
  // Колонка, которую монитор не трогает: у всех фикстур она говорит «active».
  status: "active",
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  fastpanel_version: null,
  fastpanel_port: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  purchase_date: null,
  expiry_date: null,
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
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: null,
  last_check_error: null,
};

const SERVERS = [
  { ...SERVER_BASE, id: 1, name: "srv-alive", ip_address: "10.0.0.1", last_check_at: ago(2 * HOUR), last_check_ok: true },
  {
    ...SERVER_BASE,
    id: 2,
    name: "srv-down",
    ip_address: "10.0.0.2",
    last_check_at: ago(30 * MINUTE),
    last_check_ok: false,
    last_check_error: "timeout after 5s",
  },
  { ...SERVER_BASE, id: 3, name: "srv-new", ip_address: "10.0.0.3" },
  { ...SERVER_BASE, id: 4, name: "srv-quiet", ip_address: "10.0.0.4", last_check_at: ago(3 * DAY), last_check_ok: true },
  // Первый, НЕподтверждённый промах: ошибка записана, статус ещё не упал.
  {
    ...SERVER_BASE,
    id: 5,
    name: "srv-blip",
    ip_address: "10.0.0.5",
    last_check_at: ago(20 * MINUTE),
    last_check_ok: true,
    last_check_error: "timeout after 5s",
  },
];

const domainRow = (id: number, name: string, serverId: number) => ({
  id,
  domain_name: name,
  status: "active",
  registrar_id: null,
  server_id: serverId,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "ok",
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const DOMAINS = SERVERS.map((s, i) => domainRow(100 + i, `${s.name}.com`, s.id));

function renderPage() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return DOMAINS;
    if (url === "/servers") return { items: SERVERS, total: SERVERS.length };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
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
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

/**
 * Ячейка «Server» строки домена. Ищем ВНУТРИ таблицы: имена серверов есть ещё
 * и в пунктах фильтра над ней, и глобальный поиск нашёл бы два совпадения —
 * по той же причине ожидание рендера идёт через `findAllByText`.
 */
function serverCell(serverName: string): HTMLElement {
  const table = screen.getByRole("table");
  const cell = within(table).getByText(serverName).closest("td");
  if (!cell) throw new Error(`сервера «${serverName}» в списке нет`);
  return cell as HTMLElement;
}

/** Подпись имени сервера в строке — на ней висит подсказка с причиной падения. */
function serverLabel(serverName: string): HTMLElement {
  return within(screen.getByRole("table")).getByText(serverName);
}

/** Цвет точки состояния: она без текста, ищем по круглой форме. */
function dotColor(cell: HTMLElement): string {
  const dot = cell.querySelector('span[style*="border-radius: 50%"]') as HTMLElement | null;
  if (!dot) throw new Error("точки состояния в ячейке нет");
  return dot.style.background;
}

const GREEN = "rgb(22, 163, 74)";
const RED = "rgb(220, 38, 38)";
const GRAY = "rgb(156, 163, 175)";

describe("Domains — точка состояния сервера в строке домена", () => {
  beforeEach(() => renderPage());

  it("ответивший сервер зелёный, упавший красный", async () => {
    await screen.findAllByText("srv-alive");
    expect(dotColor(serverCell("srv-alive"))).toBe(GREEN);
    // Колонка `status` у него та же «active» — правду знает только проверка.
    expect(dotColor(serverCell("srv-down"))).toBe(RED);
  });

  it("ни разу не проверенный сервер не зелёный, и это сказано словами", async () => {
    await screen.findAllByText("srv-new");
    expect(dotColor(serverCell("srv-new"))).toBe(GRAY);
    expect(within(serverCell("srv-new")).getByText("never checked")).toBeTruthy();
  });

  it("протухшая проверка перестаёт удерживать зелёную точку", async () => {
    await screen.findAllByText("srv-quiet");
    expect(dotColor(serverCell("srv-quiet"))).toBe(GRAY);
    expect(within(serverCell("srv-quiet")).getByText("checked 3d ago · stale")).toBeTruthy();
  });

  it("возраст свежей проверки подписан рядом с точкой", async () => {
    await screen.findAllByText("srv-alive");
    // Точка без возраста утверждает «сейчас», даже если проверке три месяца.
    expect(within(serverCell("srv-alive")).getByText("checked 2h ago")).toBeTruthy();
  });

  it("причина падения — в подсказке, и только при подтверждённом падении", async () => {
    await screen.findAllByText("srv-down");
    expect(serverLabel("srv-down").getAttribute("title")).toBe("timeout after 5s");
    // Первый промах бэкенд уже записал, но статус не уронил: подсказка с
    // ошибкой на зелёной строке — тот же дефект, что был на списке серверов.
    expect(dotColor(serverCell("srv-blip"))).toBe(GREEN);
    expect(serverLabel("srv-blip").getAttribute("title")).toBeNull();
  });
});
