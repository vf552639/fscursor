import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainExpiryField from "./DomainExpiryField";
import { queryClient } from "../../api/queryClient";
import { tokens } from "../../lib/designTokens";
import { expiryTextColor } from "../../lib/domainExpiry";
import { hexToRgb, luminanceOfRgb, relativeLuminance } from "../../test/colors";

/**
 * Срок домена в шапке карточки — и правка его на месте.
 *
 * Два правила, ради которых тут вообще есть тесты.
 *
 * 1. **Незнание названо словом.** У домена без срока поле не пустое и не
 *    прочерк, а приглашение «set date»: править его надо оттуда же, где видно,
 *    что править нечего.
 * 2. **Пока запись идёт, на экране стоит ВЫБРАННОЕ.** Своей строки домена у
 *    карточки нет — она приезжает пропсом и обновляется только после рефетча по
 *    инвалидации. Без памяти о выборе поле возвращалось бы к старой дате сразу
 *    после клика, и это читалось бы как «правку потеряли». А вот провал записи,
 *    наоборот, обязан вернуть сохранённое: держать на экране дату, которой
 *    сервер не принял, — то же враньё, только наоборот.
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
/** Срок такой даты — конец дня, поэтому от 18-го полудня до неё 14 полных суток. */
const STORED_LABEL = "01.09.2026 · in 14 days";
const PICKED = "2027-01-01";
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
  return screen.getByRole("button", { name: /Expiry date/ });
}

/** Значение в состоянии правки: инпут даты. */
function dateInput() {
  return screen.getByLabelText("Expiry date") as HTMLInputElement;
}

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

describe("срок домена — правка на месте", () => {
  it("клик по значению открывает инпут даты, уже стоящий в сохранённом сроке", () => {
    show();
    fireEvent.click(value());

    const input = dateInput();
    expect(input.type).toBe("date");
    // `expiry_date` и `<input type="date">` говорят на одном языке (`YYYY-MM-DD`)
    // в обе стороны — никаких переводов формата между ними нет и быть не должно.
    expect(input.value).toBe(STORED);
    // Фокус сразу в поле: иначе после клика надо кликать второй раз.
    expect(document.activeElement).toBe(input);
  });

  it("выбор даты уходит в строку домена ровно одним полем", async () => {
    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
  });

  it("снятие срока подтверждается уходом из поля и пишется значением null", async () => {
    show();
    fireEvent.click(value());
    // Пустое поле само по себе ещё ничего не значит: ровно так же выглядит
    // недонабранная с клавиатуры дата.
    fireEvent.change(dateInput(), { target: { value: "" } });
    await settle();
    expect(writes().length).toBe(0);
    // И поле осталось пустым: привязанное к показанному значению, оно прыгало
    // бы обратно на прежнюю дату (React восстанавливает управляемый инпут после
    // события, не изменившего состояние) — и снять срок было бы нельзя вовсе.
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

    fireEvent.change(dateInput(), { target: { value: STORED } });
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
  });

  it("уход из поля без правки ничего не пишет", async () => {
    show();
    fireEvent.click(value());
    // Открыть поле и передумать — не правка. PUT здесь инвалидировал бы список
    // доменов и перерисовал бы полэкрана на простое любопытство, а
    // «сохранение», ничего не меняющее, ещё и обманывает.
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(0);
  });

  it("незавершённый набор с клавиатуры срок не снимает", async () => {
    show();
    fireEvent.click(value());
    // Нативный `<input type="date">` отдаёт `""` за любой незаконченный набор:
    // стирая сегмент даты, человек шлёт сюда «срока нет» посреди правки.
    // Записанное, оно снимало бы срок без вопросов, а вторым PUT'ом вдогонку
    // давало бы гонку двух записей из одного хука — севший последним `null`
    // оставлял бы базу пустой под уверенно нарисованной новой датой.
    fireEvent.change(dateInput(), { target: { value: "" } });
    fireEvent.change(dateInput(), { target: { value: PICKED } });

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()).toEqual([{ expiry_date: PICKED }]);
  });

  it("выбор в пикере пишется один раз, а не дважды с уходом из поля", async () => {
    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    await waitFor(() => expect(writes().length).toBe(1));

    // `blur` записывает ровно один случай — пустое поле, а здесь оно не пустое.
    fireEvent.blur(dateInput());
    await settle();
    expect(writes().length).toBe(1);
  });

  it("возврат к прежней дате поверх незаписанной правки всё равно уходит на сервер", async () => {
    let finish: ((row: any) => void) | null = null;
    mocks.apiPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    await waitFor(() => expect(writes().length).toBe(1));

    // Человек передумал и вернул прежнюю дату. В пропсе она же и стоит (рефетч
    // не доехал), но на сервере уже лежит другая — и «эта дата и так стоит»
    // было бы неправдой: сравнивать надо с тем, что человек ВИДИТ.
    fireEvent.change(dateInput(), { target: { value: STORED } });
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]).toEqual({ expiry_date: STORED });

    await act(async () => {
      finish?.(domain({ expiry_date: STORED }));
    });
  });

  it("blur закрывает правку", () => {
    show();
    fireEvent.click(value());
    fireEvent.blur(dateInput());

    expect(screen.queryByLabelText("Expiry date")).toBeNull();
    expect(value().textContent).toBe(STORED_LABEL);
  });
});

/**
 * Запасные входы в запись — и почему без них поле не сохраняло ничего.
 *
 * Единственным входом было событие `change` нативного `<input type="date">`.
 * Двенадцать тестов выше дёргают его НАПРЯМУЮ (`fireEvent.change`), то есть
 * проверяют путь, который в WebKit не срабатывает: выбор даты в системном
 * пикере доезжает туда не всегда, и живьём дефект выглядел так — поле
 * схлопывается, снова показывает «set date», красной строки нет. Красной
 * строки нет потому, что записи не было ВОВСЕ: `commit` не звался ни разу.
 *
 * Отсюда форма проверок ниже: событие `change` в них НЕ посылается. Это не
 * стилистика — это и есть модель отказа, и тест, начинающийся с `change`,
 * зеленел бы на сломанном поле.
 */
describe("срок домена — правка сохраняется и без события change", () => {
  it("уход из поля пишет выбранную дату — точная модель отказа в WebKit", async () => {
    show();
    fireEvent.click(value());

    // `change` не посылается намеренно: в WebKit его и не было. Значение
    // приезжает вместе с `blur` — ровно так, как его отдаёт живой инпут, у
    // которого дату выбрали в системном пикере.
    fireEvent.blur(dateInput(), { target: { value: PICKED } });

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
  });

  it("Enter пишет дату и закрывает поле", async () => {
    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    // Запись уже ушла по `change`; Enter обязан не задвоить её, а закрыть поле.
    await waitFor(() => expect(writes().length).toBe(1));

    fireEvent.keyDown(dateInput(), { key: "Enter" });
    await settle();

    expect(writes().length).toBe(1);
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("Enter — самостоятельный вход в запись, а не только закрытие", async () => {
    show();
    fireEvent.click(value());
    // Опять без `change`: человек набрал дату с клавиатуры и нажал Enter, а
    // событие изменения до нас не доехало.
    const input = dateInput();
    input.value = PICKED;
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ expiry_date: PICKED });
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
  });

  it("Escape закрывает поле и НЕ пишет", async () => {
    show();
    fireEvent.click(value());
    const input = dateInput();
    input.value = PICKED;
    fireEvent.keyDown(input, { key: "Escape" });
    await settle();

    expect(writes().length).toBe(0);
    expect(screen.queryByLabelText("Expiry date")).toBeNull();
    // И на экране осталось сохранённое, а не то, от чего человек отказался.
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("после провала записи уход из поля не шлёт ту же дату вторым PUT'ом", async () => {
    mocks.apiPut.mockRejectedValue(new Error("nope"));

    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    await waitFor(() => expect(writes().length).toBe(1));
    // Провал уже нарисован: показанным снова стало сохранённое, и рядом причина.
    await screen.findByText(/nope/);

    // Уход из поля с отвергнутой датой — не новая правка, а конец старой.
    // Ретрай, которого никто не просил, ещё и рисовал бы отвергнутую дату
    // принятой; повторить попытку по-прежнему можно явным действием.
    fireEvent.blur(dateInput(), { target: { value: PICKED } });
    await settle();
    expect(writes().length).toBe(1);
  });
});

describe("срок домена — что видно, пока запись идёт и когда она провалилась", () => {
  it("пока запись идёт, на экране стоит выбранная дата, а не сохранённая", async () => {
    let finish: ((row: any) => void) | null = null;
    mocks.apiPut.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    fireEvent.blur(dateInput());

    // Строка домена в пропсе ещё старая (в проде она догонит после рефетча по
    // инвалидации) — и ровно здесь поле раньше мигало назад на прежнюю дату,
    // то есть выглядело так, будто выбор не сохранился.
    await waitFor(() => expect(value().textContent).toContain("01.01.2027"));
    expect(value().textContent).not.toContain("01.09.2026");

    await act(async () => {
      finish?.(domain({ expiry_date: PICKED }));
    });
    // И после ответа сервера — тоже: пропс всё ещё старый, а правда уже новая.
    expect(value().textContent).toContain("01.01.2027");
  });

  it("провал записи не стирает набранное, но и не выдаёт его за сохранённое", async () => {
    mocks.apiPut.mockRejectedValue(new Error("HTTP 422: expiry_date is not a valid date"));

    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });

    await screen.findByRole("alert");
    // Открытое поле — рабочее место: сервер отверг дату, поправят её здесь же,
    // и стирать набранное значило бы заставить набирать заново.
    expect(dateInput().value).toBe(PICKED);

    // А закрытое обязано называть то, что лежит в базе: удержав отвергнутую
    // дату, оно рисовало бы её сохранённой.
    fireEvent.blur(dateInput());
    expect(value().textContent).toBe(STORED_LABEL);
  });

  it("чужая правка строки домена снимает наложение, а не прячется под ним", async () => {
    const { rerender } = show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    await waitFor(() => expect(writes().length).toBe(1));
    fireEvent.blur(dateInput());
    expect(value().textContent).toContain("01.01.2027");

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

  it("провал записи возвращает сохранённую дату и называет причину", async () => {
    mocks.apiPut.mockRejectedValue(new Error("HTTP 422: expiry_date is not a valid date"));

    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: PICKED } });
    fireEvent.blur(dateInput());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not save");
    expect(alert.textContent).toContain("expiry_date is not a valid date");
    // Главное: поле перестало утверждать новую дату. Оставшись в ней, оно
    // рисовало бы сохранённым то, что сервер отверг.
    expect(value().textContent).toBe(STORED_LABEL);
  });
});
