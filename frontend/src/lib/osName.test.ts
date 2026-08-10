import { describe, it, expect } from "vitest";

import { OS_OPTIONS, osShortName } from "./osName";

/**
 * `osShortName` — чистая функция, поэтому весь разбор проверяется на строках,
 * без сервера и без десктопа. Главное здесь — что версия и архитектура,
 * которые приносит `os_pretty` из `/etc/os-release`, отваливаются одинаково
 * для всех поддерживаемых семейств, а не только для той пары, что попалась
 * при разработке.
 */
describe("osShortName — канонические PRETTY_NAME из /etc/os-release", () => {
  it.each([
    ["Ubuntu 20.04.6 LTS", "Ubuntu"],
    ["Debian GNU/Linux 12 (bookworm)", "Debian"],
    ["CentOS Linux 7 (Core)", "CentOS"],
    ["AlmaLinux 9.3 (Shamrock Pampas Cat)", "AlmaLinux"],
    ["Rocky Linux 9.3 (Blue Onyx)", "Rocky Linux"],
  ])("%s → %s", (input, expected) => {
    expect(osShortName(input)).toBe(expected);
  });
});

describe("osShortName — legacy-значения из старой формы Add Server", () => {
  /**
   * До переезда на общий модуль форма отдавала строку вида «Ubuntu 22.04 LTS
   * (x86_64)» — с архитектурой в скобках. Формат ушёл из формы, но старые
   * серверы в базе с ним остались.
   */
  it("Ubuntu 22.04 LTS (x86_64) → Ubuntu", () => {
    expect(osShortName("Ubuntu 22.04 LTS (x86_64)")).toBe("Ubuntu");
  });
});

describe("osShortName — регистр", () => {
  it("нижний регистр всё равно даёт каноничное имя", () => {
    expect(osShortName("ubuntu")).toBe("Ubuntu");
  });
});

/**
 * Круговая проверка: каждое значение, которое можно ВЫБРАТЬ в форме,
 * обязано возвращать само себя. Ловит ситуацию «в `OS_OPTIONS` добавили
 * шестой пункт формы, а иголку в `FAMILY_NEEDLES` для него забыли завести» —
 * иначе такой выбор молча уезжал бы в fallback.
 */
describe("osShortName — каждое значение OS_OPTIONS возвращается само собой", () => {
  it.each(OS_OPTIONS)("%s", (opt) => {
    expect(osShortName(opt)).toBe(opt);
  });
});

/**
 * Иголки шире `OS_OPTIONS`: Red Hat и Fedora выбрать в форме нельзя, но
 * `os_pretty` десктоп вычитывает из настоящего `/etc/os-release`, и там они
 * встречаются. Без этих иголок фраза вида «Red Hat Enterprise Linux» дала бы
 * обрубок «Red», а «Linux Mint» — «Linux»: обе матчатся дефолтным fallback
 * раньше, чем добрались бы до настоящего семейства.
 */
describe("osShortName — иголки шире OS_OPTIONS (Red Hat, Fedora)", () => {
  it.each([
    ["Red Hat Enterprise Linux 9.3 (Plow)", "Red Hat"],
    ["RHEL 8.9 (Ootpa)", "Red Hat"],
    ["Fedora Linux 39", "Fedora"],
  ])("%s → %s", (input, expected) => {
    expect(osShortName(input)).toBe(expected);
  });
});

describe("osShortName — fallback для семейств вне списка", () => {
  /**
   * Ни одно известное семейство не подошло — режем по первой цифре и берём
   * первое слово, а не всю голову: у openSUSE иначе осталось бы лишнее
   * «Leap», которого нет ни у одного канонического имени.
   */
  it.each([
    ["openSUSE Leap 15.5", "openSUSE"],
    ["Slackware 15.0", "Slackware"],
  ])("%s → %s", (input, expected) => {
    expect(osShortName(input)).toBe(expected);
  });

  /**
   * `parseServerMetrics` вычищает из `os_pretty` только сам управляющий байт
   * (ESC), а видимый остаток escape-последовательности вроде «[0m» оставляет
   * как есть (см. `serverMetrics.test.ts`) — и для неизвестного семейства он
   * может уехать в конец первого слова. Срезаем хвостовой не-буквенный мусор,
   * а не отдаём его наружу огрызком имени.
   */
  it("хвостовой ANSI-огрызок не остаётся в результате", () => {
    expect(osShortName("Slackware[0m 15.0")).toBe("Slackware");
  });
});

describe("osShortName — пустые значения", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["пустая строка", ""],
    ["строка из одних пробелов", "   "],
    // Цифра в самом начале: обрезать нечего, а не пустую строку молча
    // считать именем.
    ["строка из одной версии без имени", "39"],
  ])("%s → null", (_name, input) => {
    expect(osShortName(input)).toBeNull();
  });
});
