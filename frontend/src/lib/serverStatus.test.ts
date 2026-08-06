import { describe, it, expect } from "vitest";

import {
  UNCHECKED,
  isCheckStale,
  isMetricsStale,
  serverUiStatus,
  statusBadgeVariant,
} from "./serverStatus";

/**
 * Лестница статусов и пороги свежести — чистые функции, и проверяются они
 * отдельно от экранов: три страницы читают ОДНУ эту логику, и уронить её
 * рендером одной из них значит проверить одну треть.
 *
 * Проверяется не «функция вернула строку», а правило продукта: незнание не
 * должно выглядеть как здоровье.
 */

const NOW = new Date("2026-08-06T12:00:00Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** Сервер, который только что ответил на проверку. */
const ALIVE = { status: "active", last_check_at: ago(HOUR), last_check_ok: true };

describe("serverUiStatus", () => {
  it("ответивший на свежую проверку сервер — «active»", () => {
    expect(serverUiStatus(ALIVE, NOW)).toBe("active");
  });

  it("подтверждённое падение — «error», даже если в колонке статуса «active»", () => {
    expect(serverUiStatus({ ...ALIVE, last_check_ok: false }, NOW)).toBe("error");
    expect(serverUiStatus({ status: "error", last_check_at: null, last_check_ok: null }, NOW)).toBe(
      "error",
    );
  });

  it("ни разу не проверенный «active» — это «не знаем», а не «жив»", () => {
    // Колонка `status` ставится при заведении сервера и об ответе машины не
    // говорит ничего: до первой проверки зелёный бейдж — выдумка.
    expect(serverUiStatus({ ...ALIVE, last_check_at: null, last_check_ok: null }, NOW)).toBe(
      UNCHECKED,
    );
  });

  it("протухшая проверка перестаёт удерживать «active»", () => {
    // Порог — три пропущенных прогона (проверка идёт раз в 6 часов). Одиночная
    // задержка очереди не должна мигать статусом.
    expect(serverUiStatus({ ...ALIVE, last_check_at: ago(18 * HOUR) }, NOW)).toBe("active");
    expect(serverUiStatus({ ...ALIVE, last_check_at: ago(18 * HOUR + MINUTE) }, NOW)).toBe(UNCHECKED);
    expect(serverUiStatus({ ...ALIVE, last_check_at: ago(90 * DAY) }, NOW)).toBe(UNCHECKED);
  });

  it("падение на протухшей отметке остаётся «error», а не уезжает в «не знаем»", () => {
    // Несимметрично намеренно: старое «упал» не усыпляет, а старое «жив» — да.
    expect(serverUiStatus({ ...ALIVE, last_check_ok: false, last_check_at: ago(90 * DAY) }, NOW)).toBe(
      "error",
    );
  });

  it("неподтверждённый результат проверки за «жив» не считается", () => {
    // `last_check_ok === null` при заполненной отметке — состояние, которого
    // монитор не создаёт, но «жив» из него не следует.
    expect(serverUiStatus({ ...ALIVE, last_check_ok: null }, NOW)).toBe(UNCHECKED);
  });

  it("этапы жизненного цикла проверкой не подменяются", () => {
    expect(serverUiStatus({ status: "provisioned", last_check_at: null, last_check_ok: null }, NOW)).toBe(
      "provisioned",
    );
    expect(serverUiStatus({ status: "new", last_check_at: null, last_check_ok: null }, NOW)).toBe("new");
    // Незнакомое значение колонки — «new», а не «active»: гадать в сторону
    // здоровья нельзя.
    expect(serverUiStatus({ status: "whatever", last_check_at: ago(MINUTE), last_check_ok: true }, NOW)).toBe(
      "new",
    );
  });
});

describe("statusBadgeVariant", () => {
  it("зелёный занят под «машина ответила», и больше ни подо что", () => {
    expect(statusBadgeVariant("active")).toBe("green");
    expect(statusBadgeVariant("error")).toBe("red");
    // `provisioned` зелёным стоял бы рядом с серой точкой `StatusDot` — у него
    // там ключа нет; и «этап установки» здоровьем не является.
    expect(statusBadgeVariant("provisioned")).toBe("gray");
    expect(statusBadgeVariant(UNCHECKED)).toBe("gray");
    expect(statusBadgeVariant("new")).toBe("gray");
  });
});

describe("isMetricsStale", () => {
  it("сутки — ещё свежо, сутки с минутой — уже нет", () => {
    // Границу пишем числом, а не сверяемся с константой модуля: сверка
    // константы с самой собой зеленела бы при любом пороге.
    expect(isMetricsStale(ago(DAY), NOW)).toBe(false);
    expect(isMetricsStale(ago(DAY + MINUTE), NOW)).toBe(true);
  });

  it("метрик нет — это не «протухли»", () => {
    expect(isMetricsStale(null, NOW)).toBe(false);
    expect(isMetricsStale(undefined, NOW)).toBe(false);
  });

  it("мусор вместо даты не объявляется протухшим", () => {
    expect(isMetricsStale("not-a-date", NOW)).toBe(false);
  });
});

describe("isCheckStale", () => {
  it("18 часов — ещё свежо, 18 с минутой — уже нет", () => {
    expect(isCheckStale(ago(18 * HOUR), NOW)).toBe(false);
    expect(isCheckStale(ago(18 * HOUR + MINUTE), NOW)).toBe(true);
  });

  it("порог проверки строже метрик: сутки для неё — уже протухло", () => {
    // Разные источники, разный ритм: метрики снимают руками, доступность —
    // расписанием раз в 6 часов, и сутки молчания там означают поломку.
    expect(isCheckStale(ago(DAY), NOW)).toBe(true);
    expect(isMetricsStale(ago(DAY), NOW)).toBe(false);
  });

  it("проверок не было — это не «протухли»", () => {
    expect(isCheckStale(null, NOW)).toBe(false);
  });
});
