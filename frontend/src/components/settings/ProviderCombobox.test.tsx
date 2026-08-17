import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ProviderCombobox } from "./ProviderCombobox";

/**
 * Селектор провайдера: список = API-каталог ∪ ранее использованные, плюс
 * возможность завести своего вводом имени. Тесты проверяют поведение поля,
 * а не разметку: что уходит наружу в `onChange` и что видно пользователю.
 *
 * `cleanup` вручную, потому что в `vite.config.ts` у vitest нет `globals: true`
 * — авто-очистка Testing Library не регистрируется, и без этого второй `render`
 * оставлял бы на экране первый (getByText падал бы на «found multiple»).
 */

afterEach(cleanup);

function Harness({
  accounts = [] as { provider: string }[],
  onChange = vi.fn(),
  initial = "hostiq",
}) {
  const [value, setValue] = useState(initial);
  return (
    <ProviderCombobox
      value={value}
      accounts={accounts}
      onChange={(p) => {
        setValue(p);
        onChange(p);
      }}
    />
  );
}

const openList = () =>
  fireEvent.click(screen.getByRole("button", { name: /provider/i }));

describe("ProviderCombobox", () => {
  it("показывает выбранного провайдера и бейдж API", () => {
    render(<Harness />);
    expect(screen.getByText("Hostiq")).toBeTruthy();
    expect(screen.getByText("API")).toBeTruthy();
  });

  it("выбор существующего провайдера из списка зовёт onChange с ключом", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openList();
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(onChange).toHaveBeenCalledWith("namecheap");
  });

  it("ранее использованный ручной провайдер попадает в список", () => {
    render(<Harness accounts={[{ provider: "GoDaddy" }]} />);
    openList();
    const opt = screen.getByRole("option", { name: /GoDaddy/ });
    expect(opt).toBeTruthy();
    // помечен manual, а не API
    expect(opt.textContent).toContain("manual");
  });

  it("выбор ручного провайдера отдаёт имя как оно записано (не нормализованный ключ)", () => {
    const onChange = vi.fn();
    render(<Harness accounts={[{ provider: "GoDaddy" }]} onChange={onChange} />);
    openList();
    fireEvent.click(screen.getByRole("option", { name: /GoDaddy/ }));
    expect(onChange).toHaveBeenCalledWith("GoDaddy");
  });

  it("ввод неизвестного имени предлагает создать и отдаёт его как есть", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "Porkbun" },
    });
    fireEvent.click(screen.getByText(/Создать/));
    expect(onChange).toHaveBeenCalledWith("Porkbun");
  });

  it("ввод существующего имени (в другом регистре) не предлагает создать", () => {
    render(<Harness />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "HOSTIQ" },
    });
    expect(screen.queryByText(/Создать/)).toBeNull();
  });

  /**
   * Ключевой тест на пробелы. `hasApi` их НЕ срезает (зеркало `make_service`
   * десктопа), поэтому вставленное из буфера " Namecheap " не должно уходить
   * наружу как есть: иначе завёлся бы ручной ярлык, который выглядит настоящим
   * Namecheap, но у которого нет ни кнопки Test, ни Set NS.
   */
  it("вставка имени с пробелами не плодит ручной дубль API-провайдера", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "  Namecheap  " },
    });
    expect(screen.queryByText(/Создать/)).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(onChange).toHaveBeenCalledWith("namecheap");
  });

  it("создание тримит ввод: «  Porkbun  » уходит как «Porkbun»", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "  Porkbun  " },
    });
    fireEvent.click(screen.getByText(/Создать/));
    expect(onChange).toHaveBeenCalledWith("Porkbun");
  });

  /**
   * Фокус после выбора обязан вернуться на кнопку. `autoFocus` уводит его в поле
   * поиска, а выбор размонтирует всплывашку — и без возврата фокус приземляется
   * на `document.body`: следующий `Tab` начинается с начала документа, а не со
   * следующего поля формы. Речь именно про возврат, не про навигацию по списку
   * с клавиатуры (её здесь нет).
   */
  it("после выбора фокус возвращается на кнопку провайдера", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /provider/i });
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/Поиск/));
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(document.activeElement).toBe(button);
  });

  it("создание нового провайдера тоже возвращает фокус на кнопку", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /provider/i });
    fireEvent.click(button);
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "Porkbun" },
    });
    fireEvent.click(screen.getByText(/Создать/));
    expect(document.activeElement).toBe(button);
  });

  it("выбор закрывает список и сбрасывает поиск", () => {
    render(<Harness />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "Name" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Namecheap/ }));
    expect(screen.queryByRole("listbox")).toBeNull();
    openList();
    expect((screen.getByPlaceholderText(/Поиск/) as HTMLInputElement).value).toBe("");
  });

  it("ввод из одних пробелов равен пустому поиску: список цел, создавать нечего", () => {
    render(<Harness />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "   " },
    });
    expect(screen.getAllByRole("option").length).toBe(2); // hostiq + namecheap
    expect(screen.queryByText(/Создать/)).toBeNull();
  });

  /**
   * Инвариант «список не пустеет молча»: если фильтр не нашёл ничего, значит
   * введённого имени в опциях нет — и снизу обязан быть пункт «Создать».
   * Пустая выпадашка без единого действия была бы тупиком.
   */
  it("поиск без совпадений всегда оставляет пункт «Создать»", () => {
    render(<Harness />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "zzz" },
    });
    expect(screen.queryAllByRole("option").length).toBe(1); // только «Создать»
    expect(screen.getByText(/Создать/)).toBeTruthy();
  });

  /**
   * Выбранный провайдер входит в список сам по себе, без аккаунта под ним:
   * в форме создания это состояние наступает сразу после «Создать «Porkbun»».
   */
  it("выбранный провайдер вне каталога и вне аккаунтов подсвечен в списке", () => {
    render(<Harness initial="Porkbun" />);
    openList();
    const opt = screen.getByRole("option", { name: /Porkbun/ });
    expect(opt.getAttribute("aria-selected")).toBe("true");
    expect(opt.textContent).toContain("manual");
  });

  it("поиск по уже выбранному своему провайдеру не предлагает создать его повторно", () => {
    render(<Harness initial="Porkbun" />);
    openList();
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), {
      target: { value: "Porkbun" },
    });
    expect(screen.queryByText(/Создать/)).toBeNull();
    expect(screen.getAllByRole("option").length).toBe(1);
  });

  it("каталожный value не задваивает пункт списка", () => {
    render(<Harness initial="hostiq" />);
    openList();
    const opts = screen.getAllByRole("option");
    expect(opts.length).toBe(2);
    expect(opts.map((o) => o.textContent).join("|")).toContain("Hostiq");
    expect(opts.map((o) => o.textContent).join("|")).toContain("Namecheap");
  });

  it("value с пробелами вокруг каталожного имени тоже не задваивает пункт", () => {
    render(<Harness initial=" hostiq " />);
    openList();
    expect(screen.getAllByRole("option").length).toBe(2);
  });

  it("пустой value не заводит пункт-призрак", () => {
    render(<Harness initial="" />);
    openList();
    expect(screen.getAllByRole("option").length).toBe(2);
  });

  it("disabled не даёт раскрыть список", () => {
    const [value, onChange] = ["hostiq", vi.fn()];
    render(
      <ProviderCombobox value={value} accounts={[]} onChange={onChange} disabled />
    );
    openList();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  /**
   * Тот же `disabled`, но пришедший поверх уже раскрытого списка — так его и
   * подаёт форма (`disabled={secrets.saving}`), если сохранение началось
   * из-под открытой выпадашки. Список обязан исчезнуть на время записи и
   * вернуться тем же, каким его открывали: своего стейта `open` мы не рушим.
   */
  it("disabled поверх открытого списка прячет его, а снятие — возвращает", () => {
    const props = { value: "hostiq", accounts: [], onChange: vi.fn() };
    const { rerender } = render(<ProviderCombobox {...props} />);
    openList();
    expect(screen.getByRole("listbox")).toBeTruthy();

    rerender(<ProviderCombobox {...props} disabled />);
    expect(screen.queryByRole("listbox")).toBeNull();

    rerender(<ProviderCombobox {...props} />);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
