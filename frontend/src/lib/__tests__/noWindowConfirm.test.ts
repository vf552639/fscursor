import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Сторож нативных диалогов — с обоих концов сразу.
 *
 * Конец первый, фронтовый: `window.confirm`/`alert`/`prompt` в десктопе не
 * работают. WKWebView рисует JS-панели только через UI-делегата, а делегат wry
 * не реализует ни одного панельного метода — панель не показывается,
 * `confirm()` отдаёт `false`. Ошибки при этом нет ни в консоли, ни в тестах на
 * jsdom (там `confirm` живой), поэтому обычным код-ревью такой вызов не
 * ловится: он выглядит рабочим ровно до запуска в настоящем окне. Семь кнопок
 * удаления так и прожили — молча.
 *
 * Конец второй, десктопный: нативный диалог плагина открывается, только если
 * разрешение выписано в `capabilities/default.json`. Разрешения нет — плагин
 * отбивает вызов, обёртка ловит ошибку, и выходит ровно тот же молчаливый
 * отказ, только этажом ниже. Поэтому каждое разрешение, на котором висит
 * кнопка, сторожится тестом, а не глазами при ревью capabilities.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", ".."); // src/lib/__tests__ → src
const FRONTEND = join(SRC, "..");

/**
 * Голый вызов диалога браузера.
 *
 * Лукбихайнд отсекает то, что лишь заканчивается на нужное слово
 * (`confirmAction(`, `setConfirm(`), а `.` в нём отсекает чужие методы
 * (`dialog.prompt(`). Но `window.confirm(` — как раз то, что ловим, поэтому
 * известные хосты глобалов разрешены явной альтернативой перед именем.
 */
const BROWSER_DIALOG_CALL = /(?<![A-Za-z0-9_$.])(?:(?:window|globalThis|self)\.)?(?:confirm|alert|prompt)\s*\(/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function isChecked(relPath: string): boolean {
  const parts = relPath.split(sep);
  if (parts.includes("__tests__")) return false;
  if (/\.test\.tsx?$/.test(relPath)) return false;
  // Единственное место, где `window.confirm` законен: там он выбран осознанно
  // и только для веба, где панель настоящая.
  if (relPath === join("lib", "confirmDialog.ts")) return false;
  return true;
}

describe("browser dialog guard", () => {
  it("регекс ловит именно голый вызов, а не похожие имена", () => {
    // Позитивные: так писать нельзя.
    for (const s of [
      "if (!confirm(`Delete ${x}?`)) return;",
      "if (!window.confirm(msg)) return;",
      "globalThis.confirm('x')",
      "alert('boom')",
      "const name = prompt('name')",
      "return confirm (msg)",
      "{ confirm(msg) }",
    ]) {
      expect(BROWSER_DIALOG_CALL.test(s), s).toBe(true);
    }
    // Негативные: сюда сторож лезть не должен.
    for (const s of [
      "if (!(await confirmAction(msg))) return;",
      "setConfirm(true)",
      "const [confirmOpen, setConfirmOpen] = useState(false);",
      "dialog.prompt('x')",
      "obj.alert('x')",
      "await confirmAction(`Delete ${d.domain}?`)",
      "// подтверждение делает confirmAction",
    ]) {
      expect(BROWSER_DIALOG_CALL.test(s), s).toBe(false);
    }
  });

  it("во фронте нет вызовов confirm/alert/prompt", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (!isChecked(rel)) continue;
      const lines: string[] = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (BROWSER_DIALOG_CALL.test(line)) {
          offenders.push(`src/${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Диалоги браузера в десктопе не работают: WKWebView без UI-делегата не " +
        "показывает панель, а confirm() молча отдаёт false — кнопка не делает " +
        "ничего. Используй confirmAction из lib/confirmDialog.ts.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

/**
 * Разрешения плагина диалога. Отдельный блок: соседний сторожит текст фронта,
 * этот — файл десктопа, и ломаются они по разным причинам.
 */
describe("native dialog permissions", () => {
  function permissions(): string[] {
    const path = join(FRONTEND, "..", "desktop", "src-tauri", "capabilities", "default.json");
    return (JSON.parse(readFileSync(path, "utf8")) as { permissions: string[] }).permissions;
  }

  it("десктоп разрешает нативный ask — иначе confirmAction тоже молчит", () => {
    // Без `dialog:allow-ask` плагин отбивает вызов, `confirmAction` ловит
    // ошибку и возвращает `false` — то есть мы получаем ровно тот молчаливый
    // отказ, который и чинили, только этажом ниже. Поэтому разрешение
    // сторожится тестом, а не только глазами при ревью capabilities.
    expect(permissions()).toContain("dialog:allow-ask");
  });

  it("десктоп разрешает нативный save — иначе бэкап некуда скачать", () => {
    // Без `dialog:allow-save` панель «сохранить как» не откроется: плагин
    // отобьёт вызов, выбор пути вернётся пустым — и «скачать бэкап» станет
    // кнопкой, которая молча не делает ничего. На jsdom этого не видно вовсе:
    // там плагина нет, путь берётся из мока, и тесты остаются зелёными.
    // Именно `save`, а не `open`: человек должен видеть и править имя файла, а
    // команда бэкапа принимает полный путь; `open` вдобавок открыл бы вебвью
    // чтение произвольных путей, которое задаче не нужно.
    expect(permissions()).toContain("dialog:allow-save");
  });
});
