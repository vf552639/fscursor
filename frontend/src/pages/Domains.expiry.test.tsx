import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { useAuthStore } from "../store/auth";

/**
 * Сроки, сортировка и срез по статусам в списке доменов.
 *
 * Про что тест на самом деле: продукт заведён затем, чтобы про истечение домена
 * и сертификата человек узнавал от него, а не от клиента. Поэтому проверяется не
 * «в ячейке есть текст», а правила:
 *   1) незнание срока рисуется прочерком, а не молчанием и не «всё хорошо»;
 *   2) битая дата даёт тот же прочерк, а не «NaN» и не падение страницы;
 *   3) при сортировке по сроку домены с НЕИЗВЕСТНЫМ сроком уходят в конец при
 *      ЛЮБОМ направлении — иначе оба вопроса («что горит», «что дальше всего»)
 *      заслоняют те, про кого ответа нет вовсе;
 *   4) дата без времени показывается ТОЙ ЖЕ, какую называет регистратор, а не
 *      сдвинутой в зону читателя.
 *
 * Зона намеренно западная: восточнее UTC (наш UTC+3) сдвиг date-only даты на
 * день не виден вовсе, и зелёная сюита его как раз и пропустила.
 */
process.env.TZ = "America/New_York";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}));

vi.mock("../lib/localCache", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeSynced: vi.fn(),
  syncLocalCache: vi.fn(async () => {}),
}));

// Тяжёлый сосед страницы, к срокам отношения не имеющий (та же преамбула, что в
// Domains.serverstatus.test.tsx, и по той же причине).
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Полная ISO-дата, отстоящая от «сейчас» на `ms`. Час сверху у вызывающих — не
 * суеверие: страница читает свои часы на несколько миллисекунд позже фикстуры, и
 * ровно суточное смещение перескакивало бы через границу полных суток то в одну
 * сторону, то в другую.
 */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

/** `expiry_date` в том виде, в каком его отдаёт бэкенд: `date`, без времени. */
const dateOnly = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);

/**
 * `2026-09-01` → `01.09.2026`. Своей арифметикой, а не форматтером продукта:
 * ожидание, посчитанное тем же кодом, что и проверяемое значение, сойдётся с
 * ним при любой ошибке.
 */
const ddMmYyyy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

/** Один и тот же момент у двух доменов — иначе «равные ключи» не проверить. */
const SAME_EXPIRY = at(10 * DAY + HOUR);
const GOLF_EXPIRY = dateOnly(20 * DAY);

const domainRow = (id: number, name: string, extra: Record<string, unknown>) => ({
  id,
  domain_name: name,
  status: "new",
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "pending",
  ns_updated_at: null,
  ssl_status: null,
  ssl_expires_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...extra,
});

/**
 * Порядок в ответе API — НЕ алфавитный и не совпадающий ни с одним ключом
 * сортировки. Пока фикстуры приезжали уже отсортированными по имени, проверка
 * порядка по умолчанию зеленела бы и с полностью удалённой сортировкой.
 *
 * Имена подобраны так, что алфавит расходится и со сроком, и со статусом, и с
 * датой заведения — иначе тест не отличил бы одну сортировку от другой.
 */
const DOMAINS = [
  domainRow(4, "delta.com", {
    status: "ns_ok",
    // Дата, которую не разобрать. Приезжает с сервера, и падать от неё нельзя.
    expiry_date: "not-a-date",
    ssl_status: "pending",
    created_at: "2026-02-10T00:00:00Z",
  }),
  domainRow(6, "foxtrot.com", {
    status: "new",
    expiry_date: SAME_EXPIRY,
    ssl_status: "active",
    ssl_expires_at: at(5 * DAY + HOUR),
    created_at: "2026-06-15T00:00:00Z",
  }),
  // Срока нет вовсе — самый частый случай: домен, заведённый вручную.
  domainRow(2, "bravo.com", { status: "new", created_at: "2026-01-05T00:00:00Z" }),
  domainRow(5, "echo.com", {
    status: "site_created",
    expiry_date: SAME_EXPIRY,
    created_at: "2026-04-01T00:00:00Z",
  }),
  domainRow(1, "alpha.com", {
    status: "active",
    expiry_date: at(200 * DAY),
    ssl_status: "active",
    ssl_expires_at: at(40 * DAY + HOUR),
    created_at: "2026-03-01T00:00:00Z",
  }),
  // Статус, которого фронт не знает: бэкенд волен добавить такой в любой день.
  domainRow(7, "golf.com", {
    status: "teleported",
    expiry_date: GOLF_EXPIRY,
    created_at: "2026-01-01T00:00:00Z",
  }),
  domainRow(3, "charlie.com", {
    status: "failed",
    expiry_date: at(-3 * DAY - HOUR),
    ssl_status: "error",
    created_at: "2026-05-20T00:00:00Z",
  }),
];

function renderPage() {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return DOMAINS;
    if (url === "/servers") return { items: [], total: 0 };
    if (url === "/registrars/accounts") return [];
    if (url === "/cloudflare/accounts") return [];
    return {};
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Domains onProvisionResult={() => {}} onBulkProvisionResult={() => {}} onBulkProvisionError={() => {}} onCloudflareBindNotice={() => {}} onFullSetupNotice={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
  // Фильтр статуса страница зеркалит в адрес (`?status=`), а адрес в jsdom один
  // на весь файл: без сброса тест, потрогавший фильтр, задавал бы стартовый
  // фильтр всем следующим — и они не находили бы половину фикстур.
  window.history.replaceState({}, "", "/");
  renderPage();
  await screen.findByText("alpha.com");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

/** Строки таблицы (без шапки) в том порядке, в каком они на экране. */
function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0);
}

/** Имена доменов сверху вниз — то, что и есть «порядок» для пользователя. */
function rowNames(): string[] {
  return bodyRows().map((r) => within(r).getAllByRole("cell")[1].textContent?.trim() ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = bodyRows().find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`строки «${name}» в таблице нет`);
  return row;
}

const cell = (name: string, testId: string) => within(rowOf(name)).getByTestId(testId);

/** Кнопка сортировки: её доступное имя называет ДЕЙСТВИЕ, а не только колонку. */
const sortBtn = (column: string) => screen.getByRole("button", { name: `Sort by ${column}` });
const header = (column: string) => sortBtn(column).closest("th") as HTMLElement;

const RED = "rgb(220, 38, 38)";
const AMBER = "rgb(217, 119, 6)";
const DIM = "rgb(156, 163, 175)";

describe("Domains — колонка Expires", () => {
  it("близкий срок называет и красит, просроченный — тоже", () => {
    const soon = cell("echo.com", "expiry-cell");
    expect(within(soon).getByText("in 10 days")).toBeTruthy();
    expect((within(soon).getByText("in 10 days") as HTMLElement).style.color).toBe(AMBER);

    const gone = cell("charlie.com", "expiry-cell");
    expect(within(gone).getByText("expired 3 days ago")).toBeTruthy();
    expect((within(gone).getByText("expired 3 days ago") as HTMLElement).style.color).toBe(RED);
  });

  it("дату без времени показывает как есть, не сдвигая в зону читателя", () => {
    // Контроль: зона теста действительно западная. Без этой строки проверка
    // ниже зеленела бы и в UTC+3, то есть охраняла бы пустоту.
    expect(
      new Date(GOLF_EXPIRY).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }),
    ).not.toBe(ddMmYyyy(GOLF_EXPIRY));
    // `expiry_date` — это `date` без времени, то есть «2026-09-01». Показанная в
    // зоне читателя, она западнее UTC превращалась в предыдущий день: колонка
    // называла дату, которой у домена нет, и расходилась с письмом регистратора.
    expect(within(cell("golf.com", "expiry-cell")).getByText(ddMmYyyy(GOLF_EXPIRY))).toBeTruthy();
  });

  it("отсутствие срока — прочерк, а не пустота и не «ok»", () => {
    // Правило продукта №6: незнание — отдельное состояние. Пустая ячейка
    // читается как «показывать нечего, значит порядок», то есть наоборот.
    const unknown = cell("bravo.com", "expiry-cell");
    expect(unknown.textContent?.trim()).toBe("—");
    expect((within(unknown).getByText("—") as HTMLElement).style.color).toBe(DIM);
  });

  it("нечитаемая дата даёт тот же прочерк, а не «Invalid Date»", () => {
    expect(cell("delta.com", "expiry-cell").textContent?.trim()).toBe("—");
  });

  it("срок сертификата стоит в колонке SSL — второй колонки под него нет", () => {
    const ssl = cell("alpha.com", "ssl-cell");
    expect(within(ssl).getByText("SSL active")).toBeTruthy();
    expect(within(ssl).getByText("in 40 days")).toBeTruthy();
    // «Сертификата нет» и «срок сертификата неизвестен» — разные вещи, но обе
    // означают, что даты перевыпуска у нас нет, и молчать об этом нельзя.
    const none = cell("bravo.com", "ssl-cell");
    expect(within(none).getByText("— No SSL")).toBeTruthy();
    expect(within(none).getByText("—")).toBeTruthy();
  });
});

describe("Domains — сортировка по клику на заголовок", () => {
  it("по умолчанию — по имени, и направление видно в заголовке", () => {
    // Фикстуры приезжают из API в другом порядке (см. `DOMAINS`), так что это
    // проверка сортировки, а не совпадения с ответом сервера.
    expect(rowNames()).toEqual([
      "alpha.com",
      "bravo.com",
      "charlie.com",
      "delta.com",
      "echo.com",
      "foxtrot.com",
      "golf.com",
    ]);
    expect(header("Domain").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Expires").getAttribute("aria-sort")).toBe("none");
  });

  it("повторный клик по имени переворачивает алфавит", () => {
    fireEvent.click(sortBtn("Domain"));
    expect(rowNames()[0]).toBe("golf.com");
    expect(header("Domain").getAttribute("aria-sort")).toBe("descending");
  });

  it("клик по Expires ставит первым самый горящий домен", () => {
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().slice(0, 4)).toEqual(["charlie.com", "echo.com", "foxtrot.com", "golf.com"]);
    expect(header("Expires").getAttribute("aria-sort")).toBe("ascending");
  });

  it("повторный клик переворачивает порядок", () => {
    fireEvent.click(sortBtn("Expires"));
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().slice(0, 2)).toEqual(["alpha.com", "golf.com"]);
    expect(header("Expires").getAttribute("aria-sort")).toBe("descending");
  });

  it("домены с одинаковым сроком стоят по имени, а не как пришли", () => {
    // echo и foxtrot истекают в один и тот же момент, а из API приходят в
    // обратном порядке. Без разрешения ничьей полсотни доменов с одной датой
    // покупки встают в порядке заведения, который меняется от каждой вставки
    // строки в базу. Имя не переворачивается вместе с направлением — иначе
    // «одинаковые» строки прыгали бы от клика, не меняя ключа сортировки.
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().indexOf("echo.com")).toBeLessThan(rowNames().indexOf("foxtrot.com"));
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().indexOf("echo.com")).toBeLessThan(rowNames().indexOf("foxtrot.com"));
  });

  it("домены без известного срока — в конце при ОБОИХ направлениях", () => {
    // Ни «в начале списка горящего», ни «в начале списка дальнего» им не место:
    // это не ответ на вопрос, а его отсутствие. Нечитаемая дата (delta) здесь
    // приравнена к отсутствующей (bravo) — пользователю разницы нет.
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().slice(-2)).toEqual(["bravo.com", "delta.com"]);
    fireEvent.click(sortBtn("Expires"));
    expect(rowNames().slice(-2)).toEqual(["bravo.com", "delta.com"]);
  });

  it("статус сортируется по жизненному циклу, а не по алфавиту", () => {
    // По алфавиту вышло бы «active, failed, new, ns_ok, site_created» — порядок
    // букв, из которого не видно, что доделано, а что нет.
    fireEvent.click(sortBtn("Status"));
    expect(rowNames().slice(0, 5)).toEqual([
      "bravo.com",
      "foxtrot.com",
      "delta.com",
      "echo.com",
      "alpha.com",
    ]);
    // Второй клик поднимает наверх failed — то, что ищут вторым кликом.
    fireEvent.click(sortBtn("Status"));
    expect(rowNames()[0]).toBe("charlie.com");
  });

  it("незнакомый статус уходит в конец при ОБОИХ направлениях", () => {
    // golf в статусе, которого фронт не знает. Числом «за концом лестницы» он
    // переворачивался бы вместе с направлением и вторым кликом вставал бы ПЕРЕД
    // failed — то есть верх списка занимал бы тот, про кого мы ничего не знаем.
    fireEvent.click(sortBtn("Status"));
    expect(rowNames()[6]).toBe("golf.com");
    fireEvent.click(sortBtn("Status"));
    expect(rowNames()[6]).toBe("golf.com");
  });

  it("колонка SSL сортируется по статусу сертификата, срок — вторым ключом", () => {
    // Так же устроена и сама ячейка: бейдж крупно, срок подписью под ним.
    // Сортировать её по подписи значило бы упорядочить список по тому, чего в
    // заголовке нет.
    fireEvent.click(sortBtn("SSL"));
    const asc = rowNames();
    // «Нет сертификата» — тоже статус, и он первый; ошибка выпуска — последняя.
    expect(asc.slice(0, 3)).toEqual(["bravo.com", "echo.com", "golf.com"]);
    expect(asc[6]).toBe("charlie.com");
    // Внутри одного статуса решает срок: foxtrot истекает раньше alpha.
    expect(asc.indexOf("foxtrot.com")).toBeLessThan(asc.indexOf("alpha.com"));

    fireEvent.click(sortBtn("SSL"));
    const desc = rowNames();
    expect(desc[0]).toBe("charlie.com");
    expect(desc.indexOf("alpha.com")).toBeLessThan(desc.indexOf("foxtrot.com"));
  });

  it("колонка Added сортируется по дате заведения", () => {
    fireEvent.click(sortBtn("Added"));
    expect(rowNames().slice(0, 3)).toEqual(["golf.com", "bravo.com", "delta.com"]);
    fireEvent.click(sortBtn("Added"));
    expect(rowNames()[0]).toBe("foxtrot.com");
  });

  it("сортировка идёт ПОСЛЕ фильтра, а не вместо него", () => {
    fireEvent.click(sortBtn("Expires"));
    // Срез по статусу задаётся чипом: селекта «All Statuses» больше нет, и это
    // не смена способа нажать, а смена поверхности — фильтр теперь виден на
    // экране числом, а не спрятан в списке.
    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(rowNames()).toEqual(["charlie.com"]);
  });

  it("клик по заголовку не отбирает у него фокус", () => {
    // Вторая сортировка — это ВТОРОЙ клик по тому же заголовку, на нём держится
    // вся функция. Пока `Th` объявлялся внутри компонента страницы, каждый
    // рендер создавал новый тип компонента, React перемонтировал ячейки шапки,
    // и фокус после первого нажатия уезжал на `body`: клавиатурному
    // пользователю, чтобы перевернуть порядок, приходилось протабливаться до
    // заголовка заново. Мышью это не видно вовсе.
    const btn = sortBtn("Expires");
    btn.focus();
    fireEvent.click(btn);
    expect(sortBtn("Expires")).toBe(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("у чекбокса и колонки действий сортировки нет", () => {
    // Кликабельный заголовок над кнопками обещал бы порядок, которого у них не
    // бывает.
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
    expect(within(headers[0]).queryByRole("button")).toBeNull();
    expect(within(headers[headers.length - 1]).queryByRole("button")).toBeNull();
  });
});

describe("Domains — срез по статусам и рассинхрон ns_ok", () => {
  /**
   * Чип — кнопка, подписанная словом и счётчиком («Failed 1»). Ищется по началу
   * подписи, а не по ней целиком: разделитель между словом и числом — деталь
   * вёрстки, и тест, прибитый к нему, краснел бы от смены отступа.
   */
  const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("чипы показывают жизненный цикл и сходятся с общим числом", () => {
    expect(within(chip("New")).getByText("2")).toBeTruthy();
    expect(within(chip("Active")).getByText("1")).toBeTruthy();
    expect(within(chip("Failed")).getByText("1")).toBeTruthy();
    // «All» — то самое Total, на котором и проверяется сходимость: 2 + 1 + 1
    // плюс трое «в работе», которым своего чипа не досталось.
    expect(within(chip("All")).getByText("7")).toBeTruthy();
  });

  it("«In progress» считается остатком и не теряет статусы, которых нет в чипах", () => {
    // ns_ok, site_created и незнакомый статус — все «в работе»: перечислением
    // статусов их легко потерять, поэтому счётчик считается остатком и всегда
    // сходится с общим числом. Живёт он теперь за кнопкой NS-деталей — чипов
    // ровно четыре, и промежуточным статусам среди них места нет.
    fireEvent.click(screen.getByRole("button", { name: "NS details" }));
    expect(screen.getByText("In progress: 3")).toBeTruthy();
  });

  it("ns_ok рисуется своим бейджем, а не серым фолбэком", () => {
    // Ровно этот рассинхрон и держался: статус существует на бэкенде, а на
    // фронте его не было ни в списке фильтра, ни в карте бейджа. Половина про
    // список фильтра снята вместе с самим селектом «All Statuses»: срез по
    // статусу задают четыре чипа, промежуточных статусов среди них нет по
    // решению, и проверять в них пункт `NS_OK` больше нечего. Половина про
    // бейдж — та, что и ловила фолбэк, — остаётся.
    const badge = within(rowOf("delta.com")).getByText("NS_OK");
    // Синий, а не серый (`#9ca3af` фолбэка) и не зелёный: NS проставлены — это
    // пройденная ступень, а не готовый домен.
    expect(badge.style.color).toBe("rgb(37, 99, 235)");
  });
});
