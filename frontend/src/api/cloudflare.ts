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

/**
 * Зона, вернувшаяся из `cf_create_zone` (`cloudflare::client::Zone`). Полей
 * `status`/`paused` там нет — это не `Zone` выше.
 */
export interface CreatedZone {
  id: string;
  name: string;
  name_servers: string[] | null;
}

function requireUserId(): string {
  const userId = useAuthStore.getState().userId;
  if (!userId) throw new Error("Desktop: unlock session (user id missing)");
  return userId;
}

/**
 * Мутации Cloudflare живут только в десктопе: токен аккаунта расшифровывается
 * на клиенте, и HTTP-роутов под них на бэкенде нет и не будет (в
 * `routes/cloudflare.py` только CRUD аккаунтов). Веб — «только смотрит».
 */
function requireDesktop(what: string): void {
  if (!isTauri()) throw new Error(`${what} runs in the SDMP desktop app.`);
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

/**
 * ⚠️ Чтения ниже (зоны, детали зоны, DNS-записи, nameservers) бьются в роуты,
 * которых на бэкенде НЕТ: `routes/cloudflare.py` знает только CRUD аккаунтов.
 * Tauri-команд на чтение тоже нет (в Rust есть `client::list_zones` и
 * `client::list_dns_records`, но они не выставлены как `#[tauri::command]`).
 * Пока read-путь не построен, эти хуки честно возвращают ошибку, и UI её
 * показывает — молча пустой таблицы быть не должно. Список зон страница
 * поэтому строит из `/domains` (`cloudflare_zone_id`), а не отсюда.
 */
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

/**
 * Создание зоны в Cloudflare. Возвращает name_servers — их надо прописать у
 * регистратора, иначе зона так и останется pending.
 */
export function useCreateZone(accountId: number) {
  return useMutation({
    mutationFn: async (zoneName: string) => {
      requireDesktop("Creating a Cloudflare zone");
      const userId = requireUserId();
      return invokeSynced<CreatedZone>("cf_create_zone", {
        userId,
        accountId: String(accountId),
        zoneName,
      });
    },
    // Список зон страница строит из доменов: связку зоны с доменом ставит
    // серверная синхронизация, поэтому перечитываем именно домены.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["domains"] }),
  });
}

export function useCreateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async (data: DnsRecordCreate) => {
      requireDesktop("Creating a DNS record");
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
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useUpdateDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async ({ recordId, data }: { recordId: string; data: DnsRecordUpdate }) => {
      requireDesktop("Editing a DNS record");
      const userId = requireUserId();
      return invokeSynced<DnsRecord>("cf_update_dns_record", {
        userId,
        accountId: String(accountId),
        zoneId,
        recordId,
        patch: {
          // Форма правки даёт менять тип записи — без этого поля смена типа
          // молча не доезжала. `undefined` serde видит как «не менять».
          type: data.type,
          name: data.name,
          content: data.content,
          ttl: data.ttl,
          proxied: data.proxied,
          priority: data.priority,
        },
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function useDeleteDnsRecord(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async (recordId: string) => {
      requireDesktop("Deleting a DNS record");
      const userId = requireUserId();
      return invokeSynced<void>("cf_delete_dns_record", {
        userId,
        accountId: String(accountId),
        zoneId,
        recordId,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.dns(accountId, zoneId) }),
  });
}

export function usePurgeCache(accountId: number, zoneId: string) {
  return useMutation({
    mutationFn: async () => {
      requireDesktop("Purging the Cloudflare cache");
      const userId = requireUserId();
      await invokeSynced<void>("cf_purge_cache", {
        userId,
        accountId: String(accountId),
        zoneId,
      });
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
