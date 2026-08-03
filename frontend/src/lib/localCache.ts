import { invokeIfTauri } from "./tauri-invoke";
import { isTauri } from "./runtime";
import { useAuthStore } from "../store/auth";

/**
 * Локальный SQLCipher-кэш: из него КАЖДАЯ Tauri-команда достаёт свою сущность
 * (сервер, домен, аккаунт CF/регистратора). Пока он обновлялся только на
 * логине, всё созданное в текущей сессии для команд не существовало:
 * `"server not in local cache"` / `"domain not in local cache"`.
 *
 * Синхронизируемся защитно ПЕРЕД вызовом команды, а не в `onSuccess` каждой
 * создающей мутации: сущности меняют не только шесть «главных» хуков, но и
 * bulk-эндпоинты (`/domains/bulk`, `bulk-assign-server`, `bulk-import`, …) и
 * другое устройство того же пользователя — перечислять их все значило бы
 * гарантированно что-то забыть. Плюс `sync_now` инкрементальный (тянет только
 * строки новее `last_version`), так что вызов перед командой дешёвый.
 */

let inFlight: Promise<void> | null = null;

async function pull(userId: string): Promise<void> {
  try {
    // ВАЖНО: ключи аргументов Tauri v2 — camelCase (`rename_all` по умолчанию),
    // поэтому `userId`, а не `user_id`.
    await invokeIfTauri<number>("sync_now", { userId });
  } catch {
    // Кэш мог быть не инициализирован (SyncHandle пуст) — например, если
    // sync_init на логине не прошёл. Пробуем поднять его и повторить один раз.
    try {
      await invokeIfTauri("sync_init", { userId });
      await invokeIfTauri<number>("sync_now", { userId });
    } catch {
      // Синхронизация — best-effort: она НЕ должна ронять действие, ради
      // которого её вызвали. Если кэш остался устаревшим, команда сама скажет
      // "… not in local cache".
    }
  }
}

/**
 * Подтянуть свежие данные в локальный кэш. Вне Tauri — no-op. Никогда не
 * бросает. Параллельные вызовы разделяют один запрос.
 */
export async function syncLocalCache(): Promise<void> {
  if (!isTauri()) return;
  const userId = useAuthStore.getState().userId;
  if (!userId) return;
  if (!inFlight) {
    inFlight = pull(userId).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * Вызвать Tauri-команду, предварительно обновив локальный кэш.
 *
 * Использовать для команд, которые резолвят сущность из кэша (provision,
 * install_fastpanel, cf_*, registrar_*). Для `api_request` (прокси HTTP) не
 * нужно — он в кэш не ходит.
 */
export async function invokeSynced<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await syncLocalCache();
  return invokeIfTauri<T>(cmd, args);
}
