import { describe, it, expect } from "vitest";

import { matchDomainsToZones, normalizeZoneName, resolveZoneByName } from "./cfZoneMatch";

/**
 * Правило привязки домена к зоне проверяется здесь, а не на странице: зоны
 * приходят от Tauri-команды, и на реальном пути каждое из этих утверждений
 * стоило бы мока десктопа ради сравнения двух строк. Ломается же тут не
 * механика, а именно правило — регистр, точка, неоднозначность, поддомен.
 */

function domain(id: number, name: string, cfAccount: number | null = null) {
  return { id, domain_name: name, cloudflare_account_id: cfAccount };
}

const ACCOUNT_7 = {
  accountId: 7,
  zones: [
    { id: "zone-a", name: "example.com" },
    { id: "zone-b", name: "second.com" },
  ],
};

describe("normalizeZoneName", () => {
  it("схлопывает регистр, пробелы и завершающую точку", () => {
    // Cloudflare отдаёт имена в нижнем регистре, а пользователь набирает домен
    // как придётся; `example.com.` — законный FQDN из копипасты зонного файла.
    expect(normalizeZoneName("  Example.COM. ")).toBe("example.com");
    expect(normalizeZoneName("example.com")).toBe("example.com");
  });
});

describe("matchDomainsToZones", () => {
  it("привязывает точное совпадение", () => {
    const [m] = matchDomainsToZones([domain(1, "example.com")], [ACCOUNT_7]);

    expect(m).toEqual({
      outcome: "matched",
      domainId: 1,
      domain: "example.com",
      accountId: 7,
      zoneId: "zone-a",
    });
  });

  it("совпадение не зависит от регистра, точки и пробелов", () => {
    const rows = matchDomainsToZones(
      [domain(1, "Example.COM"), domain(2, "second.com."), domain(3, " example.com ")],
      [ACCOUNT_7],
    );

    expect(rows.map((r) => r.outcome)).toEqual(["matched", "matched", "matched"]);
    expect(rows.map((r) => (r.outcome === "matched" ? r.zoneId : null))).toEqual([
      "zone-a",
      "zone-b",
      "zone-a",
    ]);
  });

  it("совпадение в двух аккаунтах не привязывает ни к одному", () => {
    const other = { accountId: 9, zones: [{ id: "zone-x", name: "example.com" }] };

    const [m] = matchDomainsToZones([domain(1, "example.com")], [ACCOUNT_7, other]);

    // Угадав аккаунт, продукт записал бы домену чужой zone_id, а вкладка NS
    // потом отдала бы регистратору nameservers чужой зоны.
    expect(m).toEqual({
      outcome: "ambiguous",
      domainId: 1,
      domain: "example.com",
      accountIds: [7, 9],
    });
  });

  it("две одноимённые зоны внутри одного аккаунта — тоже неоднозначность", () => {
    const twins = {
      accountId: 7,
      zones: [
        { id: "zone-a", name: "example.com" },
        { id: "zone-a2", name: "example.com" },
      ],
    };

    const [m] = matchDomainsToZones([domain(1, "example.com")], [twins]);

    // Аккаунт известен, а zone_id выбрать не из чего — и наугад выбранная зона
    // это тот же чужой NS-путь. Аккаунт при этом называется один раз.
    expect(m.outcome).toBe("ambiguous");
    expect(m.outcome === "ambiguous" ? m.accountIds : []).toEqual([7]);
  });

  it("уже привязанный домен не трогает", () => {
    const rows = matchDomainsToZones(
      [domain(1, "example.com", 42), domain(2, "second.com", 42)],
      [ACCOUNT_7],
    );

    // Даже когда зона нашлась бы: выбор аккаунта пользователем перезаписывать
    // нечем и незачем.
    expect(rows.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
  });

  it("поддомен не привязывается к родительской зоне", () => {
    const [m] = matchDomainsToZones([domain(1, "shop.example.com")], [ACCOUNT_7]);

    // Зафиксированное решение, а не недосмотр: `cloudflare_zone_id` читается
    // фронтом как «зона ЭТОГО домена», и вкладка NS пушит регистратору её
    // nameservers. Привязка к родителю заставила бы этот путь врать.
    expect(m.outcome).toBe("none");
  });

  it("пустой список зон даёт «совпадений нет», а не падение", () => {
    const rows = matchDomainsToZones([domain(1, "example.com")], []);
    expect(rows.map((r) => r.outcome)).toEqual(["none"]);

    const empty = matchDomainsToZones([domain(1, "example.com")], [{ accountId: 7, zones: [] }]);
    expect(empty.map((r) => r.outcome)).toEqual(["none"]);
  });

  it("имя из пробелов не совпадает ни с чем", () => {
    const withBlank = {
      accountId: 7,
      zones: [{ id: "zone-blank", name: "  " }],
    };

    const [m] = matchDomainsToZones([domain(1, "   ")], [withBlank]);

    // Пустое совпадает с пустым — и именно поэтому пустое имя в индекс не
    // кладётся: иначе домен без имени получил бы зону без имени.
    expect(m.outcome).toBe("none");
  });

  it("сохраняет порядок входа", () => {
    const rows = matchDomainsToZones(
      [domain(1, "nope.com"), domain(2, "example.com"), domain(3, "taken.com", 3)],
      [ACCOUNT_7],
    );

    // Отчёт читается рядом со списком, где домены стоят в своём порядке.
    expect(rows.map((r) => r.domainId)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.outcome)).toEqual(["none", "matched", "skipped"]);
  });
});

describe("resolveZoneByName", () => {
  it("находит зону в выбранном аккаунте", () => {
    expect(resolveZoneByName("example.com", ACCOUNT_7.zones)).toEqual({
      outcome: "matched",
      zoneId: "zone-a",
    });
  });

  it("нормализует имя так же, как общий матч", () => {
    // Одно правило на два места: разъехавшись, строка таблицы показывала бы
    // совпадение, которого карточка не находит.
    expect(resolveZoneByName("  Example.COM. ", ACCOUNT_7.zones)).toEqual({
      outcome: "matched",
      zoneId: "zone-a",
    });
  });

  it("две одноимённые зоны в аккаунте не резолвятся ни в одну", () => {
    // Выбранная наугад зона — это чужой NS-путь: по `cloudflare_zone_id` потом
    // пушатся nameservers регистратору.
    expect(
      resolveZoneByName("example.com", [
        { id: "zone-a", name: "example.com" },
        { id: "zone-dup", name: "Example.com." },
      ]),
    ).toEqual({ outcome: "ambiguous", zoneIds: ["zone-a", "zone-dup"] });
  });

  it("поддомен к родительской зоне не привязывается", () => {
    expect(resolveZoneByName("shop.example.com", ACCOUNT_7.zones).outcome).toBe("none");
  });

  it("пустое имя и пустой список зон не падают", () => {
    expect(resolveZoneByName("   ", ACCOUNT_7.zones).outcome).toBe("none");
    expect(resolveZoneByName("example.com", []).outcome).toBe("none");
  });
});
