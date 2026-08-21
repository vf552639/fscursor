import { describe, it, expect } from "vitest";

import {
  DOMAIN_STATUSES,
  domainStatusHint,
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

  it("подпись — человеческая, а не внутреннее имя бэкенда", () => {
    // `NS_OK`, `SITE_CREATED`, `SSL_PENDING` — имена из чужого кода, и объяснить
    // себя ими колонка не могла. Проверяются все восемь дословно: подпись,
    // сверенная с самой лестницей, зеленела бы при любом её содержимом.
    expect(DOMAIN_STATUSES.map((s) => domainStatusLabel(s.status))).toEqual([
      "Not set up",
      "Waiting NS",
      "NS set",
      "Deploying",
      "Site created",
      "Issuing SSL",
      "Deployed",
      "Failed",
    ]);
  });

  it("`active` подписан «Deployed», а не «Active» — и это главная правка", () => {
    // Колонка называет ступень настройки ВНУТРИ SDMP, а не здоровье сайта:
    // `active` стоит только у доменов, прошедших provision из приложения, а
    // заведённые вручную остаются `new` навсегда. Слово «Active» обещало
    // обратное — что домен работает, — и человек читал «New» у живого сайта
    // как поломку.
    expect(domainStatusLabel("active")).toBe("Deployed");
    expect(domainStatusLabel("new")).toBe("Not set up");
  });

  it("незнакомый и пустой статус — «Unknown», а не сырое имя и не пустое место", () => {
    // Бэкенд волен добавить ступень в любой день; печатать её сырое имя значило
    // бы показать пользователю строку из чужого кода. Пустой бейдж читался бы
    // как «статуса нет», а не как «статус нам неизвестен».
    expect(domainStatusLabel("teleported")).toBe("Unknown");
    expect(domainStatusLabel("")).toBe("Unknown");
  });
});

describe("domainStatusHint", () => {
  it("подсказка есть у КАЖДОГО статуса лестницы и нигде не пуста", () => {
    // Пустая подсказка — это `title=""`: наведение молчит, а колонка так и
    // остаётся необъяснённой. Форму сторожит `satisfies`, непустоту — этот тест.
    for (const { status } of DOMAIN_STATUSES) {
      expect(domainStatusHint(status).length).toBeGreaterThan(0);
    }
  });

  it("«Deployed» прямо оговаривает, что о работе сайта не говорит ничего", () => {
    // Ровно то недоразумение, из-за которого фаза и делалась: зелёный бейдж
    // читается как «сайт жив», а означает «мы его отсюда развернули».
    expect(domainStatusHint("active")).toMatch(/site is up/);
  });

  it("незнакомый статус объясняет себя незнанием, а не выдуманной ступенью", () => {
    expect(domainStatusHint("teleported")).toMatch(/teleported/);
    expect(domainStatusHint("teleported")).toMatch(/not one this app knows/);
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
