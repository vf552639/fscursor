import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore } from "./auth";

describe("authStore", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
  });

  it("sets and clears user", () => {
    useAuthStore.getState().setUser("u1", "u@e.com");
    expect(useAuthStore.getState().userId).toBe("u1");
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().userId).toBeNull();
  });

  it("clears the vault key on setUnlocked(false)", () => {
    useAuthStore.getState().setVaultKey(new Uint8Array([1, 2, 3]));
    expect(useAuthStore.getState().vaultKey).not.toBeNull();
    useAuthStore.getState().setUnlocked(false);
    expect(useAuthStore.getState().vaultKey).toBeNull();
  });

  it("wipes the key it drops, not just the reference to it", () => {
    // Отпущенный ссылкой ключ лежит в куче до сборки мусора; правило «сначала
    // fill(0)» держат все мутаторы файла, и сеттер — не исключение.
    const first = new Uint8Array([1, 2, 3]);
    useAuthStore.getState().setVaultKey(first);
    useAuthStore.getState().setVaultKey(new Uint8Array([4, 5, 6]));
    expect([...first]).toEqual([0, 0, 0]);

    const second = useAuthStore.getState().vaultKey!;
    useAuthStore.getState().clearVaultKey();
    expect([...second]).toEqual([0, 0, 0]);
  });

  it("does not wipe the key it is being handed when it is already the current one", () => {
    // `setVaultKey(k)` дважды с одной ссылкой обнулил бы k «предыдущим» и оставил
    // в сторе нули — разблокировку, которая выглядит удачной и ничего не расшифровывает.
    const k = new Uint8Array([7, 8, 9]);
    useAuthStore.getState().setVaultKey(k);
    useAuthStore.getState().setVaultKey(k);
    expect([...useAuthStore.getState().vaultKey!]).toEqual([7, 8, 9]);
  });
});
