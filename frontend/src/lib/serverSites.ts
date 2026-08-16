import { normalizeZoneName } from "./cfZoneMatch";

/**
 * Сравнение «сайты на сервере ↔ домены в SDMP» — чистая функция, вся логика
 * сверки в одном месте (по образцу `cfZoneMatch`/`nsDelegation`).
 *
 * Зачем отдельным модулем, а не в компоненте: нормализация имени домена —
 * правило про реальные данные (регистр из письма регистратора, завершающая
 * точка из копипасты зонного файла), и живёт оно уже в `normalizeZoneName`.
 * Переписанное в карточке сервера заново, оно разошлось бы с тем, которым
 * матчатся зоны Cloudflare и сверяется делегирование, — а тогда один и тот же
 * `Example.COM.` был бы «совпал» на одном экране и «только на сервере» на
 * другом. Одна нормализация на всех.
 */

/** Минимум, что нужно от сайта сервера для сверки: имя домена. */
export interface ComparableSite {
  domain_name: string;
}

/** Минимум, что нужно от домена SDMP для сверки: имя домена. */
export interface ComparableDomain {
  domain_name: string;
}

/**
 * Три группы сверки. Имена намеренно говорят о ЗНАНИИ, а не о действии:
 * `onlyOnServer` — «есть на сервере, SDMP о нём не знает»; `onlyInSdmp` — «есть
 * в SDMP, на сервере не нашли». Никакого ресинка эта сверка не делает — только
 * читает и показывает расхождение (принцип №3: веб/сверка не мутируют).
 */
export interface SiteComparison<S extends ComparableSite, D extends ComparableDomain> {
  /** Домен есть и на сервере, и в SDMP (совпал по нормализованному имени). */
  matched: { site: S; domain: D }[];
  /** Сайт есть на сервере, но такого домена в SDMP нет. */
  onlyOnServer: S[];
  /** Домен есть в SDMP, но сайта с таким именем на сервере не нашли. */
  onlyInSdmp: D[];
}

/**
 * Сверить список сайтов с сервера со списком доменов SDMP.
 *
 * Матч — по `normalizeZoneName` (trim + срез завершающей точки + нижний
 * регистр): та же нормализация, что у зон Cloudflare. Пустое имя после
 * нормализации в сверку не идёт (мусорная строка не должна ни с чем совпасть).
 *
 * Дубли схлопываются по нормализованному имени (побеждает первое вхождение):
 * сервер, вернувший домен дважды, или две одноимённые строки в SDMP не должны
 * задваивать группу. Порядок вывода — порядок первого вхождения во входе.
 */
export function compareServerSites<S extends ComparableSite, D extends ComparableDomain>(
  sites: readonly S[],
  domains: readonly D[],
): SiteComparison<S, D> {
  const domainByName = new Map<string, D>();
  for (const d of domains) {
    const key = normalizeZoneName(d.domain_name);
    if (key && !domainByName.has(key)) domainByName.set(key, d);
  }
  const siteByName = new Map<string, S>();
  for (const s of sites) {
    const key = normalizeZoneName(s.domain_name);
    if (key && !siteByName.has(key)) siteByName.set(key, s);
  }

  const matched: { site: S; domain: D }[] = [];
  const onlyOnServer: S[] = [];
  for (const [key, site] of siteByName) {
    const domain = domainByName.get(key);
    if (domain) matched.push({ site, domain });
    else onlyOnServer.push(site);
  }

  const onlyInSdmp: D[] = [];
  for (const [key, domain] of domainByName) {
    if (!siteByName.has(key)) onlyInSdmp.push(domain);
  }

  return { matched, onlyOnServer, onlyInSdmp };
}
