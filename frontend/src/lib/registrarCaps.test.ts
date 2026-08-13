import { describe, it, expect } from "vitest";

import { registrarSupportsNsApi } from "./registrarCaps";

/**
 * Список зеркалит `make_service` (`desktop/src-tauri/src/registrars/mod.rs`).
 * Тест не одобряет конкретные два имени, он не даёт им разъехаться с десктопом
 * молча: провайдер, добавленный там и не добавленный здесь, останется с
 * выключенной кнопкой «Set NS», и заметить это можно будет только глазами.
 */
describe("registrarSupportsNsApi", () => {
  it("знает ровно тех провайдеров, которых знает make_service", () => {
    expect(registrarSupportsNsApi("hostiq")).toBe(true);
    expect(registrarSupportsNsApi("namecheap")).toBe(true);
    expect(registrarSupportsNsApi("godaddy")).toBe(false);
    expect(registrarSupportsNsApi("reg.ru")).toBe(false);
  });

  it("схлопывает регистр — ровно то, что делает `to_lowercase()` в десктопе", () => {
    // В колонке `registrar_accounts.provider` лежит произвольная строка: после
    // чужого импорта там встречается «Namecheap».
    expect(registrarSupportsNsApi("Namecheap")).toBe(true);
    expect(registrarSupportsNsApi("HOSTIQ")).toBe(true);
  });

  it("пробелы НЕ схлопывает: их не срезает и десктоп", () => {
    // `make_service` делает только `to_lowercase()`, поэтому `" namecheap "`
    // для него — неизвестный провайдер. Признай мы такую строку рабочей, фронт
    // оставил бы живой кнопку с гарантированным `unknown provider` за ней —
    // ровно то, ради чего этот модуль и заведён.
    expect(registrarSupportsNsApi("  HOSTIQ ")).toBe(false);
    expect(registrarSupportsNsApi(" namecheap")).toBe(false);
  });

  it("незнание провайдера — это НЕ «умеет»", () => {
    // Аккаунт не прочитан (или удалён) — провайдера нет. Округлив это в сторону
    // «умеет», карточка дала бы нажать кнопку, за которой отказ десктопа.
    expect(registrarSupportsNsApi(null)).toBe(false);
    expect(registrarSupportsNsApi(undefined)).toBe(false);
    expect(registrarSupportsNsApi("")).toBe(false);
    expect(registrarSupportsNsApi("   ")).toBe(false);
  });
});
