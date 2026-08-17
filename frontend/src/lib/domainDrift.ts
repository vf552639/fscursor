/**
 * Расходится ли НАША запись про сайт с тем, что стоит на сервере.
 *
 * Карточка домена отвечает на вопрос «что с сайтом» из двух источников: колонки
 * домена — это снимок момента provision (что мы записали, когда разворачивали),
 * а `fp_facts` — живое чтение с сервера по SSH. Восемь полей у них общие, и
 * печатать оба ответа рядом значит заставлять человека сверять их глазами. Факт
 * — единственный источник; наша запись всплывает строкой «при развёртывании: X»
 * ровно тогда, когда РАСХОДИТСЯ с фактом.
 *
 * Исходов три, а не два, потому что вопросов тут три, и «мы этого не читали» —
 * не то же самое, что «совпало» (принцип №6 CLAUDE.md: незнание нельзя рисовать
 * согласием). Отсюда `recorded-only`: факта нет, значением поля становится наша
 * запись — приглушённая, с честной подписью «на сервере не проверено».
 *
 * Сердце модуля — НОРМАЛИЗАЦИЯ, и она не педантизм. Стороны пишут одно и то же
 * по-разному (`8.1` у provision против `81` у FastPanel, хвостовой слэш в пути,
 * секунды в datetime), и наивное сравнение строк объявляло бы расхождение на
 * каждом домене. Ложная строка «при развёртывании: …» под каждым полем стоит
 * ровно столько же, сколько ложный красный бейдж: после третьей её перестают
 * читать.
 *
 * Модуль намеренно НЕ знает типа `Domain`: каждая функция берёт одно значение
 * нашей записи и снимок целиком. Так правило можно проверить без сборки объекта
 * домена из тридцати полей, а зависимость остаётся одна — `DomainFacts`,
 * wire-контракт, который и без того общий у всех, кто про факты говорит.
 */

import { type DomainFacts } from "./domainFacts";

/** Откуда взялось значение поля и что рядом с ним дорисовать. */
export type FieldSource =
  /** Факт есть, наша запись с ним совпала — дорисовывать нечего. */
  | { kind: "agree" }
  /** Факт есть, наша запись другая — серая строка «при развёртывании: {recorded}». */
  | { kind: "drift"; recorded: string }
  /** Факта нет, есть только наша запись — она и становится значением поля. */
  | { kind: "recorded-only"; recorded: string };

const AGREE: FieldSource = { kind: "agree" };

/**
 * Пустая строка, `null` и `undefined` — одно и то же «значения нет».
 *
 * Ровно так их уже уравнивает хелпер `Field` в карточке (`v === null || v ===
 * undefined || v === ""` → прочерк): бэкенд отдаёт незаполненную колонку то
 * `null`, то пустой строкой, и различать их на экране нечем и незачем.
 */
function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Общий скелет всех правил: три исхода одинаковы у всех полей, разное — только
 * то, как «то же самое» выглядит с двух сторон (`same`).
 *
 * `fact` уже приведён к строке местом вызова (у баз это отдельная функция —
 * там факт список, а не значение). Пустой факт — это «мы не прочитали», а не
 * измеренное «там ничего нет», поэтому он даёт `recorded-only`, а не
 * расхождение: объявлять расхождение против незнания — то же самое, что рисовать
 * незнание здоровьем, только с обратным знаком.
 *
 * В `recorded` уходит ЧИТАЕМОЕ значение (только с обрезанными пробелами), а не
 * нормализованное: нормализация — дело сравнения, человеку же надо увидеть
 * ровно то, что записал provision (`8.1`, а не `81`).
 */
function compare(
  recorded: string | null | undefined,
  fact: string | null | undefined,
  same: (a: string, b: string) => boolean,
): FieldSource {
  const rec = clean(recorded);
  // Нашей записи нет — дорисовывать нечего ни в каком случае. Строка «при
  // развёртывании: —» не сообщает ничего: пустая колонка значит «мы не
  // записали», а не «мы записали пустоту». Отдельного исхода этому не заведено
  // намеренно — UI поступает с ним так же, как с совпадением: молчит.
  if (!rec) return AGREE;

  const f = clean(fact);
  if (!f) return { kind: "recorded-only", recorded: rec };

  return same(rec, f) ? AGREE : { kind: "drift", recorded: rec };
}

/** Точное совпадение с точностью до пробелов по краям. Регистр значим. */
const exact = (a: string, b: string) => a === b;

/**
 * Логин FTP.
 *
 * Регистр учитываем: логины на linux регистрозависимы, и `Example_ftp` — это
 * другой аккаунт, а не то же слово.
 *
 * Сверяемся с ПЕРВЫМ аккаунтом списка — тем же, который секция «Server state»
 * уже показывает как основной. Аккаунтов на сайте может быть несколько, но
 * основной у provision ровно один, и выбирать «наш где-то в списке есть»
 * означало бы прятать настоящую подмену основного логина.
 */
export function ftpLoginSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  return compare(recorded, facts?.ftp_accounts[0]?.login, exact);
}

/**
 * Путь до сайта. Хвостовой слэш не в счёт: `/var/www/x` и `/var/www/x/` — одна
 * и та же папка, а пишут её стороны как придётся.
 */
export function sitePathSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  return compare(recorded, facts?.site?.site_path, (a, b) => trimSlash(a) === trimSlash(b));
}

/** Убирает хвостовые слэши, но не сам корень: `/` — это путь, а не пустота. */
function trimSlash(path: string): string {
  const cut = path.replace(/\/+$/, "");
  return cut || "/";
}

/** Владелец сайта (системный пользователь). Регистр значим — см. логин FTP. */
export function siteOwnerSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  return compare(recorded, facts?.site?.site_user, exact);
}

/**
 * Версия PHP — сравнение ТОЛЬКО по цифрам: `8.1` ≡ `81` ≡ `php8.1`.
 *
 * Это самая дорогая ловушка из всех восьми: provision пишет версию человеческим
 * `8.1`, а FastPanel отдаёт свой идентификатор `81`, и наивное сравнение строк
 * подписывало бы расхождение КАЖДОМУ домену — то есть обесценивало бы саму
 * идею подписи.
 *
 * Факт берём из верхнего `php_version` (версия, которой сайт исполняется
 * сейчас), а при его отсутствии — из `site.php_version`; ровно этот же порядок
 * уже печатает секция «Server state», и разойтись с ней здесь значило бы
 * сверяться не с тем, что человек видит рядом.
 */
export function phpVersionSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  const fact = facts?.php_version ?? facts?.site?.php_version;
  return compare(recorded, fact, (a, b) => digits(a) === digits(b));
}

const digits = (v: string) => v.replace(/\D+/g, "");

/**
 * Срок сертификата — сравнение по КАЛЕНДАРНОЙ ДАТЕ.
 *
 * Обе стороны здесь полный datetime, и совпадают они до дня, но не до секунды:
 * наша запись сделана в момент выпуска, а сервер отдаёт то, что написано в
 * самом сертификате. Сравнение моментов подписывало бы расхождение из-за
 * секунд — при том что на экране обе даты выглядят одинаково.
 *
 * День берём в зоне ЧИТАТЕЛЯ, а не в UTC, и это не мелочь: карточка печатает
 * оба значения через `formatExpiryDate`, а он у datetime переводит момент в
 * местную зону (правило `domainExpiry.ts` — у настоящего мгновения правильный
 * ответ «когда у меня»). Сравнивай мы дни в UTC, у читателя далеко от UTC
 * нашлась бы пара значений, которые печатаются ОДНОЙ датой и при этом объявлены
 * расхождением, — и наоборот. Сравнение обязано жить в той же зоне, что и показ.
 *
 * Нечитаемая дата с любой стороны сравнивается как обычная строка: выдавать
 * мусор за совпадение нельзя, но две одинаковые строки — всё-таки не
 * расхождение.
 */
export function sslExpiresSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  return compare(recorded, facts?.ssl.expires_at, (a, b) => {
    const da = localDay(a);
    const db = localDay(b);
    return da !== null && db !== null ? da === db : a === b;
  });
}

/** Календарный день в зоне читателя; `null` — строку разобрать не удалось. */
function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Издатель сертификата. Сравниваем как есть, с точностью до пробелов. */
export function sslIssuerSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  return compare(recorded, facts?.ssl.issuer, exact);
}

/**
 * Имя базы. Факт здесь — СПИСОК баз сервера, а не одно значение: расхождение,
 * если нашего имени в списке нет.
 *
 * Поэтому же поле не проходит через `compare`: пустой список — это измерение
 * («баз не нашли»), а не отсутствие измерения, и он даёт расхождение. Незнание
 * тут выражено иначе — отсутствием самого снимка.
 *
 * Регистр значим: под linux имена баз MySQL регистрозависимы.
 */
export function dbNameSource(
  recorded: string | null | undefined,
  facts: DomainFacts | null | undefined,
): FieldSource {
  const rec = clean(recorded);
  if (!rec) return AGREE;
  if (!facts) return { kind: "recorded-only", recorded: rec };
  return facts.databases.some((db) => db.trim() === rec) ? AGREE : { kind: "drift", recorded: rec };
}

/**
 * Пользователь базы — ВСЕГДА `recorded-only`: сверять не с чем.
 *
 * `facts.databases` — только имена баз; пользователей FastPanel CLI не отдаёт
 * вовсе (`docs/FASTPANEL_CLI.md`). Функция существует ради единообразия вызова
 * в карточке: без неё поле показывалось бы «просто так», и через полгода никто
 * не вспомнил бы, обошли его намеренно или забыли.
 */
export function dbUserSource(recorded: string | null | undefined): FieldSource {
  const rec = clean(recorded);
  return rec ? { kind: "recorded-only", recorded: rec } : AGREE;
}
