/**
 * Правило «какая зона Cloudflare принадлежит этому домену» — один модуль на
 * весь фронт, по образцу `lib/domainStatus.ts` и `lib/domainExpiry.ts`.
 *
 * Отдельный модуль, а не десяток строк внутри исполнителя, по двум причинам.
 * Во-первых, правило проверяется без сети и без React: зоны в базе не лежат
 * вовсе (их вживую читает Tauri-команда `cf_list_zones`), и тест на реальном
 * пути стоил бы мока десктопа ради арифметики над строками. Во-вторых, здесь
 * живёт то, что легко переписать «почти так же»: нормализация имени и решение
 * про неоднозначность. Вторая копия этих двух правил разошлась бы с первой
 * молча — и разойтись ей есть где, потому что привязка приезжает с двух сторон
 * (автоматически при заведении домена и кнопкой по выделенным).
 *
 * Главное, чего модуль НЕ делает: он не угадывает. Совпадение зоны в двух
 * аккаунтах — это `ambiguous`, а не «возьмём первый»: угадав, продукт записал
 * бы домену чужой `cloudflare_zone_id`, а вкладка NS потом пушила бы
 * регистратору nameservers чужой зоны — то есть увела бы домен в аккаунт, о
 * котором пользователь не просил.
 */

/**
 * Домен в том виде, в каком его знает это правило: имя и признак «уже привязан».
 *
 * Структурная подпись строки `Domain` (`api/domains.ts`) — специально, чтобы
 * вызывающий не собирал промежуточных объектов, но и чтобы модуль не тянул
 * зависимость на api-слой ради трёх полей.
 */
export interface MatchableDomain {
  id: number;
  domain_name: string;
  /** Непустой — домен уже за аккаунтом, и трогать его нельзя (см. `skipped`). */
  cloudflare_account_id: number | null;
}

/** Зоны ОДНОГО аккаунта. Аккаунт, чьи зоны прочитать не удалось, сюда не попадает. */
export interface AccountZones {
  accountId: number;
  /** Подмножество `Zone` (`api/cloudflare.ts`): для сопоставления нужны только эти два поля. */
  zones: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Что делать с доменом. Четыре исхода, и все четыре различимы намеренно:
 * «не нашли зону», «нашли в двух аккаунтах» и «не трогаем, он уже привязан» —
 * три разные новости, и слив их в один «не привязали», отчёт перестал бы
 * отвечать на вопрос «а почему».
 */
export type ZoneMatch =
  | { outcome: "matched"; domainId: number; domain: string; accountId: number; zoneId: string }
  | { outcome: "none"; domainId: number; domain: string }
  /** Имя зоны нашлось больше чем в одном месте — какое из них «то самое», знает только пользователь. */
  | { outcome: "ambiguous"; domainId: number; domain: string; accountIds: number[] }
  /**
   * У домена уже есть аккаунт Cloudflare: перезаписывать чужой выбор нечем и
   * незачем.
   *
   * Признак — ИМЕННО аккаунт, а не пара «аккаунт + зона». Домен с аккаунтом, но
   * без `cloudflare_zone_id` сюда тоже попадает и остаётся нетронутым: дописать
   * ему зону было бы другим правилом (аккаунт задан, неоднозначности нет, и
   * искать надо только в нём), а не частным случаем этого. Отдельная задача.
   */
  | { outcome: "skipped"; domainId: number; domain: string };

/**
 * Имя в сравнимом виде: без пробелов по краям, без завершающей точки, в нижнем
 * регистре.
 *
 * Все три правила про реальные данные, а не про аккуратность. Cloudflare отдаёт
 * имена зон в нижнем регистре, а пользователь набирает домен как придётся
 * («Example.COM» из письма регистратора). Завершающая точка — законная запись
 * FQDN (`example.com.`), и она приезжает из копипасты зонных файлов. Пробелы —
 * из тех же копипаст.
 *
 * Порядок операций важен ровно в одном месте: точка срезается ПОСЛЕ `trim`,
 * иначе `"example.com. "` осталось бы с точкой.
 */
export function normalizeZoneName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Сопоставить домены зонам. Чистая функция: ни сети, ни React, ни времени.
 *
 * Совпадение ТОЧНОЕ по имени. Поддомен (`shop.example.com` при зоне
 * `example.com`) даёт `none`, и это зафиксированное решение, а не недосмотр:
 * `cloudflare_zone_id` в строке домена читается всем фронтом как «зона ЭТОГО
 * домена» (см. `useZoneNameservers` и вкладку NS, которая пушит nameservers
 * этой зоны регистратору). Привязав поддомен к родительской зоне, продукт
 * заставил бы NS-путь врать: у поддомена своего делегирования нет, и менять
 * NS родителя, думая, что меняешь NS поддомена, — это испорченный родитель.
 * Понадобится — будет отдельная задача со своим правилом записи.
 *
 * Два одноимённых совпадения ВНУТРИ одного аккаунта — тоже `ambiguous`
 * (`accountIds` из одного элемента): аккаунт известен, а вот `zoneId` выбрать
 * не из чего, и выбранная наугад зона — тот же чужой NS-путь.
 *
 * Порядок результата повторяет порядок входа: отчёт читается рядом со списком,
 * в котором домены стоят в своём порядке.
 */
export function matchDomainsToZones(
  domains: ReadonlyArray<MatchableDomain>,
  zonesByAccount: ReadonlyArray<AccountZones>,
): ZoneMatch[] {
  // Индекс строится ОДИН раз на прогон: на сотне доменов и десятке аккаунтов
  // перебор зон на каждый домен — это перебор, который видно глазами.
  const byName = new Map<string, Array<{ accountId: number; zoneId: string }>>();
  for (const account of zonesByAccount) {
    for (const zone of account.zones) {
      const key = normalizeZoneName(zone.name);
      if (!key) continue;
      const bucket = byName.get(key);
      const hit = { accountId: account.accountId, zoneId: zone.id };
      if (bucket) bucket.push(hit);
      else byName.set(key, [hit]);
    }
  }

  return domains.map((d): ZoneMatch => {
    const domain = d.domain_name;
    if (d.cloudflare_account_id != null) {
      return { outcome: "skipped", domainId: d.id, domain };
    }
    const key = normalizeZoneName(domain);
    // Пустое имя (строка из пробелов) не должно совпасть с чем попало: пустой
    // ключ в индекс не кладётся, но сравнить его с ним всё равно нельзя.
    const hits = key ? byName.get(key) : undefined;
    if (!hits || hits.length === 0) {
      return { outcome: "none", domainId: d.id, domain };
    }
    if (hits.length > 1) {
      // `Set` — потому что «две зоны в одном аккаунте» и «по зоне в двух
      // аккаунтах» это разные истории, а список аккаунтов в отчёте должен
      // называть каждый аккаунт один раз.
      const accountIds = [...new Set(hits.map((h) => h.accountId))];
      return { outcome: "ambiguous", domainId: d.id, domain, accountIds };
    }
    return {
      outcome: "matched",
      domainId: d.id,
      domain,
      accountId: hits[0].accountId,
      zoneId: hits[0].zoneId,
    };
  });
}
