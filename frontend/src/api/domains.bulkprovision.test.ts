import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  PROVISION_DOMAIN_KEY,
  runBulkProvisionDomains,
  runProvisionDomain,
  summarizeBulkProvision,
  type BulkProvisionDesktopResult,
  type ProvisionOutcome,
} from "./domains";
import { onlineManager } from "@tanstack/react-query";

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
      ftp: { status: "created" as const, ftp_user: `ftp_${id}`, ftp_password: password },
    },
  };
}

/**
 * Пароль FTP из результата домена — `undefined`, если аккаунт уже существовал.
 *
 * Сужение по `status` тут не церемония: у варианта `exists` поля пароля нет в
 * типе вовсе (см. `ProvisionFtpResult`), и обратиться к нему напрямую — ошибка
 * компиляции. Это ровно та страховка, ради которой варианты и разведены.
 */
function ftpPasswordOf(r: ProvisionOutcome): string | undefined {
  const ftp = r.result.ftp;
  return ftp?.status === "created" ? ftp.ftp_password : undefined;
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
  // Менеджер сети общий на весь прогон тестов — оставить его выключенным значит
  // сломать соседние файлы.
  onlineManager.setOnline(true);
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
    expect(ftpPasswordOf(out.results[0])).toBe("PW-1");
    // Упавший назван причиной, незапущенный — отличим от упавшего.
    expect(out.failed).toEqual([{ domainId: "2", error: "ssh: connect: refused" }]);
    expect(out.skipped).toEqual(["3"]);
    expect(out.status).toBe("failed");
  });

  it("про завершённый прогон говорит, что его пароли уже не показать", async () => {
    mocks.invokeSynced.mockResolvedValue(
      report({
        status: "already_ran",
        previous_status: "done",
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
    expect(text).toMatch(/already provisioned by an earlier run/i);
    expect(text).toMatch(/cannot be shown again/i);
  });

  // Строка `running` снимается только явными ветками внутри процесса, поэтому
  // она остаётся и после краша посреди прогона. Сказать про неё «пароли уже
  // показаны» — соврать дважды: прогон не прошёл, и паролей никто не видел.
  it("про незакрытый прогон НЕ утверждает, что его пароли уже показывали", async () => {
    mocks.invokeSynced.mockResolvedValue(
      report({
        status: "already_ran",
        previous_status: "running",
        items: [{ domain_id: "1", outcome: "skipped" }],
      }),
    );

    const out = await runBulkProvisionDomains("user-1", ["1"]);

    expect(out.previousStatus).toBe("running");
    const text = summarizeBulkProvision(out);
    expect(text).toMatch(/in progress/i);
    expect(text).toMatch(/interrupted/i);
    expect(text).not.toMatch(/cannot be shown/i);
    expect(text).not.toMatch(/already provisioned/i);
  });

  // Ключ прогона — единственное, чем пользователь может назвать проблему в
  // поддержке: команда адресует прогон только им.
  it("доносит ключ идемпотентности до вызывающего", async () => {
    mocks.invokeSynced.mockResolvedValue(
      report({ idempotency_key: "abc123", items: [doneItem("1", "PW-1")] }),
    );
    const out = await runBulkProvisionDomains("user-1", ["1"]);
    expect(out.idempotencyKey).toBe("abc123");
  });

  // `ids=1,1,1` заводил три заявки гейта на один домен и трижды провижинил его:
  // три FTP-аккаунта под одним логином, из которых рабочий — последний.
  it("схлопывает дубликаты id из ссылки", async () => {
    mocks.invokeSynced.mockResolvedValue(report({ items: [doneItem("1", "PW-1")] }));

    await runBulkProvisionDomains("user-1", ["1", "1", "1"]);

    expect(mocks.invokeSynced).toHaveBeenCalledTimes(1);
    expect(mocks.invokeSynced.mock.calls[0][1]).toMatchObject({ domainIds: ["1"] });
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
    expect(out.results.map(ftpPasswordOf)).toEqual(SECRETS);

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
    // Именно это читает страница `Domains`, гася кнопку `Provision` на вкладке
    // Server карточки домена.
    expect(pending).toContain(1);
    expect(pending).toContain(2);

    // И встречная сторона: ссылка/кнопка по домену из набора не откроет вторую
    // SSH-сессию, пока bulk не отпустит.
    await expect(
      runProvisionDomain({ domainId: 1, domainName: "a.com", withDb: false }),
    ).rejects.toThrow(/already running/i);

    finishBulk(report({ items: [doneItem("1", "PW-1"), doneItem("2", "PW-2")] }));
    await bulk;

    // После прогона гейт отпущен — иначе кнопка `Provision` не включится уже
    // никогда.
    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
  });

  // Провал на середине набора оставил бы уже поставленные заявки висеть вечно,
  // то есть навсегда погасил бы кнопку `Provision` на карточках части доменов.
  it("не оставляет висеть заявки, если гейт не удалось занять целиком", async () => {
    const cache = queryClient.getMutationCache();
    const realBuild = cache.build.bind(cache);
    let calls = 0;
    vi.spyOn(cache, "build").mockImplementation(((...args: Parameters<typeof realBuild>) => {
      calls += 1;
      if (calls === 2) throw new Error("cache exploded");
      return realBuild(...args);
    }) as typeof realBuild);

    await expect(runBulkProvisionDomains("user-1", ["1", "2"])).rejects.toThrow("cache exploded");

    await vi.waitFor(() =>
      expect(
        cache.findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
    // И по SSH при этом никто не пошёл.
    expect(mocks.invokeSynced).not.toHaveBeenCalled();
  });

  // `navigator.onLine === false` — это про сеть БРАУЗЕРА, а провижн идёт по SSH
  // из десктопа. С дефолтным `networkMode: "online"` retryer ставит заявку в
  // `pending` и не зовёт её `mutationFn` вовсе: `held` никто не ждёт, `release()`
  // резолвит промис в пустоту, и заявка висит `pending` до возвращения сети —
  // кнопка `Provision` читается как «Provisioning…» бесконечно, а каждый
  // повтор отвечает «already running», и снять это из UI нечем.
  it("не залипает заявками, когда браузер считает себя оффлайном", async () => {
    onlineManager.setOnline(false);
    mocks.invokeSynced.mockResolvedValue(report({ items: [doneItem("1", "PW-1")] }));

    const out = await runBulkProvisionDomains("user-1", ["1"]);
    expect(out.results).toHaveLength(1);

    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: PROVISION_DOMAIN_KEY, status: "pending" }),
      ).toHaveLength(0),
    );
    // И гейт снова открыт: следующий прогон по тому же домену стартует.
    await expect(runBulkProvisionDomains("user-1", ["1"])).resolves.toBeTruthy();
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
