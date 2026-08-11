import { describe, it, expect } from "vitest";

import {
  EXPIRY_SOON_DAYS,
  daysLeft,
  expiryState,
  expiryTextColor,
  expiryTs,
  formatExpiry,
} from "./domainExpiry";

/**
 * Сроки домена и сертификата — чистые функции, и проверяются они отдельно от
 * экранов: одну и ту же лестницу читают колонка Expires, колонка SSL и карточка
 * домена, и уронить её рендером одного из мест значит проверить треть.
 *
 * Проверяется не «функция вернула строку», а правило продукта: незнание срока —
 * отдельное состояние, а не «всё хорошо».
 */

const NOW = new Date("2026-08-11T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** ISO-строка на N миллисекунд позже «сейчас» (отрицательное — раньше). */
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("expiryState", () => {
  it("далёкий срок — «ok», близкий — «soon», прошедший — «expired»", () => {
    expect(expiryState(at(200 * DAY), NOW)).toBe("ok");
    expect(expiryState(at(10 * DAY), NOW)).toBe("soon");
    expect(expiryState(at(-1 * DAY), NOW)).toBe("expired");
  });

  it("даты нет — это «не знаем», а не «ok» и не «expired»", () => {
    // Правило продукта №6: отсутствие измерения — своё состояние. Домен без
    // `expiry_date` не «в порядке» — про него просто ничего не известно.
    expect(expiryState(null, NOW)).toBe("unknown");
    expect(expiryState(undefined, NOW)).toBe("unknown");
    expect(expiryState("", NOW)).toBe("unknown");
  });

  it("нечитаемая дата уравнена с её отсутствием, а не роняет разбор", () => {
    // `new Date("не дата")` → NaN, и любое сравнение с ним ложно: без явной
    // ветки такой домен молча уехал бы в «ok».
    expect(expiryState("not-a-date", NOW)).toBe("unknown");
    expect(expiryState("2026-13-45", NOW)).toBe("unknown");
    expect(daysLeft("not-a-date", NOW)).toBeNull();
  });

  it("граница ровно на пороге входит в «soon»", () => {
    // Число пишем вручную, а не берём из константы модуля: сверка константы с
    // самой собой зеленела бы при любом пороге.
    expect(EXPIRY_SOON_DAYS).toBe(30);
    expect(expiryState(at(30 * DAY), NOW)).toBe("soon");
    // На день дальше порога — уже «ok»…
    expect(expiryState(at(31 * DAY), NOW)).toBe("ok");
    // …а неполные сутки сверх порога остатка не добавляют: округляем вниз,
    // потому что раннее предупреждение дешевле пропущенного.
    expect(expiryState(at(30 * DAY + 20 * HOUR), NOW)).toBe("soon");
  });

  it("день самого срока — уже «expired», а не «остался ноль дней»", () => {
    // У `expiry_date` (тип `date`) времени нет: к обеду того же дня остаток
    // отрицателен. Занижаем намеренно — подпись при этом честно скажет
    // «expired today», а не выдумает давность.
    expect(expiryState(at(-1 * HOUR), NOW)).toBe("expired");
    expect(formatExpiry(at(-1 * HOUR), NOW)).toBe("expired today");
  });
});

describe("formatExpiry", () => {
  it("будущее считает днями, а первые неполные сутки называет своим именем", () => {
    expect(formatExpiry(at(12 * DAY), NOW)).toBe("in 12 days");
    expect(formatExpiry(at(1 * DAY), NOW)).toBe("in 1 day");
    expect(formatExpiry(at(5 * HOUR), NOW)).toBe("in <1 day");
  });

  it("прошедшее считает днями назад", () => {
    expect(formatExpiry(at(-3 * DAY - HOUR), NOW)).toBe("expired 3 days ago");
    expect(formatExpiry(at(-1 * DAY - HOUR), NOW)).toBe("expired 1 day ago");
  });

  it("ровные сутки назад называет своим числом, а не вчерашним", () => {
    // ЕДИНСТВЕННАЯ точка, где прежняя формула (`-daysLeft - 1`) расходилась с
    // нынешней: целое число суток. На дробной давности обе дают одно и то же,
    // поэтому ошибка и не попадалась — соседние тесты берут смещения с часом
    // сверху и границу обходят. Здесь она берётся в упор с обеих сторон.
    expect(formatExpiry(at(-1 * DAY), NOW)).toBe("expired 1 day ago");
    expect(formatExpiry(at(-3 * DAY), NOW)).toBe("expired 3 days ago");
    // А вот сутки ещё не прошли — это «сегодня», и здесь единицы быть не должно.
    expect(formatExpiry(at(-23 * HOUR), NOW)).toBe("expired today");
  });

  it("неизвестный срок подписывает прочерком, а не пустотой", () => {
    // Пустая строка превратилась бы в пустую ячейку, а пустая ячейка читается
    // как «всё хорошо».
    expect(formatExpiry(null, NOW)).toBe("—");
    expect(formatExpiry("not-a-date", NOW)).toBe("—");
  });
});

describe("expiryTs", () => {
  it("нечитаемый и отсутствующий срок отдаёт одним `null`, а не NaN", () => {
    // На этом значении держится сортировка: `NaN` в компараторе ложен во всех
    // сравнениях сразу, и одна битая дата сделала бы произвольным весь порядок,
    // а не только своё место в нём.
    expect(expiryTs("not-a-date")).toBeNull();
    expect(expiryTs(null)).toBeNull();
    expect(expiryTs(undefined)).toBeNull();
    expect(expiryTs("2026-08-11T12:00:00Z")).toBe(NOW);
  });
});

describe("expiryTextColor", () => {
  it("тревожные состояния красит, спокойные — нет", () => {
    expect(expiryTextColor("expired")).toBe("#dc2626");
    expect(expiryTextColor("soon")).toBe("#d97706");
    // «Далеко» не зелёное: это отсутствие повода, а не достижение, — иначе
    // жёлтое и красное потерялись бы в зелёном ряду на сотню строк.
    expect(expiryTextColor("ok")).toBe("#374151");
    // А «не знаем» — приглушённое: тем же серым на странице нарисованы прочерки.
    expect(expiryTextColor("unknown")).toBe("#9ca3af");
  });
});
