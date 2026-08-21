import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import { RegistrarAccount } from "../../api/registrars";
import { Server } from "../../api/servers";
import { setTauri } from "../../test/secretBlobKit";
import { tokens } from "../../lib/designTokens";
import { domainStatusHint, domainStatusLabel } from "../../lib/domainStatus";
import { hexToRgb } from "../../test/colors";
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
  ssl: null,
  facts_at: null,
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

/**
 * Ячейка имени домена — вторая в строке (нулевая — чекбокс).
 *
 * Под именем в ней же стоят метки (ступень настройки, сервер, регистратор) и
 * текст провалившегося прогона, так что «в этой ячейке» — не придирка к
 * вёрстке, а само утверждение: сигнал переехал в колонку имени, а не остался в
 * строке вообще.
 */
const nameCell = (name: string) => within(rowOf(name)).getAllByRole("cell")[1];

afterEach(cleanup);

describe("DomainTable — набор колонок", () => {
  it("колонок семь: Server, Registrar и Setup среди них больше нет", () => {
    renderTable();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim() ?? "");
    // Первая — чекбокс «выделить всё», последняя — действия; обе без подписи.
    // Стрелка — часть подписи и здесь несущая: «↕» стоит и на неактивных
    // сортируемых колонках (иначе кликабельность узнаётся только случайным
    // попаданием курсора), а у активной она сменилась направлением. Колонка
    // Cloudflare без стрелки — по ней порядка нет.
    expect(headers).toEqual(["", "Domain↑", "Cloudflare", "SSL↕", "Expires↕", "Added↕", ""]);
  });

  it("по ступени настройки сортировать больше нечем — заголовка нет", () => {
    // Ключ сортировки без заголовка нажать нечем, а заголовок без колонки
    // обещал бы порядок строк по значению, которого в них не видно.
    //
    // Проверяется ровно «Sort by Setup» — подпись, которая тут была. Соседняя
    // проверка на «Sort by Status» отсюда убрана как нефальсифицируемая:
    // колонки с такой подписью в этой таблице не было никогда (заголовок звался
    // «Setup» намеренно, чтобы не спорить с колонкой Status вкладки Servers), и
    // упасть такое утверждение не могло ни при какой реализации.
    renderTable();
    expect(screen.queryByRole("button", { name: "Sort by Setup" })).toBeNull();
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

describe("DomainRow — ступень настройки называется только там, где она исключение", () => {
  /**
   * Про что тест на самом деле: колонка Setup ушла, а сигнал остался.
   *
   * Колонка называла ступень у КАЖДОГО домена, и на живом списке это было 31
   * «Not set up» и 15 «Deployed» — ровно то, что чипы над таблицей уже
   * говорят одной строкой со счётчиками. Ценность у неё была одна и редкая:
   * застрявший, упавший или незнакомый статус. Он и остался — бейджем под
   * именем домена, рядом с сервером и регистратором.
   *
   * Обе половины утверждения нужны разом. Без первой («у рутины бейджа нет»)
   * уборка не состоялась бы: бейдж у всех — это та же колонка, только внутри
   * другой. Без второй («у исключения бейдж есть») уборка унесла бы с собой
   * единственное место в списке, где видно, что домен не доехал.
   */
  it("у `new` и `active` ступени в строке нет вовсе", () => {
    renderTable({ rows: [domain(1, "fresh.com", { status: "new" }), domain(2, "live.com", { status: "active" })] });
    // Не «нет в ячейке имени», а нет НИГДЕ в строке: колонки со ступенью в
    // таблице больше не существует, и проверка по ячейке зеленела бы даже у
    // реализации, вернувшей колонку обратно.
    expect(within(rowOf("fresh.com")).queryByText(domainStatusLabel("new"))).toBeNull();
    expect(within(rowOf("live.com")).queryByText(domainStatusLabel("active"))).toBeNull();
  });

  it("застрявший, упавший и незнакомый домены называют себя под именем", () => {
    renderTable({
      rows: [
        domain(1, "waiting.com", { status: "ns_pending" }),
        domain(2, "deploying.com", { status: "provisioning" }),
        domain(3, "broken.com", { status: "failed" }),
        // Статус, которого фронт не знает: незнание нельзя рисовать
        // благополучием, поэтому бейдж ему полагается наравне с провалом.
        domain(4, "alien.com", { status: "teleported" }),
      ],
    });
    expect(within(nameCell("waiting.com")).getByText(domainStatusLabel("ns_pending")).textContent).toBe("Waiting NS");
    expect(within(nameCell("deploying.com")).getByText(domainStatusLabel("provisioning"))).toBeTruthy();
    expect(within(nameCell("broken.com")).getByText(domainStatusLabel("failed"))).toBeTruthy();
    expect(within(nameCell("alien.com")).getByText("Unknown")).toBeTruthy();
  });

  it("исключение стоит ПЕРЕД сервером и регистратором", () => {
    // Порядок здесь и есть смысл ряда: слева — то, что требует действия,
    // справа — справка о том, где домен живёт. Обратный порядок прятал бы
    // редкий сигнал за двумя метками, которые есть почти у всех.
    renderTable({ rows: [domain(1, "broken.com", { status: "failed", server_id: 3, registrar_id: 4 })] });
    const badges = within(nameCell("broken.com"))
      .getAllByText(/^(Failed|web-01|hostiq)$/)
      .map((e) => e.textContent);
    expect(badges).toEqual(["Failed", "web-01", "hostiq"]);
  });
});

describe("DomainRow — текст провалившегося прогона", () => {
  /**
   * Единственное место в списке, где видно, ПОЧЕМУ домен не доехал. Переезжая
   * из своей колонки под имя домена, он обязан остаться видимым ТЕКСТОМ:
   * `title` — второй канал, а не первый, и подсказка, невидимая до наведения
   * мышью, не годится для поиска провалившегося домена глазами по списку в
   * двести строк.
   */
  const ERR = "provision failed at create_site: the command failed on the server";

  it("стоит текстом под именем домена, а полный — ещё и в подсказке", () => {
    renderTable({ rows: [domain(1, "broken.com", { status: "failed", last_provision_error: ERR })] });
    const err = within(nameCell("broken.com")).getByTestId("provision-error");
    expect(err.textContent).toBe(ERR);
    expect(err.getAttribute("title")).toBe(ERR);
    // Видимая часть — ДВЕ строки, а не одна обрезанная по первому слову:
    // в узкой колонке статуса от такой строки оставалось «provision failed…»,
    // то есть всё объяснение уезжало в подсказку. `nowrap` — ровно тот дефект,
    // и вернуть его молча нельзя.
    //
    // Проверяются ВСЕ ЧЕТЫРЕ свойства связки, и лишних среди них нет — каждое
    // отвечает за свой шаг обрезки:
    //   `display: -webkit-box`  — включает саму раскладку, в которой счёт строк
    //                             вообще существует;
    //   `box-orient: vertical`  — задаёт, что считаются СТРОКИ, а не колонки;
    //   `line-clamp: 2`         — сколько их оставить и где поставить многоточие;
    //   `overflow: hidden`      — прячет остальные; без него clamp не обрезает
    //                             ничего, и многоточие не рисуется тоже.
    // Снятое поодиночке, любое из четырёх возвращает нам строку, растущую вслед
    // за многословием сервера, — и делает это молча: текст на месте, `title` на
    // месте, тест на длину не поймает. Ради этого класса поломок и написана
    // преамбула файла.
    expect(err.style.display).toBe("-webkit-box");
    expect(err.style.getPropertyValue("-webkit-box-orient")).toBe("vertical");
    expect(err.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
    expect(err.style.overflow).toBe("hidden");
    expect(err.style.whiteSpace).not.toBe("nowrap");
  });

  it("бейдж объясняет СТУПЕНЬ, а не пересказывает ошибку в третий раз", () => {
    // Пока ошибка была обрезана до одного слова в колонке 110px, подсказка
    // бейджа была единственным местом с полным текстом, и перебивать ею
    // объяснение статуса стоило того. Теперь текст виден двумя строками и несёт
    // собственный `title` — пересказ в подсказке бейджа был бы третьей копией
    // той же строки, купленной ценой погашенного объяснения ступени. А ступень
    // без объяснения молчит о том, чем «Failed» отличается от «Site created»:
    // оба слова из чужого словаря.
    renderTable({ rows: [domain(1, "broken.com", { status: "failed", last_provision_error: ERR })] });
    const pill = within(rowOf("broken.com")).getByText(domainStatusLabel("failed"));
    expect(pill.getAttribute("title")).toBe(domainStatusHint("failed"));
    expect(pill.getAttribute("title")).not.toBe(ERR);
    // И о том, что подсказка есть, курсор заявляет — как у соседних меток
    // (`RowBadge`): пилюля показывает одно слово из чужого словаря, и догадаться
    // иначе не о чем. Без этого о наличии объяснения сообщали бы как раз те две
    // метки, чьи объяснения менее ценны.
    expect(pill.style.cursor).toBe("help");
  });

  it("чистому домену блока не достаётся вовсе", () => {
    renderTable({
      rows: [domain(1, "broken.com", { status: "failed", last_provision_error: ERR }), domain(2, "fine.com", { status: "active" })],
    });
    // Считается ЧИСЛО блоков: проверка «в чистой строке нет текста» осталась бы
    // зелёной и у реализации, которая рисует блок всем подряд, — у чистого
    // домена он просто вышел бы пустым.
    expect(screen.getAllByTestId("provision-error")).toHaveLength(1);
    expect(within(rowOf("fine.com")).queryByTestId("provision-error")).toBeNull();
  });

  it("текст ошибки не остаётся без бейджа, даже если статус придёт рутинным", () => {
    // Такого домена сегодня не производит ни один писатель: и десктоп
    // (`domain_write_back_body`), и повтор прогона шлют рутинный статус ОДНИМ
    // запросом вместе с `last_provision_error: null`, а не дойдя, тот же запрос
    // оставляет домен в `failed` — то есть первая половина условия. Проверка
    // сторожит не достижимое состояние, а инвариант самой строки: красного
    // текста без слова о том, чем домен является, в списке не бывает, что бы ни
    // прислал сервер. Разойдись мы с ним завтра — строка читалась бы как
    // поломка страницы, а не домена, и это нельзя оставлять на «не случится».
    renderTable({ rows: [domain(1, "stale.com", { status: "active", last_provision_error: ERR })] });
    const cell = nameCell("stale.com");
    expect(within(cell).getByText(domainStatusLabel("active"))).toBeTruthy();
    expect(within(cell).getByTestId("provision-error")).toBeTruthy();
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

describe("DomainRow — состав колонки действий", () => {
  /**
   * Главное утверждение фазы 4: вход в provision ОДИН, и он на карточке домена.
   *
   * Проверяется составом, а не отсутствием одной кнопки, и проверяется именно
   * под флагом десктопа — потому что ревью сломало это мутацией и не поймало
   * никто: иконка ⚙ provision, возвращённая в строку под `isTauri()`, оставила
   * зелёными все четыреста тридцать три теста страниц. Исчезновение второго
   * входа охранял ровно один тест, и тот — в веб-ветке
   * (`Domains.provision.test.tsx`), то есть ровно в той, где кнопки не было бы
   * и у мутанта.
   *
   * `toEqual` на массиве, а не пара `queryByRole(...).toBeNull()`: список имён
   * запирает и набор, и порядок, и любое ТРЕТЬЕ действие — как бы оно ни
   * называлось. Отрицание же охраняет только то имя, которое в него вписали, а
   * следующая кнопка приедет с другим.
   */
  // Флаг десктопа живёт на общем `window` и переживает файл: не сняв его, мы
  // покрасили бы чужой тест, который сам десктоп не включал.
  afterEach(() => setTauri(false));

  /** Доступные имена кнопок ячейки действий — она последняя в строке. */
  const actionNames = (domainName: string) => {
    const cells = within(rowOf(domainName)).getAllByRole("cell");
    return within(cells[cells.length - 1])
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
  };

  it("в ДЕСКТОПЕ действий ровно два — открыть карточку и удалить", () => {
    setTauri(true);
    renderTable();
    expect(actionNames("alpha.com")).toEqual(["Open domain settings", "Delete domain"]);
  });

  it("в вебе набор тот же — разницы между ветками у строки нет вовсе", () => {
    renderTable();
    expect(actionNames("alpha.com")).toEqual(["Open domain settings", "Delete domain"]);
  });
});

describe("DomainRow — тег сертификата не теряет краёв", () => {
  /**
   * Про что тест на самом деле: находка прошлого ревью, у которой не было ни
   * одного ассерта, — рамка пилюли «No SSL».
   *
   * Дефект не в цвете, а в СОВПАДЕНИИ двух цветов: заливка нейтральной пилюли
   * (`surface.page`) равна разлиновке строк (`border.hairline` объявлен ей
   * равным намеренно), поэтому без рамки у пилюли не было краёв ПО
   * ПОСТРОЕНИЮ — она читалась пятном на строке, а не тегом. Заметить это можно
   * только глазами и только на настоящем списке; в diff'е снятая рамка
   * выглядит уборкой лишнего.
   *
   * Поэтому утверждение двойное: рамка есть И она отличается от заливки. Одной
   * первой половины мало — `border: 1px solid <цвет заливки>` формально рамка,
   * а на экране её нет.
   *
   * Нейтральную пилюлю носит теперь «Not checked» («снимка нет»), а не «No
   * SSL»: предмет находки от этого не изменился — те же два токена и то же
   * совпадение, — а вот сама подпись стала честнее (фаза 1 плана
   * `2026-08-21-domains-shest-pravok.md`).
   */
  const sslPill = (name: string) =>
    within(rowOf(name)).getByTitle(/^SSL: /) as HTMLElement;

  it("нейтральная пилюля очерчена, и рамка не сливается с собственной заливкой", () => {
    renderTable();
    const pill = sslPill("bravo.com");
    expect(pill.textContent).toBe("Not checked");
    expect(pill.style.background).toBe(hexToRgb(tokens.surface.page));
    expect(pill.style.borderStyle).toBe("solid");
    expect(pill.style.borderColor).toBe(hexToRgb(tokens.border.light));
    expect(pill.style.borderColor).not.toBe(pill.style.background);
  });

  it("и та же заливка правда равна разлиновке строк — ради чего рамка и нужна", () => {
    // Опорная точка находки, а не украшение: сойдись эти два токена в разные
    // значения, тест выше охранял бы уже не ту причину, о которой написан.
    expect(tokens.surface.page).toBe(tokens.border.hairline);
  });
});

describe("RowActions — ховер не оставляет за собой рамки", () => {
  /**
   * Про что тест на самом деле: вторая находка прошлого ревью без ассертов.
   *
   * Инлайн-стиль, поставленный на `mouseenter`, живёт на узле до тех пор, пока
   * его не снимут явно. Тон `inverted` красит на ховере ещё и рамку (опасное
   * действие краснеет целиком), а `mouseleave`, возвращавший только фон и цвет
   * глифа, оставлял красную рамку на кнопке, с которой курсор давно ушёл, — то
   * есть строка помнила бы, над каким «✕» посетитель однажды пронёс мышь.
   *
   * Проверяется ЦИКЛ, а не конечное состояние: рамка, никогда не менявшаяся,
   * прошла бы проверку «после ухода она обычная» с тем же успехом.
   */
  const deleteBtn = (name: string) =>
    within(rowOf(name)).getByRole("button", { name: "Delete domain" });

  it("рамка краснеет под курсором и возвращается, когда он ушёл", () => {
    renderTable();
    const btn = deleteBtn("alpha.com");
    const resting = btn.style.borderColor;
    expect(resting).toBeTruthy();

    fireEvent.mouseEnter(btn);
    expect(btn.style.borderColor).toBe(hexToRgb(tokens.semantic.danger.border));
    expect(btn.style.borderColor).not.toBe(resting);

    fireEvent.mouseLeave(btn);
    expect(btn.style.borderColor).toBe(resting);
  });

  it("обычное действие уходит с ховера тем же путём", () => {
    // Второй тон той же карты: `inverted` красит рамку и у обычной кнопки
    // (тёмная плашка — тёмная рамка), так что забыть её вернуть можно ровно
    // так же.
    renderTable();
    const btn = within(rowOf("alpha.com")).getByRole("button", { name: "Open domain settings" });
    const resting = btn.style.borderColor;

    fireEvent.mouseEnter(btn);
    expect(btn.style.borderColor).not.toBe(resting);

    fireEvent.mouseLeave(btn);
    expect(btn.style.borderColor).toBe(resting);
  });
});
