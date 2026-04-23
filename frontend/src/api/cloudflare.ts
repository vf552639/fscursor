import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut } from "./client";
import { queryClient } from "./queryClient";

export interface CloudflareAccount {
  id: number;
  name: string;
  account_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
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

export const cloudflareKeys = {
  accounts: ["cloudflare", "accounts"] as const,
  zones: (accountId: number) => ["cloudflare", accountId, "zones"] as const,
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

export function useCloudflareZones(accountId: number | null | undefined) {
  return useQuery({
    queryKey: accountId ? cloudflareKeys.zones(accountId) : ["cloudflare", "zones", "disabled"],
    queryFn: () => apiGet<Zone[]>(`/cloudflare/accounts/${accountId}/zones`),
    enabled: !!accountId,
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
    mutationFn: (data: DnsRecordCreate) =>
      apiPost<DnsRecord>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/dns`,
        data
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useUpdateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: ({ recordId, data }: { recordId: string; data: DnsRecordUpdate }) =>
      apiPut<DnsRecord>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/dns/${recordId}`,
        data
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useDeleteDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: (recordId: string) =>
      apiDelete(`/cloudflare/accounts/${accountId}/zones/${zoneId}/dns/${recordId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function usePurgeCache(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: () =>
      apiPost<{ success: boolean; message: string | null }>(
        `/cloudflare/accounts/${accountId}/zones/${zoneId}/purge`
      ),
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
