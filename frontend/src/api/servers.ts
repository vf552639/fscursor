import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
import { forgetSecretBlobs } from "../lib/secretBlob";
import { useAuthStore } from "../store/auth";
import type { InstallFastpanelResult } from "../lib/deepLink";

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
  /**
   * Ссылка на блоб от `putSecretBlob` — единственный способ передать
   * SSH-пароль. Поля `ssh_password` здесь нет намеренно: серверная схема его
   * не объявляет и с `extra="ignore"` молча выбрасывает (200 OK и `NULL` в
   * колонке), поэтому в TS оно давало зелёную компиляцию на пути, который
   * теряет секрет. Без него это ошибка типа, а не молчаливая потеря.
   */
  ssh_password_blob_id?: string | null;
  os?: string | null;
  purchase_date?: string | null;
  expiry_date?: string | null;
  fastpanel_user?: string;
  /** См. `ssh_password_blob_id`: `fastpanel_password` здесь нет по той же причине. */
  fastpanel_password_blob_id?: string | null;
  fastpanel_url?: string;
  fastpanel_status?: string;
}

export interface ServerUpdate {
  name?: string;
  ip_address?: string;
  ssh_port?: number;
  ssh_user?: string;
  /** См. `ServerCreate.ssh_password_blob_id`. При правке — ТОТ ЖЕ id. */
  ssh_password_blob_id?: string | null;
  os?: string | null;
  status?: string;
  purchase_date?: string | null;
  expiry_date?: string | null;
  fastpanel_user?: string;
  /** См. `ServerCreate.fastpanel_password_blob_id`. При правке — ТОТ ЖЕ id. */
  fastpanel_password_blob_id?: string | null;
  fastpanel_url?: string;
  fastpanel_status?: string;
}

export interface SshTestResult {
  success: boolean;
  message: string;
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
};

/**
 * Ключ запущенной установки FastPanel. Один и тот же у `useInstallFastPanel` и
 * у `useMutationState` на странице: он и есть тот общий адрес, по которому
 * страница узнаёт про установку, начатую до её последнего монтирования.
 */
export const installFastPanelKey = (id: number) => ["install-fastpanel", id] as const;

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

/** Аргумент — сущность, а не id: ссылки на блобы знает только она (`forgetSecretBlobs`). */
export function useDeleteServer() {
  return useMutation({
    mutationFn: async (
      server: Pick<Server, "id" | "ssh_password_blob_id" | "fastpanel_password_blob_id">,
    ) => {
      await apiDelete(`/servers/${server.id}`);
      await forgetSecretBlobs([server.ssh_password_blob_id, server.fastpanel_password_blob_id]);
    },
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

/**
 * Установка FastPanel. Выполняет ТОЛЬКО десктоп: команда лезет по SSH на живой
 * сервер, обновляет все пакеты и запускает инсталлятор (30-40 минут). Эндпоинта
 * `POST /servers/{id}/install-fastpanel` на бэкенде нет и быть не должно — веб
 * вместо вызова отдаёт deep link `sdmp://install-fastpanel` (см. OpenInDesktop).
 *
 * `invokeSynced`, а не `invokeIfTauri`: команда резолвит сервер из локального
 * SQLCipher-кэша, и от свежести кэша зависит проверка идемпотентности
 * (`fastpanel_status == "installed"`), которую заполняет write-back.
 *
 * Ответ команды содержит пароль панели в открытом виде — он существует только
 * там и больше нигде. Отсюда две связанные вещи, которые нельзя «упростить».
 *
 * 1. Креды уходят в `onCreds` изнутри `mutationFn`, а наружу возвращается один
 *    `server_id`. Попади они в возврат `mutationFn`, react-query положил бы их
 *    в `data` MutationCache, откуда их не убирает даже `reset()` — запись живёт
 *    там ещё gcTime (5 минут по умолчанию).
 * 2. Именно `onCreds`, а НЕ `mutate(vars, { onSuccess })` у места вызова.
 *    Замыкание `mutationFn` переживает размонтирование (здесь `onCreds`
 *    захватывает `setFpCreds` всегда смонтированного DesktopWorkspace), а
 *    per-call коллбэки — нет: `MutationObserver` гасит их через
 *    `this.hasListeners()`, и они молча теряются. Для операции на 40 минут это
 *    разница между «пароль показан» и «пароль потерян навсегда».
 *
 * `onCreds` обязан только показать креды один раз и не сохранять
 * (см. FastPanelCredsModal).
 *
 * `mutationKey` не косметика: по нему `useMutationState` находит запущенную
 * установку после ухода со страницы и обратно. Без ключа новый observer не
 * подхватывает живую мутацию, `isPending` читается как `false` — и второй клик
 * запускает вторую установку поверх первой. В Rust страховки нет: проверка
 * идемпотентности смотрит `fastpanel_status == "installed"`, а он появляется
 * только в конце, при write-back.
 */
export function useInstallFastPanel(id: number, onCreds: (creds: InstallFastpanelResult) => void) {
  return useMutation({
    mutationKey: installFastPanelKey(id),
    mutationFn: async (opts?: { force?: boolean }) => {
      if (!isTauri()) {
        throw new Error(desktopOnly("Installing FastPanel"));
      }
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      const creds = await invokeSynced<InstallFastpanelResult>("install_fastpanel", {
        userId,
        serverId: String(id),
        force: Boolean(opts?.force),
      });
      onCreds(creds);
      // НЕ «return creds»: ушло бы в data MutationCache на gcTime — см. JSDoc выше.
      return { server_id: creds.server_id };
    },
    onSuccess: () => {
      // Обновление статуса тянем с сервера: его туда пишет write-back самой
      // команды. В кэш запросов кладём только то, что уже знает сервер.
      // `all` = ["servers"] совпадает по префиксу и с ["servers", id].
      queryClient.invalidateQueries({ queryKey: serversKeys.all });
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
