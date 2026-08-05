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

const mocks = vi.hoisted(() => ({ invokeIfTauri: vi.fn() }));

vi.mock("./tauri-invoke", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  invokeIfTauri: mocks.invokeIfTauri,
}));

import {
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
 * ответить на вопрос про ключ. Порядок «сначала событие, потом ошибка» тоже
 * рабочий (`window.confirm` блокирует поток) — он покрыт тем, что решение
 * запоминается, а не только раздаётся ждущим.
 */
async function handleHostKeyPromptSoon(confirmHost: () => boolean): Promise<void> {
  await Promise.resolve();
  void handleHostKeyPrompt(PROMPT, confirmHost);
}

/** Уступить макротаск: всё, что готово было выполниться, выполнилось. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
