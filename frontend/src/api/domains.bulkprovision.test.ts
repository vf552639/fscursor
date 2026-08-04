import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  PROVISION_DOMAIN_KEY,
  runBulkProvisionDomains,
  runProvisionDomain,
  summarizeBulkProvision,
  type BulkProvisionDesktopResult,
} from "./domains";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Массовый provision по `sdmp://bulk-provision`.
 *
 * Проверяется ровно то, ради чего фаза затевалась: результат каждого домена
 * доходит наружу (на каждом создаётся FTP-аккаунт, чей пароль возвращается
 * только в этом ответе), обрыв на середине не уносит уже созданное, «прогон уже
 * был» произносится словами, и оба конца подоменного гейта соблюдены.
 */

const mocks = vi.hoisted(() => ({ invokeSynced: vi.fn() }));

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

function doneItem(id: string, password: string) {
  return {
    domain_id: id,
    outcome: "done" as const,
    result: {
      domain_id: id,
      site_user: `site_${id}`,
      site_path: `/var/www/site_${id}`,
      ssl_issued: true,
      ftp: { ftp_user: `ftp_${id}`, ftp_password: password },
    },
  };
}

function report(over: Partial<BulkProvisionDesktopResult>): BulkProvisionDesktopResult {
  return { idempotency_key: "k", status: "ok", items: [], ...over };
}

/** Пароли из отчёта — те, что не имеют права осесть нигде, кроме экрана. */
const SECRETS = ["PW-1", "PW-2"];

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  queryClient.getMutationCache().clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({ ...base, mutations: { ...base.mutations, retry: false } });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  setTauri(true);
});

afterEach(() => {
  queryClient.clear();
  queryClient.getMutationCache().clear();
  useAuthStore.getState().clear();
  setTauri(false);
  vi.restoreAllMocks();
});

describe("runBulkProvisionDomains — отчёт вместо ключа идемпотентности", () => {
  it("отдаёт пароль каждого отработавшего домена, ошибку упавшего и хвост незапущенных", async () => {
    mocks.invokeSynced.mockResolvedValue(
      report({
        status: "failed",
        error: "failed on domain 2: ssh: connect: refused",
        items: [
          doneItem("1", "PW-1"),
          { domain_id: "2", outcome: "failed", error: "ssh: connect: refused" },
          { domain_id: "3", outcome: "skipped" },
        ],
      }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1", "2", "3"]);

    // Домен 1 отработал ДО обрыва: его FTP-аккаунт на сервере уже создан, и
    // пароль к нему существует только здесь. Раньше цикл делал `return Err` и
    // уносил его вместе с провалом домена 2.
    expect(out.results).toHaveLength(1);
    expect(out.results[0].domain).toBe("#1");
    expect(out.results[0].result.ftp?.ftp_password).toBe("PW-1");
    // Упавший назван причиной, незапущенный — отличим от упавшего.
    expect(out.failed).toEqual([{ domainId: "2", error: "ssh: connect: refused" }]);
    expect(out.skipped).toEqual(["3"]);
    expect(out.status).toBe("failed");
  });

  it("говорит словами, что прогон уже был и паролей у него нет", async () => {
    mocks.invokeSynced.mockResolvedValue(
      report({
        status: "already_ran",
        items: [
          { domain_id: "1", outcome: "skipped" },
          { domain_id: "2", outcome: "skipped" },
        ],
      }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1", "2"]);

    expect(out.status).toBe("already_ran");
    expect(out.results).toHaveLength(0);
    // Пустой успех выглядел бы как «готово», хотя показать пароли уже некому.
    const text = summarizeBulkProvision(out);
    expect(text).toMatch(/already happened/i);
    expect(text).toMatch(/cannot be shown a second time/i);
  });

  it("тост про исход не содержит ни одного пароля", async () => {
    const out = await (async () => {
      mocks.invokeSynced.mockResolvedValue(
        report({
          status: "failed",
          items: [
            doneItem("1", "PW-1"),
            { domain_id: "2", outcome: "failed", error: "boom" },
            { domain_id: "3", outcome: "skipped" },
          ],
        }),
      );
      return runBulkProvisionDomains("user-1", ["1", "2", "3"]);
    })();

    const text = summarizeBulkProvision(out);
    expect(text).toContain("1 provisioned");
    expect(text).toContain("1 failed");
    expect(text).toContain("1 not started");
    expect(text).toContain("#2: boom");
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it("не пишет пароли ни в кэш мутаций, ни в storage, ни в консоль", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    mocks.invokeSynced.mockResolvedValue(
      report({ items: [doneItem("1", "PW-1"), doneItem("2", "PW-2")] }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1", "2"]);
    // Пароли действительно пришли — иначе «нигде нет» ничего не доказывает.
    expect(out.results.map((r) => r.result.ftp?.ftp_password)).toEqual(SECRETS);

    // ОБЯЗАТЕЛЬНО дождаться, пока заявки гейта осядут. `release()` вызывается в
    // `finally`, но их `mutationFn` дорезолвливается микротаском позже, и до
    // этого момента `state.data` у КАЖДОЙ мутации — `undefined`. Дамп, снятый
    // сразу после `await`, смотрел бы в состояние, где пароля не может быть в
    // принципе, и проходил бы при любой реализации (проверено: заявка,
    // резолвящаяся полным отчётом, оставляла тест зелёным).
    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
    const settled = queryClient.getMutationCache().getAll();
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every((m) => m.state.data !== undefined)).toBe(true);

    // Кэш мутаций переживает `reset()` ещё gcTime — попав туда, пароль лежал бы
    // в памяти минутами и уехал бы в любой дамп состояния.
    const cacheDump = JSON.stringify(
      settled.map((m) => ({ state: m.state, options: { mutationKey: m.options.mutationKey } })),
    );
    const consoleDump = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const s of SECRETS) {
      expect(cacheDump).not.toContain(s);
      expect(JSON.stringify(localStorage)).not.toContain(s);
      expect(JSON.stringify(sessionStorage)).not.toContain(s);
      expect(consoleDump).not.toContain(s);
    }
  });
});

describe("runBulkProvisionDomains — подоменный гейт", () => {
  it("не стартует, пока по одному из его доменов уже идёт одиночный provision", async () => {
    let finishSingle: (v: unknown) => void = () => {};
    mocks.invokeSynced.mockImplementation(
      () => new Promise((resolve) => (finishSingle = resolve)),
    );
    const single = runProvisionDomain({ domainId: 2, domainName: "b.com", withDb: false });

    await expect(runBulkProvisionDomains("user-1", ["1", "2"])).rejects.toThrow(/#2/);
    // И по SSH никто второй раз не полез: вызов ровно один — одиночный.
    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);

    finishSingle({ domain_id: "2", site_user: "u", site_path: "/p" });
    await single;
  });

  it("на время прогона занимает гейт по каждому домену набора", async () => {
    let finishBulk: (v: unknown) => void = () => {};
    mocks.invokeSynced.mockImplementation(
      () => new Promise((resolve) => (finishBulk = resolve)),
    );

    const bulk = runBulkProvisionDomains("user-1", ["1", "2"]);
    // Ждать нечего: `Mutation.execute` переводит мутацию в `pending`
    // синхронно, до первого `await` внутри `mutationFn` (query-core 5.100.9,
    // `mutation.ts`). Гейт обязан закрыться в тот же тик, что и старт прогона,
    // иначе между ними помещается второй запуск.
    const pending = queryClient
      .getMutationCache()
      .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" })
      .map((m) => (m.state.variables as { domainId: number }).domainId);
    // Именно это читает страница `Domains`, гася ⚙ на строке домена.
    expect(pending).toContain(1);
    expect(pending).toContain(2);

    // И встречная сторона: ссылка/кнопка по домену из набора не откроет вторую
    // SSH-сессию, пока bulk не отпустит.
    await expect(
      runProvisionDomain({ domainId: 1, domainName: "a.com", withDb: false }),
    ).rejects.toThrow(/already running/i);

    finishBulk(report({ items: [doneItem("1", "PW-1"), doneItem("2", "PW-2")] }));
    await bulk;

    // После прогона гейт отпущен — иначе ⚙ не включится уже никогда.
    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
  });

  it("отпускает гейт и когда прогон упал целиком", async () => {
    mocks.invokeSynced.mockRejectedValue(new Error("locked"));

    await expect(runBulkProvisionDomains("user-1", ["1"])).rejects.toThrow("locked");

    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
  });
});
