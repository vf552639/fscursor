import { describe, it, expect } from "vitest";
import {
  BUILD_INFO,
  UNKNOWN,
  buildLabel,
  buildTooltip,
  formatBuiltAt,
  type BuildInfo,
} from "./buildInfo";

const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: "0.1.0",
  commit: "86be15a1",
  builtAt: "2026-08-07T09:05:00.000Z",
  ...over,
});

describe("buildLabel", () => {
  it("показывает версию и коммит вместе — версии одной для различения сборок мало", () => {
    expect(buildLabel(info())).toBe("v0.1.0 · 86be15a1");
  });

  it("сохраняет пометку грязного дерева: бинарник не соответствует коммиту", () => {
    expect(buildLabel(info({ commit: "86be15a1+" }))).toBe("v0.1.0 · 86be15a1+");
  });

  it("без коммита остаётся одна версия, без выдуманного SHA", () => {
    expect(buildLabel(info({ commit: UNKNOWN }))).toBe("v0.1.0");
  });

  it("без версии остаётся один коммит — он различает сборки сам по себе", () => {
    expect(buildLabel(info({ version: UNKNOWN }))).toBe("build 86be15a1");
  });

  it("не зная ничего, честно пишет unknown, а не пустую строку", () => {
    expect(buildLabel(info({ version: UNKNOWN, commit: UNKNOWN }))).toBe("build unknown");
  });

  it("пустая строка — такое же незнание, как и unknown", () => {
    expect(buildLabel(info({ version: "", commit: "" }))).toBe("build unknown");
  });
});

describe("formatBuiltAt", () => {
  it("печатает время сборки в зоне читателя, до минут", () => {
    // Дата собрана из локальных компонент, поэтому проверка не зависит от TZ
    // машины, на которой гоняются тесты.
    const local = new Date(2026, 7, 7, 9, 5, 30);
    expect(formatBuiltAt(local.toISOString())).toBe("2026-08-07 09:05");
  });

  it("дополняет однозначные месяц, день и час нулём", () => {
    const local = new Date(2026, 0, 2, 3, 4);
    expect(formatBuiltAt(local.toISOString())).toBe("2026-01-02 03:04");
  });

  it("нечитаемую дату не выдаёт за измерение", () => {
    expect(formatBuiltAt("не дата")).toBe(UNKNOWN);
  });

  it("отсутствие даты остаётся отсутствием", () => {
    expect(formatBuiltAt(UNKNOWN)).toBe(UNKNOWN);
    expect(formatBuiltAt("")).toBe(UNKNOWN);
  });
});

describe("buildTooltip", () => {
  it("раскрывает все три поля построчно", () => {
    const local = new Date(2026, 7, 7, 9, 5);
    expect(buildTooltip(info({ builtAt: local.toISOString() }))).toBe(
      "Version: 0.1.0\nCommit: 86be15a1\nBuilt: 2026-08-07 09:05"
    );
  });

  it("неизвестное поле подписано, а не выброшено — иначе строк было бы меньше", () => {
    expect(buildTooltip(info({ commit: UNKNOWN, builtAt: "" }))).toBe(
      "Version: 0.1.0\nCommit: unknown\nBuilt: unknown"
    );
  });
});

describe("BUILD_INFO", () => {
  it("собран из define и в этой сборке содержит строки", () => {
    // Значения зависят от машины сборки, поэтому проверяем не их, а то, что
    // define вообще доехал: пустое или undefined здесь означало бы, что
    // vite.config перестал их подставлять, и весь модуль молча показывал бы
    // unknown в рабочей сборке.
    expect(typeof BUILD_INFO.version).toBe("string");
    expect(typeof BUILD_INFO.commit).toBe("string");
    expect(typeof BUILD_INFO.builtAt).toBe("string");
    expect(BUILD_INFO.version).not.toBe("");
    expect(BUILD_INFO.commit).not.toBe("");
    expect(BUILD_INFO.builtAt).not.toBe("");
  });

  it("в репозитории define даёт настоящие значения, а не заглушку", () => {
    // Тесты гоняются из рабочего дерева, где и tauri.conf.json, и .git на
    // месте. Если тут unknown — сломался именно источник в vite.config.ts,
    // а не форматирование выше.
    expect(BUILD_INFO.version).toMatch(/^\d+\.\d+/);
    expect(BUILD_INFO.commit).toMatch(/^[0-9a-f]{7,}\+?$/);
    expect(formatBuiltAt(BUILD_INFO.builtAt)).not.toBe(UNKNOWN);
  });
});
