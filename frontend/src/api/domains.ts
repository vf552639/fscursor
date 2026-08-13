import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
import { queryClient } from "./queryClient";
import { registrarsKeys } from "./registrars";
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

// Со страницы `Domains` хук ушёл вместе с недостижимым `EditDomainModal`, но
// чистить его нечего: живой вызывающий — карточка сервера (`ServerDetail`,
// действие «Edit domain»), роут `PUT /domains/{id}` реальный, и им же будет
// писаться привязка домена к зоне Cloudflare (отдельный план).
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
 * — вопрос UI (обычно NS зоны Cloudflare, см. `useCloudflareZones`).
 */
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
      // NS этого домена у регистратора — то, по чему карточка сверяет
      // делегирование. Мы только что поменяли ровно их, и без сброса бейдж ещё
      // минуту (`staleTime`) показывал бы «MISMATCH» на удавшейся смене. На
      // ОБОИХ исходах: отказ регистратора мог примениться частично.
      if (vars.registrarAccountId != null) {
        queryClient.invalidateQueries({
          queryKey: registrarsKeys.nameservers(vars.registrarAccountId, vars.domainName),
        });
      }
    },
  });
}

/**
 * Что стало с базой домена (см. `DbOut` в `commands/provision.rs`).
 *
 * Размеченное объединение, а не «пароль может не прийти»: у существующей базы
 * пароль выдан прошлым прогоном и не хранится больше нигде, поэтому в варианте
 * `exists` поля пароля НЕТ — обратиться к нему нельзя, не сузив тип. Тот же
 * приём, которым в фазе 3a закрывались пароли в `BulkProvisionReport`: убрать
 * поле из типа, а не договориться его не трогать.
 *
 * Вместе с `undefined` («базу не просили») состояний три, и все различимы.
 */
export type ProvisionDbResult =
  | { status: "created"; db_name: string; db_user: string; db_password: string }
  | {
      status: "exists";
      db_name: string;
      db_user: string;
      /**
       * Есть ли сама база. Отсутствует, когда проверить не удалось и «уже
       * существует» распознано по тексту ошибки создания.
       *
       * Провижининг пропускает пару по ПОЛЬЗОВАТЕЛЮ (пароль его), а база могла
       * быть дропнута руками — тогда она так и осталась несозданной, и сказать
       * «база уже существовала» было бы неправдой. Три значения, три разные
       * фразы; `undefined` — про базу не утверждаем ничего.
       */
      database_exists?: boolean;
    };

/** Что стало с FTP-аккаунтом домена (см. `FtpOut` в `commands/provision.rs`). */
export type ProvisionFtpResult =
  | { status: "created"; ftp_user: string; ftp_password: string }
  | { status: "exists"; ftp_user: string };

/**
 * Ответ `provision_domain` (см. `ProvisionResultOut` в `commands/provision.rs`).
 * Опциональные поля Rust опускает целиком, когда их нет; `ftp` приходит только
 * при `site_only: false`.
 *
 * `db.db_password` и `ftp.ftp_password` генерируются на сервере и больше нигде
 * не хранятся: показать один раз в модалке и не писать ни в localStorage, ни в
 * sessionStorage, ни в кэш запросов, ни в лог, ни в URL. Приходят они только в
 * варианте `created` — то есть только у того прогона, который их и создал.
 */
export interface ProvisionDesktopResult {
  domain_id: string;
  site_user: string;
  site_path: string;
  ssl_issued?: boolean;
  ssl_error?: string;
  db?: ProvisionDbResult;
  ftp?: ProvisionFtpResult;
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
    // Провижн идёт по SSH из десктопа, а не из webview: `navigator.onLine`
    // ничего про эту сеть не знает. С дефолтным `networkMode: "online"`
    // react-query на «оффлайне» браузера переводит мутацию в `pending`, но
    // `mutationFn` не запускает вовсе — то есть ⚙ показывал бы «Provisioning…»
    // для прогона, который не начинался, и гейт держал бы домен занятым.
    networkMode: "always" as const,
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

/**
 * Строка отчёта массового прогона (см. `BulkProvisionItem` в
 * `commands/provision.rs`). Три исхода различимы намеренно: «не запускался» —
 * это не «упал», и повтор после обрыва должен идти по хвосту, а не вслепую.
 */
export type BulkProvisionItem =
  | { domain_id: string; outcome: "done"; result: ProvisionDesktopResult }
  | { domain_id: string; outcome: "failed"; error: string }
  | { domain_id: string; outcome: "skipped" };

/** Ответ команды `provision_bulk` (см. `BulkProvisionOut` в Rust). */
export interface BulkProvisionDesktopResult {
  idempotency_key: string;
  status: "ok" | "failed" | "already_ran";
  error?: string;
  /**
   * Статус ПРЕДЫДУЩЕГО прогона — только при `already_ran`. `running` и `done` —
   * разные новости: у `running` прогон могли оборвать крашем, и тогда «пароли
   * уже показаны» неправда (см. `BulkProvisionOut` в Rust).
   */
  previous_status?: string;
  items: BulkProvisionItem[];
}

/**
 * Разобранный отчёт массового прогона — то, что показывает воркспейс.
 *
 * `results` несут пароли FTP (и БД, если бы массовый путь её создавал). Они
 * существуют ТОЛЬКО здесь: сервер их не знает, кэш мутаций и локальный
 * SQLCipher-кэш не хранят. Каждый обязан быть показан ровно один раз
 * (`ProvisionResultModal` через очередь показов) и не осесть ни в localStorage,
 * ни в кэше запросов, ни в логе.
 */
export interface BulkProvisionOutcome {
  status: "ok" | "failed" | "already_ran";
  /** Причина обрыва прогона — только при `failed`. */
  error?: string;
  /** Ключ прогона: то, что пользователю есть чем назвать проблему в поддержке. */
  idempotencyKey: string;
  /** Статус предыдущего прогона — только при `already_ran`. */
  previousStatus?: string;
  results: ProvisionOutcome[];
  failed: Array<{ domainId: string; error: string }>;
  /** Домены, до которых прогон не дошёл. */
  skipped: string[];
}

/**
 * Отчёт БЕЗ паролей: `results` сужены до имени домена.
 *
 * Тип, а не обещание в комментарии. Всё, что рисует итог прогона (заголовочная
 * строка, экран `BulkProvisionReportModal`), принимает именно его — и тогда
 * `r.result.ftp?.ftp_password` там не компилируется, вместо того чтобы
 * компилироваться и ждать ревьюера. Тот же приём, которым в фазе 1 закрывались
 * плейнтекст-поля в TS-типах: убрать поле из типа, а не договориться его не
 * трогать.
 *
 * `BulkProvisionOutcome` присваивается сюда структурно, так что вызывающему
 * ничего конвертировать не нужно.
 */
export type BulkProvisionReport = Omit<BulkProvisionOutcome, "results"> & {
  results: ReadonlyArray<{ domain: string }>;
};

/**
 * Заголовочная строка об исходе массового прогона.
 *
 * Отдельная чистая функция, а не шаблон внутри воркспейса, по двум причинам:
 * её проверяет тест, и она не может коснуться паролей — их нет в её типе
 * аргумента. Текст уезжает в DOM и в скриншоты.
 *
 * Про `already_ran` говорится РАЗНОЕ для `running` и `done`. Слепив их, мы
 * врали бы в половине случаев: `running` мог остаться от прогона, убитого
 * крашем на середине, — тогда «пароли уже показаны» неправда, их никто не
 * видел, а половина доменов не тронута.
 */
export function summarizeBulkProvision(o: BulkProvisionReport): string {
  if (o.status === "already_ran") {
    if (o.previousStatus === "running") {
      return (
        "Bulk provision: a run over exactly this set of domains is already marked as " +
        "in progress, so nothing was started again. If that run was interrupted, retry " +
        "later or change the set."
      );
    }
    return (
      "Bulk provision: this exact set of domains was already provisioned by an earlier " +
      "run, so nothing was started again. Credentials are shown once, so that run's " +
      "passwords cannot be shown again."
    );
  }
  const parts = [`${o.results.length} provisioned`];
  if (o.failed.length > 0) parts.push(`${o.failed.length} failed`);
  if (o.skipped.length > 0) parts.push(`${o.skipped.length} not started`);
  const head = `Bulk provision: ${parts.join(", ")}.`;
  const first = o.failed[0];
  return first ? `${head} #${first.domainId}: ${first.error}` : head;
}

function parseBulkProvisionResult(res: BulkProvisionDesktopResult): BulkProvisionOutcome {
  const results: ProvisionOutcome[] = [];
  const failed: Array<{ domainId: string; error: string }> = [];
  const skipped: string[] = [];
  for (const item of res.items) {
    if (item.outcome === "done") {
      // Имени домена у массового пути нет — он адресует по id, как и ссылка;
      // та же форма `#id`, что в тексте подтверждения и у deep link'а provision.
      results.push({ domain: `#${item.domain_id}`, result: item.result });
    } else if (item.outcome === "failed") {
      failed.push({ domainId: item.domain_id, error: item.error });
    } else {
      skipped.push(item.domain_id);
    }
  }
  return {
    status: res.status,
    error: res.error,
    idempotencyKey: res.idempotency_key,
    previousStatus: res.previous_status,
    results,
    failed,
    skipped,
  };
}

/**
 * Занять на время массового прогона тот же гейт, которым защищён одиночный
 * provision, — по одной заявке на каждый домен набора.
 *
 * Почему так, а не флагом «идёт bulk». Гейт живёт в `MutationCache` под
 * `PROVISION_DOMAIN_KEY`, и обе его стороны отбирают домен предикатом по
 * `variables.domainId`: страница `Domains` гасит ⚙ (`useMutationState`), а
 * `runProvisionDomain` бросает на летящем домене. Массовый прогон — это один
 * вызов с одним `variables`, поэтому предикату он неотличим от чужого домена;
 * чтобы обе стороны увидели каждый домен набора, на каждый заводится
 * собственная pending-мутация, висящая ровно столько, сколько идёт прогон.
 *
 * Заявка ничего не выполняет и ничего не возвращает, кроме id: результат
 * приезжает отчётом bulk, а возврат `mutationFn` react-query кладёт в `data`
 * `MutationCache`, откуда его не убирает даже `reset()` (запись живёт ещё
 * gcTime). Паролям там не место.
 *
 * Возвращает функцию освобождения. Звать её ОБЯЗАТЕЛЬНО на любом исходе, иначе
 * домены останутся «провижинятся» навсегда и ⚙ уже не включится.
 */
function claimProvisionGate(domainIds: number[]): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    for (const domainId of domainIds) {
      const claim = queryClient.getMutationCache().build(queryClient, {
        mutationKey: PROVISION_DOMAIN_KEY,
        // Тот же `networkMode: "always"`, что у настоящего provision, и здесь он
        // спасает от худшего: на «оффлайне» браузера retryer ставит мутацию в
        // `pending` и НЕ зовёт `mutationFn`, а значит заявка никогда не дождётся
        // `held` — `release()` в `finally` резолвит промис, которого никто не
        // ждёт. Заявка так и висит `pending` до возвращения сети: ⚙ на этих
        // доменах читается как «Provisioning…» бесконечно, каждый повтор
        // отвечает «already running», и снять это из UI нечем.
        networkMode: "always" as const,
        mutationFn: async (vars: ProvisionDomainVars) => {
          await held;
          return { domain_id: String(vars.domainId) };
        },
      });
      // `void` + `catch`: заявка живёт своей жизнью, а её промис никого не
      // интересует — ждём мы сам прогон.
      void claim.execute(gateClaimVars(domainId)).catch(() => {});
    }
  } catch (e) {
    // Провал на середине набора оставил бы уже поставленные заявки висеть
    // вечно — то есть навсегда погасил бы ⚙ на части доменов.
    release();
    throw e;
  }
  return release;
}

/**
 * `variables` заявки гейта.
 *
 * `bulkGateClaim` — маркер, а не украшение: читатель `MutationCache` (страница
 * `Domains`, `runProvisionDomain`, любой отладчик) иначе не отличит заявку от
 * настоящего запроса на provision. `domainName` и `withDb` у заявки выдуманы —
 * поля осмысленные, значения ничего не значат, потому что никакого provision
 * заявка не делает.
 */
function gateClaimVars(domainId: number): ProvisionDomainVars & { bulkGateClaim: true } {
  return { domainId, domainName: `#${domainId}`, withDb: false, bulkGateClaim: true };
}

/**
 * Заявка ли это гейта массового прогона? Читается по тому же маркеру, который
 * ставит `gateClaimVars`, — и живёт рядом с ним намеренно: страница `Domains`
 * гасит по этому признаку кнопку «Provision» тулбара, и разъехавшийся с
 * записью литерал сделал бы кнопку живой во время прогона.
 *
 * Признак «идёт массовый прогон» берётся отсюда, а не из локального `useState`,
 * по той же причине, что и подоменный гейт для ⚙: прогон идёт минутами и
 * переживает уход со страницы, а `useState` размонтированной страницы — нет.
 */
export function isBulkGateClaim(vars: unknown): boolean {
  return (vars as { bulkGateClaim?: unknown } | undefined)?.bulkGateClaim === true;
}

/** Домены набора, по которым provision уже летит (кнопкой, ссылкой или другим bulk). */
function alreadyProvisioning(domainIds: number[]): number[] {
  return domainIds.filter((id) =>
    queryClient.getMutationCache().find({
      mutationKey: PROVISION_DOMAIN_KEY,
      status: "pending",
      predicate: (m) => (m.state.variables as ProvisionDomainVars | undefined)?.domainId === id,
    }),
  );
}

/**
 * Массовый provision — путь deep link `sdmp://bulk-provision`. Только десктоп.
 *
 * Отчёт возвращается вызывающему целиком: на каждом домене создаётся
 * FTP-аккаунт, пароль которого существует только в этом ответе. Вызывающий
 * обязан показать каждый результат ровно один раз и не сохранять.
 *
 * Оба конца гейта одиночного provision соблюдены: набор не стартует, если
 * какой-то из его доменов уже провижинится, и на время прогона каждый домен
 * набора занят для кнопки ⚙ и для `sdmp://provision`.
 */
export async function runBulkProvisionDomains(
  userId: string,
  domainIds: string[],
): Promise<BulkProvisionOutcome> {
  if (!isTauri()) {
    throw new Error(desktopOnly("Provisioning"));
  }
  // Дубликаты убираем ДО всего: `ids=1,1,1` заводил три заявки на домен 1 и
  // трижды провижинил его в Rust — то есть трижды создавал FTP-аккаунт, из
  // которых пользователь увидел бы три разных пароля к одному логину.
  const ids = [...new Set(domainIds)];
  // Гейт ключуется числовым id — тем же, что кладёт в `variables` страница.
  // Нечисловой id ссылки гейту не соответствует ничему; такой домен всё равно
  // отобьёт Rust («domain not in local cache»), и он попадёт в отчёт как failed.
  const numeric = ids.map(Number).filter((n) => Number.isInteger(n));
  const busy = alreadyProvisioning(numeric);
  if (busy.length > 0) {
    throw new Error(
      `Provisioning of ${busy.map((id) => `#${id}`).join(", ")} is already running.`,
    );
  }
  const release = claimProvisionGate(numeric);
  try {
    const res = await invokeSynced<BulkProvisionDesktopResult>("provision_bulk", {
      userId,
      domainIds: ids,
    });
    return parseBulkProvisionResult(res);
  } finally {
    release();
    queryClient.invalidateQueries({ queryKey: domainsKeys.all });
  }
}

// Здесь же лежал HTTP-слой исполнения: `useBulkProvisionDomains`,
// `useBulkFullSetup`, `useCreateSite`, `useCreateDb`, `useDbCredentials`,
// `useRequestSsl`, `useCancelSsl`, `useRefreshSsl`, `useSetNginxOverride`,
// `useGetNginxOverride` и типы их ответов (`ProvisionResponse`, `SetNsResponse`,
// `DomainDbCredentials`, `NginxOverridePayload`/`NginxOverrideResponse`,
// `BulkProvisionResponse`, `BulkFullSetupPayload`/`BulkFullSetupResponse`).
// Удалены вместе с кнопками, которые их звали: в
// `backend/app/api/routes/domains.py` объявлены только list,
// failed-export.csv, get/{id}, create, bulk, bulk-structured, put/{id},
// delete/{id}, bulk-assign-server, bulk-assign-cloudflare, bulk-import,
// bulk-import-errors/{token} — ни одного из этих путей там нет, поэтому каждый
// такой хук всегда получал 404. Транспорт тут ни при чём, и «это же десктоп»
// не спасало: `apiPost`/`apiGet` в Tauri уходят не в axios, а в команду
// `api_request` (`api/client.ts`), но она проксирует к тому же REST API — 404
// одинаково в вебе и в десктопе. (Исходный аудит `task7.md` объяснял это тем,
// что `apiPost` — «чистый axios, не Tauri-aware»; это неверно, вывод — верен.)
// Замены сегодня нет и это не недосмотр чистки: гранулярные операции по домену
// (Create Site / Create DB / Request SSL / Refresh SSL / nginx-override) требуют
// новых Tauri-команд и SSH-логики в десктопе (в `lib.rs` таких команд нет), а
// Full Setup — связки assign → `cf_create_zone` → `registrar_set_nameservers`.
// Возврат каждой — отдельная фича со своим планом. Единственное, что уже
// переехало, — массовый provision: `runBulkProvisionDomains` выше
// (команда `provision_bulk`), его и зовёт кнопка тулбара.

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
