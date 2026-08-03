import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";

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

export interface InstallFastPanelResponse {
  task_id: string;
  server_id: number;
}

export type TaskLogLine = string;

export interface FastPanelStatus {
  server_id: number;
  fastpanel_status: string;
  fastpanel_url: string | null;
  fastpanel_user: string | null;
  log_tail: TaskLogLine[];
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
  fastpanel: (id: number) => ["servers", id, "fastpanel-status"] as const,
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

export function useInstallFastPanel(id: number) {
  return useMutation({
    mutationFn: () => apiPost<InstallFastPanelResponse>(`/servers/${id}/install-fastpanel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serversKeys.fastpanel(id) });
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
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

export function useFastPanelStatus(id: number | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: id ? serversKeys.fastpanel(id) : ["servers", "fastpanel", "disabled"],
    queryFn: () => apiGet<FastPanelStatus>(`/servers/${id}/fastpanel-status`),
    enabled: !!id && enabled,
    refetchInterval: enabled ? 3000 : false,
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
