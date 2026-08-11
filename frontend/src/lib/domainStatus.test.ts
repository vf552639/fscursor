import { describe, it, expect } from "vitest";

import {
  DOMAIN_STATUSES,
  SSL_STATUSES,
  domainStatusLabel,
  domainStatusRank,
  domainStatusVariant,
  sslStatusRank,
} from "./domainStatus";

/**
 * Лестница статусов домена — единственный источник для трёх мест сразу (пункты
 * фильтра, бейдж строки, порядок сортировки). До неё список жил на фронте в
 * двух копиях, и обе разошлись с бэкендом одинаково: в них не было `ns_ok`.
 *
 * Поэтому проверяется здесь не «функция вернула число», а ровно то, чем этот
 * рассинхрон был опасен: полнота списка, серый фолбэк для незнакомого статуса
 * и то, что незнакомое НЕ всплывает наверх при перевороте сортировки.
 */

describe("DOMAIN_STATUSES", () => {
  it("совпадает с `DomainStatus` бэкенда — целиком и в том же порядке", () => {
    // Список записан руками, а не выведен из самой константы: сверка константы
    // с собой зеленела бы при любом её содержимом, включая то, в котором снова
    // не окажется `ns_ok`. Источник — `backend/app/core/constants.py`.
    expect(DOMAIN_STATUSES.map((s) => s.status)).toEqual([
      "new",
      "ns_pending",
      "ns_ok",
      "provisioning",
      "site_created",
      "ssl_pending",
      "active",
      "failed",
    ]);
    expect(SSL_STATUSES).toEqual(["none", "pending", "active", "error"]);
  });

  it("зелёный занят одним `active`, красный — одним `failed`", () => {
    // Зелёный на этой лестнице значит «дошли до конца». Второй зелёный бейдж
    // посреди пути заставлял бы различать два зелёных вместо того, чтобы
    // искать глазами один — поэтому `ns_ok` синий.
    const green = DOMAIN_STATUSES.filter((s) => s.variant === "green").map((s) => s.status);
    const red = DOMAIN_STATUSES.filter((s) => s.variant === "red").map((s) => s.status);
    expect(green).toEqual(["active"]);
    expect(red).toEqual(["failed"]);
    expect(domainStatusVariant("ns_ok")).toBe("blue");
  });
});

describe("domainStatusVariant / domainStatusLabel", () => {
  it("незнакомый статус — серый, а не зелёный", () => {
    // Гадать в сторону здоровья нельзя: серый и значит «мы такого не знаем».
    expect(domainStatusVariant("teleported")).toBe("gray");
    expect(domainStatusVariant("")).toBe("gray");
  });

  it("подпись — сам статус заглавными, пустое значение — «UNKNOWN»", () => {
    expect(domainStatusLabel("ns_ok")).toBe("NS_OK");
    // Пустой бейдж читался бы как «статуса нет», а не как «статус пуст».
    expect(domainStatusLabel("")).toBe("UNKNOWN");
  });
});

describe("domainStatusRank / sslStatusRank", () => {
  it("порядок — жизненный цикл, а не алфавит", () => {
    expect(domainStatusRank("new")).toBeLessThan(domainStatusRank("active") as number);
    expect(domainStatusRank("active")).toBeLessThan(domainStatusRank("failed") as number);
    expect(sslStatusRank("pending")).toBeLessThan(sslStatusRank("error") as number);
  });

  it("незнакомый статус — `null`, то есть «в конец при любом направлении»", () => {
    // Числом «за концом лестницы» он переворачивался бы вместе с направлением,
    // и второй клик по Status — тот, что должен поднять `failed`, — поднимал бы
    // наверх статус, который бэкенд только что добавил, а фронт ещё не знает.
    expect(domainStatusRank("teleported")).toBeNull();
    expect(sslStatusRank("revoked")).toBeNull();
  });

  it("сертификата нет — это `none`, а не незнание", () => {
    // Домен без сертификата — обычное состояние, и в списке оно так и
    // подписано («— No SSL»). Уводить такие строки в конец было бы враньём:
    // про них как раз всё известно.
    expect(sslStatusRank(null)).toBe(sslStatusRank("none"));
    expect(sslStatusRank(undefined)).toBe(sslStatusRank("none"));
    expect(sslStatusRank("")).toBe(sslStatusRank("none"));
  });
});
