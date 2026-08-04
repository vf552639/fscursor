import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut } from "./client";
import { invokeSynced } from "../lib/localCache";
// Всё, что ходит в API регистратора, живёт только в десктопе: ключ и секрет
// расшифровываются на клиенте, и роутов под них на бэкенде нет и не будет (в
// `routes/registrars.py` только CRUD аккаунтов). HTTP-резерв здесь был мёртвым —
// он уходил в 404. Веб — «только смотрит».
import { requireDesktop } from "../lib/runtime";
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
  api_key?: string;
  api_secret?: string;
  is_active?: boolean;
}

export interface RegistrarAccountUpdate {
  provider?: RegistrarProvider;
  name?: string;
  api_user?: string | null;
  api_key?: string;
  api_secret?: string;
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

export function useDeleteRegistrarAccount() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/registrars/accounts/${id}`),
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
