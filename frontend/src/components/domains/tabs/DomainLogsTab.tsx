import React, { useState } from "react";

import { Domain, useReadDomainFacts } from "../../../api/domains";
import { DomainFacts } from "../../../lib/domainFacts";
import { logFileLabel } from "../../../lib/logFiles";
import { isTauri } from "../../../lib/runtime";
import { Btn, formatBytes } from "../../ui/Primitives";
import { snapshotOf } from "../facts/snapshot";
import { TabBody } from "./TabLayout";

/** Один файл из снимка — то, что о нём знает провод (`lib/domainFacts`). */
type LogFile = DomainFacts["logs"][number];

/**
 * Вкладка Logs — перечень лог-файлов сайта из того же снимка сервера, что и
 * вкладка Server, и честный ответ о том, чего мы про них НЕ знаем.
 *
 * Показываем ровно то, что измерено: путь каждого файла, есть ли он и сколько
 * весит. Макет рисует здесь ещё три вещи, и ни одна из них сюда не приехала —
 * это не упрощение вёрстки, а отказ печатать выдуманное:
 *
 * - **Число строк в бейдже чипа.** Мы его не считали: команда снимка делает
 *   `test -f` и `stat -c %s` (`ssh/fastpanel_facts.rs`), то есть знает
 *   существование и РАЗМЕР. Он в бейдже и стоит.
 * - **Таблица access-лога и тёмная консоль ошибок с их строками.** Содержимое
 *   логов не читает никто: ни бэкенд (и не сможет — SSH-пароль это блоб,
 *   принцип №1), ни десктоп (команды с `tail` пока нет). Тело вкладки говорит
 *   это словами, а не рисует правдоподобные строки, которых на сервере нет.
 * - **Кнопки «Refresh» и «Download».** Ни та, ни другая сегодня не может
 *   ничего сделать; кнопка, которая ничего не делает, — обещание функции
 *   (та же причина, по которой на карточке нет «Create Site»).
 *
 * Кнопка снятия снимка тут ОДНА и только в состоянии «ни разу не читали».
 * Правило карточки — «читает с сервера вкладка Server», и рядом с показанными
 * данными эта вкладка его не нарушает: свежесть у неё общая с Server, снимок
 * один, и второй кнопкой «Проверить» они бы только спорили, кто из них главный.
 * Но без снимка здесь нет ни чипов, ни путей — пустой экран со словами «Never
 * checked» и без единого способа это изменить. Кнопка и есть выход из него;
 * прогон у неё тот же (`useReadDomainFacts`), поэтому разойтись с кнопкой
 * Server она не может по построению.
 */
export interface DomainLogsTabProps {
  domain: Domain;
  /**
   * «Сейчас» карточки: один раз на рендер, общее для всех её сроков — возраст
   * снимка здесь обязан совпадать с тем, что печатают Server и карточка SSL.
   */
  now: number;
}

/**
 * Пустое тело вкладки: пунктирная рамка макета (его же состояние «Log file is
 * empty») с одной фразой посередине.
 *
 * Пунктир — не украшение: он рисует место, где ПОЯВИТСЯ содержимое, и тем
 * отличает «сюда ещё нечего положить» от карточки с данными. Три разных
 * состояния (нет снимка, путей не прочитали, содержимое не умеем) выглядят
 * одинаково намеренно — различает их фраза внутри, а не рамка.
 */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed #cbd5e1",
        borderRadius: 12,
        padding: 40,
        textAlign: "center",
        color: "#94a3b8",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Всплывающая подпись чипа: полный путь файла и, если о файле есть отдельная
 * новость, она же словами.
 *
 * Новостей две, и в бейдже они выглядят одинаково — прочерком: файла на сервере
 * нет либо размер не прочитан. Различает их на экране только цвет чипа
 * (несуществующий приглушён, см. стиль ниже), а цвет не доезжает ни до
 * скринридера, ни до печати, ни до чёрно-белого скриншота в переписке — поэтому
 * обе сказаны здесь ещё и словами.
 *
 * Путь в `title` — по другой причине: на экране напечатан путь только
 * ВЫБРАННОГО файла, и у остальных чипов это единственное место, где видно,
 * какой файл стоит за подписью.
 */
function chipTitle(f: LogFile): string {
  if (!f.exists) return `${f.path} — not found on the server`;
  if (f.size_bytes === null) return `${f.path} — size was not read`;
  return f.path;
}

export default function DomainLogsTab({ domain, now }: DomainLogsTabProps) {
  /**
   * Разбор снимка — общий (`facts/snapshot`), а не свой: гейт `fp_facts_at` над
   * `fp_facts` и порог свежести обязаны быть теми же, что на вкладке Server и в
   * карточке SSL, потому что снимок у всех троих ОДИН. Свежесть считается от
   * `fp_facts_at` (когда сняли), а не от `fp_checked_at` (когда пытались), —
   * иначе провалившаяся проверка молодила бы перечень логов.
   */
  const { facts, noSnapshot, stale, freshness } = snapshotOf(domain, now);
  const logs = facts?.logs ?? [];
  const desktop = isTauri();
  const read = useReadDomainFacts(domain.id);

  /**
   * Выбранный чип хранится ПУТЁМ, а не индексом, и путь этот проверяется по
   * списку на каждом рендере.
   *
   * Список приезжает из снимка и переснимается кнопкой: после чтения в нём
   * может не оказаться прежнего файла (сайт переехал, владелец сменился). Тогда
   * индекс молча показал бы соседний файл под прежним номером, а «висящий» путь
   * — строку под чипами, которой в перечне уже нет. Не нашли — берём первый.
   */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected: LogFile | null = logs.find((f) => f.path === selectedPath) ?? logs[0] ?? null;

  return (
    <TabBody>
      {/* Отдельной названной области (`TabGroup`), как на вкладке Server, здесь
          нет намеренно: там она отделяла прочитанное с сервера от заглушки
          Backups, стоящей рядом, — а тут ВСЁ содержимое панели про один снимок,
          и панель уже названа своей вкладкой (`role="tabpanel"` +
          `aria-labelledby` в `ui/Tabs`). Вторая обёртка добавила бы к «Logs»
          ещё один заголовок про то же самое. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        {/* Возраст снимка — тот же, что печатает вкладка Server: размеры файлов
            это измерение, и без его возраста они читаются как сегодняшние. При
            `noSnapshot` эта же строка и есть требуемое планом «Never checked» —
            слова берутся из общего разбора, а не пишутся здесь второй раз. */}
        <span style={{ fontSize: 13, color: stale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
        {/* Только десктоп: чтение идёт по SSH, веб этого не умеет (принцип №3).
            И только без снимка — см. объяснение у компонента. */}
        {noSnapshot && desktop ? (
          <Btn
            size="sm"
            variant="secondary"
            onClick={read.run}
            disabled={read.pending}
            title="Read the server snapshot over one SSH session — log file paths and sizes come with it"
          >
            {read.pending ? "Checking…" : "Проверить на сервере"}
          </Btn>
        ) : null}
      </div>

      {logs.length > 0 && selected ? (
        <>
          {/* Чипы — переключатель одного значения, поэтому это кнопки с
              `aria-pressed`, а не ссылки и не вторая строка вкладок: вложенный
              `tablist` внутри панели вкладки читался бы как вкладки карточки. */}
          <div role="group" aria-label="Log files" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {logs.map((f) => {
              const active = f.path === selected.path;
              return (
                <button
                  key={f.path}
                  // Модалка домена содержит формы; кнопка без `type` в форме —
                  // это submit.
                  type="button"
                  aria-pressed={active}
                  title={chipTitle(f)}
                  onClick={() => setSelectedPath(f.path)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    border: `1px solid ${active ? "#0f172a" : "#e2e8f0"}`,
                    background: active ? "#0f172a" : "#fff",
                    // Три цвета вместо двух: приглушённый — это «файла на
                    // сервере нет», и он обязан быть виден и на выбранном чипе
                    // тоже, иначе выбор файла стирал бы новость о нём.
                    color: !f.exists ? "#94a3b8" : active ? "#fff" : "#475569",
                    // Шрифт задаётся явно, как у `Btn` и у вкладок `ui/Tabs`:
                    // без него кнопка берёт системный шрифт формы и выпадает из
                    // строки набранного Inter.
                    fontFamily: "'Inter',sans-serif",
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    padding: "6px 12px",
                    borderRadius: 99,
                    cursor: "pointer",
                  }}
                >
                  {logFileLabel(f.path, domain.domain_name)}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: active ? "#cbd5e1" : "#64748b",
                      background: active ? "#1e293b" : "#f1f5f9",
                      borderRadius: 99,
                      padding: "1px 7px",
                    }}
                  >
                    {/* Размер, а не число строк (их мы не считали). Прочерк —
                        два разных «не знаем»: файла нет вовсе либо `stat` не
                        разобрался; `null` тут не ноль, и печатать его нулём
                        значило бы выдумать пустой файл. Какое из двух — сказано
                        в `title` чипа. */}
                    {!f.exists || f.size_bytes === null ? "—" : formatBytes(f.size_bytes)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Полный путь выбранного файла. Моно — потому что путь читают
              посимвольно; `overflowWrap` — потому что текст ЧУЖОЙ и длинный, а
              `Modal` держит `overflowY: auto`, из-за чего `overflow-x`
              вычисляется в `auto`: неразрывный путь дал бы карточке
              горизонтальную полосу, запрещённую `design-brief.md` §11.

              Моно — СИСТЕМНЫЙ (`ui-monospace`, как у остальных путей и айди в
              приложении), а не `IBM Plex Mono` из макета: подключать вебфонт
              ради одной модалки — вопрос уровня всего приложения
              (`design-brief.md` §5) и лишняя сетевая зависимость в Tauri.
              Названный, но не подключённый, он всё равно откатился бы к
              системному — то есть был бы строкой, которая ничего не делает. */}
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              color: "#94a3b8",
              overflowWrap: "anywhere",
            }}
          >
            {selected.path}
          </div>
        </>
      ) : null}

      {noSnapshot ? (
        <Placeholder>Log files are listed from the server snapshot, and none has been taken yet.</Placeholder>
      ) : logs.length === 0 ? (
        /* Снимок есть, а список путей пуст — и это НЕ «логов у сайта нет».
           Десктоп строит пути от домашнего каталога владельца сайта и, не найдя
           владельца, возвращает пустой список, ни одного файла не проверив
           (`ssh/fastpanel_facts.rs`: `match owner_home { None => vec![] }`).
           Найдись владелец — сюда приехали бы все четыре пути, и найденные, и
           ненайденные файлы; то есть пустой список означает ровно «мы не
           выяснили, где они лежат», и никогда — «логов нет». Ровно
           то же различие, ради которого у полей-списков заведён `list` в
           `FactRow`: прочерк там читался бы как «спросили, там пусто». */
        <Placeholder>
          Log paths are derived from the site owner&apos;s home directory, and the last check did not find
          one — so we do not know where this site&apos;s logs are.
        </Placeholder>
      ) : (
        <Placeholder>Reading log contents is not wired up yet.</Placeholder>
      )}
    </TabBody>
  );
}
