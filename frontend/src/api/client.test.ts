import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { apiGet, apiPost, ApiError } from "./client";

function enterTauri() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
}
function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe("api client — desktop routes HTTP through the Rust session", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enterTauri();
  });
  afterEach(exitTauri);

  it("routes GET through the api_request command and returns the body", async () => {
    invokeMock.mockResolvedValue({ status: 200, body: [{ id: "s1" }] });
    const out = await apiGet<Array<{ id: string }>>("/servers");
    expect(invokeMock).toHaveBeenCalledWith("api_request", {
      method: "GET",
      path: "/servers",
      body: null,
    });
    expect(out).toEqual([{ id: "s1" }]);
  });

  it("folds config.params into the path (skipping null/undefined)", async () => {
    invokeMock.mockResolvedValue({ status: 200, body: [] });
    await apiGet("/domains", { params: { server_id: "x", q: "a b", skip: undefined } });
    expect(invokeMock).toHaveBeenCalledWith("api_request", {
      method: "GET",
      path: "/domains?server_id=x&q=a+b",
      body: null,
    });
  });

  it("routes POST with its body through api_request", async () => {
    invokeMock.mockResolvedValue({ status: 200, body: { ok: true } });
    await apiPost("/settings/config", { key: "v" });
    expect(invokeMock).toHaveBeenCalledWith("api_request", {
      method: "POST",
      path: "/settings/config",
      body: { key: "v" },
    });
  });

  it("surfaces a non-2xx response as ApiError carrying the status", async () => {
    invokeMock.mockResolvedValue({ status: 401, body: { detail: "missing session" } });
    const err = await apiGet("/servers").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
