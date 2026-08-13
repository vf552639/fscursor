import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { registrarSupportsNsApi } from "./registrarCaps";

/**
 * Список зеркалит `make_service` (`desktop/src-tauri/src/registrars/mod.rs`).
 * Тест не одобряет конкретные два имени, он не даёт им разъехаться с десктопом
 * молча: провайдер, добавленный там и не добавленный здесь, останется с
 * выключенной кнопкой «Set NS», и заметить это можно будет только глазами.
 */

/**
 * Файл-первоисточник и файл-зеркало. Пути считаются от этого теста, а не от
 * `process.cwd()`: запуск из корня монорепозитория и из `frontend/` должен
 * находить одно и то же. Через `fileURLToPath`, а не `new URL(…,
 * import.meta.url)`: последнее Vite переписывает в URL ассета
 * (`http://localhost/@fs/…`), и `readFileSync` такой не открывает.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RUST_SOURCE = resolve(HERE, "../../../desktop/src-tauri/src/registrars/mod.rs");
const TS_MIRROR = resolve(HERE, "registrarCaps.ts");

/**
 * Вытащить список `NS_API_PROVIDERS` из исходника — в обоих языках он объявлен
 * массивом строковых литералов, и это единственное, что тесту нужно знать про
 * их синтаксис.
 */
function providersIn(source: string): string[] {
  const text = readFileSync(source, "utf8");
  const declaration = /NS_API_PROVIDERS[^=]*=\s*\[([^\]]*)\]/.exec(text);
  if (!declaration) {
    throw new Error(`NS_API_PROVIDERS не найден в ${source} — объявление переименовали?`);
  }
  return [...declaration[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

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

  /**
   * Единственное, что держит зеркало от дрейфа.
   *
   * На стороне Rust список привязан к фабрике собственным тестом
   * (`ns_api_list_matches_what_make_service_can_build`), на стороне TS до сих
   * пор не держало ничто: провайдер, добавленный в десктоп, оставлял бы тумблер
   * «Прописать NS» навсегда погасшим — ровно тот отказ, ради предотвращения
   * которого модуль и заведён, и молчаливый.
   *
   * Читаем исходник с диска, а не экспортируем константу наружу: наружу этот
   * модуль намеренно отдаёт ответ на вопрос, а не список, по которому
   * вызывающий напишет своё сравнение (и напишет его без `toLowerCase`).
   * Красиво это не выглядит, зато расхождение становится красным, а не устным.
   * Настоящее лечение — генерация константы или команда, отдающая список из
   * десктопа; это отдельная задача.
   */
  it("список совпадает с десктопным — файл к файлу", () => {
    const rust = providersIn(RUST_SOURCE);
    expect(rust.length).toBeGreaterThan(0);
    expect(providersIn(TS_MIRROR)).toEqual(rust);
    // И зеркало не просто похоже на список, а действительно им отвечает.
    for (const provider of rust) {
      expect(registrarSupportsNsApi(provider), `провайдер ${provider}`).toBe(true);
    }
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
