/**
 * Адрес сервера: проверка перед отправкой и текст отказа — одним модулем, как
 * `providerInput` и `fastpanelInput` рядом.
 *
 * Правило поля жило двумя копиями — своей регуляркой в «Add Server» и своей на
 * странице сервера, — и копии успели разойтись по СМЫСЛУ: одна принимала только
 * IPv4, вторая пропускала что угодно с двоеточием (включая «1.2.3.4:22» и
 * «http://example.com»). Разница между формами настоящая и остаётся, но теперь
 * она названа параметром `ipv6`, а не вычитывается глазами из двух регулярок.
 *
 * Бэкенд адрес НЕ проверяет и проверять не собирается: `_checked_server_text`
 * (`backend/app/schemas/server.py`) прямо оговаривает, что `ip_address` формату
 * адреса не обязан — там сознательно проверяется только пригодность для колонки
 * (`String(45)`). То есть здесь не дубль серверного правила, а единственное
 * место, где формат вообще проверяется, и цена пропуска не 422:
 *
 *   — `sshExec` (`api/servers.ts`) шлёт значение в `host` как есть: «1.2.3.4:22»
 *     даёт отказ соединения без внятной причины;
 *   — `fastpanelUrlOf` (`pages/ServerDetail.tsx`) собирает из него адрес панели.
 */

/**
 * Ширина колонки `servers.ip_address`. Парно к `IP_ADDRESS_MAX_LEN` в
 * `backend/app/core/validators.py`, где живёт первоисточник (там же — граница
 * между 422 и 500 из Postgres).
 */
export const IP_ADDRESS_MAX_LEN = 45;

// C0 плюс DEL — парно к `_CONTROL_CHARS_RE` на бэкенде. Вставка из терминала
// приносит их вместе с ANSI-раскраской, и без этой проверки поле зеленело бы
// здесь, чтобы получить 422 на сервере (тот же довод, что в `fastpanelInput`).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Октет с потолком 255, а не `[0-9]{1,3}`: прежняя регулярка «Add Server»
// принимала «999.999.999.999» — по такому адресу не постучаться ни SSH, ни
// браузеру.
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4 = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$`);

/** Точечная запись IPv4 — та форма, в которой адрес заводят в «Add Server». */
function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

/**
 * Сколько 16-битных групп занимает половина адреса, или `null`, если половина
 * не разбирается. Встроенный IPv4 («::ffff:192.168.1.1») считается за две
 * группы и допускается только последним элементом всего адреса — за это
 * отвечает `allowV4Tail`.
 */
function groupCount(groups: string[], allowV4Tail: boolean): number | null {
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.includes(".")) {
      if (!allowV4Tail || i !== groups.length - 1 || !isIpv4(g)) return null;
      count += 2;
      continue;
    }
    // Пустая группа сюда приходит из «1:::2» и «1:2:» — `split(":")` даёт "",
    // и она честно не проходит: одно «::» уже вырезано вызывающим кодом.
    if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
    count += 1;
  }
  return count;
}

/**
 * IPv6 разбором, а не одной регуляркой: регулярка на все формы («::», сжатие,
 * встроенный IPv4) нечитаема и непроверяема глазом, а разбор — это ровно три
 * правила из RFC 4291, каждое из которых видно.
 *
 * Зона («fe80::1%eth0») не принимается намеренно: адрес уезжает в SSH-коннект и
 * в URL панели, где зона не значит ничего, а «принять и молча сломать позже» —
 * худший из исходов.
 */
function isIpv6(value: string): boolean {
  const halves = value.split("::");
  // Два «::» в одном адресе — уже не адрес: восстановить, сколько нулей за
  // каждым, невозможно.
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  const split = (s: string) => (s === "" ? [] : s.split(":"));
  const head = split(halves[0]);
  const tail = compressed ? split(halves[1]) : [];

  const headCount = groupCount(head, !compressed || tail.length === 0);
  const tailCount = groupCount(tail, compressed);
  if (headCount === null || tailCount === null) return false;

  const total = headCount + tailCount;
  // Голое «::» (адрес «не задан») формально валидно, но адресом СЕРВЕРА быть не
  // может — по нему некуда стучаться.
  if (total === 0) return false;
  return compressed ? total <= 7 : total === 8;
}

/** Форма записи, которую принимает конкретное поле. */
export interface IpErrorOptions {
  /**
   * Принимать ли IPv6. «Add Server» — нет (сервер заводят по IPv4, и лишняя
   * свобода в форме создания только плодит нерабочие записи), правка адреса на
   * странице сервера — да: у уже заведённого сервера адрес мог смениться на
   * IPv6, и форма, отвергающая настоящий адрес машины, оставила бы человека без
   * способа его записать.
   */
  ipv6?: boolean;
}

/**
 * Текст ошибки для человека или `null`, если поле в порядке.
 *
 * Проверяется обрезанное значение, и ровно оно же уезжает на сервер: иначе
 * форма зеленела бы там, где по адресу с пробелом по краям уже не постучаться.
 *
 * Формулировки общие на обе формы: множество принимаемых значений у них разное,
 * а требование, которое читает человек, одно и то же — «в поле должен стоять
 * IP-адрес», — и объяснять его двумя разными фразами нельзя.
 */
export function ipError(value: string, opts: IpErrorOptions = {}): string | null {
  const ip = value.trim();
  if (!ip) return "IP address is required";
  if (CONTROL_CHARS.test(ip)) return "IP address must not contain control characters";
  // Для правильно записанного адреса это недостижимо (самый длинный — 39
  // символов), и проверка стоит здесь не ради него, а ради колонки: правило
  // «влезает в `String(45)`» — серверное и своё, и оно не должно исчезнуть
  // молча, если формат когда-нибудь ослабят (имя хоста, зона интерфейса).
  if (ip.length > IP_ADDRESS_MAX_LEN) {
    return `IP address must be at most ${IP_ADDRESS_MAX_LEN} characters`;
  }
  if (isIpv4(ip)) return null;
  if (opts.ipv6 && isIpv6(ip)) return null;
  return "Invalid IP address format";
}
