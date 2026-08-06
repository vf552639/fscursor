import { describe, it, expect } from "vitest";

import { formatAgo, isMetricsStale } from "./Primitives";

/**
 * Возраст показаний — чистые функции, и проверяются они отдельно от компонентов:
 * границы («минуту назад», «вчера», «3 месяца назад») здесь стоят дешевле и
 * надёжнее, чем через рендер страницы.
 *
 * Смысл обеих — не «показать красивую строку», а не дать старой цифре выдать
 * себя за свежую. Отсюда и набор случаев: границы, отставшие часы клиента и
 * мусор вместо даты.
 */

const NOW = new Date("2026-08-06T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Отметка ровно на `ms` миллисекунд раньше `NOW`. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatAgo", () => {
  it("свежайшее показание — «just now», а не «0m ago»", () => {
    expect(formatAgo(ago(0), NOW)).toBe("just now");
    expect(formatAgo(ago(59_000), NOW)).toBe("just now");
  });

  it("минуты и часы считаются вниз, а не округляются вверх", () => {
    // Ровно минута — уже минута: иначе «just now» держалось бы дольше правды.
    expect(formatAgo(ago(MINUTE), NOW)).toBe("1m ago");
    expect(formatAgo(ago(59 * MINUTE), NOW)).toBe("59m ago");
    expect(formatAgo(ago(HOUR), NOW)).toBe("1h ago");
    // 90 минут — это «1h ago», а не «2h ago»: показанию полтора часа, и
    // округление вверх делало бы его моложе, чем оно есть, только наоборот.
    expect(formatAgo(ago(90 * MINUTE), NOW)).toBe("1h ago");
    expect(formatAgo(ago(DAY - MINUTE), NOW)).toBe("23h ago");
  });

  it("сутки и больше — дни, месяц и больше — месяцы", () => {
    expect(formatAgo(ago(DAY), NOW)).toBe("1d ago");
    expect(formatAgo(ago(29 * DAY), NOW)).toBe("29d ago");
    expect(formatAgo(ago(30 * DAY), NOW)).toBe("1mo ago");
    expect(formatAgo(ago(90 * DAY), NOW)).toBe("3mo ago");
    // Ровно та окаменелость, из-за которой всё затевалось: апрельское показание
    // на августовской карточке обязано выглядеть апрельским. Месяц здесь — 30
    // суток, поэтому 8 апреля от 6 августа — это «4mo ago», а не «3mo ago»:
    // календарной точности от подписи «когда снято» не требуется, требуется не
    // выдавать её за сегодняшнюю.
    expect(formatAgo("2026-04-08T12:00:00Z", NOW)).toBe("4mo ago");
  });

  it("отметка из будущего — это отставшие часы клиента, а не «через час»", () => {
    expect(formatAgo(new Date(NOW + HOUR).toISOString(), NOW)).toBe("just now");
  });

  it("неразобранная дата — прочерк, а не «NaN ago»", () => {
    expect(formatAgo("not-a-date", NOW)).toBe("—");
  });
});

describe("isMetricsStale", () => {
  it("сутки — ещё свежо, сутки с минутой — уже нет", () => {
    // Границу пишем числом здесь, а не сверяемся с константой модуля: сверка
    // константы с самой собой зеленела бы при любом пороге.
    expect(isMetricsStale(ago(DAY), NOW)).toBe(false);
    expect(isMetricsStale(ago(DAY + MINUTE), NOW)).toBe(true);
    expect(isMetricsStale(ago(90 * DAY), NOW)).toBe(true);
  });

  it("метрик нет — это не «протухли»", () => {
    // Иначе сервер, у которого снимков не было ни разу, получил бы пометку
    // «старые данные» там, где данных нет вовсе.
    expect(isMetricsStale(null, NOW)).toBe(false);
    expect(isMetricsStale(undefined, NOW)).toBe(false);
  });

  it("мусор вместо даты не объявляется протухшим", () => {
    expect(isMetricsStale("not-a-date", NOW)).toBe(false);
  });
});
