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
const EXISTING_ID = "11111111-2222-4333-8444-555555555555";

/**
 * Именно ПОСЛЕДНИЙ вызов: сценарий «правка после создания» шлёт два, и `.find()`
 * молча проверял бы аргументы первого. (`findLast` не берём — `lib` проекта
 * ES2020, метода в типах нет.)
 */
function lastPutArgs(): Record<string, unknown> {
  const calls = mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "vault_put_blob");
  if (calls.length === 0) throw new Error("vault_put_blob не вызывалась");
  return calls[calls.length - 1][1] as Record<string, unknown>;
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

describe("BLOB_KIND", () => {
  it("значения зафиксированы: они уезжают в БД и в audit-метаданные", () => {
    expect(BLOB_KIND).toEqual({
      serverSshPassword: "server_ssh_password",
      serverFastpanelPassword: "server_fastpanel_password",
      registrarApiKey: "registrar_api_key",
      registrarApiSecret: "registrar_api_secret",
      cloudflareApiToken: "cloudflare_api_token",
      domainFtpPassword: "domain_ftp_password",
    });
    // Ограничение колонки `blob_kind` — String(64).
    for (const v of Object.values(BLOB_KIND)) expect(v.length).toBeLessThanOrEqual(64);
  });

  it("компилятор не пускает произвольную строку в blobKind", () => {
    // Проверку делает `tsc --noEmit`: если тип `blobKind` когда-нибудь ослабнет
    // до `string`, директива станет неиспользованной и сборка упадёт. Дыра была
    // реальной — два соседних позиционных `string` позволяли записать сам
    // пароль в `blob_kind` и в `audit_log.metadata`.
    const bad: Parameters<typeof putSecretBlob>[0] = {
      plaintext: "p",
      // @ts-expect-error — сырая строка вместо значения BLOB_KIND.
      blobKind: "s3cret-password",
      existingBlobId: null,
    };
    expect(bad.blobKind).toBe("s3cret-password");
  });
});

describe("putSecretBlob", () => {
  it("новому секрету выдаёт свежий uuid и шлёт camelCase-аргументы", async () => {
    const id = await putSecretBlob({
      plaintext: "s3cret",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: null,
    });

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
    const a = await putSecretBlob({
      plaintext: "a",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: null,
    });
    const b = await putSecretBlob({
      plaintext: "b",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: null,
    });
    expect(a).not.toBe(b);
  });

  it("при правке переиспользует существующий blobId, а не заводит новый", async () => {
    // Версионирование блоба — на сервере: правка обязана перезаписать ТОТ ЖЕ id,
    // иначе у сущности останется ссылка на старую версию секрета.
    const created = await putSecretBlob({
      plaintext: "old-pass",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: null,
    });
    const edited = await putSecretBlob({
      plaintext: "new-pass",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: created,
    });

    expect(edited).toBe(created);
    expect(lastPutArgs()).toEqual({
      userId: "user-1",
      blobId: created,
      blobKind: "server_ssh_password",
      plaintextB64: "bmV3LXBhc3M=",
    });
  });

  it.each([
    ["null", null],
    ['пустая строка (useState("") под id)', ""],
    ["undefined (TS запрещает, но JS-вызов возможен)", undefined],
  ])("existingBlobId = %s считается отсутствующим", async (_name, existing) => {
    const id = await putSecretBlob({
      plaintext: "p",
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: existing as string | null,
    });
    expect(id).toMatch(UUID_V4);
    expect(lastPutArgs().blobId).toBe(id);
  });

  it("не-ASCII пароль доезжает байт в байт (btoa бы упал)", async () => {
    const secret = "Пароль-Ω-🔑-пробел ";
    await putSecretBlob({
      plaintext: secret,
      blobKind: BLOB_KIND.cloudflareApiToken,
      existingBlobId: null,
    });

    const b64 = lastPutArgs().plaintextB64 as string;
    expect(new TextDecoder().decode(b64ToU8(b64))).toBe(secret);
  });

  it("вне Tauri бросает общей фразой и не зовёт команду", async () => {
    setTauri(false);
    await expect(
      putSecretBlob({
        plaintext: "s",
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
      }),
    ).rejects.toThrow(/runs in the SDMP desktop app/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("без userId бросает и не зовёт команду", async () => {
    useAuthStore.setState({ userId: null });
    await expect(
      putSecretBlob({
        plaintext: "s",
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
      }),
    ).rejects.toThrow(/user id missing/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });

  it("не глотает падение команды и не отдаёт id", async () => {
    // Иначе форма сохранила бы сущность со ссылкой на несуществующий блоб —
    // ровно тот итог, ради устранения которого модуль и заведён.
    mocks.invokeIfTauri.mockRejectedValueOnce(new Error("keychain locked"));
    await expect(
      putSecretBlob({
        plaintext: "s",
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
      }),
    ).rejects.toThrow(/keychain locked/);
  });

  it("генерит валидный уникальный uuid v4 и без crypto.randomUUID", async () => {
    // Моделируем non-secure context ИМЕННО через own-свойство-заглушку:
    // `delete crypto.randomUUID` был бы no-op, метод живёт на Crypto.prototype,
    // и фоллбэк-ветка просто не исполнилась бы (ревью T1).
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    expect(crypto.randomUUID).toBeUndefined();
    try {
      const args = {
        plaintext: "s",
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
      };
      const a = await putSecretBlob(args);
      const b = await putSecretBlob(args);
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
    // Настоящий uuid: на бэкенде `blob_id` — path-параметр `uuid.UUID`, и
    // фикстура вида "abc-123" учила бы формату, на котором прилетит 422.
    await deleteSecretBlob(EXISTING_ID);
    expect(mocks.invokeIfTauri).toHaveBeenCalledWith("vault_delete_blob", { blobId: EXISTING_ID });
  });

  it("вне Tauri бросает и не зовёт команду", async () => {
    setTauri(false);
    await expect(deleteSecretBlob(EXISTING_ID)).rejects.toThrow(/runs in the SDMP desktop app/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
  });
});
