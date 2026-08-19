import { describe, it, expect, afterEach } from "vitest";

import { chooseSavePath, defaultBackupFileName } from "./chooseSavePath";

/**
 * Панель «сохранить как» и имя файла, которое она предлагает.
 *
 * Сам диалог здесь не проверяется — он живёт в плагине Tauri, и в jsdom его
 * нет; что разрешение на него выписано, сторожит `__tests__/noWindowConfirm`.
 * Проверяется то, что принадлежит нам: имя-предложение и правило «в вебе
 * спрашивать не у кого».
 */

function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

afterEach(() => setTauri(false));

describe("имя файла по умолчанию", () => {
  it("совпадает по форме с тем, как архив называет сервер", () => {
    // `<домен>-<штамп>.tar`, штамп в UTC — та же строка, что собирает
    // `BackupPaths::new` в Rust. Совпадение не косметическое: одна и та же
    // копия на диске и в `/var/tmp` сервера обязана читаться как одна вещь.
    const at = new Date(Date.UTC(2026, 7, 19, 10, 30, 0));
    expect(defaultBackupFileName("example.com", at)).toBe("example.com-20260819T103000Z.tar");
  });

  it("в имени не остаётся ничего, что означало бы путь или скрытый файл", () => {
    const at = new Date(Date.UTC(2026, 7, 19, 10, 30, 0));
    // Косая черта в имени — это каталог, ведущая точка — скрытый файл с
    // непонятным именем. Домен приезжает из нашей же БД, но подставляется в
    // чужую файловую систему.
    expect(defaultBackupFileName("../etc/passwd", at)).toBe("--etc-passwd-20260819T103000Z.tar");
    expect(defaultBackupFileName(".hidden", at)).toBe("-hidden-20260819T103000Z.tar");
    // Не-ASCII тоже уходит: имя это лишь предложение, а нечитаемое в панели
    // сохранения хуже, чем скучное.
    for (const name of ["../etc/passwd", ".hidden", "ПРИМЕР.РФ", "a b'c"]) {
      const file = defaultBackupFileName(name, at);
      expect(file).not.toContain("/");
      expect(file.startsWith(".")).toBe(false);
      expect(file.endsWith(".tar")).toBe(true);
    }
  });

  it("пустое имя домена не даёт файла с одним лишь штампом", () => {
    const at = new Date(Date.UTC(2026, 7, 19, 10, 30, 0));
    expect(defaultBackupFileName("   ", at)).toBe("backup-20260819T103000Z.tar");
  });
});

describe("веб", () => {
  it("панель не открывается и путь не выбирается", async () => {
    // Плагин диалога в веб-сборку не тянется вовсе, и попытка спросить путь
    // уронила бы вызов динамическим импортом. Отвечаем тем же, чем и отказ:
    // `null` — «не делаем».
    setTauri(false);
    await expect(chooseSavePath("example.com.tar")).resolves.toBeNull();
  });
});
