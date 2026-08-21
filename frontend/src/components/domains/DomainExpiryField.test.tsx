import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  createEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainExpiryField from "./DomainExpiryField";
import { queryClient } from "../../api/queryClient";
import { tokens } from "../../lib/designTokens";
import { expiryTextColor } from "../../lib/domainExpiry";
import { hexToRgb, luminanceOfRgb, relativeLuminance } from "../../test/colors";

/**
 * Срок домена в шапке карточки — и правка его на месте.
 *
 * Правила, ради которых тут вообще есть тесты.
 *
 * 1. **Незнание названо словом.** У домена без срока поле не пустое и не
 *    прочерк, а приглашение «set date»: править его надо оттуда же, где видно,
 *    что править нечего.
 * 2. **Дата набирается ТЕКСТОМ.** Нативный `<input type="date">` ушёл отсюда
 *    совсем: в WKWebView десктопа он не принимал ввод с клавиатуры вовсе —
 *    цифры не вставали в сегменты, календарь не открывался, `input.value` был
 *    пуст всегда. Тесты сторожат, что поле снова стало обычным текстовым.
 * 3. **Запись — только по явному входу.** ✓, Enter, уход из поля. Набор с
 *    клавиатуры сам по себе на сервер не уходит, и открытие поля тоже: колбэки
 *    примитива говорят «вот моё состояние», а не «сохрани меня», и на
 *    монтировании в StrictMode звучат дважды.
 * 4. **Непонятная строка не уходит на сервер и объясняется на месте.**
 * 5. **Пока запись идёт, на экране стоит ВЫБРАННОЕ.** Своей строки домена у
 *    карточки нет — она приезжает пропсом и обновляется только после рефетча по
 *    инвалидации. Без памяти о правке поле возвращалось бы к старой дате сразу
 *    после записи, и это читалось бы как «правку потеряли». А вот провал
 *    записи, наоборот, обязан вернуть сохранённое: держать на экране дату,
 *    которой сервер не принял, — то же враньё, только наоборот.
 */

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
}));

/** Фиксированное «сейчас»: подписи вроде «in 14 days» обязаны быть считаемы вручную. */
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
/** `expiry_date` в производственном виде: `date`, без времени и без зоны. */
const STORED = "2026-09-01";
/** Она же — набранная руками: поле принимает ровно то, что печатает. */
const STORED_TYPED = "01.09.2026";
/** Срок такой даты — конец дня, поэтому от 18-го полудня до неё 14 полных суток. */
const STORED_LABEL = "01.09.2026 · in 14 days";
const PICKED = "2027-01-01";
const PICKED_TYPED = "01.01.2027";
/** Вторая правка — та, что набирается ПОВЕРХ ещё не доехавшей записи. */
const LATER = "2028-05-15";
const LATER_TYPED = "15.05.2028";
/** Третья дата — ею в строку домена пишет КТО-ТО ДРУГОЙ, не это поле. */
const OTHER = "2027-03-01";

function domain(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    domain_name: "example.com",
    status: "active",
    expiry_date: STORED,
    ...over,
  } as any;
}

function show(over: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <DomainExpiryField domain={domain(over)} now={NOW} />
    </QueryClientProvider>,
  );
}

/** Значение в состоянии показа: кнопка с пунктиром. */
function value() {
  return screen.getByRole("button", { name: /^Expiry date: / });
}

/** Значение в состоянии правки: текстовое поле даты. */
function dateInput() {
  return screen.getByLabelText("Expiry date") as HTMLInputElement;
}

/** Кнопка подтверждения — она же ✓. */
function check() {
  return screen.getByRole("button", { name: "Save expiry date" });
}

/** Набор с клавиатуры: браузер отдаёт `change` на каждое изменение текста. */
function type(text: string) {
  fireEvent.change(dateInput(), { target: { value: text } });
}

/** Красная строка РАЗБОРА — её рисует примитив, и обе её подписи начинаются с «Expected». */
const parseError = () => screen.queryByText(/^Expected/);

/**
 * Дать мутации шанс уйти.
 *
 * `mutate` зовёт `mutationFn` не синхронно, поэтому проверка «ничего не
 * записано» сразу после события проходит и на поле, которое пишет: она успевает
 * раньше записи. Все утверждения об ОТСУТСТВИИ PUT'а идут после этого ожидания.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Тела всех `PUT /domains/42` — то, что поле записало в строку домена. */
function writes() {
  return mocks.apiPut.mock.calls
    .filter((c: any[]) => String(c[0]) === "/domains/42")
    .map((c: any[]) => c[1]);
}

/** Мутация, которая никогда не отвечает: так видно состояние «запись идёт». */
function hangingPut() {
  let finish: ((row: any) => void) | null = null;
  mocks.apiPut.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  return {
    async resolveWith(row: any) {
      await act(async () => {
        finish?.(row);
      });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  const base = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...base,
    queries: { ...base.queries, retry: false },
    mutations: { ...base.mutations, retry: false },
  });
  mocks.apiGet.mockResolvedValue([]);
  // Ответ сервера — строка домена С УЧЁТОМ отправленного тела: фиксированный
  // ответ утверждал бы «сохранено» на любую запись.
  mocks.apiPut.mockImplementation(async (_path: string, body: any) => domain(body));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("срок домена — показ", () => {
  it("печатает дату и остаток словами тем же модулем, что и колонка списка", () => {
    show();
    // Дата — в UTC: `expiry_date` приходит без времени, и западнее UTC общий
    // `fmtDate` назвал бы предыдущий день, разойдясь с колонкой `Expires`.
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("срока нет — приглашение «set date», а не пустое место", () => {
    show({ expiry_date: null });
    expect(value().textContent).toBe("set date");
  });
});

describe("срок домена — приглашение «set date» видно глазами", () => {
  /**
   * Про что тест на самом деле: это ЕДИНСТВЕННЫЙ ассерт под находкой ревью,
   * описанной пятнадцатью строками комментария в самом поле, отдельным абзацем
   * в `expiryTextColor`, границей применения у `text.disabled` и пунктом в
   * итоге плана — и не имевшей до сих пор ни одной проверки.
   *
   * Дефект: кнопка пустого состояния красилась лестницей состояний срока через
   * `expiryTextColor("unknown")`, то есть тоном РАМКИ (`text.disabled`,
   * #cbd5e1). У прочерка «—» в списке этот тон законен — там смысл несёт
   * пустота, а не знак; на кнопке же он давал призыв к действию контрастом
   * 1.48:1, который почти не видно. Правка в одну строку — и откат её в ту же
   * одну строку оставлял всю сюиту зелёной: текст кнопки не меняется, разметка
   * не меняется, меняется только то, можно ли это прочесть.
   *
   * Проверяется ПОРОГ, а не хекс, и это важнее, чем кажется: тест, сверяющий
   * `style.color` с `tokens.text.muted`, охранял бы конкретный оттенок, а не
   * причину, по которой он выбран, — и следующая правка палитры прошла бы его
   * с любым нечитаемым тоном, лишь бы он лежал под тем же именем. Здесь же
   * утверждается ровно то, ради чего правка делалась: слово, которое просят
   * прочесть и нажать, обязано брать порог AA (4.5:1) на белом фоне модалки.
   */

  /** Контраст по WCAG к белому фону карточки: `(1 + 0.05) / (L + 0.05)`. */
  const contrastOnWhite = (rgb: string) => 1.05 / (luminanceOfRgb(rgb) + 0.05);

  it("«set date» набрано читаемым тоном, а не тоном рамки", () => {
    show({ expiry_date: null });
    const color = value().style.color;

    expect(color).toBe(hexToRgb(tokens.text.muted));
    // И то же самое с другой стороны: тон лестницы для «незнания» сюда НЕ
    // приезжает. Без этой строки тест прошёл бы в тот день, когда `unknown` и
    // `muted` сойдутся в одно значение, — а сошлись бы они как раз возвратом
    // лестницы на кнопку.
    expect(color).not.toBe(hexToRgb(expiryTextColor("unknown")));
    expect(contrastOnWhite(color)).toBeGreaterThanOrEqual(4.5);
  });

  it("тон рамки этот порог не берёт — иначе тест не значил бы ничего", () => {
    // Опорная точка: показывает, что 4.5 выше по тексту — не формальность, под
    // которую подходит что угодно. Откат правки даёт здесь 1.48:1.
    const disabled = 1.05 / (relativeLuminance(tokens.text.disabled) + 0.05);
    expect(disabled).toBeLessThan(2);
  });

  it("заполненный срок по-прежнему красит лестница, а не приглашение", () => {
    // Обратная половина решения: «своим цветом» разрешено ровно пустому
    // состоянию. Покрасить приглашением ВСЁ поле — тоже способ пройти тест
    // выше, и он развёл бы карточку со списком, который красит ту же дату
    // лестницей.
    show();
    expect(value().style.color).toBe(hexToRgb(expiryTextColor("soon")));
  });
});

describe("срок домена — поле правки", () => {
  it("клик по значению открывает ТЕКСТОВОЕ поле, уже набранное сохранённой датой", () => {
    show();
    fireEvent.click(value());

    const input = dateInput();
    // Ради этой строки всё и затевалось: нативного `type="date"` здесь больше
    // нет — он в WKWebView не принимал ввод с клавиатуры вовсе.
    expect(input.type).toBe("text");
    // Дата показана человеку в том же написании, в каком её печатает колонка
    // списка, — и в нём же принимается обратно.
    expect(input.value).toBe(STORED_TYPED);
    // Фокус сразу в поле: иначе после клика надо кликать второй раз.
    expect(document.activeElement).toBe(input);
  });

  it("в правке стоит ✓, и снятие срока названо словами", () => {
    show();
    expect(screen.queryByRole("button", { name: "Save expiry date" })).toBeNull();
    expect(screen.queryByText("Empty clears the date.")).toBeNull();

    fireEvent.click(value());
    expect(check()).toBeTruthy();
    // Пустое поле здесь — распоряжение стереть дату, и догадаться об этом
    // неоткуда: у соседних полей карточки пустое значение значит «не заполнено».
    expect(screen.getByText("Empty clears the date.")).toBeTruthy();
  });

  it("домену без срока стирать нечего — и подписи про это нет", () => {
    show({ expiry_date: null });
    fireEvent.click(value());
    // Обещание стереть то, чего нет, — не подсказка, а шум.
    expect(screen.queryByText("Empty clears the date.")).toBeNull();
    expect(dateInput().getAttribute("aria-describedby") ?? "").not.toContain(
      "domain-expiry-hint-42",
    );
  });

  it("набор с клавиатуры сам по себе на сервер не уходит", async () => {
    show();
    fireEvent.click(value());
    // Каждое изменение текста примитив разбирает и рассказывает наружу. Запись,
    // повешенная на этот рассказ, слала бы PUT на каждый набранный символ — и
    // среди них были бы PUT'ы с половиной даты.
    for (const step of ["0", "01", "01.", "01.0", "01.01", "01.01.2027"]) type(step);

    await settle();
    expect(writes().length).toBe(0);
  });

  it("открытие поля не пишет ничего даже в StrictMode", async () => {
    // Приложение обёрнуто в `React.StrictMode` (`src/main.tsx`), и в dev эффект
    // монтирования вызывается ДВАЖДЫ: примитив дважды подряд рассказывает про
    // одно и то же значение. Запись, повешенная на этот рассказ, давала бы два
    // PUT'а на одно только открытие поля.
    render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <DomainExpiryField domain={domain()} now={NOW} />
        </QueryClientProvider>
      </React.StrictMode>,
    );
    fireEvent.click(value());
    expect(dateInput().value).toBe(STORED_TYPED);

    await settle();
    expect(writes().length).toBe(0);
  });
});

describe("срок домена — три входа в запись", () => {
  it("✓ сохраняет набранную дату, и клик по нему не съедается уходом из поля", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);

    // Клик по кнопке начинается с `blur` поля. Не погасив его, кнопка успела бы
    // закрыть правку раньше, чем клик до неё дойдёт, — поэтому `mousedown`
    // обязан быть отменён, и лечится это только так, а не задержкой, которая
    // «обычно успевает».
    const button = check();
    const down = createEvent.mouseDown(button);
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);

    fireEvent.click(button);
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
    // Запись удалась — правка закрыта, и на месте значения новая дата.
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("Enter сохраняет набранную дату и закрывает поле", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("уход из поля сохраняет набранную дату", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.blur(dateInput());

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
  });

  it("Escape закрывает поле и НЕ пишет", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Escape" });
    await settle();

    expect(writes().length).toBe(0);
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
    // И на экране осталось сохранённое, а не то, от чего человек отказался.
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("пустое поле снимает срок и пишется значением null", async () => {
    show();
    fireEvent.click(value());
    type("");
    // Пустое поле само по себе ещё ничего не значит: ровно так же выглядит
    // недонабранная строка. Записью его делает подтверждение.
    await settle();
    expect(writes().length).toBe(0);
    // И поле осталось пустым: набранное принадлежит ему, а не карточке —
    // иначе оно прыгало бы обратно на прежнюю дату и снять срок было бы нельзя.
    expect(dateInput().value).toBe("");

    fireEvent.blur(dateInput());
    await waitFor(() => expect(writes().length).toBe(1));
    // Пустая строка в `expiry_date` — не «даты нет», а нечитаемая дата.
    expect(writes()[0]).toEqual({ expiry_date: null });
  });

  it("правится и из пустого состояния", async () => {
    show({ expiry_date: null });
    fireEvent.click(value());
    expect(dateInput().value).toBe("");

    type(STORED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: STORED });
  });

  it("уход из пустого поля без правки ничего не пишет", async () => {
    show({ expiry_date: null });
    fireEvent.click(value());
    // Пустое поле уходом из него ПОДТВЕРЖДАЕТ снятие срока — но у домена,
    // который срока и не знал, снимать нечего: «сохранение», ничего не
    // меняющее, стоило бы инвалидации списка доменов и ещё обманывало бы.
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(0);
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("уход из поля без правки ничего не пишет", async () => {
    show();
    fireEvent.click(value());
    // Открыть поле и передумать — не правка. PUT здесь инвалидировал бы список
    // доменов и перерисовал бы полэкрана на простое любопытство.
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(0);
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("возврат к прежней дате поверх незаписанной правки всё равно уходит на сервер", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));

    // Человек передумал и вернул прежнюю дату. В пропсе она же и стоит (рефетч
    // не доехал), но на сервере уже лежит другая — и «эта дата и так стоит»
    // было бы неправдой: сравнивать надо с тем, что человек ВИДИТ.
    fireEvent.click(value());
    type(STORED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });

    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]).toEqual({ expiry_date: STORED });
  });
});

describe("срок домена — непонятная строка на сервер не уходит", () => {
  it("«31.02.2026» краснеет на месте, а не улетает запросом", async () => {
    show();
    fireEvent.click(value());
    // Формат верный, даты в календаре нет. Запрос с такой строкой — это отказ
    // бэкенда через полсекунды вместо ответа на месте и мгновенно.
    type("31.02.2026");
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await settle();

    expect(writes().length).toBe(0);
    expect(parseError()).toBeTruthy();
    // Поле осталось открытым: закрытое, оно размонтировало бы объяснение
    // раньше, чем его успели прочесть.
    expect(dateInput().value).toBe("31.02.2026");
  });

  it("уход из поля с непонятной строкой не пишет и не закрывает правку", async () => {
    show();
    fireEvent.click(value());
    // Короткая, но законченная запись: до полной длины она не дорастает, и
    // объяснить её может только уход из поля.
    type("01.09.26");
    fireEvent.blur(dateInput());
    await settle();

    expect(writes().length).toBe(0);
    expect(parseError()).toBeTruthy();
    expect(dateInput().value).toBe("01.09.26");
  });

  it("клик по ✓ на непонятной строке не съедает объяснение", async () => {
    show();
    fireEvent.click(value());
    type("01.09.26");
    // Показ ошибки у короткой записи держится на `blur`, и ✓, гасящий `blur`
    // всегда, съедал бы объяснение целиком: человек жмёт кнопку и не
    // происходит ровно ничего. Поэтому `mousedown` отменяется только тогда,
    // когда строка разобралась.
    const button = check();
    const down = createEvent.mouseDown(button);
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(false);

    // Дальше браузер делает то, чему ему не помешали.
    fireEvent.blur(dateInput());
    fireEvent.click(button);
    await settle();

    expect(parseError()).toBeTruthy();
    expect(writes().length).toBe(0);
    expect(dateInput()).toBeTruthy();
  });
});

describe("срок домена — что видно, пока запись идёт и когда она провалилась", () => {
  it("пока запись идёт, на месте ✓ стоит «Saving…»", async () => {
    const put = hangingPut();
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Saving…")).toBeTruthy());
    // Кнопки нет ВОВСЕ: нечего нажимать — нечего и задваивать.
    expect(screen.queryByRole("button", { name: "Save expiry date" })).toBeNull();

    await put.resolveWith(domain({ expiry_date: PICKED }));
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("пока запись идёт, второй вход не даёт второго PUT'а", async () => {
    const put = hangingPut();
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));

    // Второй PUT из того же хука — гонка: севший последним ответ решает, что
    // лежит в базе, а на экране нарисован исход первого.
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(1);

    await put.resolveWith(domain({ expiry_date: PICKED }));
  });

  it("после записи на экране стоит записанная дата, а не старая из пропса", async () => {
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });

    // Строка домена в пропсе ещё старая (в проде она догонит после рефетча по
    // инвалидации) — и ровно здесь поле раньше мигало назад на прежнюю дату,
    // то есть выглядело так, будто правка не сохранилась.
    await waitFor(() => expect(value().textContent).toContain(PICKED_TYPED));
    expect(value().textContent).not.toContain(STORED_TYPED);
  });

  it("чужая правка строки домена снимает наложение, а не прячется под ним", async () => {
    const { rerender } = show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(value().textContent).toContain(PICKED_TYPED));

    // Строка домена приехала с ТРЕТЬЕЙ датой — так выглядит любая чужая запись
    // в `expiry_date` (синк регистратора, write-back полной настройки) после
    // инвалидации `domainsKeys.all`. Наложение обязано уйти: дата из
    // законченной правки поверх свежей правды — это старое значение, которое
    // нечем снять до закрытия карточки.
    rerender(
      <QueryClientProvider client={queryClient}>
        <DomainExpiryField domain={domain({ expiry_date: OTHER })} now={NOW} />
      </QueryClientProvider>,
    );
    expect(value().textContent).toContain("01.03.2027");
  });

  it("провал записи называет причину, оставляет набранное и не выдаёт его за сохранённое", async () => {
    mocks.apiPut.mockRejectedValue(new Error("HTTP 422: expiry_date is not a valid date"));

    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not save");
    expect(alert.textContent).toContain("expiry_date is not a valid date");
    // Открытое поле — рабочее место: сервер отверг дату, поправят её здесь же,
    // и стирать набранное значило бы заставить набирать заново.
    expect(dateInput().value).toBe(PICKED_TYPED);

    // А закрытое обязано называть то, что лежит в базе: удержав отвергнутую
    // дату, оно рисовало бы её сохранённой.
    fireEvent.keyDown(dateInput(), { key: "Escape" });
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("после провала записи уход из поля не шлёт ту же дату вторым PUT'ом", async () => {
    mocks.apiPut.mockRejectedValue(new Error("nope"));

    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));
    // Провал уже нарисован: показанным снова стало сохранённое, и рядом причина.
    await screen.findByText(/nope/);

    // Уход из поля с отвергнутой датой — не новая правка, а конец старой.
    // Ретрай, которого никто не просил, ещё и рисовал бы отвергнутую дату
    // принятой.
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(1);
  });

  it("после провала записи повторить попытку можно явным действием", async () => {
    mocks.apiPut.mockRejectedValue(new Error("nope"));

    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await screen.findByText(/nope/);

    // Обратная сторона гарда выше: молчит только уход из поля, а ✓ и Enter
    // по-прежнему пишут — иначе после первого же отказа поле стало бы мёртвым.
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]).toEqual({ expiry_date: PICKED });
  });
});

describe("срок домена — правка, набранная поверх ещё не доехавшей записи", () => {
  /**
   * Поле не выключается на время записи, то есть набирать в него МОЖНО — и
   * значит набранное обязано пережить приезд ответа на прошлый PUT.
   *
   * Безусловное закрытие поля по успеху уносило набранное молча: человек видел
   * на экране дату, которой не набирал, и ни строки о том, куда делась его
   * вторая правка. Показательно, что при ПРОВАЛЕ записи она выживала (поле
   * оставалось открытым) — удачный исход обходился с человеком хуже неудачного.
   */
  it("успех первой записи не уносит вторую правку", async () => {
    const put = hangingPut();
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));

    // Пока PUT в полёте, человек передумал и набрал другую дату.
    type(LATER_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await put.resolveWith(domain({ expiry_date: PICKED }));

    expect(dateInput().value).toBe(LATER_TYPED);
    // И её по-прежнему есть чем сохранить: запись больше не идёт, входы открыты.
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]).toEqual({ expiry_date: LATER });
  });

  it("совпавшая с записанным правка поле всё-таки закрывает", async () => {
    // Обратная половина: условие закрытия — «набранное совпало с записанным», а
    // не «человек ничего не трогал». Иначе поле оставалось бы открытым после
    // каждой удачной записи.
    const put = hangingPut();
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(writes().length).toBe(1));

    await put.resolveWith(domain({ expiry_date: PICKED }));
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
    expect(value().textContent).toContain(PICKED_TYPED);
  });

  it("Escape во время записи не уносит «Saving…»", async () => {
    const put = hangingPut();
    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Saving…")).toBeTruthy());

    // Escape не обещает отменить ушедший PUT — и, закрыв поле, унёс бы
    // единственный знак, что запись идёт: человек нажал «отмена», получил
    // тишину, а через мгновение дата поменялась бы сама.
    fireEvent.keyDown(dateInput(), { key: "Escape" });
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(dateInput()).toBeTruthy();

    await put.resolveWith(domain({ expiry_date: PICKED }));
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });
});

describe("срок домена — отказ не переезжает в следующую правку", () => {
  it("новая правка не подписана отказом по прошлой попытке", async () => {
    mocks.apiPut.mockRejectedValue(new Error("boom"));

    show();
    fireEvent.click(value());
    type(PICKED_TYPED);
    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await screen.findByText(/boom/);

    // Человек отказался от правки — строка отказа под значением остаётся: дата
    // и правда не сохранена.
    fireEvent.keyDown(dateInput(), { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeTruthy();

    // А вот НОВАЯ правка отказом по прошлой попытке не подписывается: поле
    // открывается чистым, иначе красная строка висела бы в шапке бессрочно и
    // объясняла бы состояние, которого уже нет.
    fireEvent.click(value());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dateInput().getAttribute("aria-describedby") ?? "").not.toContain(
      "domain-expiry-error-42",
    );
    // И показано в поле сохранённое, а не отвергнутое: снятие признака отказа
    // не имеет права воскресить наложение, которое этим отказом и снято.
    expect(dateInput().value).toBe(STORED_TYPED);
  });
});
