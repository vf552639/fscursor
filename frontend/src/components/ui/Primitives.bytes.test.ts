import { describe, it, expect } from "vitest";

import { formatBytes } from "./Primitives";

/**
 * Размер файла словами. Проверяем не красоту вывода, а два его обещания:
 * двоичные ступени (как у `stat`, из которого число и приходит) и то, что ноль
 * остаётся нулём — «пусто» и «не прочитали» на карточке домена разные новости,
 * и вторая сюда не попадает вовсе (аргумент не принимает `null`).
 */
describe("formatBytes", () => {
  it("до килобайта — байтами, ноль остаётся нулём", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("ступени двоичные, а не десятичные", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    // Десятичное деление дало бы здесь «1 KB» — то есть меньший файл выглядел
    // бы ровно как килобайтный.
    expect(formatBytes(1000)).toBe("1000 B");
  });

  it("десятая доля — только пока она различима", () => {
    expect(formatBytes(1024 * 2.5)).toBe("2.5 KB");
    expect(formatBytes(1024 * 24.4)).toBe("24 KB");
  });

  it("то, что размером не является, — прочерк, а не правдоподобное число", () => {
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
  });
});
