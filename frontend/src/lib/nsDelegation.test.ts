import { describe, it, expect } from "vitest";

import type { RegistryNameservers } from "../api/rdap";
import { NsDelegation, NsDelegationInput, nsDelegation, nsDelegationVariant } from "./nsDelegation";

/**
 * Правило сверки проверяется здесь, а не на карточке домена: оба сведения
 * приезжают от Tauri-команд (`cf_list_zones`, `domain_registry_nameservers`), и
 * на реальном пути каждое утверждение стоило бы мока десктопа ради сравнения
 * двух наборов строк. Ломается же тут не механика, а правило — регистр, точка на
 * конце, порядок, число серверов и лестница «не знаем».
 */

const CF_NS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

/** Ответ реестра «зарегистрирован, вот его NS» — самая частая форма. */
function registered(nameservers: string[]): RegistryNameservers {
  return { state: "registered", nameservers };
}

/**
 * Всё известно и всё сходится — от этого набора отклоняются остальные кейсы.
 *
 * Полей про аккаунт регистратора здесь НЕТ, и это не упущение теста, а предмет
 * проверки: тип входа их больше не объявляет, поэтому сам факт, что этот файл
 * компилируется (`tsc --noEmit` в прогоне), и есть доказательство, что реестру
 * незачем знать, чей это домен. Ровно из-за этого домен у ручного провайдера
 * (Dynadot, любой ярлык) впервые получает настоящий бейдж — живьём это
 * проверяется на карточке (`DomainDetailModal.cfzone.test.tsx`).
 */
function input(over: Partial<NsDelegationInput> = {}): NsDelegationInput {
  return {
    domainName: "example.com",
    zone: { name: "example.com", nameservers: CF_NS, status: "active" },
    registryNameservers: registered(CF_NS),
    ...over,
  };
}

function reason(d: NsDelegation): string {
  return d.state === "unknown" ? d.reason : `не unknown, а ${d.state}`;
}

describe("nsDelegation — делегировано", () => {
  it("совпавшие NS при активной зоне", () => {
    expect(nsDelegation(input())).toEqual({ state: "delegated", nameservers: CF_NS });
  });

  it("не считает расхождением регистр, точку на конце и порядок", () => {
    // Реестр отдаёт NS в своём порядке и своим регистром (RDAP-ответы бывают и
    // в верхнем), а завершающая точка — законный FQDN.
    const d = nsDelegation(
      input({
        registryNameservers: registered(["BOB.ns.cloudflare.com.", " ada.NS.cloudflare.com "]),
      }),
    );
    expect(d.state).toBe("delegated");
  });

  it("схлопывает дубли в ответе реестра", () => {
    // «ns1 + NS1.» — один сервер, записанный дважды. Посчитанные за два, они
    // сделали бы из верного делегирования «расходится» (разное число).
    const d = nsDelegation(
      input({
        registryNameservers: registered([
          "ada.ns.cloudflare.com",
          "ADA.ns.cloudflare.com.",
          "bob.ns.cloudflare.com",
        ]),
      }),
    );
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
  it("реестр показывает чужие NS", () => {
    const d = nsDelegation(
      input({ registryNameservers: registered(["ns1.hoster.net", "ns2.hoster.net"]) }),
    );
    expect(d).toEqual({
      state: "mismatch",
      expected: CF_NS,
      actual: ["ns1.hoster.net", "ns2.hoster.net"],
    });
  });

  it("лишний NS сверх зоны — тоже расхождение", () => {
    // Не «те же плюс запасной»: делегирование, поделённое с чужим сервером,
    // Cloudflare активным не считает.
    const d = nsDelegation(input({ registryNameservers: registered([...CF_NS, "ns1.hoster.net"]) }));
    expect(d.state).toBe("mismatch");
  });

  it("половина нужных NS — тоже расхождение, а не pending", () => {
    const d = nsDelegation(input({ registryNameservers: registered(["ada.ns.cloudflare.com"]) }));
    expect(d.state).toBe("mismatch");
  });

  it("расхождение сильнее активного статуса зоны", () => {
    // Cloudflare мог видеть делегирование раньше, а ответ реестра — свежее.
    // Утверждать «делегировано» поверх реестра нельзя.
    const d = nsDelegation(
      input({
        zone: { name: "example.com", nameservers: CF_NS, status: "active" },
        registryNameservers: registered(["ns1.hoster.net", "ns2.hoster.net"]),
      }),
    );
    expect(d.state).toBe("mismatch");
  });

  it("домен в реестре есть, а NS у него не прописаны — расхождение с пустым «как есть»", () => {
    // Самое важное утверждение новой лестницы. `registered` с пустым списком —
    // это ОТВЕТ реестра («домен зарегистрирован, делегирования нет»), а не
    // отсутствие ответа: ключа `nameservers` в RDAP-ответе просто нет, и фаза 3
    // специально отделила этот случай от «не смогли спросить». Уводить его в
    // «не знаем» значило бы прятать домен, который не работает вообще, за серым
    // бейджем — при том что чинится он ровно тем же действием, что любое другое
    // расхождение: прописать NS зоны.
    const d = nsDelegation(input({ registryNameservers: registered([]) }));
    expect(d).toEqual({ state: "mismatch", expected: CF_NS, actual: [] });
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

  it("ответа реестра ещё нет", () => {
    // Запрос летит. Действие — дождаться, и никакого другого: обвинять в этом
    // домен или реестр не за что.
    expect(reason(nsDelegation(input({ registryNameservers: undefined })))).toBe(
      "registry-nameservers-unknown",
    );
  });

  it("реестр говорит, что домена у него нет", () => {
    // Утверждение реестра, а не наша неудача, и действие у него своё: разбираться
    // с самим доменом (опечатка в имени, домен не продлён, ещё не
    // зарегистрирован) — прописывать NS такому домену некуда.
    expect(reason(nsDelegation(input({ registryNameservers: { state: "not_registered" } })))).toBe(
      "not-in-registry",
    );
  });

  it("спросить реестр не удалось — и его слова доезжают до бейджа", () => {
    // Отличать от «домена нет» обязательно: тут чинить нечего, надо повторить
    // позже. А `detail` — то самое «чего не хватило»: серое «не знаем» без
    // причины сообщает только, что мы чего-то не сделали.
    const d = nsDelegation(
      input({ registryNameservers: { state: "unavailable", reason: "no RDAP server for .xyz" } }),
    );
    expect(d).toEqual({
      state: "unknown",
      reason: "registry-unavailable",
      detail: "no RDAP server for .xyz",
    });
  });

  it("у причин, кроме отказа реестра, детали нет — и это не «пусто», а «нечего добавить»", () => {
    const d = nsDelegation(input({ zone: null }));
    expect(d).toEqual({ state: "unknown", reason: "no-zone", detail: null });
  });

  it("неизвестная зона перебивает неизвестный реестр", () => {
    // Порядок проверок — порядок починки: пока сверять не с чем, ответ реестра
    // ничего не решает, а звать пользователя разбираться с доменом значило бы
    // послать его не туда.
    expect(
      reason(nsDelegation(input({ zone: null, registryNameservers: { state: "not_registered" } }))),
    ).toBe("no-zone");
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
