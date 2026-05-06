import { create } from "zustand";

interface AuthState {
  userId: string | null;
  email: string | null;
  unlocked: boolean;
  setUser: (userId: string, email: string) => void;
  setUnlocked: (v: boolean) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  email: null,
  unlocked: false,
  setUser: (userId, email) => set({ userId, email }),
  setUnlocked: (v) => set({ unlocked: v }),
  clear: () => set({ userId: null, email: null, unlocked: false }),
}));
