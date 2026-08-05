import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./runtime";

/**
 * Превратить то, чем реджектнулась Tauri-команда, в `Error` с читаемым текстом.
 *
 * `CommandError` в Rust — енум с `#[derive(Serialize)]` и без `#[serde(tag)]`,
 * поэтому наружу он уходит объектом `{"Keychain": "locked"}`: `thiserror`
 * рисует «keychain: locked» через `Display`, а serde про `Display` не знает.
 * Вызывающие же проверяют `e instanceof Error && e.message` — объект в эту
 * проверку не проходил и подменялся общей фразой вида «Could not save SSH
 * password».
 *
 * Цена подмены не косметическая: настоящая причина («мастер-ключ не найден в
 * keychain — войди заново») терялась целиком, и у пользователя не оставалось
 * ни одного способа узнать, что делать. Поэтому текст собираем здесь, в одной
 * точке на все команды, а не в каждой форме по-своему.
 *
 * Формат «вариант: деталь» повторяет `Display` из `thiserror`, чтобы сообщение
 * на экране совпадало с тем, что Rust пишет в свой лог, — иначе одну и ту же
 * причину пришлось бы искать по двум разным формулировкам.
 */
export function formatInvokeError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === "string") return new Error(raw);
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>);
    // Ровно один ключ — это вариант енума: `{Keychain: "locked"}`.
    if (entries.length === 1) {
      const [variant, payload] = entries[0];
      const name = variant.toLowerCase();
      if (payload === null || payload === undefined || payload === "") return new Error(name);
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      return new Error(`${name}: ${detail}`);
    }
    // Незнакомая форма: JSON лучше, чем `[object Object]` — по нему хотя бы
    // видно, что именно пришло.
    return new Error(JSON.stringify(raw));
  }
  return new Error(String(raw));
}

export async function invokeIfTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`${cmd} requires the desktop app`);
  }
  try {
    return await invoke<T>(cmd, args as Record<string, unknown>);
  } catch (raw: unknown) {
    throw formatInvokeError(raw);
  }
}
