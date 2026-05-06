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

  it("clears master key on setUnlocked(false)", () => {
    useAuthStore.getState().setMasterKey(new Uint8Array([1, 2, 3]));
    expect(useAuthStore.getState().masterKey).not.toBeNull();
    useAuthStore.getState().setUnlocked(false);
    expect(useAuthStore.getState().masterKey).toBeNull();
  });
});
