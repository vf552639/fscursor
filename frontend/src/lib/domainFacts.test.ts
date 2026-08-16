import { describe, it, expect } from "vitest";

import { FACTS_STALE_MS, isFactsStale, sslState, type DomainFacts } from "./domainFacts";

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
