import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import { RegistrarAccount } from "../../api/registrars";
import { Server } from "../../api/servers";
import DomainTable from "./DomainTable";
import { DomainUI } from "./types";

/**
 * Раскладка таблицы доменов: набор колонок, подвал, пустой результат фильтра и
 * цена клика по строке.
 *
 * Про что тест на самом деле: три из четырёх проверяемых здесь вещей ломаются
 * МОЛЧА — без исключения, без красного экрана и без единого падения соседних
 * тестов.
 *   1) `colSpan` пустого результата. Он уже разъезжался (стоял `10` при девяти
 *      колонках): ячейка просто растягивается за пределы таблицы, и увидеть это
 *      можно, только отфильтровав список в ноль и посмотрев глазами.
 *   2) `stopPropagation` у чекбокса и у «✕». Строка целиком открывает карточку;
 *      забыв гасить событие, снятие галочки открывало бы карточку заодно, а
 *      удаление вставало бы диалогом поверх только что открытой карточки — то
 *      есть дефект виден только руками и только у того, кто до него дошёл.
 *   3) Второе число в подвале. `Showing X of Y`, где Y посчитан по тому же
 *      срезу, что и X, всегда показывает «X of X» и выглядит совершенно
 *      здорово — врёт он ровно тогда, когда нужен: когда фильтр что-то спрятал.
 *
 * Компонентом, а не через страницу: набор строк, `total` и колбэки нужны здесь
 * подставными, иначе «клик по строке открыл карточку» проверялся бы по факту
 * появления модалки, то есть заодно и всей её загрузкой.
 */

const now = Date.parse("2026-08-20T00:00:00Z");

const domain = (id: number, name: string, extra: Partial<DomainUI> = {}): DomainUI => ({
  id,
  domain: name,
  server_id: null,
  registrar_id: null,
  cf_id: null,
  ns_status: "pending",
  status: "new",
  created: "2026-01-01T00:00:00Z",
  ...extra,
});

const SERVER = { id: 3, name: "web-01", ip_address: "10.0.0.1" } as unknown as Server;
const REGISTRAR = { id: 4, provider: "hostiq", name: "main" } as unknown as RegistrarAccount;

const ROWS = [
  domain(1, "alpha.com", { server_id: 3, registrar_id: 4 }),
  domain(2, "bravo.com"),
];

function renderTable(over: Partial<React.ComponentProps<typeof DomainTable>> = {}) {
  const spies = {
    onOpenDetail: vi.fn(),
    onDelete: vi.fn(),
    onToggleRow: vi.fn(),
    onToggleAll: vi.fn(),
    onSort: vi.fn(),
  };
  render(
    <DomainTable
      rows={ROWS}
      total={7}
      servers={[SERVER]}
      registrars={[REGISTRAR]}
      cfAccounts={[]}
      zoneHints={new Map()}
      now={now}
      sort={{ key: "domain", dir: "asc" }}
      selectedIds={new Set()}
      focusDomainId={null}
      {...spies}
      {...over}
    />,
  );
  return spies;
}

/** Строки доменов — без шапки и без подвала (подвал не строка таблицы, и это проверяется ниже). */
function bodyRows(): HTMLElement[] {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0);
}

const rowOf = (name: string) => {
  const row = bodyRows().find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`строки «${name}» в таблице нет`);
  return row;
};

afterEach(cleanup);

describe("DomainTable — набор колонок", () => {
  it("колонок восемь, и Server с Registrar среди них больше нет", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim() ?? "");
    // Первая — чекбокс «выделить всё», последняя — действия; обе без подписи.
    // Стрелка — часть подписи и здесь несущая: «↕» стоит и на неактивных
    // сортируемых колонках (иначе кликабельность узнаётся только случайным
    // попаданием курсора), а у активной она сменилась направлением. Колонка
    // Cloudflare без стрелки — по ней порядка нет.
    expect(headers).toEqual(["", "Domain↑", "Cloudflare", "Status↕", "SSL↕", "Expires↕", "Added↕", ""]);
  });

  it("сервер и регистратор переехали метками под имя домена, а не исчезли", () => {
    renderTable();
    const row = rowOf("alpha.com");
    // Метка показывает ТОЛЬКО значение, поэтому подпись обязана быть достижима
    // курсором — иначе «hostiq» в строке ничем себя не объясняет.
    expect(within(row).getByTitle("Server this domain is hosted on").textContent).toBe("web-01");
    expect(
      within(row).getByTitle("Domain provider (registrar) this domain was purchased from").textContent,
    ).toBe("hostiq");
    // Домену без связей метки не нужны — пустая плашка означала бы «сервер
    // есть, но безымянный».
    expect(within(rowOf("bravo.com")).queryByTitle("Server this domain is hosted on")).toBeNull();
  });
});

describe("DomainTable — подвал", () => {
  it("считает показанное и общее РАЗНЫМИ числами", () => {
    renderTable();
    // Двенадцать из двухсот — это и есть тот случай, ради которого подвал
    // заведён: остальные не пропали, а спрятаны фильтром.
    expect(screen.getByText("Showing 2 of 7 domains")).toBeTruthy();
  });

  it("пустой срез не молчит о том, что домены есть", () => {
    renderTable({ rows: [] });
    expect(screen.getByText("Showing 0 of 7 domains")).toBeTruthy();
  });

  it("подвал не притворяется строкой таблицы", () => {
    renderTable();
    // `<tfoot>` попал бы в `getAllByRole("row")` вместе с доменами, и тесты,
    // читающие строки по порядку, сдвинулись бы на одну — продолжая проходить.
    expect(bodyRows().length).toBe(2);
  });
});

describe("DomainTable — пустой результат фильтра", () => {
  it("объясняет пустоту внутри таблицы, не подменяя её", () => {
    renderTable({ rows: [] });
    expect(screen.getByText("No domains match the current filter")).toBeTruthy();
    // Шапка с выбранной колонкой обязана остаться: она и есть ответ «по чему я
    // отфильтровал» и единственный способ отсортировать обратно.
    expect(screen.getByRole("button", { name: "Sort by Domain" })).toBeTruthy();
  });

  it("ячейка растянута ровно на все колонки — ни больше, ни меньше", () => {
    renderTable({ rows: [] });
    const cell = screen.getByText("No domains match the current filter").closest("td") as HTMLElement;
    // Число берётся из шапки, а не пишется в тесте: иначе оба места врали бы
    // согласованно (ровно так `colSpan={10}` и дожил до девяти колонок).
    expect(cell.getAttribute("colSpan")).toBe(String(screen.getAllByRole("columnheader").length));
  });
});

describe("DomainRow — цена клика", () => {
  it("клик по строке открывает карточку", () => {
    const spies = renderTable();
    fireEvent.click(rowOf("alpha.com"));
    expect(spies.onOpenDetail.mock.calls).toEqual([[1]]);
  });

  it("имя домена остаётся кнопкой — иначе строка недостижима с клавиатуры", () => {
    const spies = renderTable();
    // `<tr onClick>` не фокусируется и Tab по нему не идёт; кнопка внутри
    // решает обе задачи разом.
    const name = within(rowOf("bravo.com")).getByRole("button", { name: "bravo.com" });
    fireEvent.click(name);
    expect(spies.onOpenDetail.mock.calls).toEqual([[2]]);
  });

  it("клик по чекбоксу выделяет строку и НЕ открывает карточку", () => {
    const spies = renderTable();
    fireEvent.click(within(rowOf("alpha.com")).getByRole("checkbox"));
    expect(spies.onToggleRow.mock.calls).toEqual([[1]]);
    expect(spies.onOpenDetail).not.toHaveBeenCalled();
  });

  it("клик по «✕» удаляет и НЕ открывает карточку", () => {
    const spies = renderTable();
    fireEvent.click(within(rowOf("alpha.com")).getByRole("button", { name: "Delete domain" }));
    expect(spies.onDelete.mock.calls).toEqual([[ROWS[0]]]);
    // Иначе подтверждение удаления вставало бы поверх только что открытой
    // карточки того же домена.
    expect(spies.onOpenDetail).not.toHaveBeenCalled();
  });

  it("⚙ ведёт в ту же карточку и называет себя настройками, а не развёртыванием", () => {
    const spies = renderTable();
    // Глиф тот же, что раньше запускал provision; смысл сменился нацело, и
    // доступное имя обязано это говорить — иначе кнопка обещает прогон по SSH.
    fireEvent.click(within(rowOf("bravo.com")).getByRole("button", { name: "Open domain settings" }));
    expect(spies.onOpenDetail.mock.calls).toEqual([[2]]);
    expect(spies.onDelete).not.toHaveBeenCalled();
  });
});
