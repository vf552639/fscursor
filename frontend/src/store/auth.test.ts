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
});
