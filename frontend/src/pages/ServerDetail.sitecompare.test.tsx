import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ServerDetail from "./ServerDetail";
import { setTauri, secretBlobLifecycle } from "../test/secretBlobKit";

/**
 * Сверка сайтов на карточке сервера: четыре группы и два лекарства к ним.
 *
 * Главное, что здесь пиннится, — АДРЕСАТ действия. Пока сверка сравнивала сайты
 * только с доменами этого сервера, «есть на сервере» одинаково означало и «SDMP
 * такого домена не знает», и «домен есть, но стоит на другой машине». Первого
 * надо завести, второго — перепривязать, и перепутанные местами лекарства дают
 * либо дубль имени, либо ничего. Поэтому тест смотрит не «запрос ушёл», а какие
 * ИМЕННО id и имена в нём поехали.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invokeSynced: vi.fn(),
  confirmAction: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

// Чтение сайтов идёт Tauri-командой через `invokeSynced` — мокаем транспорт.
vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

// Не `window.confirm`: в десктопе его нет (см. `lib/confirmDialog`), и подменять
// надо именно общий диалог — заодно видно, О ЧЁМ спросили.
vi.mock("../lib/confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

vi.mock("../components/RevealSecret", () => ({
  RevealSecret: () => <span>reveal</span>,
}));

const SERVER_ID = 7;
const OTHER_SERVER_ID = 9;

const SERVER = {
  id: SERVER_ID,
  name: "prod-01",
  ip_address: "10.0.0.7",
  ssh_port: 22,
  ssh_user: "root",
  os: "ubuntu-22.04",
  status: "active",
  fastpanel_status: "installed",
  fastpanel_url: null,
  fastpanel_user: "fastuser",
  fastpanel_version: "2.0",
  fastpanel_port: 8888,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  has_ssh: true,
  ssh_password_blob_id: "11111111-2222-4333-8444-555555555555",
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
  metrics_collected_at: null,
  last_check_at: null,
  last_check_ok: true,
  last_check_error: null,
};

const OTHER_SERVER = { ...SERVER, id: OTHER_SERVER_ID, name: "prod-02" };

const domain = (id: number, domain_name: string, server_id: number | null) => ({
  id,
  domain_name,
  server_id,
  status: "active",
  registrar_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: null,
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

// По одному представителю каждой группы плюс «чужой сирота»: домен другого
// сервера, у которого здесь сайта нет и быть не должно.
const ALL_DOMAINS = [
  domain(1, "matched.com", SERVER_ID),
  domain(2, "elsewhere.com", OTHER_SERVER_ID),
  domain(3, "free.com", null),
  domain(4, "orphan.com", SERVER_ID),
  domain(5, "other-orphan.com", OTHER_SERVER_ID),
];

const SITES = ["matched.com", "elsewhere.com", "free.com", "ghost.com"].map((domain_name) => ({
  domain_name,
  site_user: "u",
  site_path: `/var/www/${domain_name}`,
  php_version: "8.2",
}));

function renderDetail(domains = ALL_DOMAINS, opts: { allDomainsFail?: boolean; sites?: typeof SITES } = {}) {
  mocks.apiGet.mockImplementation(async (url: string, cfg?: any) => {
    if (url === `/servers/${SERVER_ID}`) return SERVER;
    if (url === "/servers") return { items: [SERVER, OTHER_SERVER] };
    if (url === "/domains") {
      const sid = cfg?.params?.server_id;
      // Падает ровно запрос БЕЗ фильтра — тот, из которого живёт сверка.
      // Таблица сервера при этом читается: состояние «сайты прочитаны, список
      // доменов — нет» именно такое, а не «страница мертва целиком».
      if (sid == null && opts.allDomainsFail) throw new Error("500: domains list failed");
      // Фильтр честно серверный: таблица ниже получает домены этого сервера, а
      // сверка — все. Мок, отдающий обоим одно и то же, скрыл бы как раз ту
      // ошибку, ради которой заведён второй запрос.
      return sid == null ? domains : domains.filter((d) => d.server_id === sid);
    }
    throw new Error(`unexpected GET ${url}`);
  });
  mocks.invokeSynced.mockImplementation(async (cmd: string) => {
    if (cmd === "server_list_sites") return opts.sites ?? SITES;
    throw new Error(`unexpected command ${cmd}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ServerDetail server={{ id: SERVER_ID }} onBack={() => {}} onFastpanelCreds={() => {}} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** Прогнать сверку и дождаться баннера. */
async function compare() {
  fireEvent.click(await screen.findByText("Сверить домены"));
  await screen.findByText(/Сверка с сервером/);
}

describe("ServerDetail — сверка сайтов и привязка по факту", () => {
  secretBlobLifecycle();

  it("раскладывает сайты на четыре группы и не считает чужих сирот пропавшими", async () => {
    setTauri(true);
    renderDetail();
    await compare();

    // Заголовки колонок несут счётчик — по нему и видно раскладку.
    expect(screen.getByText("Только на сервере (1)")).toBeTruthy();
    expect(screen.getByText("Не привязано сюда (2)")).toBeTruthy();
    expect(screen.getByText("Совпало (1)")).toBeTruthy();
    expect(screen.getByText("Только в SDMP (1)")).toBeTruthy();

    // Домен другого сервера без сайта здесь — не расхождение этой машины.
    expect(screen.queryByText(/other-orphan\.com/)).toBeNull();
    // А тот, что стоит на другой машине, назван вместе с ней: «привязать» его
    // означает переезд, и человек должен видеть, откуда.
    expect(screen.getByText(/elsewhere\.com/).textContent).toContain("сейчас prod-02");
    expect(screen.getByText(/free\.com/).textContent).toContain("без сервера");
  });

  it("«Привязать» шлёт ровно id непривязанных сюда — и ни одного лишнего", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockResolvedValue({ updated: 2 });
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Привязать к этому серверу"));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost.mock.calls[0][0]).toBe("/domains/bulk-assign-server");
    // Ровно «не привязанные сюда»: без совпавшего (1), без сироты SDMP (4) и
    // без чужого домена, которого на этом сервере нет (5).
    expect(mocks.apiPost.mock.calls[0][1]).toEqual({ domain_ids: [2, 3], server_id: SERVER_ID });
  });

  it("вопрос называет переезд и его цену, а не только количество", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(false);
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Привязать к этому серверу"));
    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalled());

    const msg = mocks.confirmAction.mock.calls[0][0] as string;
    expect(msg).toContain("2 домена");
    expect(msg).toContain("prod-01");
    // Переезжает один из двух — и вместе с ним сбрасываются факты с прежней
    // машины. Молчаливая перевозка чужого сайта — это то, что вопрос обязан
    // назвать вслух.
    expect(msg).toContain("У 1 из них сейчас стоит другой сервер");
    expect(msg).toMatch(/сброшен/);
  });

  it("отказ в диалоге не отправляет ничего", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(false);
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Привязать к этому серверу"));
    await waitFor(() => expect(mocks.confirmAction).toHaveBeenCalled());
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("«Завести и привязать» создаёт только неизвестные домены и сразу с сервером", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockResolvedValue({ created: [], skipped: [] });
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost.mock.calls[0][0]).toBe("/domains/bulk-structured");
    // `server_id` в самом элементе — то поле, ради которого правился бэкенд:
    // заведи домен без него, и «привязка по факту» не привяжет ничего.
    expect(mocks.apiPost.mock.calls[0][1]).toEqual({
      items: [{ domain_name: "ghost.com", server_id: SERVER_ID }],
    });
  });

  it("упавшая привязка названа, а не проглочена", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockRejectedValue(new Error("403: server belongs to another user"));
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Привязать к этому серверу"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Не удалось привязать домены");
    expect(alert.textContent).toContain("another user");
  });

  /**
   * Пропущенные — не успех: сервер отказался заводить домен (такой уже есть
   * либо имя не прошло проверку), и привязку ему при этом никто не поставил.
   * Колонки после инвалидации выглядят одинаково в обоих случаях, поэтому
   * назвать пропущенных обязан баннер (принцип №6).
   */
  it("пропущенные при заведении названы поимённо", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockResolvedValue({ created: [], skipped: ["ghost.com"] });
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Не заведены и не привязаны");
    expect(alert.textContent).toContain("ghost.com");
  });

  /**
   * Отчёт описывает КОНКРЕТНЫЙ прогон. Пережив повторную сверку, он висел бы
   * над колонками, которые построены уже по другим данным, — то есть врал бы о
   * текущем состоянии, а это ровно то, чего принцип №6 не разрешает.
   */
  it("повторная сверка стирает отчёт о прошлой привязке", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockResolvedValue({ created: [], skipped: ["ghost.com"] });
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));
    expect((await screen.findByRole("alert")).textContent).toContain("ghost.com");

    fireEvent.click(screen.getByText("Сверить домены"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("группы без расхождения кнопок не показывают", async () => {
    setTauri(true);
    // Всё сходится: у каждого сайта есть домен, привязанный сюда.
    renderDetail(SITES.map((s, i) => domain(100 + i, s.domain_name, SERVER_ID)));
    await compare();

    expect(screen.getByText("Совпало (4)")).toBeTruthy();
    expect(screen.queryByText("Привязать к этому серверу")).toBeNull();
    expect(screen.queryByText("Завести и привязать")).toBeNull();
  });

  /**
   * Непрочитанный список — не пустой список. Пока сверка получала `data ?? []`,
   * отказ `GET /domains` давал уверенный диагноз «SDMP не знает про этот сервер
   * ничего»: все сайты уезжали в «только на сервере», шапка писала «привязано 0»,
   * а кнопка предлагала завести заново домены, которые уже привязаны сюда. От
   * порчи данных спасал только UNIQUE на бэкенде (принцип №6).
   */
  it("отказ чтения доменов назван словом, а не нарисован нулями", async () => {
    setTauri(true);
    renderDetail(ALL_DOMAINS, { allDomainsFail: true });
    fireEvent.click(await screen.findByText("Сверить домены"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("список доменов SDMP не загрузился");
    expect(alert.textContent).toContain("domains list failed");

    // Ни колонок с нулями, ни лечения по выдуманному диагнозу.
    expect(screen.queryByText(/Сверка с сервером/)).toBeNull();
    expect(screen.queryByText("Завести и привязать")).toBeNull();
    expect(screen.queryByText("Привязать к этому серверу")).toBeNull();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  /**
   * Перезапуск сверки посреди привязки. Раньше баннер держал и мутацию, и
   * `skipped`, а новая сверка размонтировала его через `key` — ответ приезжал в
   * никуда, и имена, которые сервер отказался заводить, не показывались нигде.
   */
  it("сверку нельзя перезапустить посреди привязки, и отчёт доезжает", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    let release: (v: any) => void = () => {};
    mocks.apiPost.mockImplementation(() => new Promise((res) => { release = res; }));
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));
    // Кнопка сверки гаснет на время лечения — иначе клик по ней снёс бы колонки
    // из-под ещё не приехавшего ответа.
    await waitFor(() => expect((screen.getByText("Сверить домены") as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(screen.getByText("Сверить домены"));
    release({ created: [], skipped: ["ghost.com"] });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ghost.com");
  });

  /**
   * Отчёты двух кнопок описывают РАЗНЫЕ прогоны, и чужой не должен висеть над
   * колонками, перерисованными следующим. Свой статус react-query гасит сам,
   * соседний — никто, поэтому обработчики делают это руками.
   */
  it("удачное заведение убирает красную плашку прошлой привязки", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockRejectedValueOnce(new Error("500: assign failed"));
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Привязать к этому серверу"));
    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось привязать домены");

    mocks.apiPost.mockResolvedValue({ created: [], skipped: [] });
    fireEvent.click(screen.getByText("Завести и привязать"));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * «Ошибка» и «данных нет» — разные состояния, и упавший ФОНОВЫЙ перезапрос
   * даёт первое при наличии вторых. Достижимо оно не теоретически: перезапрос
   * `/domains` запускает инвалидация после самой привязки, то есть в ту же
   * секунду, когда на экране появляется отчёт `skipped`. Пока ветка отказа
   * стояла перед успехом, икота бэкенда в этот момент уносила и сверку, и
   * только что приехавшие имена — ровно то, что чинилось этажом выше.
   */
  it("упавший фоновый перезапрос не сносит сверку вместе с отчётом", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockResolvedValue({ created: [], skipped: ["ghost.com"] });
    const { client } = renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));
    expect((await screen.findByRole("alert")).textContent).toContain("ghost.com");

    // Ровно то, что делает инвалидация после мутации, — только с отказом в ответ.
    const first = mocks.apiGet.getMockImplementation()!;
    mocks.apiGet.mockImplementation(async (url: string, cfg?: any) => {
      if (url === "/domains" && cfg?.params?.server_id == null) throw new Error("502: bad gateway");
      return first(url, cfg);
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["domains"] }).catch(() => {});
    });

    // Сверка жива, лечение доступно, отчёт на месте — а про неудачу обновления
    // сказано отдельно, а не молчанием и не сносом экрана.
    expect(await screen.findByText(/мог устареть/)).toBeTruthy();
    expect(screen.getByText(/Сверка с сервером/)).toBeTruthy();
    expect(screen.getByText("Завести и привязать")).toBeTruthy();
    expect(screen.queryByText(/не загрузился/)).toBeNull();
    expect(document.body.textContent ?? "").toContain("ghost.com");
  });

  /** Та же симметрия в обратную сторону: гасит ли привязка отчёт заведения. */
  it("удачная привязка убирает красную плашку прошлого заведения", async () => {
    setTauri(true);
    mocks.confirmAction.mockResolvedValue(true);
    mocks.apiPost.mockRejectedValueOnce(new Error("500: create failed"));
    renderDetail();
    await compare();

    fireEvent.click(screen.getByText("Завести и привязать"));
    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось завести домены");

    mocks.apiPost.mockResolvedValue({ updated: 2 });
    fireEvent.click(screen.getByText("Привязать к этому серверу"));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * Оба числа шапки считаются по сверке. Сырой счёт сайтов над колонками, где
   * дубли схлопнуты, обещал бы четвёртое имя, которого на экране нет.
   */
  it("счётчик сайтов не обещает больше имён, чем показано", async () => {
    setTauri(true);
    // Пять строк с сервера, но одна из них — тот же домен в другом написании:
    // сверка схлопывает его, и на экране остаётся четыре имени.
    renderDetail(ALL_DOMAINS, { sites: [...SITES, { ...SITES[0], domain_name: "MATCHED.com." }] });
    await compare();

    const head = screen.getByText(/Сверка с сервером/).textContent ?? "";
    expect(head).toContain("на сервере 4");
    expect(head).not.toContain("на сервере 5");
  });
});
