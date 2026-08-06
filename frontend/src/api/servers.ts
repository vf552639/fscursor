import { useMutation, useQuery } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost, apiPut, http } from "./client";
import { queryClient } from "./queryClient";
import { invokeSynced } from "../lib/localCache";
import { desktopOnly, isTauri, requireDesktop } from "../lib/runtime";
import { forgetSecretBlobs, readSecretBlob } from "../lib/secretBlob";
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
 * Проверка SSH — ТОЛЬКО десктоп. Эндпоинта `POST /servers/{id}/test-ssh` на
 * бэкенде нет и быть не может: пароль хранится блобом под мастер-ключом,
 * которого у сервера нет. (До этой правки фронт его звал и получал 404 —
 * остаток переезда выполнения в десктоп.)
 *
 * Путь целиком: блоб → плейнтекст → `ssh_exec` → результат. Плейнтекст
 * появляется прямо в аргументах вызова и нигде не именуется: попади он в
 * `variables`/`data` мутации, react-query держал бы его ещё gcTime и после
 * `reset()` (см. `readSecretBlob`). Поэтому наружу уходит только «удалось/нет»
 * и текст для человека.
 */
export async function runSshTest(server: SshTarget): Promise<SshTestResult> {
  requireDesktop("Testing SSH");
  if (!server.ssh_password_blob_id) {
    // Кнопка такого сервера не показывает (`has_ssh` на бэкенде и есть «блоб
    // есть»), но поле nullable, и без этой ветки сюда приехал бы
    // `vault_decrypt_blob(blobId: undefined)` с «invalid args» на экране.
    // Кнопку формы по имени не зовём: её подпись зависит от состояния
    // («Добавить SSH» ровно там, где эта фраза и достижима, «Изменить SSH» —
    // где недостижима), и назвать её значило бы указать не на ту.
    throw new Error("This server has no SSH password saved — add SSH access first.");
  }
  const [code, output] = await sshExecWithHostKeyRetry({
    host: server.ip_address,
    port: server.ssh_port || 22,
    user: server.ssh_user || "root",
    password: await readSecretBlob(server.ssh_password_blob_id),
    command: SSH_TEST_COMMAND,
  });
  if (code === 0 && output.includes(SSH_TEST_MARKER)) {
    return {
      success: true,
      message: `${server.ssh_user || "root"}@${server.ip_address}:${server.ssh_port || 22} responded.`,
    };
  }
  // Вывод показываем как есть: он от чужой машины и объясняет отказ лучше любой
  // нашей формулировки (`ssh_exec` отдаёт и stdout, и stderr). Но с потолком:
  // длину нам никто не обещал — при подмене команды или болтливом профиле
  // шелла сюда приехали бы килобайты чужого текста прямо в баннер.
  const tail = output.trim().slice(0, 300);
  return { success: false, message: `exit ${code}${tail ? `: ${tail}` : " with no output"}` };
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

/**
 * Тело `POST /servers/{id}/metrics` — ровно то, что десктоп УМЕЕТ снять. Имя
 * повторяет серверную схему (`schemas/server.ServerMetricsIn`) намеренно: тип
 * обязан ходить с ней в ногу, а `ServerMetrics` в `pages/dashboardData.ts` —
 * это уже view-модель карточки, и путать их нельзя.
 *
 * Все поля обязательны и nullable, и это главное свойство типа. Бэкенд читает
 * тело через `exclude_unset` и различает два случая: явный `null` ЗАТИРАЕТ
 * колонку, отсутствующий ключ её НЕ ТРОГАЕТ (`server_service.apply_metrics`).
 * Отсюда правило: «пробовали снять, но не разобрали» — это `null` (снимок
 * атомарен, и старое число под свежей `metrics_collected_at` выглядело бы
 * правдой), а «не собираем вовсе» — это отсутствие ключа.
 *
 * Поэтому здесь НЕТ `fastpanel_version`: его пишет установщик панели, а мы его
 * не измеряем — пришли мы его как `null`, и первый же сбор метрик стёр бы
 * версию, которую туда положил провижн. Не «забыли добавить», а нельзя: с
 * `Required`-полями компилятор не даст ни забыть заполненное, ни дослать лишнее
 * (на бэкенде лишний ключ — 422 `extra_forbidden`).
 */
export interface ServerMetricsIn {
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
}

/** Сервер, с которого снимаем метрики: адрес для SSH плюс id для отправки. */
export type MetricsTarget = SshTarget & Pick<Server, "id">;

/**
 * Команда сбора метрик. Один вход по SSH на весь снимок и ни одной записи на
 * чужой машине: только `cat`/`head`/`grep`/`df`/`uname`/`nproc` по `/proc` и
 * `/etc/os-release`.
 *
 * Каждая секция помечена строкой-маркером. Маркеры — не украшение: вывод едет с
 * ЧУЖОЙ машины, где `/proc/net/dev` может отсутствовать (контейнер), `nproc` —
 * не быть установлен, а SSH-баннер — приехать поверх нашего stdout. Без маркеров
 * парсер угадывал бы секции по форме и на первом же нестандартном хосте
 * приписал бы значение не тому полю. С маркерами пропавшая секция — это ровно
 * `null` в своём поле и ничего больше.
 *
 * `2>/dev/null` на каждом источнике и никаких `&&`: одна недоступная секция не
 * должна ронять весь сбор.
 *
 * `sleep 1` посередине обязателен. `/proc/stat` — счётчики С МОМЕНТА ЗАГРУЗКИ:
 * одиночный замер даёт среднюю загрузку за всё время работы машины, а не то,
 * что пользователь ожидает увидеть на карточке. Проценты считаются по ДЕЛЬТЕ
 * двух замеров, `/proc/net/dev` — тоже. `top -bn1` дал бы то же одним замером,
 * но его формат гуляет между дистрибутивами и локалями.
 *
 * `/proc/uptime` снимается дважды не по недосмотру: разность двух показаний —
 * это фактическая длина паузы, ей и делим байты сети. `sleep 1` на нагруженной
 * машине может занять и полторы секунды, и тогда «нормировка на 1 с» завысила
 * бы трафик в полтора раза.
 *
 * Экспортируется ради теста: подмена на команду с побочным эффектом обязана
 * ломать тест, а не тихо проехать в живой прогон (см. `SSH_TEST_COMMAND`).
 */
export const COLLECT_METRICS_COMMAND = [
  "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
  "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
  "echo '#sdmp:net'; cat /proc/net/dev 2>/dev/null",
  "sleep 1",
  "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
  "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
  "echo '#sdmp:net'; cat /proc/net/dev 2>/dev/null",
  "echo '#sdmp:nproc'; nproc 2>/dev/null",
  "echo '#sdmp:mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
  "echo '#sdmp:disk'; df -kP / 2>/dev/null",
  "echo '#sdmp:kernel'; uname -r 2>/dev/null",
  "echo '#sdmp:os'; grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null",
].join("\n");

/** Префикс строки-маркера секции; всё до первого маркера — не наше (баннер). */
const SECTION_PREFIX = "#sdmp:";

/**
 * Потолок на объём чужого вывода. `runSshTest` режет свой до 300 символов —
 * здесь вывод структурный и заведомо больше, но потолок нужен тем более:
 * `/proc/net/dev` на хосте с сотнями veth-интерфейсов (любой docker-хост) — это
 * десятки килобайт, и снимается он ДВАЖДЫ. 64 КиБ покрывают такой хост с
 * запасом; всё, что длиннее, — уже не показания, а чей-то чужой поток в наш
 * stdout, и читать его до конца незачем.
 */
const MAX_METRICS_OUTPUT = 64 * 1024;

/**
 * Верхняя граница числовых полей — ширина колонки Postgres (`PG_INT_MAX`).
 * Значение сверх неё не «большое», а неверное: 68 лет аптайма или петабайт на
 * корне — это промах парсера по чужой строке, и честный ответ на него `null`, а
 * не подрезанное до максимума число. Для `uptime_seconds` колонка на бэкенде
 * шире (bigint), но 68 лет — уже не показание.
 */
const MAX_METRIC_INT = 2147483647;

/** Длины строковых колонок на бэкенде: длиннее — 422 на ВЕСЬ снимок. */
const OS_PRETTY_MAX_LEN = 255;
const KERNEL_MAX_LEN = 128;

/** Запасная длина паузы, если `/proc/uptime` не дал разность (см. команду). */
const FALLBACK_SAMPLE_SECONDS = 1;

/**
 * Число из чужой строки. `Number`, а не `parseInt`: `parseInt("12abc")` вернул
 * бы 12, то есть превратил бы мусор в правдоподобное показание, а `Number` на
 * том же входе честно даёт NaN → `null`.
 *
 * Запятая переводится в точку заранее: `/proc` пишет точку всегда, но эта же
 * функция разбирает и вывод утилит, который в локали вроде ru_RU приезжает как
 * `12,5`. Для `Number` это NaN, то есть поле молча пропало бы.
 */
function num(token: string | undefined): number | null {
  if (!token) return null;
  const value = Number(token.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Округлить в колонку или признать, что не разобрали (см. `MAX_METRIC_INT`). */
function toInt(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= MAX_METRIC_INT ? rounded : null;
}

/**
 * Строка в колонку: без управляющих символов и не длиннее колонки. И то, и
 * другое — не косметика: бэкенд отвергает такое значение, а отвергает он ВСЁ
 * тело, то есть один кривой `PRETTY_NAME` стоил бы нам всего снимка.
 */
function toText(value: string | undefined, maxLen: number): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, maxLen) : null;
}

/**
 * Разложить вывод по секциям. Одно имя может встретиться дважды (`uptime`,
 * `cpu`, `net` снимаются до и после паузы), поэтому значение — список
 * вхождений по порядку.
 */
function splitSections(lines: string[]): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(SECTION_PREFIX)) {
      current = [];
      const name = line.slice(SECTION_PREFIX.length).trim();
      const seen = sections.get(name);
      if (seen) seen.push(current);
      else sections.set(name, [current]);
      continue;
    }
    // Всё до первого маркера отбрасывается вместе с `current === null`: это
    // SSH-баннер или motd, и «Welcome to Ubuntu 22.04» из него — не показание.
    if (current) current.push(line);
  }
  return sections;
}

/** Первый непустой замер секции: пустая секция = источника на машине нет. */
function sampleLines(sections: Map<string, string[][]>, name: string, index = 0): string[] {
  return (sections.get(name)?.[index] ?? []).filter((l) => l.trim() !== "");
}

/** Первое число `/proc/uptime` — секунды с загрузки, дробные. */
function uptimeAt(sections: Map<string, string[][]>, index: number): number | null {
  return num(sampleLines(sections, "uptime", index)[0]?.trim().split(/\s+/)[0]);
}

/**
 * Показания строки `cpu` из `/proc/stat`: сколько всего и сколько из этого
 * простой. Берём первые 8 полей (`user nice system idle iowait irq softirq
 * steal`) и не берём `guest`/`guest_nice` — они УЖЕ учтены внутри `user`/`nice`,
 * и их сумма завысила бы знаменатель.
 *
 * Простой — только `idle`, без `iowait`: машина, забившая диск, должна выглядеть
 * занятой, а не отдыхающей. Это же значение показывал продукт раньше
 * (`100 - id` из `top`).
 */
function cpuSample(sections: Map<string, string[][]>, index: number): { total: number; idle: number } | null {
  const parts = sampleLines(sections, "cpu", index)[0]?.trim().split(/\s+/) ?? [];
  if (parts[0] !== "cpu") return null;
  const values = parts.slice(1, 9).map((p) => num(p));
  // Меньше четырёх полей — `idle` в строке нет, и знаменатель не с чем сравнить.
  if (values.length < 4 || values.some((v) => v === null)) return null;
  const nums = values as number[];
  return { total: nums.reduce((a, b) => a + b, 0), idle: nums[3] };
}

/**
 * Суммарные счётчики байт по всем интерфейсам, кроме `lo`. Петля — это трафик
 * машины с самой собой (у активной БД он больше внешнего), и в «сколько сервер
 * качает из сети» ему делать нечего.
 *
 * Заголовок `/proc/net/dev` отсекается сам: в его двух строках нет `:`.
 */
function netSample(sections: Map<string, string[][]>, index: number): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of sampleLines(sections, "net", index)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const iface = line.slice(0, at).trim();
    if (iface === "lo") continue;
    const cols = line.slice(at + 1).trim().split(/\s+/);
    // 8 колонок приёма, дальше передача: `bytes` передачи — девятая.
    if (cols.length < 9) continue;
    const inBytes = num(cols[0]);
    const outBytes = num(cols[8]);
    if (inBytes === null || outBytes === null) continue;
    rx += inBytes;
    tx += outBytes;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/** Килобиты в секунду: так это поле рисует карточка (`/1000` → «Mb/s»). */
function kbps(before: number, after: number, seconds: number): number | null {
  // Счётчик не убывает; отрицательная дельта означала бы перезагрузку между
  // замерами (за секунду — нет) или промах парсера. И то, и другое — `null`.
  if (after < before || seconds <= 0) return null;
  return toInt(((after - before) * 8) / 1000 / seconds);
}

/**
 * Разобрать вывод `COLLECT_METRICS_COMMAND` в тело запроса. Чистая функция:
 * ей нужен только текст, поэтому её проверяют на выводе настоящих Ubuntu и
 * Debian без всякого SSH.
 *
 * `null` возвращается ровно в одном случае — в выводе нет НИ ОДНОГО нашего
 * маркера. Это не «сервер ничего не смог измерить», а «команда не выполнялась»
 * (нет shell, отказ в доступе, оборванный канал), и отправить тогда снимок из
 * одних `null` значило бы стереть бэкенду все накопленные показания по причине
 * «мы не смогли зайти».
 *
 * Во всех прочих случаях поле, которое мы пытались снять и не разобрали, — это
 * `null`, а не 0: «не смогли снять» не должно выглядеть как «0%».
 */
export function parseServerMetrics(output: string): ServerMetricsIn | null {
  const truncated = output.length > MAX_METRICS_OUTPUT;
  // Только по `\n`: вывод с `\r\n` (машина, где команда прошла через
  // псевдотерминал) разбирается тем же кодом, потому что `\r` — пробельный
  // символ и его снимают `trim` в разборе, `Number` в `num` и `toText` в
  // строковых полях. Отдельного шага под CRLF нет намеренно — он был бы
  // четвёртым местом, где это чинится; требование держит тест «переживает CRLF».
  const lines = (truncated ? output.slice(0, MAX_METRICS_OUTPUT) : output).split("\n");
  // Обрезание могло разрубить строку пополам, а полстроки `/proc/uptime` — это
  // правдоподобное, но неверное число. Отброшенная строка честнее.
  if (truncated) lines.pop();

  const sections = splitSections(lines);
  if (sections.size === 0) return null;

  const uptimeStart = uptimeAt(sections, 0);
  const uptimeEnd = uptimeAt(sections, 1);
  const sampled =
    uptimeStart !== null && uptimeEnd !== null && uptimeEnd > uptimeStart
      ? uptimeEnd - uptimeStart
      : FALLBACK_SAMPLE_SECONDS;

  const cpuBefore = cpuSample(sections, 0);
  const cpuAfter = cpuSample(sections, 1);
  let cpuUsage: number | null = null;
  if (cpuBefore && cpuAfter) {
    const total = cpuAfter.total - cpuBefore.total;
    const idle = cpuAfter.idle - cpuBefore.idle;
    // Ноль тиков за паузу — не «простаивала», а «нечего делить».
    if (total > 0) cpuUsage = Math.min(100, Math.max(0, Math.round(((total - idle) / total) * 100)));
  }

  const netBefore = netSample(sections, 0);
  const netAfter = netSample(sections, 1);

  const mem = new Map<string, number | null>();
  for (const line of sampleLines(sections, "mem")) {
    const [key, ...rest] = line.split(":");
    mem.set(key.trim(), num(rest.join(":").trim().split(/\s+/)[0]));
  }
  const memTotalKb = mem.get("MemTotal") ?? null;
  // `MemAvailable`, а не `MemFree`: свободным ядро считает только неиспользуемое,
  // а отданное под кэш оно вернёт приложению по первому требованию. Разница на
  // живом сервере — десятки процентов, и это то же число, что показывает `free`.
  const memAvailableKb = mem.get("MemAvailable") ?? null;

  let diskTotalKb: number | null = null;
  let diskUsedKb: number | null = null;
  for (const line of sampleLines(sections, "disk")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    // Считаем С КОНЦА: `df -P` гарантирует одну строку на запись, но имя
    // устройства бывает с пробелами, а хвост фиксирован — `blocks used avail
    // capacity mountpoint`. Заголовок отсеется сам: там на этих местах слова.
    const total = num(parts[parts.length - 5]);
    const used = num(parts[parts.length - 4]);
    if (total === null || used === null) continue;
    diskTotalKb = total;
    diskUsedKb = used;
  }

  const osLine = sampleLines(sections, "os").find((l) => l.trim().startsWith("PRETTY_NAME="));

  return {
    uptime_seconds: toInt(uptimeStart),
    cpu_usage_pct: cpuUsage,
    cpu_count: toInt(num(sampleLines(sections, "nproc")[0]?.trim())),
    ram_used_mb:
      memTotalKb !== null && memAvailableKb !== null
        ? toInt(Math.max(0, memTotalKb - memAvailableKb) / 1024)
        : null,
    ram_total_mb: toInt(memTotalKb === null ? null : memTotalKb / 1024),
    // ГиБ, а не ГБ: `df -k` считает блоками по 1024, и раньше продукт показывал
    // ровно это (`df -BG`). `-k`, а не `-h`: человеческий формат («38G», «1,2T»)
    // пришлось бы разбирать обратно, вместе с локалью и единицей.
    disk_used_gb: toInt(diskUsedKb === null ? null : diskUsedKb / 1024 / 1024),
    disk_total_gb: toInt(diskTotalKb === null ? null : diskTotalKb / 1024 / 1024),
    net_in_kbps: netBefore && netAfter ? kbps(netBefore.rx, netAfter.rx, sampled) : null,
    net_out_kbps: netBefore && netAfter ? kbps(netBefore.tx, netAfter.tx, sampled) : null,
    os_pretty: toText(osLine?.split("=", 2)[1]?.trim().replace(/^["']|["']$/g, ""), OS_PRETTY_MAX_LEN),
    kernel: toText(sampleLines(sections, "kernel")[0], KERNEL_MAX_LEN),
  };
}

/**
 * Снять метрики с сервера и отдать их бэкенду. ТОЛЬКО десктоп — по той же
 * причине, что и `runSshTest`: SSH-пароль лежит блобом под мастер-ключом,
 * которого у сервера нет. До переезда на zero-knowledge снимал сам бэкенд
 * (`server_metrics_service.py`), после — снимать стало некому, и карточки
 * показывают прочерки при живых колонках.
 *
 * Плейнтекст пароля появляется прямо в аргументах вызова и нигде не именуется —
 * причина целиком записана в JSDoc `runSshTest`: попади он в `variables`/`data`
 * мутации, react-query держал бы его ещё gcTime и после `reset()`. Наружу из
 * этой функции уходит только сущность сервера, вернувшаяся с бэкенда.
 *
 * Код возврата не проверяется намеренно. Последняя команда снимка — `grep` по
 * `/etc/os-release`, и на системе без `PRETTY_NAME` она честно отдаёт 1: судить
 * по этому коду о снимке в целом значило бы выбрасывать девять разобранных
 * полей из-за десятого. Судим по тому, что приехало.
 */
export async function runCollectMetrics(server: MetricsTarget): Promise<Server> {
  requireDesktop("Collecting metrics");
  if (!server.ssh_password_blob_id) {
    // Тот же случай, что в `runSshTest`: без этой ветки сюда приехал бы
    // `vault_decrypt_blob(blobId: undefined)` с «invalid args» на экране.
    throw new Error("This server has no SSH password saved — add SSH access first.");
  }
  const [code, output] = await sshExecWithHostKeyRetry({
    host: server.ip_address,
    port: server.ssh_port || 22,
    user: server.ssh_user || "root",
    password: await readSecretBlob(server.ssh_password_blob_id),
    command: COLLECT_METRICS_COMMAND,
  });
  const metrics = parseServerMetrics(output);
  if (!metrics) {
    // Вывод показываем как есть и с тем же потолком, что в `runSshTest`: он от
    // чужой машины и объясняет отказ лучше нашей формулировки.
    const tail = output.trim().slice(0, 300);
    throw new Error(`Server returned no metrics — exit ${code}${tail ? `: ${tail}` : " with no output"}`);
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
