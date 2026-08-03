import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
import { queryClient } from "./queryClient";
import { useAuthStore } from "../store/auth";

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

/**
 * Одна фраза и для брошенной ошибки, и для подписи под выключенной кнопкой:
 * оба места объясняют пользователю одно и то же, и разъехаться они не должны.
 */
export const NS_DESKTOP_NOTE = desktopOnly("Setting nameservers");

/**
 * Минимум nameservers, который принимают оба регистратора. Меньше двух — это
 * гарантированный отказ на их стороне, а отказ теперь ещё и оседает на сервере
 * как `ns_status: error`. Дешевле не пускать.
 */
export const MIN_NAMESERVERS = 2;

/**
 * Нормализация списка перед отправкой: убрать пустое, схлопнуть регистр и
 * повторы. Дубль (`ns1.x` дважды — обычная опечатка при ручном вводе) Namecheap
 * отбивает ошибкой, а отбитая попытка теперь пишет на сервер `ns_status: error`
 * — то есть опечатка портила бы состояние домена.
 */
export function normalizeNameservers(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const ns = raw.trim();
    if (!ns) continue;
    const key = ns.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ns);
  }
  return out;
}

/**
 * Аргументы смены NS. Три разных идентификатора, которые легко перепутать, —
 * поэтому они и разведены по именам, а не по позициям.
 */
export interface SetNameserversVars {
  /** Строка `domains` на сервере: адресат write-back'а `ns_status`. */
  domainId: number;
  /** ИМЯ домена: именно его ждёт API регистратора и аудит (`target_id`). */
  domainName: string;
  /**
   * Аккаунт РЕГИСТРАТОРА (`domains.registrar_id`), из которого команда достаёт
   * и расшифровывает API-ключ. Не аккаунт Cloudflare и не id домена.
   */
  registrarAccountId: number | null;
  nameservers: string[];
}

/**
 * Прописать NS у регистратора. Выполняет ТОЛЬКО десктоп: API-ключ регистратора
 * лежит на сервере зашифрованным блобом и расшифровывается на клиенте, поэтому
 * `POST /domains/{id}/set-ns` на бэкенде нет и не будет (в `routes/domains.py`
 * его никогда не было — остались только схемы ответа). Веб — «только смотрит».
 *
 * `invokeSynced`, а не `invokeIfTauri`: команда резолвит аккаунт регистратора из
 * локального SQLCipher-кэша, и без свежей синхронизации только что назначенный
 * регистратор ей не виден.
 *
 * Список NS передаётся явно: команда не умеет его добывать. Откуда его берёт UI
 * — вопрос UI (обычно NS зоны Cloudflare, см. `useZoneNameservers`).
 */
/**
 * Ключ смены NS. Не косметика: по нему `useMutationState` находит результат
 * попытки, начатой до последнего монтирования карточки. Namecheap отвечает
 * секундами, и без ключа отказ, прилетевший после закрытия модалки, терялся бы
 * совсем — per-call `onError` глушит `MutationObserver` при размонтировании
 * (`hasListeners()`), а своего канала событий у этой команды нет. Единственным
 * следом остался бы красный бейдж «NS: Error» в строке таблицы без причины.
 *
 * Ключ общий на все домены, а нужный отбирается предикатом по `variables`:
 * иначе `useSetNameservers` пришлось бы параметризовать доменом, который и так
 * едет в аргументах мутации.
 */
export const SET_NAMESERVERS_KEY = ["set-nameservers"] as const;

export function useSetNameservers() {
  return useMutation({
    mutationKey: SET_NAMESERVERS_KEY,
    mutationFn: async (vars: SetNameserversVars): Promise<boolean> => {
      if (!isTauri()) {
        throw new Error(NS_DESKTOP_NOTE);
      }
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      if (vars.registrarAccountId == null) {
        throw new Error("Assign a registrar account to this domain first.");
      }
      const nameservers = normalizeNameservers(vars.nameservers);
      if (nameservers.length < MIN_NAMESERVERS) {
        throw new Error(`Enter at least ${MIN_NAMESERVERS} distinct nameservers.`);
      }
      const ok = await invokeSynced<boolean>("registrar_set_nameservers", {
        userId,
        accountId: String(vars.registrarAccountId),
        // Оба: `domain` уходит регистратору и в аудит, `domainId` адресует
        // write-back `ns_status` (см. `registrar_set_nameservers` в Rust).
        domainId: String(vars.domainId),
        domain: vars.domainName,
        nameservers,
      });
      // Сегодня оба провайдера отвечают либо `Ok(true)`, либо ошибкой, так что
      // ветка недостижима. Но «успех» на `false` — молчаливая ложь про то,
      // делегирование чего пользователь только что менял.
      if (!ok) {
        throw new Error("The registrar did not apply the nameserver change.");
      }
      return ok;
    },
    // Именно `onSettled`: `ns_status` на сервере переписывает write-back самой
    // команды, и он срабатывает на ОБОИХ исходах — отказ регистратора кладёт
    // туда `error` и только потом доезжает сюда ошибкой. На `onSuccess` самый
    // интересный случай остался бы без обновления списка.
    onSettled: (_data, _err, vars) => {
      // Работу делает `all`: карточку домена рисует строка из списка (см.
      // `DomainDetailModal` в `Domains.tsx`), и без этой инвалидации она бы ещё
      // долго показывала «pending» после удавшейся смены.
      queryClient.invalidateQueries({ queryKey: domainsKeys.all });
      // `detail` пока сбрасывать некому: у `useDomain` нет ни одного
      // вызывающего. Оставлено как парная инвалидация — в тот день, когда
      // карточка станет отдельным запросом, забыть её здесь будет дороже.
      queryClient.invalidateQueries({ queryKey: domainsKeys.detail(vars.domainId) });
    },
  });
}

/**
 * Ответ `provision_domain` (см. `ProvisionResultOut` в `commands/provision.rs`).
 * Опциональные поля Rust опускает целиком, когда их нет; `ftp` приходит только
 * при `site_only: false`.
 *
 * `db.db_password` и `ftp.ftp_password` генерируются на сервере и больше нигде
 * не хранятся: показать один раз в модалке и не писать ни в localStorage, ни в
 * sessionStorage, ни в кэш запросов, ни в лог, ни в URL.
 */
export interface ProvisionDesktopResult {
  domain_id: string;
  site_user: string;
  site_path: string;
  ssl_issued?: boolean;
  ssl_error?: string;
  db?: { db_name: string; db_user: string; db_password: string };
  ftp?: { ftp_user: string; ftp_password: string };
}

/**
 * Аргументы одиночного provision.
 *
 * `withDb` обязателен и не имеет умолчания: создавать базу или нет — решение
 * пользователя, а не хука. Пока флаг был опциональным, ни один вызывающий его
 * не передавал, и опциональная БД была недостижима из интерфейса вообще.
 *
 * `domainName` команде не нужен (она адресует домен по id) — он нужен модалке
 * результата, чтобы назвать домен, чьи пароли показывает. Едет в аргументах
 * мутации, потому что путь «результат → показ» переживает размонтирование
 * страницы, с которой известно имя.
 */
export interface ProvisionDomainVars {
  domainId: number;
  domainName: string;
  withDb: boolean;
}

/** Результат provision вместе с именем домена — то, что показывает модалка. */
export interface ProvisionOutcome {
  domain: string;
  result: ProvisionDesktopResult;
}

/**
 * Ключ запущенного provision. Общий на все домены, конкретный отбирается
 * предикатом по `variables.domainId` — как у `SET_NAMESERVERS_KEY`, и по той же
 * причине: хук на странице один, а строк в таблице много.
 *
 * Не косметика: без ключа перемонтированная страница не видит летящую мутацию
 * (`MutationObserver` подхватывает только мутации своего ключа), `isPending`
 * читается как `false`, и второй клик открывает вторую SSH-сессию с
 * create_site/create_ftp_account/certbot по тому же домену.
 */
export const PROVISION_DOMAIN_KEY = ["provision-domain"] as const;

/**
 * Provision одного домена. Выполняет ТОЛЬКО десктоп.
 *
 * Ответ команды содержит пароли БД и FTP в открытом виде — они существуют
 * только там и больше нигде (сервер их не знает по определению). Отсюда две
 * связанные вещи, которые нельзя «упростить», — ровно как у
 * `useInstallFastPanel`, см. его JSDoc.
 *
 * 1. Результат уходит в `onResult` изнутри `mutationFn`, а наружу возвращается
 *    один `domain_id`. Попади он в возврат `mutationFn`, react-query положил бы
 *    пароли в `data` MutationCache, откуда их не убирает даже `reset()`: запись
 *    живёт там ещё gcTime (5 минут по умолчанию).
 * 2. Именно `onResult`, а НЕ `mutate(vars, { onSuccess })` у места вызова.
 *    Замыкание `mutationFn` переживает размонтирование, а per-call коллбэки —
 *    нет: `MutationObserver` гасит их через `this.hasListeners()`, и они молча
 *    теряются. Для операции на минуты (SSH + certbot) это разница между
 *    «пароли показаны» и «пароли потеряны навсегда».
 *
 * `onResult` обязан только показать креды один раз и не сохранять
 * (см. `ProvisionResultModal`).
 */
function provisionDomainOptions(onResult: (outcome: ProvisionOutcome) => void) {
  return {
    mutationKey: PROVISION_DOMAIN_KEY,
    mutationFn: async (vars: ProvisionDomainVars) => {
      if (!isTauri()) {
        throw new Error(desktopOnly("Provisioning"));
      }
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      const result = await invokeSynced<ProvisionDesktopResult>("provision_domain", {
        userId,
        domainId: String(vars.domainId),
        siteOnly: false,
        withDb: vars.withDb,
      });
      onResult({ domain: vars.domainName, result });
      // НЕ «return result»: пароли ушли бы в data MutationCache — см. JSDoc.
      return { domain_id: result.domain_id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: domainsKeys.all });
    },
  };
}

export function useProvisionDomain(onResult: (outcome: ProvisionOutcome) => void) {
  return useMutation(provisionDomainOptions(onResult));
}

/**
 * Тот же provision, но запущенный ВНЕ React — путь deep link `sdmp://provision`.
 *
 * Не прямой `invokeSynced`, а мутация в том же `MutationCache` и под тем же
 * `PROVISION_DOMAIN_KEY`: иначе страница `Domains` запущенной по ссылке
 * операции не видит (`useMutationState` смотрит именно в кэш), ⚙ той же строки
 * остаётся активной, и клик открывает вторую SSH-сессию с
 * create_site/create_ftp_account/certbot по тому же домену.
 *
 * Результат возвращается вызывающему — он обязан показать пароли один раз
 * (`ProvisionResultModal`) и не сохранять. В кэше мутаций их нет: туда попадает
 * только возврат `mutationFn`, то есть `{ domain_id }`.
 */
export async function runProvisionDomain(vars: ProvisionDomainVars): Promise<ProvisionOutcome> {
  // Парная сторона того же гейта. Кнопку ⚙ блокирует страница, читая этот же
  // кэш; ссылка приходит извне и о летящей операции не знает, а Rust на этом
  // пути не страхует: `site_exists`/`ssl_exists` проверяются в начале прогона,
  // то есть до того, как первая попытка что-то создала. Без проверки ссылка
  // открывала бы вторую SSH-сессию по домену, который уже провижинится.
  const running = queryClient.getMutationCache().find({
    mutationKey: PROVISION_DOMAIN_KEY,
    status: "pending",
    predicate: (m) =>
      (m.state.variables as ProvisionDomainVars | undefined)?.domainId === vars.domainId,
  });
  if (running) {
    throw new Error(`Provisioning of domain #${vars.domainId} is already running.`);
  }
  let outcome: ProvisionOutcome | null = null;
  const mutation = queryClient
    .getMutationCache()
    .build(queryClient, provisionDomainOptions((o) => { outcome = o; }));
  await mutation.execute(vars);
  if (!outcome) {
    // Недостижимо: `mutationFn` зовёт `onResult` до возврата, а до сюда мы
    // доходим только после его успеха. Но молча вернуть «результата нет» —
    // это тот же потерянный пароль, поэтому громко.
    throw new Error("Provision finished without a result");
  }
  return outcome;
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

// `useMarkNsSet` и `useCheckNs` удалены вместе с кнопками, которые их звали:
// роутов `POST /domains/{id}/mark-ns-set` и `/check-ns` на бэкенде нет
// (`grep -rn "check-ns\|mark-ns-set" backend` — пусто), то есть обе всегда
// давали 404. Заменить их Tauri-командой сегодня нечем: проверка делегирования
// — это DNS-резолв, а в десктопе нет ни такой команды (см. список в `lib.rs`),
// ни резолвера в зависимостях. Кнопка, которая всегда 404, хуже отсутствующей:
// она обещает функцию, которой нет, и забивает общий баннер ошибок.

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
