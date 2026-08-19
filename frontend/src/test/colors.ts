/**
 * jsdom сериализует `style.color` как `rgb(r, g, b)`, а наши цветовые константы
 * (`STALE_TEXT`, `DIM_TEXT` и т.п.) — hex-строки. Тесты, проверяющие «эта цифра
 * окрашена именно этой константой», сравнивают через эту функцию, а не через
 * захардкоженный `rgb(...)`: так смена цвета в `Primitives.tsx` не роняет
 * тесты, которые ничего не утверждали про конкретное значение.
 *
 * Принимает только полный шестизначный hex (`#a8a29e`) — ровно то, чем в
 * проекте заданы цветовые константы. Сокращённая форма (`#fff`) тоже встречается
 * в коде, но здесь не поддержана: `parseInt("", 16)` тихо даёт `NaN`, и без
 * проверки длины функция печатала бы правдоподобную с виду, но лживую строку
 * вместо явной ошибки на непонятном ей входе.
 */
export function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`hexToRgb: ожидается 6-значный hex-цвет, получено "${hex}"`);
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Относительная светлота по WCAG (линеаризация каналов sRGB, затем
 * `0.2126R + 0.7152G + 0.0722B`). Нужна тестам, которые проверяют не точное
 * значение контраста (оно меняется вместе с выбором цвета), а отношение между
 * двумя константами — «этот цвет темнее того».
 */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`relativeLuminance: ожидается 6-значный hex-цвет, получено "${hex}"`);
  }
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(clean.slice(0, 2), 16));
  const g = channel(parseInt(clean.slice(2, 4), 16));
  const b = channel(parseInt(clean.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * То же, что `relativeLuminance`, но на вход принимает `rgb(r, g, b)` — форму,
 * в которой jsdom отдаёт `element.style.color`.
 *
 * Живёт рядом с ней, а не в файле теста: тесты, которые проверяют «это
 * различимо», а не «это вот такой хекс», нужны каждому экрану со своей
 * приглушённой строкой, и переписывать разбор `rgb(...)` в каждом — тот же
 * способ развести копии, ради которого заведён сам модуль.
 */
export function luminanceOfRgb(rgb: string): number {
  const parts = rgb.match(/\d+/g);
  if (!parts || parts.length < 3) {
    throw new Error(`luminanceOfRgb: ожидается "rgb(r, g, b)", получено "${rgb}"`);
  }
  const hex = parts
    .slice(0, 3)
    .map((v) => Number(v).toString(16).padStart(2, "0"))
    .join("");
  return relativeLuminance(`#${hex}`);
}
