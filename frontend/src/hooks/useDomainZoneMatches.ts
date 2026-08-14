import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";

import { CloudflareAccount, Zone, useCloudflareAccounts, zonesQuery } from "../api/cloudflare";
import { RowCfHint } from "../components/domains/types";
import { AccountZones, MatchableDomain, matchDomainsToZones } from "../lib/cfZoneMatch";
import { isTauri } from "../lib/runtime";

/**
 * Что живые зоны Cloudflare знают про строки списка доменов.
 *
 * Раскладка аккаунтов известна шире, чем записана: зоны читаются вживую (их же
 * показывает вкладка Cloudflare), а в строке домена стоит только сохранённый
 * `cloudflare_account_id`, и у большинства доменов он пуст. Без этой встречи
 * колонка сообщает «Cloudflare нет» о домене, который через Cloudflare и ходит.
 *
 * Результат встречи остаётся ПОДСКАЗКОЙ: в базу ничего не пишется, и рисуется
 * она иначе, чем сохранённая привязка (`DomainRow`). Запись — отдельное действие
 * пользователя (прогон привязки), потому что `cloudflare_zone_id` в строке
 * домена читается всем фронтом как факт, по которому потом пушатся NS.
 *
 * Только десктоп: зон в базе нет вовсе, их читает Tauri-команда `cf_list_zones`
 * (см. `zonesQuery`), а веб-панель «только смотрит». В вебе запросы не
 * запускаются, карта пуста, и колонка остаётся прочерком, как была.
 */
export interface DomainZoneMatches {
  /**
   * Подсказка по id домена. Домена нет в карте — подсказывать нечего: он либо
   * уже привязан, либо зона не нашлась, либо зоны ещё не прочитаны.
   *
   * Ссылка СТАБИЛЬНА, пока не изменились сами данные, и это не оптимизация «на
   * будущее»: карта уезжает в мемоизированный `DomainRow` (есть тест на число
   * рендеров), а пересобранная на каждый рендер карта отдаёт каждой из двухсот
   * строк новый объект подсказки — то есть снимает `React.memo` целиком и молча.
   */
  hints: ReadonlyMap<number, RowCfHint>;
  /**
   * Аккаунты, чьи зоны прочитать не удалось (сломанный токен, сеть).
   *
   * Не косметика, а поправка к смыслу прочерка: у непрочитанного аккаунта могла
   * лежать та самая зона, и без этой оговорки «—» в строке читалось бы как
   * «Cloudflare нет». Та же оговорка есть в отчёте прогона привязки
   * (`summarizeCfBind`) — и по той же причине.
   *
   * Сюда же попадает аккаунт, чей ПЕРЕЗАПРОС провалился поверх прочитанных
   * раньше зон: подсказки по нему остаются (устаревший список вернее прочерка),
   * но зоны, заведённой после поломки, в нём уже не будет.
   */
  unreadAccounts: UnreadCloudflareAccount[];
}

/** Аккаунт, чьи зоны прочитать не удалось, и причина отказа. */
export interface UnreadCloudflareAccount {
  account: CloudflareAccount;
  /**
   * Ошибка запроса зон как она пришла. Она здесь потому, что «не прочитан» без
   * причины нечем отработать: истёкший токен чинят в настройках, а оборвавшуюся
   * сеть — повтором, и это разные действия. Показывающий её обязан обрезать
   * текст (`clip`): в пределе это тело ответа Cloudflare.
   */
  error: unknown;
}

/** Одна пустая карта на все случаи «подсказывать нечем»: ссылка обязана быть стабильной. */
const NO_HINTS: ReadonlyMap<number, RowCfHint> = new Map();

/** Ответ запроса зон в том виде, в каком он тут нужен: данные либо отказ. */
interface ZonesResult {
  data: Zone[] | undefined;
  error: unknown;
}

function buildMatches(
  domains: ReadonlyArray<MatchableDomain>,
  accounts: ReadonlyArray<CloudflareAccount>,
  results: ReadonlyArray<ZonesResult>,
): DomainZoneMatches {
  const zonesByAccount: AccountZones[] = [];
  const unreadAccounts: UnreadCloudflareAccount[] = [];
  accounts.forEach((account, i) => {
    const result = results[i];
    // Аккаунт, чьи зоны ещё грузятся, не попадает никуда: ждущий запрос — это
    // не сломанный токен, и объявлять его непрочитанным значило бы показывать
    // поломку при каждом открытии вкладки.
    if (result?.data) zonesByAccount.push({ accountId: account.id, zones: result.data });
    // Отдельным `if`, а не `else`: данные и ошибка бывают ОДНОВРЕМЕННО —
    // провалившийся фоновый перезапрос (отозвали токен) оставляет прочитанные
    // раньше зоны и ставит ошибку. Подсказывать по ним можно, они всё ещё
    // вернее прочерка; молчать о том, что список устарел, — нельзя: зоны,
    // заведённой после отзыва токена, в нём нет, и её домен снова получил бы
    // «—», выданное за знание.
    if (result?.error) unreadAccounts.push({ account, error: result.error });
  });
  if (zonesByAccount.length === 0) return { hints: NO_HINTS, unreadAccounts };

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const hints = new Map<number, RowCfHint>();
  for (const match of matchDomainsToZones(domains, zonesByAccount)) {
    if (match.outcome === "matched") {
      // Промах невозможен — зоны прочитаны из этих же аккаунтов, — но `Map.get`
      // об этом не знает, а подсказка без аккаунта показать всё равно нечего.
      const account = byId.get(match.accountId);
      if (account) hints.set(match.domainId, { outcome: "matched", account });
    } else if (match.outcome === "ambiguous") {
      hints.set(match.domainId, { outcome: "ambiguous", accountIds: match.accountIds });
    }
    // `none` и `skipped` в карту не кладутся: подсказывать по ним нечего, а
    // строка и так рисует прочерк либо сохранённое имя аккаунта.
  }
  return { hints, unreadAccounts };
}

/** Совпадают ли зависимости поэлементно. `Object.is`, потому что все они — ссылки. */
function sameDeps(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Сопоставить домены живым зонам Cloudflare — один прогон на весь список.
 *
 * Прогон один и мемоизированный: `matchDomainsToZones` строит индекс по всем
 * зонам всех аккаунтов, а список бывает на двести доменов при десятке аккаунтов
 * по полсотни зон — на каждый рендер страницы (буква в поиске, выделение строки)
 * этого делать нельзя.
 *
 * Мемоизация — своя, на `useRef`, а не `useMemo`, и это не самодеятельность:
 * зависимостей здесь столько, сколько у пользователя аккаунтов Cloudflare, то
 * есть их число меняется между рендерами, а `useMemo` требует массив постоянной
 * длины. Свести их к одному ключу-строке нельзя: сравнивать надо именно ссылки
 * на данные запросов (у react-query они стабильны, пока данные не менялись).
 */
export function useDomainZoneMatches(domains: ReadonlyArray<MatchableDomain>): DomainZoneMatches {
  const accountsQ = useCloudflareAccounts();
  const accountsData = accountsQ.data;
  // Выключенный аккаунт — тот, которым пользователь пользоваться запретил: его
  // зоны не читаются и в подсказках не участвуют. Тот же отбор, что в прогоне
  // привязки (`api/cfAutoBind.ts`).
  const accounts = useMemo(
    () => (accountsData ?? []).filter((a) => a.is_active),
    [accountsData],
  );

  // Аккаунты читаются ПАРАЛЛЕЛЬНО, тогда как прогон привязки (`readZones` в
  // `api/cfAutoBind.ts`) ходит по ним последовательно, и это не расхождение по
  // недосмотру. Там очередь — способ не устраивать чужому API десяток
  // параллельных серий пагинации ради фоновой работы, которой никто не ждёт
  // глазами. Здесь ждут: это отрисовка открытой вкладки, и последовательное
  // чтение растянуло бы заполнение колонки на десятки секунд. Цена разовая —
  // запрос на аккаунт за `staleTime`, и та же запись кэша достаётся потом и
  // прогону привязки, и странице Cloudflare, то есть общее число походов в
  // Cloudflare от этого не растёт.
  const zoneQueries = useQueries({
    queries: accounts.map((a) => ({
      // Тот же запрос, что у страницы Cloudflare и у прогона привязки: одна
      // запись кэша на аккаунт со своим `staleTime`, а не третий поход за теми
      // же зонами.
      ...zonesQuery(a.id),
      enabled: isTauri(),
    })),
  });

  // Ячейка ОДНА, и это допущение: два конкурентных рендера с разными
  // зависимостями выбивали бы друг друга из неё, пересчитывая карту каждый раз,
  // — то есть мемоизация строк умерла бы, а тест на число рендеров этого не
  // увидел бы. Сегодня их нет: страница ничего не заворачивает в
  // `startTransition`/`useDeferredValue`. Появится — здесь нужен кэш на
  // несколько записей, а не подпорка в вызывающем.
  const cache = useRef<{ deps: unknown[]; value: DomainZoneMatches } | null>(null);
  const deps: unknown[] = [domains, accounts];
  for (const q of zoneQueries) deps.push(q.data, q.error);
  if (!cache.current || !sameDeps(cache.current.deps, deps)) {
    cache.current = { deps, value: buildMatches(domains, accounts, zoneQueries) };
  }
  return cache.current.value;
}
