import { describe, it, expect } from "vitest";

import {
  backupsOf,
  factsFreshness,
  FACTS_STALE_MS,
  isFactsStale,
  snapshotOf,
  SSL_BADGE,
  sslState,
  sslStateRank,
  type BackupsFacts,
  type DomainBackup,
  type DomainFacts,
} from "./domainFacts";

/**
 * Лестница SSL и порог свежести снимка — чистые функции, и проверяются они
 * отдельно от карточки, ровно как `serverStatus`: правило продукта («незнание
 * нельзя рисовать как здоровье») не должно зависеть от рендера одного экрана.
 *
 * Сердце этих тестов — асимметрия свежести: вывод о СРОКЕ переживает
 * протухание, вывод о НАЛИЧИИ — нет. Зелёный (`valid`) занят только под свежее
 * подтверждение.
 */

const NOW = new Date("2026-08-16T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();

/** Снимок SSL: по умолчанию — живой сертификат с далёким сроком. */
function ssl(over: Partial<DomainFacts["ssl"]> = {}): DomainFacts["ssl"] {
  return {
    has_certificate: true,
    expires_at: ahead(60 * DAY),
    issuer: "Let's Encrypt",
    is_letsencrypt: true,
    ...over,
  };
}

describe("isFactsStale", () => {
  it("неделя — ещё свежо, неделя с минутой — уже нет", () => {
    // Границу пишем числом, а не сверяемся с константой модуля: сверка
    // константы с самой собой зеленела бы при любом пороге.
    expect(isFactsStale(ago(FACTS_STALE_MS), NOW)).toBe(false);
    expect(isFactsStale(ago(FACTS_STALE_MS + MINUTE), NOW)).toBe(true);
  });

  it("снимка нет — это не «протухло»", () => {
    expect(isFactsStale(null, NOW)).toBe(false);
    expect(isFactsStale(undefined, NOW)).toBe(false);
  });

  it("мусор вместо даты не объявляется протухшим", () => {
    expect(isFactsStale("not-a-date", NOW)).toBe(false);
  });
});

describe("sslState — проверки не было ≠ здоров", () => {
  it("нет удачной проверки (нет времени снимка) → unchecked, никогда не valid", () => {
    expect(sslState(ssl(), null, NOW)).toBe("unchecked");
    expect(sslState(ssl(), undefined, NOW)).toBe("unchecked");
  });

  it("снимка ssl нет вовсе → unchecked", () => {
    expect(sslState(null, ago(HOUR), NOW)).toBe("unchecked");
    expect(sslState(undefined, ago(HOUR), NOW)).toBe("unchecked");
  });
});

describe("sslState — наличие сертификата протухает, срок нет", () => {
  it("свежий снимок без сертификата → missing", () => {
    expect(sslState(ssl({ has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false }), ago(HOUR), NOW)).toBe("missing");
  });

  it("протухший «сертификата нет» → unchecked, а не missing (за неделю мог выпуститься)", () => {
    expect(
      sslState(
        ssl({ has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false }),
        ago(FACTS_STALE_MS + DAY),
        NOW,
      ),
    ).toBe("unchecked");
  });

  it("свежий сертификат с далёким сроком → valid (зелёный только под свежее подтверждение)", () => {
    expect(sslState(ssl(), ago(HOUR), NOW)).toBe("valid");
  });

  it("сертификат есть, срок в порядке, но снимок протух → unchecked (наличие протухло)", () => {
    // Срок ещё не наступил, но сказать «валиден» нельзя: за неделю сертификат
    // могли отозвать или переставить. Наличие — не знание больше.
    expect(sslState(ssl(), ago(FACTS_STALE_MS + DAY), NOW)).toBe("unchecked");
  });

  it("протухший снимок, срок в прошлом → всё равно expired (вывод о сроке живёт дольше)", () => {
    // Неделю назад срок истекал через 3 дня — значит сейчас точно истёк.
    expect(sslState(ssl({ expires_at: ago(4 * DAY) }), ago(FACTS_STALE_MS + DAY), NOW)).toBe("expired");
  });

  it("протухший снимок, срок скоро → expiring, а не unchecked", () => {
    expect(sslState(ssl({ expires_at: ahead(5 * DAY) }), ago(FACTS_STALE_MS + DAY), NOW)).toBe("expiring");
  });
});

describe("sslState — сроки на свежем снимке", () => {
  it("срок в прошлом → expired", () => {
    expect(sslState(ssl({ expires_at: ago(DAY) }), ago(HOUR), NOW)).toBe("expired");
  });

  it("ровно сейчас → expired (граница включительно)", () => {
    expect(sslState(ssl({ expires_at: new Date(NOW).toISOString() }), ago(HOUR), NOW)).toBe("expired");
  });

  it("срок в пределах порога → expiring", () => {
    expect(sslState(ssl({ expires_at: ahead(10 * DAY) }), ago(HOUR), NOW)).toBe("expiring");
  });

  it("срок за порогом → valid", () => {
    expect(sslState(ssl({ expires_at: ahead(30 * DAY) }), ago(HOUR), NOW)).toBe("valid");
  });
});

describe("sslState — ошибка чтения", () => {
  it("ssl.error присутствует → error, даже на свежем снимке", () => {
    expect(sslState(ssl({ error: "openssl failed" }), ago(HOUR), NOW)).toBe("error");
  });

  it("ошибка сильнее наличия сертификата", () => {
    expect(sslState(ssl({ has_certificate: false, error: "openssl failed" }), ago(HOUR), NOW)).toBe("error");
  });
});

/** Снимок целиком: `snapshotOf` берёт из него только факты SSL-независимо. */
function facts(over: Partial<DomainFacts> = {}): DomainFacts {
  return {
    site: null,
    ssl: ssl(),
    ftp_accounts: [],
    php_version: null,
    php_handler: null,
    databases: [],
    logs: [],
    ...over,
  };
}

describe("SSL_BADGE — как состояние выглядит на экране", () => {
  it("вся карта дословно: и подписи, и цвета", () => {
    // Карту не проверял НИКТО: три таблицы тестов, которые её читают, берут
    // ожидаемую подпись из неё же — то есть сверяют карту с самой собой и
    // зеленеют при любой её правке. Переставь `unchecked` в зелёный, и
    // непроверенный домен рисовался бы здоровым, не уронив ни одного теста, —
    // ровно тот дефект, ради запрета которого написан принцип №6 CLAUDE.md.
    //
    // Целиком и `toEqual`, а не выборочно: правило звучит «серый у незнания,
    // ЗЕЛЁНЫЙ ТОЛЬКО у valid», и вторая половина проверяется лишь тем, что у
    // остальных пяти цвет назван поимённо. Новое состояние тоже обязано
    // приехать сюда — иначе оно попадёт на экран, ни разу не будучи названным.
    expect(SSL_BADGE).toEqual({
      unchecked: { label: "Not checked", variant: "gray" },
      missing: { label: "No certificate", variant: "red" },
      expired: { label: "Expired", variant: "red" },
      expiring: { label: "Expiring soon", variant: "yellow" },
      valid: { label: "Valid", variant: "green" },
      error: { label: "Read error", variant: "red" },
    });
  });
});

describe("sslStateRank — порядок колонки SSL", () => {
  it("лестница здоровья по возрастанию, отказ чтения — за её концом", () => {
    // Ранги записаны отношениями, а не числами: числа поменяются от любой
    // вставки состояния в середину, а «нет сертификата раньше валидного» —
    // не поменяется, и проверять надо именно это.
    const rank = (s: Parameters<typeof sslStateRank>[0]) => sslStateRank(s) as number;
    expect(rank("missing")).toBeLessThan(rank("expired"));
    expect(rank("expired")).toBeLessThan(rank("expiring"));
    expect(rank("expiring")).toBeLessThan(rank("valid"));
    // `error` — не ступень здоровья, а отказ измерения, и стоит он ПОСЛЕ
    // валидного: поднимает его второй клик по заголовку, ровно как второй клик
    // по Setup поднимает `failed`.
    expect(rank("valid")).toBeLessThan(rank("error"));
  });

  it("«не проверяли» — `null`, то есть в конец при ЛЮБОМ направлении", () => {
    // Числом «за концом лестницы» незнание переворачивалось бы вместе с
    // направлением и вторым кликом вставало бы наверх — то есть список
    // начинался бы с доменов, про которые ответа нет вовсе.
    expect(sslStateRank("unchecked")).toBeNull();
  });

  it("ранг есть у КАЖДОГО состояния, кроме незнания", () => {
    // Иначе новое состояние молча получит `null` и уедет в конец списка
    // вместе с непроверенными — на экране это неотличимо от порядка.
    const ranked = (Object.keys(SSL_BADGE) as (keyof typeof SSL_BADGE)[])
      .filter((s) => sslStateRank(s) !== null)
      .sort();
    expect(ranked).toEqual(["error", "expired", "expiring", "missing", "valid"]);
  });
});

describe("factsFreshness — возраст снимка словами", () => {
  it("снимка не было — «Never checked», а не «0m ago»", () => {
    // Выдуманный возраст хуже отсутствия: «just now» у домена, которого не
    // читали ни разу, — это здоровье, нарисованное на месте незнания.
    expect(factsFreshness(null, NOW)).toBe("Never checked");
    expect(factsFreshness(undefined, NOW)).toBe("Never checked");
  });

  it("свежий снимок — возраст без пометки, протухший — с пометкой", () => {
    expect(factsFreshness(ago(HOUR), NOW)).toBe("Checked 1h ago");
    expect(factsFreshness(ago(FACTS_STALE_MS + MINUTE), NOW)).toBe("Checked 7d ago · stale");
  });

  it("та же подпись, что собирает `snapshotOf` — одна на продукт", () => {
    // Строка списка зовёт `factsFreshness` напрямую (объекта `Snapshot` у неё
    // нет), карточка — через разбор. Разойдись эти два пути, и один и тот же
    // снимок назывался бы на двух экранах по-разному.
    const at = ago(3 * DAY);
    expect(snapshotOf(facts(), at, NOW).freshness).toBe(factsFreshness(at, NOW));
  });
});

/**
 * Разбор снимка — правило трёх экранов (карточка SSL, вкладки Server и Logs), и
 * до сих пор оно проверялось только через их рендер. Ради этого разбор и уехал
 * в `lib`: спрашивать его теперь можно напрямую.
 */
describe("snapshotOf", () => {
  it("факты читаются ТОЛЬКО вместе с отметкой времени", () => {
    // Пара «факты есть, отметки нет» бэкендом не производится (обе колонки
    // пишутся одной транзакцией), но случись она — экран сказал бы «сервер не
    // читали» и тут же напечатал эти факты как измеренные.
    const s = snapshotOf(facts(), null, NOW);
    expect(s.noSnapshot).toBe(true);
    expect(s.facts).toBeNull();
  });

  it("снимок есть — факты те самые, и он не «никогда»", () => {
    const f = facts();
    const s = snapshotOf(f, ago(HOUR), NOW);
    expect(s.facts).toBe(f);
    expect(s.noSnapshot).toBe(false);
  });

  it("протухание считается тем же порогом, что и у `isFactsStale`", () => {
    expect(snapshotOf(facts(), ago(FACTS_STALE_MS), NOW).stale).toBe(false);
    expect(snapshotOf(facts(), ago(FACTS_STALE_MS + MINUTE), NOW).stale).toBe(true);
  });

  it("подпись возраста печатает и возраст, и пометку протухания", () => {
    expect(snapshotOf(facts(), ago(4 * HOUR), NOW).freshness).toBe("Checked 4h ago");
    expect(snapshotOf(facts(), ago(8 * DAY), NOW).freshness).toBe("Checked 8d ago · stale");
  });

  it("снимка не было — «Never checked», а не пустая строка", () => {
    // Пустая строка на экране неотличима от «мы не напечатали возраст», то есть
    // выдавала бы незнание за отсутствие вопроса.
    expect(snapshotOf(null, null, NOW).freshness).toBe("Never checked");
  });
});

/**
 * Разбор списка копий: четыре состояния и своя сортировка.
 *
 * Сердце этих тестов — то, что «пусто» бывает двух сортов. `state: "unknown"`
 * означает «спросили, разобрать не смогли», и превратить его в пустой список
 * значит соврать про сервер: единственное утверждение об отсутствии копий во
 * всём продукте — это `listed` с пустыми `entries`.
 */

/** Копия, у которой есть всё; поля перекрываются по одному. */
function backup(over: Partial<DomainBackup> = {}): DomainBackup {
  return { id: "b1", name: "backup-1.tar", created_at: ago(HOUR), size_bytes: 1024, source: "site_row", ...over };
}

function withBackups(backups: BackupsFacts | undefined) {
  const facts = { ftp_accounts: [], databases: [], logs: [], backups } as unknown as DomainFacts;
  return snapshotOf(facts, ago(HOUR), NOW);
}

describe("backupsOf — четыре состояния, и «не знаем» ≠ «нет»", () => {
  it("снимка не было ни разу → no-snapshot", () => {
    expect(backupsOf(snapshotOf(null, null, NOW))).toEqual({ state: "no-snapshot" });
  });

  it("снимок есть, поля backups в нём нет → not-in-snapshot", () => {
    // Старый снимок (снят сборкой, которая читать копии не умела) — это про
    // НАС, а не про сервер, и с «копий нет» не имеет ничего общего.
    expect(backupsOf(withBackups(undefined))).toEqual({ state: "not-in-snapshot" });
  });

  it("отметка есть, а фактов нет → not-in-snapshot, а не «сервер не читали»", () => {
    // Пару «facts: null при живом fp_facts_at» гасит сам `snapshotOf`. Сказать
    // на ней «сервер не читали» значило бы спорить с подписью «Checked 1h ago»,
    // которая стоит на экране строкой выше.
    expect(backupsOf(snapshotOf(null, ago(HOUR), NOW))).toEqual({ state: "not-in-snapshot" });
  });

  it("state: unknown → unreadable, даже когда entries пуст", () => {
    const view = backupsOf(withBackups({ state: "unknown", entries: [], probed: ["site_row"] }));
    expect(view).toEqual({ state: "unreadable" });
  });

  it("state: unknown с записями всё равно unreadable — частичному списку веры нет", () => {
    // Правило `ftp_accounts_from_json`: разобрали меньше, чем было, — значит
    // читаем неправильно, и показывать огрызок опаснее, чем не показывать.
    const view = backupsOf(withBackups({ state: "unknown", entries: [backup()], probed: [] }));
    expect(view).toEqual({ state: "unreadable" });
  });

  it("state: known с пустым списком → listed без записей (единственное «копий нет»)", () => {
    expect(backupsOf(withBackups({ state: "known", entries: [], probed: ["plan_cli"] }))).toEqual({
      state: "listed",
      items: [],
    });
  });
});

describe("backupsOf — сортировка", () => {
  const listed = (entries: DomainBackup[]) =>
    backupsOf(withBackups({ state: "known", entries, probed: [] }));

  it("новые сверху", () => {
    const view = listed([
      backup({ id: "old", created_at: ago(3 * DAY) }),
      backup({ id: "new", created_at: ago(HOUR) }),
      backup({ id: "mid", created_at: ago(DAY) }),
    ]);
    expect(view.state === "listed" && view.items.map((b) => b.id)).toEqual(["new", "mid", "old"]);
  });

  it("копия без даты уходит в конец, а не претендует на «самую свежую»", () => {
    const view = listed([
      backup({ id: "undated", created_at: undefined }),
      backup({ id: "dated", created_at: ago(3 * DAY) }),
    ]);
    expect(view.state === "listed" && view.items.map((b) => b.id)).toEqual(["dated", "undated"]);
  });

  it("неразобранная дата считается отсутствующей, а не сегодняшней", () => {
    const view = listed([
      backup({ id: "garbage", created_at: "вчера вечером" }),
      backup({ id: "dated", created_at: ago(30 * DAY) }),
    ]);
    expect(view.state === "listed" && view.items.map((b) => b.id)).toEqual(["dated", "garbage"]);
  });

  it("порядок бездатных копий сохраняется тем, каким его отдал десктоп", () => {
    const view = listed([
      backup({ id: "u1", created_at: undefined }),
      backup({ id: "u2", created_at: undefined }),
      backup({ id: "u3", created_at: undefined }),
    ]);
    expect(view.state === "listed" && view.items.map((b) => b.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("исходный массив снимка не переставляется на месте", () => {
    // Снимок приезжает из кэша React Query и живёт дольше рендера: сортировка
    // на месте перетасовала бы то, что читают другие экраны.
    const entries = [backup({ id: "old", created_at: ago(3 * DAY) }), backup({ id: "new", created_at: ago(HOUR) })];
    backupsOf(withBackups({ state: "known", entries, probed: [] }));
    expect(entries.map((b) => b.id)).toEqual(["old", "new"]);
  });
});
