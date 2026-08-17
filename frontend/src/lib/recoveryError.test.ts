import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { describeCommandError, describeRecoveryError } from "./recoveryError";

describe("describeCommandError", () => {
  it("unwraps the serde-tagged Rust CommandError instead of rendering [object Object]", () => {
    expect(describeCommandError({ Api: "api error 401: invalid recovery key" })).toBe(
      "api error 401: invalid recovery key"
    );
    expect(describeCommandError({ Recovery: "invalid mnemonic phrase" })).toBe(
      "invalid mnemonic phrase"
    );
  });

  it("passes through Errors, strings and ApiError", () => {
    expect(describeCommandError(new Error("boom"))).toBe("boom");
    expect(describeCommandError("boom")).toBe("boom");
    expect(describeCommandError(new ApiError(409, "nope"))).toBe("HTTP 409: nope");
  });

  it("turns a locked vault into an instruction, not the bare word «locked»", () => {
    // Так падают `auth_change_password` и `auth_recovery_setup`, когда VK нет в связке:
    // общее правило «один ключ, строка внутри» вернуло бы «locked» дословно.
    const text = describeCommandError({ Keychain: "locked" });
    expect(text).not.toBe("locked");
    expect(text).toMatch(/vault key/i);
    expect(text).toMatch(/sign in with your master password/i);
  });

  it("does not swallow other keychain failures into the same advice", () => {
    // «Связка недоступна» — не «ключа в ней нет»: советовать перелогиниться бессмысленно,
    // и настоящую причину пользователь должен увидеть дословно.
    expect(describeCommandError({ Keychain: "platform secure storage failure" })).toBe(
      "platform secure storage failure"
    );
  });
});

describe("describeRecoveryError", () => {
  it("keeps a wrong phrase and an unknown email indistinguishable on 401", () => {
    const wrongPhrase = describeRecoveryError({ Api: "api error 401: invalid recovery key" });
    const unknownEmail = describeRecoveryError(new ApiError(401, "invalid recovery key"));
    expect(wrongPhrase).toBe(unknownEmail);
    expect(wrongPhrase).toMatch(/does not match that account/);
  });

  it("tells legacy accounts to reconfigure recovery on 409 and 404", () => {
    expect(describeRecoveryError({ Api: "api error 409: recovery is not configured" })).toMatch(
      /set recovery up again/
    );
    expect(describeRecoveryError({ Api: "api error 404: recovery not configured" })).toMatch(
      /set recovery up again/
    );
  });

  it("names the rate limit on 429", () => {
    expect(describeRecoveryError({ Api: "api error 429: Rate limit exceeded" })).toMatch(
      /Wait a minute/
    );
  });

  it("shows the underlying message when there is no HTTP status", () => {
    expect(describeRecoveryError({ Recovery: "invalid mnemonic phrase" })).toBe(
      "invalid mnemonic phrase"
    );
  });
});
