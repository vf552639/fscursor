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
 * audit-логу было видно, какой именно секрет переписали. Значения — часть
 * wire-контракта: опечатка в литерале не сломает запись (сервер примет любую
 * строку), а молча разъедет метаданные, поэтому набирать их заново нельзя —
 * `putSecretBlob` принимает только `BlobKind`, и компилятор это держит.
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
 * Аргумент — объект, а не три позиционных значения, по двум причинам, и обе
 * про молчаливую порчу данных. Позиционные `plaintext`/`blobKind` были двумя
 * соседними `string`: перепутанный порядок компилировался, проходил серверную
 * валидацию (1..64 символа — пароль укладывается) и писал плейнтекст в
 * `blob_storage.blob_kind` И в `audit_log.metadata`. А `existingBlobId` был
 * опциональным хвостом: вызов, скопированный из формы создания в форму правки,
 * компилировался, показывал «сохранено» и оставлял сущность со ссылкой на
 * старый пароль.
 *
 * Поэтому `blobKind` — union `BlobKind` (только значения `BLOB_KIND`), а
 * `existingBlobId` обязателен и nullable: на создании надо написать `null`
 * руками, и это ровно тот момент, когда автор формы смотрит на поле сущности.
 * При правке переиспользовать существующий id ОБЯЗАТЕЛЬНО: версии блоба ведёт
 * сервер внутри одного id.
 *
 * Порядок вызова: сначала `putSecretBlob`, потом сохранение сущности с
 * полученным id. Если сохранение сущности упало — блоб остался записанным, и
 * откатывать его `deleteSecretBlob` в `catch` НЕЛЬЗЯ: на правке это снесёт
 * живой секрет, на который ещё указывает рабочая ссылка. Осиротевший блоб
 * безвреден, а повтор сохранения переиспользует тот же id.
 *
 * Плейнтекст нельзя гонять через react-query: `useMutation({ mutationFn: (v:
 * { password: string }) => … })` кладёт пароль в `variables` мутации, откуда
 * его не убирает даже `reset()` — та же ловушка, что описана про `data` в
 * `useInstallFastPanel`. В мутацию отдавать уже полученный `blobId`, а
 * плейнтекст — аргументом функции.
 *
 * Плейнтекст едет в base64 (команда его раскодирует и уже потом зашифрует),
 * причём через TextEncoder, а не `btoa`: `btoa` бросает на любом не-latin1
 * символе — то есть на кириллическом пароле или эмодзи в токене.
 */
export async function putSecretBlob(args: {
  plaintext: string;
  blobKind: BlobKind;
  /** `null` — новый секрет; при правке ОБЯЗАТЕЛЬНО текущий `*_blob_id`. */
  existingBlobId: string | null;
}): Promise<string> {
  const { plaintext, blobKind, existingBlobId } = args;
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
 *
 * Только для осознанного снятия секрета пользователем. НЕ для отката упавшего
 * сохранения сущности — почему, см. `putSecretBlob`.
 */
export async function deleteSecretBlob(blobId: string): Promise<void> {
  requireDesktop("Deleting secrets");
  await invokeIfTauri<void>("vault_delete_blob", { blobId });
}

/**
 * Убрать блобы удалённой сущности. Порядок ОБРАТЕН записи: сначала сущность,
 * потом блобы. Наоборот — живая сущность со ссылкой на стёртый блоб, если
 * удаление не доехало: секрет числится настроенным, а команды падают на
 * расшифровке. Остаток этого порядка — осиротевший блоб, он безвреден
 * (`putSecretBlob`), поэтому провал глотаем и на первом id не останавливаемся.
 *
 * Почему провал не показывается пользователю: сущность к этому моменту уже
 * удалена, и красное на ней — это вопрос «так удалилась или нет?», ответа на
 * который у человека нет, а действия по нему — тем более. Осиротевший блоб —
 * мусор, а не утечка: он зашифрован тем же мастер-ключом, ссылаться на него
 * больше некому, и прочитать его нельзя ни из веба, ни из десктопа.
 *
 * ВАЖНО: удаление сущности ИЗ БРАУЗЕРА оставляет её блобы навсегда — кнопки
 * удаления в вебе живые, а `deleteSecretBlob` там бросает `requireDesktop` в
 * тот же `catch`. Уборка есть только в десктопе; след — один `console.warn`.
 */
export async function forgetSecretBlobs(blobIds: (string | null | undefined)[]): Promise<void> {
  for (const blobId of blobIds) {
    if (!blobId) continue;
    try {
      await deleteSecretBlob(blobId);
    } catch (e: unknown) {
      // Только в консоль: id — не секрет, а сам факт нужен, когда в хранилище
      // потом находят блоб без хозяина.
      console.warn(`orphan secret blob ${blobId}:`, e);
    }
  }
}
