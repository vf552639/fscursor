import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import type { Server } from "../api/servers";
import { u8ToB64 } from "../lib/b64";
import { setTauri, secretBlobLifecycle } from "../test/secretBlobKit";
import { hexToRgb } from "../test/colors";
import { STALE_TEXT } from "../components/ui/Primitives";

/**
 * Деталь сервера: сбор метрик по кнопке и честность того, что на ней нарисовано.
 *
 * Два независимых сигнала с разной свежестью — доступность (бэкенд, TCP-порт,
 * раз в 6 часов) и метрики (десктоп, SSH, только по нажатию). Страница обязана
 * показывать возраст каждого: показание без возраста читается как сегодняшнее,
 * а зелёный «active» у ни разу не проверенного сервера — это незнание,
 * нарисованное как здоровье.
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
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
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

vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const SSH_BLOB = "11111111-2222-4333-8444-555555555555";
const SSH_PW = "s3cret-ssh-pw";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Отметка на `ms` раньше настоящего `Date.now()` — см. Servers.freshness.test. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const SERVER: Server = {
  id: 7,
  name: "srv-7",
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  os: "ubuntu-22.04",
  provider: null,
  status: "active",
  purchase_date: null,
  expiry_date: null,
  fastpanel_status: "not_installed",
  fastpanel_url: null,
  fastpanel_user: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: SSH_BLOB,
  fastpanel_password_blob_id: null,
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
  last_check_ok: null,
  last_check_error: null,
};

/** Снимок метрик со всеми показаниями — на нём проверяется «протухло». */
const WITH_READINGS = {
  uptime_seconds: 3 * 86400,
  cpu_usage_pct: 42,
  cpu_count: 2,
  ram_used_mb: 2048,
  ram_total_mb: 4096,
  disk_used_gb: 30,
  disk_total_gb: 80,
};

function renderDetail(server: Server = SERVER) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === `/servers/${server.id}`) return server;
    if (url === "/servers") return { items: [server], total: 1 };
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

/**
 * Вывод настоящей машины на `COLLECT_METRICS_COMMAND`, урезанный до сути.
 * Финальный маркер `#sdmp:end` обязателен: по нему разбор отличает полный
 * снимок от оборванного на полпути (`lib/serverMetrics`).
 */
const COLLECTED = [
  "#sdmp:nproc",
  "2",
  "#sdmp:mem",
  "MemTotal:        4194304 kB",
  "MemAvailable:    2097152 kB",
  "#sdmp:disk",
  "/dev/sda1 83886080 31457280 52428800 38% /",
  "#sdmp:kernel",
  "6.5.0-14-generic",
  "#sdmp:os",
  'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
  "#sdmp:uptime",
  "1000.00 900.00",
  "#sdmp:cpu",
  "cpu 100 0 50 850 0 0 0 0",
  "#sdmp:uptime",
  "1001.00 900.50",
  "#sdmp:cpu",
  "cpu 150 0 60 890 0 0 0 0",
  "#sdmp:end",
].join("\n");

/**
 * Карточка показания целиком (`StatCard`) — блок с подписью, значением,
 * припиской и полосой заполнения.
 */
function statCard(label: string): HTMLElement {
  const el = screen.getByText(label).parentElement;
  if (!el) throw new Error(`карточки «${label}» на экране нет`);
  return el;
}

/**
 * Нарисована ли под значением полоса заполнения. Ищем по остатку разметки
 * `StatCard` (единственный элемент страницы с анимацией ширины), а не по
 * тест-иду: полоса — это разметка компонента, и появись она снова другим
 * способом, проверка обязана поймать её всё равно.
 */
function hasBar(label: string): boolean {
  return statCard(label).querySelectorAll('div[style*="transition"]').length > 0;
}

/**
 * Значение строки «Server Information» по её подписи (`InfoRow`).
 *
 * Кнопки из строки выбрасываются: у правимых строк (Name/IP/Provider/OS)
 * `InfoRow` рисует карандаш там же, и его глиф «✎» приклеился бы к значению без
 * разделителя (`rowValue("Name")` вернул бы `"server-1✎"`). Убираем сам
 * элемент, а не подчищаем строку от глифа: подгонка ожидания под мусор скрыла
 * бы и настоящий мусор в значении.
 */
function rowValue(label: string): string {
  const row = screen.getByText(label).parentElement;
  if (!row) throw new Error(`строки «${label}» на экране нет`);
  const clone = row.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button").forEach((b) => b.remove());
  return (clone.textContent || "").replace(label, "").trim();
}

function sshReturns(output: string) {
  mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
    if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
    if (cmd === "ssh_exec") return [0, output];
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe("ServerDetail — кнопка «Refresh metrics»", () => {
  secretBlobLifecycle();

  it("снимает показания по SSH и отдаёт их бэкенду", async () => {
    setTauri(true);
    sshReturns(COLLECTED);
    mocks.apiPost.mockResolvedValue({ ...SERVER, ...WITH_READINGS, metrics_collected_at: ago(0) });

    renderDetail();
    fireEvent.click(await screen.findByText("Refresh metrics"));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = mocks.apiPost.mock.calls[0];
    // Путь именно на приём снимка: мёртвый `refresh-metrics` на бэкенде убран, и
    // кнопка не должна к нему вернуться.
    expect(url).toBe("/servers/7/metrics");
    expect(body.cpu_count).toBe(2);
    expect(body.ram_total_mb).toBe(4096);
  });

  it("пока снимок идёт, кнопка занята и не даёт зайти вторым SSH", async () => {
    setTauri(true);
    let release: (v: unknown) => void = () => {};
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      await new Promise((r) => { release = r; });
      return [0, COLLECTED];
    });
    mocks.apiPost.mockResolvedValue(SERVER);

    renderDetail();
    fireEvent.click(await screen.findByText("Refresh metrics"));

    const busy = await screen.findByText("Refreshing...");
    expect((busy.closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);

    release(null);
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));
    // Второй клик по занятой кнопке не должен был начать второй вход по SSH.
    expect(mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "ssh_exec").length).toBe(1);
  });

  it("отказ виден баннером, а не только в консоли", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      throw new Error("api: ssh: connect: connection refused");
    });

    renderDetail();
    fireEvent.click(await screen.findByText("Refresh metrics"));

    expect(await screen.findByText(/connection refused/)).toBeTruthy();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("в вебе кнопки нет — вместо неё общая фраза продукта", async () => {
    setTauri(false);
    renderDetail();

    // Та же фраза, что бросит сама `runCollectMetrics` (`requireDesktop`):
    // объяснение одного запрета не должно разъезжаться между экраном и ошибкой.
    expect(await screen.findByText("Collecting metrics runs in the SDMP desktop app.")).toBeTruthy();
    expect(screen.queryByText("Refresh metrics")).toBeNull();
  });
});

describe("ServerDetail — свежесть проверки и метрик", () => {
  secretBlobLifecycle();

  it("ни разу не проверенный сервер — «unchecked» и «never», а не зелёный «active»", async () => {
    setTauri(true);
    renderDetail();

    // `status: "active"` в фикстуре стоит, но это поле заведения сервера.
    const badge = await screen.findByText("unchecked");
    expect(screen.queryByText("active")).toBeNull();
    // Не зелёный: слово «unchecked» на зелёном фоне читается как «всё хорошо».
    expect(badge.style.background).toBe("rgb(243, 244, 246)");
    // Строку ищем по её подписи: «never» на экране два — у проверки и у метрик,
    // и это разные «никогда».
    expect(rowValue("Last check")).toBe("never");
  });

  it("проверенный сервер показывает возраст проверки", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, last_check_at: ago(2 * HOUR + 5 * MINUTE), last_check_ok: true });

    expect(await screen.findByText("active")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();
  });

  it("подтверждённое падение — красный «error» и причина баннером", async () => {
    setTauri(true);
    renderDetail({
      ...SERVER,
      last_check_at: ago(30 * MINUTE),
      last_check_ok: false,
      last_check_error: "timeout after 5s",
    });

    const badge = await screen.findByText("error");
    expect(badge.style.background).toBe("rgb(254, 242, 242)");
    expect(screen.getByText(/Uptime check failed: timeout after 5s/)).toBeTruthy();
  });

  it("первый неподтверждённый промах не поднимает баннер и не красит в error", async () => {
    setTauri(true);
    // Бэкенд пишет `last_check_error` уже на первом промахе, а `last_check_ok`
    // роняет только на втором. Баннер без оглядки на статус кричал бы о падении,
    // которого ещё не случилось, — тот же гейт, что у тултипа на списке.
    renderDetail({
      ...SERVER,
      last_check_at: ago(20 * MINUTE),
      last_check_ok: true,
      last_check_error: "timeout after 5s",
    });

    expect(await screen.findByText("active")).toBeTruthy();
    expect(screen.queryByText(/Uptime check failed/)).toBeNull();
  });

  it("протухшая проверка перестаёт удерживать «active»", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, last_check_at: ago(3 * DAY), last_check_ok: true });

    expect(await screen.findByText("unchecked")).toBeTruthy();
    expect(rowValue("Last check")).toBe("3d ago · stale");
  });

  it("без снимков зовёт снять их, а не рисует прочерки как показания", async () => {
    setTauri(true);
    renderDetail();

    expect(await screen.findByText(/No metrics yet/)).toBeTruthy();
    // Пустых карточек показаний на экране быть не должно.
    expect(screen.queryByText("CPU Usage")).toBeNull();
  });

  it("снимок, из которого ничего не разобралось, снимком быть не перестал", async () => {
    setTauri(true);
    // Все показания `null`, но отметка стоит: десктоп заходил и ничего не смог
    // измерить. Это «пробовали пять минут назад — не вышло», а не «не пробовали
    // ни разу», и звать нажать кнопку ещё раз тут нечестно.
    renderDetail({ ...SERVER, metrics_collected_at: ago(5 * MINUTE) });

    expect(await screen.findByText("Metrics: 5m ago")).toBeTruthy();
    expect(screen.queryByText(/No metrics yet/)).toBeNull();
  });

  it("непрочитанный процент CPU не рисуется пустой полосой под прочерком", async () => {
    setTauri(true);
    // Тот же снимок без единого показания. Полоса под «—» — это утверждение
    // «CPU 0%», которого никто не измерял: пустой жёлоб читается как нулевая
    // загрузка. У RAM и SSD рядом её в этом случае и нет.
    renderDetail({ ...SERVER, metrics_collected_at: ago(5 * MINUTE) });

    await screen.findByText("CPU Usage");
    expect(statCard("CPU Usage").textContent).toContain("—");
    expect(hasBar("CPU Usage")).toBe(false);
    expect(hasBar("RAM Usage")).toBe(false);
    expect(hasBar("SSD Usage")).toBe(false);
  });

  it("измеренный процент CPU полосу как раз рисует", async () => {
    setTauri(true);
    // Обратная сторона проверки выше: без неё «полосы нет» зеленело бы и у
    // карточки, которая перестала рисовать её вовсе.
    renderDetail({ ...SERVER, ...WITH_READINGS, metrics_collected_at: ago(5 * MINUTE) });

    await screen.findByText("CPU Usage");
    expect(hasBar("CPU Usage")).toBe(true);
  });

  it("свежий снимок подписан своим возрастом", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, ...WITH_READINGS, metrics_collected_at: ago(12 * MINUTE) });

    expect(await screen.findByText("Metrics: 12m ago")).toBeTruthy();
    expect(screen.getByText("CPU Usage")).toBeTruthy();
    expect(screen.queryByText(/stale/)).toBeNull();
    // И сама цифра не выкрашена в «протухшее»: цвет — часть утверждения.
    expect(screen.getByText("42%").style.color).not.toBe(hexToRgb(STALE_TEXT));
    // «Normal» рядом с числом ядер утверждалось безусловно — и при 95% CPU, и
    // на трёхмесячном снимке. Оценки, не выведенной из данных, здесь нет.
    expect(screen.queryByText(/Normal/)).toBeNull();
    expect(screen.getByText("2 vCPU")).toBeTruthy();
  });

  it("память переведена в ГБ той же формулой, что в списке и на дашборде", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, ...WITH_READINGS, ram_used_mb: 1536, metrics_collected_at: ago(5 * MINUTE) });

    // 1536 МБ — это «1.5 GB», а не «2 GB»: округление до целого дорисовывало бы
    // машине полгигабайта занятой памяти, которых никто не измерял.
    expect(await screen.findByText("1.5 GB")).toBeTruthy();
  });

  it("карточки показаний не рисуют ряд наблюдений, которого не существует", async () => {
    setTauri(true);
    const { container } = renderDetail({
      ...SERVER,
      ...WITH_READINGS,
      metrics_collected_at: ago(12 * MINUTE),
    });
    await screen.findByText("CPU Usage");

    // Спарклайн `MiniChart` рисовал пятнадцать столбиков шириной 4px вокруг
    // ОДНОГО значения: истории метрик мы не храним, и форма графика заявляла
    // колебания, которых никто не измерял. Ищем по остатку его разметки —
    // вернись он под другим именем, тест всё равно упадёт.
    expect(container.querySelectorAll('div[style*="border-radius: 2px 2px 0 0"]').length).toBe(0);
  });

  it("снимок старше суток помечен «stale» — и в подписи, и у аптайма в шапке", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, ...WITH_READINGS, metrics_collected_at: ago(95 * DAY) });

    expect(await screen.findByText(/Metrics: 3mo ago · stale/)).toBeTruthy();
    // Аптайм в шапке — то же самое трёхмесячное показание, и без пометки он
    // читается как «сервер работает 3 дня» прямо сейчас. Пометка — та же самая
    // словом в слово: «(stale)» здесь и «· stale» рядом были двумя редакциями
    // одного факта.
    expect(screen.getByText(/Uptime: 3d 0h · stale/)).toBeTruthy();
  });

  it("протухший снимок подан цветом показаний, а не прозрачностью всего блока", async () => {
    setTauri(true);
    renderDetail({ ...SERVER, ...WITH_READINGS, metrics_collected_at: ago(95 * DAY) });

    // Тот же цвет протухшего показания, что в списке серверов и на дашборде.
    expect((await screen.findByText("42%")).style.color).toBe(hexToRgb(STALE_TEXT));
    // И НЕ `opacity` на весь блок: она была третьим механизмом для того же
    // сигнала и утаскивала заодно серые подписи («of 4 GB») до нечитаемого
    // контраста — приписка должна читаться как раз у старого снимка.
    const grid = screen.getByText("CPU Usage").closest('div[style*="grid-template-columns"]');
    expect((grid as HTMLElement).style.opacity).toBe("");
    expect(screen.getByText("of 4 GB")).toBeTruthy();
  });
});
