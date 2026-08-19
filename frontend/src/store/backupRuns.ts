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

/** Полезная нагрузка события. Байты приходят ТОЛЬКО у шага `download`. */
export interface BackupProgressPayload {
  domain_id: string;
  step: string;
  done_bytes?: number;
  total_bytes?: number;
}

/** Что сохранено на диске — из ответа команды, и только из него. */
export interface BackupSaved {
  /** Путь, который ВЕРНУЛА команда (не тот, что выбрал человек). */
  path: string;
  fileName: string;
  bytes: number;
  /** Что прошло, но не идеально: код `tar`, неубранный архив на сервере. */
  warnings: string[];
  /** Обновился ли снимок домена. `false` — бэкап удался, а список копий нет. */
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
}

const EMPTY_RUN: BackupRun = { step: null, doneBytes: null, totalBytes: null, outcome: null };

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
  // рядом со словом «Saved» — остаток прошлого кадра, а не состояние.
  saved: (domainId, saved) =>
    set((s) => ({
      runs: { ...s.runs, [String(domainId)]: { ...EMPTY_RUN, outcome: { kind: "saved", saved } } },
    })),

  cancelled: (domainId) =>
    set((s) => ({
      runs: { ...s.runs, [String(domainId)]: { ...EMPTY_RUN, outcome: { kind: "cancelled" } } },
    })),

  failed: (domainId, error) =>
    set((s) => ({
      runs: { ...s.runs, [String(domainId)]: { ...EMPTY_RUN, outcome: { kind: "failed", error } } },
    })),
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
