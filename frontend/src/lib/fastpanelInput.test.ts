import { describe, it, expect } from "vitest";

import { fastpanelUrlError, fastpanelUserError } from "./fastpanelInput";

/**
 * Форма «Connect Existing Fastpanel» — единственное место, где адрес панели и
 * её логин набирает человек, а не разбирает десктоп. С тех пор как схема
 * `ServerCreate` отвергает URL с userinfo, не-http схему, адрес без порта и
 * логин с пробелом, обычная опечатка стала давать 422 — а `client.ts` для 422
 * кладёт в форму `String(data.detail)`, то есть `[object Object]`.
 *
 * Правила здесь — копия серверных (`backend/app/core/validators.py`) и
 * десктопных (`provision/fastpanel_install.rs`). Полноценным URL-парсером не
 * притворяются: проверяются ровно три вещи — схема, отсутствие userinfo,
 * форма «хост:порт».
 */
describe("fastpanelUrlError", () => {
  it("пропускает адрес панели", () => {
    expect(fastpanelUrlError("https://192.168.1.100:8888")).toBeNull();
    expect(fastpanelUrlError("http://panel.example.com:8888/login")).toBeNull();
    // Набранное с пробелами по краям уедет на сервер обрезанным — значит и
    // проверять надо обрезанное, иначе форма зеленеет там, где сервер откажет.
    expect(fastpanelUrlError("  https://192.168.1.100:8888  ")).toBeNull();
  });

  it("отвергает креды внутри URL", () => {
    // Ровно тот случай, ради которого затевался долг №10: пароль панели в
    // значении, которое уезжает в колонку и в аудит.
    expect(fastpanelUrlError("https://admin:s3cr3t@192.168.1.100:8888/")).toMatch(/credential/i);
    expect(fastpanelUrlError("https://admin@192.168.1.100:8888")).toMatch(/credential/i);
    // Пароль с `/` внутри по RFC уже не userinfo: authority кончается на `/`
    // и равна `admin:12` — идеальному «хост:порт», — а логин с паролем
    // проезжали как путь. Отсюда правило «`@` где угодно — отказ», и `@` в
    // пути отвергается заодно (панельного адреса с ним не бывает).
    expect(fastpanelUrlError("https://admin:12/345@192.168.1.100:8888")).toMatch(/credential/i);
    expect(fastpanelUrlError("https://192.168.1.100:8888/mail@example")).toMatch(/credential/i);
  });

  it("отвергает адрес без схемы и без порта — с разным текстом", () => {
    // Два разных промаха, и человеку надо сказать, какой именно: «добавьте
    // http://» и «добавьте :8888» — это разные правки.
    const noScheme = fastpanelUrlError("10.0.0.9:8888");
    const noPort = fastpanelUrlError("https://panel.example.com");
    expect(noScheme).toMatch(/https?:\/\//);
    expect(noPort).toMatch(/port/i);
    expect(noScheme).not.toEqual(noPort);
  });

  it("отвергает пустое поле", () => {
    expect(fastpanelUrlError("   ")).toMatch(/required/i);
  });

  it("отвергает управляющие символы", () => {
    // Вставка из терминала приносит ANSI-раскраску вместе с адресом. Без этой
    // проверки форма зеленела бы, а 422 от бэкенда приезжал бы в неё как
    // `[object Object]` — то, ради чего модуль и заводился.
    expect(fastpanelUrlError("https://1.2.3.4:8888/\x1b[0m")).toMatch(/control/i);
    expect(fastpanelUrlError("https://1.2.3.4:8888/x\x7fy")).toMatch(/control/i);
  });
});

describe("fastpanelUserError", () => {
  it("пропускает логин панели", () => {
    expect(fastpanelUserError("fastuser")).toBeNull();
  });

  it("отвергает пустой логин и логин с пробелом", () => {
    // Пробел внутри — это 422 от `is_valid_fastpanel_user`: разбор на десктопе
    // ловит `(\S+)`, и серверное правило повторяет его один в один.
    expect(fastpanelUserError("")).toMatch(/required/i);
    expect(fastpanelUserError("fast user")).toMatch(/space/i);
  });

  it("отвергает управляющие символы в логине", () => {
    expect(fastpanelUserError("fast\x7fuser")).toMatch(/control/i);
  });
});
