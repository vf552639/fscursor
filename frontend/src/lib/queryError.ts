import { ApiError } from "../api/client";

export interface QueryErrorCopy {
  title: string;
  message: string;
  hint?: string;
}

/**
 * Turn a failed query into an accurate error box.
 *
 * The pages used to blame a stale database schema for every failure, which sends
 * you chasing alembic logs when the real answer is a 401. Keep the schema hint
 * where a stale schema can actually surface: a 5xx from the backend.
 */
export function describeQueryError(error: unknown): QueryErrorCopy {
  const status = error instanceof ApiError ? error.status : -1;

  if (status === 401) {
    return {
      title: "Not signed in — request rejected (HTTP 401)",
      message: "The server did not accept this request as authenticated.",
      hint: "Sign in again. In the desktop app the session lives in the Rust client, so the in-app pages can be unauthenticated even right after a successful login.",
    };
  }

  if (status === 403) {
    return {
      title: "Access denied (HTTP 403)",
      message: "This account is not allowed to read that data.",
    };
  }

  if (status === 0) {
    return {
      title: "Backend unavailable",
      message: "The request never reached the API.",
      hint: "docker compose ps",
    };
  }

  if (status >= 500) {
    return {
      title: `Backend error (HTTP ${status})`,
      message: "The API failed while handling the request. A stale database schema shows up here.",
      hint: "docker compose logs backend | grep -i alembic",
    };
  }

  if (status > 0) {
    return {
      title: `Request failed (HTTP ${status})`,
      message: error instanceof ApiError ? error.message : "The request failed.",
    };
  }

  return {
    title: "Unable to load data",
    message: error instanceof Error ? error.message : "The request failed.",
  };
}
