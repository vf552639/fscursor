import { create } from "zustand";

import { isTauri } from "../lib/runtime";

/**
 * Подробности идущего бэкапа: на каком он шаге, сколько байт довезено и чем всё
 * кончилось.
 *
 * **Почему это отдельный стор, а не поле компонента и не `MutationCache`.**
 * Гейт «один прогон за раз» остаётся в `api/runGate.ts` — это общий механизм
 * продукта, — но подробностей он не хранит и хранить не должен: `MutationCache`
 * отвечает на один вопрос, «идёт ли», и ответ этот булев. Хранить шаг и байты в
 * компоненте нельзя по той же причине, по которой там не живёт сам гейт:
 * скачивание идёт минутами, карточку домена за это время закрывают, а открыв
 * снова, человек обязан увидеть правду — а не чистый экран, на котором ничего
 * не происходит, пока по SSH едет гигабайт.
 *
 * **Почему единственная в приложении подписка на `backup:progress` — здесь.**
 * Событие Tauri получают ВСЕ слушатели окна, поэтому вторая подписка означала
 * бы двойной учёт (тот же довод, что у `ssh:host-key-prompt` в
 * `DesktopWorkspace`). Но там подписка живёт в эффекте страницы, а здесь так
 * нельзя: страница и карточка размонтируются посреди прогона, и эффект унёс бы
 * слушателя вместе с собой — ровно в тот момент, когда события и идут. Значит
 * подписка обязана быть модульной; ставится она лениво, первым же прогоном
 * (`ensureBackupProgressSubscription`), и не снимается никогда — короче времени
 * жизни приложения у неё осмысленного срока нет.
 */

/** Канал событий бэкапа (`BACKUP_PROGRESS_EVENT` в `commands/domain_backup.rs`). */
export const BACKUP_PROGRESS_EVENT = "backup:progress";

/**
 * Словарь шагов — контракт с Rust. Всё, чего здесь нет, молча выбрасывается:
 * так же поступают слушатели `provision:progress` и `fastpanel:progress`, и по
 * той же причине — незнакомый шаг напечатал бы на экране служебную строку,
 * которой человек не поймёт.
 */
export type BackupStep = "connect" | "archive" | "download" | "remote_cleanup" | "facts";

const STEPS: Record<string, BackupStep> = {
  connect: "connect",
  archive: "archive",
  download: "download",
  remote_cleanup: "remote_cleanup",
  facts: "facts",
};

/**
 * Не шаг, а ОГОВОРКА: архив на сервере убрать не вышло, и он остался лежать.
 *
 * Приходит тем же каналом, но шагом прогресса не является — прогон после него
 * продолжается (или кончается), а весть обязана дожить до исхода. Событие здесь
 * — не дубль `warnings`, а единственный канал на пути ОТМЕНЫ и на пути отказа:
 * там команда возвращает `Err`, и `warnings` вместе с результатом не доезжают
 * никуда. Заглушив его, мы печатали бы «Cancelled — no copy was saved» над
 * многогигабайтным тарболлом, оставшимся в `/var/tmp` продакшна.
 */
const STEP_REMOTE_CLEANUP_FAILED = "remote_cleanup_failed";

/** Полезная нагрузка события. Байты приходят ТОЛЬКО у шага `download`. */
export interface BackupProgressPayload {
  domain_id: string;
  step: string;
  done_bytes?: number;
  total_bytes?: number;
  /** Текст оговорки — у `remote_cleanup_failed` там путь и что делать руками. */
  note?: string;
}

/** Что сохранено на диске — из ответа команды, и только из него. */
export interface BackupSaved {
  /** Путь, который ВЕРНУЛА команда (не тот, что выбрал человек). */
  path: string;
  bytes: number;
  /**
   * Сколько дампов баз попало в архив.
   *
   * Печатается на экране, и это не украшение: архив сайта без базы выглядит
   * ровно как архив с базой — те же байты, тот же путь, — а восстановиться из
   * него нельзя. Число берётся из `parts` ответа, где каждая часть названа
   * своим `kind`. Имён баз здесь нет: на вопрос «попали ли» отвечает счётчик, а
   * имена только раздули бы строку.
   */
  databases: number;
  /** Есть ли в архиве часть с файлами сайта. */
  files: boolean;
  /** Что прошло, но не идеально: код `tar`, неубранный архив на сервере. */
  warnings: string[];
  /** Обновился ли снимок домена. `false` — бэкап удался, а снимок старый. */
  factsRefreshed: boolean;
}

/**
 * Чем кончился прогон. Три исхода, а не «успех/ошибка»: отмену рисовать красным
 * — врать (тот же приём, что у `HOST_KEY_UNKNOWN`), а бэкап при ней не
 * состоялся, так что и зелёным её рисовать нечем.
 */
export type BackupOutcome =
  | { kind: "saved"; saved: BackupSaved }
  | { kind: "cancelled" }
  | { kind: "failed"; error: string };

export interface BackupRun {
  /** Текущий шаг; `null` — прогон кончился, шага больше нет. */
  step: BackupStep | null;
  /** Довезено байт. `null` — этот шаг байтов не считает. */
  doneBytes: number | null;
  /**
   * Сколько всего. `null` — знаменателя НЕТ, и полосу рисовать нечем; выдумать
   * его «на глаз» — тот же принцип №6, что зелёный бейдж вместо «не мерили».
   */
  totalBytes: number | null;
  outcome: BackupOutcome | null;
  /**
   * Отмену уже попросили, а прогон ещё идёт.
   *
   * Отдельное поле, а не `pending` мутации отмены: команда `domain_backup_cancel`
   * отвечает мгновенно (она только ставит флаг), а РЕАКЦИЯ на него приходит
   * через десятки секунд — флаг читается на следующем чанке выгрузки или на
   * границе шага. Признак «идёт» от мутации погас бы через миллисекунды, и
   * человек, не увидев никакого отклика, жал бы отмену снова и снова, решив,
   * что она не работает.
   */
  cancelRequested: boolean;
  /**
   * Оговорки, приехавшие событиями по ходу прогона (сегодня одна —
   * неубранный архив на сервере).
   *
   * Переживают исход намеренно: они про то, что осталось ПОСЛЕ прогона, и
   * гасить их вместе с шагом значило бы стереть единственную весть о гигабайте,
   * забытом на чужой машине.
   */
  notes: string[];
}

interface BackupRunsState {
  /** Ключ — id домена строкой: событие приносит его строкой, карточка числом. */
  runs: Record<string, BackupRun>;
  /** Прогон начался: прежний исход по этому домену стирается — он уже не про сейчас. */
  start: (domainId: number | string) => void;
  /** Событие с провода. Исход НЕ выставляет никогда — см. комментарий внутри. */
  progress: (payload: BackupProgressPayload) => void;
  /** Успех — и только по ответу команды. */
  saved: (domainId: number | string, saved: BackupSaved) => void;
  cancelled: (domainId: number | string) => void;
  failed: (domainId: number | string, error: string) => void;
  /** Отмену попросили: прогон ещё идёт, но человек уже нажал. */
  requestCancel: (domainId: number | string) => void;
  /**
   * Попросить не вышло (команда отбилась). Признак снимается, чтобы кнопка
   * снова стала нажимаемой: «Cancelling…», которое ничего не отменило, —
   * такое же враньё, как зелёный бейдж без измерения.
   */
  cancelRequestFailed: (domainId: number | string) => void;
}

const EMPTY_RUN: BackupRun = {
  step: null,
  doneBytes: null,
  totalBytes: null,
  outcome: null,
  cancelRequested: false,
  notes: [],
};

/** Закончить прогон, сохранив всё, что должно пережить исход. */
function finish(
  s: { runs: Record<string, BackupRun> },
  domainId: number | string,
  outcome: BackupOutcome,
): { runs: Record<string, BackupRun> } {
  const key = String(domainId);
  return {
    runs: { ...s.runs, [key]: { ...EMPTY_RUN, notes: s.runs[key]?.notes ?? [], outcome } },
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export const useBackupRunsStore = create<BackupRunsState>((set) => ({
  runs: {},

  start: (domainId) =>
    set((s) => ({ runs: { ...s.runs, [String(domainId)]: { ...EMPTY_RUN } } })),

  progress: (payload) =>
    set((s) => {
      const key = String(payload.domain_id);
      const run = s.runs[key];
      // Прогона нет — событие не наше: строку на экране заводит только запуск,
      // и нарисовать её «по событию» значило бы показать прогон, которого этот
      // экран не начинал и об исходе которого ничего не узнает.
      if (!run) return s;
      // Прогон уже кончился — событие опоздало. Доставка событий асинхронна, и
      // последнее из них вполне может доехать ПОСЛЕ ответа команды; пустив его
      // дальше, мы бы стёрли готовый исход шагом, который давно позади.
      if (run.outcome) return s;
      // Оговорка, а не шаг: шаг и байты она не трогает, зато доживает до
      // исхода. Пустую строку не берём — весть без текста ничего не сообщает.
      if (payload.step === STEP_REMOTE_CLEANUP_FAILED) {
        const note = typeof payload.note === "string" ? payload.note.trim() : "";
        if (!note || run.notes.includes(note)) return s;
        return { runs: { ...s.runs, [key]: { ...run, notes: [...run.notes, note] } } };
      }
      const step = STEPS[payload.step];
      // Незнакомый шаг выбрасываем. Сюда же попадает `facts_failed`: это не шаг
      // прогресса, а новость об исходе, и приезжает она полем `facts_refreshed`
      // ответа команды. Событию верить в этом вопросе нельзя ровно по той же
      // причине, по которой ему нельзя верить в вопросе «сохранено»: команда
      // после него ещё может упасть.
      if (!step) return s;
      const done = step === "download" ? num(payload.done_bytes) : null;
      const total = step === "download" ? num(payload.total_bytes) : null;
      return { runs: { ...s.runs, [key]: { ...run, step, doneBytes: done, totalBytes: total } } };
    }),

  // Все три исхода гасят шаг и байты: прогон кончился, и недорисованная полоса
  // рядом со словом «Saved» — остаток прошлого кадра, а не состояние. Оговорки
  // при этом переносятся: они про то, что ОСТАЛОСЬ после прогона, и на пути
  // отмены событие — их единственный канал.
  saved: (domainId, saved) => set((s) => finish(s, domainId, { kind: "saved", saved })),

  cancelled: (domainId) => set((s) => finish(s, domainId, { kind: "cancelled" })),

  failed: (domainId, error) => set((s) => finish(s, domainId, { kind: "failed", error })),

  requestCancel: (domainId) =>
    set((s) => {
      const key = String(domainId);
      const run = s.runs[key];
      // Отменять нечего: прогона нет или он уже кончился. Признак в этом случае
      // не ставится вовсе — иначе на экране повисло бы «Cancelling…» над
      // законченным прогоном, которое никогда не сменится.
      if (!run || run.outcome) return s;
      return { runs: { ...s.runs, [key]: { ...run, cancelRequested: true } } };
    }),

  cancelRequestFailed: (domainId) =>
    set((s) => {
      const key = String(domainId);
      const run = s.runs[key];
      if (!run) return s;
      return { runs: { ...s.runs, [key]: { ...run, cancelRequested: false } } };
    }),
}));

/** Прогон одного домена — или `null`, если по нему ничего не запускали. */
export function useBackupRun(domainId: number | string): BackupRun | null {
  return useBackupRunsStore((s) => s.runs[String(domainId)] ?? null);
}

/**
 * Подписка на `backup:progress` — ровно одна на всё приложение.
 *
 * Идемпотентна: сколько бы прогонов ни началось, `listen` зовётся один раз.
 * Вторая подписка — не «лишний слушатель», а двойной учёт: событие получают все
 * слушатели окна, и одна и та же цифра прилетела бы в стор дважды.
 *
 * Зовётся из прогона (`api/domainBackups.ts`) ДО `invoke`, и ожидание её
 * результата обязательно: `listen` асинхронен, а первое событие (`connect`)
 * команда шлёт почти сразу — подписавшись после, мы бы его потеряли.
 *
 * Провал подписки прогон не отменяет: бэкап важнее строки о нём. Но следующему
 * прогону даётся новая попытка — иначе одна неудача навсегда оставила бы
 * приложение без прогресса.
 */
let subscription: Promise<void> | null = null;

export function ensureBackupProgressSubscription(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (!subscription) {
    subscription = (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<BackupProgressPayload>(BACKUP_PROGRESS_EVENT, (event) => {
        useBackupRunsStore.getState().progress(event.payload);
      });
    })().catch((e) => {
      console.error("backup progress subscription failed", e);
      subscription = null;
    });
  }
  return subscription;
}
