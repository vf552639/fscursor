import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import DateField, { DateFieldProps } from "./DateField";

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
 *    другой датой набранный текст не трогает. Отсюда же и сторож на спред
 *    пропсов: `type="date"`, вернувшийся через `{...props}`, отменил бы весь
 *    план разом.
 * 2. **Наружу уходит РАЗОБРАННОЕ значение, а не событие.** `onParsed(iso|null)`
 *    и `onParseError(kind)` зовутся с монтирования и на каждое изменение —
 *    форме карточки сервера больше неоткуда узнать, можно ли включать Save, а
 *    карточке домена — что писать по Enter.
 * 3. **Сказать наружу и показать человеку — разные моменты.** Красная строка
 *    ждёт конца набора (полная длина либо уход из поля): загоревшись на первом
 *    символе, она весь набор толкала бы соседнюю кнопку ✓ под пальцами.
 * 4. **Пустое поле — не ошибка**, а распоряжение снять дату (`onParsed(null)`).
 * 5. **Вставка из буфера работает** — то самое, чего нативное поле не умело
 *    вовсе; дата из письма регистратора приезжает с пробелами по краям.
 * 6. **Красная строка связана с полем** `aria-describedby` и дописывается к
 *    чужому описанию; на карточке сервера таких полей ДВА рядом.
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

function show(props: Partial<DateFieldProps> = {}) {
  const onParsed = vi.fn();
  const onParseError = vi.fn();
  const view = render(<DateField {...({ onParsed, onParseError, ...props } as DateFieldProps)} />);
  return { onParsed, onParseError, ...view };
}

/**
 * Набор с клавиатуры: браузер отдаёт `change` на каждый символ, и промежуточные
 * состояния поля — это ровно то, что видит человек. Целой строкой (как делает
 * ⌘V) шлём отдельно и там, где проверяем именно вставку.
 */
function type(input: HTMLInputElement, steps: string[]) {
  for (const step of steps) fireEvent.change(input, { target: { value: step } });
}

/** Посимвольные состояния поля при наборе строки слева направо. */
const keystrokes = (text: string) =>
  Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));

describe("DateField", () => {
  afterEach(cleanup);

  it("это ТЕКСТОВОЕ поле с обещанной формой в плейсхолдере, а не нативный date", () => {
    show();
    const input = field();
    // Ради этой строки всё и затевалось: `type="date"` из проекта уходит совсем.
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("DD.MM.YYYY");
    expect(input.inputMode).toBe("numeric");
    // `maxLength` нет намеренно: он режет вставку даты с пробелами по краям
    // (см. комментарий в примитиве). Сторож — чтобы его не «вернули как забытый».
    expect(input.getAttribute("maxLength")).toBeNull();
  });

  it("ISO-проп печатается в поле по-человечески и сразу называется наружу", () => {
    const { onParsed, onParseError } = show({ defaultValue: "2026-09-01" });
    expect(field().value).toBe("01.09.2026");
    // Потребитель узнаёт состояние поля с монтирования, не дожидаясь правки:
    // иначе и форме сервера, и карточке домена пришлось бы разбирать семя самим.
    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(onParsed).toHaveBeenCalledWith("2026-09-01");
    expect(onParseError).not.toHaveBeenCalled();
  });

  it("значения нет — поле пустое, и наружу это сказано как «значения нет»", () => {
    const { onParsed, onParseError } = show({ defaultValue: null });
    expect(field().value).toBe("");
    expect(anyError()).toBeNull();
    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(onParsed).toHaveBeenCalledWith(null);
    expect(onParseError).not.toHaveBeenCalled();
  });

  it("нечитаемое семя — пустое поле, но НЕ молчание", () => {
    // `formatExpiryDate` отвечает на незнание прочерком (он для ПОКАЗА), и
    // засеянный им инпут предлагал бы человеку править знак «значения нет».
    // Промолчи поле при этом — родитель остался бы с нечитаемой датой в руках,
    // считая её сохраняемой: незнание, нарисованное благополучием.
    const { onParsed, onParseError } = show({ defaultValue: "2026-13-45" });
    expect(field().value).toBe("");
    expect(onParseError).toHaveBeenCalledWith("date");
    expect(onParsed).not.toHaveBeenCalled();
    // Ругаться на поле, которого человек ещё не касался, при этом не за что.
    expect(anyError()).toBeNull();
  });

  it("набор не краснеет посреди себя, но каждый его шаг слышен наружу", () => {
    const { onParsed, onParseError } = show();
    const input = field();

    for (const step of keystrokes("01.09.2026")) {
      fireEvent.change(input, { target: { value: step } });
      // Незаконченная строка — не ошибка человека, а середина его действия.
      // Красное здесь толкало бы соседнюю кнопку ✓ весь набор.
      if (step.length < 10) expect(anyError()).toBeNull();
    }

    expect(onParsed).toHaveBeenLastCalledWith("2026-09-01");
    expect(anyError()).toBeNull();
    // Девять незаконченных шагов — девять вызовов: Save на форме обязан быть
    // выключен всё это время, и узнать об этом ей больше неоткуда.
    expect(onParseError).toHaveBeenCalledTimes(9);
  });

  it("дописанная до конца ошибка краснеет, починенная — гаснет", () => {
    const { onParseError } = show();
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    expect(onParseError).toHaveBeenLastCalledWith("date");
    expect(anyError()).not.toBeNull();

    fireEvent.change(input, { target: { value: "01.02.2026" } });
    // Красное, пережившее починку, учит себя не читать.
    expect(anyError()).toBeNull();
  });

  it("короткая, но законченная запись краснеет по уходу из поля", () => {
    // `01.09.26` до полной длины не дорастает никогда, и без второго момента
    // («человек ушёл») объяснение не показалось бы вовсе.
    const onBlur = vi.fn();
    const { onParseError } = show({ onBlur });
    const input = field();

    type(input, keystrokes("01.09.26"));
    expect(onParseError).toHaveBeenLastCalledWith("format");
    expect(anyError()).toBeNull();

    fireEvent.blur(input);
    expect(anyError()?.textContent).toMatch(/four digits/i);
    // Свой обработчик поля чужого не съел: на `blur` у карточки домена висит
    // запись срока.
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("показанная ошибка держится, пока строку правят, и уходит с починкой", () => {
    show();
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    expect(anyError()).not.toBeNull();

    // Правка в середине: человек стёр «1» в дне. Строка стала короче полной, но
    // объяснение, однажды прочитанное, гаснуть от этого не должно — иначе оно
    // мигало бы на каждый символ.
    fireEvent.change(input, { target: { value: "3.02.2026" } });
    expect(anyError()).not.toBeNull();

    fireEvent.change(input, { target: { value: "03.02.2026" } });
    expect(anyError()).toBeNull();
  });

  it("американский порядок — та же ошибка `date`, и подпись зовёт проверить порядок", () => {
    const { onParseError } = show();
    const input = field();

    // По-американски `12/25/2026` — Рождество, у нас — 25-й месяц. Подпись
    // обязана назвать ПОРЯДОК (день первым), иначе человек пойдёт искать ошибку
    // в числе, где её нет.
    fireEvent.change(input, { target: { value: "12/25/2026" } });
    expect(onParseError).toHaveBeenLastCalledWith("date");
    expect(anyError()?.textContent).toMatch(/day first/i);
  });

  it("опустошённое поле — это «снять значение», а не ошибка", () => {
    const { onParsed, onParseError } = show({ defaultValue: "2026-09-01" });
    const input = field();

    fireEvent.change(input, { target: { value: "" } });

    expect(onParsed).toHaveBeenLastCalledWith(null);
    expect(onParseError).not.toHaveBeenCalled();
    // Единственный способ стереть однажды записанную дату не должен выглядеть
    // как ошибка — иначе стирать её человек побоится.
    expect(anyError()).toBeNull();
  });

  it("вставка из буфера с пробелами по краям читается", () => {
    const { onParsed } = show();
    // ⌘V — одно событие с целой строкой, и в дате из письма регистратора по
    // краям чаще есть пробел, чем нет. Длина такой строки — 12 символов, и
    // именно поэтому у поля НЕТ `maxLength={10}`.
    fireEvent.change(field(), { target: { value: " 01.09.2026 " } });
    expect(onParsed).toHaveBeenLastCalledWith("2026-09-01");
    expect(anyError()).toBeNull();
  });

  it("родитель НЕ может затереть набранное перерисовкой", () => {
    const { rerender, onParsed, onParseError } = show({ defaultValue: "2026-09-01" });
    const input = field();

    fireEvent.change(input, { target: { value: "15.10" } });
    // Перерисовка с ДРУГОЙ датой посреди набора — ровно то, что происходило,
    // когда значение поля диктовал пропс: строка прыгала обратно, и дособрать
    // дату было нельзя. Сторожит заодно и эффект монтирования: следи он за
    // `defaultValue`, дефект вернулся бы через него.
    rerender(
      <DateField defaultValue="2027-03-01" onParsed={onParsed} onParseError={onParseError} />,
    );

    expect(field().value).toBe("15.10");
  });

  it("спред пропсов не отбирает у поля ни тип, ни разбор", () => {
    // TS ловит только ПРЯМОЙ запрещённый атрибут; спред переменной он
    // пропускает молча — а в `pages/ServerDetail.tsx` (`domain: any`) спред
    // пропсов бытовая норма. Порядок атрибутов в примитиве — единственное, что
    // мешает `type="date"` вернуться этим путём.
    const onParsed = vi.fn();
    const spread = { type: "date" as const, value: "2000-01-01", onChange: () => {} };
    render(
      <DateField {...(spread as any)} onParsed={onParsed} onParseError={() => {}} />,
    );

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "01.09.2026" } });
    expect(onParsed).toHaveBeenLastCalledWith("2026-09-01");
  });

  it("красная строка связана с полем, и связь снимается вместе с ошибкой", () => {
    show();
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    const shown = anyError()!;
    // Id собран из `useId` и внятного суффикса через разделитель: без него
    // выходит склейка `:r1:error`, в которой не видно границы частей.
    expect(shown.id).toMatch(/-error$/);
    expect((input.getAttribute("aria-describedby") ?? "").split(" ")).toContain(shown.id);

    fireEvent.change(input, { target: { value: "01.02.2026" } });
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("ошибка разбора не кричит: это не `role=\"alert\"`", () => {
    // Соседние строки отказа кричат намеренно — они приезжают с сервера редко и
    // асинхронно. Эта живёт правкой поля, и объявленная вслух перебивала бы
    // набор. Решение закреплено тестом, чтобы `role` не дописали «за компанию».
    show();
    fireEvent.change(field(), { target: { value: "31.02.2026" } });
    expect(anyError()).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("двух полей рядом хватает на два разных идентификатора", () => {
    // Ровно случай карточки сервера: Purchase Date и Expiry Date стоят
    // вплотную. Статический id связал бы оба поля с первой строкой ошибки.
    render(
      <>
        <DateField aria-label="Purchase date" onParsed={() => {}} onParseError={() => {}} />
        <DateField aria-label="Expiry date" onParsed={() => {}} onParseError={() => {}} />
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
    show({ "aria-describedby": "save-error" });
    const input = field();

    fireEvent.change(input, { target: { value: "31.02.2026" } });
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("save-error");
    expect(ids).toContain(anyError()!.id);

    fireEvent.change(input, { target: { value: "01.02.2026" } });
    expect(input.getAttribute("aria-describedby")).toBe("save-error");
  });

  it("клавиатура и фокус достаются потребителю нетронутыми", () => {
    // На этом держится вся Фаза 3: карточка домена пишет срок по Enter и по
    // `blur`, а Escape отменяет правку.
    const onKeyDown = vi.fn();
    show({ onKeyDown, autoFocus: true, "aria-label": "Expiry date" });

    const input = screen.getByRole("textbox", { name: "Expiry date" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("место вызова доназначает геометрию через style", () => {
    // Потребителя два и они разного размера: поле формы на карточке сервера и
    // компактный инлайн в мета-ряду шапки карточки домена. Ширины в дефолте
    // нет — в мета-ряду `width:100%` разрешается плохо, и форма дописывает его
    // себе сама.
    show({ style: { fontSize: 13, padding: "3px 8px" } });
    const input = field();
    expect(input.style.padding).toBe("3px 8px");
    expect(input.style.width).toBe("");
  });
});
