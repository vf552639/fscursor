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

  // 422 от FastAPI приходит СПИСКОМ объектов (`{loc, msg, type}`), а не строкой.
  // `String(detail)` на нём давал пользователю `[object Object]` — сообщение, по
  // которому нельзя понять ни что не так, ни какое поле виновато. Форма ответа
  // взята с живого бэкенда: `POST /api/auth/login/finish` без `auth_key_b64`.
  it("turns a FastAPI 422 detail list into a readable message with the field name", async () => {
    invokeMock.mockResolvedValue({
      status: 422,
      body: {
        detail: [{ type: "missing", loc: ["body", "auth_key_b64"], msg: "Field required" }],
      },
    });
    const err = (await apiPost("/auth/login/finish", {}).catch((e) => e)) as ApiError;
    expect(err.message).not.toContain("[object Object]");
    expect(err.message).toContain("auth_key_b64");
    expect(err.message).toContain("Field required");
  });

  it("joins several validation errors instead of showing only the first", async () => {
    invokeMock.mockResolvedValue({
      status: 422,
      body: {
        detail: [
          { loc: ["body", "email"], msg: "value is not a valid email address" },
          { loc: ["body", "fastpanel_url"], msg: "URL must not carry credentials" },
        ],
      },
    });
    const err = (await apiPost("/servers", {}).catch((e) => e)) as ApiError;
    expect(err.message).toContain("email");
    expect(err.message).toContain("fastpanel_url");
  });

  // Страховка от «починили 422, сломали всё остальное»: строковый detail —
  // самый частый ответ бэкенда (401/403/404), он обязан дойти дословно.
  it("keeps a plain string detail untouched", async () => {
    invokeMock.mockResolvedValue({ status: 401, body: { detail: "invalid credentials" } });
    const err = (await apiGet("/servers").catch((e) => e)) as ApiError;
    expect(err.message).toBe("invalid credentials");
  });
});
