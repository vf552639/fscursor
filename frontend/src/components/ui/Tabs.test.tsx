import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { Tabs } from "./Tabs";

/**
 * `Tabs` — примитив вкладок, и проверяется здесь ровно то, ради чего он заведён:
 * роли, связь вкладки с панелью и клавиатура. Внешний вид (подчёркивание,
 * цвета) не проверяется намеренно — он живёт инлайновыми стилями и меняется
 * вместе с макетом, а вот контракт доступности меняться не должен.
 *
 * Три существующие копии вкладок в продукте (`pages/Activity`, `pages/Settings`,
 * `pages/ServerDetail`) — это `<div onClick>` без ролей и без tabindex: до них
 * нельзя добраться с клавиатуры вовсе, а скринридер называет их «группа». Тесты
 * ниже — граница, за которую новый примитив не должен съехать обратно.
 */

const ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "server", label: "Server" },
  { id: "logs", label: "Logs" },
];

/**
 * Обвязка с состоянием: примитив управляемый, поэтому без родителя, который
 * возвращает новое `value`, ни клик, ни стрелка ничего не переключат. Проверять
 * надо именно связку — сам по себе вызов `onChange` не доказывает, что вкладка
 * стала активной.
 */
function Harness({ onChange }: { onChange?: (id: string) => void }) {
  const [tab, setTab] = useState("overview");
  return (
    <Tabs
      items={ITEMS}
      value={tab}
      onChange={(id) => {
        onChange?.(id);
        setTab(id);
      }}
      label="Domain sections"
    >
      <div>panel of {tab}</div>
    </Tabs>
  );
}

describe("Tabs", () => {
  afterEach(cleanup);

  it("рисует tablist с вкладками, активная помечена aria-selected", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Domain sections" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Server" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("false");
  });

  it("панель связана с активной вкладкой в обе стороны и показывает содержимое", () => {
    render(<Harness />);

    const tab = screen.getByRole("tab", { name: "Overview" });
    const panel = screen.getByRole("tabpanel");

    // Связь нужна обеими сторонами: `aria-controls` ведёт от вкладки к панели,
    // `aria-labelledby` даёт панели имя вкладки. Одной стороны мало — по ней
    // скринридер не построит переход в обратном направлении.
    expect(tab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.getAttribute("id"));

    expect(panel.textContent).toContain("panel of overview");
  });

  it("идентификаторы двух tablist на одном экране не совпадают", () => {
    // Статические id сломали бы связь вкладка↔панель ровно там, где вкладок на
    // экране больше одной: `aria-controls` первой указывал бы на панель второй.
    render(
      <>
        <Harness />
        <Harness />
      </>,
    );

    const [first, second] = screen.getAllByRole("tabpanel");
    expect(first.getAttribute("id")).not.toBe(second.getAttribute("id"));
  });

  it("клик по вкладке переключает выбор и содержимое панели", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    expect(onChange).toHaveBeenCalledWith("logs");
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel").textContent).toContain("panel of logs");
  });

  it("в таб-порядок попадает только активная вкладка", () => {
    // Иначе клавиша Tab прогоняет по всем пяти вкладкам подряд, прежде чем
    // добраться до содержимого панели, — а по строке вкладок ходят стрелками.
    render(<Harness />);

    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Server" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("tabindex")).toBe("-1");

    fireEvent.click(screen.getByRole("tab", { name: "Server" }));

    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tab", { name: "Server" }).getAttribute("tabindex")).toBe("0");
  });

  it("стрелка вправо переключает на следующую вкладку и уводит на неё фокус", () => {
    render(<Harness />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });

    const server = screen.getByRole("tab", { name: "Server" });
    expect(server.getAttribute("aria-selected")).toBe("true");
    // Фокус обязан ехать следом: иначе следующая стрелка приходит в кнопку,
    // которая уже не выбрана, и ходьба по строке разваливается.
    expect(document.activeElement).toBe(server);
    expect(screen.getByRole("tabpanel").textContent).toContain("panel of server");
  });

  it("стрелка влево переключает на предыдущую вкладку", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    const logs = screen.getByRole("tab", { name: "Logs" });
    logs.focus();
    fireEvent.keyDown(logs, { key: "ArrowLeft" });

    const server = screen.getByRole("tab", { name: "Server" });
    expect(server.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(server);
  });

  it("стрелки заворачиваются по кругу на краях строки", () => {
    render(<Harness />);

    // Влево с первой — на последнюю.
    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");

    // И вправо с последней — обратно на первую.
    const logs = screen.getByRole("tab", { name: "Logs" });
    logs.focus();
    fireEvent.keyDown(logs, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("чужие клавиши строку вкладок не трогают", () => {
    // Строка горизонтальная, и вертикальные стрелки принадлежат прокрутке
    // модалки: перехвати мы их здесь — прокрутка встала бы, а вкладка уехала.
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowDown" });

    expect(onChange).not.toHaveBeenCalled();
    expect(overview.getAttribute("aria-selected")).toBe("true");
  });
});
