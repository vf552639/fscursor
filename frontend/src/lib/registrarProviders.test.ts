import { describe, it, expect } from "vitest";
import {
  hasApi,
  needsClientIp,
  normalizeProvider,
  providerMeta,
  buildProviderList,
} from "./registrarProviders";

describe("registrarProviders — API-способность", () => {
  it("hasApi: только каталожные провайдеры, без учёта регистра и пробелов", () => {
    expect(hasApi("hostiq")).toBe(true);
    expect(hasApi("  Namecheap ")).toBe(true);
    expect(hasApi("godaddy")).toBe(false);
    expect(hasApi("")).toBe(false);
  });

  it("needsClientIp: только Namecheap", () => {
    expect(needsClientIp("namecheap")).toBe(true);
    expect(needsClientIp("HOSTIQ")).toBe(false);
    expect(needsClientIp("godaddy")).toBe(false);
  });

  it("normalizeProvider: нижний регистр и trim", () => {
    expect(normalizeProvider("  Hostiq ")).toBe("hostiq");
  });
});

describe("registrarProviders — метаданные показа", () => {
  it("API-провайдер: метка и флаг из каталога", () => {
    const m = providerMeta("namecheap");
    expect(m.label).toBe("Namecheap");
    expect(m.api).toBe(true);
    expect(m.icon).toBe("N");
  });

  it("ручной провайдер: метка = ввод, буква = первая, api=false, без '?'", () => {
    const m = providerMeta("GoDaddy");
    expect(m.label).toBe("GoDaddy");
    expect(m.api).toBe(false);
    expect(m.icon).toBe("G");
  });

  it("ручной провайдер: цвет детерминирован по имени", () => {
    expect(providerMeta("GoDaddy").bg).toBe(providerMeta("godaddy").bg);
  });
});

describe("registrarProviders — список для выпадашки", () => {
  it("сначала API-каталог, затем уникальные ручные из аккаунтов", () => {
    const list = buildProviderList([
      { provider: "GoDaddy" },
      { provider: "godaddy" }, // дубль по регистру — не повторяем
      { provider: "hostiq" },  // уже в каталоге — не повторяем
    ]);
    const keys = list.map((o) => o.key);
    expect(keys.slice(0, 2)).toEqual(["hostiq", "namecheap"]); // каталог первым
    expect(keys.filter((k) => k === "godaddy").length).toBe(1);
    expect(list.find((o) => o.key === "godaddy")?.api).toBe(false);
  });

  it("ноль аккаунтов: только API-каталог", () => {
    expect(buildProviderList([]).map((o) => o.key)).toEqual(["hostiq", "namecheap"]);
  });
});
