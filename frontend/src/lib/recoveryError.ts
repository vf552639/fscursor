import { ApiError } from "../api/client";

/**
 * A rejected Tauri command does not arrive as an `Error`. The Rust `CommandError` enum
 * derives `Serialize`, so serde's external tagging puts it on the wire as
 * `{ "Api": "…" }` / `{ "Recovery": "…" }`, and `String(e)` on that renders the useless
 * `[object Object]`. Unwrap it back into the message Rust wrote.
 */
export function describeCommandError(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const values = Object.values(err as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

/** Pull the HTTP status out of whatever form the failure took. */
function statusOf(err: unknown, text: string): number | null {
  if (err instanceof ApiError) return err.status;
  const m = text.match(/\b(?:api error|HTTP)\s*(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Actionable copy for the recovery endpoints.
 *
 * 401 deliberately covers both a wrong phrase and an unknown email — the backend
 * refuses to tell those apart, and neither do we.
 * 409/404 mean the account has no recovery key on file (registered before the
 * recovery-proof change); the only fix is to sign in and reconfigure.
 * 429 is the rate limit (finish 5/min, start 10/min).
 */
export function describeRecoveryError(err: unknown): string {
  const text = describeCommandError(err);
  switch (statusOf(err, text)) {
    case 401:
      return "Recovery rejected: this phrase does not match that account. Check the email address and all 24 words.";
    case 404:
    case 409:
      return "This account has no recovery key configured (it predates the recovery-proof update). Sign in with your password and set recovery up again, then retry.";
    case 429:
      return "Too many recovery attempts. Wait a minute before trying again.";
    default:
      return text;
  }
}
