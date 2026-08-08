// Какая сборка сейчас запущена. Версия из tauri.conf.json, коммит и время —
// подставлены `define` в vite.config.ts на этапе сборки (там же объяснено, почему
// иначе никак и почему любая осечка даёт UNKNOWN, а не выдуманное значение).
//
// Здесь — вся деградация до «неизвестно» в одном месте: разметка получает уже
// готовую строку и не решает, что делать с пустым коммитом.

export const UNKNOWN = "unknown";

export interface BuildInfo {
  version: string;
  commit: string;
  /** ISO-8601, как его отдал `Date.prototype.toISOString` на машине сборки. */
  builtAt: string;
}

// `define` — текстовая замена, а не переменная: если сборка почему-то прошла без
// него (чужой бандлер, прямой ts-node), идентификатора в рантайме не будет вовсе
// и обращение бросит ReferenceError. Модуль импортирует оболочка приложения, так
// что незакрытый бросок здесь — белый экран вместо окна. Отсюда try/catch: цена
// три строки, отказ — деградация до UNKNOWN вместо падения.
function fromDefine(read: () => string): string {
  try {
    const value = read();
    return typeof value === "string" && value ? value : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export const BUILD_INFO: BuildInfo = {
  version: fromDefine(() => __APP_VERSION__),
  commit: fromDefine(() => __APP_COMMIT__),
  builtAt: fromDefine(() => __APP_BUILT_AT__),
};

function isKnown(value: string): boolean {
  return !!value && value !== UNKNOWN;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Время сборки в местной зоне читателя — `YYYY-MM-DD HH:MM`.
 *
 * Не `toLocaleString`: формат тогда зависит от локали системы, и одна и та же
 * сборка в скриншоте пользователя и в тесте выглядела бы по-разному. Секунды
 * отброшены намеренно — вопрос «та ли это сборка» решается на минутах.
 */
export function formatBuiltAt(iso: string): string {
  if (!isKnown(iso)) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Короткая подпись для подвала сайдбара.
 *
 * Версия без коммита бесполезна для различения сборок (она стоит на 0.1.0
 * месяцами), поэтому коммит показывается рядом с ней, а не вместо неё в
 * подсказке. Суффикс `+` у коммита ставит сборка — он означает, что дерево было
 * грязным, и приезжает сюда уже внутри строки.
 */
export function buildLabel(info: BuildInfo = BUILD_INFO): string {
  const version = isKnown(info.version);
  const commit = isKnown(info.commit);
  if (version && commit) return `v${info.version} · ${info.commit}`;
  if (version) return `v${info.version}`;
  if (commit) return `build ${info.commit}`;
  return "build unknown";
}

/** Полные данные о сборке — в `title`, чтобы не занимать место в сайдбаре. */
export function buildTooltip(info: BuildInfo = BUILD_INFO): string {
  return [
    `Version: ${isKnown(info.version) ? info.version : UNKNOWN}`,
    `Commit: ${isKnown(info.commit) ? info.commit : UNKNOWN}`,
    `Built: ${formatBuiltAt(info.builtAt)}`,
  ].join("\n");
}
