import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { Modal } from "./Primitives";

/**
 * Проверяется один проп — `header`, — и ровно то, что он обещает: без него
 * шапка прежняя, с ним её нет вовсе.
 *
 * Цена ошибки здесь выше обычной вёрстки. Штатная строка — единственное место,
 * где живёт крестик, а часть модалок продукта закрывается ТОЛЬКО им
 * (`closeOnBackdrop={false}` у тех, чей `onClose` уничтожает единственную копию
 * показанного пароля). Подмени шапку пустотой — и такая модалка станет
 * незакрываемой; отсюда третий случай про ложный `ReactNode`.
 */

describe("Modal header", () => {
  afterEach(cleanup);

  it("без header — штатная строка «title + ✕», крестик закрывает", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Unlock" onClose={onClose}>
        <div>body</div>
      </Modal>,
    );

    expect(screen.getByText("Unlock")).toBeTruthy();

    const close = screen.getByRole("button", { name: "✕" });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("с header штатной строки нет вовсе — ни заголовка, ни крестика", () => {
    render(
      <Modal
        title="Unlock"
        onClose={() => {}}
        header={<div>Domain: example.com</div>}
      >
        <div>body</div>
      </Modal>,
    );

    expect(screen.getByText("Domain: example.com")).toBeTruthy();
    // Именно замена, а не добавление: иначе на карточке домена стояли бы два
    // заголовка и два крестика подряд.
    expect(screen.queryByText("Unlock")).toBeNull();
    expect(screen.queryByRole("button", { name: "✕" })).toBeNull();
    // Содержимое модалки от подмены шапки не зависит.
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("ложный header (`cond && <Header/>`) откатывает к штатной строке", () => {
    // Самая вероятная форма вызова — `header={ready && <Header/>}`, и при
    // ложном условии это `false`. На `??` он считался бы шапкой (проп ведь не
    // `undefined`), и модалка осталась бы без крестика — а с
    // `closeOnBackdrop={false}` и вовсе без выхода.
    const onClose = vi.fn();
    render(
      <Modal title="Unlock" onClose={onClose} closeOnBackdrop={false} header={false && <div>never</div>}>
        <div>body</div>
      </Modal>,
    );

    expect(screen.getByText("Unlock")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
