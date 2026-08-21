import { describe, it, expect } from "vitest";

import { DEFAULT_SORT, Sort, sortDomains } from "./sortDomains";
import { DomainUI } from "./types";

/**
 * Правила порядка — без DOM.
 *
 * Кликами по заголовкам они проверяются и в `pages/Domains.expiry.test.tsx`, и
 * те проверки остаются: там видно то, что видит пользователь. Здесь —
 * дополнение, а не замена: у правила «незнание в конец при ЛЮБОМ направлении»
 * четыре ключа и два направления, и перебирать восемь сочетаний, поднимая
 * страницу за четырьмя моками API, никто не станет.
 *
 * Ради этого вынесенные чистые куски и заводились (см. план №4).
 */

const row = (over: Partial<DomainUI> & { id: number; domain: string }): DomainUI => ({
  server_id: null,
  registrar_id: null,
  cf_id: null,
  ns_status: "ok",
  status: "active",
  ssl: null,
  facts_at: null,
  ssl_status: null,
  expiry_date: null,
  last_provision_error: null,
  created: "2026-01-01T00:00:00Z",
  ...over,
});

/** «Сейчас» тестов — одно на файл, чтобы протухание снимков считалось от него. */
const NOW = Date.parse("2026-08-20T00:00:00Z");
/** Снимок недельной свежести: выводы о наличии сертификата по нему ещё действительны. */
const FRESH = "2026-08-19T00:00:00Z";

/** Сертификат из снимка. `expires` — срок; `undefined` значит «прочитан не был». */
const cert = (expires?: string | null, error?: string): DomainUI["ssl"] => ({
  has_certificate: true,
  expires_at: expires ?? null,
  issuer: "R3",
  is_letsencrypt: true,
  ...(error ? { error } : null),
});

const names = (rows: DomainUI[]) => rows.map((d) => d.domain);
const sort = (key: Sort["key"], dir: Sort["dir"]): Sort => ({ key, dir });

describe("sortDomains", () => {
  it("умолчание — по имени, по возрастанию, и список это не тот, что пришёл с бэкенда", () => {
    const rows = [row({ id: 3, domain: "gamma.com" }), row({ id: 1, domain: "alpha.com" }), row({ id: 2, domain: "beta.com" })];
    expect(names(sortDomains(rows, DEFAULT_SORT))).toEqual(["alpha.com", "beta.com", "gamma.com"]);
  });

  it("не трогает исходный массив", () => {
    // Список приезжает из кэша react-query: сортировка на месте испортила бы
    // его всем остальным читателям.
    const rows = [row({ id: 2, domain: "b.com" }), row({ id: 1, domain: "a.com" })];
    sortDomains(rows, DEFAULT_SORT);
    expect(names(rows)).toEqual(["b.com", "a.com"]);
  });

  describe("незнание уходит в конец при ЛЮБОМ направлении", () => {
    const withExpiry = [
      row({ id: 1, domain: "late.com", expiry_date: "2027-01-01" }),
      row({ id: 2, domain: "unknown.com", expiry_date: null }),
      row({ id: 3, domain: "soon.com", expiry_date: "2026-09-01" }),
    ];

    it("срок домена", () => {
      expect(names(sortDomains(withExpiry, sort("expiry_date", "asc")))).toEqual(["soon.com", "late.com", "unknown.com"]);
      expect(names(sortDomains(withExpiry, sort("expiry_date", "desc")))).toEqual(["late.com", "soon.com", "unknown.com"]);
    });

    it("битая дата — то же самое незнание, а не «начало времён»", () => {
      const rows = [
        row({ id: 1, domain: "ok.com", expiry_date: "2027-01-01" }),
        row({ id: 2, domain: "broken.com", expiry_date: "не дата" }),
      ];
      expect(names(sortDomains(rows, sort("expiry_date", "asc")))).toEqual(["ok.com", "broken.com"]);
      expect(names(sortDomains(rows, sort("expiry_date", "desc")))).toEqual(["ok.com", "broken.com"]);
    });

    it("незнакомый статус домена", () => {
      const rows = [
        row({ id: 1, domain: "active.com", status: "active" }),
        row({ id: 2, domain: "alien.com", status: "статуса-такого-нет" }),
        row({ id: 3, domain: "new.com", status: "new" }),
      ];
      expect(names(sortDomains(rows, sort("status", "asc"))).slice(-1)).toEqual(["alien.com"]);
      expect(names(sortDomains(rows, sort("status", "desc"))).slice(-1)).toEqual(["alien.com"]);
    });

    it("«снимка нет» — незнание; «сертификата нет» — знание, и это разные места", () => {
      const rows = [
        row({ id: 1, domain: "valid.com", ssl: cert("2027-01-01T00:00:00Z"), facts_at: FRESH }),
        row({ id: 2, domain: "unchecked.com", ssl: null, facts_at: null }),
        row({
          id: 3,
          domain: "missing.com",
          ssl: { has_certificate: false, expires_at: null, issuer: null, is_letsencrypt: false },
          facts_at: FRESH,
        }),
      ];
      const asc = names(sortDomains(rows, sort("ssl", "asc"), NOW));
      const desc = names(sortDomains(rows, sort("ssl", "desc"), NOW));
      // Домен, который ни разу не читали по SSH, уходит в конец при ОБОИХ
      // направлениях: про его сертификат мы не знаем ничего.
      expect(asc.slice(-1)).toEqual(["unchecked.com"]);
      expect(desc.slice(-1)).toEqual(["unchecked.com"]);
      // А «сертификата на сервере нет» — полноценное измерение и первая ступень
      // лестницы здоровья, а не незнание. Проверка написана потому, что эти два
      // состояния колонка когда-то рисовала одним словом «No SSL».
      expect(asc[0]).toBe("missing.com");
    });

    it("протухший снимок возвращает домен в незнание, а не оставляет его зелёным", () => {
      // Сердце фазы: «valid» — утверждение о том, что было на сервере в момент
      // снимка, и через неделю оно перестаёт быть знанием. Порядок обязан
      // стареть вместе с подписью, иначе колонка сортирует по тому, чего в ней
      // уже не написано.
      const rows = [
        row({ id: 1, domain: "fresh.com", ssl: cert("2027-01-01T00:00:00Z"), facts_at: FRESH }),
        row({ id: 2, domain: "stale.com", ssl: cert("2027-01-01T00:00:00Z"), facts_at: "2026-07-01T00:00:00Z" }),
      ];
      expect(names(sortDomains(rows, sort("ssl", "asc"), NOW))).toEqual(["fresh.com", "stale.com"]);
      expect(names(sortDomains(rows, sort("ssl", "desc"), NOW))).toEqual(["fresh.com", "stale.com"]);
    });
  });

  it("колонка SSL сортируется по состоянию, а срок из снимка — только второй ключ", () => {
    // Срок берётся из СНИМКА (`ssl.expires_at`), а не из колонки
    // `ssl_expires_at`: у списка и у карточки один источник, иначе второй ключ
    // упорядочивал бы строки по записи, которой на экране нет вовсе.
    const rows = [
      row({ id: 1, domain: "a-valid-far.com", ssl: cert("2027-01-01T00:00:00Z"), facts_at: FRESH }),
      row({ id: 2, domain: "b-error.com", ssl: cert("2027-06-01T00:00:00Z", "read failed"), facts_at: FRESH }),
      row({ id: 3, domain: "c-valid-far-too.com", ssl: cert("2026-12-01T00:00:00Z"), facts_at: FRESH }),
    ];
    const asc = names(sortDomains(rows, sort("ssl", "asc"), NOW));
    // Оба «valid» стоят рядом, и внутри них решает срок; `error` — за ними.
    expect(asc.indexOf("c-valid-far-too.com")).toBeLessThan(asc.indexOf("a-valid-far.com"));
    expect(asc.indexOf("a-valid-far.com")).toBeLessThan(asc.indexOf("b-error.com"));
  });

  it("равные ключи разбираются по имени, а не порядком заведения", () => {
    // Полсотни доменов с одной датой покупки иначе встают в порядке вставки в
    // базу, который меняется от каждой новой строки.
    const same = "2026-12-01";
    const rows = [
      row({ id: 10, domain: "delta.com", expiry_date: same }),
      row({ id: 11, domain: "alpha.com", expiry_date: same }),
      row({ id: 12, domain: "charlie.com", expiry_date: same }),
    ];
    expect(names(sortDomains(rows, sort("expiry_date", "asc")))).toEqual(["alpha.com", "charlie.com", "delta.com"]);
    // И при обратном направлении тоже по имени: вторичный ключ на направление
    // не умножается — иначе «одинаковые» строки прыгали бы от каждого клика.
    expect(names(sortDomains(rows, sort("expiry_date", "desc")))).toEqual(["alpha.com", "charlie.com", "delta.com"]);
  });

  it("колонка Added сортирует по дате заведения, а не по имени", () => {
    const rows = [
      row({ id: 1, domain: "alpha.com", created: "2026-03-01T00:00:00Z" }),
      row({ id: 2, domain: "beta.com", created: "2026-01-01T00:00:00Z" }),
    ];
    expect(names(sortDomains(rows, sort("created", "asc")))).toEqual(["beta.com", "alpha.com"]);
  });
});
