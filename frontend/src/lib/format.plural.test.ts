import { describe, expect, it } from "vitest";

import { domainWord } from "./format";

/**
 * Склонение счётчика доменов. Проверяется здесь, а не через ярлыки выпадашки в
 * `fullSetupPlan.test.ts`: те гоняют функцию на 0, 1 и 2, то есть ровно ту
 * часть правила, которую трудно написать неправильно. Опасны исключения — 11–14
 * («11 доменов», а не «11 домен») и возврат правила единиц на 21, — и порядок
 * проверок в самой функции существует только ради них.
 */

describe("domainWord", () => {
  it("единица — «домен», но только настоящая единица", () => {
    expect(domainWord(1)).toBe("домен");
    expect(domainWord(21)).toBe("домен");
    expect(domainWord(101)).toBe("домен");
  });

  it("два-четыре — «домена»", () => {
    expect(domainWord(2)).toBe("домена");
    expect(domainWord(3)).toBe("домена");
    expect(domainWord(4)).toBe("домена");
    expect(domainWord(22)).toBe("домена");
    expect(domainWord(104)).toBe("домена");
  });

  it("пять и дальше до десяти — «доменов»", () => {
    expect(domainWord(5)).toBe("доменов");
    expect(domainWord(9)).toBe("доменов");
    expect(domainWord(10)).toBe("доменов");
  });

  /**
   * Тот самый десяток, ради которого в функции стоит комментарий про порядок
   * проверок: по последней цифре 11 и 21 неотличимы, а слово у них разное.
   */
  it("одиннадцать–четырнадцать — исключение, «доменов»", () => {
    expect(domainWord(11)).toBe("доменов");
    expect(domainWord(12)).toBe("доменов");
    expect(domainWord(13)).toBe("доменов");
    expect(domainWord(14)).toBe("доменов");
    expect(domainWord(111)).toBe("доменов");
    expect(domainWord(112)).toBe("доменов");
  });

  /**
   * Ноль сюда доезжает: пустую пачку кнопки не отправляют, но подпись
   * загруженности сервера («prod-01 — 0 доменов») считается по тому же правилу.
   */
  it("ноль — «доменов»", () => {
    expect(domainWord(0)).toBe("доменов");
    expect(domainWord(20)).toBe("доменов");
    expect(domainWord(100)).toBe("доменов");
  });
});
