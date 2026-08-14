import { describe, it, expect, beforeEach } from "vitest";

import { queryClient } from "./queryClient";
import { runExclusive } from "./runGate";

/**
 * Гейт «один прогон за раз» — сам по себе, без страницы.
 *
 * Проверяется здесь, потому что через UI его не проверить вовсе: обе кнопки к
 * моменту второго клика уже погашены признаком `pending`, и тест был бы зелёным
 * даже со снятым гейтом (это записано комментарием в `Domains.cfbind.test.tsx`).
 * А снятый гейт стоит дорого: `pending` читается из этой же заявки, поэтому без
 * неё кнопка не гаснет НИКОГДА — в том числе у страницы, открытой заново
 * посреди прогона. Второй прогон полной настройки по той же пачке — это вторая
 * смена делегирования у регистратора: платный вызов и второй увод трафика, а не
 * идемпотентный повтор, как у привязки.
 */

const KEY = ["run-gate-test"] as const;

/** Заявка, которую видит `pending` страницы, — тем же фильтром, что и кнопки. */
function pendingClaims(): number {
  return queryClient.getMutationCache().findAll({ mutationKey: KEY, status: "pending" }).length;
}

beforeEach(() => {
  queryClient.getMutationCache().clear();
});

describe("runExclusive", () => {
  it("два запуска в одном такте дают один прогон", async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return new Promise<void>(() => {});
    };

    // Оба вызова — до первого `await`, то есть до любого рендера: отрендеренный
    // `pending` второй запуск не остановил бы, останавливает заявка в кэше.
    void runExclusive(KEY, run);
    void runExclusive(KEY, run);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(pendingClaims()).toBe(1);
  });

  it("пока прогон идёт, заявка видна — по ней и гаснут кнопки", async () => {
    let finish: () => void = () => {};
    const started = runExclusive(KEY, () => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    expect(pendingClaims()).toBe(1);

    finish();
    await started;
    expect(pendingClaims()).toBe(0);
  });

  it("отказ прогона снимает заявку: следующий запуск проходит", async () => {
    let calls = 0;
    await runExclusive(KEY, () => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    });
    // Отказ не уезжает наружу (вызывающие зовут гейт через `void`), но и
    // кнопку он навсегда не гасит: заявка снята в любом исходе.
    expect(pendingClaims()).toBe(0);

    await runExclusive(KEY, () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(2);
  });

  it("чужой ключ гейтом не связан: прогоны разных действий идут параллельно", async () => {
    let mine = 0;
    let other = 0;
    void runExclusive(KEY, () => {
      mine += 1;
      return new Promise<void>(() => {});
    });
    void runExclusive(["run-gate-test-other"], () => {
      other += 1;
      return new Promise<void>(() => {});
    });
    await Promise.resolve();

    expect(mine).toBe(1);
    expect(other).toBe(1);
  });
});
