import { describe, it, expect } from "vitest";

import { chipCount, countDomains, CountableDomain } from "./domainCounts";

/**
 * Срезы вкладки Domains.
 *
 * Про что тест на самом деле: два правила подсчёта, ради которых модуль и
 * вынесен из компонента. Первое — «в работе» считается ОСТАТКОМ, поэтому
 * статус, о котором фронт не знает вовсе, обязан попасть в него, а не пропасть
 * из суммы. Второе — провал SSL опознаётся по `ssl_status`, а не по тексту
 * ошибки провижининга: до этого счётчик требовал `status === "failed"` И слова
 * «ssl» в тексте, то есть не мог стать ненулевым ни при одном прогоне.
 *
 * Раньше оба проверялись только рендером всей страницы — с QueryClient, четырьмя
 * замоканными эндпоинтами и кликом по кнопке «NS details».
 */

const d = (over: Partial<CountableDomain> = {}): CountableDomain => ({
  status: "active",
  ns_status: "ok",
  ssl_status: "active",
  ...over,
});

describe("countDomains", () => {
  it("складывает в «в работе» всё, что не new/active/failed, — включая незнакомый статус", () => {
    const counts = countDomains([
      d({ status: "new" }),
      d({ status: "new" }),
      d({ status: "active" }),
      d({ status: "failed" }),
      d({ status: "ns_ok" }),
      d({ status: "site_created" }),
      // Статуса, которого фронт не знает, бэкенд однажды пришлёт — ровно так и
      // появился `ns_ok`. Перечисление промежуточных статусов потеряло бы его
      // молча, и сумма чипов перестала бы сходиться с «All».
      d({ status: "статуса-такого-нет" }),
    ]);

    expect(counts.byStatus).toEqual({ new: 2, active: 1, failed: 1 });
    expect(counts.inProgress).toBe(3);
    // Главное утверждение: срезы сходятся с общим числом при ЛЮБОМ содержимом.
    expect(counts.byStatus.new + counts.byStatus.active + counts.byStatus.failed + counts.inProgress).toBe(counts.total);
  });

  it("на пустом списке даёт нули, а не отрицательный остаток", () => {
    const counts = countDomains([]);
    expect(counts.total).toBe(0);
    expect(counts.inProgress).toBe(0);
    expect(counts.ns).toEqual({ ok: 0, pending: 0, error: 0 });
  });

  it("считает провал SSL по ssl_status, а не по тексту ошибки провижининга", () => {
    // Набор подобран так, что прежний предикат («status failed» И слово «ssl» в
    // тексте) и нынешний дают РАЗНЫЕ числа: с одним доменом на каждую сторону
    // утверждение было бы верно при обеих реализациях и не проверяло бы ничего.
    const counts = countDomains([
      // Считаются эти двое: провижининг дошёл до конца, сертификата нет.
      d({ status: "site_created", ssl_status: "error" }),
      d({ status: "active", ssl_status: "error" }),
      // Прежний предикат посчитал бы этого — а сертификат у него как раз есть.
      d({ status: "failed", ssl_status: "active" }),
      d({ status: "active", ssl_status: null }),
    ]);

    expect(counts.failedAtSsl).toBe(2);
  });

  it("делегирование считается отдельно от жизненного цикла", () => {
    // Два независимых сигнала: домен может быть `active` с протухшими NS и
    // `new` с уже проставленными. Сваливать их в один счётчик нельзя.
    const counts = countDomains([
      d({ status: "active", ns_status: "error" }),
      d({ status: "new", ns_status: "ok" }),
      d({ status: "new", ns_status: "pending" }),
      d({ ns_status: "чего-то новенькое" }),
    ]);

    expect(counts.ns).toEqual({ ok: 1, pending: 1, error: 1 });
    // Незнакомое значение не досчитывается никуда — но и общее число не
    // подделывает: сумма NS-среза с `total` сходиться не обязана, и это разные
    // вопросы («доехало ли делегирование» против «доехал ли сайт»).
    expect(counts.total).toBe(4);
  });
});

describe("chipCount", () => {
  it("число на чипе выводится из значения его фильтра, а не сопоставляется руками", () => {
    const counts = countDomains([d({ status: "new" }), d({ status: "failed" }), d({ status: "ns_ok" })]);

    expect(chipCount(counts, "")).toBe(3);
    expect(chipCount(counts, "new")).toBe(1);
    expect(chipCount(counts, "failed")).toBe(1);
    expect(chipCount(counts, "active")).toBe(0);
  });
});
