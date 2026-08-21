import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

/**
 * Сторож на весь репозиторий: нативного поля даты в живом коде больше нет.
 *
 * ЧТО ЛОВИТ. `<input type="date">` (и его записи через `Inp`/спред-литерал) в
 * любом файле `frontend/src` — независимо от того, кто и когда его добавит.
 *
 * ЗАЧЕМ. В WKWebView десктопа такое поле не принимает ввод с клавиатуры вовсе:
 * цифры не встают в сегменты, календарь не открывается, `input.value` остаётся
 * пустым — то есть форма молча читает пустоту и стирает дату. Продукт от него
 * ушёл целиком (`ui/DateField`), и критерий приёмки был сформулирован как «в
 * проекте не осталось ни одного `type="date"` — проверяется грепом, а не
 * памятью». Грепу, который живёт в чьей-то голове, свойственно не запуститься:
 * проверка того же самого сюитой — способ сделать это свойством проекта.
 *
 * Почему не хватает теста на конкретную форму: он сторожит СВОЙ экран. Поле,
 * заведённое завтра на любом другом (домены, серверы, будущие мастера),
 * прошло бы молча — и разошлось бы с остальным продуктом ровно там, где
 * человек набирает дату руками.
 *
 * Комментарии не считаются: объяснений, ПОЧЕМУ нативное поле ушло, в проекте с
 * десяток, и они обязаны продолжать называть предмет по имени. Отсюда же
 * исключение для самого сторожа — образец, который он ищет, записан в нём.
 */

/**
 * `frontend/src` — от корня vitest'а, а не от `import.meta.url`: под jsdom
 * модулю достаётся `http://localhost/...`, и `fileURLToPath` на нём падает.
 */
const SRC = path.resolve(process.cwd(), "src");

/** Сам сторож: образец, который он ищет, записан в нём. */
const SELF = path.join("test", "nativeDateInput.test.ts");

/** Записи атрибута, которыми нативное поле возвращается: `type="date"`, `type={"date"}`. */
const NATIVE_DATE = /type\s*=\s*\{?\s*["']date["']/;

const CODE = /\.(ts|tsx)$/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.isFile() && CODE.test(entry.name) ? [full] : [];
  });
}

/**
 * Строки без комментариев. Блочные вырезаются целиком, строчные — только там,
 * где комментарий занимает строку один: обрезать хвост после `//` было бы
 * рискованно (`https://…` внутри строкового литерала съел бы остаток строки
 * вместе с возможной находкой).
 */
function codeLines(text: string): { line: number; code: string }[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((code, i) => ({ line: i + 1, code }))
    .filter(({ code }) => !/^\s*(\/\/|\*)/.test(code));
}

describe("нативное поле даты не возвращается в проект", () => {
  it("во frontend/src нет ни одного type=\"date\" в живом коде", () => {
    expect(fs.existsSync(SRC)).toBe(true);
    const found = sources(SRC)
      .filter((file) => path.relative(SRC, file) !== SELF)
      .flatMap((file) =>
        codeLines(fs.readFileSync(file, "utf8"))
          .filter(({ code }) => NATIVE_DATE.test(code))
          .map(({ line }) => `${path.relative(SRC, file)}:${line}`),
      );

    // Список, а не «пусто/не пусто»: упавший сторож обязан назвать место.
    expect(found).toEqual([]);
  });

  it("сторож действительно ловит, а не всегда зелен", () => {
    // Иначе первая же опечатка в образце превратила бы его в пустую формальность.
    expect(NATIVE_DATE.test('<input type="date" value={x} />')).toBe(true);
    expect(NATIVE_DATE.test("<Inp type={'date'} />")).toBe(true);
    expect(NATIVE_DATE.test('<input type="text" />')).toBe(false);
    // Комментарии предмет называют и обязаны продолжать: они не код.
    expect(codeLines(' * Ушёл нативный <input type="date">, см. DateField.')).toEqual([]);
    expect(codeLines('// был <input type="date">')).toEqual([]);
    expect(codeLines('/* <input type="date"> */').every(({ code }) => !NATIVE_DATE.test(code))).toBe(
      true,
    );
  });
});
