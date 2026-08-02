import { describe, it, expect } from "vitest";
import { ApiError } from "../api/client";
import { describeQueryError } from "./queryError";

describe("describeQueryError", () => {
  it("reports 401 as an auth problem, not a schema problem", () => {
    const d = describeQueryError(new ApiError(401, "unauthorized"));
    expect(d.title).toMatch(/sign in|not signed in|session/i);
    expect(d.title).not.toMatch(/schema|alembic/i);
    expect(d.hint).not.toMatch(/alembic/i);
  });

  it("keeps the alembic hint for 5xx, where a stale schema actually shows up", () => {
    const d = describeQueryError(new ApiError(500, "boom"));
    expect(d.title).toMatch(/500/);
    expect(d.hint).toMatch(/alembic/i);
  });

  it("calls a network failure a backend availability problem", () => {
    const d = describeQueryError(new ApiError(0, "Network Error"));
    expect(d.title).toMatch(/unavailable/i);
    expect(d.hint).toMatch(/docker compose/i);
  });

  it("surfaces the status code for other failures", () => {
    expect(describeQueryError(new ApiError(403, "forbidden")).title).toMatch(/403/);
  });

  it("does not throw on a non-ApiError value", () => {
    expect(describeQueryError(new Error("nope")).message).toBeTruthy();
    expect(describeQueryError(undefined).message).toBeTruthy();
  });
});
