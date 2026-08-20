import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainServerField from "./DomainServerField";
import { queryClient } from "../../api/queryClient";
import { useAuthStore } from "../../store/auth";

/**
 * Связь домена с сервером на карточке домена.
 *
 * Поле было read-only по решению плана 2026-08-17 с подписью «A domain gets its
 * server when it is deployed» — и подпись была неверна: provision `server_id` не
 * ставит, а ЧИТАЕТ и без него падает. Read-only здесь не охраняло инвариант, а
 * закрывало нормальный путь; эти тесты запирают отмену решения.
 *
 * Правила состояний — те же, что у `DomainRegistrarField` (и проверяются так же
 * подробно, потому что это ОДНО правило продукта, а не два похожих): список
 * серверов имеет три состояния, а не «пусто»; сохранённый id, которого в списке
 * нет, удерживает значение селекта; незнание называется словом (CLAUDE.md §6).
 *
 * Своего у сервера два ответа. Сверка с A-записью — потому что связка в базе это
 * НАША запись, а куда пойдёт запрос, знает только DNS; и строка про переезд —
 * потому что смена сервера сайт не переносит, а снимок с прежней машины бэкенд
 * при этом гасит.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), invokeSynced: vi.fn() }));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

vi.mock("../../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

const WEB01 = 3;
const WEB02 = 4;
const GONE = 9;
const CF_ACCOUNT = 7;
const ZONE = "zone-1";

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    registrar_id: null,
    server_id: WEB01,
    cloudflare_account_id: null,
    cloudflare_zone_id: null,
    ...over,
  } as any;
}

const SERVERS = [
  { id: WEB01, name: "web-01", ip_address: "10.0.0.3" },
  { id: WEB02, name: "web-02", ip_address: "10.0.0.4" },
];

function mockServers(servers: any[] = SERVERS) {
  mocks.apiGet.mockImplementation(async (path: string) =>
    String(path) === "/servers" ? { items: servers, total: servers.length } : [],
  );
}

/** Десктоп включается признаком окна — тем же, по которому смотрит `isTauri`. */
function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Записи зоны так, как их отдаёт `cf_list_dns_records`. */
function mockDns(records: any[]) {
  mocks.invokeSynced.mockImplementation(async (cmd: string) =>
    cmd === "cf_list_dns_records" ? records : [],
  );
}

const aRecord = (content: string, name = "example.com") => ({
  id: `r-${content}`,
  type: "A",
  name,
  content,
  ttl: 1,
  proxied: false,
  zone_id: ZONE,
  priority: null,
});

/** Домен с привязанной зоной — иначе сверка выключена по построению. */
const WITH_ZONE = { cloudflare_account_id: CF_ACCOUNT, cloudflare_zone_id: ZONE };

function show(over: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DomainServerField domain={domain(over)} />
    </QueryClientProvider>,
  );
}

function sel() {
  return screen.getByLabelText("Server") as HTMLSelectElement;
}

/** Тела всех `PUT /domains/42` — то, что поле записало в строку домена. */
function domainWrites() {
  return mocks.apiPut.mock.calls
    .filter((c: any[]) => String(c[0]) === "/domains/42")
    .map((c: any[]) => c[1]);
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
  mockServers();
  mockDns([]);
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" } as any);
  setTauri(false);
  // Ответ сервера — строка домена С УЧЁТОМ отправленного тела: фиксированный
  // ответ подтверждал бы любую запись независимо от того, что уехало.
  mocks.apiPut.mockImplementation(async (_path: string, body: any) => domain(body));
});

afterEach(() => {
  cleanup();
  setTauri(false);
  useAuthStore.getState().clear();
  queryClient.clear();
});

describe("сервер домена — выбор, а не приговор развёртывания", () => {
  it("показывает имя сервера вместо сырого id и даёт его сменить", async () => {
    show();

    // Ждём сам список: выбрать пункт, которого ещё нет в разметке, нельзя —
    // селект молча остался бы в прежнем положении.
    expect(await screen.findByText("web-01")).toBeTruthy();
    expect(sel().value).toBe(String(WEB01));

    fireEvent.change(sel(), { target: { value: String(WEB02) } });

    await waitFor(() => expect(domainWrites().length).toBe(1));
    // Ровно одно поле: снимок с прежней машины гасит бэкенд (фаза 1), и второй
    // писатель тех же колонок с фронта разошёлся бы с ним при первой правке.
    expect(domainWrites()[0]).toEqual({ server_id: WEB02 });
  });

  it("даёт снять сервер целиком", async () => {
    show();

    await screen.findByText("web-01");
    fireEvent.change(sel(), { target: { value: "" } });

    await waitFor(() => expect(domainWrites()).toEqual([{ server_id: null }]));
  });

  it("выбор того же сервера запроса не шлёт", async () => {
    // `exclude_unset` на бэкенде: пустой `PUT` безобиден, но лишний, а с ним
    // уехал бы и сброс снимка на «смене» сервера на самого себя.
    show();

    await screen.findByText("web-01");
    fireEvent.change(sel(), { target: { value: String(WEB01) } });

    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("отказ записи показан, а не проглочен", async () => {
    mocks.apiPut.mockRejectedValue(new Error("server_id does not exist"));
    show();

    await screen.findByText("web-02");
    fireEvent.change(sel(), { target: { value: String(WEB02) } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("server_id does not exist");
  });

  it("под селектом стоит адрес сервера — тот же, что печатает карточка FTP", async () => {
    show();
    expect(await screen.findByText("10.0.0.3")).toBeTruthy();
  });
});

describe("незнание не рисуется «связи нет»", () => {
  it("домен без сервера: сказано и что не назначен, и чем это грозит", async () => {
    show({ server_id: null });

    // Диагноз готов сразу: он читается из строки домена и чужого списка не ждёт.
    expect(sel().value).toBe("");
    // Прежний текст «A domain gets its server when it is deployed» удалён как
    // неверный: развёртывание `server_id` не ставит, а требует.
    expect(screen.queryByText(/when it is deployed/i)).toBeNull();
    expect(screen.getByText(/deployment has nowhere to go/i)).toBeTruthy();

    await screen.findByText("web-01");
    expect(screen.getByText(/deployment has nowhere to go/i)).toBeTruthy();
    expect(sel().value).toBe("");
    expect(sel().disabled).toBe(false);
  });

  it("не назначен И список не прочитался — названы обе половины", async () => {
    // Диагноз «назначь сервер» стоит, а лекарство рядом мёртвое: выбирать не из
    // чего. Без второй строки экран велит сделать то, чего в нём сделать нельзя.
    mocks.apiGet.mockRejectedValue(new Error("401 Unauthorized"));
    show({ server_id: null });

    expect(await screen.findByText(/401 Unauthorized/)).toBeTruthy();
    expect(screen.getByText(/deployment has nowhere to go/i)).toBeTruthy();
    expect(sel().disabled).toBe(true);
  });

  it("список ещё грузится — «загрузка», а не «не назначен»", async () => {
    mocks.apiGet.mockImplementation(() => new Promise(() => {}));
    show();

    expect(screen.getByText(/Loading servers/i)).toBeTruthy();
    expect(sel().value).toBe(String(WEB01));
    expect(sel().disabled).toBe(true);
    // Причина состояния селекта связана с ним явно: выключенный селект фокуса не
    // получает, и без `aria-describedby` подпись существует только визуально.
    const described = document.getElementById(sel().getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toMatch(/Loading servers/i);
    // И «сервер не найден» тоже рано: мы его ещё не искали.
    expect(screen.queryByText(/server not found/i)).toBeNull();
  });

  it("список не прочитался — названа причина, а не выдуман ответ", async () => {
    mocks.apiGet.mockRejectedValue(new Error("401 Unauthorized"));
    show();

    expect(await screen.findByText(/401 Unauthorized/)).toBeTruthy();
    expect(sel().value).toBe(String(WEB01));
    expect(sel().disabled).toBe(true);
  });

  it("сервер удалён, а id в домене остался — селект не встаёт в «No server»", async () => {
    // В БД связь есть, сервера нет. Пустой селект обещал бы, что связи нет
    // вовсе, — и человек «назначил» бы сервер, ничего не изменив.
    mockServers([]);
    show({ server_id: GONE });

    await waitFor(() => expect(screen.getByText(/server not found/i)).toBeTruthy());
    expect(sel().value).toBe(String(GONE));
    await act(async () => {});
    expect(domainWrites()).toEqual([]);
  });

  it("список устарел, а рефетч отказал — не утверждаем, что сервер удалили", async () => {
    // TanStack при провале рефетча оставляет прежние `data` и ставит `error`.
    // Обычная причина — протухший токен, а не удалённая машина.
    show({ server_id: GONE });
    await screen.findByText(/server not found/i);

    mocks.apiGet.mockRejectedValue(new Error("401 Unauthorized"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["servers"] });
    });

    expect(await screen.findByText(/401 Unauthorized/)).toBeTruthy();
    expect(screen.getByText(/server not found/i)).toBeTruthy();
    expect(screen.queryByText(/probably deleted/i)).toBeNull();
  });

  it("пока запись идёт, под погасшим селектом не висит прежний диагноз", async () => {
    mocks.apiPut.mockImplementation(() => new Promise(() => {}));
    show({ server_id: null });

    await screen.findByText("web-01");
    fireEvent.change(sel(), { target: { value: String(WEB01) } });

    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect(screen.queryByText(/deployment has nowhere to go/i)).toBeNull();
    expect(sel().disabled).toBe(true);
  });
});

describe("сверка с A-записью", () => {
  it("A-запись ведёт мимо выбранного сервера — янтарная строка с обоими адресами", async () => {
    setTauri(true);
    mockDns([aRecord("5.6.7.8")]);
    show(WITH_ZONE);

    const line = await screen.findByText(/A record points to 5\.6\.7\.8/);
    // Оба адреса в одной строке: без второго непонятно, что именно «не тот».
    expect(line.textContent).toContain("10.0.0.3");
    // Селект при этом НЕ блокируется: назначить сервер ДО развёртывания —
    // нормальный путь, и требовать в этот момент готового DNS значило бы
    // запретить сам сценарий.
    await waitFor(() => expect(sel().disabled).toBe(false));
  });

  it("A-запись ведёт на выбранный сервер — строки нет вовсе", async () => {
    setTauri(true);
    mockDns([aRecord("10.0.0.3")]);
    show(WITH_ZONE);

    await screen.findByText("10.0.0.3");
    await act(async () => {});
    expect(screen.queryByText(/A record points to/)).toBeNull();
  });

  it("в вебе строки нет и в Cloudflare никто не ходит", async () => {
    // Чтение DNS — десктопное (`requireDesktop` внутри запроса), и в вебе оно
    // может только упасть. Принцип №3 при этом не нарушен: назначение сервера
    // остаётся метаданными и работает везде.
    mockDns([aRecord("5.6.7.8")]);
    show(WITH_ZONE);

    await screen.findByText("web-01");
    await act(async () => {});
    expect(screen.queryByText(/A record points to/)).toBeNull();
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    // Спрашиваем КЭШ, а не мок: `requireDesktop` внутри `queryFn` бросает до
    // `invokeSynced`, поэтому один лишь «не звали» прошёл бы и без гейта — с
    // запросом, ушедшим в красное состояние. Здесь запроса нет вовсе.
    expect(queryClient.getQueryState(["cloudflare", CF_ACCOUNT, "zones", ZONE, "dns"])).toBeUndefined();
  });

  it("зоны у домена нет — сверять не с чем, запроса нет", async () => {
    setTauri(true);
    show();

    await screen.findByText("web-01");
    await act(async () => {});
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(screen.queryByText(/A record points to/)).toBeNull();
  });

  it("отказ чтения DNS расхождением не притворяется", async () => {
    // Незнание — не обвинение: строка появляется только на прочитанном ответе.
    setTauri(true);
    mocks.invokeSynced.mockRejectedValue(new Error("cloudflare 403"));
    show(WITH_ZONE);

    await screen.findByText("web-01");
    await act(async () => {});
    expect(screen.queryByText(/A record points to/)).toBeNull();
  });
});

describe("смена сервера переносит только запись", () => {
  it("у домена со снимком сказано, что сайт остаётся на прежней машине", async () => {
    show({ fp_facts_at: "2026-08-19T10:00:00Z" });
    expect(await screen.findByText(/moves only the record/i)).toBeTruthy();
  });

  it("снимка нет — обещать нечего, строки нет", async () => {
    show();
    await screen.findByText("web-01");
    expect(screen.queryByText(/moves only the record/i)).toBeNull();
  });
});
