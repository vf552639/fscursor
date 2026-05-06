export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  // Tauri 1/2 injects internals on window
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__,
  );
}
