import React from "react";

import { formatBytes } from "../../../lib/format";
import { useBackupRun, type BackupStep } from "../../../store/backupRuns";

/**
 * Строка прогона бэкапа: на каком он шаге, сколько довезено и чем кончился.
 *
 * **Инлайн, а не тост.** Тост живёт 2200 мс и гаснет; он для прогонов, чью
 * страницу покинули, и он глобален — одна строка на всё приложение. Здесь всё
 * наоборот: бэкап идёт минутами, смотрят на него именно с этой вкладки, а
 * результат (путь на диске!) обязан остаться на экране, пока его не сменит
 * следующий прогон. Исчезающий путь к файлу — это путь, который придётся
 * искать заново.
 *
 * **Полоса рисуется только при известном знаменателе.** Байты приходят одним
 * шагом из шести — выгрузкой; у остальных их нет вовсе, и знаменатель «на глаз»
 * был бы тем же враньём, что зелёный бейдж вместо «не измеряли» (принцип №6).
 * Нет `total_bytes` — на экране слова о шаге, и только они.
 *
 * **`aria-live` — на строке шага, не на счётчике байтов.** Счётчик меняется
 * четыре раза в секунду (троттлинг Rust — 250 мс), и живая область вокруг него
 * превратила бы чтение с экрана в непрерывный поток цифр, из которого не
 * выудить ни одной новости. Новость — смена шага, она и объявляется.
 */

/** Шаг → фраза. Незнакомых сюда не доезжает: их отсеивает стор. */
const STEP_TEXT: Record<BackupStep, string> = {
  connect: "Connecting to the server…",
  archive: "Building the archive on the server…",
  download: "Downloading the archive…",
  remote_cleanup: "Removing the archive from the server…",
  // Пересъёмка снимка — не служебная мелочь: именно она делает новую копию
  // видимой в списке выше, и её отдельная строка объясняет, почему после
  // скачивания что-то ещё происходит.
  facts: "Refreshing the snapshot…",
};

/**
 * Пока не приехало ни одного события. Состояние настоящее, а не «пустое»:
 * между запуском и первым `connect` успевает пройти синхронизация кэша, и
 * пустая строка на её месте читалась бы как «ничего не происходит».
 */
const STARTING_TEXT = "Starting…";

const MUTED = "#64748b";
/** Цвет оговорки: не ошибка (красный), но и не «всё хорошо». */
const NOTE = "#b45309";

/** Строка оговорки — общая для всех исходов: их формат обязан быть один. */
function NoteLine({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: NOTE, overflowWrap: "anywhere" }}>{children}</div>;
}

/**
 * Что попало в архив, словами.
 *
 * Печатается всегда, а не только когда баз нет: молчание про базы читается как
 * «всё внутри», а архив сайта без дампа выглядит ровно как архив с дампом — те
 * же байты, тот же путь, — и обнаруживается это при восстановлении, то есть в
 * худший из возможных моментов.
 */
function partsText(files: boolean, databases: number): string {
  const what = [
    files ? "site files" : null,
    databases === 1 ? "1 database" : databases > 1 ? `${databases} databases` : null,
  ].filter(Boolean);
  // Пусто быть не должно (архив без частей не собирается), но если провод
  // принесёт такое — скажем прямо, а не промолчим.
  return what.length ? what.join(" + ") : "nothing recognizable";
}

export function BackupRunLine({ domainId }: { domainId: number }) {
  const run = useBackupRun(domainId);
  // Ничего не запускали — и строки нет. Отмена панели сохранения сюда тоже не
  // доезжает: прогон в сторе не заводится вовсе.
  if (!run) return null;

  if (run.outcome) {
    if (run.outcome.kind === "saved") {
      const { path, bytes, warnings, factsRefreshed, databases, files } = run.outcome.saved;
      // Оговорка про неубранный архив приезжает ДВУМЯ каналами сразу (Rust шлёт
      // её и событием, и в `warnings`) — на успешном пути доезжают оба. Один
      // текст, напечатанный дважды, выглядит как две разные беды.
      const said = Array.from(new Set([...warnings, ...run.notes]));
      return (
        // `role="status"` — на ВЕСЬ исход, а не на одну зелёную строку. Строка
        // про непересъёмку и предупреждения меняют смысл зелёной: успех с ними
        // — полууспех. Оставь живой область вокруг одной первой строки, и
        // скринридер объявил бы полный успех там, где зрячий видит три строки и
        // читает оговорку. Различия обязаны доезжать до обоих одинаково.
        <div role="status" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Путь — ЧУЖОЙ текст (его выбрал человек, а вернул Rust), и он
              неразрывный: без переноса он распирает модалку и даёт ей
              горизонтальную полосу, запрещённую `design-brief.md` §11. */}
          <div style={{ fontSize: 13, color: "#166534", overflowWrap: "anywhere" }}>
            Saved to {path} · {formatBytes(bytes)} · {partsText(files, databases)}
          </div>
          {factsRefreshed ? null : (
            // Полууспех, а не успех: архив на диске, но снимок сервера остался
            // прежним. Красным это рисовать нельзя (бэкап удался), молчать —
            // тоже: карточка домена после удачного бэкапа показывает данные «до
            // него», и без оговорки это читается как «ничего не произошло».
            //
            // Про «список копий выше» тут не говорится намеренно: списка нет и
            // не будет, пока не разблокирована фаза 3 (`DESKTOP_READS_BACKUPS`),
            // — на его месте пунктирная панель, которая не покажет ничего
            // никогда, и ссылаться на неё значит объяснять непонятное несуществующим.
            <NoteLine>
              The server snapshot could not be refreshed after the backup, so this card still
              shows what the last snapshot showed.
            </NoteLine>
          )}
          {said.map((w) => (
            <NoteLine key={w}>{w}</NoteLine>
          ))}
        </div>
      );
    }
    if (run.outcome.kind === "cancelled") {
      // Отмена — не авария, и красной она быть не должна. Но и молчать нельзя:
      // человек обязан узнать, что файла нет (недокачанный `.part` снесён, а
      // архив с сервера убран).
      return (
        // Живая область — на весь исход, как и у успеха: оговорка про архив,
        // оставшийся на сервере, меняет смысл слова «Cancelled» и обязана
        // объявляться вместе с ним.
        <div role="status" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: MUTED }}>Cancelled — no copy was saved.</div>
          {/* На пути отмены `warnings` не возвращаются вовсе (команда отдаёт
              `Err`), и событие — ЕДИНСТВЕННЫЙ канал этой вести. Заглуши его, и
              экран будет утверждать, что убрал за собой, пока на продакшне
              лежит многогигабайтный тарболл. */}
          {run.notes.map((n) => (
            <NoteLine key={n}>{n}</NoteLine>
          ))}
        </div>
      );
    }
    return (
      <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 13, color: "#b91c1c", overflowWrap: "anywhere" }}>
          Backup failed: {run.outcome.error}
        </div>
        {/* И здесь тоже: провал выгрузки — как раз тот случай, когда архив на
            сервере ОСТАВЛЕН намеренно (единственная целая копия), и путь к нему
            человеку нужен больше всего. */}
        {run.notes.map((n) => (
          <NoteLine key={n}>{n}</NoteLine>
        ))}
      </div>
    );
  }

  const stepText = run.step ? STEP_TEXT[run.step] : STARTING_TEXT;
  const { doneBytes, totalBytes } = run;
  // Знаменатель обязан быть и обязан быть ненулевым: доля от нуля не
  // определена, и полоса на ней либо пустая навсегда, либо полная сразу.
  const measured = doneBytes !== null && totalBytes !== null && totalBytes > 0;
  const percent = measured ? Math.min(100, Math.round((doneBytes! / totalBytes!) * 100)) : 0;
  const counter = measured ? `${formatBytes(doneBytes!)} of ${formatBytes(totalBytes!)}` : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        {/* Живая область — только слова о шаге. */}
        <span aria-live="polite" style={{ fontSize: 13, color: "#0f172a" }}>
          {stepText}
        </span>
        {/* Счётчик вне живой области намеренно (см. шапку файла). */}
        {counter ? (
          <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap" }}>{counter}</span>
        ) : null}
      </div>
      {measured ? (
        <div
          role="progressbar"
          aria-label="Backup download"
          aria-valuemin={0}
          aria-valuemax={totalBytes!}
          aria-valuenow={doneBytes!}
          // Числами байт скринридер отчитался бы как «12345678 of 251658240» —
          // это не ответ на «сколько осталось». Текст даёт тот же формат, что
          // и на экране.
          aria-valuetext={counter ?? undefined}
          style={{ height: 6, borderRadius: 99, background: "#e2e8f0", overflow: "hidden" }}
        >
          <div style={{ width: `${percent}%`, height: "100%", background: "#2563eb" }} />
        </div>
      ) : null}
    </div>
  );
}

export default BackupRunLine;
