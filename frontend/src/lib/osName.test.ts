import { describe, it, expect } from "vitest";

import { osShortName } from "./osName";

/**
 * `osShortName` — чистая функция, поэтому весь разбор проверяется на строках,
 * без сервера и без десктопа. Главное здесь — что версия и архитектура,
 * которые приносит `os_pretty` из `/etc/os-release`, отваливаются одинаково
 * для всех пяти поддерживаемых семейств, а не только для той пары, что
 * попалась при разработке.
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

describe("osShortName — fallback для семейств вне списка", () => {
  /**
   * Ни одно из пяти известных семейств не подошло — режем по первой цифре и
   * берём первое слово, а не всю голову: у Fedora иначе осталось бы лишнее
   * «Linux», которого нет ни у одного из пяти канонических имён.
   */
  it.each([
    ["Fedora Linux 39", "Fedora"],
    ["openSUSE Leap 15.5", "openSUSE"],
  ])("%s → %s", (input, expected) => {
    expect(osShortName(input)).toBe(expected);
  });
});

describe("osShortName — пустых значений", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["пустая строка", ""],
    ["строка из одних пробелов", "   "],
  ])("%s → null", (_name, input) => {
    expect(osShortName(input)).toBeNull();
  });
});
