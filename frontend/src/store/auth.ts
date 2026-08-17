import { create } from "zustand";

interface AuthState {
  userId: string | null;
  email: string | null;
  /** Desktop vault unlocked (Tauri); ignored for web session gating. */
  unlocked: boolean;
  /**
   * Ephemeral web-only vault key (VK) — the 32 bytes the blobs are actually encrypted
   * with. `UnlockModal` derives a KEK from the password, unwraps the VK with it and puts
   * the result here; cleared on lock / idle. For an account created before the vault-key
   * change the server reports no wrapper and VK == KEK, which changes what the bytes are,
   * not what this field means.
   */
  vaultKey: Uint8Array | null;
  setUser: (userId: string, email: string) => void;
  setUnlocked: (v: boolean) => void;
  setVaultKey: (key: Uint8Array) => void;
  clearVaultKey: () => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  userId: null,
  email: null,
  unlocked: false,
  vaultKey: null,
  setUser: (userId, email) => set({ userId, email }),
  setUnlocked: (v) => {
    if (!v) {
      const k = get().vaultKey;
      if (k) k.fill(0);
      set({ unlocked: false, vaultKey: null });
    } else {
      set({ unlocked: true });
    }
  },
  setVaultKey: (key) => {
    // Тот же порядок «сначала погасить», что и у остальных мутаторов: ключ, который
    // просто отпустили ссылкой, остаётся лежать в куче до сборки мусора. Сейчас сюда
    // дважды подряд не приходят, но исключение из правила, которое сам файл и заводит,
    // — это ровно то, что потом никто не заметит.
    const prev = get().vaultKey;
    if (prev && prev !== key) prev.fill(0);
    set({ vaultKey: key });
  },
  clearVaultKey: () => {
    const k = get().vaultKey;
    if (k) k.fill(0);
    set({ vaultKey: null });
  },
  clear: () => {
    const k = get().vaultKey;
    if (k) k.fill(0);
    set({ userId: null, email: null, unlocked: false, vaultKey: null });
  },
}));

// Explicit `number` (not `ReturnType<typeof window.setTimeout>`): with `@types/node`
// installed, the global `setTimeout` ambient declaration merges with DOM's `Window.setTimeout`,
// and `ReturnType<...>` picks up Node's `Timeout` overload even though the browser call below
// still resolves to (and returns) the DOM overload's `number`.
let idleTimer: number | null = null;

/** Reset the 5-minute idle timer that clears `vaultKey` (web secrets). */
export function bumpVaultKeyActivity(): void {
  if (typeof window === "undefined") return;
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    useAuthStore.getState().clearVaultKey();
  }, 5 * 60 * 1000);
}
