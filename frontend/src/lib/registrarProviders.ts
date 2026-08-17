/**
 * Провайдеры со встроенным Rust-клиентом в десктопе. Зеркалит
 * `registrars::make_service` (desktop/src-tauri/src/registrars/mod.rs): у кого
 * здесь есть запись — у того реально работают test_connection / get_domains /
 * set_nameservers. Всё остальное — «ручной» провайдер: хранится ярлыком, API нет.
 *
 * ЕДИНСТВЕННЫЙ источник правды об API-способности на фронте. Добавляя новый
 * Rust-клиент, добавь запись СЮДА — иначе форма не покажет ему поля секретов, а
 * карточка — кнопку Test.
 */
export const API_PROVIDERS = {
  hostiq: { label: "Hostiq", icon: "H", bg: "#fff7ed", color: "#ea580c", needsClientIp: false },
  namecheap: { label: "Namecheap", icon: "N", bg: "#fef2f2", color: "#dc2626", needsClientIp: true },
} as const;

export type ApiProviderKey = keyof typeof API_PROVIDERS;

/** В БД `provider` — свободная строка; "Hostiq"/" hostiq " — один провайдер. */
export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Есть ли у провайдера рабочий API-клиент. Не в каталоге → ручной. */
export function hasApi(provider: string): boolean {
  return normalizeProvider(provider) in API_PROVIDERS;
}

/** Нужно ли поле Client IP (сегодня — только Namecheap). */
export function needsClientIp(provider: string): boolean {
  const meta = API_PROVIDERS[normalizeProvider(provider) as ApiProviderKey];
  return !!meta && meta.needsClientIp;
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
 */
const MANUAL_PALETTE = [
  { bg: "#eef2ff", color: "#4f46e5" },
  { bg: "#ecfeff", color: "#0891b2" },
  { bg: "#f0fdf4", color: "#16a34a" },
  { bg: "#fef3c7", color: "#b45309" },
  { bg: "#fce7f3", color: "#be185d" },
  { bg: "#f3f4f6", color: "#374151" },
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Метаданные показа: API — из каталога, ручной — из палитры по хешу имени. */
export function providerMeta(provider: string): ProviderMeta {
  const key = normalizeProvider(provider);
  const api = API_PROVIDERS[key as ApiProviderKey];
  if (api) {
    return { key, label: api.label, icon: api.icon, bg: api.bg, color: api.color, api: true };
  }
  const display = provider.trim() || "?";
  const pal = MANUAL_PALETTE[hashIndex(key || "?", MANUAL_PALETTE.length)];
  return { key, label: display, icon: (display[0] || "?").toUpperCase(), bg: pal.bg, color: pal.color, api: false };
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
