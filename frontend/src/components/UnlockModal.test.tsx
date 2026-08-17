import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { UnlockModal } from "./UnlockModal";
import { useAuthStore } from "../store/auth";
import { ApiError } from "../api/client";
import { b64ToU8, u8ToB64 } from "../lib/b64";
import { FIXTURE_KEK_HEX, FIXTURE_VK_HEX, WRAPPED_VK_B64, toHex } from "../lib/vaultKeyFixture";

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    apiGet: (url: string) => apiGet(url),
    apiPost: (url: string, body?: unknown) => apiPost(url, body),
  };
});

/**
 * Argon2id считается секунды — в тесте это только шум: проверяется не KDF (на него есть
 * вектор в `lib/crypto.test.ts`), а то, ЧТО кладётся в стор. Поэтому подменён ровно вывод
 * ключа, а `unwrapVaultKey` остаётся настоящим — иначе тест перестал бы что-либо доказывать.
 *
 * Массив свежий на каждый вызов и запоминается в `kek.last`: без этого нечем проверить,
 * что модалка его гасит (`vi.hoisted` — потому что фабрика `vi.mock` поднимается выше
 * объявлений файла).
 */
const kek = vi.hoisted(() => ({ last: null as Uint8Array | null }));

vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  const { fromHex, FIXTURE_KEK_HEX } = await import("../lib/vaultKeyFixture");
  return {
    ...actual,
    deriveMasterKey: async () => {
      kek.last = fromHex(FIXTURE_KEK_HEX);
      return kek.last;
    },
  };
});

const ZERO_SALT_B64 = btoa(String.fromCharCode(...new Uint8Array(16)));

function unlockWith(password: string) {
  render(<UnlockModal onClose={() => {}} />);
  fireEvent.change(document.querySelector("input[type=password]") as HTMLInputElement, {
    target: { value: password },
  });
  // Именно кнопка: «Unlock» есть ещё и в заголовке модалки.
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
}

describe("UnlockModal", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    kek.last = null;
    useAuthStore.getState().clear();
    useAuthStore.getState().setUser("u-1", "owner@example.com");
  });

  // См. RecoveryPhraseCard.test.tsx: `globals` у vitest выключен, автоочистки RTL нет.
  afterEach(cleanup);

  it("puts the vault key in the store, not the key derived from the password", async () => {
    apiGet.mockResolvedValue({ salt_b64: ZERO_SALT_B64, wrapped_vault_key_b64: WRAPPED_VK_B64 });

    unlockWith("hunter2");

    await waitFor(() => expect(hexOfStoredKey()).toBe(FIXTURE_VK_HEX));
    // Соль берётся одним аутентифицированным вызовом, а не анонимным /auth/login/start:
    // там она отдаётся по email и без сессии.
    expect(apiGet).toHaveBeenCalledWith("/auth/me");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("wipes the KEK once the vault key is out of the wrapper", async () => {
    apiGet.mockResolvedValue({ salt_b64: ZERO_SALT_B64, wrapped_vault_key_b64: WRAPPED_VK_B64 });

    unlockWith("hunter2");

    await waitFor(() => expect(hexOfStoredKey()).toBe(FIXTURE_VK_HEX));
    // Единственная строка во всей разблокировке, поломка которой не видна ничем:
    // ключ, выведенный из пароля, просто остался бы лежать в куче вкладки.
    expect(toHex(kek.last!)).toBe("00".repeat(32));
  });

  it("falls back to the password-derived key when the account has no wrapper yet", async () => {
    apiGet.mockResolvedValue({ salt_b64: ZERO_SALT_B64, wrapped_vault_key_b64: null });

    unlockWith("hunter2");

    // До перехода VK := KEK, и блобы такого аккаунта зашифрованы именно им, —
    // гасить его на этой ветке было бы разблокировкой в нули.
    await waitFor(() => expect(hexOfStoredKey()).toBe(FIXTURE_KEK_HEX));
  });

  it("explains a wrapper the password cannot open instead of «decrypt failed»", async () => {
    // Обёртка, выпущенная под ДРУГИМ паролем, — байт в шифротексте отличается, длина та же.
    const other = b64ToU8(WRAPPED_VK_B64);
    other[30] ^= 0x01;
    apiGet.mockResolvedValue({ salt_b64: ZERO_SALT_B64, wrapped_vault_key_b64: u8ToB64(other) });

    unlockWith("hunter2");

    expect(await screen.findByText(/recovery phrase/i)).toBeTruthy();
    expect(screen.queryByText(/decrypt failed/i)).toBeNull();
    // Полуоткрытое состояние хуже закрытого: ключ в сторе означал бы «разблокировано».
    expect(useAuthStore.getState().vaultKey).toBeNull();
  });

  it("says the session expired on 401, instead of blaming the password", async () => {
    // `/auth/me` аутентифицирован — на протухшей сессии он отдаёт 401, и сырой `detail`
    // бэкенда под полем «Master password» читается как «пароль не тот».
    apiGet.mockRejectedValue(new ApiError(401, "Not authenticated"));

    unlockWith("hunter2");

    expect(await screen.findByText(/session has expired/i)).toBeTruthy();
    expect(screen.queryByText(/Not authenticated/)).toBeNull();
  });
});

function hexOfStoredKey(): string {
  const key = useAuthStore.getState().vaultKey;
  if (!key) throw new Error("no key in store");
  return toHex(key);
}
