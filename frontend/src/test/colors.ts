/**
 * jsdom сериализует `style.color` как `rgb(r, g, b)`, а наши цветовые константы
 * (`STALE_TEXT`, `DIM_TEXT` и т.п.) — hex-строки. Тесты, проверяющие «эта цифра
 * окрашена именно этой константой», сравнивают через эту функцию, а не через
 * захардкоженный `rgb(...)`: так смена цвета в `Primitives.tsx` не роняет
 * тесты, которые ничего не утверждали про конкретное значение.
 */
export function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
