import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * TOFU host-key: событие про незнакомый ключ приходит ОТДЕЛЬНЫМ каналом, а
 * `ssh_exec` в этот момент уже вернул ошибку. Проверяется здесь ровно стык этих
 * двух каналов — он и есть то место, где «первый в жизни коннект к хосту» либо
 * доводится до конца, либо молча теряется.
 *
 * Роль подписки на событие играет прямой вызов `handleHostKeyPrompt`: подписка
 * — одна строчка `listen(...)`, а решение принимает и публикует именно он.
 */

const mocks = vi.hoisted(() => ({ invokeIfTauri: vi.fn(), confirmAction: vi.fn() }));

vi.mock("./tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

// Мокается ради ОДНОГО теста — «чем спрашивает дефолт». Остальные подсовывают
// свой `confirmHost` и до этого мока не доходят; ровно поэтому мок и нужен:
// пока дефолтную ветку не проверял никто, в ней спокойно жил `window.confirm`,
// который в десктопе не показывает ничего и возвращает `false`.
vi.mock("./confirmDialog", () => ({ confirmAction: mocks.confirmAction }));

import {
  describeHostKey,
  handleHostKeyPrompt,
  resetHostKeyStateForTests,
  sshExecWithHostKeyRetry,
} from "./sshHostKey";

const TARGET = { host: "10.0.0.7", port: 2222, user: "deploy", password: "pw", command: "echo x" };
const PROMPT = { host: "10.0.0.7", port: 2222, fingerprint: "SHA256:abc" };

function execCalls(): unknown[][] {
  return mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "ssh_exec");
}

beforeEach(() => {
  vi.resetAllMocks();
  // Карта решений — модульная (событие глобальное), и без сброса «да»,
  // сказанное в прошлом тесте, засчиталось бы ответом в следующем.
  resetHostKeyStateForTests();
});

afterEach(() => {
  resetHostKeyStateForTests();
});

describe("sshExecWithHostKeyRetry", () => {
  it("после принятия ключа повторяет коннект — и только когда ключ уже сохранён", async () => {
    const order: string[] = [];
    let saved: () => void = () => {};
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_accept_host_key") {
        order.push("save:start");
        await new Promise<void>((r) => (saved = r));
        order.push("save:done");
        return null;
      }
      order.push("exec");
      if (execCalls().length === 1) throw new Error("api: HOST_KEY_UNKNOWN");
      return [0, "ok"];
    });

    const run = sshExecWithHostKeyRetry(TARGET);
    // Событие из Rust прилетает своим каналом; здесь его приносит обработчик.
    await handleHostKeyPromptSoon(() => true);

    // Запись known_hosts ещё идёт — и повтора быть не должно. Утверждение
    // именно в этой точке: повтор, не дожидающийся записи, гоняется с ней и
    // падает тем же HOST_KEY_UNKNOWN («ключ принял, а всё равно не пускает»),
    // но по итоговому порядку это неразличимо — обе ветки резолвятся
    // микротасками и приходят к финишу в одном и том же виде.
    await drainMicrotasks();
    expect(execCalls()).toHaveLength(1);

    saved();
    await expect(run).resolves.toEqual([0, "ok"]);
    expect(order).toEqual(["exec", "save:start", "save:done", "exec"]);
  });

  it("отказ пользователя не делает второй попытки и называет причину", async () => {
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_exec") throw new Error("api: HOST_KEY_UNKNOWN");
      throw new Error(`ssh_accept_host_key звать нельзя: пользователь отказался (${cmd})`);
    });

    const run = sshExecWithHostKeyRetry(TARGET);
    await handleHostKeyPromptSoon(() => false);

    await expect(run).rejects.toThrow(/10\.0\.0\.7:2222 was not trusted/);
    expect(execCalls()).toHaveLength(1);
  });

  it("не засчитывает за ответ решение, принятое до этой попытки", async () => {
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_exec") throw new Error("api: HOST_KEY_UNKNOWN");
      return null;
    });

    // Ключ этого хоста уже принимали раньше (например, при provision). Если
    // сейчас он СНОВА неизвестен — файл known_hosts стёрли или ключ сменился, —
    // то старое «да» не ответ: повтор по нему упал бы тем же HOST_KEY_UNKNOWN,
    // а пользователя ни о чём не спросили.
    await handleHostKeyPrompt(PROMPT, () => true);

    await expect(sshExecWithHostKeyRetry(TARGET, { decisionTimeoutMs: 20 })).rejects.toThrow(
      /was not confirmed/,
    );
    expect(execCalls()).toHaveLength(1);
  });

  /**
   * Второй из двух возможных порядков, и в жизни он ОСНОВНОЙ: событие Rust
   * эмитит перед тем, как вернуть ошибку, поэтому к `catch` решение обычно уже
   * опубликовано и лежит в карте. Здесь этот порядок задан явно: событие и
   * ответ на него проходят целиком, пока первый `ssh_exec` ещё висит.
   */
  it("отвечает и на решение, принятое РАНЬШЕ отказа ssh_exec", async () => {
    let failFirstExec: () => void = () => {};
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_accept_host_key") return null;
      if (execCalls().length === 1) {
        await new Promise<void>((r) => (failFirstExec = r));
        throw new Error("api: HOST_KEY_UNKNOWN");
      }
      return [0, "ok"];
    });

    const run = sshExecWithHostKeyRetry(TARGET, { decisionTimeoutMs: 20 });
    await drainMicrotasks();
    // Вопрос задан и ключ записан — а `ssh_exec` ещё даже не отказал.
    await handleHostKeyPrompt(PROMPT, () => true);

    failFirstExec();
    await expect(run).resolves.toEqual([0, "ok"]);
    // Ровно один повтор: решение потребляется, а не раздаётся снова и снова.
    expect(execCalls()).toHaveLength(2);
  });

  /**
   * Две операции к одному незнакомому хосту (SSH Test и provision) идут
   * параллельно, и Rust эмитит событие на КАЖДУЮ попытку коннекта. Спросить
   * дважды про один и тот же отпечаток — значит показать человеку два
   * одинаковых диалога подряд и дописать в known_hosts две одинаковые строки
   * (`append_known_host` пишет без дедупа).
   */
  it("на повторное событие о том же ключе не спрашивает второй раз", async () => {
    let saveDone: () => void = () => {};
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd !== "ssh_accept_host_key") return [0, "ok"];
      await new Promise<void>((r) => (saveDone = r));
      return null;
    });
    const asked = vi.fn(() => true);

    const first = handleHostKeyPrompt(PROMPT, asked);
    // Второе событие приходит, пока запись первого ещё идёт. Оба вызова — в
    // одном такте, без `await` между ними: дедуп обязан работать именно так,
    // потому что события из Rust приходят одно за другим, не давая JS вдохнуть.
    const second = handleHostKeyPrompt(PROMPT, asked);
    // А вот до записи ключа дело доходит только через микротаски: вопрос
    // асинхронный (нативный диалог), и синхронно `ssh_accept_host_key` не
    // зовётся. Без этой уступки `saveDone` разблокировал бы вызов, которого
    // ещё не было.
    await drainMicrotasks();
    saveDone();

    await expect(first).resolves.toBe("accepted");
    // И второй спрашивающий получает тот же ответ, а не «отказано» и не зависание.
    await expect(second).resolves.toBe("accepted");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(
      mocks.invokeIfTauri.mock.calls.filter((c: unknown[]) => c[0] === "ssh_accept_host_key"),
    ).toHaveLength(1);
  });

  /**
   * Тот путь, которым вопрос ходит в жизни. Нативный диалог отвечает ПРОМИСОМ:
   * `window.confirm` в десктопном webview не показывает ничего и возвращает
   * `false` (см. `confirmDialog.ts`), поэтому пока ответ ждали синхронно,
   * незнакомый ключ нельзя было принять ни разу.
   *
   * Ответ приходит с задержкой — человек читает отпечаток, а не жмёт мгновенно;
   * ожидание при этом обязано пережить `decisionTimeoutMs`, потому что таймаут
   * отмеряет ПРИХОД СОБЫТИЯ, а не время на размышление.
   */
  it("доводит до конца вопрос, на который ответили не сразу и промисом", async () => {
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_accept_host_key") return null;
      if (execCalls().length === 1) throw new Error("api: HOST_KEY_UNKNOWN");
      return [0, "ok"];
    });
    let answer: (trusted: boolean) => void = () => {};
    const asked = vi.fn(() => new Promise<boolean>((r) => (answer = r)));

    const run = sshExecWithHostKeyRetry(TARGET, { decisionTimeoutMs: 20 });
    await handleHostKeyPromptSoon(asked as unknown as () => boolean);

    // Диалог висит дольше таймаута ожидания события — и это не отказ.
    await new Promise((r) => setTimeout(r, 60));
    expect(execCalls()).toHaveLength(1);

    answer(true);
    await expect(run).resolves.toEqual([0, "ok"]);
    expect(execCalls()).toHaveLength(2);
  });

  /**
   * Вопрос может сорваться, а не получить ответ: у плагина нет разрешения, окно
   * закрыли. Мимо ждущего это пройти не должно — иначе он молчит все 15 секунд
   * таймаута и объявляет «не подтверждено», хотя настоящая причина известна
   * прямо сейчас.
   */
  it("сорвавшийся вопрос доносит до ждущего, а не заставляет ждать таймаут", async () => {
    mocks.invokeIfTauri.mockImplementation(async (cmd: string) => {
      if (cmd === "ssh_exec") throw new Error("api: HOST_KEY_UNKNOWN");
      throw new Error(`ssh_accept_host_key звать нельзя: вопрос сорвался (${cmd})`);
    });
    const broken = () => {
      throw new Error("dialog plugin is not allowed");
    };

    const run = sshExecWithHostKeyRetry(TARGET, { decisionTimeoutMs: 5_000 });
    await handleHostKeyPromptSoon(broken);

    // Текст настоящий, а не «was not confirmed»; и приходит он сразу, что
    // доказывает пятисекундный таймаут: дождаться его тест бы не успел.
    await expect(run).rejects.toThrow("dialog plugin is not allowed");
    expect(execCalls()).toHaveLength(1);
  });

  /**
   * Единственный тест про ДЕФОЛТНЫЙ способ спросить — и заведён он потому, что
   * его отсутствие уже стоило нам работающего SSH. Все остальные тесты передают
   * свой `confirmHost`, поэтому подмена дефолта на `window.confirm` не роняла
   * ни одного из них, а в десктопе означала «незнакомый ключ принять нельзя
   * никогда»: WKWebView без JS-панелей в делегате не показывает диалог и отдаёт
   * `false`.
   */
  it("спрашивает через общий confirmAction, а не через window.confirm", async () => {
    mocks.confirmAction.mockResolvedValue(false);
    const windowConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await expect(handleHostKeyPrompt(PROMPT)).resolves.toBe("declined");

    expect(mocks.confirmAction).toHaveBeenCalledWith(describeHostKey(PROMPT));
    expect(windowConfirm).not.toHaveBeenCalled();
    windowConfirm.mockRestore();
  });

  it("ошибку не про ключ хоста отдаёт как есть, без вопросов пользователю", async () => {
    mocks.invokeIfTauri.mockRejectedValue(new Error("api: ssh: connect: connection refused"));

    await expect(sshExecWithHostKeyRetry(TARGET, { decisionTimeoutMs: 20 })).rejects.toThrow(
      "api: ssh: connect: connection refused",
    );
    expect(execCalls()).toHaveLength(1);
  });
});

/**
 * Отдать управление, чтобы первый `ssh_exec` успел отказать, и только потом
 * ответить на вопрос про ключ. Это порядок «сначала ошибка, потом событие» —
 * тот, в котором ответ ждут. Обратный (и в жизни основной) порядок проверяет
 * отдельный тест выше.
 */
async function handleHostKeyPromptSoon(confirmHost: () => boolean): Promise<void> {
  await Promise.resolve();
  void handleHostKeyPrompt(PROMPT, confirmHost);
}

/** Уступить макротаск: всё, что готово было выполниться, выполнилось. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
