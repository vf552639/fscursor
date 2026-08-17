/**
 * Copy for the Settings "Encryption" tab, kept out of the JSX so it can be unit-tested.
 *
 * The claims here are verified against the actual implementation, not copied from a plan:
 *  - What encrypts a blob: the vault key (VK) — 32 random bytes minted by
 *    `aead::random_key` in `desktop/src-tauri/src/crypto/aead.rs`, never derived from
 *    anything. The password does NOT encrypt blobs; `deriveMasterKey` /
 *    `kdf::derive_master_key` produce a key-encryption key (KEK) whose only job is the
 *    wrapper `aead(VK, KEK)`, see `unwrap_vault_key_with_kek` in
 *    `desktop/src-tauri/src/commands/auth.rs` and `unwrapVaultKey` in
 *    `frontend/src/lib/crypto.ts`.
 *  - Why that matters for a password change: `POST /auth/password/change`
 *    (`backend/app/auth/routes.py`) takes a NEW wrapper and writes exactly three columns —
 *    `user.salt`, `user.auth_key_hash`, `user.wrapped_vault_key`. Nothing else at all.
 *  - `POST /auth/recovery/finish` writes those same three AND more: it reissues the
 *    recovery blob (`rb.ciphertext = new_blob`), rotates `rb.recovery_auth_key_hash` when
 *    the client sends a new one, and deletes every session the user has. Spelled out
 *    separately because "blob" is overloaded in this codebase — `RecoveryBlob` is one
 *    thing, `BlobStorage` another — and recovery does rewrite the former, always. A flat
 *    "no blob is touched" would be a lie about a file whose only value is that its claims
 *    were checked against the code.
 *  - What NEITHER of them touches is `BlobStorage`, i.e. the secrets: not one row, because
 *    the key inside the wrapper is the same one it was before. That, and nothing else, is
 *    what makes changing the password safe.
 *  - Key derivation: `desktop/src-tauri/src/crypto/kdf.rs` and `frontend/src/lib/crypto.ts`
 *    both derive keys with Argon2id (dryoc `pwhash` on desktop, `argon2-browser` on web),
 *    using per-purpose domain-separation contexts ("sdmp-auth-key-v1" / "sdmp-master-key-v1").
 *  - Encryption: `desktop/src-tauri/src/crypto/aead.rs` and `frontend/src/lib/crypto.ts` both
 *    call libsodium's `crypto_secretbox_easy` — the classic NaCl "secretbox" construction,
 *    which is XSalsa20-Poly1305. This is NOT the XChaCha20-Poly1305 AEAD construction (a
 *    related but different libsodium API, `crypto_aead_xchacha20poly1305_ietf_*`) — the two
 *    share a 24-byte nonce size but use different stream ciphers, so they must not be
 *    conflated in the UI copy.
 *  - Where it runs: both the desktop app (russh/Tauri) and the web panel unwrap the vault
 *    key and decrypt entirely client-side — see `frontend/src/components/RevealSecret.tsx`
 *    and `frontend/src/components/UnlockModal.tsx`, which call
 *    `deriveMasterKey`/`unwrapVaultKey`/`decryptBlob` in the browser and never send the
 *    password, the KEK or the vault key to the server.
 *  - But only ONE of the two encrypts. The browser cannot write a secret at all:
 *    `encryptBlob` in `frontend/src/lib/crypto.ts` is marked `@internal` and has no caller
 *    outside tests, and every form that would need it renders `DesktopOnlyNote` instead
 *    (whose own docstring says why: the field is absent, not disabled, so that nothing
 *    promises to save a password it cannot save). So: desktop encrypts and decrypts, web
 *    only decrypts. The copy below must not blur that into "both encrypt".
 *  - What the server stores: `backend/app/blobs/models.py` (`BlobStorage`) persists only a
 *    `ciphertext` column plus metadata (kind/version/device/timestamps); `User.wrapped_vault_key`
 *    (`backend/app/auth/models.py`) holds the 72-byte wrapper — no plaintext, no bare key.
 *  - Where the key lives: `desktop/src-tauri/src/keychain/mod.rs` stores the VAULT key
 *    (`store_vault_key`) in the OS keychain via the `keyring` crate — since the vault-key
 *    change it is no longer the password-derived key that sits there. On web the vault key
 *    lives only in the memory of the current browser tab and is dropped after five idle
 *    minutes (`frontend/src/store/auth.ts`), never persisted server-side.
 */

export const ENCRYPTION_BANNER = {
  title: "Zero-Knowledge Encryption Active",
  body:
    "Secrets are encrypted by the desktop app before they ever reach the server, with a " +
    "vault key of 32 random bytes that never leaves your devices. Your password encrypts " +
    "nothing by itself: Argon2id turns it into the key that unwraps the vault key. The " +
    "server stores only opaque ciphertext blobs and that wrapper. This web panel writes " +
    "no secrets at all; it unwraps the same key only to read them back.",
};

export const ENCRYPTION_INFO: ReadonlyArray<readonly [string, string]> = [
  ["Algorithm", "libsodium secretbox — XSalsa20-Poly1305 authenticated encryption"],
  ["Vault Key", "32 random bytes generated on your device — this is what encrypts the secrets"],
  ["Key Derivation", "Argon2id, client-side: your password only wraps and unwraps the vault key"],
  [
    "Changing Your Password",
    "Rewraps the vault key — no secret is re-encrypted, and all of them stay readable",
  ],
  ["Stored Fields", "SSH passwords, FastPanel passwords, registrar/Cloudflare API keys, tokens"],
  ["Where It Runs", "Desktop encrypts and decrypts; this web panel only decrypts — never the server"],
  ["Where The Key Lives", "Desktop: OS keychain. Web: this tab's memory, dropped after 5 idle minutes"],
  ["Server Sees", "Ciphertext blobs, the wrapped vault key and metadata — never plaintext or keys"],
];
