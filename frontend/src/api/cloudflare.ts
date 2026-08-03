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

/** Зона так, как её отдаёт `cf_list_zones` (`cloudflare::client::Zone`). */
export interface Zone {
  id: string;
  name: string;
  name_servers: string[] | null;
  /** Делегирование у Cloudflare: `active` / `pending` / `moved`. */
  status: string | null;
}

/** Запись так, как её отдают `cf_list_dns_records` и мутации. */
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  /** `Option<u32>` в Rust: у записи может не быть TTL. */
  ttl: number | null;
  proxied: boolean;
  zone_id: string | null;
  // priority здесь намеренно нет: `client::DnsRecord` его не десериализует,
  // так что в ответе на create/update приоритет не возвращается.
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
  dns: (accountId: number, zoneId: string) => ["cloudflare", accountId, "zones", zoneId, "dns"] as const,
};

/**
 * Один запрос `cf_list_zones` на аккаунт — на нём стоят и список зон, и детали
 * зоны, и её nameservers: Cloudflare отдаёт `name_servers` прямо в списке, так
 * что отдельные команды под зону и NS были бы лишними походами с тем же
 * ответом. Три хука ниже — три `select` над одной записью кэша.
 */
function zonesQuery(accountId: number | null | undefined) {
  return {
    queryKey: accountId ? cloudflareKeys.zones(accountId) : (["cloudflare", "zones", "disabled"] as const),
    queryFn: async (): Promise<Zone[]> => {
      requireDesktop("Reading Cloudflare zones");
      const userId = requireUserId();
      return invokeSynced<Zone[]>("cf_list_zones", { userId, accountId: String(accountId) });
    },
  };
}

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
      // Проверка токена — тоже «десктоп выполняет»: токен расшифровывается на
      // клиенте, а роута `/accounts/{id}/test` на бэкенде нет.
      requireDesktop("Testing a Cloudflare token");
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
    },
  });
}

export function useCloudflareZones(accountId: number | null | undefined) {
  return useQuery({
    ...zonesQuery(accountId),
    // Вне десктопа запрос обречён (`requireDesktop`), а его ошибку список зон
    // не читает — там своя подпись и резерв из доменов. Не запускаем вовсе.
    //
    // NB: фильтр по `isTauri()` стоит ТОЛЬКО здесь, и это не недосмотр.
    // У `useDnsRecords` текст этой ошибки И ЕСТЬ объяснение, которое веб
    // показывает вместо таблицы. У `useZoneDetails`/`useZoneNameservers`
    // (та же запись кэша, что и тут) — то же самое: `Domains.tsx` рисует по
    // ним красное «Failed to load», и это правда, потому что веб про зону
    // действительно ничего знать не может. Молчаливое «нет данных» там было бы
    // хуже. Не «выравнивать» три хука под один флаг.
    enabled: !!accountId && isTauri(),
  });
}

export function useZoneDetails(
  accountId: number | null | undefined,
  zoneId: string | null | undefined
) {
  return useQuery({
    ...zonesQuery(accountId),
    enabled: !!accountId && !!zoneId,
    select: (zones: Zone[]) => zones.find((z) => z.id === zoneId) ?? null,
  });
}

export function useZoneNameservers(
  accountId: number | null | undefined,
  zoneId: string | null | undefined
) {
  return useQuery({
    ...zonesQuery(accountId),
    enabled: !!accountId && !!zoneId,
    // `null` — зоны нет в аккаунте (например, zone_id от другого аккаунта).
    // Пустой массив тут врал бы: «NS не настроены» вместо «зона не найдена».
    select: (zones: Zone[]): Nameservers | null => {
      const zone = zones.find((z) => z.id === zoneId);
      return zone ? { zone_id: zone.id, name_servers: zone.name_servers ?? [] } : null;
    },
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
    queryFn: async () => {
      requireDesktop("Reading DNS records");
      const userId = requireUserId();
      return invokeSynced<DnsRecord[]>("cf_list_dns_records", {
        userId,
        accountId: String(accountId),
        zoneId: String(zoneId),
      });
    },
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
      return invokeSynced<Zone>("cf_create_zone", {
        userId,
        accountId: String(accountId),
        zoneName,
      });
    },
    onSuccess: () => {
      // Зоны — это то, что рисует список: без инвалидации только что созданная
      // зона не появлялась бы до ухода со страницы (refetchOnWindowFocus
      // выключен, карточку модалка не размонтирует).
      queryClient.invalidateQueries({ queryKey: cloudflareKeys.zones(accountId) });
      // Домены — потому что серверная синхронизация привязывает зону к строке
      // домена, и от этого зависит резервный список для веба.
      queryClient.invalidateQueries({ queryKey: ["domains"] });
    },
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

