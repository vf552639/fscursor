import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import DomainFilters from "./DomainFilters";

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
