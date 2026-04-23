import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut } from "./client";
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
  notes: string | null;
  created_at: string;
  updated_at: string;
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
  notes?: string | null;
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
  notes?: string | null;
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

export function useInstallFastPanel(id: number) {
  return useMutation({
    mutationFn: () => apiPost<InstallFastPanelResponse>(`/servers/${id}/install-fastpanel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: serversKeys.fastpanel(id) });
      queryClient.invalidateQueries({ queryKey: serversKeys.detail(id) });
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
