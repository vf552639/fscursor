import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { isTauri } from "../lib/runtime";
import { invokeIfTauri } from "../lib/tauri-invoke";

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8100/api";

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Превратить `detail` из ответа бэкенда в строку для человека.
 *
 * Ответ 422 от FastAPI — это НЕ строка, а список объектов
 * `{loc, msg, type}` (по одному на провалившееся поле). `String()` на нём
 * возвращает `[object Object]`, и пользователь видел ровно это: ни что не так,
 * ни какое поле виновато. Путь достижим обычной опечаткой — например, URL
 * FastPanel без порта в форме «Connect Existing Fastpanel».
 *
 * `loc` начинается с источника (`body`/`query`/`path`) — он пользователю
 * ничего не говорит, поэтому в текст идёт остаток пути. Если после отброса
 * источника ничего не осталось (ошибка на теле целиком) — только `msg`.
 *
 * Строковый `detail` (401/403/404 и прочие ручные `HTTPException`) обязан
 * доходить дословно — на это есть отдельный тест.
 */
export function formatErrorDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return String(item);
      const { loc, msg } = item as { loc?: unknown; msg?: unknown };
      const field = Array.isArray(loc) ? loc.slice(1).join(".") : "";
      const text = typeof msg === "string" ? msg : JSON.stringify(item);
      return field ? `${field}: ${text}` : text;
    });
    return parts.join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return String(detail);
}

export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: true,
});

http.interceptors.request.use((config) => {
  config.headers = config.headers ?? {};
  if (!config.headers["Content-Type"] && config.method !== "get") {
    config.headers["Content-Type"] = "application/json";
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<any>) => {
    const status = error.response?.status ?? 0;
    const data = error.response?.data;
    const message =
      (typeof data === "object" && data && (data.detail || data.message)) ||
      error.message ||
      "Request failed";
    return Promise.reject(new ApiError(status, formatErrorDetail(message), data));
  }
);

/**
 * Desktop (Tauri) has no browser cookie for the API: the session lives in the
 * Rust `reqwest` client, and the webview's origin (`tauri://localhost`) is
 * cross-site to the backend, so a `SameSite=Strict` cookie could never ride
 * along even if we planted one. So in the desktop app every API call is proxied
 * through the Rust `api_request` command, which reuses the authenticated jar.
 * The web build keeps using axios with its own cookie.
 */
interface RustApiResponse {
  status: number;
  body: unknown;
}

function foldParamsIntoPath(url: string, config?: AxiosRequestConfig): string {
  const params = config?.params as Record<string, unknown> | undefined;
  if (!params) return url;
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    usp.append(key, String(value));
  }
  const qs = usp.toString();
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

async function tauriRequest<T>(
  method: string,
  url: string,
  body: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const path = foldParamsIntoPath(url, config);
  const resp = await invokeIfTauri<RustApiResponse>("api_request", {
    method,
    path,
    body: body ?? null,
  });
  if (resp.status >= 200 && resp.status < 300) {
    return resp.body as T;
  }
  const detail =
    (typeof resp.body === "object" &&
      resp.body &&
      ((resp.body as { detail?: unknown }).detail ||
        (resp.body as { message?: unknown }).message)) ||
    `HTTP ${resp.status}`;
  throw new ApiError(resp.status, formatErrorDetail(detail), resp.body);
}

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  if (isTauri()) return tauriRequest<T>("GET", url, null, config);
  const r = await http.get<T>(url, config);
  return r.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  if (isTauri()) return tauriRequest<T>("POST", url, body, config);
  const r = await http.post<T>(url, body, config);
  return r.data;
}

export async function apiPut<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  if (isTauri()) return tauriRequest<T>("PUT", url, body, config);
  const r = await http.put<T>(url, body, config);
  return r.data;
}

export async function apiPatch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  if (isTauri()) return tauriRequest<T>("PATCH", url, body, config);
  const r = await http.patch<T>(url, body, config);
  return r.data;
}

export async function apiDelete<T = void>(url: string, config?: AxiosRequestConfig): Promise<T> {
  if (isTauri()) return tauriRequest<T>("DELETE", url, null, config);
  const r = await http.delete<T>(url, config);
  return r.data;
}
