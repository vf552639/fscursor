import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";

export interface Domain {
  id: number;
  domain_name: string;
  status: string;
  registrar_id: number | null;
  server_id: number | null;
  cloudflare_account_id: number | null;
  cloudflare_zone_id: string | null;
  cloudflare_enabled: boolean;
  expiry_date: string | null;
  purchase_date: string | null;
  ns_status: string | null;
  ns_updated_at: string | null;
  site_user?: string | null;
  site_path?: string | null;
  ftp_user?: string | null;
  ssl_status?: string | null;
  ssl_email_used?: string | null;
  ssl_expires_at?: string | null;
  ssl_issuer?: string | null;
  php_version?: string | null;
  db_name?: string | null;
  db_user?: string | null;
  ns_check_mode?: string | null;
  nginx_override?: string | null;
  nginx_presets?: Record<string, unknown> | null;
  last_provision_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainCreate {
  domain_name: string;
  registrar_id?: number | null;
  server_id?: number | null;
  cloudflare_account_id?: number | null;
  cloudflare_zone_id?: string | null;
  cloudflare_enabled?: boolean;
  expiry_date?: string | null;
  purchase_date?: string | null;
}

export interface DomainUpdate {
  domain_name?: string;
  status?: string;
  registrar_id?: number | null;
  server_id?: number | null;
  cloudflare_account_id?: number | null;
  cloudflare_zone_id?: string | null;
  cloudflare_enabled?: boolean;
  expiry_date?: string | null;
  purchase_date?: string | null;
  ns_status?: string | null;
}

export interface DomainBulkCreate {
  domains_text: string;
  registrar_id?: number | null;
}

export interface DomainBulkCreateResponse {
  created: Domain[];
  skipped: string[];
}

export interface DomainBulkCreateItem {
  domain_name: string;
  registrar_id?: number | null;
  registrar_name?: string | null;
}

export interface DomainBulkStructuredCreate {
  items: DomainBulkCreateItem[];
}

export interface DomainBulkAssignServer {
  domain_ids: number[];
  server_id: number | null;
}

export interface DomainBulkAssignCloudflare {
  domain_ids: number[];
  cloudflare_account_id: number | null;
}

export interface DomainBulkAssignResponse {
  updated: number;
}

export interface DomainFilters {
  server_id?: number;
  registrar_id?: number;
  cf_account_id?: number;
  status?: string;
  ns_status?: string;
}

export interface SetNsResponse {
  task_id: string;
  domain_id: number;
}

export interface BulkSetNsResponse {
  task_ids: string[];
}

export interface ProvisionResponse {
  task_id: string;
  task_log_id: number;
  domain_id: number;
}

export interface DomainDbCredentials {
  domain_id: number;
  db_name: string | null;
  db_user: string | null;
  db_password: string | null;
}

export interface NginxOverridePayload {
  snippet: string;
  presets: Record<string, unknown>;
}

export interface NginxOverrideResponse {
  domain_id: number;
  snippet: string;
  presets: Record<string, unknown>;
}

export interface BulkProvisionResponse {
  task_ids: string[];
}

export interface BulkFullSetupPayload {
  domain_ids: number[];
  server_id: number;
  cloudflare_account_id: number;
  registrar_id?: number | null;
}

export interface BulkFullSetupResponse {
  task_ids: string[];
  task_log_ids: number[];
}

export interface BulkImportError {
  row: number;
  domain: string;
  reason: string;
}

export interface BulkImportResponse {
  created: number;
  skipped: number;
  errors: BulkImportError[];
  errors_csv_url?: string | null;
}

export const domainsKeys = {
  all: ["domains"] as const,
  list: (filters?: DomainFilters) => ["domains", "list", filters ?? {}] as const,
  detail: (id: number) => ["domains", id] as const,
};

export function useDomains(filters?: DomainFilters) {
  return useQuery({
    queryKey: domainsKeys.list(filters),
    queryFn: () => apiGet<Domain[]>("/domains", { params: filters }),
  });
}

export function useDomain(id: number | null | undefined) {
  return useQuery({
    queryKey: id ? domainsKeys.detail(id) : ["domains", "disabled"],
    queryFn: () => apiGet<Domain>(`/domains/${id}`),
    enabled: !!id,
  });
}

export function useCreateDomain() {
  return useMutation({
    mutationFn: (data: DomainCreate) => apiPost<Domain>("/domains", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkCreateDomains() {
  return useMutation({
    mutationFn: (data: DomainBulkCreate) =>
      apiPost<DomainBulkCreateResponse>("/domains/bulk", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkCreateStructuredDomains() {
  return useMutation({
    mutationFn: (data: DomainBulkStructuredCreate) =>
      apiPost<DomainBulkCreateResponse>("/domains/bulk-structured", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useUpdateDomain(id: number) {
  return useMutation({
    mutationFn: (data: DomainUpdate) => apiPut<Domain>(`/domains/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: domainsKeys.all });
      queryClient.invalidateQueries({ queryKey: domainsKeys.detail(id) });
    },
  });
}

export function useDeleteDomain() {
  return useMutation({
    mutationFn: (id: number) => apiDelete(`/domains/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkAssignServer() {
  return useMutation({
    mutationFn: (data: DomainBulkAssignServer) =>
      apiPost<DomainBulkAssignResponse>("/domains/bulk-assign-server", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkAssignCloudflare() {
  return useMutation({
    mutationFn: (data: DomainBulkAssignCloudflare) =>
      apiPost<DomainBulkAssignResponse>("/domains/bulk-assign-cloudflare", data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useSetNameservers(id: number) {
  return useMutation({
    mutationFn: () => apiPost<SetNsResponse>(`/domains/${id}/set-ns`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: domainsKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: domainsKeys.all });
    },
  });
}

export function useBulkSetNameservers() {
  return useMutation({
    mutationFn: (domain_ids: number[]) =>
      apiPost<BulkSetNsResponse>("/domains/bulk-set-ns", { domain_ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useProvisionDomain() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost<ProvisionResponse>(`/domains/${domainId}/provision`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkProvisionDomains() {
  return useMutation({
    mutationFn: (domain_ids: number[]) =>
      apiPost<BulkProvisionResponse>("/domains/bulk-provision", { domain_ids }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useBulkFullSetup() {
  return useMutation({
    mutationFn: (payload: BulkFullSetupPayload) =>
      apiPost<BulkFullSetupResponse>("/domains/bulk-full-setup", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useCreateSite() {
  return useMutation({
    mutationFn: (payload: { domainId: number; site_only?: boolean }) =>
      apiPost<ProvisionResponse>(`/domains/${payload.domainId}/create-site`, {
        site_only: Boolean(payload.site_only),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useCreateDb() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost<SetNsResponse>(`/domains/${domainId}/create-db`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useDbCredentials(domainId: number | null | undefined) {
  return useQuery({
    queryKey: ["domains", domainId, "db-credentials"],
    queryFn: () => apiGet<DomainDbCredentials>(`/domains/${domainId}/db-credentials`),
    enabled: !!domainId,
  });
}

export function useRequestSsl() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost<SetNsResponse>(`/domains/${domainId}/ssl-request`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useCancelSsl() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost<SetNsResponse>(`/domains/${domainId}/ssl-cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useRefreshSsl() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost(`/domains/${domainId}/refresh-ssl`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useSetNginxOverride() {
  return useMutation({
    mutationFn: (payload: { domainId: number; data: NginxOverridePayload }) =>
      apiPost<SetNsResponse>(`/domains/${payload.domainId}/nginx-override`, payload.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useGetNginxOverride(domainId: number | null | undefined) {
  return useQuery({
    queryKey: ["domains", domainId, "nginx-override"],
    queryFn: () => apiGet<NginxOverrideResponse>(`/domains/${domainId}/nginx-override`),
    enabled: !!domainId,
  });
}

export function useMarkNsSet() {
  return useMutation({
    mutationFn: (payload: { domainId: number; set: boolean }) =>
      apiPost<Domain>(`/domains/${payload.domainId}/mark-ns-set`, { set: payload.set }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export function useCheckNs() {
  return useMutation({
    mutationFn: (domainId: number) =>
      apiPost<SetNsResponse>(`/domains/${domainId}/check-ns`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: domainsKeys.all }),
  });
}

export async function bulkImportDomains(params: {
  file: File;
  hasHeader: boolean;
  defaultRegistrarId?: number | null;
  onProgress?: (percent: number) => void;
}): Promise<BulkImportResponse> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("has_header", String(params.hasHeader));
  if (params.defaultRegistrarId != null) {
    form.append("default_registrar_id", String(params.defaultRegistrarId));
  }
  const r = await http.post<BulkImportResponse>("/domains/bulk-import", form, {
    headers: { "Content-Type": "multipart/form-data" },
    onUploadProgress: (evt) => {
      if (!evt.total || !params.onProgress) return;
      const percent = Math.round((evt.loaded / evt.total) * 100);
      params.onProgress(percent);
    },
  });
  return r.data;
}
