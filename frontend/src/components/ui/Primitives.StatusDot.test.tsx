import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { hexToRgb } from "../../test/colors";
import { StatusDot } from "./Primitives";

/**
 * Карта цветов `StatusDot` — и то, во что она красит незнакомое.
 *
 * Заведён взамен потерянного покрытия: фактические цвета точки утверждались во
 * всём репозитории ровно в одном месте — `pages/Domains.serverstatus.test.tsx`,
 * — а третья фаза редизайна вкладки Domains этот файл удалила вместе с самой
 * точкой в строке домена. Компонент никуда не делся: он рисуется на `Servers`,
 * `Dashboard` и `ServerDetail`, то есть на всех трёх экранах, где про здоровье
 * сервера и спрашивают.
 *
 * Лестницу `serverUiStatus`/`isCheckStale` здесь НЕ проверяют — она покрыта
 * своими тестами (`lib/serverStatus.test.ts` и три экранных). Здесь ровно то,
 * чего нет больше нигде: во что превращается её результат на экране.
 *
 * Главное утверждение — последнее. Всё незнакомое обязано быть СЕРЫМ: ключей у
 * карты два, а строк в неё приходить может сколько угодно (их было восемь), и
 * стоит запасному цвету однажды стать зелёным — как непроверенная и упавшая
 * машина снова получит бейдж здоровья. Это принцип №6 `CLAUDE.md` в одну
 * строчку кода, и охраняется он только здесь.
 */

/**
 * Цвета сверяются по-разному, и это не небрежность: jsdom нормализует `background`
 * в `rgb(r, g, b)` (для чего и заведён `hexToRgb`), а `box-shadow` оставляет
 * ровно тем текстом, что ему дали, — то есть хексом.
 */
const dotOf = (status: string): HTMLElement => {
  const { container } = render(<StatusDot status={status} />);
  return container.firstElementChild as HTMLElement;
};

afterEach(cleanup);

describe("StatusDot — карта цветов", () => {
  it("подтверждённо живой — зелёный, и с ореолом", () => {
    const dot = dotOf("active");
    expect(dot.style.background).toBe(hexToRgb("#16a34a"));
    // Ореол усиливает утверждение, поэтому достаётся только проверенному.
    expect(dot.style.boxShadow).toContain("#bbf7d0");
  });

  it("подтверждённо упавший — красный, и тоже с ореолом", () => {
    const dot = dotOf("error");
    expect(dot.style.background).toBe(hexToRgb("#dc2626"));
    expect(dot.style.boxShadow).toContain("#fecaca");
  });

  it.each(["unchecked", "healthy", "pending", ""])(
    "«%s» — серый и БЕЗ ореола: это «не знаю», а не здоровье",
    (status) => {
      const dot = dotOf(status);
      expect(dot.style.background).toBe(hexToRgb("#9ca3af"));
      // Ореола нет намеренно: усиливать нечего — утверждения не было.
      expect(dot.style.boxShadow).toBe("none");
      // И отдельно, в лоб: серый — не зелёный. Именно этой подменой зелёная
      // точка и стояла у подтверждённо упавшей машины, пока в карте жили ключи,
      // которых никто не производил.
      expect(dot.style.background).not.toBe(hexToRgb("#16a34a"));
    },
  );
});
