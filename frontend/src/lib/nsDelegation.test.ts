import { describe, it, expect } from "vitest";

import { NsDelegation, nsDelegation, nsDelegationVariant } from "./nsDelegation";

/**
 * Правило сверки проверяется здесь, а не на карточке домена: оба списка NS
 * приезжают от Tauri-команд (`cf_list_zones`, `registrar_get_nameservers`), и на
 * реальном пути каждое утверждение стоило бы мока десктопа ради сравнения двух
 * наборов строк. Ломается же тут не механика, а правило — регистр, точка на
 * конце, порядок, число серверов и лестница «не знаем».
 */

const CF_NS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

/** Всё известно и всё сходится — от этого набора отклоняются остальные кейсы. */
function input(over: Record<string, unknown> = {}) {
  return {
    domainName: "example.com",
    zone: { name: "example.com", nameservers: CF_NS, status: "active" },
    registrarAccountId: 9,
    registrarProvider: "namecheap",
    registrarNameservers: CF_NS,
    ...over,
  } as Parameters<typeof nsDelegation>[0];
}

function reason(d: NsDelegation): string {
  return d.state === "unknown" ? d.reason : `не unknown, а ${d.state}`;
}

describe("nsDelegation — делегировано", () => {
  it("совпавшие NS при активной зоне", () => {
    expect(nsDelegation(input())).toEqual({ state: "delegated", nameservers: CF_NS });
  });

  it("не считает расхождением регистр, точку на конце и порядок", () => {
    // Регистратор отдаёт NS как хочет: Namecheap — в том порядке, в каком их
    // записали, Hostiq — в своём; завершающая точка это законный FQDN.
    const d = nsDelegation(
      input({ registrarNameservers: ["BOB.ns.cloudflare.com.", " ada.NS.cloudflare.com "] }),
    );
    expect(d.state).toBe("delegated");
  });

  it("схлопывает дубли у регистратора", () => {
    // «ns1 + NS1.» — один сервер, записанный дважды. Посчитанные за два, они
    // сделали бы из верного делегирования «расходится» (разное число).
    const d = nsDelegation({
      ...input(),
      registrarNameservers: ["ada.ns.cloudflare.com", "ADA.ns.cloudflare.com.", "bob.ns.cloudflare.com"],
    });
    expect(d.state).toBe("delegated");
  });
});

describe("nsDelegation — pending", () => {
  it("NS уже те, а Cloudflare ещё не подтвердил", () => {
    const d = nsDelegation(input({ zone: { name: "example.com", nameservers: CF_NS, status: "pending" } }));
    expect(d).toEqual({ state: "pending", nameservers: CF_NS, zoneStatus: "pending" });
  });

  it("незнакомый статус зоны не даёт зелёного", () => {
    // `moved`, `deactivated`, отсутствующий статус — всё это «не подтверждено».
    // Зелёный бейдж здесь обещал бы работающий домен.
    expect(nsDelegation(input({ zone: { name: "example.com", nameservers: CF_NS, status: "moved" } })).state).toBe("pending");
    expect(nsDelegation(input({ zone: { name: "example.com", nameservers: CF_NS, status: null } })).state).toBe("pending");
  });
});

describe("nsDelegation — расходится", () => {
  it("регистратор указывает на чужие NS", () => {
    const d = nsDelegation(input({ registrarNameservers: ["ns1.hoster.net", "ns2.hoster.net"] }));
    expect(d).toEqual({
      state: "mismatch",
      expected: CF_NS,
      actual: ["ns1.hoster.net", "ns2.hoster.net"],
    });
  });

  it("лишний NS сверх зоны — тоже расхождение", () => {
    // Не «те же плюс запасной»: делегирование, поделённое с чужим сервером,
    // Cloudflare активным не считает.
    const d = nsDelegation({ ...input(), registrarNameservers: [...CF_NS, "ns1.hoster.net"] });
    expect(d.state).toBe("mismatch");
  });

  it("половина нужных NS — тоже расхождение, а не pending", () => {
    const d = nsDelegation({ ...input(), registrarNameservers: ["ada.ns.cloudflare.com"] });
    expect(d.state).toBe("mismatch");
  });

  it("расхождение сильнее активного статуса зоны", () => {
    // Cloudflare мог видеть делегирование раньше, а список регистратора —
    // свежее. Утверждать «делегировано» поверх ответа регистратора нельзя.
    const d = nsDelegation({
      ...input(),
      zone: { name: "example.com", nameservers: CF_NS, status: "active" },
      registrarNameservers: ["ns1.hoster.net", "ns2.hoster.net"],
    });
    expect(d.state).toBe("mismatch");
  });
});

describe("nsDelegation — незнание отдельным состоянием", () => {
  it("домен без живой зоны Cloudflare", () => {
    expect(reason(nsDelegation(input({ zone: null })))).toBe("no-zone");
  });

  it("зоны аккаунта ещё не прочитаны", () => {
    expect(reason(nsDelegation(input({ zone: undefined })))).toBe("zone-nameservers-unknown");
  });

  it("зона без единого nameserver — не «нет делегирования», а «не знаем»", () => {
    expect(reason(nsDelegation(input({ zone: { name: "example.com", nameservers: [], status: "active" } })))).toBe(
      "zone-nameservers-unknown",
    );
  });

  it("аккаунт регистратора не назначен", () => {
    expect(reason(nsDelegation(input({ registrarAccountId: null })))).toBe("no-registrar");
  });

  it("провайдер без NS-API", () => {
    // Спросить регистратора нечем: `make_service` в десктопе такого не знает.
    expect(reason(nsDelegation(input({ registrarProvider: "godaddy" })))).toBe("registrar-no-api");
  });

  it("непрочитанный список аккаунтов не выдаётся за «провайдер без API»", () => {
    // Разные фразы и разные действия: одну чинит ожидание, другую — смена
    // регистратора руками в его панели.
    expect(reason(nsDelegation(input({ registrarProvider: undefined })))).toBe(
      "registrar-nameservers-unknown",
    );
  });

  it("привязка указывает на зону с другим именем", () => {
    // Самая коварная из причин: nameservers Cloudflare выдаёт ОДНИ И ТЕ ЖЕ на
    // весь аккаунт, поэтому чужая зона сходится по ним с настоящими NS домена,
    // а её статус вполне может быть `active`. Без сверки имени карточка
    // показала бы зелёное «делегировано, Cloudflare подтвердил» про домен,
    // зоны которого в Cloudflare нет вовсе.
    const d = nsDelegation(input({ zone: { name: "other.com", nameservers: CF_NS, status: "active" } }));
    expect(d.state).not.toBe("delegated");
    expect(reason(d)).toBe("zone-name-mismatch");
  });

  it("имя зоны сверяется тем же правилом, что и матч зон", () => {
    // Регистр и завершающая точка — не «другое имя».
    const d = nsDelegation(input({ zone: { name: "Example.COM.", nameservers: CF_NS, status: "active" } }));
    expect(d.state).toBe("delegated");
  });

  it("NS у регистратора не прочитаны", () => {
    expect(reason(nsDelegation(input({ registrarNameservers: undefined })))).toBe(
      "registrar-nameservers-unknown",
    );
  });

  it("регистратор не назвал ни одного NS", () => {
    expect(reason(nsDelegation(input({ registrarNameservers: [] })))).toBe(
      "registrar-nameservers-unknown",
    );
  });

  it("неизвестная зона перебивает неизвестного регистратора", () => {
    // Порядок проверок — порядок починки: пока сверять не с чем, ответ
    // регистратора ничего не решает, и звать пользователя в настройки
    // регистратора значило бы послать его не туда.
    expect(reason(nsDelegation({ ...input(), zone: null, registrarAccountId: null }))).toBe("no-zone");
  });
});

describe("nsDelegationVariant", () => {
  it("зелёный — только подтверждённое делегирование", () => {
    expect(nsDelegationVariant("delegated")).toBe("green");
    expect(nsDelegationVariant("pending")).toBe("yellow");
    expect(nsDelegationVariant("mismatch")).toBe("red");
    // Незнание — серое. Правило то же, что у серверов: пустой или зелёный
    // бейдж читался бы как «всё в порядке», то есть ровно наоборот.
    expect(nsDelegationVariant("unknown")).toBe("gray");
  });
});
