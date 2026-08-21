import { CloudflareAccount } from "../../api/cloudflare";
import { Domain } from "../../api/domains";
import { DomainFacts } from "../../lib/domainFacts";

/**
 * Строка домена в том виде, в каком её показывает вкладка: только те поля,
 * которые действительно рисуются или по которым фильтруют и сортируют.
 *
 * Отдельный тип, а не сам `Domain`, — чтобы у таблицы, карточек и строки был
 * один словарь: они складывались бы из разных подмножеств одного большого
 * ответа, и «какие поля этому экрану нужны» приходилось бы вычитывать из JSX.
 */
export interface DomainUI {
  id: number;
  domain: string;
  server_id: number | null;
  registrar_id: number | null;
  cf_id: number | null;
  ns_status: string;
  status: string;
  /**
   * Сертификат из СНИМКА сервера (`fp_facts.ssl`), а не наша запись
   * `ssl_status`, и это главное отличие типа от ответа API.
   *
   * `ssl_status` — исход provision: единственный её писатель — сам прогон
   * (`desktop/.../provision.rs`), и у домена, настроенного мимо SDMP, она пуста
   * НАВСЕГДА. Строка, читавшая её, называла такой домен «No SSL», пока его же
   * карточка показывала «Valid», — два ответа про одно на двух экранах. Теперь
   * источник один: `sslState(ssl, facts_at)`, ровно как в карточке.
   *
   * `null` — снимка нет; это `unchecked` («не проверяли»), а не «сертификата
   * нет» (принцип №6 CLAUDE.md).
   */
  ssl: DomainFacts["ssl"] | null;
  /** Когда снимок УДАЛСЯ (`fp_facts_at`). Читается только в паре с `ssl`. */
  facts_at: string | null;
  /**
   * Исход выпуска сертификата в НАШЕМ прогоне. Остался ровно ради одного
   * потребителя — счётчика «Failed at SSL» (`lib/domainCounts`), и это не
   * пережиток: `ssl_status === "error"` — единственный след прогона, дошедшего
   * до SSL и не получившего сертификат, а колонка списка теперь отвечает на
   * другой вопрос («что сейчас на сервере»). Рисовать им состояние сертификата
   * больше нельзя нигде.
   */
  ssl_status?: string | null;
  /** Срок домена у регистратора. `date` без времени — считаем сутками. */
  expiry_date?: string | null;
  last_provision_error?: string | null;
  created: string;
}

/**
 * Что живой список зон Cloudflare знает про домен, у которого в базе привязки
 * нет (`cloudflare_account_id` пуст).
 *
 * Это ЗНАНИЕ, а не факт: зоны читаются вживую (`cf_list_zones`), в строке домена
 * ничего не записано, и до прогона привязки не записано и не будет. Поэтому
 * подсказка и рисуется иначе, чем сохранённое имя аккаунта, — см. `DomainRow`.
 *
 * `ambiguous` попал в тип, хотя сегодня рисуется тем же прочерком, что и
 * отсутствие подсказки: «мы не нашли» и «нашли в двух аккаунтах, и выбрать за
 * пользователя не вправе» — разные состояния, и первому нельзя дать поглотить
 * второе (то же правило, что в `lib/cfZoneMatch`). Показывать неоднозначность в
 * строке — решение пользователя: не показываем, чтобы не шуметь.
 */
export type RowCfHint =
  | { outcome: "matched"; account: CloudflareAccount }
  | { outcome: "ambiguous"; accountIds: number[] };

/** Ответ API → строка вкладки. Единственное место, где эти поля переименовываются. */
export function toDomainUI(d: Domain): DomainUI {
  return {
    id: d.id,
    domain: d.domain_name,
    server_id: d.server_id,
    registrar_id: d.registrar_id,
    cf_id: d.cloudflare_account_id,
    ns_status: d.ns_status || "pending",
    status: d.status,
    ssl: d.fp_facts?.ssl ?? null,
    facts_at: d.fp_facts_at ?? null,
    ssl_status: d.ssl_status,
    expiry_date: d.expiry_date,
    last_provision_error: d.last_provision_error,
    created: d.created_at,
  };
}
