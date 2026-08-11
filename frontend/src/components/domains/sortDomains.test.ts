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
  ssl_status: null,
  expiry_date: null,
  ssl_expires_at: null,
  last_provision_error: null,
  created: "2026-01-01T00:00:00Z",
  ...over,
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

    it("незнакомый статус сертификата — но «сертификата нет» это НЕ незнание", () => {
      const rows = [
        row({ id: 1, domain: "active.com", ssl_status: "active" }),
        row({ id: 2, domain: "alien.com", ssl_status: "такого-статуса-нет" }),
        row({ id: 3, domain: "none.com", ssl_status: null }),
      ];
      const asc = names(sortDomains(rows, sort("ssl", "asc")));
      const desc = names(sortDomains(rows, sort("ssl", "desc")));
      expect(asc.slice(-1)).toEqual(["alien.com"]);
      expect(desc.slice(-1)).toEqual(["alien.com"]);
      // Домен без сертификата — обычное состояние, первая ступень лестницы
      // (`none` в `lib/domainStatus`), а не «мы не знаем»: в списке оно так и
      // подписано — «— No SSL». Проверка написана потому, что автор теста
      // сначала предположил обратное.
      expect(asc[0]).toBe("none.com");
    });
  });

  it("колонка SSL сортируется по статусу, а срок — только второй ключ", () => {
    // Так устроена и сама ячейка: бейдж крупно, срок подписью под ним.
    const rows = [
      row({ id: 1, domain: "a-active-far.com", ssl_status: "active", ssl_expires_at: "2027-01-01T00:00:00Z" }),
      row({ id: 2, domain: "b-error-soon.com", ssl_status: "error", ssl_expires_at: "2026-09-01T00:00:00Z" }),
      row({ id: 3, domain: "c-active-soon.com", ssl_status: "active", ssl_expires_at: "2026-08-20T00:00:00Z" }),
    ];
    const asc = names(sortDomains(rows, sort("ssl", "asc")));
    // Оба «active» стоят рядом, и внутри них решает срок.
    expect(asc.indexOf("c-active-soon.com")).toBeLessThan(asc.indexOf("a-active-far.com"));
    expect(asc.indexOf("a-active-far.com")).toBeLessThan(asc.indexOf("b-error-soon.com"));
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
