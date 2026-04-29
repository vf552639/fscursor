import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import { queryClient } from "./queryClient";

export interface SslEmail {
  id: number;
  email: string;
  usage_count: number;
  usage_cap: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SslEmailCreate {
  email: string;
  usage_cap: number;
}

export interface SslEmailPatch {
  is_active?: boolean;
  usage_cap?: number;
}

export const sslEmailKeys = {
  all: ["ssl-emails"] as const,
};

export function useSslEmails() {
  return useQuery({
    queryKey: sslEmailKeys.all,
    queryFn: () => apiGet<SslEmail[]>("/ssl-emails"),
  });
}

export function useCreateSslEmail() {
  return useMutation({
    mutationFn: (payload: SslEmailCreate) => apiPost<SslEmail>("/ssl-emails", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sslEmailKeys.all }),
  });
}

export function usePatchSslEmail() {
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SslEmailPatch }) =>
      apiPatch<SslEmail>(`/ssl-emails/${id}`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sslEmailKeys.all }),
  });
}

export function useDeleteSslEmail() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/ssl-emails/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sslEmailKeys.all }),
  });
}
