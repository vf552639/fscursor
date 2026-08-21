import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import DateField from "./DateField";

/**
 * Поле даты, набираемой руками, — замена нативному `<input type="date">`,
 * который в WKWebView десктопа не принимал ввод с клавиатуры вовсе.
 *
 * Тесты сторожат ровно то, ради чего примитив заведён, а не вёрстку.
 *
 * 1. **Набранное принадлежит полю, а не родителю.** Один из двух кандидатов на
 *    причину исходного дефекта — восстановление значения управляемого инпута из
 *    пропса посреди набора. Примитив обязан быть устроен так, чтобы этого не
 *    могло случиться: ISO-проп — семя, а не диктат, и перерисовка родителя с
 *    другой датой набранный текст не трогает.
 * 2. **Наружу уходит РАЗОБРАННОЕ значение, а не событие.** `onParsed(iso|null)`
 *    и `onInvalid(kind)` зовутся на каждое изменение — форме карточки сервера
 *    больше неоткуда узнать, можно ли включать Save.
 * 3. **Пустое поле — не ошибка**, а распоряжение снять дату (`onParsed(null)`).
 * 4. **Вставка из буфера работает** — то самое, чего нативное поле не умело
 *    вовсе; дата из письма регистратора приезжает с пробелами по краям.
 * 5. **Красная строка связана с полем** `aria-describedby`, и на карточке
 *    сервера таких полей ДВА рядом — идентификаторы обязаны различаться.
 */

/**
 * Обе подписи ошибок начинаются с «Expected»: они называют ОЖИДАЕМОЕ, а не
 * обвиняют в конкретной описке (одна и та же `date` прилетает и от «31.02», и
 * от американского «12/25/2026», и от описки в годе). Поэтому и ищем их одним
 * образцом — тест не должен зависеть от точной формулировки, но обязан падать,
 * если строка не появилась вовсе.
 */
const anyError = () => screen.queryByText(/^Expected/);

const field = () => screen.getByRole("textbox") as HTMLInputElement;

function show(props: Partial<React.ComponentProps<typeof DateField>> = {}) {
  const onParsed = vi.fn();
  const onInvalid = vi.fn();
  const view = render(<DateField onParsed={onParsed} onInvalid={onInvalid} {...props} />);
  return { onParsed, onInvalid, ...view };
}

/** Набор с клавиатуры: браузер отдаёт `change` на каждый символ. */
function type(input: HTMLInputElement, text: string) {
  for (let i = 1; i <= text.length; i++) {
    fireEvent.change(input, { target: { value: text.slice(0, i) } });
  }
}

describe("DateField", () => {
  afterEach(cleanup);

  it("это ТЕКСТОВОЕ поле с обещанной формой в плейсхолдере, а не нативный date", () => {
    show();
    const input = field();
    // Ради этой строки всё и затевалось: `type="date"` из проекта уходит совсем.
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("DD.MM.YYYY");
    // Форма обещана плейсхолдером — и ровно она принимается разбором.
    expect(input.inputMode).toBe("numeric");
  });

  it("ISO-проп печатается в поле по-человечески", () => {
    show({ defaultValue: "2026-09-01" });
    expect(field().value).toBe("01.09.2026");
  });

  it("значения нет — поле пустое и молчит", () => {
    const { onParsed, onInvalid } = show({ defaultValue: null });
    expect(field().value).toBe("");
    expect(anyError()).toBeNull();
    // Ни одного вызова на монтировании: родитель и так знает, чем засеял поле,
    // а лишний `onParsed` на старте формы означал бы «значение поменялось».
    expect(onParsed).not.toHaveBeenCalled();
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("нечитаемое семя — пустое поле, а не прочерк «—»", () => {
    // `formatExpiryDate` отвечает на незнание прочерком (он для ПОКАЗА), и
    // засеянный им инпут предлагал бы человеку править знак «значения нет».
    show({ defaultValue: "не-дата" });
    expect(field().value).toBe("");
  });

  it("набранная дата уходит наружу разобранной, без красной строки", () => {
    const { onParsed, onInvalid } = show();
    type(field(), "01.09.2026");

    expect(onParsed).toHaveBeenLastCalledWith("2026-09-01");
    expect(anyError()).toBeNull();
    // Незаконченный набор — тоже состояние, и о нём потребитель узнаёт сразу:
    // «01», «01.», «01.0» … читаться не могут, и Save на форме обязан быть
    // выключен всё это время.
    expect(onInvalid).toHaveBeenCalled();
  });

  it("незаконченный набор краснеет, дописанный — перестаёт", () => {
    const { onInvalid } = show();
    const input = field();

    fireEvent.change(input, { target: { value: "01.09.20" } });
    expect(onInvalid).toHaveBeenLastCalledWith("format");
    expect(anyError()).not.toBeNull();

    fireEvent.change(input, { target: { value: "01.09.2026" } });
    // Строка обязана УХОДИТЬ: красное, пережившее починку, учит его не читать.
    expect(anyError()).toBeNull();
  });

  it("несуществующая дата и американский порядок — одна ошибка `date`, и подпись не обвиняет в описке", () => {
    const { onInvalid } = show();
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    expect(onInvalid).toHaveBeenLastCalledWith("date");
    const shown = anyError();
    expect(shown).not.toBeNull();

    // Тот же ответ на `12/25/2026`: по-американски это Рождество, у нас —
    // 25-й месяц. Подпись обязана назвать ПОРЯДОК (день первым), иначе человек
    // пойдёт искать ошибку в числе, где её нет.
    fireEvent.change(input, { target: { value: "12/25/2026" } });
    expect(onInvalid).toHaveBeenLastCalledWith("date");
    expect(anyError()?.textContent).toMatch(/day first/i);
  });

  it("двузначный год — это `format`, и подпись зовёт дописать век", () => {
    const { onInvalid } = show();
    fireEvent.change(field(), { target: { value: "01.09.26" } });
    expect(onInvalid).toHaveBeenLastCalledWith("format");
    expect(anyError()?.textContent).toMatch(/four digits/i);
  });

  it("опустошённое поле — это «снять значение», а не ошибка", () => {
    const { onParsed, onInvalid } = show({ defaultValue: "2026-09-01" });
    const input = field();

    fireEvent.change(input, { target: { value: "" } });

    expect(onParsed).toHaveBeenLastCalledWith(null);
    expect(onInvalid).not.toHaveBeenCalled();
    // Единственный способ стереть однажды записанную дату не должен выглядеть
    // как ошибка — иначе стирать её человек побоится.
    expect(anyError()).toBeNull();
  });

  it("вставка из буфера с пробелами по краям читается", () => {
    const { onParsed } = show();
    // ⌘V — одно событие с целой строкой, и в дате из письма регистратора по
    // краям чаще есть пробел, чем нет. Длина такой строки — 12 символов, и
    // именно поэтому у поля НЕТ `maxLength={10}` (см. комментарий в примитиве).
    fireEvent.change(field(), { target: { value: " 01.09.2026 " } });
    expect(onParsed).toHaveBeenLastCalledWith("2026-09-01");
    expect(anyError()).toBeNull();
  });

  it("родитель НЕ может затереть набранное перерисовкой", () => {
    const { rerender, onParsed } = show({ defaultValue: "2026-09-01" });
    const input = field();

    fireEvent.change(input, { target: { value: "15.10" } });
    // Перерисовка с ДРУГОЙ датой посреди набора — ровно то, что происходило,
    // когда значение поля диктовал пропс: строка прыгала обратно, и дособрать
    // дату было нельзя.
    rerender(<DateField defaultValue="2027-03-01" onParsed={onParsed} onInvalid={() => {}} />);

    expect(field().value).toBe("15.10");
  });

  it("красная строка связана с полем, и связь снимается вместе с ошибкой", () => {
    show();
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    const shown = anyError()!;
    expect(shown.id).toBeTruthy();
    expect((input.getAttribute("aria-describedby") ?? "").split(" ")).toContain(shown.id);

    fireEvent.change(input, { target: { value: "01.02.2026" } });
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("двух полей рядом хватает на два разных идентификатора", () => {
    // Ровно случай карточки сервера: Purchase Date и Expiry Date стоят
    // вплотную. Статический id связал бы оба поля с первой строкой ошибки.
    render(
      <>
        <DateField aria-label="Purchase date" onParsed={() => {}} onInvalid={() => {}} />
        <DateField aria-label="Expiry date" onParsed={() => {}} onInvalid={() => {}} />
      </>,
    );
    const purchase = screen.getByRole("textbox", { name: "Purchase date" });
    const expiry = screen.getByRole("textbox", { name: "Expiry date" });

    fireEvent.change(purchase, { target: { value: "31.02.2026" } });
    fireEvent.change(expiry, { target: { value: "31.04.2026" } });

    const [first, second] = screen.getAllByText(/^Expected/);
    expect(first.id).not.toBe(second.id);
    expect(purchase.getAttribute("aria-describedby")).toBe(first.id);
    expect(expiry.getAttribute("aria-describedby")).toBe(second.id);
  });

  it("чужой aria-describedby не теряется — ошибка разбора ДОПИСЫВАЕТСЯ к нему", () => {
    // Ошибка ЗАПИСИ приезжает с сервера и рисуется потребителем (карточка
    // домена), а описывают поле обе разом. Затри примитив чужой id — и причина
    // отказа сервера перестанет читаться вслух.
    show({ "aria-describedby": "save-error" } as any);
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("save-error");
    expect(ids).toContain(anyError()!.id);

    fireEvent.change(input, { target: { value: "01.02.2026" } });
    expect(input.getAttribute("aria-describedby")).toBe("save-error");
  });

  it("клавиатура и уход из поля достаются потребителю нетронутыми", () => {
    // На этом держится вся Фаза 3: карточка домена пишет срок по Enter и по
    // `blur`, а Escape отменяет правку. Свои обработчики примитива их не
    // перехватывают — своих у него на этих событиях нет вовсе.
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    show({ onKeyDown, onBlur, autoFocus: true, "aria-label": "Expiry date" } as any);

    const input = screen.getByRole("textbox", { name: "Expiry date" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("место вызова доназначает геометрию через style", () => {
    // Потребителя два и они разного размера: поле формы на карточке сервера и
    // компактный инлайн в мета-ряду шапки карточки домена.
    show({ style: { fontSize: 13, padding: "3px 8px" } });
    expect(field().style.padding).toBe("3px 8px");
  });
});
