import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decryptBlob,
  deriveMasterKey,
  deriveRecoveryAuthKey,
  encryptBlob,
  normalizeRecoveryPhrase,
  unwrapVaultKey,
} from "./crypto";
import { b64ToU8 } from "./b64";
import { FIXTURE_KEK_HEX, FIXTURE_VK_HEX, WRAPPED_VK_B64, toHex } from "./vaultKeyFixture";

/** Same fixture as `desktop/src-tauri/src/crypto/kdf.rs`. */
const FIXTURE_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("browser crypto", () => {
  it(
    "derives the same master key as desktop for hunter2 + zero salt",
    async () => {
      const salt = new Uint8Array(16);
      const key = await deriveMasterKey("hunter2", salt);
      expect(toHex(key)).toBe(FIXTURE_KEK_HEX);
    },
    60_000
  );

  it(
    "derives the same recovery auth key as desktop for the fixture phrase",
    async () => {
      const key = await deriveRecoveryAuthKey(FIXTURE_PHRASE);
      expect(b64(key)).toBe("reJBXXNBI6uFBH1umkSAzylaw8qSkV8PA2GPnlSBa+k=");
    },
    60_000
  );

  it("normalizes case and whitespace before deriving the recovery auth key", async () => {
    expect(normalizeRecoveryPhrase("  Abandon\tABANDON\n  art  ")).toBe("abandon abandon art");
  });

  it(
    "unwraps a vault-key wrapper byte-for-byte the way desktop does",
    async () => {
      const kek = await deriveMasterKey("hunter2", new Uint8Array(16));
      const wrapped = b64ToU8(WRAPPED_VK_B64);
      expect(wrapped.length).toBe(72); // nonce 24 + tag 16 + key 32
      const vk = await unwrapVaultKey(wrapped, kek);
      expect(toHex(vk)).toBe(FIXTURE_VK_HEX);
      // Ключ хранилища НЕ равен выведенному из пароля: если бы равнялся, смена
      // пароля снова означала бы потерю всех блобов.
      expect(toHex(vk)).not.toBe(toHex(kek));
    },
    60_000
  );

  it("says the password and the wrapper are out of step, not «decrypt failed»", async () => {
    const wrapped = b64ToU8(WRAPPED_VK_B64);
    const wrongKek = new Uint8Array(32).fill(1);
    await expect(unwrapVaultKey(wrapped, wrongKek)).rejects.toThrow(/recovery phrase/i);
  });

  it("refuses a wrapper that opens into something that is not a 32-byte key", async () => {
    const kek = new Uint8Array(32).fill(5);
    // Открывается тем же ключом, но внутри не ключ: молча принятые 8 байт стали бы
    // «ключом», которым не расшифруется ни один блоб, и виноватым выглядел бы пароль.
    const wrapped = await encryptBlob(new Uint8Array(8), kek);
    await expect(unwrapVaultKey(wrapped, kek)).rejects.toThrow(/wrong length/i);
  });

  it("blames the KEK's length on the KEK, not on the password", async () => {
    // Ключ не той длины libsodium отвергает сам, и раньше этот отказ уезжал в
    // «пароль не тот» — совет про фразу восстановления за баг вызывающего кода.
    const wrapped = b64ToU8(WRAPPED_VK_B64);
    await expect(unwrapVaultKey(wrapped, new Uint8Array(16))).rejects.toThrow(/KEK must be 32/i);
  });

  it("roundtrips secretbox framing compatible with desktop", async () => {
    const key = new Uint8Array(32);
    key.fill(7);
    const pt = new Uint8Array(utf8("top secret SSH password"));
    const framed = await encryptBlob(pt, key);
    const out = await decryptBlob(framed, key);
    expect([...out]).toEqual([...pt]);
  });
});

/**
 * Отдельный describe: тесты внутри подменяют libsodium и потому крутят реестр модулей
 * (`vi.resetModules`), а импорт `./crypto` наверху файла остаётся нетронутым.
 */
describe("unwrapVaultKey when libsodium itself fails to start", () => {
  afterEach(() => {
    vi.doUnmock("libsodium-wrappers");
    vi.resetModules();
  });

  it("lets the init failure through instead of blaming the password", async () => {
    // CSP без `wasm-unsafe-eval`, корпоративный прокси, неверный MIME на `.wasm` — и
    // libsodium не поднимется. Разблокировка — первый вызов криптографии в вебе, так что
    // это сообщение единственное, которое пользователь увидит.
    //
    // Цена подмены его на «пароль не тот» необратима: пользователь идёт в десктоп,
    // проходит восстановление, оно поворачивает соль, пароль И перевыпускает
    // recovery-блоб — записанная на бумаге фраза после этого может не подойти. Сжечь
    // фразу из-за не загрузившегося WASM — ровно тот ущерб, против которого делалась
    // вся фаза.
    vi.resetModules();
    vi.doMock("libsodium-wrappers", () => ({
      default: {
        get ready() {
          return Promise.reject(new Error("wasm blocked by CSP"));
        },
      },
    }));
    const { unwrapVaultKey: unwrap, VAULT_KEY_MISMATCH } = await import("./crypto");

    const err = await unwrap(b64ToU8(WRAPPED_VK_B64), new Uint8Array(32)).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("wasm blocked by CSP");
    expect((err as Error).message).not.toBe(VAULT_KEY_MISMATCH);
  });
});

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
