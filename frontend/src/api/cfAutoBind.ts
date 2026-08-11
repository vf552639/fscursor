import { apiPut } from "./client";
import { cloudflareAccountsQuery, zonesQuery, CloudflareAccount, Zone } from "./cloudflare";
import { domainsKeys, Domain } from "./domains";
import { queryClient } from "./queryClient";
import { AccountZones, MatchableDomain, ZoneMatch, matchDomainsToZones } from "../lib/cfZoneMatch";
import { isTauri } from "../lib/runtime";

/**
 * Прогон привязки доменов к зонам Cloudflare: прочитать зоны всех активных
 * аккаунтов, сопоставить их именам доменов (`lib/cfZoneMatch`) и записать
 * найденное в строки доменов.
 *
 * Живёт вне React намеренно: вызывающих двое и оба не хуки — автопривязка
 * сразу после создания домена (модалка к этому моменту уже закрывается) и
 * кнопка «Match Cloudflare zones» по выделенным. Хук здесь означал бы, что
 * прогон умирает вместе с компонентом, который его начал.
 *
 * ТОЛЬКО десктоп, и гейт стоит внутри, а не у вызывающих: зоны в базе не лежат
 * вовсе — их вживую читает Tauri-команда `cf_list_zones` (веб-панель «только
 * смотрит»). Гейт снаружи пришлось бы повторить в каждом месте вызова, и
 * забытый означал бы в вебе поток ошибок на ровном месте — при создании домена,
 * которое там работает и должно работать.
 *
 * Zero-knowledge: наружу тут уезжают только имена и id зон — не секреты.
 * API-токен Cloudflare не покидает десктоп: его читает и расшифровывает сама
 * команда `cf_list_zones`.
 */

/** Домен, привязанный этим прогоном. */
export interface CfBound {
  domainId: number;
  domain: string;
  accountId: number;
  zoneId: string;
}

/** Аккаунт, зоны которого прочитать не удалось. */
export interface CfUnreadAccount {
  accountId: number;
  name: string;
  error: string;
}

/**
 * Отчёт о прогоне.
 *
 * `status` отвечает на вопрос «а был ли прогон вообще», и это не то же самое,
 * что пустые списки: «зон ни у кого не нашлось» и «аккаунтов нет вовсе» —
 * разные новости, и вторая при автопривязке обязана молчать, а по кнопке —
 * говорить.
 *
 * `unreadAccounts` — не косметика отчёта, а поправка к его смыслу: аккаунт,
 * зоны которого прочитать не удалось, в решении об однозначности НЕ участвует,
 * поэтому «совпадений нет» на непрочитанном аккаунте может оказаться неправдой.
 * Молчание об этом — ложь про домен, зона которого лежит именно там.
 */
export interface CfBindReport {
  /**
   * `not-desktop` — веб, ничего не делали и делать нечем.
   * `no-accounts` — активных аккаунтов Cloudflare нет, сопоставлять не с чем.
   * `nothing-to-do` — все домены набора уже привязаны (или набор пуст).
   * `ran` — зоны читали, сопоставление было.
   */
  status: "not-desktop" | "no-accounts" | "nothing-to-do" | "ran";
  bound: CfBound[];
  none: Array<{ domainId: number; domain: string }>;
  ambiguous: Array<{ domainId: number; domain: string; accountIds: number[] }>;
  /** Совпадение нашлось, а `PUT /domains/{id}` не прошёл. Не то же самое, что «нет совпадения». */
  writeFailed: Array<{ domainId: number; domain: string; error: string }>;
  unreadAccounts: CfUnreadAccount[];
  /** Сколько доменов набора уже были привязаны и потому не тронуты. */
  skipped: number;
}

/**
 * Сколько записей идёт одновременно.
 *
 * `Promise.all` по всему набору — это на двух сотнях доменов две сотни
 * одновременных `PUT` в один бэкенд (в десктопе они вдобавок идут через одну
 * команду-прокси `api_request`). Четыре — компромисс: прогон по сотне доменов
 * укладывается в секунды, а очередь запросов остаётся такой, что параллельная
 * работа пользователя со страницей не встаёт.
 */
const WRITE_CONCURRENCY = 4;

function emptyReport(status: CfBindReport["status"], skipped = 0): CfBindReport {
  return {
    status,
    bound: [],
    none: [],
    ambiguous: [],
    writeFailed: [],
    unreadAccounts: [],
    skipped,
  };
}

/** Текст ошибки в том виде, в каком его можно показать. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Выполнить задачи пачками по `limit`, сохранив порядок результатов.
 *
 * Порядок важен: отчёт читается рядом со списком доменов, а конкурентные
 * `push` расставили бы строки в порядке ответов сервера — то есть по-разному
 * от прогона к прогону.
 */
async function mapWithLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Прочитать зоны всех активных аккаунтов.
 *
 * Один запрос на аккаунт на весь прогон — не на домен: `cf_list_zones` ходит в
 * Cloudflare с пагинацией, и на сотне доменов поаккаунтный запрос превратился
 * бы в сотню полных вычиток.
 *
 * Через `fetchQuery`, а не прямым `invokeSynced`: так прогон делит запись кэша
 * (и её `staleTime` в 60с) со страницей Cloudflare и с вкладкой NS карточки
 * домена. Прогон, запущенный сразу после просмотра зон, не ходит в Cloudflare
 * повторно, а зона, только что созданная `useCreateZone`, видна ему сразу —
 * та инвалидирует ровно эту запись.
 *
 * Ошибка ОДНОГО аккаунта не роняет прогон: она делает аккаунт непрочитанным.
 * Иначе истёкший токен на одном из пяти аккаунтов означал бы, что привязать
 * нельзя ничего.
 */
async function readZones(
  accounts: ReadonlyArray<CloudflareAccount>,
): Promise<{ zonesByAccount: AccountZones[]; unread: CfUnreadAccount[] }> {
  const zonesByAccount: AccountZones[] = [];
  const unread: CfUnreadAccount[] = [];
  // Последовательно, а не `Promise.all`: у каждого аккаунта своя пагинация в
  // Cloudflare, и десяток параллельных вычиток — это десяток параллельных
  // серий запросов к чужому API с его же лимитами.
  for (const account of accounts) {
    try {
      const zones = await queryClient.fetchQuery<Zone[]>(zonesQuery(account.id));
      zonesByAccount.push({ accountId: account.id, zones });
    } catch (e) {
      unread.push({ accountId: account.id, name: account.name, error: errorText(e) });
    }
  }
  return { zonesByAccount, unread };
}

/**
 * Привязать домены к зонам Cloudflare по точному совпадению имени.
 *
 * Ничего не перезаписывает: домены, у которых `cloudflare_account_id` уже
 * заполнен, попадают в `skipped` и до записи не доходят.
 *
 * Не бросает на частных провалах: непрочитанный аккаунт и несостоявшийся `PUT`
 * — это строки отчёта, а не конец прогона. Бросить может только чтение списка
 * аккаунтов: без него сопоставлять не с чем вовсе.
 */
export async function autoBindDomainsToCloudflare(
  domains: ReadonlyArray<MatchableDomain>,
): Promise<CfBindReport> {
  if (!isTauri()) return emptyReport("not-desktop");

  // Считаем ДО похода за аккаунтами: набор, в котором привязывать нечего
  // (например, аккаунт выбран руками в форме «Add Domain»), не должен стоить
  // ни одного запроса — ни за аккаунтами, ни тем более за зонами.
  const candidates = domains.filter((d) => d.cloudflare_account_id == null);
  const skipped = domains.length - candidates.length;
  if (candidates.length === 0) return emptyReport("nothing-to-do", skipped);

  const accounts = await queryClient.fetchQuery<CloudflareAccount[]>(cloudflareAccountsQuery());
  // Выключенный аккаунт — это аккаунт, которым пользователь пользоваться
  // запретил; его зоны в решении не участвуют так же, как не участвуют его
  // зоны в списках на странице Cloudflare.
  const active = accounts.filter((a) => a.is_active);
  if (active.length === 0) return emptyReport("no-accounts", skipped);

  const { zonesByAccount, unread } = await readZones(active);
  const matches = matchDomainsToZones(candidates, zonesByAccount);

  const report: CfBindReport = { ...emptyReport("ran", skipped), unreadAccounts: unread };
  const toWrite: Array<Extract<ZoneMatch, { outcome: "matched" }>> = [];
  for (const m of matches) {
    if (m.outcome === "matched") toWrite.push(m);
    else if (m.outcome === "ambiguous") {
      report.ambiguous.push({ domainId: m.domainId, domain: m.domain, accountIds: m.accountIds });
    } else if (m.outcome === "none") {
      report.none.push({ domainId: m.domainId, domain: m.domain });
    }
    // `skipped` сюда не приезжает: такие домены отсеяны до чтения зон.
  }

  const written = await mapWithLimit(toWrite, WRITE_CONCURRENCY, async (m) => {
    try {
      // `PUT /domains/{id}`, а не `bulk-assign-cloudflare`: тот роут знает
      // только `account_id`, а без `zone_id` привязка не даёт главного —
      // вкладке NS по-прежнему нечего пушить регистратору.
      await apiPut<Domain>(`/domains/${m.domainId}`, {
        cloudflare_account_id: m.accountId,
        cloudflare_zone_id: m.zoneId,
      });
      return null;
    } catch (e) {
      // Прогон не останавливается: домен, которому не записалась привязка, —
      // это одна строка отчёта, а не повод бросить остальные девяносто девять.
      return errorText(e);
    }
  });
  written.forEach((error, i) => {
    const m = toWrite[i];
    if (error === null) {
      report.bound.push({
        domainId: m.domainId,
        domain: m.domain,
        accountId: m.accountId,
        zoneId: m.zoneId,
      });
    } else {
      report.writeFailed.push({ domainId: m.domainId, domain: m.domain, error });
    }
  });

  // ОДНА инвалидация на весь прогон, а не по одной на домен: `useUpdateDomain`
  // гасит `domainsKeys.all` в своём `onSuccess`, и на сотне привязок это сотня
  // перезапросов списка на сотню строк — поэтому запись идёт `apiPut`'ом мимо
  // хука. Инвалидация нужна только если что-то действительно изменилось.
  if (report.bound.length > 0) {
    queryClient.invalidateQueries({ queryKey: domainsKeys.all });
  }
  return report;
}

/** Сообщение об исходе прогона — то, что читает пользователь. */
export interface CfBindNotice {
  /** `warn` — полууспех: что-то привязано, а что-то нет (те же два тона, что у тостов воркспейса). */
  kind: "info" | "warn";
  text: string;
}

/**
 * Что сказать пользователю об исходе. `null` — сказать нечего, и молчание тут
 * правильный ответ.
 *
 * Отдельная чистая функция по образцу `summarizeBulkProvision` (`api/domains.ts`)
 * и по той же причине: текст уезжает пользователю, и проверять его надо без
 * DOM. Здесь он вдобавок единственный след действия, которое изменило данные
 * НЕ спросив, — при создании домена привязка происходит молча по решению
 * пользователя (2026-08-11). «Молча» значит «без диалога», а не «без следа».
 *
 * `mode` разводит два вызывающих, и разводит по существу:
 * - `auto` (после создания домена) молчит, когда прогона не было. «Cloudflare:
 *   аккаунтов нет» после каждого заведённого домена — это шум тому, кто
 *   Cloudflare не пользуется вовсе.
 * - `manual` (кнопка) обязан ответить всегда: кнопка, которая молчит, не
 *   отличима от сломанной.
 */
export function summarizeCfBind(
  report: CfBindReport,
  mode: "auto" | "manual",
): CfBindNotice | null {
  if (report.status === "not-desktop") return null;
  if (report.status === "no-accounts") {
    return mode === "auto"
      ? null
      : { kind: "warn", text: "Cloudflare: no active account is connected — nothing to match against." };
  }
  if (report.status === "nothing-to-do") {
    if (mode === "auto") return null;
    return {
      kind: "info",
      text:
        report.skipped > 0
          ? `Cloudflare: nothing to do — all ${report.skipped} selected domain(s) are already linked.`
          : "Cloudflare: nothing to match.",
    };
  }

  const considered =
    report.bound.length + report.none.length + report.ambiguous.length + report.writeFailed.length;
  const parts = [`${report.bound.length} of ${considered} linked`];
  // Каждая из четырёх строк ниже отвечает на свой вопрос «почему не
  // привязано», и слитые в одно число они бы на него не отвечали. «Без зоны»
  // названо ЧИСЛОМ, а не оставлено вычитанием из «N of M»: при трёх причинах
  // сразу читателю пришлось бы считать в уме — а он читает эту строку как раз
  // затем, чтобы понять, надо ли что-то делать руками.
  if (report.none.length > 0) parts.push(`${report.none.length} with no matching zone`);
  if (report.ambiguous.length > 0) {
    parts.push(`${report.ambiguous.length} matched in more than one account`);
  }
  if (report.writeFailed.length > 0) parts.push(`${report.writeFailed.length} could not be saved`);
  if (report.skipped > 0) parts.push(`${report.skipped} already linked`);
  let text = `Cloudflare: ${parts.join(", ")}.`;

  const first = report.unreadAccounts[0];
  if (first) {
    // Оговорка обязательна: у непрочитанного аккаунта могла лежать та самая
    // зона, и без этой фразы «совпадений нет» врало бы про такой домен.
    const more = report.unreadAccounts.length - 1;
    text +=
      ` ${report.unreadAccounts.length} account(s) could not be read` +
      ` (${first.name}: ${first.error}${more > 0 ? `, +${more} more` : ""}),` +
      ` so "no match" is not final.`;
  }

  const halfSuccess =
    report.ambiguous.length > 0 || report.writeFailed.length > 0 || report.unreadAccounts.length > 0;
  return { kind: halfSuccess ? "warn" : "info", text };
}
