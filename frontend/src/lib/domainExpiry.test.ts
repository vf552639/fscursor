import { describe, it, expect } from "vitest";

import {
  EXPIRY_SOON_DAYS,
  expiryState,
  expiryTextColor,
  expiryTextWeight,
  expiryTs,
  formatExpiry,
  formatExpiryDate,
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

/**
 * `expiry_date` приезжает с бэкенда РОВНО в этом виде — `Optional[date]`, то
 * есть строка «2026-09-01» без времени и без зоны. До этого блока весь модуль
 * проверялся полными ISO-датами (`at()`), то есть единственная форма, в которой
 * поле вообще существует в проде, не проверялась ничем — и сдвиг даты на день
 * западнее UTC прошёл мимо зелёной сюиты именно так.
 */
describe("дата без времени — это весь день", () => {
  // Полдень UTC 1 сентября: домен со сроком «1 сентября» в этот момент ЖИВ.
  const NOON_SEP_1 = new Date("2026-09-01T12:00:00Z").getTime();

  it("в день своего срока домен ещё не просрочен", () => {
    // Срок такой даты — конец дня, а не его начало: у регистратора «expiry
    // date: 1 сентября» значит, что первого числа домен работает. Красное
    // «expired today» на живом домене зовёт продлевать то, что не истекло.
    expect(expiryState("2026-09-01", NOON_SEP_1)).toBe("soon");
    expect(formatExpiry("2026-09-01", NOON_SEP_1)).toBe("in <1 day");
  });

  it("просрочка начинается со следующих суток", () => {
    const noonSep2 = new Date("2026-09-02T12:00:00Z").getTime();
    expect(expiryState("2026-09-01", noonSep2)).toBe("expired");
    expect(formatExpiry("2026-09-01", noonSep2)).toBe("expired today");
  });

  it("остаток считается от конца дня", () => {
    expect(formatExpiry("2026-09-11", NOON_SEP_1)).toBe("in 10 days");
    // Порог в 30 суток от полудня 1 сентября приходится на конец 1 октября.
    expect(expiryState("2026-10-01", NOON_SEP_1)).toBe("soon");
    expect(expiryState("2026-10-02", NOON_SEP_1)).toBe("ok");
  });

  it("печатается в UTC, а не в зоне читателя — в ЛЮБОЙ зоне", () => {
    // `new Date("2026-09-01")` — полночь UTC, и `toLocaleDateString` без зоны
    // переводит её в зону читателя: западнее UTC (Нью-Йорк, Гонолулу) выходило
    // «31.08.2026» — дата, которой у домена нет.
    //
    // Зона тут НЕ подменяется намеренно: `formatExpiryDate` прибивает
    // `timeZone: "UTC"` для date-only, поэтому ответ от зоны не зависит вовсе, и
    // подмена охраняла бы не поведение, а саму себя. Зона, в которой ошибка
    // видна, задаётся там, где она и нужна, — в тесте страницы
    // (`pages/Domains.expiry.test.tsx`), и там же стоит контроль, что подмена
    // сработала.
    expect(formatExpiryDate("2026-09-01")).toBe("01.09.2026");
  });

  it("а вот у datetime печать идёт в зоне читателя — и это тоже правило", () => {
    // Асимметрия сознательная: у `date` мгновения нет вовсе, у `datetime` есть,
    // и «когда у МЕНЯ истекает сертификат» — правильный ответ. Здесь подмена
    // зоны решает всё: тот же момент в Нью-Йорке приходится на предыдущий день.
    const tz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatExpiryDate("2026-09-01T02:00:00Z")).toBe("31.08.2026");
      process.env.TZ = "UTC";
      expect(formatExpiryDate("2026-09-01T02:00:00Z")).toBe("01.09.2026");
    } finally {
      // Именно `delete`, а не присваивание: обычно `TZ` не задан вовсе, и
      // `process.env.TZ = undefined` записал бы туда СТРОКУ «undefined» —
      // зону, которой нет, после чего Node молча считает время в UTC. Так
      // тест уносил бы с собой чужую зону во все следующие в этом воркере.
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("у полноценного datetime мгновение настоящее, и сдвигать его нечем", () => {
    // Сертификат истекает в известную секунду — прибавить ему день значило бы
    // выдумать сутки, которых у сертификата нет.
    const t = new Date("2026-09-01T00:00:00Z");
    expect(expiryTs(t.toISOString())).toBe(t.getTime());
    expect(expiryTs("2026-09-01")).toBe(t.getTime() + DAY);
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

  it("те же состояния выделяет и начертанием — цвет не единственный канал", () => {
    // Второй канал нужен тем, кто цвет не различает; и он обязан совпадать с
    // цветом состояние в состояние, иначе строка спорит сама с собой.
    expect(expiryTextWeight("expired")).toBe(600);
    expect(expiryTextWeight("soon")).toBe(600);
    expect(expiryTextWeight("ok")).toBe(400);
    expect(expiryTextWeight("unknown")).toBe(400);
  });
});
