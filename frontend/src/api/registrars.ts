import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut } from "./client";
import { invokeSynced } from "../lib/localCache";
// Всё, что ходит в API регистратора, живёт только в десктопе: ключ и секрет
// расшифровываются на клиенте, и роутов под них на бэкенде нет и не будет (в
// `routes/registrars.py` только CRUD аккаунтов). HTTP-резерв здесь был мёртвым —
// он уходил в 404. Веб — «только смотрит».
import { requireDesktop } from "../lib/runtime";
import { forgetSecretBlobs } from "../lib/secretBlob";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";

export type RegistrarProvider = "hostiq" | "namecheap";

export interface RegistrarAccount {
  id: number;
  provider: RegistrarProvider | string;
  name: string;
  api_user: string | null;
  is_active: boolean;
  // Ссылки на блобы, а не секреты. Форма правки перезаписывает ИМЕННО этот id:
  // новый оставил бы аккаунт указывать на прежний ключ («сохранено», а в API
  // регистратора едет старый секрет), и снять секрет при удалении было бы нечем.
  api_key_blob_id: string | null;
  api_secret_blob_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegistrarAccountCreate {
  provider: RegistrarProvider;
  name: string;
  api_user?: string | null;
  /**
   * Ссылки на блобы от `putSecretBlob` — единственный способ передать секреты.
   * Полей `api_key`/`api_secret` здесь нет намеренно: серверная схема их не
   * объявляет, и до `extra="forbid"` она молча их выбрасывала (200 OK и `NULL`
   * в колонках) — в TS они давали зелёную компиляцию на пути, который теряет
   * секрет. Теперь это ошибка типа здесь и 422 `extra_forbidden` там.
   */
  api_key_blob_id?: string | null;
  /** У Namecheap этим параметром едет whitelisted client IP (см. `make_service`). */
  api_secret_blob_id?: string | null;
  is_active?: boolean;
}

export interface RegistrarAccountUpdate {
  provider?: RegistrarProvider;
  name?: string;
  api_user?: string | null;
  /**
   * См. `RegistrarAccountCreate`. При правке — ТОТ ЖЕ id. Снять секрет через
   * PUT нельзя: `registrar_service.update_account` применяет эти поля только
   * когда они `not None`, а `exclude_unset` не отличает явный `null` от
   * пропуска. Форме это и не нужно — пустое поле значит «не менять».
   */
  api_key_blob_id?: string | null;
  api_secret_blob_id?: string | null;
  is_active?: boolean;
}

export interface RegistrarTestResult {
  success: boolean;
  message: string;
}

export interface RegistrarDomain {
  domain: string | null;
  expiry_date: string | null;
  status: string | null;
  nameservers: string[];
}

function requireUserId(): string {
  const userId = useAuthStore.getState().userId;
  if (!userId) throw new Error("Desktop: unlock session (user id missing)");
  return userId;
}

export const registrarsKeys = {
  accounts: ["registrars", "accounts"] as const,
  domains: (accountId: number) => ["registrars", accountId, "domains"] as const,
  /** Ключ на ДОМЕН: соседний `domains` — это выкачка аккаунта, а тут один вопрос про один домен. */
  nameservers: (accountId: number, domain: string) =>
    ["registrars", accountId, "nameservers", domain] as const,
};

export function useRegistrarAccounts() {
  return useQuery({
    queryKey: registrarsKeys.accounts,
    queryFn: () => apiGet<RegistrarAccount[]>("/registrars/accounts"),
  });
}

export function useCreateRegistrarAccount() {
  return useMutation({
    mutationFn: (data: RegistrarAccountCreate) =>
      apiPost<RegistrarAccount>("/registrars/accounts", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: registrarsKeys.accounts }),
  });
}

export function useUpdateRegistrarAccount(id: number) {
  return useMutation({
    mutationFn: (data: RegistrarAccountUpdate) =>
      apiPut<RegistrarAccount>(`/registrars/accounts/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: registrarsKeys.accounts }),
  });
}

/** Аргумент — сущность, а не id: ссылки на блобы знает только она (`forgetSecretBlobs`). */
export function useDeleteRegistrarAccount() {
  return useMutation({
    mutationFn: async (
      account: Pick<RegistrarAccount, "id" | "api_key_blob_id" | "api_secret_blob_id">,
    ) => {
      await apiDelete(`/registrars/accounts/${account.id}`);
      await forgetSecretBlobs([account.api_key_blob_id, account.api_secret_blob_id]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: registrarsKeys.accounts }),
  });
}

export function useTestRegistrarConnection() {
  return useMutation({
    mutationFn: async (id: number): Promise<RegistrarTestResult> => {
      requireDesktop("Testing a registrar connection");
      const userId = requireUserId();
      const [success, message] = await invokeSynced<[boolean, string]>(
        "registrar_test_connection",
        { userId, accountId: String(id) }
      );
      return { success, message };
    },
  });
}

export function useRegistrarDomains(accountId: number | null | undefined) {
  return useQuery({
    queryKey: accountId ? registrarsKeys.domains(accountId) : ["registrars", "domains", "disabled"],
    queryFn: async () => {
      requireDesktop("Reading domains from a registrar");
      const userId = requireUserId();
      return invokeSynced<RegistrarDomain[]>("registrar_get_domains", {
        userId,
        accountId: String(accountId),
      });
    },
    enabled: !!accountId,
  });
}

/**
 * Настоящие nameservers ОДНОГО домена — как их видит его регистратор.
 *
 * Отдельный запрос, а не поле из `useRegistrarDomains`, и это не оптимизация.
 * Листинг у Namecheap nameservers не отдаёт вовсе, а у обоих провайдеров он
 * непагинирован — то есть отсутствие домена в ответе означает «страница
 * кончилась» ничуть не реже, чем «домена в аккаунте нет», и сказать по нему
 * что-либо о делегировании нельзя. Здесь ответ однозначен: либо список, либо
 * ошибка регистратора с её текстом.
 *
 * `staleTime` — как у зон Cloudflare (`zonesQuery`) и по той же причине: это
 * поход в чужой API с лимитами (Namecheap считает запросы поминутно), а
 * меняются NS домена либо нашей же кнопкой (она гасит этот ключ в
 * `useSetNameservers`), либо руками в панели регистратора — то есть редко.
 * Дефолтные 10 секунд означали бы полный опрос на каждое переоткрытие
 * карточки.
 */
export function useRegistrarNameservers(
  accountId: number | null | undefined,
  domain: string | null | undefined,
) {
  return useQuery({
    queryKey:
      accountId && domain
        ? registrarsKeys.nameservers(accountId, domain)
        : ["registrars", "nameservers", "disabled"],
    queryFn: async () => {
      requireDesktop("Reading nameservers from a registrar");
      const userId = requireUserId();
      return invokeSynced<string[]>("registrar_get_nameservers", {
        userId,
        accountId: String(accountId),
        domain,
      });
    },
    enabled: !!accountId && !!domain,
    staleTime: 60_000,
  });
}
