import { invokeIfTauri } from "./tauri-invoke";

/**
 * TOFU для ключей SSH-хостов: один вопрос пользователю на один незнакомый ключ
 * и один способ довести до конца вызов, оборвавшийся из-за него.
 *
 * Почему это отдельный модуль, а не состояние страницы. `ssh_exec` на
 * незнакомом ключе делает две вещи РАЗНЫМИ каналами: эмитит событие
 * `ssh:host-key-prompt` (в нём отпечаток — без него ключ не принять) и
 * возвращает ошибку `HOST_KEY_UNKNOWN`. Событие глобальное: его получает КАЖДЫЙ
 * слушатель в окне. Заведи страница свою подписку — на первый в жизни коннект к
 * хосту пользователь получил бы два одинаковых `confirm` подряд (второй — от
 * общего слушателя воркспейса), а на «да» в обоих — две записи в known_hosts.
 *
 * Поэтому подписка остаётся ровно одна (её ставит DesktopWorkspace через
 * `listenHostKeyPrompts`), а место вызова, которому есть что повторить,
 * СПРАШИВАЕТ у этого модуля, чем кончился вопрос про его хост. Провижн ничего
 * не спрашивает и повтора не делает намеренно: он идёт минутами и половину уже
 * мог сделать — повторять его молча нельзя.
 *
 * Порядок «событие против ошибки» не гарантирован ничем, поэтому решение
 * ЗАПОМИНАЕТСЯ, а не только раздаётся тем, кто уже ждёт: `window.confirm`
 * блокирует поток, и пока висит диалог, отказ `ssh_exec` до JS не доезжает.
 */

/** Полезная нагрузка события `ssh:host-key-prompt` (`HostKeyPrompt` в Rust). */
export interface HostKeyPrompt {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * Чем кончился вопрос про ключ. `save-failed` отделён от `declined` намеренно:
 * пользователь-то доверился, и новость у него другая — «сохранить не вышло»,
 * а не «вы отказались». Повтор невозможен в обоих случаях: known_hosts не
 * пополнился, и вторая попытка упала бы тем же `HOST_KEY_UNKNOWN`.
 */
export type HostKeyDecision = "accepted" | "declined" | "save-failed";

/** Маркер в тексте ошибки `ssh_exec` (см. `commands/ssh.rs`). */
const HOST_KEY_UNKNOWN = "HOST_KEY_UNKNOWN";

/**
 * Сколько ждать ответа про ключ после отказа `ssh_exec`. Щедро и почти не
 * тикает: пока открыт `window.confirm`, поток заблокирован и таймеры стоят, —
 * то есть это время «событие вообще не пришло», а не «пользователь думает».
 */
const HOST_KEY_DECISION_TIMEOUT_MS = 15_000;

interface Published {
  /**
   * Порядковый номер, а не время: решение засчитывается ответом, только если
   * оно принято ПОСЛЕ начала этой попытки. Часами это не измерить — публикация
   * и старт попытки укладываются в одну миллисекунду, и «своё» решение стало бы
   * неотличимо от прошлогоднего.
   */
  seq: number;
  decided: Promise<HostKeyDecision>;
}

let seq = 0;
const decisions = new Map<string, Published>();
const waiters = new Map<string, Array<(entry: Published) => void>>();

const addr = (host: string, port: number) => `${host}:${port}`;

/** Только для тестов: карта модульная и пережила бы файл (см. `seq`). */
export function resetHostKeyStateForTests(): void {
  seq = 0;
  decisions.clear();
  waiters.clear();
}

function publish(key: string, decided: Promise<HostKeyDecision>): void {
  const entry: Published = { seq: ++seq, decided };
  decisions.set(key, entry);
  const queue = waiters.get(key);
  if (!queue) return;
  waiters.delete(key);
  for (const notify of queue) notify(entry);
}

/**
 * Дождаться решения по этому хосту, принятого после `since`. `null` — не
 * дождались: подписки нет вовсе или событие не пришло.
 *
 * Решение ПОТРЕБЛЯЕТСЯ (убирается из карты): второй `HOST_KEY_UNKNOWN` подряд
 * означает, что сохранение не помогло, и отвечать на него старым «да» —
 * зацикливать повторы вместо того, чтобы показать человеку проблему.
 */
function awaitDecision(key: string, since: number, timeoutMs: number): Promise<HostKeyDecision | null> {
  const ready = decisions.get(key);
  if (ready && ready.seq > since) {
    decisions.delete(key);
    return ready.decided;
  }
  return new Promise<HostKeyDecision | null>((resolve) => {
    const drop = () => {
      const rest = (waiters.get(key) ?? []).filter((w) => w !== onPublished);
      if (rest.length) waiters.set(key, rest);
      else waiters.delete(key);
    };
    const timer = setTimeout(() => {
      drop();
      resolve(null);
    }, timeoutMs);
    const onPublished = (entry: Published) => {
      clearTimeout(timer);
      decisions.delete(key);
      resolve(entry.decided);
    };
    waiters.set(key, [...(waiters.get(key) ?? []), onPublished]);
  });
}

/**
 * Текст вопроса. Отпечаток — единственное, по чему ключ можно сверить с тем,
 * что показывает сам сервер, поэтому он в вопросе, а не в логе.
 */
export function describeHostKey({ host, port, fingerprint }: HostKeyPrompt): string {
  return `Unknown SSH host key for ${host}:${port}\n\n${fingerprint}\n\nTrust this host and save the key?`;
}

// `window.confirm`, а не Modal: вопрос синхронный и блокирующий, его нельзя
// подделать содержимым страницы, и ровно им же подтверждаются `sdmp://`-ссылки
// (см. `defaultConfirm` в deepLink.ts).
const defaultConfirm = (message: string): boolean =>
  typeof window === "undefined" ? false : window.confirm(message);

/**
 * Спросить про ключ и опубликовать ответ. Зовётся из подписки на событие;
 * `confirmHost` подменяется только тестами.
 *
 * Публикуется ПРОМИС, а не значение: пока `ssh_accept_host_key` не дописал
 * known_hosts, повторять коннект нельзя — он гонялся бы с записью и падал бы
 * тем же `HOST_KEY_UNKNOWN`, то есть «ключ принят, а всё равно не пускает».
 */
export function handleHostKeyPrompt(
  prompt: HostKeyPrompt,
  confirmHost: (message: string) => boolean = defaultConfirm,
): Promise<HostKeyDecision> {
  const { host, port, fingerprint } = prompt;
  const decided: Promise<HostKeyDecision> = confirmHost(describeHostKey(prompt))
    ? invokeIfTauri<void>("ssh_accept_host_key", { host, port, fingerprint }).then(
        (): HostKeyDecision => "accepted",
        (): HostKeyDecision => "save-failed",
      )
    : Promise.resolve<HostKeyDecision>("declined");
  publish(addr(host, port), decided);
  return decided;
}

/**
 * Единственная в приложении подписка на `ssh:host-key-prompt`. Ставит её
 * DesktopWorkspace — он смонтирован всегда, а событие приходит и от операций,
 * переживших уход со страницы.
 *
 * `onSaveFailed` — известить, что пользователь доверился, а записать не вышло:
 * без этого следующая попытка снова спросит про тот же ключ без объяснения.
 */
export async function listenHostKeyPrompts(onSaveFailed: () => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<HostKeyPrompt>("ssh:host-key-prompt", (event) => {
    void handleHostKeyPrompt(event.payload).then((decision) => {
      if (decision === "save-failed") onSaveFailed();
    });
  });
}

export interface SshExecArgs {
  host: string;
  port: number;
  user: string;
  /** Плейнтекст. Живёт только в этом объекте и умирает вместе с вызовом. */
  password: string;
  command: string;
}

function refusedMessage(host: string, port: number, decision: HostKeyDecision | null): string {
  const target = `SSH host key for ${host}:${port}`;
  if (decision === "declined") return `${target} was not trusted — nothing was run.`;
  if (decision === "save-failed") return `${target} could not be saved — nothing was run, try again.`;
  return `${target} is unknown and was not confirmed — nothing was run.`;
}

/**
 * `ssh_exec` с доведением до конца первого в жизни коннекта к хосту: на
 * незнакомом ключе дожидается ответа пользователя (его задаёт общая подписка) и
 * повторяет вызов ровно один раз.
 *
 * Один раз, а не «пока не получится»: второй `HOST_KEY_UNKNOWN` подряд означает,
 * что запись known_hosts не помогла, и крутить цикл вокруг живого сервера
 * незачем.
 */
export async function sshExecWithHostKeyRetry(
  args: SshExecArgs,
  opts: { decisionTimeoutMs?: number } = {},
): Promise<[number, string]> {
  // До первого `await`: решение, принятое раньше этой строки, — про чужую
  // попытку (см. `Published.seq`).
  const since = seq;
  try {
    return await invokeIfTauri<[number, string]>("ssh_exec", { ...args });
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes(HOST_KEY_UNKNOWN)) throw e;
    const decision = await awaitDecision(
      addr(args.host, args.port),
      since,
      opts.decisionTimeoutMs ?? HOST_KEY_DECISION_TIMEOUT_MS,
    );
    if (decision !== "accepted") throw new Error(refusedMessage(args.host, args.port, decision));
    return await invokeIfTauri<[number, string]>("ssh_exec", { ...args });
  }
}
