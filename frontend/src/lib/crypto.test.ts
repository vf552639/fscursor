import { describe, it, expect } from "vitest";
import { decryptBlob, deriveMasterKey, encryptBlob } from "./crypto";

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
