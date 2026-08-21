import { describe, it, expect } from "vitest";

import {
  DOMAIN_STATUSES,
  domainStatusLabel,
  domainStatusRank,
  domainStatusVariant,
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

/*
 * Лестницы статуса СЕРТИФИКАТА здесь больше нет.
 *
 * `SSL_STATUSES`/`sslStatusRank` упорядочивали `ssl_status` — нашу запись
 * момента provision, — и колонка SSL сортировалась по ней, пока рисовала совсем
 * другое. Фаза 1 плана `2026-08-21-domains-shest-pravok.md` перевела и показ, и
 * порядок на состояние с сервера (`sslState` + `sslStateRank` в
 * `lib/domainFacts`), а осиротевшую лестницу удалила вместе с этими тестами:
 * оставленная «на всякий случай», она была бы вторым порядком тех же значений,
 * которого никто не рисует.
 */

describe("domainStatusRank", () => {
  it("порядок — жизненный цикл, а не алфавит", () => {
    expect(domainStatusRank("new")).toBeLessThan(domainStatusRank("active") as number);
    expect(domainStatusRank("active")).toBeLessThan(domainStatusRank("failed") as number);
  });

  it("незнакомый статус — `null`, то есть «в конец при любом направлении»", () => {
    // Числом «за концом лестницы» он переворачивался бы вместе с направлением,
    // и второй клик по Status — тот, что должен поднять `failed`, — поднимал бы
    // наверх статус, который бэкенд только что добавил, а фронт ещё не знает.
    expect(domainStatusRank("teleported")).toBeNull();
  });
});
