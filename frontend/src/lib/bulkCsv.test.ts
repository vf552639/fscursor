import { describe, expect, it } from "vitest";

import { bulkCsvErrorText, parseBulkCsv } from "./bulkCsv";

/**
 * Разбор CSV массового добавления.
 *
 * Проверяется здесь, а не через диалог, потому что цена ошибки тут не в
 * разметке: третья колонка становится `server_id`, а по нему provision заливает
 * сайт на машину. Строка, отданная не тому серверу, — это чужой сайт на чужом
 * железе, и увидеть это можно только после заливки.
 *
 * Отдельная тема тестов — номер строки в ошибке: он единственное, чем человек
 * находит опечатку в сотне вставленных строк, и считаться он обязан по тексту
 * в textarea, а не по тому, что осталось после отбрасывания пустых.
 */

const WEB01 = { id: 11, name: "web-01", ip_address: "45.83.194.107" };
const WEB02 = { id: 12, name: "web-02", ip_address: "10.0.0.2" };
const SERVERS = [WEB01, WEB02];

describe("parseBulkCsv", () => {
  it("третью колонку резолвит по IP", () => {
    const r = parseBulkCsv("example.com;Namecheap;45.83.194.107", { servers: SERVERS });
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].domain_name).toBe("example.com");
    expect(r.items[0].registrar_name).toBe("Namecheap");
    expect(r.items[0].server_id).toBe(WEB01.id);
  });

  it("третью колонку резолвит по имени", () => {
    const r = parseBulkCsv("example.com;Namecheap;web-02", { servers: SERVERS });
    expect(r.errors).toEqual([]);
    expect(r.items[0].server_id).toBe(WEB02.id);
  });

  it("имя сервера сверяет без учёта регистра и пробелов по краям", () => {
    const r = parseBulkCsv("example.com;Namecheap;  WEB-02  ", { servers: SERVERS });
    expect(r.errors).toEqual([]);
    expect(r.items[0].server_id).toBe(WEB02.id);
  });

  it("пустая третья колонка берёт сервер из селекта", () => {
    const r = parseBulkCsv("example.com;Namecheap\nshop.com;Hostiq;", {
      servers: SERVERS,
      defaultServerId: WEB01.id,
    });
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.server_id)).toEqual([WEB01.id, WEB01.id]);
  });

  it("без сервера в селекте пустая третья колонка оставляет домен без сервера", () => {
    const r = parseBulkCsv("example.com;Namecheap", { servers: SERVERS });
    expect(r.items[0].server_id).toBeNull();
  });

  it("ненайденное значение называет ИСХОДНЫЙ номер строки", () => {
    // Пустые строки между данными — обычная копипаста; после их отбрасывания
    // «строка 2» указывала бы человека не туда.
    const text = "example.com;Namecheap;web-01\n\n\nshop.com;Hostiq;1.2.3.4";
    const r = parseBulkCsv(text, { servers: SERVERS });
    expect(r.errors).toEqual([{ line: 4, value: "1.2.3.4", reason: "not-found" }]);
  });

  it("ненайденное значение НЕ подменяется сервером из селекта", () => {
    const r = parseBulkCsv("example.com;Namecheap;1.2.3.4", {
      servers: SERVERS,
      defaultServerId: WEB02.id,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.items[0].server_id).toBeNull();
  });

  it("значение, подошедшее двум серверам, — тоже ошибка, а не первый попавшийся", () => {
    // Сервер, названный чужим IP: выбрать за пользователя нечем (то же правило,
    // что в `lib/cfZoneMatch`).
    const twin = { id: 13, name: "45.83.194.107", ip_address: "10.0.0.3" };
    const r = parseBulkCsv("example.com;Namecheap;45.83.194.107", {
      servers: [...SERVERS, twin],
    });
    expect(r.errors).toEqual([{ line: 1, value: "45.83.194.107", reason: "ambiguous" }]);
    expect(r.items[0].server_id).toBeNull();
  });

  it("один и тот же сервер, совпавший и по имени, и по IP, неоднозначностью не считается", () => {
    const selfNamed = { id: 14, name: "10.0.0.9", ip_address: "10.0.0.9" };
    const r = parseBulkCsv("example.com;Namecheap;10.0.0.9", { servers: [selfNamed] });
    expect(r.errors).toEqual([]);
    expect(r.items[0].server_id).toBe(selfNamed.id);
  });

  it("запятые вместо точек с запятой отменяют разбор целиком", () => {
    const r = parseBulkCsv("example.com,Namecheap,45.83.194.107", { servers: SERVERS });
    expect(r.commaSeparated).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("запятая внутри строки с точкой с запятой разбор не отменяет", () => {
    const r = parseBulkCsv("example.com;Reg, Inc.;web-01", { servers: SERVERS });
    expect(r.commaSeparated).toBe(false);
    expect(r.items[0].registrar_name).toBe("Reg, Inc.");
  });

  it("строки без домена выпадают молча — и вторая не становится дублём первой", () => {
    // Две пустые первые колонки дают ОДИН нормализованный ключ, поэтому гард
    // пустого домена обязан стоять раньше проверки дубля: иначе вставка
    // блокируется жалобой на домен, которого в ней нет.
    const r = parseBulkCsv("  ;Namecheap;1.2.3.4\n;Hostiq;web-01\nexample.com;Namecheap;web-01", {
      servers: SERVERS,
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].domain_name).toBe("example.com");
    expect(r.errors).toEqual([]);
  });

  it("пустой текст даёт пустой разбор", () => {
    const r = parseBulkCsv("   \n\n", { servers: SERVERS });
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.commaSeparated).toBe(false);
  });

  it("второе вхождение домена — ошибка со своим номером строки, а не второй item", () => {
    // `bulk_create_structured` внутри пачки не дедуплицирует (в отличие от
    // текстового `bulk_create`), а имя домена уникально глобально: два
    // одинаковых имени доезжают до commit и дают 500 — без номера строки и без
    // единого созданного домена.
    const r = parseBulkCsv("a.com;Reg;web-01\nb.com;Reg;web-01\na.com;Reg;web-02", {
      servers: SERVERS,
    });
    expect(r.errors).toEqual([{ line: 3, value: "a.com", reason: "duplicate", firstLine: 1 }]);
    expect(r.items.map((i) => i.domain_name)).toEqual(["a.com", "b.com"]);
  });

  it("дубль ловится той же нормализацией имени, что и на бэкенде", () => {
    // `normalize_domain` там — trim + lower + срез точки; своё правило здесь
    // означало бы «разные домены» на фронте и «один и тот же» в базе.
    const r = parseBulkCsv("example.com;Reg;web-01\n Example.COM. ;Reg;web-01", {
      servers: SERVERS,
    });
    expect(r.errors.map((e) => e.reason)).toEqual(["duplicate"]);
    expect(r.items).toHaveLength(1);
  });

  it("у дубля свой сервер уже не спрашивают — одна строка, одна причина", () => {
    const r = parseBulkCsv("a.com;Reg;web-01\na.com;Reg;1.2.3.4", { servers: SERVERS });
    expect(r.errors).toEqual([{ line: 2, value: "a.com", reason: "duplicate", firstLine: 1 }]);
  });

  it("у каждой причины своя формулировка, и подлежащее в ней верное", () => {
    expect(bulkCsvErrorText({ line: 2, value: "1.2.3.4", reason: "not-found" })).toContain("сервер");
    expect(bulkCsvErrorText({ line: 2, value: "1.2.3.4", reason: "ambiguous" })).toContain(
      "подходит нескольким",
    );
    // Дубль — про домен: общий шаблон «сервер «...»» назвал бы домен сервером.
    const dup = bulkCsvErrorText({ line: 5, value: "a.com", reason: "duplicate", firstLine: 2 });
    expect(dup).toContain("домен");
    // И называет НОМЕР первой строки: ключ нормализован, поэтому та строка
    // может быть написана иначе, и «уже есть выше» человек бы не опознал.
    expect(dup).toContain("2");
  });

  it("сообщение про дубль называет строку первого вхождения, а не его написание", () => {
    const r = parseBulkCsv("Example.COM.;Reg;web-01\nb.com;Reg;web-01\nexample.com;Reg;web-01", {
      servers: SERVERS,
    });
    expect(bulkCsvErrorText(r.errors[0])).toBe("домен «example.com» — дубль строки 1");
  });

  it("пустая вторая колонка берёт регистратора из селекта, непустая — побеждает его", () => {
    const r = parseBulkCsv("example.com;;web-01\nshop.com;Hostiq;web-01", {
      servers: SERVERS,
      defaultRegistrarId: 5,
    });
    expect(r.items[0].registrar_name).toBeNull();
    expect(r.items[0].registrar_id).toBe(5);
    // Имя из строки резолвит бэкенд (`find_reg_id`), и id из селекта его бы
    // перебил — поэтому у строки со своим регистратором id пуст.
    expect(r.items[1].registrar_name).toBe("Hostiq");
    expect(r.items[1].registrar_id).toBeNull();
  });
});
