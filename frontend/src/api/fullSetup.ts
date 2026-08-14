import { apiPost } from "./client";
import { clip, errorText, mapWithLimit } from "./cfAutoBind";
import { domainsKeys } from "./domains";
import { queryClient } from "./queryClient";
import { FullSetupPlan } from "../lib/fullSetupPlan";
import { syncLocalCache } from "../lib/localCache";
import { desktopOnly, isTauri } from "../lib/runtime";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { useAuthStore } from "../store/auth";

/**
 * Полная настройка домена: связки на бэкенде, зона в Cloudflare и NS у
 * регистратора — в десктопе.
 *
 * Живёт вне React по той же причине, что и прогон привязки
 * (`api/cfAutoBind.ts`): вызывающих двое и ни один не хук — мастер «Add Domain»
 * (модалка к моменту прогона уже закрыта) и массовое действие по выделенным.
 * Прогон по сотне доменов идёт минутами и обязан пережить страницу, которая
 * размонтируется на любой навигации.
 *
 * Граница ровно там, где проходит zero-knowledge: бэкенд проставляет связки
 * (`POST /domains/full-setup`), но в Cloudflare и к регистратору не ходит — он
 * видит только шифротекст. Всё остальное делает Tauri-команда
 * `domain_full_setup`.
 */

/** Что стало с зоной домена (`ZoneStep` в `commands/full_setup.rs`). */
export type FullSetupZoneStep =
  | { status: "created"; zone_id: string; name_servers: string[] }
  | { status: "existed"; zone_id: string; name_servers: string[] }
  | { status: "failed"; error: string };

/** Почему шаг NS не выполнялся (`NsSkipReason` в Rust). Это НЕ провалы. */
export type FullSetupNsSkipReason =
  | "not_requested"
  | "no_registrar_account"
  | "registrar_no_ns_api"
  | "zone_unavailable"
  | "zone_without_nameservers";

/** Что стало с делегированием (`NsStep` в Rust). */
export type FullSetupNsStep =
  | { status: "pushed"; nameservers: string[] }
  | { status: "skipped"; reason: FullSetupNsSkipReason }
  | { status: "failed"; error: string };

/** Ответ команды `domain_full_setup` (`FullSetupOut` в Rust). */
export interface FullSetupDesktopResult {
  domain_id: string;
  zone: FullSetupZoneStep;
  /**
   * Уехал ли `cloudflare_zone_id` в строку домена. `null` — зоны нет, писать
   * было нечего; `false` — зона в Cloudflare есть, а SDMP о ней не знает.
   */
  zone_saved: boolean | null;
  ns: FullSetupNsStep;
}

/** Домен, по которому идёт прогон: команде нужны и id, и имя. */
export interface FullSetupTarget {
  id: number;
  domain_name: string;
}

/** Ответ `POST /domains/full-setup`. */
export interface BulkFullSetupResponse {
  domains: FullSetupTarget[];
  /** id, которых бэкенд не нашёл: чужие или удалённые в соседней вкладке. */
  skipped_ids: number[];
}

/** Строка отчёта: что вышло по одному домену. */
export interface FullSetupItem {
  domain: string;
  result: FullSetupDesktopResult;
}

/**
 * Прогон остановлен на этом домене.
 *
 * `Err` команды означает ровно одно: работа НЕ начиналась и по этому домену
 * повторять её бессмысленно, пока не починено общее — запертый сейф,
 * неинициализированная синхронизация, пустой ввод (см. `preflight` в
 * `commands/full_setup.rs`). Условие это машинного уровня, то есть одинаково
 * для всех ста доменов пачки: гнать за ним остальных значит сто раз
 * постучаться в запертый keychain и показать сто одинаковых красных строк
 * вместо одного «сейф заперт».
 */
export interface FullSetupAbort {
  domain: string;
  error: string;
  /** Сколько доменов пачки остались ненастроенными — включая этот. */
  notSetUp: number;
}

/**
 * Итог прогона.
 *
 * Размеченное объединение, а не поле-статус: у провалившейся связки нет ни
 * одного числа из второй ветки, и обращаться к ним нельзя, не сузив тип.
 */
export type FullSetupReport =
  | {
      /** Связки не проставились — дальше не пошли, менять было нечего. */
      outcome: "link-failed";
      requested: number;
      error: string;
    }
  | {
      outcome: "ran";
      /**
       * Что вышло со связками. `null` — этот прогон их не проставлял: мастер
       * передаёт связки полями создания домена, и рапортовать «1 of 1 linked»
       * значило бы записать себе чужую работу. Хуже того — при пустых полях
       * формы отчёт хвалился бы связками, которых нет вовсе.
       */
      links: { requested: number; linked: number; skipped: number } | null;
      /**
       * Что стало с шагами выполнения. «Не просили» и «нечем» — разные новости,
       * и ни одна из них не «сделано».
       */
      steps: "ran" | "not-requested" | "not-desktop" | "no-session" | "nothing-to-run";
      items: FullSetupItem[];
      aborted: FullSetupAbort | null;
    };

/**
 * Сколько доменов настраивается одновременно.
 *
 * Вдвое меньше, чем у прогона привязки (`WRITE_CONCURRENCY = 4`), и это не
 * осторожность ради осторожности: там единица работы — один `PUT` в СВОЙ
 * бэкенд, здесь — цепочка чужих API (создание зоны в Cloudflare, поиск по
 * имени при отказе «уже существует», write-back в SDMP и, по тумблеру, смена
 * NS у регистратора). Лимиты считают именно чужие: Namecheap отвечает
 * секундами и режет по ключу, и четыре смены делегирования разом — прямой путь
 * в его rate limiter, то есть в красные строки на ровном месте.
 */
const SETUP_CONCURRENCY = 2;

/**
 * Проставить связки пачке доменов. Бросает: без связок выполнять нечего.
 *
 * `registrar_id` уезжает только когда выбран — схема запроса объявлена с
 * `extra="forbid"`, и лишнее поле стоило бы всей пачке 422.
 */
async function assignLinks(
  domainIds: number[],
  plan: FullSetupPlan & { serverId: number },
): Promise<BulkFullSetupResponse> {
  const body: Record<string, unknown> = {
    domain_ids: domainIds,
    server_id: plan.serverId,
    cloudflare_account_id: plan.cloudflareAccountId,
  };
  if (plan.registrarId != null) body.registrar_id = plan.registrarId;
  const res = await apiPost<BulkFullSetupResponse>("/domains/full-setup", body);
  queryClient.invalidateQueries({ queryKey: domainsKeys.all });
  return res;
}

/**
 * Прогнать шаги десктопа по пачке.
 *
 * Синхронизация локального кэша — ОДНА на всю пачку, а не `invokeSynced` на
 * каждый домен: команда резолвит сущности из SQLCipher-кэша, но связки пачке
 * проставлены одним запросом и одним `sync_now` подтягиваются целиком.
 * Подоменный `invokeSynced` стоил бы сотни лишних round-trip'ов на сотне
 * доменов ради того же самого результата.
 */
async function runSteps(
  targets: ReadonlyArray<FullSetupTarget>,
  plan: FullSetupPlan,
  userId: string,
): Promise<{ items: FullSetupItem[]; aborted: FullSetupAbort | null }> {
  await syncLocalCache();
  // Список, а не одна переменная: параллельные воркеры могут отказать оба, и
  // порядок их отказов не определён. Наружу уезжает первый (см. ниже).
  const stopped: Array<{ domain: string; error: string }> = [];
  const outcomes = await mapWithLimit(targets, SETUP_CONCURRENCY, async (target) => {
    // Прогон останавливается на первом `Err` — см. `FullSetupAbort`. Проверка
    // стоит внутри воркера, потому что `mapWithLimit` раздаёт задачи по мере
    // освобождения: уже начатые договорят, новые не начнутся.
    if (stopped.length > 0) return { kind: "not-started" } as const;
    try {
      const result = await invokeIfTauri<FullSetupDesktopResult>("domain_full_setup", {
        userId,
        domainId: String(target.id),
        domainName: target.domain_name,
        cloudflareAccountId: String(plan.cloudflareAccountId),
        registrarAccountId: plan.registrarId != null ? String(plan.registrarId) : null,
        pushNs: plan.pushNs,
      });
      return { kind: "ok", result } as const;
    } catch (e) {
      // Первый отказ и есть причина остановки: второй, прилетевший из
      // параллельного воркера, — то же самое условие машины, и называть его
      // отдельно значило бы предлагать чинить две вещи вместо одной.
      stopped.push({ domain: target.domain_name, error: errorText(e) });
      return { kind: "failed" } as const;
    }
  });

  const items: FullSetupItem[] = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes[i];
    if (outcome.kind === "ok") items.push({ domain: targets[i].domain_name, result: outcome.result });
  }
  if (items.length > 0) {
    // Одна инвалидация на прогон: у зон появились `cloudflare_zone_id`, у
    // доменов — `ns_status`, и строка таблицы обязана перестать показывать
    // прежнее. По одной на домен — это сотня перезапросов списка на сотню строк.
    queryClient.invalidateQueries({ queryKey: domainsKeys.all });
  }
  const first = stopped[0];
  return {
    items,
    // Ненастроенным считаем КАЖДЫЙ домен без своего отчёта — и тот, на котором
    // прогон встал, и те, до которых он не дошёл. Для пользователя это одна
    // новость: с этими доменами не сделано ничего.
    aborted: first
      ? { domain: first.domain, error: first.error, notSetUp: targets.length - items.length }
      : null,
  };
}

/** Кто мы для команды: без id пользователя ей нечем расшифровать токен. */
function currentUserId(): string | null {
  return useAuthStore.getState().userId;
}

/**
 * Шаги десктопа плюс разбор «а было ли чем их делать». Общая половина обоих
 * входов: разницу между ними составляют только связки.
 */
async function stepsOrReason(
  targets: ReadonlyArray<FullSetupTarget>,
  plan: FullSetupPlan,
): Promise<Pick<Extract<FullSetupReport, { outcome: "ran" }>, "steps" | "items" | "aborted">> {
  const idle = { items: [] as FullSetupItem[], aborted: null };
  if (!plan.createZone) return { steps: "not-requested", ...idle };
  if (!isTauri()) return { steps: "not-desktop", ...idle };
  if (targets.length === 0) return { steps: "nothing-to-run", ...idle };
  const userId = currentUserId();
  if (!userId) return { steps: "no-session", ...idle };
  return { steps: "ran", ...(await runSteps(targets, plan, userId)) };
}

/**
 * Массовое действие: связки пачке, затем шаги десктопа по тем доменам, которым
 * связки достались.
 *
 * Не бросает: провал связок — это отдельная ветка отчёта, а не исключение,
 * потому что говорить о нём надо теми же словами и в том же месте, что и об
 * остальных исходах.
 */
export async function bulkFullSetup(
  domainIds: number[],
  plan: FullSetupPlan & { serverId: number },
): Promise<FullSetupReport> {
  let linked: BulkFullSetupResponse;
  try {
    linked = await assignLinks(domainIds, plan);
  } catch (e) {
    return { outcome: "link-failed", requested: domainIds.length, error: errorText(e) };
  }
  return {
    outcome: "ran",
    links: {
      requested: domainIds.length,
      linked: linked.domains.length,
      skipped: linked.skipped_ids.length,
    },
    ...(await stepsOrReason(linked.domains, plan)),
  };
}

/**
 * Мастер «Add Domain»: домен уже создан ВМЕСТЕ со связками (`POST /domains`
 * принимает их полями), поэтому здесь остаются только шаги десктопа.
 *
 * Второй раз в `full-setup` за связками не идём: они уже стоят, а лишний запрос
 * означал бы ещё одну точку отказа между созданием домена и его настройкой.
 */
export async function newDomainFullSetup(
  target: FullSetupTarget,
  plan: FullSetupPlan,
): Promise<FullSetupReport> {
  return {
    outcome: "ran",
    // Связок этот прогон не проставлял — см. `links` в `FullSetupReport`.
    links: null,
    ...(await stepsOrReason([target], plan)),
  };
}

/** Сообщение об исходе прогона — то, что читает пользователь. */
export interface FullSetupNotice {
  /** `warn` — сделано не всё, о чём просили. `info` — сделано всё. */
  kind: "info" | "warn";
  text: string;
}

/**
 * Что сказать, когда прогон сорвался не там, где ожидалось.
 *
 * Штатные исходы сюда не попадают: провал связок — ветка отчёта, отказ
 * Cloudflare — строка отчёта, `Err` команды — остановка с именем домена. Это
 * страховка от неожиданного, и текст у неё нарочно не обещает, что ничего не
 * изменилось: часть пачки к этому моменту могла быть настроена.
 */
export function summarizeFullSetupFailure(e: unknown): FullSetupNotice {
  return { kind: "warn", text: `Full setup: the run did not finish — ${clip(errorText(e))}` };
}

/**
 * Почему шаг NS не выполнялся — словами. Про `not_requested` не говорим:
 * выключенный тумблер новостью не является.
 */
const NS_SKIP_TEXT: Record<Exclude<FullSetupNsSkipReason, "not_requested">, string> = {
  no_registrar_account: "no registrar account",
  registrar_no_ns_api: "registrar has no NS API",
  zone_unavailable: "no zone to take nameservers from",
  zone_without_nameservers: "Cloudflare did not name the zone's nameservers",
};

/** Счётчики по шагам — всё, из чего собирается текст. */
interface StepCounts {
  zoneCreated: number;
  zoneExisted: number;
  zoneFailed: number;
  /** Зона есть, а SDMP о ней не знает. Самый дорогой из полууспехов. */
  notSaved: number;
  nsPushed: number;
  nsFailed: number;
  nsSkipped: Map<Exclude<FullSetupNsSkipReason, "not_requested">, number>;
  /** Первый провал — единственный, который влезает в строку. */
  firstFailure: { domain: string; error: string } | null;
}

function countSteps(items: ReadonlyArray<FullSetupItem>): StepCounts {
  const counts: StepCounts = {
    zoneCreated: 0,
    zoneExisted: 0,
    zoneFailed: 0,
    notSaved: 0,
    nsPushed: 0,
    nsFailed: 0,
    nsSkipped: new Map(),
    firstFailure: null,
  };
  const remember = (domain: string, error: string) => {
    if (!counts.firstFailure) counts.firstFailure = { domain, error };
  };
  for (const item of items) {
    const { zone, ns, zone_saved: zoneSaved } = item.result;
    if (zone.status === "created") counts.zoneCreated += 1;
    else if (zone.status === "existed") counts.zoneExisted += 1;
    else {
      counts.zoneFailed += 1;
      remember(item.domain, zone.error);
    }
    if (zoneSaved === false) counts.notSaved += 1;
    if (ns.status === "pushed") counts.nsPushed += 1;
    else if (ns.status === "failed") {
      counts.nsFailed += 1;
      remember(item.domain, ns.error);
    } else if (ns.reason !== "not_requested") {
      counts.nsSkipped.set(ns.reason, (counts.nsSkipped.get(ns.reason) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Что сказать пользователю об исходе.
 *
 * Отдельная чистая функция по образцу `summarizeCfBind` и по той же причине:
 * текст уезжает пользователю и обязан проверяться без DOM. Молчания у неё нет:
 * прогон запускается только явным действием, а действие, которое молчит,
 * неотличимо от сломанного.
 *
 * Тон решает один вопрос: сделано ли всё, о чём просили. «✓» не имеет права
 * появиться там, где зона не завелась, NS не прописались, домен не нашёлся или
 * зона осталась незаписанной, — то есть везде, где человеку ещё предстоит
 * работа руками.
 */
export function summarizeFullSetup(report: FullSetupReport): FullSetupNotice {
  if (report.outcome === "link-failed") {
    return {
      kind: "warn",
      text: `Full setup: ${report.requested} domain(s) — nothing was changed, ${clip(report.error)}`,
    };
  }
  if (report.links && report.links.linked === 0) {
    // Связок не досталось никому: настраивать нечего, и «0 of N linked» здесь
    // читалось бы как поломка счётчика.
    return {
      kind: "warn",
      text: `Full setup: none of the ${report.links.requested} selected domain(s) were found — nothing was changed.`,
    };
  }

  const counts = countSteps(report.items);
  const parts: string[] = [];
  // Счётчик связок — только у прогона, который их проставлял (см. `links`).
  if (report.links) {
    parts.push(`${report.links.linked} of ${report.links.requested} linked`);
    if (report.links.skipped > 0) parts.push(`${report.links.skipped} not found`);
  }
  if (counts.zoneCreated > 0) parts.push(`${counts.zoneCreated} zone(s) created`);
  if (counts.zoneExisted > 0) parts.push(`${counts.zoneExisted} zone(s) already existed`);
  if (counts.zoneFailed > 0) parts.push(`${counts.zoneFailed} zone(s) failed`);
  if (counts.nsPushed > 0) parts.push(`${counts.nsPushed} NS pushed`);
  if (counts.nsFailed > 0) parts.push(`${counts.nsFailed} NS failed`);
  for (const [reason, n] of counts.nsSkipped) {
    parts.push(`${n} NS skipped (${NS_SKIP_TEXT[reason]})`);
  }

  // Предложениями, а не одной строкой: счётчиков может не быть вовсе (мастер,
  // у которого прогон не дошёл ни до одного шага), и тогда первым идёт
  // объяснение — оно в этом случае и есть весь отчёт.
  const sentences: string[] = [];
  if (parts.length > 0) sentences.push(`${parts.join(", ")}.`);

  if (report.steps === "not-requested") {
    sentences.push("Zones and nameservers were not part of this run.");
  } else if (report.steps === "not-desktop") {
    sentences.push(desktopOnly("Creating zones and setting nameservers"));
  } else if (report.steps === "no-session") {
    sentences.push("Not signed in, so no zone was created — sign in again and repeat.");
  } else if (report.steps === "nothing-to-run") {
    // Своя фраза, а не молчание: иначе баннер состоял бы из одних счётчиков
    // связок и не отвечал на вопрос, почему шагов не было.
    sentences.push("No domain reached the setup steps.");
  }

  // Отдельным предложением, а не числом в общей строке: на сотне доменов эта
  // новость — единственная, ради которой отчёт стоит читать. Зона в Cloudflare
  // есть, SDMP о ней не знает, и починит это следующий прогон, а не человек.
  if (counts.notSaved > 0) {
    sentences.push(
      `${counts.notSaved} zone(s) exist in Cloudflare but are not recorded in SDMP` +
        " — run full setup again to record them.",
    );
  }

  if (report.aborted) {
    sentences.push(
      `The run stopped on ${report.aborted.domain}: ${clip(report.aborted.error)}.` +
        ` ${report.aborted.notSetUp} domain(s) were not set up.`,
    );
  } else if (counts.firstFailure) {
    sentences.push(`First failure — ${counts.firstFailure.domain}: ${clip(counts.firstFailure.error)}`);
  }

  const text = `Full setup: ${sentences.join(" ")}`;
  const allDone =
    (report.links === null || report.links.skipped === 0) &&
    counts.zoneFailed === 0 &&
    counts.nsFailed === 0 &&
    counts.notSaved === 0 &&
    counts.nsSkipped.size === 0 &&
    report.aborted === null &&
    (report.steps === "ran" || report.steps === "not-requested");
  return { kind: allDone ? "info" : "warn", text };
}
