import { isTauri } from "./runtime";

/**
 * Спросить у человека, КУДА сохранить файл, — нативной панелью «Сохранить как».
 *
 * Живёт рядом с `confirmDialog.ts` и по той же причине: диалоги браузера в
 * десктопе не работают вовсе (WKWebView без UI-делегата не показывает панель),
 * а `<input type="file">` умеет спрашивать только про чтение — записать по
 * выбранному пути из вебвью нельзя. Путь нужен Rust-команде бэкапа полной
 * строкой: архив в гигабайты она пишет сама, потоком, мимо вебвью.
 *
 * Импорт плагина динамический — тот же приём, что у `confirmAction`: в
 * веб-сборке этот модуль не грузится вовсе, а разрешение `dialog:allow-save`
 * выписано в `capabilities/default.json` и сторожится
 * `lib/__tests__/noWindowConfirm.test.ts`. Без разрешения плагин молча отбил бы
 * вызов — и кнопка «создать копию» стала бы кнопкой, которая ничего не делает.
 */

/**
 * Отказ — `null`, и это ОДИН ответ на два разных случая: человек закрыл панель
 * и панель не открылась. Разными их делать нельзя: «сохранить как» стоит перед
 * действием, которое пишет файл на диск и час занимает сервер, и «спросить не
 * вышло» обязано означать «не делаем» ровно так же, как «передумал». Но не
 * молча — причина уходит в консоль, как у `confirmAction`.
 */
export async function chooseSavePath(defaultName: string): Promise<string | null> {
  // В вебе спрашивать не у кого и незачем: там нет ни кнопки, ни команды,
  // которая писала бы файл (принцип №3 — веб только смотрит).
  if (!isTauri()) return null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    // `save`, а не `open`: человек должен видеть и править имя файла, а команда
    // принимает полный путь. Родительский каталог и абсолютность пути ещё раз
    // проверит Rust (`validate_dest_path`) — от бага фронта, не от человека.
    const picked = await save({ defaultPath: defaultName });
    return picked ?? null;
  } catch (e) {
    console.error("save dialog failed", e);
    return null;
  }
}

/**
 * Имя архива по умолчанию — то же, каким его называет сервер
 * (`BackupPaths::new` в `ssh/backup_run.rs`): `<домен>-<штамп>.tar`, штамп в
 * UTC. Совпадение не косметическое: при разборе «что это за файл» одна и та же
 * копия на диске и в `/var/tmp` сервера обязана читаться как одна вещь, а не
 * как две разные.
 *
 * Это ПРЕДЛОЖЕНИЕ, а не решение: человек правит имя в панели, и путь, по
 * которому файл в итоге лёг, знает только команда — она его и возвращает.
 * Печатать на экране надо её ответ, а не эту строку.
 */
export function defaultBackupFileName(domainName: string, at: Date = new Date()): string {
  const stamp =
    at.getUTCFullYear().toString().padStart(4, "0") +
    pad2(at.getUTCMonth() + 1) +
    pad2(at.getUTCDate()) +
    "T" +
    pad2(at.getUTCHours()) +
    pad2(at.getUTCMinutes()) +
    pad2(at.getUTCSeconds()) +
    "Z";
  return `${safeComponent(domainName)}-${stamp}.tar`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Домен → одна безопасная составляющая имени файла. Тот же смысл, что у
 * `safe_component` в Rust: имя уходит в панель сохранения как есть, и `/` в нём
 * означал бы каталог, а ведущая точка — скрытый файл с непонятным именем.
 */
function safeComponent(domain: string): string {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^\.+/, "-");
  return cleaned || "backup";
}
