import axios, { AxiosError, AxiosRequestConfig } from "axios";

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

export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
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
    return Promise.reject(new ApiError(status, String(message), data));
  }
);

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const r = await http.get<T>(url, config);
  return r.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const r = await http.post<T>(url, body, config);
  return r.data;
}

export async function apiPut<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const r = await http.put<T>(url, body, config);
  return r.data;
}

export async function apiDelete<T = void>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const r = await http.delete<T>(url, config);
  return r.data;
}
