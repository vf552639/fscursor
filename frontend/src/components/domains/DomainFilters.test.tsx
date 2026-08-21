import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import DomainFilters from "./DomainFilters";
import { tokens } from "../../lib/designTokens";
import { hexToRgb } from "../../test/colors";

/**
 * Ряд фильтров списка доменов: доступное имя поля поиска.
 *
 * Про что тест на самом деле: у поля поиска нет и не будет видимой подписи —
 * по макету ряд состоит из четырёх голых контролов, и единственное, что о поле
 * говорит, — плейсхолдер. Плейсхолдер же исчезает при первом набранном символе,
 * то есть поле остаётся вовсе без доступного имени ровно тогда, когда в нём
 * появляется что читать: скринридер объявит «текстовое поле, alpha.com», не
 * сказав, чего это поле и почему список под ним сузился.
 *
 * `aria-label` — находка прошлого ревью, и до сих пор её не охраняло ничто:
 * снятие атрибута не роняло ни одного из полутора тысяч тестов, потому что все
 * они ищут поле по плейсхолдеру. Здесь оно ищется ИМЕНЕМ — то есть тем самым
 * каналом, который чинили.
 *
 * Компонентом, а не через страницу: имя поля — свойство ряда фильтров, и
 * тащить ради него загрузку доменов, серверов и аккаунтов значило бы поставить
 * проверку в зависимость от того, что к ней отношения не имеет.
 */

const CONTROLS = {
  search: "",
  onSearchChange: vi.fn(),
  serverId: "",
  onServerChange: vi.fn(),
  registrarId: "",
  onRegistrarChange: vi.fn(),
  cfId: "",
  onCfChange: vi.fn(),
  status: "",
  onStatusChange: vi.fn(),
};

function show(over: Partial<React.ComponentProps<typeof DomainFilters>> = {}) {
  const onSearchChange = vi.fn();
  render(
    <DomainFilters
      {...CONTROLS}
      onSearchChange={onSearchChange}
      servers={[]}
      registrars={[]}
      cfAccounts={[]}
      {...over}
    />,
  );
  return { onSearchChange };
}

afterEach(cleanup);

describe("DomainFilters — поле поиска называет себя без плейсхолдера", () => {
  it("находится по доступному имени, а не только по подсказке внутри", () => {
    show();
    expect(screen.getByLabelText("Search domains")).toBe(screen.getByPlaceholderText("Search domains…"));
  });

  it("имя остаётся, когда подсказка уже исчезла под набранным текстом", () => {
    // Ровно тот случай, ради которого атрибут и поставлен: с непустым значением
    // плейсхолдера на экране нет, и без `aria-label` поле было бы безымянным
    // именно здесь — а не в пустом состоянии, где его ещё видно.
    show({ search: "alpha.com" });
    const field = screen.getByLabelText("Search domains") as HTMLInputElement;
    expect(field.value).toBe("alpha.com");
  });

  it("и это то самое поле, которое фильтрует, а не однофамилец рядом", () => {
    // Без этого утверждение выше проходило бы и у скрытого поля-пустышки с
    // правильным именем: доступное имя ценно ровно тем, что ведёт к рабочему
    // контролу.
    const { onSearchChange } = show();
    fireEvent.change(screen.getByLabelText("Search domains"), { target: { value: "bravo" } });
    expect(onSearchChange.mock.calls).toEqual([["bravo"]]);
  });
});

describe("DomainFilters — четыре контрола одного набора", () => {
  /**
   * Про что тест: ряд выглядел разнокалиберным, и причину было не назвать.
   *
   * Общая константа существовала и раньше — но задавала лишь рамку, радиус и
   * кегль, а остальное селекты добирали умолчаниями примитива `Sel`: отбивку
   * `8px 12px` против `8px 14px` у поля, системный шрифт вместо шрифта
   * страницы, `color: #111` мимо палитры и `box-sizing` по умолчанию. Разница в
   * пару пикселей роста и в шрифте не читается как дефект — она читается как
   * «сделано небрежно», и именно поэтому её никто не чинил годами.
   *
   * Проверяются поэтому ИМЕННО те свойства, из которых складывается общая
   * высота и общий голос ряда, — а не «стиль применён».
   */
  const controls = () => [
    screen.getByLabelText("Search domains"),
    ...screen.getAllByRole("combobox"),
  ] as HTMLElement[];

  it("отбивка, шрифт, рамка и box-sizing — одни на все четыре", () => {
    show();
    const all = controls();
    expect(all.length).toBe(4);
    for (const el of all) {
      expect(el.style.paddingTop).toBe("8px");
      expect(el.style.paddingLeft).toBe("14px");
      expect(el.style.fontSize).toBe("14px");
      expect(el.style.fontFamily).toBe("inherit");
      expect(el.style.boxSizing).toBe("border-box");
      expect(el.style.borderColor).toBe(hexToRgb(tokens.border.control));
      expect(el.style.color).toBe(hexToRgb(tokens.text.body));
    }
  });

  it("`box-sizing` назван у КАЖДОГО — иначе рост считается по-разному", () => {
    // Половина ряда с `border-box`, половина без — это два разных способа
    // посчитать высоту при одинаковых числах: рамка и отбивка у одних входят в
    // заданный размер, у других прибавляются снаружи. Утверждение выше это уже
    // ловит, но повод записан здесь: без него следующий читатель примет
    // `boxSizing` за копипасту и уберёт как лишнее.
    show();
    expect(controls().every((el) => el.style.boxSizing === "border-box")).toBe(true);
  });

  it("у селектов своя стрелка, и нативная выключена", () => {
    // `appearance: none` без замены оставил бы селект вовсе без указателя на
    // то, что он раскрывается, — поэтому проверяются обе половины сразу.
    show();
    for (const sel of screen.getAllByRole("combobox")) {
      expect((sel as HTMLElement).style.appearance).toBe("none");
      expect((sel as HTMLElement).style.backgroundImage).toContain("data:image/svg+xml");
      // Правый отступ больше левого — ровно место под стрелку: подпись,
      // заезжающая под неё, читается как обрезанная.
      expect(parseInt((sel as HTMLElement).style.paddingRight, 10)).toBeGreaterThan(14);
    }
  });

  it("цвет стрелки не разъезжается с палитрой", () => {
    // Хекс прошит в разметку SVG: раскрасить `data:`-URI из CSS нечем, и
    // `currentColor` внутрь него не проникает. Значит, это ВТОРАЯ копия
    // значения — единственная в ряду, и сторожить её надо явно.
    show();
    const image = (screen.getAllByRole("combobox")[0] as HTMLElement).style.backgroundImage;
    expect(decodeURIComponent(image)).toContain(tokens.text.muted);
  });

  it("поле поиска тянется, селекты — нет", () => {
    // Единственное осознанное различие внутри ряда: длина имени домена
    // непредсказуема, а подписи «All Servers» фиксированы.
    show();
    expect(screen.getByLabelText("Search domains").style.flexGrow).toBe("1");
    for (const sel of screen.getAllByRole("combobox")) {
      expect((sel as HTMLElement).style.flexGrow).toBe("");
    }
  });
});
