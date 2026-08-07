import { describe, it, expect } from "vitest";

import { STALE_TEXT, DIM_TEXT } from "./Primitives";
import { relativeLuminance } from "../../test/colors";

/**
 * `#a8a29e` уже один раз совпал по светлоте с `DIM_TEXT` (контраст между ними
 * ~1.01:1) — протухшее и «данных нет» стали неотличимы, и это прошло мимо всех
 * проверок, потому что ни один тест не смотрел на константы напрямую, только
 * на разметку страниц. Этот тест ловит именно такой регресс там, где его
 * вносят — при выборе цвета, а не в тесте, которому «прочерки» не касаются.
 *
 * Проверяется отношение, а не число: следующая осмысленная правка цвета не
 * должна ломать тест только потому, что контраст сдвинулся с одного
 * конкретного значения на другое.
 */
describe("STALE_TEXT отличим от DIM_TEXT", () => {
  it("это не один и тот же цвет", () => {
    expect(STALE_TEXT).not.toBe(DIM_TEXT);
  });

  it("STALE_TEXT темнее DIM_TEXT", () => {
    expect(relativeLuminance(STALE_TEXT)).toBeLessThan(relativeLuminance(DIM_TEXT));
  });
});
