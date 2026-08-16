import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri, requireDesktop } from "../lib/runtime";
import { forgetSecretBlobs, readSecretBlob } from "../lib/secretBlob";
import { COLLECT_METRICS_COMMAND, parseServerMetrics } from "../lib/serverMetrics";
import { sshExecWithHostKeyRetry } from "../lib/sshHostKey";
import { useAuthStore } from "../store/auth";
import type { InstallFastpanelResult } from "../lib/deepLink";

export interface Server {
  id: number;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  os: string | null;
  /** Хостинг-провайдер. Свободный текст; `null` — «не указан» (пустой строки в колонке не бывает). */
  provider: string | null;
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
   * не объявляет, и до `extra="forbid"` она молча его выбрасывала (200 OK и
   * `NULL` в колонке) — в TS оно давало зелёную компиляцию на пути, который
   * теряет секрет. Теперь это ошибка типа здесь и 422 `extra_forbidden` там.
   */
  ssh_password_blob_id?: string | null;
  os?: string | null;
  /** Пустое поле формы едет как `null`, а не `""` — см. `providerPayload`. */
  provider?: string | null;
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
  /** См. `ServerCreate.provider`. Очистка поля — это `null`, а не отсутствие ключа. */
  provider?: string | null;
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

/**
 * Один сайт, прочитанный с сервера по SSH (`server_list_sites` → `list_sites` в
 * десктопе). Секретов здесь нет: только имя домена, владелец, путь и версия PHP.
 * Форма ТОЧНО повторяет `SiteInfo` из `ssh/fastpanel.rs` (serde → snake_case).
 */
export interface ServerSite {
  domain_name: string;
  site_user: string | null;
  site_path: string | null;
  php_version: string | null;
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

/**
 * Что нужно знать, чтобы дойти до сервера по SSH. Сущность, а не id: пароль
 * лежит блобом, ссылку на который знает только она, — ровно по той же причине,
 * что и у `useDeleteServer`.
 */
export type SshTarget = Pick<
  Server,
  "ip_address" | "ssh_port" | "ssh_user" | "ssh_password_blob_id"
>;

/**
 * Команда проверки связи. Выбрана по трём требованиям сразу: ничего не меняет
 * на живом сервере, есть везде (это builtin любого sh, в отличие от `uptime -p`
 * или `systemctl`, которых нет в урезанных образах) и даёт узнаваемый маркер в
 * stdout. Маркер не украшение: `ssh_exec` возвращает `-1` вместо кода возврата,
 * если сервер закрыл канал, не прислав `ExitStatus`, — по одному коду «связь
 * есть» отличить от «канал оборвался» нельзя, а по вернувшейся строке можно.
 *
 * Экспортируется ради теста: подмена на команду с побочным эффектом обязана
 * ломать сборку тестов, а не тихо проехать в живой прогон.
 */
export const SSH_TEST_COMMAND = "echo sdmp-ssh-ok";
const SSH_TEST_MARKER = "sdmp-ssh-ok";

/**
 * Выполнить команду на сервере — единственный путь фронта к чужой машине.
 * `action` — то, что не выйдет сделать в вебе, для `requireDesktop`
 * («Testing SSH» → «Testing SSH runs in the SDMP desktop app.»).
 *
 * Общий, а не «почти одинаковый в каждом вызове», по тому же соображению, что
 * записано в JSDoc `desktopOnly`: и запрет, и «пароль не задан» пользователь
 * читает как ОДНО правило продукта, а не как сообщения разных подсистем.
 * Раньше обе фразы были скопированы дословно, и разъехаться им мешала только
 * внимательность.
 *
 * Плейнтекст пароля появляется прямо в аргументах вызова и нигде не именуется:
 * попади он в `variables`/`data` мутации, react-query держал бы его ещё gcTime
 * и после `reset()` (см. `readSecretBlob`). Наружу отсюда уходит только код
 * возврата и вывод чужой машины.
 */
async function execOnServer(
  server: SshTarget,
  command: string,
  action: string,
): Promise<[number, string]> {
  requireDesktop(action);
  if (!server.ssh_password_blob_id) {
    // Кнопки такого сервера не показывают (`has_ssh` на бэкенде и есть «блоб
    // есть»), но поле nullable, и без этой ветки сюда приехал бы
    // `vault_decrypt_blob(blobId: undefined)` с «invalid args» на экране.
    // Кнопку формы по имени не зовём: её подпись зависит от состояния
    // («Добавить SSH» ровно там, где эта фраза и достижима, «Изменить SSH» —
    // где недостижима), и назвать её значило бы указать не на ту.
    throw new Error("This server has no SSH password saved — add SSH access first.");
  }
  return sshExecWithHostKeyRetry({
    host: server.ip_address,
    port: server.ssh_port || 22,
    user: server.ssh_user || "root",
    password: await readSecretBlob(server.ssh_password_blob_id),
    command,
  });
}

/**
 * Отказ словами чужой машины. Вывод показываем как есть: он объясняет причину
 * лучше любой нашей формулировки (`ssh_exec` отдаёт и stdout, и stderr). Но с
 * потолком: длину нам никто не обещал — при подмене команды или болтливом
 * профиле шелла сюда приехали бы килобайты чужого текста прямо в баннер.
 */
function sshFailure(code: number, output: string): string {
  const tail = output.trim().slice(0, 300);
  return `exit ${code}${tail ? `: ${tail}` : " with no output"}`;
}

/**
 * Проверка SSH — ТОЛЬКО десктоп. Эндпоинта `POST /servers/{id}/test-ssh` на
 * бэкенде нет и быть не может: пароль хранится блобом под мастер-ключом,
 * которого у сервера нет. (До этой правки фронт его звал и получал 404 —
 * остаток переезда выполнения в десктоп.)
 *
 * Путь целиком: блоб → плейнтекст → `ssh_exec` → результат. Наружу уходит
 * только «удалось/нет» и текст для человека; про плейнтекст — в `execOnServer`.
 */
export async function runSshTest(server: SshTarget): Promise<SshTestResult> {
  const [code, output] = await execOnServer(server, SSH_TEST_COMMAND, "Testing SSH");
  if (code === 0 && output.includes(SSH_TEST_MARKER)) {
    return {
      success: true,
      message: `${server.ssh_user || "root"}@${server.ip_address}:${server.ssh_port || 22} responded.`,
    };
  }
  return { success: false, message: sshFailure(code, output) };
}

/**
 * Аргументов у мутации нет намеренно: `variables` react-query переживают
 * `reset()`, и класть туда что-либо, связанное с секретом, нельзя. Всё нужное
 * замыкается на сущности сервера.
 */
export function useTestSsh(server: SshTarget | undefined) {
  return useMutation({
    mutationFn: async (): Promise<SshTestResult> => {
      if (!server) throw new Error("Server is still loading — try again in a moment.");
      return runSshTest(server);
    },
  });
}

/** Сервер, с которого снимаем метрики: адрес для SSH плюс id для отправки. */
export type MetricsTarget = SshTarget & Pick<Server, "id">;

/**
 * Снять метрики с сервера и отдать их бэкенду. ТОЛЬКО десктоп — по той же
 * причине, что и `runSshTest`: SSH-пароль лежит блобом под мастер-ключом,
 * которого у сервера нет. До переезда на zero-knowledge снимал сам бэкенд
 * (`server_metrics_service.py`), после — снимать стало некому, и карточки
 * показывают прочерки при живых колонках.
 *
 * Наружу из этой функции уходит только сущность сервера, вернувшаяся с
 * бэкенда; про пароль и запрет в вебе — в `execOnServer`.
 *
 * Полнота снимка проверяется финальным маркером внутри `parseServerMetrics`, а
 * НЕ кодом возврата: код принадлежит последней команде конвейера и о том,
 * доехали ли секции, не говорит ничего (`grep` без совпадения — это 1 на вполне
 * успешном снимке). В сообщение об отказе код всё же идёт: человеку он
 * объясняет, что случилось, лучше нашей формулировки.
 */
export async function runCollectMetrics(server: MetricsTarget): Promise<Server> {
  const [code, output] = await execOnServer(server, COLLECT_METRICS_COMMAND, "Collecting metrics");
  const metrics = parseServerMetrics(output);
  if (!metrics) {
    throw new Error(`Server returned no metrics — ${sshFailure(code, output)}`);
  }
  return apiPost<Server>(`/servers/${server.id}/metrics`, metrics);
}

/**
 * Аргументов у мутации нет по той же причине, что у `useTestSsh`: всё нужное
 * замыкается на сущности сервера, а `variables` react-query переживают
 * `reset()`. Сущность, а не id: ссылку на блоб с паролем знает только она.
 */
export function useRefreshMetrics(server: MetricsTarget | undefined) {
  return useMutation({
    mutationFn: async (): Promise<Server> => {
      if (!server) throw new Error("Server is still loading — try again in a moment.");
      return runCollectMetrics(server);
    },
    onSuccess: () => {
      // `all` = ["servers"] совпадает по префиксу и с ["servers", id], то есть
      // накрывает и карточку, и список (см. `useInstallFastPanel`).
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

/**
 * Прочитать список сайтов с сервера по SSH и вернуть его для сверки с доменами
 * SDMP (`lib/serverSites`). ТОЛЬКО десктоп: команда резолвит сервер из
 * локального кэша, расшифровывает SSH-блоб и ходит по SSH — веб этого не умеет
 * (принцип №3). Пришла на замену мёртвому `POST /servers/{id}/sync-domains`,
 * который переезд на zero-knowledge удалил (каждый клик по «Sync Domains» был
 * гарантированным 404).
 *
 * Результат — список без секретов (`ServerSite`: имя/владелец/путь/PHP), поэтому
 * его не грех держать в `data` мутации: сверку показывает сама карточка, пока
 * она открыта. Никаких мутаций на сервере — только чтение (`list_sites`).
 *
 * `invokeSynced`, а не `invokeIfTauri`: команда читает сервер из локального
 * SQLCipher-кэша, и только что заведённого сервера там может ещё не быть, если
 * не подтянуть изменения (та же причина, что у `install_fastpanel`).
 */
export function useServerListSites(id: number) {
  return useMutation({
    // Ключа `mutationKey` здесь нет намеренно: сверку наблюдает локальный
    // инстанс мутации (`listSites.data`/`isPending`), а не `useMutationState` по
    // ключу. Результат живёт, только пока открыта карточка сервера — это
    // страница, не модалка, и её перемонтирование посреди секундного чтения
    // маловероятно, а повтор безвреден (идемпотентное чтение). Наблюдение по
    // ключу (как у `installFastPanelKey` для получасовой установки) было бы
    // здесь мёртвым кодом.
    //
    // Работу делает Tauri-команда, а не webview: `navigator.onLine` про эту сеть
    // ничего не знает, а с дефолтным `networkMode: "online"` react-query на
    // «оффлайне» браузера не запустил бы `mutationFn` вовсе.
    networkMode: "always" as const,
    mutationFn: async (): Promise<ServerSite[]> => {
      if (!isTauri()) {
        // Своя русская фраза, а не `desktopOnly` (тот по шаблону английский):
        // кнопка сверки и её сообщения на карточке сервера ведутся по-русски.
        // Путь по сути недостижим — кнопка рисуется только в десктопе, — но
        // сообщение обязано быть одного языка с ней.
        throw new Error("Сверка сайтов доступна только в десктоп-приложении SDMP.");
      }
      const userId = useAuthStore.getState().userId;
      if (!userId) {
        throw new Error("Desktop: unlock session (user id missing)");
      }
      return invokeSynced<ServerSite[]>("server_list_sites", {
        userId,
        serverId: String(id),
      });
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
