/**
 * Снятие метрик сервера: команда для чужой машины и разбор её вывода.
 *
 * Живёт в `lib/`, а не в `api/servers.ts`, по той же причине, что `sshHostKey`
 * и `secretBlob`: это работа с чужой машиной, а не слой API-хуков. В
 * `api/servers.ts` остаётся только то, что связывает одно с другим —
 * `runCollectMetrics` и мутация.
 */

/**
 * Тело `POST /servers/{id}/metrics` — ровно то, что десктоп УМЕЕТ снять. Имя
 * повторяет серверную схему (`schemas/server.ServerMetricsIn`) намеренно: тип
 * обязан ходить с ней в ногу, а `ServerMetrics` в `pages/dashboardData.ts` —
 * это уже view-модель карточки, и путать их нельзя.
 *
 * Все поля обязательны и nullable, и это главное свойство типа. Бэкенд читает
 * тело через `exclude_unset` и различает два случая: явный `null` ЗАТИРАЕТ
 * колонку, отсутствующий ключ её НЕ ТРОГАЕТ (`server_service.apply_metrics`).
 * Отсюда правило: «пробовали снять, но не разобрали» — это `null` (снимок
 * атомарен, и старое число под свежей `metrics_collected_at` выглядело бы
 * правдой), а «не собираем вовсе» — это отсутствие ключа.
 *
 * Поэтому здесь НЕТ `fastpanel_version`: его пишет установщик панели, а мы его
 * не измеряем — пришли мы его как `null`, и первый же сбор метрик стёр бы
 * версию, которую туда положил провижн. Не «забыли добавить», а нельзя: с
 * `Required`-полями компилятор не даст ни забыть заполненное, ни дослать лишнее
 * (на бэкенде лишний ключ — 422 `extra_forbidden`).
 */
export interface ServerMetricsIn {
  uptime_seconds: number | null;
  cpu_usage_pct: number | null;
  cpu_count: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  net_in_kbps: number | null;
  net_out_kbps: number | null;
  os_pretty: string | null;
  kernel: string | null;
}

/**
 * Сколько строк `/proc/net/dev` читаем: две заголовочные плюс 62 интерфейса.
 *
 * Потолок именно здесь, на удалённой стороне, а не в разборе: на docker-ноде с
 * сотнями veth эта секция — самая крупная в выводе, а снимается она ДВАЖДЫ.
 * Без ограничения объём снимка зависел бы от того, сколько контейнеров подняли
 * на чужой машине, и на busy-ноде вылезал бы за наш потолок разбора — то есть
 * сбор метрик отказывал бы ровно на самых нагруженных серверах.
 *
 * Обрезаем именно хвост списка: порядок в `/proc/net/dev` — это порядок
 * регистрации устройств в ядре, то есть сначала `lo` и физические интерфейсы,
 * а динамические veth — потом. Плата за ограничение — недоучёт трафика
 * контейнеров сверх 62-го интерфейса; альтернатива (суммировать на стороне
 * сервера через awk) стоила бы разбора чужого awk и куда более хрупкой команды.
 */
const NET_DEV_LINES = 64;

/**
 * Команда сбора метрик. Один вход по SSH на весь снимок и ни одной записи на
 * чужой машине: только `cat`/`head`/`grep`/`df`/`uname`/`nproc` по `/proc` и
 * `/etc/os-release`.
 *
 * Каждая секция помечена строкой-маркером. Маркеры — не украшение: вывод едет с
 * ЧУЖОЙ машины, где `/proc/net/dev` может отсутствовать (контейнер), `nproc` —
 * не быть установлен, а SSH-баннер — приехать поверх нашего stdout. Без маркеров
 * парсер угадывал бы секции по форме и на первом же нестандартном хосте
 * приписал бы значение не тому полю. С маркерами пропавшая секция — это ровно
 * `null` в своём поле и ничего больше.
 *
 * `2>/dev/null` на каждом источнике и никаких `&&`: одна недоступная секция не
 * должна ронять весь сбор.
 *
 * Порядок секций держится на том, что МЕЖДУ ДВУМЯ ЗАМЕРАМИ не должно стоять
 * ничего, кроме самой паузы. Отсюда статика (`nproc`, `mem`, `disk`, `kernel`,
 * `os`) идёт до них: окажись `df` между замерами, длина окна выросла бы на
 * время его ответа — а на сервере с протухшим маунтом или медленным диском это
 * секунды. Само окно мы потом измеряем (разность аптаймов), так что скорость
 * сети осталась бы верной, но окно перестало бы быть тем «сейчас», о котором
 * говорит `cpu_usage_pct`: проценты считаются отношением дельт и растянутое
 * окно усредняют.
 *
 * Спасать поля порядком не пытаемся — неполный вывод не спасается вовсе:
 * без `#sdmp:end` разбор отказывает целиком (см. `parseServerMetrics`).
 *
 * `sleep 1` посередине обязателен. `/proc/stat` — счётчики С МОМЕНТА ЗАГРУЗКИ:
 * одиночный замер даёт среднюю загрузку за всё время работы машины, а не то,
 * что пользователь ожидает увидеть на карточке. Проценты считаются по ДЕЛЬТЕ
 * двух замеров, `/proc/net/dev` — тоже. `top -bn1` дал бы то же одним замером,
 * но его формат гуляет между дистрибутивами и локалями.
 *
 * `/proc/uptime` снимается дважды не по недосмотру: разность двух показаний —
 * это фактическая длина паузы, ей и делим байты сети. `sleep 1` на нагруженной
 * машине может занять и полторы секунды, и тогда «нормировка на 1 с» завысила
 * бы трафик в полтора раза.
 *
 * `df -kP`, а не голый `df`: `-P` держит запись в одной строке, `-k` — в
 * фиксированных единицах (человеческий формат пришлось бы разбирать обратно
 * вместе с локалью), а сам аргумент `/` не даёт `df` пойти по всем маунтам —
 * протухший NFS среди них подвесил бы весь сбор.
 *
 * `#sdmp:end` последней строкой — это подпись «вывод доехал целиком»; чем она
 * важна, написано в `parseServerMetrics`.
 *
 * Экспортируется ради теста: подмена на команду с побочным эффектом обязана
 * ломать тест, а не тихо проехать в живой прогон (см. `SSH_TEST_COMMAND`).
 */
export const COLLECT_METRICS_COMMAND = [
  "echo '#sdmp:nproc'; nproc 2>/dev/null",
  "echo '#sdmp:mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
  "echo '#sdmp:disk'; df -kP / 2>/dev/null",
  "echo '#sdmp:kernel'; uname -r 2>/dev/null",
  "echo '#sdmp:os'; grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null",
  "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
  "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
  `echo '#sdmp:net'; head -n ${NET_DEV_LINES} /proc/net/dev 2>/dev/null`,
  "sleep 1",
  "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
  "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
  `echo '#sdmp:net'; head -n ${NET_DEV_LINES} /proc/net/dev 2>/dev/null`,
  "echo '#sdmp:end'",
].join("\n");

/** Префикс строки-маркера секции; всё до первого маркера — не наше (баннер). */
const SECTION_PREFIX = "#sdmp:";

/** Секция-подпись: её наличие и означает «вывод доехал целиком». */
const END_SECTION = "end";

/**
 * Потолок на объём разбираемого вывода. Защищает РАЗБОР, а не транспорт: к
 * этому моменту вывод уже целиком приехал по SSH и лежит строкой в памяти.
 *
 * Сам объём ограничен конструкцией команды (`NET_DEV_LINES` — единственная
 * секция, которая могла бы расти без предела), и в норме снимок укладывается в
 * пару десятков килобайт. Поэтому превышение 64 КиБ — не «болтливая машина», а
 * признак того, что в наш stdout попало что-то чужое: разбирать это до конца
 * незачем, а `#sdmp:end` за потолком всё равно превратит вывод в отказ.
 */
const MAX_METRICS_OUTPUT = 64 * 1024;

/**
 * Верхняя граница числовых полей — ширина колонки Postgres (`PG_INT_MAX`).
 * Значение сверх неё не «большое», а неверное: 68 лет аптайма или петабайт на
 * корне — это промах парсера по чужой строке, и честный ответ на него `null`, а
 * не подрезанное до максимума число. Для `uptime_seconds` колонка на бэкенде
 * шире (bigint), но 68 лет — уже не показание.
 */
const MAX_METRIC_INT = 2147483647;

/** Длины строковых колонок на бэкенде: длиннее — 422 на ВЕСЬ снимок. */
const OS_PRETTY_MAX_LEN = 255;
const KERNEL_MAX_LEN = 128;

/** Ключ в `/etc/os-release`; он же — длина префикса при разборе значения. */
const OS_PRETTY_KEY = "PRETTY_NAME=";

/** Запасная длина паузы, если `/proc/uptime` не дал разность (см. команду). */
const FALLBACK_SAMPLE_SECONDS = 1;

/**
 * Короче этого пауза не считается паузой. Заказан `sleep 1`; разность аптаймов
 * в сотую долю секунды означает, что `sleep` не отработал и замеры пошли
 * подряд, — а делить байты на такое окно значит умножить трафик на сотню.
 */
const MIN_SAMPLE_SECONDS = 0.1;

/**
 * Число из чужой строки. `Number`, а не `parseInt`: `parseInt("12abc")` вернул
 * бы 12, то есть превратил бы мусор в правдоподобное показание, а `Number` на
 * том же входе честно даёт NaN → `null`.
 *
 * Локальной запятой здесь не занимаемся намеренно. Все источники команды —
 * файлы `/proc` и `df -k`, а они печатают числа сами, без локали. Перевод
 * `,` в `.` был бы догадкой о происхождении строки и на разделителе тысяч
 * («12,345») дал бы не отказ, а тихо неверные 12.345.
 */
function num(token: string | undefined): number | null {
  if (!token) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

/** Округлить в колонку или признать, что не разобрали (см. `MAX_METRIC_INT`). */
function toInt(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= MAX_METRIC_INT ? rounded : null;
}

/**
 * Строка в колонку: без управляющих символов и не длиннее колонки. И то, и
 * другое — не косметика: бэкенд отвергает такое значение, а отвергает он ВСЁ
 * тело, то есть один кривой `PRETTY_NAME` стоил бы нам всего снимка.
 *
 * Режем по СИМВОЛАМ, а не по единицам UTF-16, которыми меряет `slice`: эмодзи
 * или иероглиф — это две единицы, и обрыв между ними оставляет половину
 * суррогатной пары. Такая строка уезжает в JSON, и на той стороне это уже не
 * внятный 422, а 500 из драйвера, то есть потеря всего снимка. Посимвольная
 * длина заодно совпадает с той, по которой считает Postgres.
 */
function toText(value: string | undefined, maxLen: number): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? [...clean].slice(0, maxLen).join("") : null;
}

/**
 * Разложить вывод по секциям. Одно имя может встретиться дважды (`uptime`,
 * `cpu`, `net` снимаются до и после паузы), поэтому значение — список
 * вхождений по порядку.
 */
function splitSections(lines: string[]): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(SECTION_PREFIX)) {
      current = [];
      const name = line.slice(SECTION_PREFIX.length).trim();
      const seen = sections.get(name);
      if (seen) seen.push(current);
      else sections.set(name, [current]);
      continue;
    }
    // Всё до первого маркера отбрасывается вместе с `current === null`: это
    // SSH-баннер или motd, и «Welcome to Ubuntu 22.04» из него — не показание.
    if (current) current.push(line);
  }
  return sections;
}

/**
 * Непустые строки ОДНОГО замера секции — того, что под номером `index`. Пустой
 * результат = источника на машине нет; к следующему вхождению функция не
 * переходит намеренно, потому что вхождения — это разные моменты времени, и
 * подставить вместо замера «после» замер «до» значило бы посчитать дельту с
 * самой собой.
 */
function sampleLines(sections: Map<string, string[][]>, name: string, index = 0): string[] {
  return (sections.get(name)?.[index] ?? []).filter((l) => l.trim() !== "");
}

/** Первое число `/proc/uptime` — секунды с загрузки, дробные. */
function uptimeAt(sections: Map<string, string[][]>, index: number): number | null {
  return num(sampleLines(sections, "uptime", index)[0]?.trim().split(/\s+/)[0]);
}

/**
 * Показания строки `cpu` из `/proc/stat`: сколько всего и сколько из этого
 * простой. Берём первые 8 полей (`user nice system idle iowait irq softirq
 * steal`) и не берём `guest`/`guest_nice` — они УЖЕ учтены внутри `user`/`nice`,
 * и их сумма завысила бы знаменатель.
 *
 * Простой — только `idle`, без `iowait`: машина, забившая диск, должна выглядеть
 * занятой, а не отдыхающей. Это же значение показывал продукт раньше
 * (`100 - id` из `top`).
 */
function cpuSample(sections: Map<string, string[][]>, index: number): { total: number; idle: number } | null {
  const parts = sampleLines(sections, "cpu", index)[0]?.trim().split(/\s+/) ?? [];
  if (parts[0] !== "cpu") return null;
  const values = parts.slice(1, 9).map((p) => num(p));
  // Меньше четырёх полей — `idle` в строке нет, и знаменатель не с чем сравнить.
  if (values.length < 4 || values.some((v) => v === null)) return null;
  const nums = values as number[];
  return { total: nums.reduce((a, b) => a + b, 0), idle: nums[3] };
}

/**
 * Счётчики байт ПО ИНТЕРФЕЙСАМ, кроме `lo`. Петля — это трафик машины с самой
 * собой (у активной БД он больше внешнего), и в «сколько сервер качает из сети»
 * ему делать нечего.
 *
 * По интерфейсам, а не одной суммой, потому что разностью двух сумм трафик
 * считать НЕЛЬЗЯ: набор интерфейсов между замерами меняется, и подробности — в
 * `netDelta`.
 *
 * Заголовок `/proc/net/dev` отсекается сам: в его двух строках нет `:`.
 * Интерфейсы сверх `NET_DEV_LINES` до нас не доехали — см. там же.
 */
function netSample(
  sections: Map<string, string[][]>,
  index: number,
): Map<string, { rx: number; tx: number }> | null {
  const byIface = new Map<string, { rx: number; tx: number }>();
  for (const line of sampleLines(sections, "net", index)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const iface = line.slice(0, at).trim();
    if (iface === "lo") continue;
    const cols = line.slice(at + 1).trim().split(/\s+/);
    // 8 колонок приёма, дальше передача: `bytes` передачи — девятая.
    if (cols.length < 9) continue;
    const rx = num(cols[0]);
    const tx = num(cols[8]);
    if (rx === null || tx === null) continue;
    byIface.set(iface, { rx, tx });
  }
  return byIface.size ? byIface : null;
}

/**
 * Сколько байт прошло за паузу. Считается ПО КАЖДОМУ интерфейсу и только по
 * тем, что есть в обоих замерах, — разность двух сумм верна лишь при
 * неизменном наборе устройств, а он меняется, и каждый случай врёт по-своему:
 *
 * * интерфейс ИСЧЕЗ (контейнер остановился) — сумма проседает, разность
 *   отрицательная, и обнуляются обе метрики, хотя по `eth0` всё считалось;
 * * интерфейс ПОЯВИЛСЯ или въехал в окно `NET_DEV_LINES` из-за перестановки
 *   списка — его пожизненный счётчик целиком уходит в дельту. На тихой машине
 *   это рисует гигабиты в секунду, причём в допустимом диапазоне колонки, то
 *   есть на карточке это выглядит правдой;
 * * счётчик ПЕРЕПОЛНИЛСЯ (32 бита на нагруженном интерфейсе) — по-хорошему
 *   теряется он один, а по сумме терялись бы показания целиком.
 *
 * Поэтому: пересечение по именам, отрицательная дельта у интерфейса — мимо
 * него, а не мимо метрики. `null` — ни одного пригодного интерфейса.
 */
function netDelta(
  before: Map<string, { rx: number; tx: number }>,
  after: Map<string, { rx: number; tx: number }>,
): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const [iface, end] of after) {
    const start = before.get(iface);
    if (!start) continue;
    const dRx = end.rx - start.rx;
    const dTx = end.tx - start.tx;
    // Устройство с уехавшим назад счётчиком выбрасываем целиком: переполнение и
    // перерегистрация роняют обе стороны, и «взять только вторую» — это взять
    // половину неизвестно чего.
    if (dRx < 0 || dTx < 0) continue;
    rx += dRx;
    tx += dTx;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/** Килобиты в секунду: так это поле рисует карточка (`/1000` → «Mb/s»). */
function kbps(bytes: number, seconds: number): number | null {
  return toInt((bytes * 8) / 1000 / seconds);
}

/**
 * Разобрать вывод `COLLECT_METRICS_COMMAND` в тело запроса. Чистая функция: ей
 * нужен только текст, поэтому весь разбор чужого вывода проверяется без SSH.
 *
 * `null` — это «снимка нет», и отправлять на бэкенд в таком случае НЕЧЕГО:
 * тело из одних `null` не «ничего не изменит», а сотрёт всё, что там уже
 * накоплено (`apply_metrics`). Отказов два, и оба про одно и то же:
 *
 * 1. **нет `#sdmp:end`** — вывод неполон. Одного «хоть какого-то маркера» тут
 *    мало: канал, оборвавшийся сразу после первой секции, дал бы ровно один
 *    маркер, десять пустых полей и полное затирание колонок. Финальный маркер
 *    печатает сама команда последней строкой, поэтому его наличие — подпись
 *    «дошло до конца», а не догадка о форме вывода;
 * 2. **не разобрано ни одно поле** — маркеры есть, показаний нет (шелл, где
 *    работает `echo` и не работает больше ничего). Сообщать нечего.
 *
 * Во всех прочих случаях поле, которое мы пытались снять и не разобрали, — это
 * `null`, а не 0: «не смогли снять» не должно выглядеть как «0%». Такой `null`
 * ЗАТИРАЕТ колонку намеренно — снимок атомарен, и прошлое число под свежей
 * `metrics_collected_at` выглядело бы правдой.
 */
export function parseServerMetrics(output: string): ServerMetricsIn | null {
  // Только по `\n`: вывод с `\r\n` (машина, где команда прошла через
  // псевдотерминал) разбирается тем же кодом, потому что `\r` — пробельный
  // символ и его снимают `trim` в разборе, `Number` в `num` и `toText` в
  // строковых полях. Отдельного шага под CRLF нет намеренно — он был бы
  // четвёртым местом, где это чинится; требование держит тест «переживает CRLF».
  const sections = splitSections(output.slice(0, MAX_METRICS_OUTPUT).split("\n"));
  if (!sections.has(END_SECTION)) return null;

  const uptimeStart = uptimeAt(sections, 0);
  const uptimeEnd = uptimeAt(sections, 1);
  const elapsed = uptimeStart !== null && uptimeEnd !== null ? uptimeEnd - uptimeStart : null;
  /**
   * Длина паузы в секундах, `null` — «мерить нечем». Три исхода, и все три
   * про то, что делить байты на выдуманное время нельзя:
   *
   * * оба замера аптайма на месте и разошлись хотя бы на `MIN_SAMPLE_SECONDS` —
   *   вот она, фактическая длина;
   * * `/proc/uptime` не отдался вовсе — верим заказанному `sleep 1`, другого
   *   источника у нас нет;
   * * замеры разошлись на сотую долю секунды — значит паузы НЕ БЫЛО (`sleep`
   *   не отработал), и подстановка единицы завысила бы скорость в сотню раз.
   *   Прочерк честнее.
   */
  const sampleSeconds =
    elapsed === null ? FALLBACK_SAMPLE_SECONDS : elapsed >= MIN_SAMPLE_SECONDS ? elapsed : null;

  const cpuBefore = cpuSample(sections, 0);
  const cpuAfter = cpuSample(sections, 1);
  let cpuUsage: number | null = null;
  if (cpuBefore && cpuAfter) {
    const total = cpuAfter.total - cpuBefore.total;
    const idle = cpuAfter.idle - cpuBefore.idle;
    // Ноль тиков за паузу — не «простаивала», а «нечего делить».
    if (total > 0) cpuUsage = Math.min(100, Math.max(0, Math.round(((total - idle) / total) * 100)));
  }

  const netBefore = netSample(sections, 0);
  const netAfter = netSample(sections, 1);
  const net = netBefore && netAfter && sampleSeconds !== null ? netDelta(netBefore, netAfter) : null;

  const mem = new Map<string, number | null>();
  for (const line of sampleLines(sections, "mem")) {
    const [key, ...rest] = line.split(":");
    mem.set(key.trim(), num(rest.join(":").trim().split(/\s+/)[0]));
  }
  const memTotalKb = mem.get("MemTotal") ?? null;
  // `MemAvailable`, а не `MemFree`: свободным ядро считает только неиспользуемое,
  // а отданное под кэш оно вернёт приложению по первому требованию. Разница на
  // живом сервере — десятки процентов, и это то же число, что показывает `free`.
  const memAvailableKb = mem.get("MemAvailable") ?? null;

  let diskTotalKb: number | null = null;
  let diskUsedKb: number | null = null;
  for (const line of sampleLines(sections, "disk")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    // Считаем С КОНЦА: `df -P` гарантирует одну строку на запись, но имя
    // устройства бывает с пробелами, а хвост фиксирован — `blocks used avail
    // capacity mountpoint`. Заголовок отсеется сам: там на этих местах слова.
    const total = num(parts[parts.length - 5]);
    const used = num(parts[parts.length - 4]);
    // Ноль в размере корня — не показание, а совпавшая по форме строка шума.
    if (total === null || used === null || total <= 0) continue;
    diskTotalKb = total;
    diskUsedKb = used;
    // ПЕРВАЯ подходящая строка, а не последняя: спрашивали мы про один маунт,
    // и всё, что за ним, — чужой текст в секции. Перенос длинного имени
    // устройства это не ломает (числа в таком выводе всё равно во второй
    // строке), а строку-шум с пятью числами в хвосте — да.
    break;
  }

  // Не `split("=")`: второй аргумент `split` в JS — предел ДЛИНЫ МАССИВА, а не
  // «делить один раз», как в Python, и `PRETTY_NAME="Foo=Bar"` потерял бы всё
  // после второго `=`. Ключ известен целиком, поэтому просто срезаем его.
  const osLine = sampleLines(sections, "os").find((l) => l.trim().startsWith(OS_PRETTY_KEY));
  const osValue = osLine?.trim().slice(OS_PRETTY_KEY.length).replace(/^["']|["']$/g, "");

  const metrics: ServerMetricsIn = {
    // Второй замер как запасной: он про ту же машину и отличается на длину
    // паузы, а гасить аптайм из-за пустой первой секции — терять поле на
    // пустом месте.
    uptime_seconds: toInt(uptimeStart ?? uptimeEnd),
    cpu_usage_pct: cpuUsage,
    cpu_count: toInt(num(sampleLines(sections, "nproc")[0]?.trim())),
    ram_used_mb:
      memTotalKb !== null && memAvailableKb !== null
        ? toInt(Math.max(0, memTotalKb - memAvailableKb) / 1024)
        : null,
    ram_total_mb: toInt(memTotalKb === null ? null : memTotalKb / 1024),
    // ГиБ, а не ГБ: `df -k` считает блоками по 1024, и раньше продукт показывал
    // ровно это (`df -BG`).
    disk_used_gb: toInt(diskUsedKb === null ? null : diskUsedKb / 1024 / 1024),
    disk_total_gb: toInt(diskTotalKb === null ? null : diskTotalKb / 1024 / 1024),
    net_in_kbps: net && sampleSeconds !== null ? kbps(net.rx, sampleSeconds) : null,
    net_out_kbps: net && sampleSeconds !== null ? kbps(net.tx, sampleSeconds) : null,
    os_pretty: toText(osValue, OS_PRETTY_MAX_LEN),
    kernel: toText(sampleLines(sections, "kernel")[0], KERNEL_MAX_LEN),
  };
  return Object.values(metrics).every((v) => v === null) ? null : metrics;
}
