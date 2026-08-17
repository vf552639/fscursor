import { registrarSupportsNsApi } from "./registrarCaps";

/**
 * Каталог провайдеров, у которых в десктопе есть Rust-клиент: как их показывать
 * (метка, буква, цвета) и нужен ли им Client IP. Всё остальное — «ручной»
 * провайдер: хранится ярлыком, API нет.
 *
 * Источник правды здесь — про ПОКАЗ и про `needsClientIp`, и только про них.
 * Ответ на вопрос «есть ли API» каталог не даёт сам, а НАСЛЕДУЕТ у
 * `registrarCaps.registrarSupportsNsApi` (см. `hasApi` ниже): предикат в
 * проекте должен быть один, иначе один и тот же аккаунт получает два разных
 * ответа на разных экранах.
 *
 * Добавляя новый Rust-клиент, добавь запись СЮДА — иначе форма не покажет ему
 * поля секретов, а карточка — кнопку Test. Забыть не даст тест согласия в
 * `registrarProviders.test.ts`: он сверяет ключи с десктопным списком.
 */
export const API_PROVIDERS = {
  hostiq: { label: "Hostiq", icon: "H", bg: "#fff7ed", color: "#ea580c", needsClientIp: false },
  namecheap: { label: "Namecheap", icon: "N", bg: "#fef2f2", color: "#dc2626", needsClientIp: true },
} as const;

export type ApiProviderKey = keyof typeof API_PROVIDERS;

/** Читаем каталог только по собственным ключам: `provider` — свободный ввод, а
 *  `"constructor"`/`"__proto__"`/`"valueOf"` есть у любого объектного литерала
 *  по прототипу, и обычный `in`/индексация увели бы такое имя в API-ветку с
 *  `label: undefined` в аватаре. */
function catalogEntry(key: string): (typeof API_PROVIDERS)[ApiProviderKey] | undefined {
  return Object.prototype.hasOwnProperty.call(API_PROVIDERS, key)
    ? API_PROVIDERS[key as ApiProviderKey]
    : undefined;
}

/**
 * Ключ провайдера для списка: дедуп, сравнение, поиск записи в каталоге.
 *
 * Trim здесь НАМЕРЕННО, и это ДРУГОЙ вопрос, чем «понимает ли его десктоп»
 * (`hasApi`, у которого trim нет). Для списка `" hostiq "` и `"Hostiq"` — одна
 * строка в выпадашке: показывать их двумя пунктами незачем. Для десктопа же это
 * разные строки, и вторую `make_service` не знает. Расхождение не опечатка:
 * ключ показа схлопывает мусор, ответ о работоспособности — нет.
 */
export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/**
 * Есть ли у провайдера рабочий API-клиент. Не в каталоге → ручной.
 *
 * Делегирует `registrarSupportsNsApi` вместо собственной проверки: тот модуль —
 * зеркало `make_service` (регистр схлопывает, пробелы НЕТ), и он уже отвечает на
 * этот вопрос в карточке домена и мастере полной настройки. Свой предикат здесь
 * означал бы, что `" hostiq "` из чужого импорта получает бейдж «API» и живую
 * кнопку Test в Settings, а рядом — выключенный «Set NS» и `unknown provider` от
 * десктопа за кнопкой. Один аккаунт, два ответа, и оптимистичный — ложный.
 *
 * Аргумент допускает `null`/`undefined` по той же мотивировке, что у
 * `registrarSupportsNsApi`: колонка `provider` nullable, и «не знаем провайдера»
 * — это ответ «не умеет», а не повод вызывающему писать свой `String(... || "")`.
 * Каждая такая страховка на месте вызова — ещё одна нормализация, которая может
 * разойтись с соседней.
 */
export function hasApi(provider: string | null | undefined): boolean {
  return registrarSupportsNsApi(provider);
}

/**
 * Нужно ли поле Client IP (сегодня — только Namecheap).
 *
 * Сначала гейт по `hasApi`: у провайдера, которого десктоп не признаёт, полей
 * API не спрашивают вовсе — иначе форма требовала бы Client IP там, где сама же
 * не показывает API-способности.
 */
export function needsClientIp(provider: string | null | undefined): boolean {
  if (!hasApi(provider)) return false;
  // `?? ""` недостижим: гейт выше пропускает только строку из каталога. Он здесь
  // ради типа — `normalizeProvider` остаётся строгим намеренно, это ключ показа,
  // и «ключ от ничего» не бывает.
  return catalogEntry(normalizeProvider(provider ?? ""))?.needsClientIp ?? false;
}

export interface ProviderMeta {
  key: string;   // нормализованный ключ (для дедупа и сравнения)
  label: string; // человекочитаемое имя
  icon: string;  // одна буква для аватара
  bg: string;    // фон аватара
  color: string; // цвет буквы
  api: boolean;  // есть ли API-клиент
}

/**
 * Палитра для ручных провайдеров: детерминированный цвет по имени, чтобы список
 * не был серым и один провайдер всегда красился одинаково (а не «?» на сером,
 * как раньше давал неизвестный provider на карточке).
 *
 * Цвет здесь — ИДЕНТИЧНОСТЬ («это всегда GoDaddy»), а не состояние. Поэтому из
 * палитры убраны две краски примитива `Badge`, которые на тех же строках уже
 * означают состояние: зелёный `#f0fdf4/#16a34a` («Active», «API») и серый
 * `#f3f4f6/#374151` («Inactive», «manual»). Аватар и чип стоят в 40 пикселях
 * друг от друга, и зелёный аватар рядом с серым чипом «manual» — два
 * противоположных сигнала об одном аккаунте (на «GoDaddy» это и выпадало).
 * Оставшиеся оттенки на этих экранах состояний не обозначают.
 */
const MANUAL_PALETTE = [
  { bg: "#eef2ff", color: "#4f46e5" },
  { bg: "#ecfeff", color: "#0891b2" },
  { bg: "#f5f3ff", color: "#6d28d9" },
  { bg: "#fef3c7", color: "#b45309" },
  { bg: "#fce7f3", color: "#be185d" },
  { bg: "#f0f9ff", color: "#0284c7" },
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

/**
 * Метаданные показа: API — из каталога, ручной — из палитры по хешу имени.
 *
 * Ветка выбирается тем же `hasApi`, что решает про кнопку Test: посчитай `api`
 * здесь своей проверкой — и бейдж «API» разъедется с кнопкой внутри одного
 * экрана. Поэтому `" hostiq "` рисуется ручным (метка `hostiq`, буква H, цвет из
 * палитры) — честно: десктоп такую строку не знает.
 *
 * `null`/`undefined` — законный вход, а не ошибка вызывающего: колонка
 * `provider` nullable, и зовут эту функцию в `map` по списку аккаунтов, где
 * брошенное исключение уносит всю вкладку, а не одну карточку. Функция ПОКАЗА
 * обязана что-то показать на любом входе; «не знаем» показывается как `?` с
 * чипом «manual» — ровно то, что рисовал старый `plMap[provider]`.
 */
export function providerMeta(provider: string | null | undefined): ProviderMeta {
  const raw = provider ?? "";
  const key = normalizeProvider(raw);
  const api = hasApi(raw) ? catalogEntry(key) : undefined;
  if (api) {
    return { key, label: api.label, icon: api.icon, bg: api.bg, color: api.color, api: true };
  }
  const display = raw.trim() || "?";
  const pal = MANUAL_PALETTE[hashIndex(key || "?", MANUAL_PALETTE.length)];
  // По кодовым точкам, а не `display[0]`: имя с эмодзи или иным символом вне BMP
  // дало бы в аватаре половину суррогатной пары («\u{FFFD}»).
  return { key, label: display, icon: ([...display][0] || "?").toUpperCase(), bg: pal.bg, color: pal.color, api: false };
}

/**
 * Список для выпадашки: сначала API-каталог (частый кейс сверху), затем
 * уникальные провайдеры уже заведённых аккаунтов (ручные). Без повторов по
 * нормализованному ключу. Отдельной таблицы провайдеров нет — «ранее
 * использованные» выводятся из списка аккаунтов, который и так грузится на вкладке.
 */
export function buildProviderList(accounts: { provider: string }[]): ProviderMeta[] {
  const seen = new Set<string>();
  const out: ProviderMeta[] = [];
  for (const key of Object.keys(API_PROVIDERS)) {
    out.push(providerMeta(key));
    seen.add(key);
  }
  for (const acc of accounts) {
    const key = normalizeProvider(acc.provider);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(providerMeta(acc.provider));
  }
  return out;
}
