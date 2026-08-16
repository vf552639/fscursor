import { describe, expect, it } from "vitest";

import { compareServerSites } from "./serverSites";

const site = (domain_name: string) => ({ domain_name });
const dom = (domain_name: string, id = 0) => ({ domain_name, id });

describe("compareServerSites", () => {
  it("пустые списки дают три пустые группы", () => {
    const r = compareServerSites([], []);
    expect(r.matched).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("точное совпадение имени попадает в matched", () => {
    const r = compareServerSites([site("example.com")], [dom("example.com", 1)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].site.domain_name).toBe("example.com");
    expect(r.matched[0].domain.id).toBe(1);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("разный регистр всё равно совпадает (нормализация в нижний)", () => {
    const r = compareServerSites([site("Example.COM")], [dom("example.com")]);
    expect(r.matched).toHaveLength(1);
    expect(r.onlyOnServer).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("завершающая точка FQDN не мешает совпадению", () => {
    const r = compareServerSites([site("example.com.")], [dom("example.com")]);
    expect(r.matched).toHaveLength(1);
    expect(r.onlyOnServer).toEqual([]);
  });

  it("пробелы по краям не мешают совпадению", () => {
    const r = compareServerSites([site("  example.com  ")], [dom("example.com")]);
    expect(r.matched).toHaveLength(1);
  });

  it("сайт без домена в SDMP уходит в onlyOnServer", () => {
    const r = compareServerSites([site("ghost.com")], []);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["ghost.com"]);
    expect(r.matched).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });

  it("домен без сайта на сервере уходит в onlyInSdmp", () => {
    const r = compareServerSites([], [dom("orphan.com", 7)]);
    expect(r.onlyInSdmp.map((d) => d.domain_name)).toEqual(["orphan.com"]);
    expect(r.matched).toEqual([]);
    expect(r.onlyOnServer).toEqual([]);
  });

  it("смешанный случай раскладывается на три группы", () => {
    const r = compareServerSites(
      [site("a.com"), site("both.com"), site("server-only.com")],
      [dom("both.com"), dom("sdmp-only.com"), dom("a.com")],
    );
    // Порядок matched = порядок первого вхождения СРЕДИ САЙТОВ (по нему строится
    // `siteByName`): "a.com" перед "both.com", как во входном списке сайтов.
    expect(r.matched.map((m) => m.site.domain_name)).toEqual(["a.com", "both.com"]);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["server-only.com"]);
    expect(r.onlyInSdmp.map((d) => d.domain_name)).toEqual(["sdmp-only.com"]);
  });

  it("дубли на сервере схлопываются по нормализованному имени", () => {
    const r = compareServerSites(
      [site("dup.com"), site("DUP.com."), site("dup.com")],
      [dom("dup.com")],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.onlyOnServer).toEqual([]);
  });

  it("дубли в SDMP схлопываются по нормализованному имени", () => {
    const r = compareServerSites([], [dom("dup.com", 1), dom("Dup.com.", 2)]);
    expect(r.onlyInSdmp).toHaveLength(1);
    // Побеждает первое вхождение.
    expect(r.onlyInSdmp[0].id).toBe(1);
  });

  it("пустое имя после нормализации не участвует в сверке", () => {
    const r = compareServerSites([site("   "), site("example.com")], [dom(".")]);
    expect(r.onlyOnServer.map((s) => s.domain_name)).toEqual(["example.com"]);
    expect(r.matched).toEqual([]);
    expect(r.onlyInSdmp).toEqual([]);
  });
});
