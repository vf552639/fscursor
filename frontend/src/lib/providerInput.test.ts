import { describe, it, expect } from "vitest";

import { PROVIDER_MAX_LEN, providerError, providerOptions, providerPayload } from "./providerInput";

/**
 * Правило проверки провайдера — вторая копия серверного
 * (`is_valid_provider` + `_checked_provider` в бэкенде). Копия нужна по той же
 * причине, что и у `fastpanelInput`: 422 приезжает в форму строкой из
 * `formatErrorDetail`, и «string_too_long» вместо внятной фразы у поля
 * пользователя ничему не учит.
 *
 * Границы записаны ЛИТЕРАЛАМИ (64/65), а не через `PROVIDER_MAX_LEN`: сверка
 * константы с самой собой зеленела бы при любом её значении, включая то, при
 * котором лишний символ доезжает до Postgres и возвращается 500-й.
 */

describe("providerError", () => {
  it("пустое поле — не ошибка: провайдер необязателен", () => {
    expect(providerError("")).toBeNull();
    // Пробелы сервер срезает (`_checked_provider`), после обрезки это пустое
    // поле, а не значение из одних пробелов.
    expect(providerError("   ")).toBeNull();
  });

  it("пробел ВНУТРИ имени разрешён — в отличие от логина панели", () => {
    // «Hetzner Online», «OVH Cloud» — обычные имена; правило `\S+` от логина
    // FastPanel сюда не переносится.
    expect(providerError("Hetzner Online")).toBeNull();
  });

  it("ровно ширина колонки проходит, а 65-й символ — уже нет", () => {
    expect(PROVIDER_MAX_LEN).toBe(64);
    expect(providerError("x".repeat(64))).toBeNull();
    expect(providerError("x".repeat(65))).toContain("64");
  });

  it("длина считается ПОСЛЕ обрезки — как на сервере", () => {
    // Сервер сначала `strip()`, потом `is_valid_provider`. Проверь мы длину до
    // обрезки — форма краснела бы там, где сервер записывает без вопросов.
    expect(providerError(`  ${"x".repeat(64)}  `)).toBeNull();
  });

  it("управляющие символы — отказ: значение уезжает в аудит", () => {
    // `\n` внутри строки аудит-лога превращает одну запись в две, вторая из
    // которых выглядит настоящей (долг №10).
    expect(providerError("Het\nzner")).toContain("control");
    expect(providerError("Het\x1bzner")).toContain("control");
  });
});

describe("providerPayload", () => {
  it("очищенное поле уезжает как null, а не пустой строкой", () => {
    // `""` в колонке означал бы «провайдер есть, и он пустой»: и `datalist`, и
    // фильтр считали бы его отдельным провайдером.
    expect(providerPayload("")).toBeNull();
    expect(providerPayload("   ")).toBeNull();
  });

  it("обрамляющие пробелы срезает сам, не полагаясь на сервер", () => {
    expect(providerPayload("  Hetzner  ")).toBe("Hetzner");
  });
});

describe("providerOptions", () => {
  it("даёт уникальные непустые имена по алфавиту", () => {
    expect(
      providerOptions([
        { provider: "Hetzner" },
        { provider: null },
        { provider: "AWS" },
        { provider: "Hetzner" },
        { provider: "" },
        {},
      ]),
    ).toEqual(["AWS", "Hetzner"]);
  });

  it("сортировка не зависит от регистра — иначе «aws» уезжает под все заглавные", () => {
    expect(providerOptions([{ provider: "Hetzner" }, { provider: "aws" }])).toEqual([
      "aws",
      "Hetzner",
    ]);
  });

  it("значения с хвостовым пробелом не плодят второго «того же самого»", () => {
    // Сегодня сервер обрезает при записи, но в списке лежат и строки, записанные
    // до появления этой проверки.
    expect(providerOptions([{ provider: "Hetzner" }, { provider: "Hetzner " }])).toEqual([
      "Hetzner",
    ]);
  });
});
