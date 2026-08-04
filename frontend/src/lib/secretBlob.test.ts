import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { putSecretBlob, deleteSecretBlob, BLOB_KIND } from "./secretBlob";
import { b64ToU8 } from "./b64";
import { useAuthStore } from "../store/auth";

/**
 * Единственный путь записи секрета. Ломается он тихо: перепутанный регистр
 * ключа аргумента или `btoa` вместо TextEncoder не роняют вызов, а дают
 * `blob_id = NULL` либо блоб, который десктоп потом не расшифрует в исходный
 * пароль. Поэтому тесты смотрят не «позвали ли команду», а ЧТО именно уехало
 * в неё: имена ключей и байты плейнтекста.
 */

const mocks = vi.hoisted(() => ({ invokeIfTauri: vi.fn() }));

vi.mock("./tauri-invoke", () => ({ invokeIfTauri: mocks.invokeIfTauri }));

// `runtime` намеренно НЕ мокается: проверка десктопа должна быть настоящей,
// иначе тест «вне Tauri бросает» перестанет ловить снятый guard.
function setTauri(on: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lastPutArgs(): Record<string, unknown> {
  const call = mocks.invokeIfTauri.mock.calls.find((c) => c[0] === "vault_put_blob");
  if (!call) throw new Error("vault_put_blob не вызывалась");
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  setTauri(true);
  useAuthStore.setState({ userId: "user-1", email: "u@e.x" });
});

afterEach(() => {
  setTauri(false);
  useAuthStore.getState().clear();
});

describe("putSecretBlob", () => {
  it("новому секрету выдаёт свежий uuid и шлёт camelCase-аргументы", async () => {
    const id = await putSecretBlob("s3cret", BLOB_KIND.serverSshPassword);

    expect(id).toMatch(UUID_V4);
    expect(mocks.invokeIfTauri).toHaveBeenCalledTimes(1);
    expect(mocks.invokeIfTauri.mock.calls[0][0]).toBe("vault_put_blob");
    expect(lastPutArgs()).toEqual({
      userId: "user-1",
      blobId: id,
      blobKind: "server_ssh_password",
      plaintextB64: "czNjcmV0",
    });
  });

  it("двум новым секретам выдаёт разные id", async () => {
    const a = await putSecretBlob("a", BLOB_KIND.serverSshPassword);
    const b = await putSecretBlob("b", BLOB_KIND.serverSshPassword);
    expect(a).not.toBe(b);
  });

  it("при правке переиспользует существующий blobId, а не заводит новый", async () => {
    // Версионирование блоба — на сервере: правка обязана перезаписать ТОТ ЖЕ id,
    // иначе у сущности останется ссылка на старую версию секрета.
    const existing = "11111111-2222-4333-8444-555555555555";
    const id = await putSecretBlob("new-pass", BLOB_KIND.serverSshPassword, existing);

    expect(id).toBe(existing);
    expect(lastPutArgs().blobId).toBe(existing);
  });

  it("пустой existingBlobId считает отсутствующим", async () => {
    const id = await putSecretBlob("p", BLOB_KIND.serverSshPassword, null);
    expect(id).toMatch(UUID_V4);
  });

  it("не-ASCII пароль доезжает байт в байт (btoa бы упал)", async () => {
    const secret = "Пароль-Ω-🔑-пробел ";
    await putSecretBlob(secret, BLOB_KIND.cloudflareApiToken);

    const b64 = lastPutArgs().plaintextB64 as string;
    expect(new TextDecoder().decode(b64ToU8(b64))).toBe(secret);
  });

  it("вне Tauri бросает общей фразой и не зовёт команду", async () => {
    setTauri(false);
    await expect(putSecretBlob("s", BLOB_KIND.serverSshPassword)).rejects.toThrow(
      /runs in the SDMP desktop app/,
    );
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("без userId бросает и не зовёт команду", async () => {
    useAuthStore.setState({ userId: null });
    await expect(putSecretBlob("s", BLOB_KIND.serverSshPassword)).rejects.toThrow(/user id missing/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("генерит валидный уникальный uuid v4 и без crypto.randomUUID", async () => {
    // Моделируем non-secure context ИМЕННО через own-свойство-заглушку:
    // `delete crypto.randomUUID` был бы no-op, метод живёт на Crypto.prototype,
    // и фоллбэк-ветка просто не исполнилась бы (ревью T1).
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    expect(crypto.randomUUID).toBeUndefined();
    try {
      const a = await putSecretBlob("s", BLOB_KIND.serverSshPassword);
      const b = await putSecretBlob("s", BLOB_KIND.serverSshPassword);
      // Формат проверяем полным regex'ом: биты версии и варианта — часть id,
      // который уедет в БД ссылкой на секрет, константа или v-less строка тут
      // должны падать.
      expect(a).toMatch(UUID_V4);
      expect(b).toMatch(UUID_V4);
      expect(a).not.toBe(b);
    } finally {
      // Снимаем own-заглушку — прототипный метод возвращается сам.
      delete (crypto as Partial<Crypto>).randomUUID;
    }
    expect(typeof crypto.randomUUID).toBe("function");
  });
});

describe("deleteSecretBlob", () => {
  it("передаёт { blobId }", async () => {
    await deleteSecretBlob("abc-123");
    expect(mocks.invokeIfTauri).toHaveBeenCalledWith("vault_delete_blob", { blobId: "abc-123" });
  });

  it("вне Tauri бросает и не зовёт команду", async () => {
    setTauri(false);
    await expect(deleteSecretBlob("abc-123")).rejects.toThrow(/runs in the SDMP desktop app/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });
});
