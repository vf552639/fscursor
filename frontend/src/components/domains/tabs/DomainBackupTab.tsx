import React from "react";

import { Domain } from "../../../api/domains";
import { useCreateDomainBackup } from "../../../api/domainBackups";
import {
  DESKTOP_READS_BACKUPS,
  backupsOf,
  snapshotOf,
  type DomainBackup,
} from "../../../lib/domainFacts";
import { formatBytes } from "../../../lib/format";
import { isTauri } from "../../../lib/runtime";
import { Btn, fmtDT } from "../../ui/Primitives";
import { DesktopOnlyNote } from "../../DesktopOnlyNote";
import { SnapshotLine } from "../facts/SnapshotLine";
import { BackupRunLine } from "./BackupRunLine";
import { EmptyPanel, TabBody } from "./TabLayout";

/**
 * Вкладка Backup — резервные копии сайта: что о них знает панель и что из этого
 * знания честно показать.
 *
 * Место этой вкладки раньше занимала карточка-заглушка `Backups` на вкладке
 * Server, и её обоснование переезжает сюда целиком, потому что оно никуда не
 * делось: **макет рисует здесь два селекта (частота и место хранения), поле
 * своего пути, кнопки «Backup now» / «Save» и мету «Last backup: … · 412 MB»**.
 * Ни один из этих органов управления сюда не приехал, и это не незаконченная
 * вёрстка:
 *
 * - селекты частоты и места — обещание настройки, которой нет: расписание это
 *   `backup:plan` панели, внешнее хранилище (S3/FTP) требует своих ключей
 *   vault-блобами, и ни того ни другого в продукте нет (оба названы внизу
 *   вкладки словами, а не пустым селектом);
 * - «Last backup: … · 412 MB» — измерение, которого никто не делал; ровно то,
 *   что запрещает принцип №6 CLAUDE.md.
 *
 * Что вкладка делает вместо этого — показывает список копий ПАНЕЛИ с явным
 * ответом, знаем ли мы его вообще (`lib/domainFacts::backupsOf`, четыре
 * состояния, у каждого своя фраза). Пустой список — единственное место
 * продукта, где мы утверждаем, что копий нет; в трёх остальных состояниях этой
 * мысли нет ни в одной формулировке.
 *
 * **Кнопка на вкладке РОВНО ОДНА, и только в десктопе** — «Create backup». Она
 * не читает список выше, а делает новую копию: собирает архив на сервере по
 * SSH, качает его на машину пользователя и сверяет sha256
 * (`domain_backup_create`). Прогон, строка прогресса и правила «не соврать» —
 * в `api/domainBackups.ts`, `store/backupRuns.ts` и `BackupRunLine`.
 *
 * Второй кнопки — **«Проверить на сервере»** — здесь нет, хотя план её называл
 * для состояний `no-snapshot` и `not-in-snapshot`: новый снимок списка не
 * принесёт, потому что чтение чужих копий на стороне Rust не написано, и поле
 * `backups` не приходит вовсе. Условие и причина зафиксированы одной константой
 * — `DESKTOP_READS_BACKUPS`, там же расписано, что меняется при переключении.
 * Асимметрия с вкладкой Logs (там такая кнопка есть) не противоречие: там
 * снимок реально приносит пути логов, здесь — ничего. К кнопке создания эта
 * константа отношения не имеет: создание от списка не зависит.
 *
 * Кнопки **отмены** прогона тоже нет, хотя команда `domain_backup_cancel` в
 * десктопе есть: фаза 7 плана её не называет, и отдельная кнопка рядом с
 * идущим прогоном — своё решение (куда её ставить, что делать с `.part`,
 * как рисовать «отменяется»), а не следствие уже принятых. Отмена при этом
 * обработана целиком: если она придёт (второе окно, `sdmp://`), прогон покажет
 * её отдельным исходом, а не красной ошибкой.
 *
 * `TabGroup` и `SectionCard` вокруг содержимого нет намеренно: панель уже
 * названа своей вкладкой (`role="tabpanel"` + `aria-labelledby` в `ui/Tabs`), и
 * обёртка добавила бы к «Backup» второй заголовок про то же самое. Шапка
 * снимка — общая `facts/SnapshotLine`, та же, что на Server и Logs: снимок один
 * на карточку, и его возраст обязан читаться одинаково на всех трёх вкладках.
 */
export interface DomainBackupTabProps {
  domain: Domain;
  /**
   * «Сейчас» карточки: один раз на рендер, общее для всех её сроков — возраст
   * снимка здесь обязан совпадать с тем, что печатают Server и Logs.
   */
  now: number;
}

/**
 * Фразы пустых состояний. Разные — не для разнообразия: человек по ним решает,
 * что делать дальше, и «мы не спрашивали», «мы не умеем спросить», «спросили и
 * не поняли ответ» и «спросили, копий нет» ведут к четырём разным следующим
 * шагам. Одна фраза на всех означала бы, что мы не различаем эти случаи сами.
 *
 * Живут в одном объекте, а не по месту показа, чтобы их можно было прочитать
 * подряд и увидеть: утверждение об ОТСУТСТВИИ копий стоит ровно в одной из них.
 * Экспортированы затем же: тест сравнивает сами фразы, а не текст отрендеренной
 * панели, — иначе «две фразы слились в одну» пряталось бы за соседними
 * строками вкладки, которые у разных состояний и так разные.
 */
export const EMPTY_TEXT = {
  /**
   * Гейт `DESKTOP_READS_BACKUPS` стоит и здесь, а не только у соседа снизу.
   * Достижимых состояний сегодня два — это и `not-in-snapshot`, — и новый
   * снимок не лечит ни одно: «сервер ещё не читали» само по себе правда, но
   * рядом со списком копий оно читается как «прочитай, и узнаем», а мы не
   * узнаем. Ложная импликатура — та же болезнь, что кнопка, обещающая починку,
   * только выраженная фразой; на неё правило распространяется тоже.
   */
  "no-snapshot": DESKTOP_READS_BACKUPS
    ? "The server has not been read for this domain yet, so nothing here is known about its backup copies."
    : "The server has not been read for this domain yet — and reading it would not bring copies either: SDMP does not read what FastPanel keeps.",
  /**
   * Фраза зависит от того, лечится ли состояние новым снимком, — а это ровно
   * то, что говорит `DESKTOP_READS_BACKUPS`. Сегодня не лечится, и предлагать
   * «пересними» значило бы отправить человека жать кнопку, которая ничего не
   * изменит (потому кнопки рядом и нет).
   */
  "not-in-snapshot": DESKTOP_READS_BACKUPS
    ? "This snapshot was taken before SDMP learned to read backups — read the server again to bring the list."
    : "SDMP does not read the copies FastPanel keeps yet, so no snapshot brings that list.",
  unreadable:
    "The last snapshot could not read the list of copies, so we do not know what FastPanel keeps for this site.",
  /** ЕДИНСТВЕННОЕ утверждение об отсутствии копий во всём продукте. */
  listed: "FastPanel shows no backup copies for this site.",
  /**
   * Не состояние снимка, а его причина: читать копии не с чего. Заменяет собой
   * ровно одну фразу — `no-snapshot`, — и только её: там мы и правда ничего не
   * спрашивали, а пустая привязка объясняет, почему и не спросим.
   *
   * Ко всем остальным состояниям она не применяется, хотя `server_id` может
   * быть пуст и при них: снимок-то есть. Сказать «домен не привязан к серверу»
   * под строкой «Checked 2h ago» значит поспорить с самим собой и спрятать
   * настоящий ответ панели за нашей записью — а карточка домена устроена
   * наоборот, факт важнее записи (`lib/domainDrift`). Домен, отвязанный ПОСЛЕ
   * снимка, — обычный случай, и ответ у него прежний: что панель показала, то и
   * показано.
   */
  "no-server": "This domain is not bound to a server, so there is nothing to read backup copies from.",
} as const;

/** Дата копии словами. Не разобралась — «date unknown», а не прочерк. */
function dateText(iso: string | undefined): string {
  // Прочерк здесь читался бы как «спросили, там пусто» — та же дисциплина, что
  // у полей снимка (`facts/fields`) и у бейджа размера ниже. Мусор вместо даты
  // (панель отдала свой формат, разбор не встал) — то же незнание, что и
  // отсутствие поля, и врать «Invalid Date» на экране нечего.
  if (!iso) return "date unknown";
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? "date unknown" : fmtDT(iso);
}

/** Глиф «размер не прочитан». Он же — признак: см. `BackupRow`. */
const SIZE_UNKNOWN = "—";

/** Размер копии по дисциплине бейджа логов: «—» ≠ «0 B». */
function sizeText(bytes: number | undefined): string {
  // `undefined` — размер не прочитан, и печатать его нулём значило бы выдумать
  // пустой архив. Настоящий ноль (файл есть, он пуст) печатается как «0 B».
  // Проверяем тип, а не `!= null`: с провода в это поле может приехать строка.
  if (typeof bytes !== "number") return SIZE_UNKNOWN;
  // `formatBytes` сам отвечает прочерком на отрицательное и нефинитное — это
  // тоже «не размер», и различать эти два прочерка нечем и незачем.
  return formatBytes(bytes);
}

/** Подпись копии: имя, иначе имя файла из пути, иначе идентификатор. */
function backupLabel(b: DomainBackup): string {
  const fromPath = b.path ? b.path.split("/").filter(Boolean).pop() : undefined;
  return b.name || fromPath || b.id || "backup";
}

/**
 * Одна копия строкой списка.
 *
 * Три ответа в строке, и каждый умеет сказать «не знаю» отдельным словом:
 * подпись, дата и размер. Полный путь — в `title`: на экране он не напечатан,
 * потому что в ряду из десяти копий он бы вытеснил всё остальное, а вопрос
 * «что это за файл» задаётся к одной строке за раз.
 */
function BackupRow({ backup }: { backup: DomainBackup }) {
  // Признак берётся из НАПЕЧАТАННОГО, а не из типа поля: прочерк рисует ещё и
  // `formatBytes` — на отрицательном и нефинитном числе, — и, спрашивая тип, мы
  // оставили бы такой прочерк без слова. Тогда единственным каналом различия
  // остался бы сам глиф, которого у скринридера нет. Правило простое: печатаем
  // «—» — говорим, что это значит.
  const size = sizeText(backup.size_bytes);
  const sizeKnown = size !== SIZE_UNKNOWN;
  return (
    <li
      title={backup.path}
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        borderBottom: "1px solid #f1f5f9",
      }}
    >
      <span style={{ fontSize: 13, color: "#0f172a", overflowWrap: "anywhere" }}>
        {backupLabel(backup)}
        {backup.kind ? <span style={{ color: "#94a3b8", marginLeft: 6 }}>{backup.kind}</span> : null}
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 12, whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#64748b" }}>{dateText(backup.created_at)}</span>
        <span
          // Метка только у прочерка: у остальных состояний содержимое читается
          // как есть («0 B», «24 MB»), и вторая формулировка рядом разошлась бы
          // с первой. Тот же приём и по той же причине — в бейдже чипа логов.
          aria-label={sizeKnown ? undefined : "size not read"}
          style={{ fontSize: 12, color: "#64748b", minWidth: 56, textAlign: "right" }}
        >
          {size}
        </span>
      </span>
    </li>
  );
}

export default function DomainBackupTab({ domain, now }: DomainBackupTabProps) {
  /**
   * Разбор снимка — общий (`lib/domainFacts`), а не свой: гейт `fp_facts_at`
   * над `fp_facts` и порог свежести обязаны быть теми же, что на вкладках
   * Server и Logs, потому что снимок у всех троих ОДИН.
   */
  const snapshot = snapshotOf(domain.fp_facts, domain.fp_facts_at, now);
  const view = backupsOf(snapshot);
  const items = view.state === "listed" ? view.items : [];
  const desktop = isTauri();
  const backup = useCreateDomainBackup(domain);
  /**
   * Без привязки к серверу собирать архив не с чего: команда резолвит сервер по
   * `server_id` из локального кэша и отвечает «domain has no server_id». Кнопка
   * выключена, а не спрятана, и это не то же самое, что «выключенная кнопка с
   * подсказкой» из соседних абзацев: там серым обещали функцию, которой в
   * продукте нет вовсе, а здесь функция есть — не хватает шага, который человек
   * может сделать сам. Спрятать её значило бы оставить вкладку без объяснения,
   * почему копию создать нельзя.
   */
  const hasServer = domain.server_id != null;

  /**
   * Ответ снимка сильнее нашей записи о сервере — и это правило применяется до
   * конца, а не только к непустому списку. Пустая колонка `server_id`
   * подменяет собой единственную фразу, `no-snapshot`: там нам действительно
   * нечего сказать, и «домен не привязан к серверу» — лучший ответ, какой у нас
   * есть. Как только снимок появился, говорит он: и «поля нет», и «не
   * разобрали», и сам список — это ответы про сервер, а `server_id` — наша
   * колонка, которую могли очистить уже после съёмки.
   */
  const emptyText =
    view.state === "no-snapshot" && domain.server_id == null
      ? EMPTY_TEXT["no-server"]
      : EMPTY_TEXT[view.state];

  return (
    <TabBody>
      {/* Возраст снимка и провал последней попытки — общая шапка снимка. Возраст
          нужен потому, что список копий — измерение: без возраста он читается
          как сегодняшний, а копия, которой на сервере уже нет, выглядела бы
          доступной. Провалившаяся проверка печатается здесь `role="alert"`
          рядом с ПРЕЖНИМ возрастом — сам снимок при провале не меняется, и
          список под ним обязан остаться таким же, а не помолодеть.

          Кнопка стоит в слоте `right` той же строки — там же, где кнопка чтения
          на вкладках Server и Logs. Место не случайное: удачный бэкап
          пересъёмывает снимок, то есть меняет ровно ту строку, рядом с которой
          нажат. В вебе слот пуст (принцип №3), и вкладка объясняет это ниже. */}
      <SnapshotLine
        snapshot={snapshot}
        error={domain.fp_check_error}
        right={
          desktop ? (
            <Btn
              variant="primary"
              size="sm"
              onClick={backup.run}
              disabled={backup.pending || !hasServer}
              title={hasServer ? undefined : "This domain is not bound to a server"}
            >
              {backup.pending ? "Backing up…" : "Create backup"}
            </Btn>
          ) : null
        }
      />

      {/* Строка прогона — сразу под кнопкой, которая его запускает, и над
          списком, который он меняет. Своё состояние она держит в модульном
          сторе, а не здесь: бэкап идёт минутами, карточку за это время
          закрывают, и после повторного открытия человек обязан увидеть тот же
          прогон, а не чистый экран. */}
      <BackupRunLine domainId={domain.id} />

      {items.length > 0 ? (
        // `<ul>` со снятыми маркерами, а не ряд `div`: скринридер объявляет
        // «list, N items» — то есть отвечает на «сколько их» до чтения строк.
        // Ряд одинаковых `div` этого ответа не даёт вовсе.
        <ul aria-label="Backup copies" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((b, i) => (
            <BackupRow key={b.id ?? b.path ?? `${backupLabel(b)}#${i}`} backup={b} />
          ))}
        </ul>
      ) : (
        <EmptyPanel>{emptyText}</EmptyPanel>
      )}

      {/* Веб только смотрит (принцип №3 CLAUDE.md): создание архива идёт по SSH
          из десктопа, и в браузере его не будет. Фраза говорит не про кнопку, а
          про то, ГДЕ живёт действие, — иначе в вебе осталась бы вкладка, у
          которой органов управления нет, без единого слова об этом. */}
      {desktop ? null : <DesktopOnlyNote what="Creating backups" />}

      {/* Отложенное — словами, и ни одного органа управления рядом. Вторая
          строка (про восстановление) обязательна: список копий без единого
          слова о restore читается как обещание «отсюда можно откатиться», а
          откатываться SDMP не умеет и в планах ближайшей фазы не умеет тоже. */}
      <div style={{ fontSize: 13, color: "#94a3b8" }}>
        External storage (S3/FTP) and a backup schedule are not part of SDMP yet — FastPanel keeps
        its own schedule, and SDMP neither reads nor sets it.
      </div>
      <div style={{ fontSize: 13, color: "#94a3b8" }}>
        Restoring a site from an archive is not part of SDMP either: copies listed here can be
        looked at, not rolled back to.
      </div>
    </TabBody>
  );
}
