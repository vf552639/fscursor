import { u8ToB64 } from "./b64";
import { requireDesktop } from "./runtime";
import { invokeIfTauri } from "./tauri-invoke";
import { useAuthStore } from "../store/auth";

/**
 * Единственный путь записи секретов в хранилище блобов. До него формы слали
 * плейнтекстовые поля (`ssh_password`, `api_token`, …), которых нет в
 * Pydantic-схемах: сервер их молча выбрасывал, `*_blob_id` оставался NULL, а
 * все 26 Tauri-команд потом падали на «server has no ssh_password_blob_id».
 */

/**
 * Значения `blob_kind` — свободная строка до 64 символов на бэкенде, поэтому
 * конвенцию задаём здесь и держим в одном месте: имя вида повторяет колонку
 * сущности (`ssh_password_blob_id` → `server_ssh_password`), чтобы по
 * audit-логу было видно, какой именно секрет переписали. Формы обязаны брать
 * вид отсюда, а не набирать литерал заново — опечатка в нём не сломает запись,
 * но навсегда разъедет метаданные.
 */
export const BLOB_KIND = {
  serverSshPassword: "server_ssh_password",
  serverFastpanelPassword: "server_fastpanel_password",
  registrarApiKey: "registrar_api_key",
  registrarApiSecret: "registrar_api_secret",
  cloudflareApiToken: "cloudflare_api_token",
} as const;

export type BlobKind = (typeof BLOB_KIND)[keyof typeof BLOB_KIND];

function newBlobId(): string {
  // `randomUUID` нет в non-secure context (webview на голом http), а тихо
  // сгенерить кривой id нельзя: он уедет в БД ссылкой на секрет. Фоллбэк —
  // тот же v4 из getRandomValues, который есть везде.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Зашифровать секрет и положить в блоб. Возвращает `blob_id`, который вызвавшая
 * форма кладёт в `*_blob_id` сущности.
 *
 * Только десктоп: шифрует Rust мастер-ключом из системного keychain, и ключ
 * там же и остаётся — веб физически не может выполнить эту запись, поэтому
 * запрет объясняем общей продуктовой фразой `requireDesktop`, а не своей.
 *
 * `existingBlobId` при правке ОБЯЗАТЕЛЕН к переиспользованию: версии блоба
 * ведёт сервер внутри одного id, а новый id оставил бы сущность со ссылкой на
 * старый пароль и осиротевший блоб в придачу.
 *
 * Плейнтекст едет в base64 (команда сама его расшифрует и зашифрует), причём
 * через TextEncoder, а не `btoa`: `btoa` бросает на любом не-latin1 символе —
 * то есть на кириллическом пароле или эмодзи в токене.
 */
export async function putSecretBlob(
  plaintext: string,
  blobKind: string,
  existingBlobId?: string | null,
): Promise<string> {
  requireDesktop("Saving secrets");
  const userId = useAuthStore.getState().userId;
  if (!userId) {
    throw new Error("Desktop: unlock session (user id missing)");
  }
  const blobId = existingBlobId || newBlobId();
  // Ключи аргументов Tauri v2 — camelCase (`rename_all` по умолчанию).
  await invokeIfTauri<void>("vault_put_blob", {
    userId,
    blobId,
    blobKind,
    plaintextB64: u8ToB64(new TextEncoder().encode(plaintext)),
  });
  return blobId;
}

/**
 * Удалить блоб (снятие секрета с сущности). Тоже только десктоп: веб read-only,
 * и удаление секрета — такая же мутация, как его запись.
 */
export async function deleteSecretBlob(blobId: string): Promise<void> {
  requireDesktop("Deleting secrets");
  await invokeIfTauri<void>("vault_delete_blob", { blobId });
}
