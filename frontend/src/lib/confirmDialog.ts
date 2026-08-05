import { isTauri } from "./runtime";

/**
 * Единственный способ спросить у человека «да/нет» во всём приложении.
 *
 * Почему не `window.confirm` напрямую — он **не работает в десктопе**. WKWebView
 * рисует JS-диалоги (`alert`/`confirm`/`prompt`) только если UI-делегат
 * реализует `webView:runJavaScriptConfirmPanelWithMessage:…`; делегат wry (0.55,
 * `wkwebview/class/wry_web_view_ui_delegate.rs`) не реализует ни одного
 * JS-панельного метода, и в этом случае WKWebView панель не показывает вовсе, а
 * вызову отдаёт `false`. То есть `confirm()` в Tauri — это молчаливое «нет».
 *
 * Что это стоило: незнакомый SSH-ключ нельзя было принять ни разу (SSH Test
 * падал с «was not trusted», не задав вопроса), любая `sdmp://`-ссылка молча
 * отменялась, а СЕМЬ кнопок удаления в десктопе не делали ничего — ни диалога,
 * ни действия, ни ошибки. Тот же класс, что `keyring` без платформенных фич:
 * механизм, у которого нет теста в живой среде, зелёный и мёртвый одновременно.
 *
 * Поэтому в десктопе вопрос задаёт нативный диалог плагина (`dialog:allow-ask` в
 * `capabilities/default.json`), а `window.confirm` остаётся только для веба —
 * там он настоящий, и тянуть в веб-сборку десктопный плагин незачем.
 *
 * Импорт плагина динамический по той же причине: в браузере модуль не грузится.
 */

const DIALOG_TITLE = "SDMP";

/**
 * Спросить подтверждение. `false` — не делать.
 *
 * Ошибка диалога (нет разрешения в capabilities, окно закрыли) — тоже `false`:
 * этот вопрос стоит перед удалением и перед выполнением по чужой ссылке, и
 * «спросить не вышло» обязано означать «не делаем». Но не молча: молчание —
 * ровно то, из-за чего девять сломанных мест прожили незамеченными, поэтому
 * причина уходит в консоль. Что разрешение на месте, сторожит тест
 * `noWindowConfirm.test.ts` — он читает сам файл capabilities.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!isTauri()) return window.confirm(message);
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(message, { title: DIALOG_TITLE, kind: "warning" });
  } catch (e) {
    console.error("confirm dialog failed", e);
    return false;
  }
}
