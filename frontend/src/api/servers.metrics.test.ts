import { describe, it, expect, vi } from "vitest";

import {
  COLLECT_METRICS_COMMAND,
  parseServerMetrics,
  runCollectMetrics,
  type ServerMetricsIn,
} from "./servers";
import { u8ToB64 } from "../lib/b64";
import { setTauri, secretBlobLifecycle, BLOB_USER_ID } from "../test/secretBlobKit";

/**
 * Сбор метрик по SSH. Половина файла — про парсер: он чистая функция, и весь
 * разбор чужого вывода проверяется без всякого SSH. Вторая половина — про то,
 * что до чужой машины мы доходим только из десктопа и только с тем, что там
 * действительно измерили: `null` в теле ЗАТИРАЕТ колонку на бэкенде
 * (`server_service.apply_metrics`), поэтому «не разобрали» и «не собираем» —
 * это два разных исхода, а не один.
 */

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  invokeIfTauri: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  apiPost: mocks.apiPost,
}));

// Мокаем транспорт, а не `secretBlob`/`sshHostKey`: сборка аргументов команд
// (camelCase, id блоба, host/port/user, текст команды) — часть проверяемого пути.
vi.mock("../lib/tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

const SSH_BLOB = "11111111-2222-4333-8444-555555555555";
const SSH_PW = "s3cret-ssh-pw";

const TARGET = {
  id: 7,
  ip_address: "10.0.0.7",
  ssh_port: 2222,
  ssh_user: "deploy",
  ssh_password_blob_id: SSH_BLOB as string | null,
};

/**
 * Вывод настоящей Ubuntu 22.04, снятый нашей же командой. Числа подобраны так,
 * чтобы каждое поле имело ровно один правильный ответ: дельта тиков CPU даёт
 * 20% на нос, а счётчики `lo` двигаются — интерфейс, который мы обязаны
 * выбросить, виден по ответу.
 *
 * Первая строка — SSH-баннер: он приезжает в тот же stdout, и «Welcome to
 * Ubuntu 22.04.4 LTS» обязано остаться за бортом (иначе оно попало бы в
 * `os_pretty` раньше настоящего `PRETTY_NAME`).
 */
const UBUNTU_OUTPUT = [
  "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-91-generic x86_64)",
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

describe("parseServerMetrics — вывод живых машин", () => {
  it("разбирает Ubuntu 22.04 целиком", () => {
    expect(parseServerMetrics(UBUNTU_OUTPUT)).toEqual(UBUNTU_METRICS);
  });

  /**
   * Тот же разбор на выводе с `\r\n`: так отвечает машина, у которой команда
   * прошла через псевдотерминал. Без снятия `\r` числа перестают быть числами,
   * а `PRETTY_NAME` уезжает в колонку с управляющим хвостом — и бэкенд отвергает
   * 422-м ВЕСЬ снимок, а не одно поле.
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
      "#sdmp:nproc",
      "#sdmp:mem",
      "MemTotal:        1010000 kB",
      "#sdmp:disk",
      "Filesystem     1024-blocks    Used Available Capacity Mounted on",
      "overlay           20971520 5242880  15728640      25% /",
      "#sdmp:kernel",
      "6.1.0-18-amd64",
      "#sdmp:os",
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

  it("мусор вместо чисел не превращается в показания", () => {
    const junk = [
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
      "#sdmp:nproc",
      "many",
      "#sdmp:mem",
      "MemTotal:        plenty kB",
      "MemAvailable:    some kB",
      "#sdmp:disk",
      "df: /: Permission denied",
      "#sdmp:kernel",
      "",
      "#sdmp:os",
      "",
    ].join("\n");

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
      kernel: null,
    } satisfies ServerMetricsIn);
  });

  /**
   * Ни одного маркера — значит команда не выполнялась вовсе (нет shell, отказ в
   * доступе, оборванный канал). Это НЕ «сервер намерил одни нули»: отправь мы
   * такой снимок, бэкенд стёр бы `null`-ами все накопленные показания по
   * причине «мы не смогли зайти».
   */
  it.each([
    ["пустой вывод", ""],
    ["ошибка вместо вывода", "bash: /proc/uptime: Permission denied\n"],
    ["чужой баннер", "Welcome to Ubuntu 22.04.4 LTS\nLast login: Wed Aug  6 10:00:00 2026\n"],
  ])("%s — это отказ, а не снимок из нулей", (_name, output) => {
    expect(parseServerMetrics(output)).toBeNull();
  });

  /**
   * Обрыв по потолку пришёлся на середину числа: в выводе `1234` ядер, до
   * потолка доехало `12`. Половина числа — самое опасное, что бывает в чужом
   * выводе: она выглядит показанием и проходит любую проверку диапазона.
   * Поэтому последняя строка обрезанного вывода не разбирается вовсе.
   */
  it("половину числа за потолком не считает показанием", () => {
    const head = "#sdmp:uptime\n120.4\n#sdmp:junk\n";
    const tail = "\n#sdmp:nproc\n";
    // Длина `head + pad + tail` = потолок минус два символа, поэтому в разбор
    // попадают ровно первые две цифры «1234».
    const pad = "x".repeat(64 * 1024 - head.length - tail.length - 2);
    const parsed = parseServerMetrics(`${head}${pad}${tail}1234`);

    expect(parsed?.uptime_seconds).toBe(120);
    expect(parsed?.cpu_count).toBeNull();
  });

  /**
   * Docker-хост с сотнями veth: `/proc/net/dev` снимается дважды, и вывод
   * распухает. Дочитываем до потолка, остальное отбрасываем.
   */
  it("не читает чужой вывод без края", () => {
    const veth = Array.from(
      { length: 1500 },
      (_, i) => `  veth${i}: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0`,
    ).join("\n");
    const bloated = UBUNTU_OUTPUT.replace("#sdmp:nproc", `${veth}\n#sdmp:nproc`);
    expect(bloated.length).toBeGreaterThan(64 * 1024);

    const parsed = parseServerMetrics(bloated);
    // Секции до обрыва разобраны как обычно.
    expect(parsed?.uptime_seconds).toBe(1234568);
    expect(parsed?.cpu_usage_pct).toBe(20);
    // Всё, что осталось за потолком, — прочерки, а не выдуманные числа.
    expect(parsed?.cpu_count).toBeNull();
    expect(parsed?.ram_total_mb).toBeNull();
    expect(parsed?.disk_total_gb).toBeNull();
    expect(parsed?.kernel).toBeNull();
    expect(parsed?.os_pretty).toBeNull();
  });

  /**
   * Строковые поля едут в колонки с ограниченной шириной, и бэкенд отвергает
   * такое значение вместе со ВСЕМ телом. Обрезаем и чистим здесь, чтобы болтливый
   * `PRETTY_NAME` не стоил нам девяти нормально снятых чисел.
   */
  it("подрезает и чистит строки под колонки бэкенда", () => {
    const long = UBUNTU_OUTPUT.replace(
      'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      `PRETTY_NAME="${"A".repeat(400)}"`,
    )
      // Точечно по секции: та же строка есть и в SSH-баннере, который парсер
      // обязан игнорировать.
      .replace("#sdmp:kernel\n5.15.0-91-generic", "#sdmp:kernel\n6.8.0-custom");
    const parsed = parseServerMetrics(long);
    expect(parsed?.os_pretty).toBe("A".repeat(255));
    expect(parsed?.kernel).toBe("6.8.0-custom");
  });

  /**
   * `df` переносит длинное имя устройства на свою строку — числа тогда лежат в
   * СЛЕДУЮЩЕЙ, и в ней на два поля меньше. Считаем с конца: хвост
   * `blocks used avail capacity mountpoint` фиксирован, а голова — нет.
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
});

describe("COLLECT_METRICS_COMMAND", () => {
  /**
   * Литерал, а НЕ импортированная константа: сверка команды с самой собой —
   * тавтология, при которой `rm -rf /var/log; cat /proc/uptime` проезжает
   * зелёным на живой сервер. Команда — часть контракта («read-only» = ничего не
   * меняет на чужой машине), и записана она здесь ровно один раз.
   */
  it("не делает на чужой машине ничего, кроме чтения", () => {
    expect(COLLECT_METRICS_COMMAND).toBe(
      [
        "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
        "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
        "echo '#sdmp:net'; cat /proc/net/dev 2>/dev/null",
        "sleep 1",
        "echo '#sdmp:uptime'; cat /proc/uptime 2>/dev/null",
        "echo '#sdmp:cpu'; head -n 1 /proc/stat 2>/dev/null",
        "echo '#sdmp:net'; cat /proc/net/dev 2>/dev/null",
        "echo '#sdmp:nproc'; nproc 2>/dev/null",
        "echo '#sdmp:mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
        "echo '#sdmp:disk'; df -kP / 2>/dev/null",
        "echo '#sdmp:kernel'; uname -r 2>/dev/null",
        "echo '#sdmp:os'; grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null",
      ].join("\n"),
    );
  });
});

describe("runCollectMetrics — путь до сервера и обратно", () => {
  secretBlobLifecycle();

  it("расшифровывает блоб, снимает метрики этим паролем и не оставляет его в теле", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
      if (cmd === "ssh_exec") return [0, UBUNTU_OUTPUT];
      throw new Error(`unexpected command ${cmd}`);
    });
    mocks.apiPost.mockResolvedValue({ id: 7 });

    await runCollectMetrics(TARGET);

    // camelCase: с `user_id`/`blob_id` команда падает «invalid args».
    expect(mocks.invokeIfTauri).toHaveBeenCalledWith("vault_decrypt_blob", {
      userId: BLOB_USER_ID,
      blobId: SSH_BLOB,
    });
    const exec = mocks.invokeIfTauri.mock.calls.find((c: unknown[]) => c[0] === "ssh_exec")![1] as any;
    expect(exec.host).toBe("10.0.0.7");
    expect(exec.port).toBe(2222);
    expect(exec.user).toBe("deploy");
    expect(exec.password).toBe(SSH_PW);
    expect(exec.command).toBe(COLLECT_METRICS_COMMAND);

    const [url, body] = mocks.apiPost.mock.calls[0];
    expect(url).toBe("/servers/7/metrics");
    expect(body).toEqual(UBUNTU_METRICS);
    // Пароль живёт ровно до вызова `ssh_exec` и в тело запроса не попадает.
    expect(JSON.stringify(body)).not.toContain(SSH_PW);
  });

  /**
   * `fastpanel_version` мы не измеряем, и КЛЮЧА его в теле быть не должно.
   * Ключ со значением `null` бэкенд понимает как «сотри»
   * (`apply_metrics`/`exclude_unset`) — первый же сбор метрик стёр бы версию
   * панели, которую туда записал установщик.
   */
  it("не шлёт полей, которых не измеряет", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) =>
      cmd === "vault_decrypt_blob"
        ? u8ToB64(new TextEncoder().encode(SSH_PW))
        : [0, UBUNTU_OUTPUT],
    );
    mocks.apiPost.mockResolvedValue({ id: 7 });

    await runCollectMetrics(TARGET);

    const body = mocks.apiPost.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(UBUNTU_METRICS).sort());
    // Каждое из этих имён — либо чужая зона ответственности, либо 422
    // `extra_forbidden` на весь снимок.
    for (const forbidden of [
      "fastpanel_version",
      "fastpanel_port",
      "metrics_collected_at",
      "status",
      "last_check_at",
      "last_check_ok",
      "os",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  /**
   * Команда не выполнилась — на бэкенд не идём вовсе. Пустой снимок затёр бы
   * `null`-ами всё, что там уже накоплено.
   */
  it("не отправляет пустой снимок, если сервер ничего не ответил", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) =>
      cmd === "vault_decrypt_blob"
        ? u8ToB64(new TextEncoder().encode(SSH_PW))
        : [126, "sh: 1: cannot open /proc/uptime: Permission denied"],
    );

    await expect(runCollectMetrics(TARGET)).rejects.toThrow(/exit 126.*Permission denied/s);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  /**
   * Последняя команда снимка — `grep` по `/etc/os-release`, и на системе без
   * `PRETTY_NAME` она честно отдаёт 1. Выбросить из-за этого десять разобранных
   * полей значило бы судить о снимке по коду возврата чужого grep'а.
   */
  it("ненулевой код при разобранном выводе снимку не мешает", async () => {
    setTauri(true);
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) =>
      cmd === "vault_decrypt_blob"
        ? u8ToB64(new TextEncoder().encode(SSH_PW))
        : [1, UBUNTU_OUTPUT.replace('PRETTY_NAME="Ubuntu 22.04.4 LTS"', "")],
    );
    mocks.apiPost.mockResolvedValue({ id: 7 });

    await runCollectMetrics(TARGET);

    const body = mocks.apiPost.mock.calls[0][1] as ServerMetricsIn;
    expect(body.os_pretty).toBeNull();
    expect(body.cpu_usage_pct).toBe(20);
  });

  /**
   * Функция экспортирована, и звать её из веба будет не только кнопка, которой
   * там нет. Запрет должен стоять в САМОЙ функции и объясняться её же словами:
   * без него отказ приезжал бы из `readSecretBlob` («Reading secrets…»), то есть
   * пользователь читал бы про чтение секретов вместо сбора метрик.
   */
  it("в вебе не выполняется вовсе и объясняет это фразой про метрики", async () => {
    setTauri(false);

    await expect(runCollectMetrics(TARGET)).rejects.toThrow(
      "Collecting metrics runs in the SDMP desktop app.",
    );
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  /**
   * Такого сервера кнопка не показывает (`has_ssh` = «блоб есть»), но тип поля
   * nullable, и путь достижим из любого нового места вызова. Внятная фраза
   * здесь — вместо `vault_decrypt_blob(blobId: undefined)` и «invalid args» на
   * экране.
   */
  it("объясняет, что пароль не задан, и никуда не ходит", async () => {
    setTauri(true);

    await expect(
      runCollectMetrics({ ...TARGET, ssh_password_blob_id: null }),
    ).rejects.toThrow(/no SSH password/);
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
