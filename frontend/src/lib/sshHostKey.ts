import { confirmAction } from "./confirmDialog";
import { invokeIfTauri } from "./tauri-invoke";

/**
 * TOFU для ключей SSH-хостов: один вопрос пользователю на один незнакомый
 * отпечаток и один способ довести до конца вызов, оборвавшийся из-за него.
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
 * ЗАПОМИНАЕТСЯ, а не только раздаётся тем, кто уже ждёт: прийти первым может
 * любое из двух.
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
 * Это отказ из-за незнакомого ключа хоста?
 *
 * Экспортировано затем, что маркер отдаёт НЕ только `ssh_exec`: тем же кончается
 * любое открытие сессии (`ssh_connect_session_with_timeout`), а значит и бэкап
 * домена. Знание о самой строке при этом обязано остаться в одном модуле —
 * второй его копией маркер и разъезжается.
 *
 * Повтор вызова этой функцией НЕ подразумевается: `sshExecWithHostKeyRetry`
 * умеет повторить только `ssh_exec` и только потому, что тот идемпотентен и
 * получает все свои аргументы снаружи. Мутация, идущая часами, повторяется
 * человеком, а не молча.
 */
export function isHostKeyUnknown(message: string): boolean {
  return message.includes(HOST_KEY_UNKNOWN);
}

/**
 * Сколько ждать ПРИХОДА СОБЫТИЯ про ключ после отказа `ssh_exec`. Не времени на
 * размышление: `publish` случается в обработчике события — то есть сразу, ещё до
 * ответа человека, — и ожидающий получает промис решения, который тикающим
 * таймером уже не ограничен. Человек думает столько, сколько хочет; истечение
 * этих 15 секунд означает ровно «события не было вовсе» (подписки нет, окно без
 * DesktopWorkspace), и тогда честнее сказать «не подтверждено», чем ждать вечно.
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

/**
 * Заданные и ещё не закрытые вопросы, по `host:port:fingerprint`. Rust эмитит
 * событие на КАЖДУЮ попытку коннекта (`ssh_exec` и сессия провижина — разные
 * попытки), поэтому две операции к одному незнакомому хосту приносят два
 * одинаковых события. Без этой карты человек видел бы два одинаковых диалога
 * подряд, а `append_known_host` дописал бы в known_hosts две одинаковые строки
 * — он пишет без дедупа.
 *
 * Отпечаток — часть ключа намеренно: другой отпечаток того же хоста это уже
 * ДРУГОЙ вопрос (сменился ключ или в канале кто-то третий), и молча отвечать
 * на него прошлым «да» нельзя.
 */
const inFlight = new Map<string, Promise<HostKeyDecision>>();

const addr = (host: string, port: number) => `${host}:${port}`;

/** Только для тестов: карты модульные и пережили бы файл (см. `seq`). */
export function resetHostKeyStateForTests(): void {
  // В прод-бандле пусто: сбрасывать состояние живого приложения этим нельзя.
  if (!import.meta.env.DEV) return;
  seq = 0;
  decisions.clear();
  waiters.clear();
  inFlight.clear();
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

// Нативный диалог, а не Modal: вопрос про ключ нельзя подделать содержимым
// страницы, и ровно им же подтверждаются `sdmp://`-ссылки (см. `defaultConfirm`
// в deepLink.ts). Раньше здесь стоял `window.confirm` — в десктопе он не
// показывает ничего и возвращает `false` (см. `confirmDialog.ts`), поэтому
// незнакомый ключ нельзя было принять НИ РАЗУ: SSH Test падал с «was not
// trusted», не задав вопроса.
const defaultConfirm = confirmAction;

/**
 * Спросить про ключ и опубликовать ответ. Зовётся из подписки на событие;
 * `confirmHost` подменяется только тестами.
 *
 * Публикуется ПРОМИС, а не значение, и по двум причинам сразу. Первая: пока
 * `ssh_accept_host_key` не дописал known_hosts, повторять коннект нельзя — он
 * гонялся бы с записью и падал бы тем же `HOST_KEY_UNKNOWN`, то есть «ключ
 * принят, а всё равно не пускает». Вторая: сам вопрос теперь асинхронный, и
 * значения на момент публикации ещё нет.
 *
 * Всё до первого `await` здесь — синхронное намеренно: и `inFlight.set`, и
 * `publish` обязаны случиться в том же такте, что и приход события. Отложи их
 * за `await` — и два события про один ключ (а Rust эмитит по одному на каждую
 * попытку коннекта) успели бы разойтись мимо дедупа, дав два диалога.
 */
export function handleHostKeyPrompt(
  prompt: HostKeyPrompt,
  confirmHost: (message: string) => boolean | Promise<boolean> = defaultConfirm,
): Promise<HostKeyDecision> {
  const { host, port, fingerprint } = prompt;
  const asked = `${addr(host, port)}:${fingerprint}`;
  let decided = inFlight.get(asked);
  if (!decided) {
    // `.then(() => …)`, а не `Promise.resolve(confirmHost(…))`: во втором виде
    // синхронное исключение из `confirmHost` вылетело бы ДО `inFlight.set` и
    // `publish`, оставив ждущего без ответа до самого таймаута. Здесь оно
    // становится реджектом промиса, который ждущий получит сразу и с настоящим
    // текстом — вопрос сорвался, а не «пользователь отказал».
    decided = Promise.resolve().then(() => confirmHost(describeHostKey(prompt))).then((trusted) =>
      trusted
        ? invokeIfTauri<void>("ssh_accept_host_key", { host, port, fingerprint }).then(
            (): HostKeyDecision => "accepted",
            (): HostKeyDecision => "save-failed",
          )
        : Promise.resolve<HostKeyDecision>("declined"),
    );
    inFlight.set(asked, decided);
    // Держим ровно пока вопрос открыт. Дальше событие про тот же отпечаток —
    // уже новая ситуация: known_hosts либо пополнился (и события не будет
    // вовсе), либо запись не помогла — и об этом надо спросить, а не отвечать
    // за человека прошлым ответом.
    const settled = decided;
    const release = () => {
      if (inFlight.get(asked) === settled) inFlight.delete(asked);
    };
    // Оба исхода, а не `.finally`: сорвавшийся вопрос — это реджект, и
    // `.finally` вернул бы ещё один необработанный промис поверх него.
    void settled.then(release, release);
  }
  // Публикуем на КАЖДОЕ событие, в том числе на дедуплицированное: своей
  // попытки ждёт каждый вызов, и «уже спросили» для него означает ответ, а не
  // тишину до таймаута.
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
    void handleHostKeyPrompt(event.payload).then(
      (decision) => {
        if (decision === "save-failed") onSaveFailed();
      },
      // Вопрос может сорваться (см. `handleHostKeyPrompt`). Ждущий вызов
      // получит этот реджект и покажет его человеку; здесь же он только не
      // должен всплыть необработанным и утопить консоль.
      (e) => console.error("host key prompt failed", e),
    );
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
