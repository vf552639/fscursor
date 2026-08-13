import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  FullSetupDesktopResult,
  FullSetupReport,
  bulkFullSetup,
  summarizeFullSetup,
} from "./fullSetup";
import { queryClient } from "./queryClient";
import { FullSetupPlan } from "../lib/fullSetupPlan";
import { useAuthStore } from "../store/auth";

/**
 * Прогон полной настройки и его отчёт.
 *
 * Две вещи проверяются здесь, а не через страницу, потому что цена ошибки в них
 * не про вёрстку: остановка пачки на `Err` (иначе сто доменов стучатся в
 * запертый keychain) и текст отчёта (иначе о зоне, которую SDMP не записала,
 * пользователь не узнаёт вовсе).
 */

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPost: mocks.apiPost,
}));

vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  syncLocalCache: vi.fn(async () => {}),
}));

const PLAN: FullSetupPlan & { serverId: number } = {
  serverId: 5,
  cloudflareAccountId: 7,
  registrarId: 3,
  createZone: true,
  pushNs: true,
};

function okResult(id: number, patch: Partial<FullSetupDesktopResult> = {}): FullSetupDesktopResult {
  return {
    domain_id: String(id),
    zone: { status: "created", zone_id: `z${id}`, name_servers: ["a.ns", "b.ns"] },
    zone_saved: true,
    ns: { status: "pushed", nameservers: ["a.ns", "b.ns"] },
    ...patch,
  };
}

/** Отчёт удавшегося прогона по одному домену — основа для правок в тестах. */
function ranReport(patch: Partial<Extract<FullSetupReport, { outcome: "ran" }>> = {}): FullSetupReport {
  return {
    outcome: "ran",
    requested: 1,
    linked: 1,
    skipped: 0,
    steps: "ran",
    items: [{ domain: "a.com", result: okResult(1) }],
    aborted: null,
    ...patch,
  };
}

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  setTauri(true);
});

afterEach(() => {
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("bulkFullSetup — прогон по пачке", () => {
  it("связки бэкендом, затем команда на каждый связанный домен", async () => {
    mocks.apiPost.mockResolvedValue({
      domains: [
        { id: 1, domain_name: "a.com" },
        { id: 2, domain_name: "b.com" },
      ],
      skipped_ids: [9],
    });
    mocks.invokeIfTauri.mockImplementation(async (_cmd: string, args: any) =>
      okResult(Number(args.domainId)),
    );

    const report = await bulkFullSetup([1, 2, 9], PLAN);

    // Лишнего поля в теле нет: схема запроса объявлена с `extra="forbid"`, и
    // `registrar_id: null` стоил бы всей пачке 422.
    expect(mocks.apiPost).toHaveBeenCalledWith("/domains/full-setup", {
      domain_ids: [1, 2, 9],
      server_id: 5,
      cloudflare_account_id: 7,
      registrar_id: 3,
    });
    expect(mocks.invokeIfTauri).toHaveBeenCalledTimes(2);
    expect(mocks.invokeIfTauri.mock.calls[0]).toEqual([
      "domain_full_setup",
      {
        userId: "user-1",
        domainId: "1",
        domainName: "a.com",
        cloudflareAccountId: "7",
        registrarAccountId: "3",
        pushNs: true,
      },
    ]);
    expect(report).toMatchObject({ outcome: "ran", linked: 2, skipped: 1, steps: "ran" });
  });

  it("невыбранный регистратор не уезжает полем вовсе", async () => {
    mocks.apiPost.mockResolvedValue({ domains: [], skipped_ids: [] });
    await bulkFullSetup([1], { ...PLAN, registrarId: null });
    expect(mocks.apiPost.mock.calls[0][1]).not.toHaveProperty("registrar_id");
  });

  it("провал связок — ветка отчёта, а не исключение", async () => {
    mocks.apiPost.mockRejectedValue(new Error("500 server error"));
    const report = await bulkFullSetup([1, 2], PLAN);
    expect(report).toEqual({ outcome: "link-failed", requested: 2, error: "500 server error" });
    // В Cloudflare не ходили: связок нет, настраивать нечего.
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("выключенный тумблер зоны оставляет прогон на связках", async () => {
    mocks.apiPost.mockResolvedValue({ domains: [{ id: 1, domain_name: "a.com" }], skipped_ids: [] });
    const report = await bulkFullSetup([1], { ...PLAN, createZone: false, pushNs: false });
    expect(report).toMatchObject({ steps: "not-requested" });
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("`Err` команды останавливает прогон, а не даёт сто одинаковых строк", async () => {
    const targets = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, domain_name: `d${i + 1}.com` }));
    mocks.apiPost.mockResolvedValue({ domains: targets, skipped_ids: [] });
    mocks.invokeIfTauri.mockImplementation(async (_cmd: string, args: any) => {
      // Запертый сейф: условие машины, одинаковое для всех пяти доменов.
      if (args.domainId === "1") throw new Error("keychain: locked");
      return okResult(Number(args.domainId));
    });

    const report = await bulkFullSetup([1, 2, 3, 4, 5], PLAN);

    // Успели уйти только задачи, начатые до отказа (предел конкуренции), —
    // остальные не начинались вовсе.
    expect(mocks.invokeIfTauri).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      outcome: "ran",
      aborted: { domain: "d1.com", error: "keychain: locked", notSetUp: 4 },
    });
    const notice = summarizeFullSetup(report);
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("The run stopped on d1.com: keychain: locked.");
    expect(notice.text).toContain("4 domain(s) were not set up.");
  });
});

describe("summarizeFullSetup — что читает пользователь", () => {
  it("всё сделано — тон спокойный и числа названы", () => {
    const notice = summarizeFullSetup(
      ranReport({
        requested: 2,
        linked: 2,
        items: [
          { domain: "a.com", result: okResult(1) },
          { domain: "b.com", result: okResult(2, { zone: { status: "existed", zone_id: "z2", name_servers: ["a.ns"] } }) },
        ],
      }),
    );
    expect(notice).toEqual({
      kind: "info",
      text: "Full setup: 2 of 2 linked, 1 zone(s) created, 1 zone(s) already existed, 2 NS pushed.",
    });
  });

  // Самый дорогой из полууспехов: зона в Cloudflare есть, а SDMP о ней не
  // знает. В построчном отчёте это утонуло бы, поэтому сказано отдельным
  // предложением и вместе с тем, что с этим делать.
  it("незаписанную зону поднимает в сводку отдельно", () => {
    const notice = summarizeFullSetup(
      ranReport({ items: [{ domain: "a.com", result: okResult(1, { zone_saved: false }) }] }),
    );
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("1 zone(s) exist in Cloudflare but are not recorded in SDMP");
    expect(notice.text).toContain("run full setup again");
  });

  it("пропущенный шаг NS называет причину и не считается успехом", () => {
    const notice = summarizeFullSetup(
      ranReport({
        items: [
          {
            domain: "a.com",
            result: okResult(1, { ns: { status: "skipped", reason: "registrar_no_ns_api" } }),
          },
        ],
      }),
    );
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("1 NS skipped (registrar has no NS API)");
  });

  it("выключенный тумблер NS новостью не является", () => {
    const notice = summarizeFullSetup(
      ranReport({
        items: [
          { domain: "a.com", result: okResult(1, { ns: { status: "skipped", reason: "not_requested" } }) },
        ],
      }),
    );
    expect(notice.kind).toBe("info");
    expect(notice.text).not.toContain("NS skipped");
  });

  it("отказ Cloudflare — строка отчёта с текстом первого провала", () => {
    const notice = summarizeFullSetup(
      ranReport({
        items: [
          {
            domain: "a.com",
            result: {
              domain_id: "1",
              zone: { status: "failed", error: "1061 zone already exists in another account" },
              zone_saved: null,
              ns: { status: "skipped", reason: "zone_unavailable" },
            },
          },
        ],
      }),
    );
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("1 zone(s) failed");
    expect(notice.text).toContain("First failure — a.com: 1061 zone already exists");
  });

  it("прогон, ничего не связавший, не рапортует успехом", () => {
    const notice = summarizeFullSetup(
      ranReport({ requested: 3, linked: 0, skipped: 3, steps: "nothing-to-run", items: [] }),
    );
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("none of the 3 selected domain(s) were found");
  });

  it("прогон на одних связках говорит, что шагов не было", () => {
    const notice = summarizeFullSetup(ranReport({ steps: "not-requested", items: [] }));
    expect(notice.kind).toBe("info");
    expect(notice.text).toContain("Zones and nameservers were not part of this run.");
  });

  it("провал связок сообщает, что не изменилось ничего", () => {
    const notice = summarizeFullSetup({ outcome: "link-failed", requested: 4, error: "422 unprocessable" });
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("nothing was changed");
    expect(notice.text).toContain("422 unprocessable");
  });
});
