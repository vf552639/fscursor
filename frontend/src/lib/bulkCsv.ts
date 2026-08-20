import { DomainBulkCreateItem } from "../api/domains";

/**
 * Разбор CSV массового добавления — отдельным модулем, а не обработчиком внутри
 * диалога.
 *
 * Причина та же, что у `lib/fullSetupPlan` и `lib/cfZoneMatch`: здесь не
 * разметка, а решения. Третья колонка превращается в `server_id`, по которому
 * provision заливает сайт на конкретную машину, — то есть ошибка разбора
 * материализуется чужим сайтом на чужом железе, и увидеть её глазами в диалоге
 * нельзя. Такое проверяется без DOM.
 *
 * Почему резолв «строка → сервер» вообще на фронте, хотя регистратор рядом
 * резолвится по имени на бэкенде (`find_reg_id`): только фронт держит ИСХОДНЫЙ
 * текст и может назвать номер строки, в которой опечатка, и не дать отправить
 * пачку. Бэкенд на его месте либо завёл бы домен без сервера молча, либо уронил
 * бы всю пачку, не сказав, какая строка виновата. Поэтому в
 * `DomainBulkCreateItem` нет и не будет поля `server_name`/`server_ip`.
 */

/** Что нужно от сервера для резолва — подмножество `Server` (`api/servers.ts`). */
export interface ResolvableServer {
  id: number;
  name: string;
  ip_address: string;
}

export interface BulkCsvOptions {
  /** Все серверы пользователя: только среди них ищется третья колонка. */
  servers: ReadonlyArray<ResolvableServer>;
  /** Сервер из селекта диалога — для строк без третьей колонки. */
  defaultServerId?: number | null;
  /**
   * Регистратор из селекта диалога — для строк без второй колонки.
   *
   * Пара к `defaultServerId`, а не украшение: оба селекта видны на вкладке CSV,
   * и селект, который ни на что не влияет, — это молча потерянный выбор
   * пользователя. Ставится ТОЛЬКО там, где своего имени в строке нет:
   * `find_reg_id` на бэкенде смотрит `registrar_id` раньше `registrar_name`, и
   * проставленный поверх имени id перебил бы то, что человек написал в строке.
   */
  defaultRegistrarId?: number | null;
}

/**
 * Почему значение третьей колонки не стало сервером. Два повода, и различать их
 * обязательно: «не найден» чинят опечаткой, а «подходит нескольким» — тем, что
 * пишут IP вместо имени (или наоборот). Одно слово на оба случая солгало бы в
 * половине показов.
 */
export type BulkCsvErrorReason = "not-found" | "ambiguous";

export interface BulkCsvError {
  /**
   * Номер строки в textarea, считая с единицы и ВКЛЮЧАЯ пустые.
   *
   * Пустые строки между данными — обычная копипаста, и номер, посчитанный после
   * их отбрасывания, отправил бы человека искать опечатку не туда. Это
   * единственный способ найти одну строку среди сотни вставленных.
   */
  line: number;
  /** Значение колонки словами пользователя — по нему он и ищет строку глазами. */
  value: string;
  reason: BulkCsvErrorReason;
}

export interface BulkCsvParse {
  items: DomainBulkCreateItem[];
  /**
   * Строки, чей сервер не разобрался. Непустой список — запрет на отправку:
   * отправив пачку, продукт завёл бы часть доменов без сервера, а вернуться к
   * исходному тексту уже было бы неоткуда.
   */
  errors: BulkCsvError[];
  /**
   * Весь текст похож на CSV с запятыми вместо `;`.
   *
   * Не строчная ошибка, а диагноз всему вводу, поэтому отдельным полем, а не
   * элементом `errors`: разобранный по `;` текст с запятыми даёт домены вида
   * «example.com,Namecheap,45.83.194.107» и ни одной осмысленной ошибки про
   * сервер — то есть шум вместо единственной внятной новости «поменяйте
   * разделитель». Поле, а не отдельная экспортируемая проверка, ровно потому,
   * что вызвать её было бы можно забыть.
   */
  commaSeparated: boolean;
}

/**
 * Найти сервер по значению третьей колонки: по `ip_address` ИЛИ по `name`.
 *
 * «Или/или» — то же правило, что у `find_reg_id` для регистратора: человек
 * пишет то, чем помнит машину. IP сверяется как есть (после `trim`), имя — без
 * учёта регистра, потому что имена набирают руками, а IP копируют.
 *
 * Совпадение у двух РАЗНЫХ серверов — отказ, а не первый попавшийся. Ровно то
 * же решение, что в `lib/cfZoneMatch`, и по той же причине: угадав, продукт
 * записал бы домену чужой `server_id`, а provision залил бы сайт на машину, о
 * которой пользователь не просил. Один сервер, совпавший обоими способами
 * сразу (машина, названная собственным IP), неоднозначностью не является —
 * выбирать не из чего.
 */
function resolveServer(
  raw: string,
  servers: ReadonlyArray<ResolvableServer>,
): { outcome: "matched"; id: number } | { outcome: BulkCsvErrorReason } {
  const key = raw.toLowerCase();
  const hits = servers.filter(
    (s) => s.ip_address.trim() === raw || s.name.trim().toLowerCase() === key,
  );
  if (hits.length === 0) return { outcome: "not-found" };
  if (hits.length > 1) return { outcome: "ambiguous" };
  return { outcome: "matched", id: hits[0].id };
}

/**
 * Строки CSV → элементы `/domains/bulk-structured` плюс список непонятых
 * серверов.
 *
 * Чего модуль НЕ проверяет — имя домена. Это не забывчивость: домены проверяет
 * бэкенд (`is_valid_domain`) и называет непринятые в `skipped`, а диалог уже
 * показывает этот ответ. Вторая проверка здесь была бы вторым мнением о том же
 * вопросе — и разошлась бы с первым молча. Сервер — другое дело: о третьей
 * колонке бэкенд не знает по построению (см. шапку модуля), и кроме фронта
 * ответить некому.
 *
 * Строка без первой колонки выпадает молча и без ошибки: привязывать сервер
 * не к чему, а жалоба на её третью колонку была бы жалобой на строку, которой
 * в отправке всё равно нет.
 */
export function parseBulkCsv(text: string, options: BulkCsvOptions): BulkCsvParse {
  const { servers, defaultServerId = null, defaultRegistrarId = null } = options;

  // Индекс строки в исходном тексте — единственный источник номера в ошибке,
  // поэтому нумеруем ДО любой фильтрации.
  const lines = text.split("\n").map((line, i) => ({ n: i + 1, text: line.trim() }));
  const filled = lines.filter((l) => l.text);

  if (filled.some((l) => l.text.includes(",") && !l.text.includes(";"))) {
    return { items: [], errors: [], commaSeparated: true };
  }

  const items: DomainBulkCreateItem[] = [];
  const errors: BulkCsvError[] = [];

  for (const line of filled) {
    const parts = line.text.split(";");
    const domainName = parts[0].trim();
    if (!domainName) continue;

    const registrarName = (parts[1] ?? "").trim();
    const serverRaw = (parts[2] ?? "").trim();

    let serverId: number | null = defaultServerId;
    if (serverRaw) {
      const hit = resolveServer(serverRaw, servers);
      if (hit.outcome === "matched") {
        serverId = hit.id;
      } else {
        errors.push({ line: line.n, value: serverRaw, reason: hit.outcome });
        // Именно `null`, а не сервер из селекта: подставить дефолт вместо
        // непонятого значения — это и есть то самое угадывание. Отправку
        // всё равно держат `errors`, но элемент не должен нести догадку на
        // случай, если однажды их прочитает кто-то другой.
        serverId = null;
      }
    }

    items.push({
      domain_name: domainName,
      registrar_name: registrarName || null,
      registrar_id: registrarName ? null : defaultRegistrarId,
      server_id: serverId,
    });
  }

  return { items, errors, commaSeparated: false };
}
