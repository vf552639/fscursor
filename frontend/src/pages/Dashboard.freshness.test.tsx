import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Dashboard from "./Dashboard";
import { hexToRgb } from "../test/colors";
import { STALE_TEXT } from "../components/ui/Primitives";

/**
 * Дашборд — первый экран приложения, и до этих правок он был самым громким
 * источником неправды: статус сервера он выводил из колонки `status`, которой
 * монитор не касается вовсе. Подтверждённо упавшая машина светилась там зелёной
 * точкой, бейджем «healthy» и считалась в плитке «Healthy: N».
 *
 * Файл держит ровно это: счётчики и строки говорят о том, что мы знаем, а
 * показания подписаны своим возрастом.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

// Размонтирование между тестами: без него второй рендер дашборда живёт рядом с
// первым, и `getByText` находит два экрана вместо одного.
afterEach(() => cleanup());

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const BASE = {
  ssh_port: 22,
  ssh_user: "root",
  has_ssh: true,
  os: "Ubuntu 22.04",
  os_pretty: null,
  provider: null,
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

const READINGS = {
  uptime_seconds: 3 * 86400,
  cpu_usage_pct: 42,
  cpu_count: 2,
  ram_used_mb: 2048,
  ram_total_mb: 4096,
  disk_used_gb: 30,
  disk_total_gb: 80,
};

const SERVERS = [
  // Отвечает, снимок свежий.
  {
    ...BASE,
    ...READINGS,
    id: 1,
    name: "web-01",
    ip_address: "10.0.0.1",
    last_check_at: ago(2 * HOUR),
    last_check_ok: true,
    metrics_collected_at: ago(12 * MINUTE),
  },
  // Подтверждённо упал — но в колонке `status` по-прежнему «active».
  {
    ...BASE,
    id: 2,
    name: "web-02",
    ip_address: "10.0.0.2",
    last_check_at: ago(30 * MINUTE),
    last_check_ok: false,
    last_check_error: "timeout after 5s",
  },
  // Ни разу не проверялся.
  { ...BASE, id: 3, name: "web-03", ip_address: "10.0.0.3" },
  // Упал — но последний раз проверялся до того, как монитор замолчал: факт
  // старый, а в счётчике «Down» стоит как текущий.
  {
    ...BASE,
    id: 5,
    name: "web-05",
    ip_address: "10.0.0.5",
    last_check_at: ago(40 * DAY),
    last_check_ok: false,
    last_check_error: "timeout after 5s",
  },
  // Отвечает, но снимку три месяца — та самая окаменелость.
  {
    ...BASE,
    ...READINGS,
    id: 4,
    name: "web-04",
    ip_address: "10.0.0.4",
    last_check_at: ago(HOUR),
    last_check_ok: true,
    metrics_collected_at: ago(95 * DAY),
  },
];

function renderDashboard() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/servers") return { items: SERVERS, total: SERVERS.length };
    if (url === "/domains") return [];
    if (url === "/cloudflare/accounts") return [];
    if (url === "/registrars/accounts") return [];
    if (url === "/tasks") return [];
    if (url.startsWith("/audit/log")) return [];
    throw new Error(`unexpected GET ${url}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Dashboard onNav={() => {}} />
    </QueryClientProvider>,
  );
}

/** Число на плитке сводки по её подписи. */
function tile(label: string): string {
  const box = screen.getByText(label).parentElement?.parentElement;
  if (!box) throw new Error(`плитки «${label}» на экране нет`);
  // Именно первый потомок, а не текст всей плитки за вычетом известных слов:
  // прежняя вырезка `replace(label).replace("servers")` возвращала счёт
  // склеенным с любой новой подписью, и утверждение «Down равен двум» падало
  // от появления квалификатора, ничего при этом про счёт не сказав. Счёт и
  // подпись — разные предметы, у каждого свой доступ (см. `tileNote`).
  return (box.firstElementChild?.textContent || "").trim();
}

/** Подпись под счётом: «servers» или «servers · N unverified». */
function tileNote(label: string): string {
  const note = screen.getByText(label).nextElementSibling;
  if (!note) throw new Error(`подписи под плиткой «${label}» на экране нет`);
  return (note.textContent || "").trim();
}

/** Строка «Server Health» целиком — ближайший предок имени с его же IP. */
function row(name: string, ip: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(name).parentElement;
  while (el && !(el.textContent || "").includes(ip)) el = el.parentElement;
  if (!el) throw new Error(`строки «${name}» на экране нет`);
  // Ещё одна ступень вверх: найденный блок — колонка с именем, а показания и
  // бейдж лежат рядом с ней.
  return (el.parentElement as HTMLElement) ?? el;
}

describe("Dashboard — сводка считает только то, что известно", () => {
  beforeEach(() => renderDashboard());

  it("упавший сервер не в «Online», а в «Down»", async () => {
    await screen.findByText("web-01");
    // Ответили двое (web-01 и web-04), упал один (web-02), про одного не знаем
    // ничего (web-03). Колонка `status` у всех четверых говорит «active».
    expect(tile("Online")).toBe("2");
    expect(tile("Down")).toBe("2");
    expect(tile("Unknown")).toBe("1");
  });

  it("«Down» не занижен, но давнее падение в нём датировано", async () => {
    await screen.findByText("web-01");
    // web-02 упал по проверке получасовой давности, web-05 — по проверке
    // сорокадневной. Счёт считает обоих: ошибка в сторону тревоги дешевле —
    // сходить и убедиться, что машина жива, стоит меньше, чем считать мёртвую
    // живой. Но подать давний факт как текущее число значило бы повторить
    // ровно тот дефект, который здесь и чинится, поэтому подпись его датирует.
    expect(tile("Down")).toBe("2");
    expect(tileNote("Down")).toBe("servers · 1 unverified");
    // У остальных плиток квалификатора нет: «Online» требует свежего
    // положительного ответа по построению, а «Unknown» и так про незнание.
    expect(tileNote("Online")).toBe("servers");
    expect(tileNote("Unknown")).toBe("servers");
  });

  it("плитка «Total Servers» подписана тем же разбором", async () => {
    await screen.findByText("web-01");
    expect(screen.getByText("2 online · 2 down · 1 unknown")).toBeTruthy();
  });

  it("бейдж строки не зеленеет у упавшего и у непроверенного", async () => {
    await screen.findByText("web-02");
    const down = within(row("web-02", "10.0.0.2")).getByText("error");
    expect(down.style.background).toBe("rgb(254, 242, 242)");

    const unknown = within(row("web-03", "10.0.0.3")).getByText("unchecked");
    expect(unknown.style.background).toBe("rgb(243, 244, 246)");
  });
});

describe("Dashboard — возраст показаний виден на первом экране", () => {
  beforeEach(() => renderDashboard());

  it("у каждой строки подписан возраст проверки", async () => {
    await screen.findByText("web-01");
    expect(within(row("web-01", "10.0.0.1")).getByText("checked 2h ago")).toBeTruthy();
    expect(within(row("web-03", "10.0.0.3")).getByText("never checked")).toBeTruthy();
  });

  it("аптайм подан той же плотной формой, что в списке и на детали", async () => {
    await screen.findByText("web-01");
    // «3d 0h», а не «3 days»: у дашборда была своя реализация того же числа, и
    // один сервер назывался на двух экранах по-разному. Форма плотная —
    // продукт держит много цифр в строке, и «3 days» рядом с «42%» и «2/4GB»
    // из неё выпадает.
    expect(within(row("web-01", "10.0.0.1")).getByText("3d 0h")).toBeTruthy();
    // Аптайма нет — прочерк, а не «0h»: ноль здесь читался бы как «только что
    // перезагрузился».
    expect(within(row("web-03", "10.0.0.3")).getByText("—")).toBeTruthy();
  });

  it("у каждой строки подписан возраст снимка, а протухший помечен", async () => {
    await screen.findByText("web-04");
    expect(within(row("web-01", "10.0.0.1")).getByText("metrics 12m ago")).toBeTruthy();
    expect(within(row("web-04", "10.0.0.4")).getByText("metrics 3mo ago · stale")).toBeTruthy();
    expect(within(row("web-03", "10.0.0.3")).getByText("no metrics yet")).toBeTruthy();
  });

  it("под относительным возрастом лежит точная дата — как на двух других экранах", async () => {
    await screen.findByText("web-01");
    // «2h ago» отвечает на вопрос «свежо ли это», но не на «когда именно».
    // В списке серверов и на детали точная дата есть в подсказке; дашборд был
    // единственным экраном, где её не было.
    const line = within(row("web-01", "10.0.0.1"));
    expect(line.getByText("checked 2h ago").title).toBe(
      new Date(SERVERS[0].last_check_at as string).toLocaleString(),
    );
    expect(line.getByText("metrics 12m ago").title).toBe(
      new Date(SERVERS[0].metrics_collected_at as string).toLocaleString(),
    );
  });

  it("протухшее показание подано не как свежее", async () => {
    await screen.findByText("web-04");
    const stale = within(row("web-04", "10.0.0.4")).getByText("CPU 42%");
    const fresh = within(row("web-01", "10.0.0.1")).getByText("CPU 42%");
    expect(stale.style.color).toBe(hexToRgb(STALE_TEXT));
    expect(fresh.style.color).not.toBe(stale.style.color);
  });

  it("никаких нарисованных рядов наблюдений — ни у плиток, ни у строк", async () => {
    await screen.findByText("web-01");

    // Плитки рисовали спарклайн из КОНСТАНТЫ в коде (`[3,5,6,6,7,7,8,8]`), а
    // карточки серверов — из пятнадцати случайных чисел вокруг текущего
    // значения. Ни того ни другого мы не измеряли: истории метрик нет.
    // Ищем по остатку разметки `MiniChart` (столбик 4px со скруглённым верхом),
    // а не по имени компонента: вернись он под другим именем — тест всё равно
    // упадёт.
    expect(document.body.querySelectorAll('div[style*="border-radius: 2px 2px 0 0"]').length).toBe(0);
  });
});
