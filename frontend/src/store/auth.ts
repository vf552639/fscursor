import { create } from "zustand";

interface AuthState {
  userId: string | null;
  email: string | null;
  /** Desktop vault unlocked (Tauri); ignored for web session gating. */
  unlocked: boolean;
  /** Ephemeral web-only key for decrypting blobs; cleared on lock / idle. */
  masterKey: Uint8Array | null;
  setUser: (userId: string, email: string) => void;
  setUnlocked: (v: boolean) => void;
  setMasterKey: (key: Uint8Array) => void;
  clearMasterKey: () => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  userId: null,
  email: null,
  unlocked: false,
  masterKey: null,
  setUser: (userId, email) => set({ userId, email }),
  setUnlocked: (v) => {
    if (!v) {
      const k = get().masterKey;
      if (k) k.fill(0);
      set({ unlocked: false, masterKey: null });
    } else {
      set({ unlocked: true });
    }
  },
  setMasterKey: (key) => set({ masterKey: key }),
  clearMasterKey: () => {
    const k = get().masterKey;
    if (k) k.fill(0);
    set({ masterKey: null });
  },
  clear: () => {
    const k = get().masterKey;
    if (k) k.fill(0);
    set({ userId: null, email: null, unlocked: false, masterKey: null });
  },
}));

let idleTimer: ReturnType<typeof window.setTimeout> | null = null;

/** Reset the 5-minute idle timer that clears `masterKey` (web secrets). */
export function bumpMasterKeyActivity(): void {
  if (typeof window === "undefined") return;
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    useAuthStore.getState().clearMasterKey();
  }, 5 * 60 * 1000);
}
