import { describe, expect, it } from "vitest";

import { compareServerSites } from "./serverSites";

/** Сервер, чью карточку «открыли»: сверка всегда идёт относительно него. */
const THIS = 1;
const OTHER = 2;

const site = (domain_name: string) => ({ domain_name });
/**
 * Домен SDMP. `server_id` первым необязательным аргументом, а не id: после
 * разделения групп именно привязка решает, в какую из четырёх попадёт строка, —
 * фикстура без неё описывала бы домен, которого не бывает.
 */
const dom = (domain_name: string, server_id: number | null = THIS, id = 0) => ({
  domain_name,
  server_id,
  id,
});

describe("compareServerSites", () => {
  it("пустые списки дают четыре пустые группы", () => {
    const r = compareServerSites([], [], THIS);
    expect(r.matched).toEqual([]);
    expect(r.notBoundHere).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("сайт плюс домен, привязанный к ЭТОМУ серверу, — это matched", () => {
    const r = compareServerSites([site("example.com")], [dom("example.com", THIS, 1)], THIS);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].site.domain_name).toBe("example.com");
    expect(r.matched[0].domain.id).toBe(1);
    expect(r.notBoundHere).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("разный регистр всё равно совпадает (нормализация в нижний)", () => {
    const r = compareServerSites([site("Example.COM")], [dom("example.com")], THIS);
    expect(r.matched).toHaveLength(1);
    expect(r.notBoundHere).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("завершающая точка FQDN не мешает совпадению", () => {
    const r = compareServerSites([site("example.com.")], [dom("example.com")], THIS);
    expect(r.matched).toHaveLength(1);
    expect(r.onlyOnServer).toEqual([]);
  });

  it("пробелы по краям не мешают совпадению", () => {
    const r = compareServerSites([site("  example.com  ")], [dom("example.com")], THIS);
    expect(r.matched).toHaveLength(1);
  });

  it("сайт без домена в SDMP уходит в onlyOnServer", () => {
    const r = compareServerSites([site("ghost.com")], [], THIS);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["ghost.com"]);
    expect(r.matched).toEqual([]);
    expect(r.notBoundHere).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  /**
   * Главное разделение фазы: раньше обе эти строки лежали в `onlyOnServer`
   * вперемешку, хотя лечатся они по-разному — одну надо завести, другую только
   * перепривязать. Домен, привязанный к ДРУГОМУ серверу, — это знание, а не
   * незнание, и «завести заново» его сломало бы (дубль имени).
   */
  it("сайт, чей домен привязан к другому серверу, — notBoundHere, а не onlyOnServer", () => {
    const r = compareServerSites([site("moved.com")], [dom("moved.com", OTHER, 5)], THIS);
    expect(r.notBoundHere.map((d) => d.id)).toEqual([5]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.matched).toEqual([]);
    // И в `onlyInSdmp` он не попадает тоже: там только домены ЭТОГО сервера.
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("сайт, чей домен не привязан никуда, — тоже notBoundHere", () => {
    const r = compareServerSites([site("free.com")], [dom("free.com", null, 6)], THIS);
    expect(r.notBoundHere.map((d) => d.id)).toEqual([6]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.matched).toEqual([]);
  });

  it("домен этого сервера без сайта на нём уходит в onlyInSdmp", () => {
    const r = compareServerSites([], [dom("orphan.com", THIS, 7)], THIS);
    expect(r.onlyInSdmp.map((d) => d.domain_name)).toEqual(["orphan.com"]);
    expect(r.matched).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.notBoundHere).toEqual([]);
  });

  /**
   * Обратная сторона того, что на вход теперь идут ВСЕ домены пользователя:
   * чужие домены без сайта на этой машине — норма, а не расхождение. Попади они
   * в `onlyInSdmp`, карточка каждого сервера рапортовала бы о сотнях «пропавших
   * сайтов» — то есть диагноз стал бы шумом и перестал читаться.
   */
  it("чужие домены без сайта здесь в onlyInSdmp не попадают", () => {
    const r = compareServerSites(
      [],
      [dom("mine.com", THIS, 1), dom("theirs.com", OTHER, 2), dom("nobody.com", null, 3)],
      THIS,
    );
    expect(r.onlyInSdmp.map((d) => d.id)).toEqual([1]);
    expect(r.notBoundHere).toEqual([]);
  });

  it("смешанный случай раскладывается на четыре группы", () => {
    const r = compareServerSites(
      [site("a.com"), site("both.com"), site("server-only.com"), site("elsewhere.com")],
      [
        dom("both.com", THIS),
        dom("sdmp-only.com", THIS),
        dom("a.com", THIS),
        dom("elsewhere.com", OTHER),
        dom("not-here.com", OTHER),
      ],
      THIS,
    );
    // Порядок matched = порядок первого вхождения СРЕДИ САЙТОВ (по нему строится
    // `siteByName`): "a.com" перед "both.com", как во входном списке сайтов.
    expect(r.matched.map((m) => m.site.domain_name)).toEqual(["a.com", "both.com"]);
    expect(r.notBoundHere.map((d) => d.domain_name)).toEqual(["elsewhere.com"]);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["server-only.com"]);
    expect(r.onlyInSdmp.map((d) => d.domain_name)).toEqual(["sdmp-only.com"]);
  });

  it("дубли на сервере схлопываются по нормализованному имени", () => {
    const r = compareServerSites(
      [site("dup.com"), site("DUP.com."), site("dup.com")],
      [dom("dup.com")],
      THIS,
    );
    expect(r.matched).toHaveLength(1);
    expect(r.onlyOnServer).toEqual([]);
  });

  it("дубли в SDMP схлопываются по нормализованному имени", () => {
    const r = compareServerSites([], [dom("dup.com", THIS, 1), dom("Dup.com.", THIS, 2)], THIS);
    expect(r.onlyInSdmp).toHaveLength(1);
    // Побеждает первое вхождение.
    expect(r.onlyInSdmp[0].id).toBe(1);
  });

  it("пустое имя после нормализации не участвует в сверке", () => {
    const r = compareServerSites([site("   "), site("example.com")], [dom(".")], THIS);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["example.com"]);
    expect(r.matched).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
    expect(r.notBoundHere).toEqual([]);
  });
});
