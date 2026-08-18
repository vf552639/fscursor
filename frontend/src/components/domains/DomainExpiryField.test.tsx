import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import DomainExpiryField from "./DomainExpiryField";
import { queryClient } from "../../api/queryClient";

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

  it("пустой инпут снимает срок значением null, а не пустой строкой", async () => {
    show();
    fireEvent.click(value());
    fireEvent.change(dateInput(), { target: { value: "" } });

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

  it("та же дата не пишется вовсе", () => {
    show();
    fireEvent.click(value());
    // Пустой PUT инвалидировал бы список доменов и перерисовал бы полэкрана ни
    // за чем — а «сохранение», ничего не меняющее, ещё и обманывает.
    fireEvent.change(dateInput(), { target: { value: STORED } });
    expect(writes().length).toBe(0);
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
