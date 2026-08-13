/**
 * Делегирован ли домен на свою зону Cloudflare — и насколько это знание полное.
 *
 * Отдельный модуль по той же причине, что `lib/serverStatus.ts`: правило
 * нетривиальное (регистр, точка на конце FQDN, порядок серверов, разное их
 * число), а проверяется без сети и без React — оба списка NS приезжают от
 * Tauri-команд, и тест на реальном пути стоил бы мока десктопа ради сравнения
 * двух наборов строк.
 *
 * Главное правило то же, что у серверов: **незнание нельзя рисовать здоровьем.**
 * Сведений тут два и оба чужие — NS зоны у Cloudflare и NS домена у
 * регистратора, — и отсутствие любого из них это не «расходится» и тем более не
 * «делегировано», а отдельное состояние с названной причиной. Причина здесь не
 * украшение: «зоны нет», «провайдер без NS-API» и «домена нет в этом аккаунте
 * регистратора» чинятся тремя разными действиями.
 */

import { normalizeZoneName } from "./cfZoneMatch";
import { registrarProviderKnown, registrarSupportsNsApi } from "./registrarCaps";

/**
 * Статус зоны, которым Cloudflare подтверждает делегирование. Остальные его
 * значения (`pending`, `initializing`, `moved`, `deactivated`) — это «пока не
 * подтвердил», и различать их нам нечем: действие у них одно — ждать.
 */
const ZONE_ACTIVE = "active";

/** Почему состояние делегирования неизвестно. Каждая причина — своё действие. */
export type NsUnknownReason =
  /** Домен не привязан к живой зоне Cloudflare (нет аккаунта/зоны или зоны нет в аккаунте). */
  | "no-zone"
  /**
   * Привязка указывает на зону С ДРУГИМ ИМЕНЕМ.
   *
   * Отдельная причина, потому что молча это состояние выглядит здоровым:
   * nameservers Cloudflare выдаёт одни и те же на весь аккаунт, поэтому у
   * чужой зоны они совпадут с настоящими NS домена, а её статус вполне может
   * быть `active` — и бейдж сказал бы «делегировано, Cloudflare подтвердил»
   * про домен, зоны которого в Cloudflare нет вовсе.
   */
  | "zone-name-mismatch"
  /** Зона есть, а её nameservers не прочитаны — или зона не назвала ни одного. */
  | "zone-nameservers-unknown"
  /** Аккаунт регистратора домену не назначен: сверять не с чем. */
  | "no-registrar"
  /** У провайдера нет NS-API (см. `registrarSupportsNsApi`): спросить регистратора нечем. */
  | "registrar-no-api"
  /** NS у регистратора не прочитаны (отказ API) — или регистратор не назвал ни одного. */
  | "registrar-nameservers-unknown";

/**
 * Что мы знаем про делегирование.
 *
 * `pending` — не полумера и не «почти делегировано»: NS у регистратора уже те,
 * что выдал Cloudflare, но сам Cloudflare делегирование ещё не подтвердил.
 * Между этими двумя событиями проходит от минут до суток, и всё это время
 * зелёный бейдж был бы обещанием работающего домена.
 */
export type NsDelegation =
  | { state: "delegated"; nameservers: string[] }
  | { state: "pending"; nameservers: string[]; zoneStatus: string | null }
  /** Регистратор указывает не туда. Оба набора — чтобы было видно, что на что менять. */
  | { state: "mismatch"; expected: string[]; actual: string[] }
  | { state: "unknown"; reason: NsUnknownReason };

/** Зона Cloudflare в том виде, в каком её знает это правило. */
export interface ZoneNameservers {
  /** Имя зоны — сверяется с именем домена, см. `zone-name-mismatch`. */
  name: string;
  nameservers: readonly string[];
  /** `Zone.status` (`api/cloudflare.ts`): подтвердил ли Cloudflare делегирование. */
  status: string | null;
}

export interface NsDelegationInput {
  /** Имя домена — то, чему обязана соответствовать зона. */
  domainName: string;
  /**
   * Зона домена. `null` — домен к живой зоне не привязан (нет аккаунта, нет
   * `cloudflare_zone_id` или сохранённой зоны в аккаунте не оказалось);
   * `undefined` — зоны аккаунта ещё не прочитаны.
   *
   * Три случая слиты в `null` намеренно: чинятся они одним и тем же — выбором
   * аккаунта и дорезолвом зоны в карточке, — а «привязка указывает в пустоту»
   * от «привязки нет» отличается только историей, которой у пользователя нет.
   */
  zone: ZoneNameservers | null | undefined;
  /** `domains.registrar_id`: аккаунт регистратора, у которого спрашиваем NS. */
  registrarAccountId: number | null;
  /** `provider` этого аккаунта. `null`/`undefined` — список аккаунтов ещё не прочитан. */
  registrarProvider: string | null | undefined;
  /**
   * NS домена у регистратора — ответ на вопрос ПРО ЭТОТ ДОМЕН
   * (`useRegistrarNameservers`), а не строка из листинга аккаунта.
   *
   * `undefined` — не прочитаны (запрос ещё летит или регистратор ответил
   * отказом). Отдельного «домена в аккаунте нет» здесь нет намеренно:
   * непагинированный листинг такого утверждения не позволял — отсутствие
   * строки в нём значило «страница кончилась» ничуть не реже, — а поимённый
   * запрос отвечает либо списком, либо ошибкой регистратора, и её текст
   * показывается как есть.
   */
  registrarNameservers: readonly string[] | undefined;
}

/**
 * Имена NS в сравнимом виде: тем же `normalizeZoneName`, что и имена зон.
 *
 * Общая нормализация — не экономия строк, а условие сходимости: имя зоны и имя
 * nameserver'а это одинаковые DNS-имена, приезжающие из одних и тех же мест
 * (ответ Cloudflare — в нижнем регистре, ответ регистратора — как придётся,
 * иногда с завершающей точкой `ns1.example.com.`, а поле ввода набирается
 * руками). Вторая копия этого правила разошлась бы с первой молча.
 *
 * Дубли схлопываются: `ns1` и `NS1.` у регистратора — один и тот же сервер, и
 * посчитанные за два они превратили бы совпавшие наборы в «расходится».
 */
function normalizeNsList(list: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const ns = normalizeZoneName(raw);
    if (!ns || seen.has(ns)) continue;
    seen.add(ns);
    out.push(ns);
  }
  return out;
}

/**
 * Одинаковые ли наборы. Именно наборы: порядок nameservers не значит ничего —
 * регистраторы отдают их в своём порядке, и сравнение списками объявляло бы
 * «расходится» на верном делегировании.
 *
 * А вот ЧИСЛО значит: лишний NS у регистратора — это не «те же плюс запасной»,
 * а делегирование, поделённое с чужим сервером; Cloudflare такую зону активной
 * не считает.
 */
function sameNsSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((ns) => set.has(ns));
}

/**
 * Состояние делегирования домена на его зону Cloudflare.
 *
 * Порядок проверок — это порядок починки: сначала то, что чинится выше в
 * карточке (привязка зоны), потом то, что чинится в настройках регистратора.
 * Поэтому неизвестная зона перебивает неизвестного регистратора: пока не с чем
 * сверять, ответ регистратора всё равно ничего не решает.
 *
 * Незнакомый статус зоны (в том числе `null`) уводит совпавшие NS в `pending`, а
 * не в `delegated`: «делегировано» — единственное зелёное состояние на этой
 * лестнице, и выдавать его без подтверждения Cloudflare нельзя. Ошибка в эту
 * сторону безопасна (жёлтый бейдж рядом с верными NS читается как «ждём»), в
 * обратную — нет.
 */
export function nsDelegation(input: NsDelegationInput): NsDelegation {
  const { zone } = input;
  if (zone === null) return { state: "unknown", reason: "no-zone" };
  if (zone === undefined) return { state: "unknown", reason: "zone-nameservers-unknown" };
  // Имя зоны сверяется ДО nameservers, и это не педантизм: набор NS у
  // Cloudflare один на аккаунт, поэтому чужая зона сойдётся по ним с настоящими
  // NS домена и выдаст зелёное «делегировано» на домен, зоны которого в
  // Cloudflare нет. Правило сравнения — общее с матчем зон (`normalizeZoneName`).
  if (normalizeZoneName(zone.name) !== normalizeZoneName(input.domainName)) {
    return { state: "unknown", reason: "zone-name-mismatch" };
  }
  const expected = normalizeNsList(zone.nameservers);
  // Зона без единого NS — это не «зона без делегирования», а зона, про NS
  // которой мы ничего не узнали: сравнивать не с чем.
  if (expected.length === 0) return { state: "unknown", reason: "zone-nameservers-unknown" };

  if (input.registrarAccountId == null) return { state: "unknown", reason: "no-registrar" };
  // Провайдера ещё не знаем (список аккаунтов не прочитан) — это «не прочитано»,
  // а НЕ «у провайдера нет API»: вторая фраза обвиняла бы регистратора в том,
  // чего мы про него не выяснили. Предикат общий с панелью (`registrarCaps`):
  // разъехавшись, бейдж и подпись под кнопкой сказали бы про один аккаунт
  // разное.
  if (!registrarProviderKnown(input.registrarProvider)) {
    return { state: "unknown", reason: "registrar-nameservers-unknown" };
  }
  if (!registrarSupportsNsApi(input.registrarProvider)) {
    return { state: "unknown", reason: "registrar-no-api" };
  }
  if (input.registrarNameservers === undefined) {
    return { state: "unknown", reason: "registrar-nameservers-unknown" };
  }
  const actual = normalizeNsList(input.registrarNameservers);
  if (actual.length === 0) return { state: "unknown", reason: "registrar-nameservers-unknown" };

  if (!sameNsSet(expected, actual)) return { state: "mismatch", expected, actual };
  return zone.status === ZONE_ACTIVE
    ? { state: "delegated", nameservers: expected }
    : { state: "pending", nameservers: expected, zoneStatus: zone.status };
}

/**
 * Цвет бейджа. Зелёный занят под «делегирование подтверждено» и больше ни под
 * что: `unknown` — серый ровно потому, что это незнание, а не порядок (то же
 * правило и та же причина, что в `statusBadgeVariant` для серверов).
 *
 * Аргумент — только состояние из `nsDelegation`: единственный производитель
 * этих значений он, а `| string` обнулил бы union и дал опечатке молча получить
 * серый бейдж вместо ошибки сборки.
 */
export function nsDelegationVariant(state: NsDelegation["state"]): "green" | "yellow" | "red" | "gray" {
  if (state === "delegated") return "green";
  if (state === "pending") return "yellow";
  if (state === "mismatch") return "red";
  return "gray";
}
