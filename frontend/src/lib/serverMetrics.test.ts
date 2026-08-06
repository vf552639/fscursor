import { describe, it, expect } from "vitest";

import { COLLECT_METRICS_COMMAND, parseServerMetrics, type ServerMetricsIn } from "./serverMetrics";

/**
 * Разбор вывода чужой машины. Функция чистая, поэтому весь разбор проверяется
 * без SSH — и главное, что здесь проверяется, это НЕ «числа сошлись», а два
 * разных исхода отказа: `null` в поле ЗАТИРАЕТ колонку на бэкенде
 * (`server_service.apply_metrics`), поэтому «не разобрали одно поле» и «снимка
 * нет вовсе» обязаны кончаться по-разному.
 */

/**
 * Вывод настоящей Ubuntu 22.04, снятый нашей же командой. Числа подобраны так,
 * чтобы у каждого поля был ровно один правильный ответ: дельта тиков CPU даёт
 * 20% на нос, а счётчики `lo` двигаются — интерфейс, который мы обязаны
 * выбросить, виден по ответу.
 *
 * Первая строка — SSH-баннер: он приезжает в тот же stdout, и «Welcome to
 * Ubuntu 22.04.4 LTS» обязано остаться за бортом (иначе оно попало бы в
 * `os_pretty` раньше настоящего `PRETTY_NAME`).
 */
const UBUNTU_OUTPUT = [
  "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-91-generic x86_64)",
  "#sdmp:nproc",
  "4",
  "#sdmp:mem",
  "MemTotal:        4045884 kB",
  "MemAvailable:    2831184 kB",
  "#sdmp:disk",
  "Filesystem     1024-blocks    Used Available Capacity Mounted on",
  "/dev/vda1         41152736 8123456  30934784      21% /",
  "#sdmp:kernel",
  "5.15.0-91-generic",
  "#sdmp:os",
  'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
  "#sdmp:uptime",
  "1234567.89 9876543.21",
  "#sdmp:cpu",
  "cpu  1000000 2000 300000 8000000 50000 0 10000 0 0 0",
  "#sdmp:net",
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo:  100000     900    0    0    0     0          0         0   100000     900    0    0    0     0       0          0",
  "  eth0: 5000000   40000    0    0    0     0          0         0  2000000   30000    0    0    0     0       0          0",
  "#sdmp:uptime",
  "1234568.89 9876544.21",
  "#sdmp:cpu",
  "cpu  1000100 2000 300050 8000800 50050 0 10000 0 0 0",
  "#sdmp:net",
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo:  900000     999    0    0    0     0          0         0   900000     999    0    0    0     0       0          0",
  "  eth0: 5125000   40100    0    0    0     0          0         0  2250000   30100    0    0    0     0       0          0",
  "#sdmp:end",
  "",
].join("\n");

/** Что из `UBUNTU_OUTPUT` обязано получиться — всё разобрано, ни одного `null`. */
const UBUNTU_METRICS: ServerMetricsIn = {
  // 1234567.89 с округлением, и только ПЕРВЫЙ замер: второй существует ради
  // длины паузы, а не ради аптайма.
  uptime_seconds: 1234568,
  // Дельты: занято 200 тиков (100 user + 50 system + 50 iowait), простой 800,
  // всего 1000 → 20%. По одному замеру вышло бы 14% — средняя загрузка с
  // момента загрузки машины. `iowait` двигается намеренно: машина, забившая
  // диск, обязана выглядеть занятой, и запиши мы его в простой — вышло бы 15%.
  cpu_usage_pct: 20,
  cpu_count: 4,
  // MemTotal - MemAvailable = 1214700 кБ. Через MemFree было бы совсем другое
  // число, и оно завышало бы занятую память на весь дисковый кэш.
  ram_used_mb: 1186,
  ram_total_mb: 3951,
  // Блоки по 1024 → ГиБ.
  disk_used_gb: 8,
  disk_total_gb: 39,
  // eth0: 125000 байт за секунду → 1000 кбит/с. Прибавь сюда `lo` (там 800000
  // байт) — получилось бы 7400.
  net_in_kbps: 1000,
  net_out_kbps: 2000,
  os_pretty: "Ubuntu 22.04.4 LTS",
  kernel: "5.15.0-91-generic",
};

/**
 * Второй дистрибутив целиком, а не «то же самое с другими числами»: Debian 12
 * на ARM, `df` с длинным LVM-именем и переносом строки, `PRETTY_NAME` без
 * патч-версии, два сетевых интерфейса вместо одного, `/proc/stat` без хвостовых
 * `guest`-полей. Всё это — форматные отличия, на которых ломается разбор,
 * написанный под один вывод.
 */
const DEBIAN_OUTPUT = [
  "#sdmp:nproc",
  "2",
  "#sdmp:mem",
  "MemTotal:        2028100 kB",
  "MemAvailable:     512000 kB",
  "#sdmp:disk",
  "Filesystem     1024-blocks    Used Available Capacity Mounted on",
  "/dev/mapper/debian--vg-root",
  "                  10485760 3145728   6815744      32% /",
  "#sdmp:kernel",
  "6.1.0-18-arm64",
  "#sdmp:os",
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  "#sdmp:uptime",
  "7200.5 14000.25",
  "#sdmp:cpu",
  "cpu  200000 100 50000 700000 2000 0 900 0",
  "#sdmp:net",
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo:   50000     100    0    0    0     0          0         0    50000     100    0    0    0     0       0          0",
  "  ens3: 1000000    8000    0    0    0     0          0         0   500000    4000    0    0    0     0       0          0",
  "docker0:  20000     200    0    0    0     0          0         0    10000     100    0    0    0     0       0          0",
  "#sdmp:uptime",
  "7202.5 14004.25",
  "#sdmp:cpu",
  "cpu  203000 100 51000 703500 2500 0 900 0",
  "#sdmp:net",
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo:   90000     150    0    0    0     0          0         0    90000     150    0    0    0     0       0          0",
  "  ens3: 1200000    8500    0    0    0     0          0         0   560000    4300    0    0    0     0       0          0",
  "docker0:  70000     400    0    0    0     0          0         0    30000     200    0    0    0     0       0          0",
  "#sdmp:end",
  "",
].join("\n");

describe("parseServerMetrics — вывод живых машин", () => {
  it("разбирает Ubuntu 22.04 целиком", () => {
    expect(parseServerMetrics(UBUNTU_OUTPUT)).toEqual(UBUNTU_METRICS);
  });

  it("разбирает Debian 12 целиком", () => {
    expect(parseServerMetrics(DEBIAN_OUTPUT)).toEqual({
      uptime_seconds: 7201,
      // Дельты: занято 3000+1000+500 = 4500, простой 3500, всего 8000 → 56%.
      cpu_usage_pct: 56,
      cpu_count: 2,
      ram_used_mb: 1481,
      ram_total_mb: 1981,
      disk_used_gb: 3,
      disk_total_gb: 10,
      // Пауза 2 с, `lo` не в счёт: (200000 + 50000) байт входящих на два
      // интерфейса за 2 с → 1000 кбит/с; исходящих (60000 + 20000) → 320.
      net_in_kbps: 1000,
      net_out_kbps: 320,
      os_pretty: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0-18-arm64",
    } satisfies ServerMetricsIn);
  });

  /**
   * Тот же разбор на выводе с `\r\n`: так отвечает машина, у которой команда
   * прошла через псевдотерминал. Не снимай мы `\r`, числа перестали бы быть
   * числами, а `PRETTY_NAME` уехал бы в колонку с управляющим хвостом — и
   * бэкенд отверг бы 422-м ВЕСЬ снимок, а не одно поле.
   */
  it("переживает CRLF", () => {
    expect(parseServerMetrics(UBUNTU_OUTPUT.replace(/\n/g, "\r\n"))).toEqual(UBUNTU_METRICS);
  });

  /**
   * Debian в контейнере: `/proc/net/dev` не отдан, `nproc` не установлен,
   * `/etc/os-release` без `PRETTY_NAME`. Ровно то, ради чего в команде стоит
   * `2>/dev/null` на каждом источнике: пропавшая секция гасит СВОИ поля и не
   * трогает соседние.
   */
  it("на обрезанном выводе гасит только свои поля", () => {
    const output = [
      "#sdmp:nproc",
      "#sdmp:mem",
      "MemTotal:        1010000 kB",
      "#sdmp:disk",
      "Filesystem     1024-blocks    Used Available Capacity Mounted on",
      "overlay           20971520 5242880  15728640      25% /",
      "#sdmp:kernel",
      "6.1.0-18-amd64",
      "#sdmp:os",
      "#sdmp:uptime",
      "864000.12 3400000.00",
      "#sdmp:cpu",
      "cpu  500 10 200 9000 40 0 5 0",
      "#sdmp:net",
      "#sdmp:uptime",
      "864002.12 3400002.00",
      "#sdmp:cpu",
      "cpu  600 10 300 9800 40 0 5 0",
      "#sdmp:net",
      "#sdmp:end",
      "",
    ].join("\n");

    expect(parseServerMetrics(output)).toEqual({
      uptime_seconds: 864000,
      // занято 200 из 1000 тиков
      cpu_usage_pct: 20,
      cpu_count: null,
      // MemTotal есть, MemAvailable нет: занятую память посчитать НЕ ИЗ ЧЕГО.
      // Ноль здесь означал бы «памяти не занято» — то есть ложь под свежей
      // отметкой времени.
      ram_used_mb: null,
      ram_total_mb: 986,
      disk_used_gb: 5,
      disk_total_gb: 20,
      net_in_kbps: null,
      net_out_kbps: null,
      os_pretty: null,
      kernel: "6.1.0-18-amd64",
    } satisfies ServerMetricsIn);
  });

  /**
   * Аптайм из второго замера, когда первый не отдался. Поле про машину, а не
   * про момент: разница между замерами — секунда, и гасить из-за неё колонку
   * значит терять показание на пустом месте.
   */
  it("берёт аптайм из второго замера, если первого нет", () => {
    const parsed = parseServerMetrics(UBUNTU_OUTPUT.replace("1234567.89 9876543.21\n", ""));
    expect(parsed?.uptime_seconds).toBe(1234569);
    // Длины паузы теперь нет — верим заказанному `sleep 1`.
    expect(parsed?.net_in_kbps).toBe(1000);
  });

  /**
   * Пауза оказалась вдвое длиннее заказанной (нагруженная машина, `sleep 1`
   * вернулся через 2 с). Длину паузы даёт разность двух `/proc/uptime`, а не
   * константа: иначе трафик был бы завышен ровно вдвое.
   */
  it("делит трафик на фактическую длину паузы, а не на единицу", () => {
    const slow = UBUNTU_OUTPUT.replace("1234568.89 9876544.21", "1234569.89 9876545.21");
    const parsed = parseServerMetrics(slow);
    expect(parsed?.net_in_kbps).toBe(500);
    expect(parsed?.net_out_kbps).toBe(1000);
    // Проценты CPU — отношение дельт, длина паузы на них не влияет.
    expect(parsed?.cpu_usage_pct).toBe(20);
  });

  /**
   * `sleep` не отработал, и замеры пошли подряд: разность аптаймов — сотая доля
   * секунды. Делить на неё нельзя (трафик вырос бы в сто раз), подставлять
   * секунду тоже (её не было) — остаётся прочерк. Всё остальное в снимке при
   * этом на месте: паузы нет только у скорости.
   */
  it("паузы не было — скорость сети не выдумывается", () => {
    const noPause = UBUNTU_OUTPUT.replace("1234568.89 9876544.21", "1234567.90 9876543.22");
    const parsed = parseServerMetrics(noPause);
    expect(parsed?.net_in_kbps).toBeNull();
    expect(parsed?.net_out_kbps).toBeNull();
    expect(parsed?.cpu_usage_pct).toBe(20);
    expect(parsed?.uptime_seconds).toBe(1234568);
  });

  it("простаивающая машина — это 0%, а не «не смогли снять»", () => {
    const idle = UBUNTU_OUTPUT.replace(
      "cpu  1000100 2000 300050 8000800 50050 0 10000 0 0 0",
      "cpu  1000000 2000 300000 8001000 50000 0 10000 0 0 0",
    );
    expect(parseServerMetrics(idle)?.cpu_usage_pct).toBe(0);
  });

  /**
   * Между замерами не набежало ни одного тика (виртуалка с грубым таймером).
   * Делить не на что, и `0%` тут был бы выдумкой.
   */
  it("нулевая дельта тиков — это null, а не 0%", () => {
    const frozen = UBUNTU_OUTPUT.replace(
      "cpu  1000100 2000 300050 8000800 50050 0 10000 0 0 0",
      "cpu  1000000 2000 300000 8000000 50000 0 10000 0 0 0",
    );
    expect(parseServerMetrics(frozen)?.cpu_usage_pct).toBeNull();
  });

  it("мусор вместо чисел не превращается в показания, но снимком остаётся", () => {
    const junk = [
      "#sdmp:nproc",
      "many",
      "#sdmp:mem",
      "MemTotal:        plenty kB",
      "MemAvailable:    some kB",
      "#sdmp:disk",
      "df: /: Permission denied",
      "#sdmp:kernel",
      "6.5.0-generic",
      "#sdmp:os",
      "",
      "#sdmp:uptime",
      "up 3 days, 4:12",
      "#sdmp:cpu",
      "cpu  n/a n/a n/a n/a",
      "#sdmp:net",
      "  eth0: -- -- -- -- -- -- -- -- --",
      "#sdmp:uptime",
      "up 3 days, 4:12",
      "#sdmp:cpu",
      "cpu  n/a n/a n/a n/a",
      "#sdmp:net",
      "  eth0: -- -- -- -- -- -- -- -- --",
      "#sdmp:end",
      "",
    ].join("\n");

    // Ядро разобралось — снимок есть, и остальные поля честно гасятся.
    expect(parseServerMetrics(junk)).toEqual({
      uptime_seconds: null,
      cpu_usage_pct: null,
      cpu_count: null,
      ram_used_mb: null,
      ram_total_mb: null,
      disk_used_gb: null,
      disk_total_gb: null,
      net_in_kbps: null,
      net_out_kbps: null,
      os_pretty: null,
      kernel: "6.5.0-generic",
    } satisfies ServerMetricsIn);
  });

  /**
   * Числа сверх ширины колонки — не «большие показания», а промах разбора по
   * чужой строке. Отдать их бэкенду значит получить 422 на ВЕСЬ снимок, а
   * подрезать до максимума — записать в колонку выдумку.
   */
  it("значение сверх ширины колонки — прочерк, а не подрезанное число", () => {
    const absurd = UBUNTU_OUTPUT.replace("MemTotal:        4045884 kB", "MemTotal:        999999999999999 kB")
      .replace("1234567.89 9876543.21", "99999999999.5 9876543.21");
    const parsed = parseServerMetrics(absurd);
    expect(parsed?.ram_total_mb).toBeNull();
    expect(parsed?.uptime_seconds).toBeNull();
    // Соседние поля не задеты: гаснет промах, а не снимок.
    expect(parsed?.cpu_count).toBe(4);
  });

  /**
   * `PRETTY_NAME` со знаком `=` внутри значения. Разбор через `split("=", 2)`
   * прочитал бы «Foo» и выбросил хвост: второй аргумент `split` в JS — это
   * предел ДЛИНЫ МАССИВА, а не «делить один раз», как в Python.
   */
  it("не теряет часть PRETTY_NAME после второго знака равенства", () => {
    const weird = UBUNTU_OUTPUT.replace(
      'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      'PRETTY_NAME="Foo=Bar Linux 1.0"',
    );
    expect(parseServerMetrics(weird)?.os_pretty).toBe("Foo=Bar Linux 1.0");
  });

  /**
   * Строковые поля едут в колонки с ограниченной шириной, и бэкенд отвергает
   * слишком длинное значение вместе со ВСЕМ телом. Подрезаем здесь, чтобы
   * болтливый `PRETTY_NAME` не стоил нам десяти нормально снятых чисел.
   */
  it("подрезает строки под ширину колонки", () => {
    const long = UBUNTU_OUTPUT.replace(
      'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      `PRETTY_NAME="${"A".repeat(400)}"`,
    );
    expect(parseServerMetrics(long)?.os_pretty).toBe("A".repeat(255));
  });

  /**
   * Подрезаем по СИМВОЛАМ: `slice` резал бы по единицам UTF-16 и оставил бы на
   * конце половину суррогатной пары. Такая строка уезжает в JSON, и на той
   * стороне это уже не внятный 422, а 500 из драйвера — то есть потеря всего
   * снимка вместо одного поля.
   */
  it("подрезает по символам, а не по половинкам суррогатных пар", () => {
    const emoji = UBUNTU_OUTPUT.replace(
      'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      `PRETTY_NAME="${"\u{1F680}".repeat(300)}"`,
    );
    const parsed = parseServerMetrics(emoji);
    expect([...(parsed?.os_pretty ?? "")]).toHaveLength(255);
    // Ни одной одинокой половины пары: `\uD800`-`\uDFFF` вне пары — это то, на
    // чём ломается кодирование в UTF-8 на той стороне.
    expect(parsed?.os_pretty).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  /**
   * Управляющие символы бэкенд отвергает так же, как перебор длины, — и так же
   * вместе со всем телом. Приезжают они запросто: `\r` от псевдотерминала,
   * escape-последовательности от цветного вывода.
   */
  it("вычищает управляющие символы из строковых полей", () => {
    const dirty = UBUNTU_OUTPUT.replace(
      'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      'PRETTY_NAME="Ubuntu\u001b[0m 22.04.4 LTS"',
    ).replace("#sdmp:kernel\n5.15.0-91-generic", "#sdmp:kernel\n5.15.0\u0007-91-generic");
    const parsed = parseServerMetrics(dirty);
    expect(parsed?.os_pretty).toBe("Ubuntu[0m 22.04.4 LTS");
    expect(parsed?.kernel).toBe("5.15.0-91-generic");
  });

  /**
   * `df` переносит длинное имя устройства на свою строку — числа тогда лежат в
   * СЛЕДУЮЩЕЙ, и в ней на два поля меньше. Разбор считает с конца: хвост
   * `blocks used avail capacity mountpoint` фиксирован, а голова — нет. (Тот же
   * случай проверяет и полный разбор Debian.)
   */
  it("читает df с перенесённой строкой устройства", () => {
    const wrapped = UBUNTU_OUTPUT.replace(
      "/dev/vda1         41152736 8123456  30934784      21% /",
      "/dev/mapper/very--long--vg-root\n                  41152736 8123456  30934784      21% /",
    );
    const parsed = parseServerMetrics(wrapped);
    expect(parsed?.disk_total_gb).toBe(39);
    expect(parsed?.disk_used_gb).toBe(8);
  });

  /**
   * В секции диска побеждает ПЕРВАЯ разобранная строка, а нулевой размер не
   * разбирается вовсе. Спрашивали мы про один маунт, и лишняя строка в секции —
   * это шум; возьми разбор последнюю, `tmpfs` с нулём въехал бы в колонку как
   * «диск 0 ГБ» — ровно то, против чего построен весь дизайн отказов.
   */
  it.each([
    // Нулевой размер не разбирается вовсе: «диск 0 ГБ» — это не показание.
    ["нулевой размер перед настоящей", "tmpfs                    0       0         0       0% /run/user/0\n{row}"],
    // А это — чужой маунт после нашего: так выглядела бы секция, если бы `df`
    // однажды позвали без аргумента. Побеждает ПЕРВАЯ строка, то есть та, про
    // которую спрашивали, а не последняя в списке.
    ["чужой маунт после настоящей", "{row}\ndevtmpfs           1957764       0   1957764       0% /dev"],
  ])("строка-шум в df (%s) не становится показанием", (_name, template) => {
    const row = "/dev/vda1         41152736 8123456  30934784      21% /";
    const noisy = UBUNTU_OUTPUT.replace(row, template.replace("{row}", row));
    const parsed = parseServerMetrics(noisy);
    expect(parsed?.disk_total_gb).toBe(39);
    expect(parsed?.disk_used_gb).toBe(8);
  });
});

/**
 * Трафик считается ПО ИНТЕРФЕЙСАМ. Набор устройств между двумя замерами
 * меняется, и разность двух сумм в каждом таком случае врёт по-своему — здесь
 * проверяется, что не врёт.
 */
describe("parseServerMetrics — набор интерфейсов между замерами", () => {
  /** Строка `/proc/net/dev`: 8 колонок приёма, 8 передачи. */
  const netLine = (iface: string, rx: number, tx: number) =>
    `  ${iface}: ${rx} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`;

  const ETH0_BEFORE =
    "  eth0: 5000000   40000    0    0    0     0          0         0  2000000   30000    0    0    0     0       0          0";
  const ETH0_AFTER =
    "  eth0: 5125000   40100    0    0    0     0          0         0  2250000   30100    0    0    0     0       0          0";

  /** Добавить интерфейс в первый / второй замер снимка Ubuntu. */
  const addBefore = (line: string) => UBUNTU_OUTPUT.replace(ETH0_BEFORE, `${ETH0_BEFORE}\n${line}`);
  const addAfter = (line: string) => UBUNTU_OUTPUT.replace(ETH0_AFTER, `${ETH0_AFTER}\n${line}`);

  /**
   * Контейнер остановился, и его `veth` исчез между замерами. По сумме это
   * ОТРИЦАТЕЛЬНАЯ дельта, то есть прочерк в обеих метриках, — хотя по `eth0`
   * всё это время всё прекрасно считалось.
   */
  it("исчезнувший интерфейс не гасит показания остальных", () => {
    const parsed = parseServerMetrics(addBefore(netLine("veth9a1", 1_000_000, 1_000_000)));
    expect(parsed?.net_in_kbps).toBe(1000);
    expect(parsed?.net_out_kbps).toBe(2000);
  });

  /**
   * Интерфейс поднялся между замерами (или въехал в окно `head -n 64`, когда
   * список устройств переставился). Его ПОЖИЗНЕННЫЙ счётчик по сумме целиком
   * уходит в дельту: на тихой машине это рисует гигабиты в секунду, причём в
   * допустимом для колонки диапазоне — то есть на карточке выглядит правдой.
   */
  it("появившийся интерфейс не приносит свой пожизненный счётчик", () => {
    const parsed = parseServerMetrics(addAfter(netLine("veth9a1", 1_000_000_000, 1_000_000_000)));
    expect(parsed?.net_in_kbps).toBe(1000);
    expect(parsed?.net_out_kbps).toBe(2000);
  });

  /**
   * 32-битный счётчик переполнился на одном интерфейсе. Терять при этом
   * положено его одного, а не всю метрику: по сумме отрицательная дельта гасит
   * и то, что честно посчиталось по соседнему устройству.
   */
  it("переполнение счётчика теряет один интерфейс, а не метрику", () => {
    const overflowed = addBefore(netLine("ens4", 4_294_000_000, 4_294_000_000))
      .replace(ETH0_AFTER, `${ETH0_AFTER}\n${netLine("ens4", 100, 200)}`);
    const parsed = parseServerMetrics(overflowed);
    expect(parsed?.net_in_kbps).toBe(1000);
    expect(parsed?.net_out_kbps).toBe(2000);
  });

  /** Совсем нечего сравнить — прочерк, а не ноль. */
  it("ни одного общего интерфейса — прочерк", () => {
    const swapped = UBUNTU_OUTPUT.replace(ETH0_AFTER, netLine("ens5", 9_000_000, 9_000_000));
    const parsed = parseServerMetrics(swapped);
    expect(parsed?.net_in_kbps).toBeNull();
    expect(parsed?.net_out_kbps).toBeNull();
  });
});

/**
 * Отказы. Снимка нет — значит на бэкенд идти НЕЛЬЗЯ: тело из одних `null` не
 * «ничего не меняет», а стирает всё, что там накоплено (`apply_metrics`).
 */
describe("parseServerMetrics — когда снимка нет вовсе", () => {
  it.each([
    ["пустой вывод", ""],
    ["ошибка вместо вывода", "bash: /proc/uptime: Permission denied\n"],
    ["чужой баннер", "Welcome to Ubuntu 22.04.4 LTS\nLast login: Wed Aug  6 10:00:00 2026\n"],
  ])("%s — это отказ, а не снимок из нулей", (_name, output) => {
    expect(parseServerMetrics(output)).toBeNull();
  });

  /**
   * Канал оборвался посреди вывода. Маркеры в тексте ЕСТЬ — «хоть один маркер»
   * такой обрывок от снимка не отличает, а разница принципиальная: без
   * финального маркера мы не знаем, чего ещё не доехало, и десять пустых полей
   * затёрли бы десять живых колонок.
   */
  it.each([
    ["сразу после первого маркера", "#sdmp:nproc\n"],
    ["на середине потока", "#sdmp:nproc\n4\n#sdmp:mem\nMemTotal:        4045884 kB\n"],
    ["перед самым концом", UBUNTU_OUTPUT.replace("#sdmp:end\n", "")],
  ])("оборванный вывод %s — отказ", (_name, output) => {
    expect(parseServerMetrics(output)).toBeNull();
  });

  /**
   * Шелл, где работает `echo` и не работает больше ничего: маркеры на месте,
   * включая финальный, а показаний нет ни одного. Сообщать нечего — и уж точно
   * нечем затирать колонки.
   */
  it("все секции пусты — отказ, а не снимок из одиннадцати null", () => {
    const empty = [
      "#sdmp:nproc",
      "#sdmp:mem",
      "#sdmp:disk",
      "#sdmp:kernel",
      "#sdmp:os",
      "#sdmp:uptime",
      "#sdmp:cpu",
      "#sdmp:net",
      "#sdmp:uptime",
      "#sdmp:cpu",
      "#sdmp:net",
      "#sdmp:end",
      "",
    ].join("\n");
    expect(parseServerMetrics(empty)).toBeNull();
  });

  /**
   * Вывод длиннее потолка разбора. Финальный маркер остаётся за ним, то есть
   * это отказ — и это лучшее, что можно сделать: разобранная «голова» такого
   * вывода поехала бы на бэкенд снимком, где всё за потолком — явные `null`,
   * то есть затирание живых колонок при каждом сборе.
   */
  it("вывод сверх потолка — отказ, а не половина снимка", () => {
    const junk = Array.from({ length: 5000 }, (_, i) => `  veth${i}: ${i} 1 0 0 0 0 0 0 ${i} 1`).join("\n");
    const bloated = UBUNTU_OUTPUT.replace("#sdmp:end", `${junk}\n#sdmp:end`);
    expect(bloated.length).toBeGreaterThan(64 * 1024);
    expect(parseServerMetrics(bloated)).toBeNull();
  });
});

describe("COLLECT_METRICS_COMMAND", () => {
  /** Команды по отдельности: каждая строка может содержать `echo ...; <источник>`. */
  const segments = COLLECT_METRICS_COMMAND.split("\n").flatMap((line) =>
    line.split(";").map((s) => s.trim()).filter(Boolean),
  );

  /**
   * Проверка СВОЙСТВА, а не сверка с копией: «read-only» — это утверждение о
   * том, чего в команде нет, и его надо проверять по всей строке, а не глазами
   * при следующей правке. Список разрешённых утилит закрытый: любая новая
   * команда обязана пройти через этот тест, а не приехать вместе с правкой.
   */
  it("состоит только из читающих утилит", () => {
    const allowed = new Set(["echo", "cat", "head", "grep", "df", "uname", "nproc", "sleep"]);
    for (const segment of segments) {
      expect(allowed).toContain(segment.split(/\s+/)[0]);
    }
  });

  it("не пишет ничего никуда, кроме /dev/null", () => {
    // Единственное перенаправление в команде — глушитель stderr. Всё прочее
    // (`>`, `>>`, `|` в файл) на чужой машине означало бы запись.
    expect(COLLECT_METRICS_COMMAND.replace(/2>\/dev\/null/g, "")).not.toMatch(/[<>]/);
    // Подстановки и цепочки: через них ехало бы что угодно, и `2>/dev/null`
    // это уже не прикрыло бы.
    expect(COLLECT_METRICS_COMMAND).not.toMatch(/\$\(|`|&&|\|\|/);
    expect(COLLECT_METRICS_COMMAND).not.toMatch(
      /\b(rm|mv|cp|tee|dd|chmod|chown|install|truncate|mkfs|kill|reboot|apt|yum|systemctl)\b/,
    );
  });

  /**
   * Литерал, а НЕ импортированная константа. Свойства выше ловят класс правок
   * («стало писать»), а эта сверка — конкретный контракт: набор секций, их
   * порядок (при неполном выводе первыми выживают статические поля) и
   * `sleep 1`, вокруг которого обязаны стоять оба замера. Команда записана
   * здесь ровно один раз.
   */
  it("снимает ровно те секции, ровно в том порядке", () => {
    expect(COLLECT_METRICS_COMMAND).toBe(
      [
        "echo '#sdmp:nproc'; nproc 2>/dev/null",
        "echo '#sdmp:mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
        "echo '#sdmp:disk'; df -kP / 2>/dev/null",
        "echo '#sdmp:kernel'; uname -r 2>/dev/null",
        "echo '#sdmp:os'; grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null",
        "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
        "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
        "echo '#sdmp:net'; head -n 64 /proc/net/dev 2>/dev/null",
        "sleep 1",
        "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
        "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
        "echo '#sdmp:net'; head -n 64 /proc/net/dev 2>/dev/null",
        "echo '#sdmp:end'",
      ].join("\n"),
    );
  });
});
