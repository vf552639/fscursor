import { describe, it, expect } from "vitest";

import { logFileLabel } from "./logFiles";

/**
 * Подпись лог-файла выводится из пути. Проверяем обе половины правила: знакомую
 * форму — что она разбирается, и незнакомую — что она НЕ выдумывается.
 */
describe("logFileLabel", () => {
  it("знакомая форма `<домен>-<вид>.log` становится подписью с заглавной", () => {
    // Ровно то, что строит `log_candidates` в десктопе.
    expect(logFileLabel("/var/www/example_usr/data/logs/example.com-frontend.access.log", "example.com")).toBe(
      "Frontend access",
    );
    expect(logFileLabel("/var/www/example_usr/data/logs/example.com-backend.error.log", "example.com")).toBe(
      "Backend error",
    );
  });

  it("дефис в имени домена не режет его пополам", () => {
    // Ради этого случая имя домена и приходит аргументом: «до первого дефиса»
    // дало бы здесь «Site.com frontend error».
    expect(logFileLabel("/home/u/logs/my-site.com-frontend.error.log", "my-site.com")).toBe("Frontend error");
  });

  it("регистр имени домена не мешает", () => {
    expect(logFileLabel("/home/u/logs/example.com-backend.access.log", "Example.com")).toBe("Backend access");
  });

  it("путь незнакомой формы печатается именем файла, а не выдуманной подписью", () => {
    // Разбор «на всякий случай» превратил бы это в «Example com error» —
    // название, которого в системе нет.
    expect(logFileLabel("/var/log/nginx/example.com.error.log", "example.com")).toBe("example.com.error.log");
    expect(logFileLabel("/var/log/syslog", "example.com")).toBe("syslog");
  });

  it("вид из одного слова тоже подписывается", () => {
    expect(logFileLabel("/home/u/logs/example.com-php.log", "example.com")).toBe("Php");
  });

  it("вырожденные пути не роняют разбор и ничего не сочиняют", () => {
    expect(logFileLabel("/home/u/logs/", "example.com")).toBe("/home/u/logs/");
    expect(logFileLabel("", "example.com")).toBe("");
    // Формально знакомая форма, но вида в ней нет — остаётся имя файла.
    expect(logFileLabel("/home/u/logs/example.com-.log", "example.com")).toBe("example.com-.log");
  });
});
