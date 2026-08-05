/**
 * Хостинг-провайдер сервера: проверка перед отправкой, приведение к хранимому
 * виду и сбор подсказок.
 *
 * Поле свободное — фиксированного списка провайдеров нет и не будет, новый
 * провайдер не должен требовать правки кода, — поэтому правил ровно два, и оба
 * не про вкус, а про систему: длина не больше колонки `servers.provider` и
 * никаких управляющих символов. Обоснование обоих — в `is_valid_provider`
 * (`backend/app/core/validators.py`), это его копия.
 *
 * Копия нужна по той же причине, что и `fastpanelInput`: 422 доезжает до формы
 * строкой из `formatErrorDetail`, и «provider: String should have at most 64
 * characters» под полем — это уже отказ постфактум, после того как секретный
 * блоб (SSH-пароль) уже записан. Пусть форма скажет это до отправки.
 */

/**
 * Ширина колонки `servers.provider`. Парно к `PROVIDER_MAX_LEN` в
 * `backend/app/core/validators.py`, где живёт первоисточник: там это ещё и
 * граница между 422 и 500 из Postgres.
 */
export const PROVIDER_MAX_LEN = 64;

// C0 плюс DEL — парно к `_CONTROL_CHARS_RE` на бэкенде.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Текст ошибки для человека или `null`, если поле в порядке.
 *
 * Проверяется обрезанное значение, и ровно оно же уезжает на сервер (см.
 * `providerPayload`): сервер сначала `strip()`, потом валидирует, — проверь мы
 * длину до обрезки, форма краснела бы там, где сервер записывает молча.
 */
export function providerError(value: string): string | null {
  const provider = value.trim();
  // Пустое поле — законное состояние: провайдер необязателен, у половины
  // серверов его просто не заполнят.
  if (!provider) return null;
  if (provider.length > PROVIDER_MAX_LEN) {
    return `Provider must be at most ${PROVIDER_MAX_LEN} characters`;
  }
  if (CONTROL_CHARS.test(provider)) return "Provider must not contain control characters";
  return null;
}

/**
 * Что класть в тело запроса. Пустое поле — это `null`, а НЕ `""`: пустая строка
 * в колонке означала бы «провайдер есть, и он пустой», и `datalist` с фильтром
 * считали бы её отдельным провайдером. Сервер приводит `""` к `NULL` сам, но
 * тогда UI и БД расходятся до первой перезагрузки страницы.
 */
export function providerPayload(value: string): string | null {
  return value.trim() || null;
}

/**
 * Имена провайдеров, встречающиеся у уже загруженных серверов, — источник и для
 * подсказок формы, и для фильтра списка. Отдельного эндпоинта нет намеренно:
 * список серверов и так грузится целиком, а второй источник тех же значений
 * умел бы с ним разойтись.
 *
 * Обрезка здесь не дублирует серверную: сервер обрезает то, что пишет СЕЙЧАС, а
 * в списке лежат и строки, записанные до появления этой проверки, — «Hetzner »
 * дал бы в подсказках второго «того же самого».
 *
 * Сортировка регистронезависимая: при обычной `sort()` все имена с маленькой
 * буквы уезжают ниже всех заглавных, и «aws» ищут в конце списка.
 */
export function providerOptions(servers: ReadonlyArray<{ provider?: string | null }>): string[] {
  const names = servers
    .map((s) => s.provider?.trim())
    .filter((p): p is string => Boolean(p));
  return Array.from(new Set(names)).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
