export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  // Tauri 1/2 injects internals on window
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__,
  );
}

/**
 * Одна фраза на все «это умеет только десктоп». Живёт здесь, а не в трёх
 * api-модулях, потому что пользователь читает её как одно правило продукта, а
 * не как три сообщения разных подсистем.
 *
 * `what` — то, что не сделать, с большой буквы и в -ing форме:
 * `desktopOnly("Setting nameservers")` → «Setting nameservers runs in the SDMP
 * desktop app.»
 */
export function desktopOnly(what: string): string {
  return `${what} runs in the SDMP desktop app.`;
}

/**
 * Бросить, если мы не в десктопе. Текст и брошенной ошибки, и подписи под
 * выключенной кнопкой берётся из одного `desktopOnly`, чтобы объяснение
 * одного и того же запрета не разъезжалось между экраном и баннером ошибки.
 */
export function requireDesktop(what: string): void {
  if (!isTauri()) throw new Error(desktopOnly(what));
}
