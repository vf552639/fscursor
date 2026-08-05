// Minimal, hand-written declarations for `argon2-browser` (no upstream/@types package).
// Covers exactly what `src/lib/crypto.ts` uses: `hash()` and the `ArgonType` enum.
// See node_modules/argon2-browser/lib/argon2.js for the real (untyped) implementation.
declare module "argon2-browser" {
  export enum ArgonType {
    Argon2d = 0,
    Argon2i = 1,
    Argon2id = 2,
  }

  export interface Argon2HashParams {
    pass: string | Uint8Array;
    salt: string | Uint8Array;
    time?: number;
    mem?: number;
    hashLen?: number;
    parallelism?: number;
    type?: ArgonType;
    secret?: Uint8Array;
    ad?: Uint8Array;
  }

  export interface Argon2HashResult {
    hash: Uint8Array;
    hashHex: string;
    encoded: string;
  }

  export function hash(params: Argon2HashParams): Promise<Argon2HashResult>;
}
