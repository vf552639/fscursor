import { describe, expect, it } from "vitest";

import { domainOriginCheck } from "./domainOriginCheck";

/**
 * Сверка «куда ведёт apex домена» с адресом выбранного сервера.
 *
 * Главное правило набора — четвёртый исход. `unknown` обязан отличаться и от
 * «совпало», и от «A-записи нет»: карточка домена рисует по нему МОЛЧАНИЕ, а по
 * `mismatch` — янтарную строку. Спутав их, поле либо обвиняет пользователя в
 * расхождении, которого не проверяло, либо утверждает «записи нет» там, где
 * запись есть и она CNAME.
 */

const rec = (over: Partial<{ type: string; name: string; content: string }> = {}) => ({
  type: "A",
  name: "example.com",
  content: "1.2.3.4",
  ...over,
});

describe("domainOriginCheck", () => {
  it("A-запись apex ведёт на выбранный сервер — совпадение", () => {
    expect(domainOriginCheck([rec()], "example.com", "1.2.3.4")).toEqual({ kind: "match" });
  });

  it("A-запись ведёт на другой адрес — расхождение и назван чужой origin", () => {
    // Именно адреса из записей, а не «не совпало»: в строке карточки стоят оба
    // конца, и без чужого человеку нечего искать в панели Cloudflare.
    expect(domainOriginCheck([rec()], "example.com", "5.6.7.8")).toEqual({
      kind: "mismatch",
      origins: ["1.2.3.4"],
    });
  });

  it("`proxied` на сверку не влияет — в `content` у Cloudflare лежит origin", () => {
    // Оранжевое облако меняет то, что отдаёт публичный DNS, а не то, что
    // хранится в записи. Пропусти мы проксированные записи — сверка молчала бы
    // ровно на тех доменах, ради которых Cloudflare и подключают.
    const proxied = { ...rec(), proxied: true } as any;
    expect(domainOriginCheck([proxied], "example.com", "1.2.3.4")).toEqual({ kind: "match" });
    expect(domainOriginCheck([proxied], "example.com", "9.9.9.9")).toEqual({
      kind: "mismatch",
      origins: ["1.2.3.4"],
    });
  });

  it("одна из нескольких A ведёт на выбранный сервер — это совпадение, а не расхождение", () => {
    // Round-robin из двух A. Прежнее правило «берём первую» печатало бы здесь
    // «ведёт не туда», то есть отправляло чинить ВЕРНУЮ запись, которая в зоне
    // есть. Проверяем оба порядка: ответ Cloudflare их не гарантирует.
    const records = [rec({ content: "9.9.9.9" }), rec({ content: "1.2.3.4" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "match" });
    expect(domainOriginCheck([...records].reverse(), "example.com", "1.2.3.4")).toEqual({
      kind: "match",
    });
  });

  it("ни одна A не ведёт на сервер — расхождение перечисляет ВСЕ адреса apex", () => {
    // Строка карточки не вправе отрицать существование соседних записей: «ведёт
    // на 9.9.9.9» при живом `8.8.8.8` рядом — половина правды, по которой в
    // панели Cloudflare человек увидит не то, что ему обещали.
    const records = [rec({ content: "9.9.9.9" }), rec({ content: "8.8.8.8" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({
      kind: "mismatch",
      origins: ["8.8.8.8", "9.9.9.9"],
    });
  });

  it("вывод не зависит от порядка записей в ответе API", () => {
    // Порядок Cloudflare не гарантирует ничем, а мигающая между двумя видами
    // строка (или, хуже, между строкой и молчанием) — незнание, нарисованное
    // здоровьем: после второго раза её перестают читать.
    const records = [rec({ content: "9.9.9.9" }), rec({ content: "8.8.8.8" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual(
      domainOriginCheck([...records].reverse(), "example.com", "1.2.3.4"),
    );
  });

  it("одинаковые адреса на apex схлопываются в один", () => {
    // Два одинаковых A — не два адреса, и перечислять их дважды в строке значит
    // рассказывать про зону то, чего в ней нет.
    const records = [rec({ content: "9.9.9.9" }), rec({ content: " 9.9.9.9 " })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({
      kind: "mismatch",
      origins: ["9.9.9.9"],
    });
  });

  it("A-записи подпомена apex не заменяют", () => {
    // `www` и `mail` живут в той же зоне; сверять сервер домена по ним значит
    // отвечать про чужое имя.
    const records = [rec({ name: "www.example.com" }), rec({ name: "mail.example.com" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "no-a-record" });
  });

  it("имя сравнивается той же нормализацией, что у зон и у сверки сайтов", () => {
    // Регистр из письма регистратора, завершающая точка FQDN и пробелы из
    // копипасты — те же три правила, что в `normalizeZoneName`. Своя
    // нормализация здесь дала бы «расхождение» на верной записи.
    expect(domainOriginCheck([rec({ name: "Example.COM." })], "  example.com ", "1.2.3.4")).toEqual({
      kind: "match",
    });
  });

  it("тип записи в нижнем регистре всё равно A", () => {
    expect(domainOriginCheck([rec({ type: "a" })], "example.com", "1.2.3.4")).toEqual({
      kind: "match",
    });
  });

  it("apex без A-записи вовсе — «записи нет»", () => {
    const records = [rec({ type: "MX", content: "mx.example.com" }), rec({ type: "TXT", content: "v=spf1" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "no-a-record" });
  });

  it("пустая зона — тоже «записи нет»: мы её прочитали", () => {
    expect(domainOriginCheck([], "example.com", "1.2.3.4")).toEqual({ kind: "no-a-record" });
  });

  it("на apex CNAME вместо A — «не знаем», а не «записи нет»", () => {
    // Запись есть, и она отправляет домен куда-то ещё; «A-записи apex нет» было
    // бы формально верным и по смыслу враньём — сравнивать действительно не с
    // чем, но и утверждать пустоту нельзя.
    const records = [rec({ type: "CNAME", content: "target.example.net" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "unknown" });
  });

  it("на apex только AAAA — тоже «не знаем»", () => {
    // Сервер у нас с IPv4-адресом, у записи IPv6: сравнить их нечем, но домен
    // при этом куда-то ведёт.
    const records = [rec({ type: "AAAA", content: "2606:4700::1111" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "unknown" });
  });

  it("A на apex перевешивает CNAME/AAAA рядом", () => {
    const records = [rec({ type: "AAAA", content: "2606:4700::1111" }), rec({ content: "1.2.3.4" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({ kind: "match" });
  });

  it("записей не читали (`undefined`) — «не знаем», а не «записи нет»", () => {
    // Ровно то состояние, в котором живёт веб (чтение DNS — десктопное) и
    // десктоп до ответа Cloudflare. Принцип №6 CLAUDE.md: незнание — отдельное
    // состояние.
    expect(domainOriginCheck(undefined, "example.com", "1.2.3.4")).toEqual({ kind: "unknown" });
  });

  it("сервер без адреса — «не знаем»: сравнивать не с чем", () => {
    // `ip_address` в схеме обязателен, но пустой строкой быть может.
    expect(domainOriginCheck([rec()], "example.com", "")).toEqual({ kind: "unknown" });
    expect(domainOriginCheck([rec()], "example.com", "   ")).toEqual({ kind: "unknown" });
    expect(domainOriginCheck([rec()], "example.com", null)).toEqual({ kind: "unknown" });
    expect(domainOriginCheck([rec()], "example.com", undefined)).toEqual({ kind: "unknown" });
  });

  it("адрес сервера сравнивается без пробелов по краям", () => {
    expect(domainOriginCheck([rec({ content: " 1.2.3.4 " })], "example.com", "1.2.3.4 ")).toEqual({
      kind: "match",
    });
  });

  it("испорченная A рядом с целой в перечень не попадает", () => {
    // Пустой `content` — не адрес; в строке карточки он стал бы висящей запятой.
    const records = [rec({ content: "" }), rec({ content: "9.9.9.9" })];
    expect(domainOriginCheck(records, "example.com", "1.2.3.4")).toEqual({
      kind: "mismatch",
      origins: ["9.9.9.9"],
    });
  });

  it("пустое имя домена — «не знаем», а не совпадение с безымянной записью", () => {
    // Мусорная строка не должна ни с чем совпасть — то же правило, что у
    // `compareServerSites`.
    expect(domainOriginCheck([rec({ name: "" })], "  ", "1.2.3.4")).toEqual({ kind: "unknown" });
  });

  it("все A-записи с пустым `content` — «не знаем», а не расхождение с пустотой", () => {
    expect(domainOriginCheck([rec({ content: "" })], "example.com", "1.2.3.4")).toEqual({
      kind: "unknown",
    });
  });
});
