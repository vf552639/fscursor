import sodium from "libsodium-wrappers";

const KEY_LEN = 32;
const NONCE_LEN = 24;
const TAG_LEN = 16;

const CONTEXT_AUTH = "sdmp-auth-key-v1";
const CONTEXT_ENC = "sdmp-master-key-v1";
/**
 * Proof-of-phrase sent to `/auth/recovery/*`. Deliberately NOT the BIP-39 seed key that
 * opens the recovery blob — that one would hand the master key to the server.
 */
const CONTEXT_RECOVERY = "sdmp-recovery-key-v1";

/**
 * Fixed salt for the recovery auth key. Not the user's salt: `password/change` and
 * `recovery/finish` both rotate it, so a salt-bound recovery key would invalidate
 * itself on every password change.
 */
const RECOVERY_SALT = "sdmp-recovery-v1";

let sodiumReady: Promise<void> | null = null;
let argon2Mod: typeof import("argon2-browser") | null = null;

function ensureSodium(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready;
  return sodiumReady;
}

async function getArgon2(): Promise<typeof import("argon2-browser")> {
  if (argon2Mod) return argon2Mod;
  if (typeof process !== "undefined" && process.versions?.node) {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const wasmPath = join(process.cwd(), "node_modules/argon2-browser/dist/argon2.wasm");
    (globalThis as unknown as { Module?: { wasmBinary: Buffer } }).Module = {
      wasmBinary: readFileSync(wasmPath),
    };
  }
  argon2Mod = await import("argon2-browser");
  return argon2Mod;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function combinePasswordContext(password: string, context: string): Uint8Array {
  const pass = utf8Bytes(password);
  const ctx = utf8Bytes(context);
  const out = new Uint8Array(pass.length + 1 + ctx.length);
  out.set(pass, 0);
  out[pass.length] = 0x1f;
  out.set(ctx, pass.length + 1);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array, context: string): Promise<Uint8Array> {
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  const argon2 = await getArgon2();
  const combined = combinePasswordContext(password, context);
  const result = await argon2.hash({
    pass: combined,
    salt,
    type: argon2.ArgonType.Argon2id,
    time: 3,
    mem: 64 * 1024,
    parallelism: 1,
    hashLen: KEY_LEN,
  });
  return new Uint8Array(result.hash);
}

export async function deriveAuthKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return deriveKey(password, salt, CONTEXT_AUTH);
}

export async function deriveMasterKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return deriveKey(password, salt, CONTEXT_ENC);
}

/**
 * Trim, collapse whitespace runs to a single space, ASCII-lowercase.
 * Must stay byte-identical to `normalize_recovery_phrase` in
 * `desktop/src-tauri/src/crypto/kdf.rs` (ASCII-only lowering on purpose: a locale-aware
 * `toLowerCase` would diverge from Rust's `make_ascii_lowercase` on exotic input).
 */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Proof that the caller holds the recovery phrase; the server keeps only its bcrypt hash.
 * Sent to `/auth/register`, `/auth/recovery/setup` and `/auth/recovery/finish`.
 */
export async function deriveRecoveryAuthKey(phrase: string): Promise<Uint8Array> {
  return deriveKey(normalizeRecoveryPhrase(phrase), utf8Bytes(RECOVERY_SALT), CONTEXT_RECOVERY);
}

/** Layout matches desktop `crypto::aead`: nonce (24) || secretbox_easy (mac || ciphertext). */
export async function decryptBlob(framed: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await ensureSodium();
  if (framed.length < NONCE_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const nonce = framed.subarray(0, NONCE_LEN);
  const boxed = framed.subarray(NONCE_LEN);
  const pt = sodium.crypto_secretbox_open_easy(boxed, nonce, key);
  if (!pt) throw new Error("decrypt failed");
  return pt;
}

/** @internal Encrypt for tests / local roundtrip parity with desktop. */
export async function encryptBlob(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await ensureSodium();
  const msg = new Uint8Array(plaintext);
  const nonce = sodium.randombytes_buf(NONCE_LEN);
  const boxed = sodium.crypto_secretbox_easy(msg, nonce, key);
  const framed = new Uint8Array(NONCE_LEN + boxed.length);
  framed.set(nonce, 0);
  framed.set(boxed, NONCE_LEN);
  return framed;
}
