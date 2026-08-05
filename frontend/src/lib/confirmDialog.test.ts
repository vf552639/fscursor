import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Единственная точка, где приложение спрашивает «да/нет», — и единственное
 * место, где ошибка стоит дорого сразу в девяти местах.
 *
 * Почему модуль вообще есть: `window.confirm` в webview Tauri на macOS не
 * показывает ничего и возвращает `false`. WKWebView рисует JS-диалоги, только
 * если UI-делегат реализует `runJavaScriptConfirmPanelWithMessage:…`, а делегат
 * wry не реализует ни одного JS-панельного метода. Пока это было незамечено:
 * незнакомый SSH-ключ нельзя было принять ни разу, `sdmp://`-ссылки молча
 * отменялись, семь кнопок удаления не делали ничего.
 */

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), ask: vi.fn() }));

vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isTauri: mocks.isTauri,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));

import { confirmAction } from "./confirmDialog";

let windowConfirm: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  windowConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  windowConfirm.mockRestore();
});

describe("confirmAction в десктопе", () => {
  beforeEach(() => mocks.isTauri.mockReturnValue(true));

  it("спрашивает нативным диалогом и НЕ трогает window.confirm", async () => {
    mocks.ask.mockResolvedValue(true);

    await expect(confirmAction("Delete server?")).resolves.toBe(true);

    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.ask.mock.calls[0][0]).toBe("Delete server?");
    // Именно это утверждение и есть тест: `window.confirm` здесь вернул бы
    // `true` (мы его так замокали), и подмена нативного диалога на него
    // прошла бы незамеченной без этой строки.
    expect(windowConfirm).not.toHaveBeenCalled();
  });

  it("отдаёт отказ пользователя как отказ", async () => {
    mocks.ask.mockResolvedValue(false);
    await expect(confirmAction("Delete server?")).resolves.toBe(false);
  });

  /**
   * Fail-closed. Диалог стоит перед удалением и перед выполнением по чужой
   * ссылке: «спросить не вышло» обязано означать «не делаем». Реальный сценарий
   * — пропавшее `dialog:allow-ask` в capabilities: плагин реджектит, и вернуть
   * `true` здесь значило бы удалять без вопроса.
   */
  it("на сорвавшемся диалоге отвечает «нет», но не молча", async () => {
    mocks.ask.mockRejectedValue(new Error("dialog.ask not allowed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(confirmAction("Delete server?")).resolves.toBe(false);

    // Молчание — ровно то, из-за чего девять сломанных мест прожили
    // незамеченными, поэтому причина обязана оказаться в консоли.
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("confirmAction в браузере", () => {
  beforeEach(() => mocks.isTauri.mockReturnValue(false));

  /**
   * В вебе `window.confirm` настоящий, и тянуть в веб-сборку десктопный плагин
   * незачем — поэтому импорт плагина динамический и в этой ветке не случается.
   */
  it("спрашивает window.confirm и не грузит десктопный плагин", async () => {
    windowConfirm.mockReturnValue(false);

    await expect(confirmAction("Delete server?")).resolves.toBe(false);

    expect(windowConfirm).toHaveBeenCalledWith("Delete server?");
    expect(mocks.ask).not.toHaveBeenCalled();
  });
});
