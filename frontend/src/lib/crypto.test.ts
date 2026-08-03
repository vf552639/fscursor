import { describe, it, expect } from "vitest";
import {
  decryptBlob,
  deriveMasterKey,
  deriveRecoveryAuthKey,
  encryptBlob,
  normalizeRecoveryPhrase,
} from "./crypto";

/** Same fixture as `desktop/src-tauri/src/crypto/kdf.rs`. */
const FIXTURE_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("browser crypto", () => {
  it(
    "derives the same master key as desktop for hunter2 + zero salt",
    async () => {
      const salt = new Uint8Array(16);
      const key = await deriveMasterKey("hunter2", salt);
      const hex = [...key].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(hex).toBe("cf3489cf8dfa53ec6604068c99f63760b1c8faa9772c0862c2acd81fac43a7a4");
    },
    60_000
  );

  it(
    "derives the same recovery auth key as desktop for the fixture phrase",
    async () => {
      const key = await deriveRecoveryAuthKey(FIXTURE_PHRASE);
      expect(b64(key)).toBe("reJBXXNBI6uFBH1umkSAzylaw8qSkV8PA2GPnlSBa+k=");
    },
    60_000
  );

  it("normalizes case and whitespace before deriving the recovery auth key", async () => {
    expect(normalizeRecoveryPhrase("  Abandon\tABANDON\n  art  ")).toBe("abandon abandon art");
  });

  it("roundtrips secretbox framing compatible with desktop", async () => {
    const key = new Uint8Array(32);
    key.fill(7);
    const pt = new Uint8Array(utf8("top secret SSH password"));
    const framed = await encryptBlob(pt, key);
    const out = await decryptBlob(framed, key);
    expect([...out]).toEqual([...pt]);
  });
});

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
