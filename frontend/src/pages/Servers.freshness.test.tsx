import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Servers from "./Servers";
import { secretBlobLifecycle } from "../test/secretBlobKit";

/**
 * Честность карточки сервера: что мы знаем про «жив» и насколько свежо то, что
 * нарисовано.
 *
 * На странице ДВА сигнала с разной природой и разной свежестью — доступность
 * (её пишет бэкенд TCP-проверкой раз в 6 часов) и метрики (их снимает десктоп по
 * SSH, только когда человек нажал кнопку). Файл проверяет, что страница их не
 * склеивает и не выдаёт незнание за здоровье:
 *
 * - зелёный `active` у ни разу не проверенного сервера — это поле, выставленное
 *   при заведении, а не ответ машины;
 * - цифра без возраста читается как сегодняшняя, даже если ей три месяца;
 * - текст ошибки в тултипе при `last_check_ok === true` — это первый
 *   неподтверждённый промах, то есть красный текст на зелёной карточке.
 *
 * Оба представления (карточки и таблица) проверяются вместе: они рисуют одно и
 * то же двумя кусками кода, и починенное в одном молча остаётся сломанным
 * в другом.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: vi.fn(),
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../components/ServerBulkImportDialog", () => ({ default: () => null }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Отметки считаются от настоящего `Date.now()`, а не от замороженных часов:
 * страница берёт время сама, и подмена таймеров тянула бы за собой react-query.
 * Значения нарочно не на границе («2ч 5м» вместо ровных двух часов), чтобы
 * прогон не зависел от миллисекунд между фикстурой и рендером.
 */
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

/** Полный набор показаний — чтобы «протухло» проверялось на видимых цифрах. */
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
  // Ни разу не проверялся и метрик не снимал — «не знаем» по обоим сигналам.
  { ...BASE, id: 1, name: "web-01", ip_address: "10.0.0.1" },
  // Проверен, отвечает; метрики снимали только что.
  {
    ...BASE,
    ...READINGS,
    id: 2,
    name: "web-02",
    ip_address: "10.0.0.2",
    last_check_at: ago(2 * HOUR + 5 * MINUTE),
    last_check_ok: true,
    metrics_collected_at: ago(12 * MINUTE),
  },
  // Отвечает, но метрики — окаменелость с прошлого захода в десктоп.
  {
    ...BASE,
    ...READINGS,
    id: 3,
    name: "web-03",
    ip_address: "10.0.0.3",
    last_check_at: ago(HOUR),
    last_check_ok: true,
    metrics_collected_at: ago(95 * DAY),
  },
  // Подтверждённое падение: два промаха подряд.
  {
    ...BASE,
    id: 4,
    name: "web-04",
    ip_address: "10.0.0.4",
    last_check_at: ago(30 * MINUTE),
    last_check_ok: false,
    last_check_error: "timeout after 5s",
  },
  // Первый, НЕподтверждённый промах: ошибка записана, статус ещё не упал.
  {
    ...BASE,
    id: 5,
    name: "web-05",
    ip_address: "10.0.0.5",
    last_check_at: ago(20 * MINUTE),
    last_check_ok: true,
    last_check_error: "timeout after 5s",
  },
  // Снимок есть и он свежий, но процент CPU из него не разобрался. Снимком он
  // быть не перестал: диск в нём настоящий, и «метрик нет» про него — ложь.
  {
    ...BASE,
    id: 6,
    name: "web-06",
    ip_address: "10.0.0.6",
    last_check_at: ago(HOUR),
    last_check_ok: true,
    metrics_collected_at: ago(5 * MINUTE),
    disk_used_gb: 30,
    disk_total_gb: 80,
  },
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

/** Карточка сетки целиком — по имени сервера внутри неё. */
function card(name: string): HTMLElement {
  const title = screen.getByText(name);
  // Имя → строка заголовка → карточка. Ближайший общий предок ищем от текста,
  // а не по data-атрибуту: разметка у страницы плотная и без хуков для тестов.
  const el = title.closest("div[style]")?.parentElement?.parentElement;
  if (!el) throw new Error(`карточки «${name}» на экране нет`);
  return el as HTMLElement;
}

async function showTable() {
  fireEvent.click(await screen.findByText("☰ Table"));
  return (await screen.findByRole("table")) as HTMLTableElement;
}

function row(table: HTMLTableElement, name: string): HTMLTableRowElement {
  const found = Array.from(table.querySelectorAll("tbody tr")).find((tr) =>
    within(tr as HTMLElement).queryByText(name),
  );
  if (!found) throw new Error(`строки «${name}» в таблице нет`);
  return found as HTMLTableRowElement;
}

function cellByHeader(table: HTMLTableElement, name: string, header: string): string {
  const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
    (th.textContent || "").trim(),
  );
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  return (row(table, name).cells[idx].textContent || "").trim();
}

describe("Servers — статус не врёт", () => {
  secretBlobLifecycle();
  beforeEach(() => renderServers());

  it("ни разу не проверенный сервер — «unchecked», а не зелёный «active»", async () => {
    await screen.findByText("web-01");
    // `status: "active"` в фикстуре стоит: это поле ставится при заведении
    // сервера и к тому, отвечает ли машина, отношения не имеет.
    const badge = within(card("web-01")).getByText("unchecked");
    expect(within(card("web-01")).queryByText("active")).toBeNull();
    // И бейдж НЕ зелёный: слово «unchecked» на зелёном фоне читается как
    // «всё хорошо», то есть врёт ровно тем, ради чего заведено.
    expect(badge.style.background).toBe("rgb(243, 244, 246)");
    expect(within(card("web-01")).getByText("Last check: never")).toBeTruthy();
  });

  it("проверенный и ответивший — «active», с возрастом проверки", async () => {
    await screen.findByText("web-02");
    expect(within(card("web-02")).getByText("active")).toBeTruthy();
    expect(within(card("web-02")).getByText("Last check: 2h ago")).toBeTruthy();
  });

  it("подтверждённое падение — «error» и причина в подсказке", async () => {
    await screen.findByText("web-04");
    expect(within(card("web-04")).getByText("error")).toBeTruthy();
    expect(screen.getByText("web-04").getAttribute("title")).toBe("timeout after 5s");
  });

  it("первый неподтверждённый промах не показывает ошибку под зелёной карточкой", async () => {
    await screen.findByText("web-05");
    // Бэкенд пишет `last_check_error` уже на первом промахе, а `last_check_ok`
    // роняет только на втором. Тултип, повешенный без оглядки на статус, давал
    // зелёную карточку с текстом ошибки в подсказке.
    expect(within(card("web-05")).getByText("active")).toBeTruthy();
    expect(screen.getByText("web-05").getAttribute("title")).toBeNull();
  });

  it("то же самое в таблице: и статус, и гейт подсказки", async () => {
    const table = await showTable();
    expect(cellByHeader(table, "web-01", "Status")).toBe("unchecked");
    expect(cellByHeader(table, "web-04", "Status")).toBe("error");
    expect(within(row(table, "web-04")).getByText("web-04").getAttribute("title")).toBe(
      "timeout after 5s",
    );
    expect(within(row(table, "web-05")).getByText("web-05").getAttribute("title")).toBeNull();
    expect(cellByHeader(table, "web-01", "Checked")).toBe("never");
    expect(cellByHeader(table, "web-02", "Checked")).toBe("2h ago");
  });

  it("фильтр статусов знает про непроверенные — иначе они выпадают из всех", async () => {
    await screen.findByText("web-01");
    const options = Array.from(
      (screen.getByDisplayValue("Status: All") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toContain("unchecked");
  });
});

describe("Servers — свежесть метрик отделена от свежести проверки", () => {
  secretBlobLifecycle();
  beforeEach(() => renderServers());

  it("«No metrics yet» — только когда снимков не было вовсе", async () => {
    await screen.findByText("web-01");
    expect(within(card("web-01")).getByText("No metrics yet")).toBeTruthy();
    // У остальных снимок есть, пусть и старый: «нет метрик» про них — ложь.
    expect(within(card("web-02")).queryByText("No metrics yet")).toBeNull();
    expect(within(card("web-03")).queryByText("No metrics yet")).toBeNull();
    // Главный случай: снимок пришёл, а процент CPU в нём не разобрался. Пока
    // «нет метрик» решалось по наличию CPU, такой сервер объявлялся неснятым —
    // при живом снимке пятиминутной давности.
    expect(within(card("web-06")).queryByText("No metrics yet")).toBeNull();
    expect(within(card("web-06")).getByText("No CPU reading")).toBeTruthy();
    expect(within(card("web-06")).getByText("Metrics: 5m ago")).toBeTruthy();
  });

  it("свежие метрики подписаны своим возрастом, а не возрастом проверки", async () => {
    await screen.findByText("web-02");
    // 12 минут — метрики, 2 часа — проверка. Одна подпись на двоих означала бы,
    // что один из двух сигналов показан чужой свежестью.
    expect(within(card("web-02")).getByText("Metrics: 12m ago")).toBeTruthy();
    expect(within(card("web-02")).getByText("Last check: 2h ago")).toBeTruthy();
  });

  it("метрики старше суток помечены «stale» прямо в подписи", async () => {
    await screen.findByText("web-03");
    expect(within(card("web-03")).getByText("Metrics: 3mo ago · stale")).toBeTruthy();
    // И это не мешает сигналу доступности: сервер отвечает, проверка свежая.
    expect(within(card("web-03")).getByText("active")).toBeTruthy();
    expect(within(card("web-03")).getByText("Last check: 1h ago")).toBeTruthy();
  });

  it("протухшие цифры показаны приглушённо, свежие — нет", async () => {
    await screen.findByText("web-03");
    // Обе карточки показывают «42%», и без разницы в подаче старое число
    // выглядит ровно так же, как сегодняшнее.
    const stale = within(card("web-03")).getByText("42%");
    const fresh = within(card("web-02")).getByText("42%");
    expect(stale.style.color).toBe("rgb(156, 163, 175)");
    expect(fresh.style.color).not.toBe("rgb(156, 163, 175)");
  });

  it("в таблице у метрик своя колонка, и протухшие цифры так же приглушены", async () => {
    const table = await showTable();
    expect(cellByHeader(table, "web-01", "Metrics")).toBe("—");
    expect(cellByHeader(table, "web-02", "Metrics")).toBe("12m ago");
    expect(cellByHeader(table, "web-03", "Metrics")).toBe("3mo ago · stale");

    const staleCpu = within(row(table, "web-03")).getByText("42%");
    const freshCpu = within(row(table, "web-02")).getByText("42%");
    expect(staleCpu.style.color).toBe("rgb(156, 163, 175)");
    expect(freshCpu.style.color).not.toBe("rgb(156, 163, 175)");
  });
});
