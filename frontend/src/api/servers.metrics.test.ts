import { describe, it, expect, vi } from "vitest";

import { runCollectMetrics } from "./servers";
import { u8ToB64 } from "../lib/b64";
import { COLLECT_METRICS_COMMAND, type ServerMetricsIn } from "../lib/serverMetrics";
import { setTauri, secretBlobLifecycle, BLOB_USER_ID } from "../test/secretBlobKit";

/**
 * Путь метрик от чужой машины до бэкенда: блоб → плейнтекст → `ssh_exec` →
 * разбор → POST. Сам разбор проверяется отдельно и без SSH
 * (`lib/serverMetrics.test.ts`); здесь — то, что до сервера мы вообще доходим
 * только из десктопа и отправляем ровно то, что измерили.
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

/** Полный снимок в компактном виде: разбор во всех подробностях — не здесь. */
const OUTPUT = [
  "#sdmp:nproc",
  "2",
  "#sdmp:mem",
  "MemTotal:        2097152 kB",
  "MemAvailable:    1048576 kB",
  "#sdmp:disk",
  "Filesystem     1024-blocks    Used Available Capacity Mounted on",
  "/dev/vda1         10485760 2097152   8388608      20% /",
  "#sdmp:kernel",
  "5.15.0-91-generic",
  "#sdmp:os",
  'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
  "#sdmp:uptime",
  "1000.0 900.0",
  "#sdmp:cpu",
  "cpu  1000 0 0 9000 0 0 0 0",
  "#sdmp:net",
  "  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0",
  "#sdmp:uptime",
  "1001.0 901.0",
  "#sdmp:cpu",
  "cpu  1100 0 0 9900 0 0 0 0",
  "#sdmp:net",
  "  eth0: 2000 2 0 0 0 0 0 0 3000 2 0 0 0 0 0 0",
  "#sdmp:end",
  "",
].join("\n");

const METRICS: ServerMetricsIn = {
  uptime_seconds: 1000,
  cpu_usage_pct: 10,
  cpu_count: 2,
  ram_used_mb: 1024,
  ram_total_mb: 2048,
  disk_used_gb: 2,
  disk_total_gb: 10,
  net_in_kbps: 8,
  net_out_kbps: 8,
  os_pretty: "Ubuntu 22.04.4 LTS",
  kernel: "5.15.0-91-generic",
};

/** Успешный SSH: блоб отдаёт пароль, `ssh_exec` — снимок. */
function sshReturns(output: string, code = 0) {
  mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
    if (cmd === "vault_decrypt_blob") return u8ToB64(new TextEncoder().encode(SSH_PW));
    if (cmd === "ssh_exec") return [code, output];
    throw new Error(`unexpected command ${cmd}`);
  });
  mocks.apiPost.mockResolvedValue({ id: TARGET.id });
}

describe("runCollectMetrics — путь до сервера и обратно", () => {
  secretBlobLifecycle();

  it("расшифровывает блоб, снимает метрики этим паролем и не оставляет его в теле", async () => {
    setTauri(true);
    sshReturns(OUTPUT);

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
    expect(body).toEqual(METRICS);
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
    sshReturns(OUTPUT);

    await runCollectMetrics(TARGET);

    const body = mocks.apiPost.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(METRICS).sort());
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
   * Снимка нет — на бэкенд не идём вовсе. Это не осторожность: тело из одних
   * `null` затёрло бы всё, что там накоплено. Что именно считается «снимка
   * нет», решает `parseServerMetrics`; здесь важно, что при её отказе POST не
   * уходит, а человек читает ответ машины.
   */
  it.each([
    ["ничего не ответил", "sh: 1: cannot open /proc/uptime: Permission denied"],
    ["оборвался на середине", "#sdmp:nproc\n4\n#sdmp:mem\nMemTotal:        4045884 kB\n"],
  ])("не отправляет пустой снимок, если сервер %s", async (_name, output) => {
    setTauri(true);
    sshReturns(output, 126);

    await expect(runCollectMetrics(TARGET)).rejects.toThrow(/exit 126/);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  /**
   * Судим по содержимому, а не по коду возврата: код принадлежит последней
   * команде конвейера и о полноте снимка не говорит ничего. Полный снимок с
   * ненулевым кодом — всё ещё снимок.
   */
  it("ненулевой код при полном выводе снимку не мешает", async () => {
    setTauri(true);
    sshReturns(OUTPUT, 1);

    await runCollectMetrics(TARGET);

    expect(mocks.apiPost.mock.calls[0][1]).toEqual(METRICS);
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

    await expect(runCollectMetrics({ ...TARGET, ssh_password_blob_id: null })).rejects.toThrow(
      /no SSH password/,
    );
    expect(mocks.invokeIfTauri).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
