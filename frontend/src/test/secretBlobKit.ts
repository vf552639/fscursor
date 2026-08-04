import type { Mock } from "vitest";

/**
 * Общая оснастка тестов на запись секретов. Заведена до того, как формы
 * FastPanel / регистратора / Cloudflare принесут по своей копии этих трёх
 * штук: `setTauri` уже размножен по файлам, и каждая копия — это шанс, что
 * в одной из них забудут снять флаг в `afterEach`.
 */

/** Флаг десктопа читает настоящий `isTauri`, поэтому подменяем именно окно. */
export function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Полный формат: биты версии и варианта — часть id, который уедет в БД. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Аргументы всех вызовов `vault_put_blob` — для проверок «сколько раз». */
export function putBlobCalls(invokeIfTauri: Mock): Record<string, any>[] {
  return invokeIfTauri.mock.calls
    .filter((c: unknown[]) => c[0] === "vault_put_blob")
    .map((c: unknown[]) => c[1] as Record<string, any>);
}

/**
 * Аргументы единственного вызова. Требование «ровно один» — не строгость ради
 * строгости: второй вызов означает второй блоб на тот же секрет, и без этой
 * проверки такой тест молча смотрел бы на первый.
 */
export function putBlobArgs(invokeIfTauri: Mock): Record<string, any> {
  const calls = putBlobCalls(invokeIfTauri);
  if (calls.length !== 1) throw new Error(`vault_put_blob вызвана ${calls.length} раз, ожидался 1`);
  return calls[0];
}
