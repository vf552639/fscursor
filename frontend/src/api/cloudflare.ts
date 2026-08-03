import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut } from "./client";
import { invokeSynced } from "../lib/localCache";
import { isTauri } from "../lib/runtime";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";

export interface CloudflareAccount {
  id: number;
  name: string;
  account_id: string | null;
  is_active: boolean;
  api_token_blob_id?: string | null;
  api_token_masked?: string | null;
  sync_result?: CloudflareSyncResult | null;
  sync_warning?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CloudflareSyncResult {
  updated: number;
  skipped: number;
  total_zones: number;
}

export interface CloudflareTestResponse {
  success: boolean;
  message: string;
  account_email?: string | null;
}

export interface CloudflareAccountCreate {
  name: string;
  account_id?: string | null;
  api_token: string;
  is_active?: boolean;
}

export interface CloudflareAccountUpdate {
  name?: string;
  account_id?: string | null;
  api_token?: string;
  is_active?: boolean;
}

export interface Zone {
  id: string;
  name: string;
  status: string | null;
  name_servers: string[];
  original_name_servers: string[];
  paused: boolean | null;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  zone_id: string | null;
}

export interface DnsRecordCreate {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface DnsRecordUpdate {
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface Nameservers {
  zone_id: string;
  name_servers: string[];
}

function requireUserId(): string {
  const userId = useAuthStore.getState().userId;
  if (!userId) throw new Error("Desktop: unlock session (user id missing)");
  return userId;
}

export const cloudflareKeys = {
  accounts: ["cloudflare", "accounts"] as const,
  zones: (accountId: number) => ["cloudflare", accountId, "zones"] as const,
  zone: (accountId: number, zoneId: string) =>
    ["cloudflare", accountId, "zones", zoneId] as const,
  dns: (accountId: number, zoneId: string) => ["cloudflare", accountId, "zones", zoneId, "dns"] as const,
  nameservers: (accountId: number, zoneId: string) =>
    ["cloudflare", accountId, "zones", zoneId, "nameservers"] as const,
};

export function useCloudflareAccounts() {
  return useQuery({
    queryKey: cloudflareKeys.accounts,
    queryFn: () => apiGet<CloudflareAccount[]>("/cloudflare/accounts"),
  });
}

export function useCreateCloudflareAccount() {
  return useMutation({
    mutationFn: (data: CloudflareAccountCreate) =>
      apiPost<CloudflareAccount>("/cloudflare/accounts", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cloudflareKeys.accounts }),
  });
}

export function useUpdateCloudflareAccount(id: number) {
  return useMutation({
    mutationFn: (data: CloudflareAccountUpdate) =>
      apiPut<CloudflareAccount>(`/cloudflare/accounts/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cloudflareKeys.accounts }),
  });
}

export function useDeleteCloudflareAccount() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/cloudflare/accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cloudflareKeys.accounts }),
  });
}

export function useTestCloudflareAccount() {
  return useMutation({
    mutationFn: async (id: number) => {
      if (isTauri()) {
        const userId = requireUserId();
        const ok = await invokeSynced<boolean>("cf_verify_token", {
          userId,
          accountId: String(id),
        });
        return {
          success: ok,
          message: ok ? "OK" : "invalid token",
          account_email: null,
        } satisfies CloudflareTestResponse;
      }
      return apiPost<CloudflareTestResponse>(`/cloudflare/accounts/${id}/test`);
    },
  });
}

export function useCloudflareZones(accountId: number | null | undefined) {
  return useQuery({
    queryKey: accountId ? cloudflareKeys.zones(accountId) : ["cloudflare", "zones", "disabled"],
    queryFn: () => apiGet<Zone[]>(`/cloudflare/accounts/${accountId}/zones`),
    enabled: !!accountId,
  });
}

export function useZoneDetails(
  accountId: number | null | undefined,
  zoneId: string | null | undefined
) {
  return useQuery({
    queryKey:
      accountId && zoneId
        ? cloudflareKeys.zone(accountId, zoneId)
        : ["cloudflare", "zone", "disabled"],
    queryFn: () => apiGet<Zone>(`/cloudflare/accounts/${accountId}/zones/${zoneId}`),
    enabled: !!accountId && !!zoneId,
  });
}

export function useDnsRecords(
  accountId: number | null | undefined,
  zoneId: string | null | undefined
) {
  return useQuery({
    queryKey:
      accountId && zoneId
        ? cloudflareKeys.dns(accountId, zoneId)
        : ["cloudflare", "dns", "disabled"],
    queryFn: () =>
      apiGet<DnsRecord[]>(`/cloudflare/accounts/${accountId}/zones/${zoneId}/dns`),
    enabled: !!accountId && !!zoneId,
  });
}

export function useCreateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async (data: DnsRecordCreate) => {
      if (isTauri()) {
        const userId = requireUserId();
        return invokeSynced<DnsRecord>("cf_create_dns_record", {
          userId,
          accountId: String(accountId),
          zoneId,
          record: {
            type: data.type,
            name: data.name,
            content: data.content,
            ttl: data.ttl,
            proxied: data.proxied,
            // MX/SRV/URI без приоритета уезжали в Cloudflare сломанными.
            priority: data.priority,
          },
        });
      }
      return apiPost<DnsRecord>(`/cloudflare/accounts/${accountId}/zones/${zoneId}/dns`, data);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useUpdateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async ({ recordId, data }: { recordId: string; data: DnsRecordUpdate }) => {
      if (isTauri()) {
        const userId = requireUserId();
        return invokeSynced<DnsRecord>("cf_update_dns_record", {
          userId,
          accountId: String(accountId),
          zoneId,
          recordId,
          patch: {
            // Форма правки даёт менять тип записи, и веб-путь его шлёт —
            // десктопный молча терял и type, и priority.
            type: data.type,
            name: data.name,
            content: data.content,
            ttl: data.ttl,
            proxied: data.proxied,
            priority: data.priority,
          },
        });
      }
      return apiPut<DnsRecord>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/dns/${recordId}`,
        data
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useDeleteDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async (recordId: string) => {
      if (isTauri()) {
        const userId = requireUserId();
        return invokeSynced<void>("cf_delete_dns_record", {
          userId,
          accountId: String(accountId),
          zoneId,
          recordId,
        });
      }
      return apiDelete(`/cloudflare/accounts/${accountId}/zones/${zoneId}/dns/${recordId}`);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function usePurgeCache(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async () => {
      if (isTauri()) {
        const userId = requireUserId();
        await invokeSynced<void>("cf_purge_cache", {
          userId,
          accountId: String(accountId),
          zoneId,
        });
        return { success: true, message: null } as { success: boolean; message: string | null };
      }
      return apiPost<{ success: boolean; message: string | null }>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/purge`
      );
    },
  });
}

export function useZoneNameservers(
  accountId: number | null | undefined,
  zoneId: string | null | undefined
) {
  return useQuery({
    queryKey:
      accountId && zoneId
        ? cloudflareKeys.nameservers(accountId, zoneId)
        : ["cloudflare", "nameservers", "disabled"],
    queryFn: () =>
      apiGet<Nameservers>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/nameservers`
      ),
    enabled: !!accountId && !!zoneId,
  });
}
