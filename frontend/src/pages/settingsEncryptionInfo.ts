/**
 * Copy for the Settings "Encryption" tab, kept out of the JSX so it can be unit-tested.
 *
 * The claims here are verified against the actual implementation, not copied from a plan:
 *  - Key derivation: `desktop/src-tauri/src/crypto/kdf.rs` and `frontend/src/lib/crypto.ts`
 *    both derive keys with Argon2id (dryoc `pwhash` on desktop, `argon2-browser` on web),
 *    using per-purpose domain-separation contexts ("sdmp-auth-key-v1" / "sdmp-master-key-v1").
 *  - Encryption: `desktop/src-tauri/src/crypto/aead.rs` and `frontend/src/lib/crypto.ts` both
 *    call libsodium's `crypto_secretbox_easy` — the classic NaCl "secretbox" construction,
 *    which is XSalsa20-Poly1305. This is NOT the XChaCha20-Poly1305 AEAD construction (a
 *    related but different libsodium API, `crypto_aead_xchacha20poly1305_ietf_*`) — the two
 *    share a 24-byte nonce size but use different stream ciphers, so they must not be
 *    conflated in the UI copy.
 *  - Where it runs: both the desktop app (russh/Tauri) and the web panel derive keys and
 *    encrypt/decrypt entirely client-side — see `frontend/src/components/RevealSecret.tsx`
 *    and `frontend/src/components/UnlockModal.tsx`, which call `deriveMasterKey`/`decryptBlob`
 *    in the browser and never send the password or master key to the server.
 *  - What the server stores: `backend/app/blobs/models.py` (`BlobStorage`) persists only a
 *    `ciphertext` column plus metadata (kind/version/device/timestamps) — no plaintext, no key.
 *  - Where the key lives: `desktop/src-tauri/src/keychain/mod.rs` stores the derived master
 *    key in the OS keychain (via the `keyring` crate) on desktop; on web it lives only in
 *    memory for the current browser tab (see `UnlockModal.tsx`), never persisted server-side.
 */

export const ENCRYPTION_BANNER = {
  title: "Zero-Knowledge Encryption Active",
  body:
    "Secrets are encrypted on your device — desktop app or browser — before they ever reach the " +
    "server. The master key is derived from your password with Argon2id and never leaves the " +
    "client; the server stores only opaque ciphertext blobs.",
};

export const ENCRYPTION_INFO: ReadonlyArray<readonly [string, string]> = [
  ["Algorithm", "libsodium secretbox — XSalsa20-Poly1305 authenticated encryption"],
  ["Key Derivation", "Argon2id, client-side, derived from your password"],
  ["Stored Fields", "SSH passwords, FastPanel passwords, registrar/Cloudflare API keys, tokens"],
  ["Where It Runs", "Desktop app and web panel both encrypt/decrypt locally, never server-side"],
  ["Server Sees", "Opaque ciphertext blobs and metadata only — never plaintext or keys"],
];
