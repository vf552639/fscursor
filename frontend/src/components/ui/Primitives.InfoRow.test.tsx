import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { InfoRow } from "./Primitives";

/**
 * `InfoRow` — примитив строки «подпись → значение» карточек вроде Server
 * Information. Проверяем только сам примитив, а не его потребителя (строки
 * Name/IP/Provider/OS на `ServerDetail` — у них свои тесты в
 * `ServerDetail.inforow.test.tsx`): без `onEdit` карандаша нет и разметка не
 * меняется, с `onEdit` — ровно одна кнопка с осмысленным доступным именем, и
 * клик по ней зовёт переданный колбэк, не трогая значение строки.
 */

describe("InfoRow", () => {
  afterEach(cleanup);

  it("без onEdit кнопки в строке нет", () => {
    render(<InfoRow k="Name" v="server-1" />);
    expect(screen.getByText("server-1")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("с onEdit — ровно одна кнопка с осмысленным доступным именем, клик зовёт колбэк", () => {
    const onEdit = vi.fn();
    render(<InfoRow k="Name" v="server-1" onEdit={onEdit} />);

    // Доступное имя берётся из подписи строки (`k`), а не голый глиф «✎» —
    // иначе кнопку не отличить от любой другой на экране ни скринридером, ни
    // курсором (тот же довод, что у карандаша в шапке страницы).
    const btn = screen.getByRole("button", { name: "Edit Name" });
    expect(screen.getAllByRole("button")).toHaveLength(1);

    fireEvent.click(btn);
    expect(onEdit).toHaveBeenCalledTimes(1);

    // Значение строки нарисовано как прежде, карандаш ничего в нём не заменил.
    expect(screen.getByText("server-1")).toBeTruthy();
  });

  it("editLabel переопределяет подпись из k — пригодится, когда k не строка (JSX)", () => {
    const onEdit = vi.fn();
    render(
      <InfoRow
        k={<span>OS</span>}
        v="Ubuntu 22.04"
        onEdit={onEdit}
        editLabel="operating system"
      />,
    );
    expect(screen.getByRole("button", { name: "Edit operating system" })).toBeTruthy();
  });

  it("k не строка и editLabel нет — кнопка всё равно с именем, не голый глиф", () => {
    // Тип `k` в файле остаётся `any`, и без этого случая ветка фолбэка
    // (`label ? ... : "Edit"`) ничем не покрыта: подмени `"Edit"` на `""` —
    // и все остальные тесты файла останутся зелёными, а кнопка при этом
    // лишится имени вовсе — ровно дефект, ради которого затевался `RowActions`.
    render(<InfoRow k={<span>OS</span>} v="Ubuntu 22.04" onEdit={() => {}} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});
