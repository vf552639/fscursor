import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  autoBindDomainsToCloudflare,
  summarizeCfBind,
  summarizeCfBindFailure,
  CfBindReport,
} from "./cfAutoBind";
import { domainsKeys } from "./domains";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Прогон привязки домена к зоне Cloudflare.
 *
 * Проверяется здесь то, что нельзя увидеть со страницы: сколько раз прогон
 * ходит за зонами (один раз на аккаунт, а не на домен), что делает с аккаунтом,
 * зоны которого не прочитались, и что записывает в домен. Ошибиться в любом из
 * этих мест можно так, что UI останется зелёным.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  invokeSynced: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: mocks.invokeSynced,
  syncLocalCache: vi.fn(async () => {}),
}));

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function account(id: number, name: string, isActive = true) {
  return {
    id,
    name,
    account_id: null,
    is_active: isActive,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function domain(id: number, name: string, cfAccount: number | null = null) {
  return { id, domain_name: name, cloudflare_account_id: cfAccount };
}

/** Зоны по аккаунтам: чем отвечает `cf_list_zones` на каждый `accountId`. */
function zonesByAccount(map: Record<string, Array<{ id: string; name: string }>>) {
  mocks.invokeSynced.mockImplementation(async (cmd: string, args: any) => {
    if (cmd !== "cf_list_zones") throw new Error(`unexpected command ${cmd}`);
    const zones = map[String(args.accountId)];
    if (!zones) throw new Error(`token invalid for account ${args.accountId}`);
    return zones.map((z) => ({ ...z, name_servers: [], status: "active" }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  setTauri(true);
  // `cf_list_zones` резолвит аккаунт из локального кэша по id пользователя:
  // без него запрос зон отвечает «unlock session», а не списком зон.
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  mocks.apiPut.mockResolvedValue({});
});

afterEach(() => {
  setTauri(false);
  queryClient.clear();
  useAuthStore.getState().clear();
});

describe("autoBindDomainsToCloudflare", () => {
  it("привязывает совпавший домен и пишет и аккаунт, и зону", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "example.com" }] });

    const report = await autoBindDomainsToCloudflare([domain(1, "example.com")]);

    expect(report.status).toBe("ran");
    expect(report.bound).toEqual([
      { domainId: 1, domain: "example.com", accountId: 7, zoneId: "zone-a" },
    ]);
    // Без `cloudflare_zone_id` привязка не даёт главного: вкладке NS
    // по-прежнему нечего пушить регистратору. Поэтому `PUT /domains/{id}`, а не
    // роут `bulk-assign-cloudflare`, который знает только аккаунт.
    expect(mocks.apiPut).toHaveBeenCalledWith("/domains/1", {
      cloudflare_account_id: 7,
      cloudflare_zone_id: "zone-a",
    });
  });

  it("уже привязанный домен не трогает и за зонами ради него не ходит", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "example.com" }] });

    const report = await autoBindDomainsToCloudflare([domain(1, "example.com", 42)]);

    expect(report.status).toBe("nothing-to-do");
    expect(report.skipped).toBe(1);
    expect(mocks.apiPut).not.toHaveBeenCalled();
    // Ни зон, ни даже списка аккаунтов: привязывать нечего, и платить за это
    // походом в Cloudflare не за что.
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it("совпадение в двух аккаунтах не пишет ничего", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main"), account(9, "second")]);
    zonesByAccount({
      "7": [{ id: "zone-a", name: "example.com" }],
      "9": [{ id: "zone-x", name: "example.com" }],
    });

    const report = await autoBindDomainsToCloudflare([domain(1, "example.com")]);

    expect(report.bound).toEqual([]);
    expect(report.ambiguous).toEqual([{ domainId: 1, domain: "example.com", accountIds: [7, 9] }]);
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("непрочитанный аккаунт не роняет прогон и попадает в отчёт", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main"), account(9, "broken")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "example.com" }] });

    const report = await autoBindDomainsToCloudflare([
      domain(1, "example.com"),
      domain(2, "unknown.com"),
    ]);

    // Истёкший токен на одном из аккаунтов не должен означать «привязать
    // нельзя ничего».
    expect(report.bound.map((b) => b.domainId)).toEqual([1]);
    expect(report.none.map((n) => n.domainId)).toEqual([2]);
    // …но «совпадений нет» для домена 2 теперь не окончательно: его зона могла
    // лежать именно в непрочитанном аккаунте.
    expect(report.unreadAccounts).toHaveLength(1);
    expect(report.unreadAccounts[0].accountId).toBe(9);
    expect(report.unreadAccounts[0].name).toBe("broken");
    expect(report.unreadAccounts[0].error).toMatch(/token invalid/);
  });

  it("провал записи по одному домену не останавливает остальные", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({
      "7": [
        { id: "zone-a", name: "a.com" },
        { id: "zone-b", name: "b.com" },
        { id: "zone-c", name: "c.com" },
      ],
    });
    mocks.apiPut.mockImplementation(async (url: string) => {
      if (url === "/domains/2") throw new Error("409 conflict");
      return {};
    });

    const report = await autoBindDomainsToCloudflare([
      domain(1, "a.com"),
      domain(2, "b.com"),
      domain(3, "c.com"),
    ]);

    expect(report.bound.map((b) => b.domainId)).toEqual([1, 3]);
    // «Не удалось записать» — это не «нет совпадения»: повторять прогон надо
    // именно по этому домену, и зона у него нашлась.
    expect(report.writeFailed).toEqual([
      { domainId: 2, domain: "b.com", error: "409 conflict" },
    ]);
    expect(report.none).toEqual([]);
  });

  it("не перезаписывает привязку, появившуюся уже после старта прогона", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "a.com" }] });
    // Список страницы говорит: домен уже за аккаунтом 42. Это свежее входного
    // снимка — так выглядит «Assign CF», нажатый пока прогон читал зоны.
    queryClient.setQueryData(domainsKeys.list(), [
      { id: 1, domain_name: "a.com", cloudflare_account_id: 42 },
    ]);

    const report = await autoBindDomainsToCloudflare([domain(1, "a.com")]);

    // Выбор пользователя остаётся на месте, и домен не выдаётся за
    // привязанный этим прогоном.
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(report.bound).toEqual([]);
    expect(report.skipped).toBe(1);
  });

  it("замечает чужую привязку, случившуюся посреди очереди записи", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    const names = ["a.com", "b.com", "c.com", "d.com", "e.com"];
    zonesByAccount({ "7": names.map((n, i) => ({ id: `zone-${i + 1}`, name: n })) });
    queryClient.setQueryData(
      domainsKeys.list(),
      names.map((n, i) => ({ id: i + 1, domain_name: n, cloudflare_account_id: null })),
    );
    mocks.apiPut.mockImplementation(async (url: string) => {
      if (url === "/domains/1") {
        // Пятый домен уходит за чужим аккаунтом, пока очередь ещё работает:
        // конкурентность 4, так что до него дело дойдёт только после этой
        // записи. Проверка свежести стоит перед КАЖДЫМ `PUT` именно поэтому —
        // разовой проверки на старте очереди тут не хватило бы.
        queryClient.setQueryData(
          domainsKeys.list(),
          names.map((n, i) => ({
            id: i + 1,
            domain_name: n,
            cloudflare_account_id: i === 4 ? 42 : null,
          })),
        );
      }
      return {};
    });

    const report = await autoBindDomainsToCloudflare(
      names.map((n, i) => domain(i + 1, n)),
    );

    expect(mocks.apiPut.mock.calls.map((c: any[]) => c[0]).sort()).toEqual([
      "/domains/1",
      "/domains/2",
      "/domains/3",
      "/domains/4",
    ]);
    expect(report.bound.map((b) => b.domainId).sort()).toEqual([1, 2, 3, 4]);
    expect(report.skipped).toBe(1);
  });

  it("без кэша списка доменов пишет по входному снимку, а не отказывается", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "a.com" }] });
    // Кэша нет — прогон запущен со страницы, где список ещё не загружен.
    // Свежее снимка у нас в этом случае ничего нет, и отказ писать означал бы
    // «не привязали ничего» на ровном месте.
    expect(queryClient.getQueryData(domainsKeys.list())).toBeUndefined();

    const report = await autoBindDomainsToCloudflare([domain(1, "a.com")]);

    expect(report.bound.map((b) => b.domainId)).toEqual([1]);
  });

  it("зоны читаются один раз на аккаунт, сколько бы ни было доменов", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    const zones = Array.from({ length: 50 }, (_, i) => ({ id: `z${i}`, name: `d${i}.com` }));
    zonesByAccount({ "7": zones });

    const domains = Array.from({ length: 50 }, (_, i) => domain(i + 1, `d${i}.com`));
    const report = await autoBindDomainsToCloudflare(domains);

    expect(report.bound).toHaveLength(50);
    // `cf_list_zones` ходит в Cloudflare с пагинацией: запрос на домен
    // превратил бы прогон по сотне доменов в сотню полных вычиток.
    const listCalls = mocks.invokeSynced.mock.calls.filter((c: any[]) => c[0] === "cf_list_zones");
    expect(listCalls).toHaveLength(1);
    expect(mocks.apiPut).toHaveBeenCalledTimes(50);
  });

  it("не запускает все записи разом", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    const zones = Array.from({ length: 20 }, (_, i) => ({ id: `z${i}`, name: `d${i}.com` }));
    zonesByAccount({ "7": zones });

    let inFlight = 0;
    let peak = 0;
    mocks.apiPut.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {};
    });

    await autoBindDomainsToCloudflare(
      Array.from({ length: 20 }, (_, i) => domain(i + 1, `d${i}.com`)),
    );

    // Двести одновременных PUT в один бэкенд — это не «быстрее», это очередь,
    // в которой встаёт и всё остальное, чем пользователь занят на странице.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("сбрасывает список доменов один раз, а не на каждую привязку", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({
      "7": [
        { id: "zone-a", name: "a.com" },
        { id: "zone-b", name: "b.com" },
      ],
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await autoBindDomainsToCloudflare([domain(1, "a.com"), domain(2, "b.com")]);

    const domainInvalidations = invalidate.mock.calls.filter(
      (c: any[]) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(["domains"]),
    );
    expect(domainInvalidations).toHaveLength(1);
    invalidate.mockRestore();
  });

  it("прогон, не привязавший ничего, не дёргает список доменов", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "main")]);
    zonesByAccount({ "7": [{ id: "zone-a", name: "other.com" }] });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const report = await autoBindDomainsToCloudflare([domain(1, "a.com")]);

    expect(report.bound).toEqual([]);
    // Перезапрос списка на две сотни строк ради прогона, который ничего не
    // изменил, — это работа впустую на каждом заведённом домене.
    expect(
      invalidate.mock.calls.filter(
        (c: any[]) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(["domains"]),
      ),
    ).toHaveLength(0);
    invalidate.mockRestore();
  });

  it("без активных аккаунтов не ходит за зонами вовсе", async () => {
    mocks.apiGet.mockResolvedValue([account(7, "off", false)]);

    const report = await autoBindDomainsToCloudflare([domain(1, "example.com")]);

    expect(report.status).toBe("no-accounts");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });

  it("в вебе не делает ни одного запроса", async () => {
    setTauri(false);
    mocks.apiGet.mockResolvedValue([account(7, "main")]);

    const report = await autoBindDomainsToCloudflare([domain(1, "example.com")]);

    // Зоны живут только в десктопе (`cf_list_zones`), поэтому в вебе шага нет
    // вовсе — ни запросов, ни ошибок.
    expect(report.status).toBe("not-desktop");
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
    expect(mocks.apiGet).not.toHaveBeenCalled();
    expect(mocks.apiPut).not.toHaveBeenCalled();
  });
});

function report(over: Partial<CfBindReport> = {}): CfBindReport {
  return {
    status: "ran",
    bound: [],
    none: [],
    ambiguous: [],
    writeFailed: [],
    unreadAccounts: [],
    skipped: 0,
    ...over,
  };
}

describe("summarizeCfBind", () => {
  it("называет и привязанные, и оставшиеся без зоны", () => {
    const notice = summarizeCfBind(
      report({
        bound: [{ domainId: 1, domain: "a.com", accountId: 7, zoneId: "z" }],
        none: [{ domainId: 2, domain: "b.com" }],
      }),
      "auto",
    );

    // «Без зоны» — числом, а не вычитанием из «N of M»: причин «не привязано»
    // три, и считать их в уме читателю нечем.
    expect(notice).toEqual({
      kind: "info",
      text: "Cloudflare: 1 of 2 linked, 1 with no matching zone.",
    });
  });

  it("полууспех произносит вслух и помечает как предупреждение", () => {
    const notice = summarizeCfBind(
      report({
        bound: [{ domainId: 1, domain: "a.com", accountId: 7, zoneId: "z" }],
        ambiguous: [{ domainId: 2, domain: "b.com", accountIds: [7, 9] }],
        writeFailed: [{ domainId: 3, domain: "c.com", error: "409" }],
      }),
      "auto",
    );

    // Три разные причины «не привязано», слитые в одно число, перестали бы
    // отвечать на вопрос «а что делать дальше».
    expect(notice?.kind).toBe("warn");
    expect(notice?.text).toContain("1 of 3 linked");
    expect(notice?.text).toContain("1 matched in more than one account");
    expect(notice?.text).toContain("1 could not be saved");
  });

  it("про непрочитанные аккаунты оговаривается, что «совпадений нет» не окончательно", () => {
    const notice = summarizeCfBind(
      report({
        none: [{ domainId: 2, domain: "b.com" }],
        unreadAccounts: [{ accountId: 9, name: "broken", error: "token invalid" }],
      }),
      "auto",
    );

    // Без этой фразы «совпадений нет» врало бы про домен, зона которого лежит
    // именно в непрочитанном аккаунте.
    expect(notice?.kind).toBe("warn");
    expect(notice?.text).toContain("could not be read");
    expect(notice?.text).toContain("broken: token invalid");
    expect(notice?.text).toContain('"no match" is not final');
  });

  it("после создания домена молчит, когда прогон ничего не изменил", () => {
    // Подключил Cloudflare, зоны заведёт потом — и на КАЖДЫЙ добавленный домен
    // получал «0 of 1 linked, 1 with no matching zone», который ещё и надо
    // закрывать крестиком. Обязанность отчитаться берётся из того, что привязка
    // меняет данные не спрашивая; здесь менять было нечего.
    expect(summarizeCfBind(report({ none: [{ domainId: 1, domain: "a.com" }] }), "auto")).toBeNull();
    // …а по кнопке ответ есть: молчащая кнопка неотличима от сломанной.
    expect(summarizeCfBind(report({ none: [{ domainId: 1, domain: "a.com" }] }), "manual")?.text)
      .toContain("0 of 1 linked");
  });

  it("после создания домена говорит, как только что-то произошло", () => {
    // Обратная сторона того же правила: одна привязка — уже изменение данных,
    // о котором пользователя не спрашивали.
    const bound = summarizeCfBind(
      report({ bound: [{ domainId: 1, domain: "a.com", accountId: 7, zoneId: "z" }] }),
      "auto",
    );
    expect(bound?.text).toContain("1 of 1 linked");
    // Непрочитанный аккаунт — тоже повод заговорить: «совпадений нет» при нём
    // неокончательно, и умолчать об этом нельзя.
    const unread = summarizeCfBind(
      report({
        none: [{ domainId: 1, domain: "a.com" }],
        unreadAccounts: [{ accountId: 9, name: "broken", error: "token invalid" }],
      }),
      "auto",
    );
    expect(unread?.kind).toBe("warn");
  });

  it("про набор, разобранный по дороге, говорит «нечего делать», а не «0 of 0»", () => {
    // Единственный кандидат оказался занят чужой привязкой, пока шёл прогон
    // (`isStillUnbound`), — и рассматривать стало нечего. «Cloudflare: 0 of 0
    // linked, 1 already linked» формально не врёт, но читается как поломка
    // счётчика; новость же ровно та, что и до старта прогона.
    const notice = summarizeCfBind(report({ skipped: 1 }), "manual");

    expect(notice).toEqual({
      kind: "info",
      text: "Cloudflare: nothing to do — all 1 selected domain(s) are already linked.",
    });
  });

  it("длинную чужую ошибку обрезает", () => {
    const notice = summarizeCfBind(
      report({
        none: [{ domainId: 1, domain: "a.com" }],
        unreadAccounts: [{ accountId: 9, name: "broken", error: "x".repeat(500) }],
      }),
      "manual",
    );

    // Текст приезжает из `e.to_string()` в Rust и в пределе может оказаться
    // телом ответа Cloudflare. В тосте (2200 мс) такой отчёт не прочитать
    // вовсе — ни чисел, ни оговорки про непрочитанные аккаунты.
    expect(notice!.text.length).toBeLessThan(300);
    expect(notice!.text).toContain("…");
    expect(notice!.text).toContain('"no match" is not final');
  });

  it("провал прогона тоже говорит словами и тоже обрезает ошибку", () => {
    const notice = summarizeCfBindFailure(new Error("y".repeat(400)));

    // Единственный путь, который бросает, — чтение списка аккаунтов; в десктопе
    // текст приезжает через прокси `api_request` и в пределе может быть телом
    // ответа. Пока строка собиралась на странице, обрезки у неё не было.
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("could not match zones");
    expect(notice.text.length).toBeLessThan(200);
    expect(notice.text).toContain("…");
  });

  it("после создания домена молчит, когда прогона не было", () => {
    // «Cloudflare: аккаунтов нет» после каждого заведённого домена — это шум
    // тому, кто Cloudflare не пользуется вовсе.
    expect(summarizeCfBind(report({ status: "no-accounts" }), "auto")).toBeNull();
    expect(summarizeCfBind(report({ status: "nothing-to-do", skipped: 1 }), "auto")).toBeNull();
    expect(summarizeCfBind(report({ status: "not-desktop" }), "auto")).toBeNull();
  });

  it("по кнопке отвечает всегда, кроме веба", () => {
    // Кнопка, которая молчит, не отличима от сломанной.
    expect(summarizeCfBind(report({ status: "no-accounts" }), "manual")?.kind).toBe("warn");
    expect(summarizeCfBind(report({ status: "nothing-to-do", skipped: 3 }), "manual")?.text).toContain(
      "all 3 selected domain(s) are already linked",
    );
    // …а в вебе кнопки нет вовсе — говорить не о чем и некому.
    expect(summarizeCfBind(report({ status: "not-desktop" }), "manual")).toBeNull();
  });
});
