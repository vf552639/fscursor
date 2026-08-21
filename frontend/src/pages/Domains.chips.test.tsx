import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import Domains from "./Domains";
import { queryClient } from "../api/queryClient";
import { tokens } from "../lib/designTokens";
import { domainStatusLabel } from "../lib/domainStatus";
import { useAuthStore } from "../store/auth";
import { hexToRgb } from "../test/colors";

/**
 * Чипы-фильтры вкладки Domains: по какому списку они считают.
 *
 * Про что тест на самом деле: счётчики обязаны считаться по ПОЛНОМУ списку, а
 * не по тому, что осталось после фильтра. Иначе выбранный чип обнуляет соседей
 * — «Failed 3» после клика по «Deployed» становится «Failed 0», — и вернуться к
 * ним некуда: ряд перестаёт быть картой списка и превращается в описание
 * текущего среза, то есть в тавтологию.
 *
 * Почему это отдельный файл, а не строчка в соседнем: правка
 * `domains={domains}` → `domains={filters.filtered}` в `pages/Domains.tsx`
 * выглядит очевидным улучшением («зачем считать по всему, если показываем
 * срез») и не роняла НИ ОДНОГО из трёхсот сорока тестов вкладки. Решение,
 * которому посвящён абзац в истории, не охранялось ничем.
 *
 * Проверяется именно страница, а не компонент чипов в одиночку: обнулить
 * счётчики можно и не трогая сам компонент — достаточно передать ему другой
 * список, и мимо теста на компонент такая правка прошла бы молча.
 */

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

// Тяжёлые соседи страницы, к чипам отношения не имеющие.
vi.mock("../components/DomainBulkImportDialog", () => ({ default: () => null }));
vi.mock("../components/DomainDetailModal", () => ({ default: () => null }));

const domainRow = (id: number, name: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  domain_name: name,
  status,
  registrar_id: null,
  server_id: null,
  cloudflare_account_id: null,
  cloudflare_zone_id: null,
  cloudflare_enabled: false,
  expiry_date: null,
  purchase_date: null,
  ns_status: "ok",
  ssl_status: "active",
  ns_updated_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

/**
 * Набор с РАЗНЫМИ числами на каждом чипе: 2 новых, 3 активных, 1 провал и один
 * промежуточный. Одинаковые числа сделали бы тест зелёным и у реализации,
 * которая считает по срезу, — совпадение приняли бы за правду.
 */
const DOMAINS = [
  domainRow(1, "new-a.com", "new"),
  domainRow(2, "new-b.com", "new"),
  domainRow(3, "live-a.com", "active"),
  domainRow(4, "live-b.com", "active"),
  domainRow(5, "live-c.com", "active"),
  domainRow(6, "broken.com", "failed", { ns_status: "error", ssl_status: "error" }),
  domainRow(7, "midway.com", "ns_ok", { ns_status: "pending" }),
];

function renderPage(rows: ReturnType<typeof domainRow>[] = DOMAINS) {
  mocks.apiGet.mockImplementation(async (url: string) => {
    if (url === "/domains") return rows;
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

/** Чип — кнопка, подписанная словом и счётчиком: «Failed 1». */
const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
/** Сам счётчик — узлом, а не текстом: у него спрашивают ещё и цвет. */
const countEl = (label: string) => within(chip(label)).getAllByText(/^\d+$/)[0];
const countOn = (label: string) => countEl(label).textContent;
const rowNames = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("td")?.parentElement?.textContent ?? "");

/** Перерисовать страницу другим списком доменов — иначе «провалов ноль» не показать. */
async function rerenderWith(rows: ReturnType<typeof domainRow>[]) {
  cleanup();
  queryClient.clear();
  renderPage(rows);
  await screen.findByRole("table");
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
  // на весь файл: без сброса тест, потрогавший чип, задавал бы стартовый срез
  // всем следующим.
  window.history.replaceState({}, "", "/");
  renderPage();
  await screen.findByRole("table");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAuthStore.getState().clear();
});

describe("Domains — чип и колонка говорят одними словами", () => {
  it("подпись чипа дословно равна подписи бейджа того же статуса", () => {
    // Чип фильтрует ту самую колонку, которую подписывает бейдж строки.
    // Разойдись словари — и человек, кликнувший «Active», получал бы список, в
    // котором написано «Deployed», то есть держал бы перевод в голове.
    // Ассерт идёт через ЛЕСТНИЦУ, а не через строковые литералы: переименуют
    // статус — тест поедет вместе с продуктом, а не начнёт врать.
    for (const status of ["active", "new", "failed"] as const) {
      expect(chip(domainStatusLabel(status))).toBeTruthy();
    }
  });

  it("в таблице у этих доменов стоит ровно то же слово", () => {
    // Вторая половина утверждения: подпись чипа совпадает не с константой, а с
    // тем, что человек ВИДИТ в строке.
    fireEvent.click(chip(domainStatusLabel("failed")));
    expect(within(screen.getByRole("table")).getAllByText(domainStatusLabel("failed")).length).toBeGreaterThan(0);
  });
});

describe("Domains — чипы считают по полному списку", () => {
  it("до выбора показывают срез всего списка", () => {
    expect(countOn("All")).toBe("7");
    expect(countOn("Deployed")).toBe("3");
    expect(countOn("Not set up")).toBe("2");
    expect(countOn("Failed")).toBe("1");
  });

  it("выбранный чип не обнуляет соседей — их числа те же", () => {
    fireEvent.click(chip("Deployed"));
    // Таблица действительно сузилась: без этого утверждения тест был бы зелёным
    // и у чипа, который вовсе не фильтрует, — а тогда «счётчики не изменились»
    // не значит ничего.
    expect(rowNames().length).toBe(3);

    // И при этом ряд остался картой ВСЕГО списка: считай он по срезу, здесь
    // стояли бы «All 3, Not set up 0, Failed 0» — то есть человек, кликнувший
    // «Deployed», терял бы из виду и провалы, и новые домены разом.
    expect(countOn("All")).toBe("7");
    expect(countOn("Not set up")).toBe("2");
    expect(countOn("Failed")).toBe("1");
    expect(countOn("Deployed")).toBe("3");
  });

  it("строка NS-деталей тоже считает по полному списку", () => {
    // Тот же вопрос ко второй половине компонента: «In progress» и NS-срез
    // живут за кнопкой и посчитаны тем же вызовом, но проверить это дешевле,
    // чем однажды обнаружить, что срез уехал только у чипов.
    fireEvent.click(chip("Deployed"));
    fireEvent.click(screen.getByRole("button", { name: "NS details" }));

    expect(screen.getByText("In progress: 1")).toBeTruthy();
    expect(screen.getByText("NS Errors: 1")).toBeTruthy();
    expect(screen.getByText("Failed at SSL: 1")).toBeTruthy();
  });

  it("повторный клик по нажатому чипу снимает срез", () => {
    // Кнопка с `aria-pressed` обещает, что нажатое отжимается повторным
    // нажатием. Обещание надо либо выполнить, либо не давать.
    fireEvent.click(chip("Deployed"));
    expect(rowNames().length).toBe(3);
    expect(chip("Deployed").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("Deployed"));
    expect(rowNames().length).toBe(7);
    expect(chip("Deployed").getAttribute("aria-pressed")).toBe("false");
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Domains — чипы фильтруют список", () => {
  it("«Failed» оставляет ровно провалившийся домен", () => {
    fireEvent.click(chip("Failed"));
    // Именно ИМЯ, а не число строк: срез из одной строки совпал бы по длине с
    // десятком других однострочных срезов, и тест не отличил бы «отфильтровал
    // по failed» от «отфильтровал хоть как-нибудь».
    expect(rowNames().length).toBe(1);
    expect(rowNames()[0]).toContain("broken.com");
    expect(chip("Failed").getAttribute("aria-pressed")).toBe("true");
  });

  it("«All» возвращает весь список, а не только соседний срез", () => {
    fireEvent.click(chip("Failed"));
    expect(rowNames().length).toBe(1);

    // Сброс через «All», а не повторным кликом по нажатому чипу (это соседний
    // тест): дорога другая — здесь нажимают ДРУГУЮ кнопку, и она обязана снять
    // чужой срез, а не добавить свой.
    fireEvent.click(chip("All"));
    expect(rowNames().length).toBe(7);
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Failed").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Domains — знаменатель подвала переживает фильтр", () => {
  /**
   * Про что тест на самом деле: `total` подвала — это ПРОВОДКА СТРАНИЦЫ, и до
   * сих пор её не охраняло ничто.
   *
   * Само решение («Y — это всё, что есть в базе, а не длина показанного среза»)
   * уже описано трижды: комментарием у пропса в `pages/Domains.tsx`, вторым — у
   * `total` в `DomainTable.tsx`, и пунктом 3 в шапке `DomainTable.test.tsx`,
   * который прямо называет его самым молчаливым из проверяемых там дефектов.
   * Но проверяется оно КОМПОНЕНТОМ, куда `total` приезжает литералом `7`, —
   * а компонент, получивший неверное число, честно его и напечатает.
   *
   * Поэтому подмена `total={domains.length}` на `total={order.sorted.length}`
   * в `pages/Domains.tsx` оставляла зелёной всю сюиту: подвал начинал говорить
   * «Showing 3 of 3», что выглядит совершенно здорово — и врёт ровно в тот
   * момент, когда нужен, то есть когда фильтр что-то спрятал. Это третий по
   * счёту близнец одной и той же дыры (первые два — счётчики чипов и `total`
   * компонента), и лечится он одинаково: спрашивать надо у страницы.
   *
   * Строка проверяется ЦЕЛИКОМ, а не двумя числами порознь: «3» и «7»,
   * найденные по отдельности, нашлись бы и в подвале, который поменял их
   * местами.
   */
  const footer = () => screen.getByText(/^Showing \d+ of \d+ domains$/);

  it("без фильтра оба числа про весь список", () => {
    expect(footer().textContent).toBe("Showing 7 of 7 domains");
  });

  it("чип сужает числитель и НЕ трогает знаменатель", () => {
    fireEvent.click(chip("Deployed"));
    // Список правда сузился — без этого «of 7» ниже не утверждало бы ничего:
    // у нефильтрующего чипа знаменатель тоже остался бы прежним.
    expect(rowNames().length).toBe(3);
    expect(footer().textContent).toBe("Showing 3 of 7 domains");
  });

  it("поиск сужает так же: дорога другая, знаменатель тот же", () => {
    // Второй фильтр, а не тот же самый: чип и поиск сходятся в `filters.filtered`
    // разными путями, и знаменатель обязан пережить оба. Иначе тест охранял бы
    // одну ветку проводки из двух.
    fireEvent.change(screen.getByPlaceholderText("Search domains…"), { target: { value: "live-" } });
    expect(rowNames().length).toBe(3);
    expect(footer().textContent).toBe("Showing 3 of 7 domains");
  });

  it("фильтр в ноль не отменяет того, что домены есть", () => {
    // Крайний случай той же лжи: «Showing 0 of 0» читается как «доменов нет
    // вовсе» и отправляет человека заводить их заново, вместо того чтобы снять
    // фильтр.
    fireEvent.change(screen.getByPlaceholderText("Search domains…"), { target: { value: "нетакого" } });
    expect(screen.getByText("No domains match the current filter")).toBeTruthy();
    expect(footer().textContent).toBe("Showing 0 of 7 domains");
  });
});

describe("Domains — красный счётчик достаётся только настоящим провалам", () => {
  /**
   * Цвет здесь утверждение, а не украшение: красное число на чипе — это «иди
   * посмотри», и оно обязано загораться ровно тогда, когда смотреть есть на
   * что.
   *
   * Сверяется с токенами (`semantic.danger`), а не с хексом в тесте: палитра
   * живёт в одном месте по построению, и вписанный сюда хекс был бы её второй
   * копией — той самой, что разъезжается. Утверждение при этом не пустое: тест
   * говорит, каким ИМЕННО токеном покрашено число, а «красный» и
   * «приглушённый» — разные роли, и перепутать их модуль токенов не поможет.
   */
  const isAlarming = (label: string) => {
    const el = countEl(label);
    return {
      color: el.style.color === hexToRgb(tokens.semantic.danger.text),
      bg: el.style.background === hexToRgb(tokens.semantic.danger.bg),
    };
  };

  it("провалы есть — число красное на красном", () => {
    expect(isAlarming("Failed")).toEqual({ color: true, bg: true });
  });

  it("у соседних чипов число обычное, сколько бы их ни было", () => {
    // «Deployed 3» — тоже не ноль, и если бы красным красили просто ненулевой
    // счётчик, тревогой светился бы весь ряд на совершенно здоровом списке.
    expect(isAlarming("Deployed")).toEqual({ color: false, bg: false });
    expect(countEl("Deployed").style.color).toBe(hexToRgb(tokens.text.secondary));
  });

  it("провалов ноль — «Failed» гаснет вместе с ними", async () => {
    await rerenderWith(DOMAINS.filter((d) => d.status !== "failed"));
    expect(countOn("Failed")).toBe("0");
    // Красный ноль кричал бы о том, чего не случилось.
    expect(isAlarming("Failed")).toEqual({ color: false, bg: false });
  });
});

describe("Domains — строка NS-деталей разворачивается и сворачивается", () => {
  /** Кнопка называет СЛЕДУЮЩЕЕ действие, поэтому ищется по обоим именам сразу. */
  const toggle = () => screen.getByRole("button", { name: /^(NS details|Hide NS details)$/ });

  it("свёрнута изначально, и её содержимого на экране нет", () => {
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/^NS OK: /)).toBeNull();
  });

  it("клик разворачивает, повторный — сворачивает обратно", () => {
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("NS OK: 5")).toBeTruthy();
    // Подпись сменилась на следующее действие: кнопка, оставшаяся «NS details»
    // при развёрнутой строке, обещает открыть уже открытое.
    expect(toggle().textContent).toBe("Hide NS details");

    fireEvent.click(toggle());
    // Пропала именно СТРОКА, а не только её первый пункт: свёрнутая строка,
    // оставившая на экране хвост из «In progress», — это половина сворачивания.
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/^NS OK: /)).toBeNull();
    expect(screen.queryByText(/^In progress: /)).toBeNull();
    expect(toggle().textContent).toBe("NS details");
  });
});
