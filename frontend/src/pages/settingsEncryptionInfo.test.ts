import { describe, expect, it } from "vitest";
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";

describe("ENCRYPTION_INFO", () => {
  const flat = JSON.stringify([ENCRYPTION_BANNER, ...ENCRYPTION_INFO]);

  it("describes the real zero-knowledge model", () => {
    expect(flat).toContain("Argon2id");
    // The desktop (crypto/aead.rs) and browser (lib/crypto.ts) implementations both
    // call libsodium's `crypto_secretbox_easy`, i.e. the classic NaCl secretbox
    // construction — XSalsa20-Poly1305, NOT the XChaCha20-Poly1305 AEAD construction.
    expect(flat).toContain("XSalsa20-Poly1305");
    expect(flat).toContain("secretbox");
  });

  it("does not mention the obsolete AES/ENCRYPTION_KEY model", () => {
    expect(flat).not.toContain("AES-256-GCM");
    expect(flat).not.toContain("ENCRYPTION_KEY");
    expect(flat).not.toContain("SHA-256");
  });

  it("does not misname the AEAD construction as XChaCha20-Poly1305", () => {
    // secretbox (XSalsa20-Poly1305) and the XChaCha20-Poly1305 AEAD are related but
    // distinct constructions; the codebase uses the former, so the copy must not claim
    // the latter.
    expect(flat).not.toContain("XChaCha20-Poly1305");
  });
});
