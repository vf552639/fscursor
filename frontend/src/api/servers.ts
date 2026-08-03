import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";
import { invokeSynced } from "../lib/localCache";
import { isTauri } from "../lib/runtime";
import { useAuthStore } from "../store/auth";
import type { InstallFastpanelResult } from "../lib/deepLink";

export interface Server {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  os: string | null;
  status: string;
  purchase_date: string | null;
  expiry_date: string | null;
  fastpanel_status: string;
  fastpanel_url: string | null;
  fastpanel_user: string | null;
  created_at: string;
  updated_at: string;
  has_ssh: boolean;
  uptime_seconds: number | null;
  cpu_usage_pct: number | null;
  cpu_count: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  net_in_kbps: number | null;
  net_out_kbps: number | null;
  os_pretty: string | null;
  kernel: string | null;
  fastpanel_version: string | null;
  fastpanel_port: number | null;
  metrics_collected_at: string | null;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_check_error: string | null;
  ssh_password_blob_id?: string | null;
  fastpanel_password_blob_id?: string | null;
}

export interface ServerListResponse {
  items: Server[];
  total: number;
}

export interface ServerCreate {
  name: string;
  ip_address: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  os?: string | null;
  purchase_date?: string | null;
  expiry_date?: string | null;
  fastpanel_user?: string;
  fastpanel_password?: string;
  fastpanel_url?: string;
  fastpanel_status?: string;
}

export interface ServerUpdate {
  name?: string;
  ip_address?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  os?: string | null;
  status?: string;
  purchase_date?: string | null;
  expiry_date?: string | null;
  fastpanel_user?: string;
  fastpanel_password?: string;
  fastpanel_url?: string;
  fastpanel_status?: string;
}

export interface SshTestResult {
  success: boolean;
  message: string;
}

export interface ServerBulkImportError {
  row: number;
  server: string;
  reason: string;
}

export interface ServerBulkImportResponse {
  created: number;
  skipped: number;
  errors: ServerBulkImportError[];
  errors_csv_url?: string | null;
}

export interface SyncDomainsResponse {
  created: number;
  linked: number;
  total: number;
  error: string | null;
}

export const serversKeys = {
  all: ["servers"] as const,
  detail: (id: number) => ["servers", id] as const,
};

export function useServers() {
  return useQuery({
    queryKey: serversKeys.all,
    queryFn: () => apiGet<ServerListResponse>("/servers"),
  });
}

export function useServer(id: number | null | undefined) {
  return useQuery({
    queryKey: id ? serversKeys.detail(id) : ["servers", "disabled"],
    queryFn: () => apiGet<Server>(`/servers/${id}`),
    enabled: !!id,
  });
}

export function useCreateServer() {
  return useMutation({
    mutationFn: (data: ServerCreate) => apiPost<Server>("/servers", data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: serversKeys.all });
    },
  });
}

export function useUpdateServer(id: number) {
  return useMutation({
    mutationFn: (data: ServerUpdate) => apiPut<Server>(`/servers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serversKeys.all });
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
    },
  });
}

export function useDeleteServer() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/servers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: serversKeys.all }),
  });
}

export function useTestSsh(id: number) {
  return useMutation({
    mutationFn: () => apiPost<SshTestResult>(`/servers/${id}/test-ssh`),
  });
}

export function useRefreshMetrics(id: number) {
  return useMutation({
    mutationFn: () => apiPost<Server>(`/servers/${id}/refresh-metrics`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: serversKeys.all });
    },
  });
}

/**
 * Установка FastPanel. Выполняет ТОЛЬКО десктоп: команда лезет по SSH на живой
 * сервер, обновляет все пакеты и запускает инсталлятор (30-40 минут). Эндпоинта
 * `POST /servers/{id}/install-fastpanel` на бэкенде нет и быть не должно — веб
 * вместо вызова отдаёт deep link `sdmp://install-fastpanel` (см. OpenInDesktop).
 *
 * `invokeSynced`, а не `invokeIfTauri`: команда резолвит сервер из локального
 * SQLCipher-кэша, и от свежести кэша зависит проверка идемпотентности
 * (`fastpanel_status == "installed"`), которую заполняет write-back.
 *
 * Ответ команды содержит пароль панели в открытом виде — он существует только
 * там и больше нигде. Поэтому креды уходят в `onCreds` напрямую, а наружу
 * возвращается один `server_id`: попади они в возврат `mutationFn`, react-query
 * положил бы их в `data` MutationCache, откуда их не убирает даже `reset()` —
 * запись живёт там ещё gcTime (5 минут по умолчанию). `onCreds` обязан только
 * показать их один раз и не сохранять (см. FastPanelCredsModal).
 */
export function useInstallFastPanel(id: number, onCreds: (creds: InstallFastpanelResult) => void) {
  return useMutation({
    mutationFn: async (opts?: { force?: boolean }) => {
      if (!isTauri()) {
        throw new Error("Installing FastPanel runs in the SDMP desktop app.");
      }
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      const creds = await invokeSynced<InstallFastpanelResult>("install_fastpanel", {
        userId,
        serverId: String(id),
        force: Boolean(opts?.force),
      });
      onCreds(creds);
      return { server_id: creds.server_id };
    },
    onSuccess: () => {
      // Обновление статуса тянем с сервера: его туда пишет write-back самой
      // команды. В кэш запросов кладём только то, что уже знает сервер.
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: serversKeys.all });
    },
  });
}

export function useSyncServerDomains(id: number) {
  return useMutation({
    mutationFn: () => apiPost<SyncDomainsResponse>(`/servers/${id}/sync-domains`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: serversKeys.all });
    },
  });
}

export async function bulkImportServers(params: {
  file: File;
  hasHeader: boolean;
  onProgress?: (percent: number) => void;
}): Promise<ServerBulkImportResponse> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("has_header", String(params.hasHeader));
  const r = await http.post<ServerBulkImportResponse>("/servers/bulk-import", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (evt) => {
      if (!evt.total || !params.onProgress) return;
      params.onProgress(Math.round((evt.loaded / evt.total) * 100));
    },
  });
  return r.data;
}
