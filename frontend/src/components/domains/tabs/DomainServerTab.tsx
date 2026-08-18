import React from "react";

import { Domain, useReadDomainFacts } from "../../../api/domains";
import { Server } from "../../../api/servers";
import { isTauri } from "../../../lib/runtime";
import { Badge, Btn, SectionCard } from "../../ui/Primitives";
import DomainFtpCard from "../DomainFtpCard";
import DomainSiteCard from "../DomainSiteCard";
import { HasSnapshot, RecordedNoteInLegend } from "../facts/fields";
import { snapshotOf } from "../facts/snapshot";

/**
 * Вкладка Server — ЕДИНСТВЕННОЕ место карточки, отвечающее на вопрос «что
 * развёрнуто на сервере»: доступ по FTP и сам сайт (путь, владелец, PHP, базы).
 * Сертификат отвечает на свой вопрос и живёт своей карточкой на Overview
 * (`DomainSslCard`) — из того же снимка, но не здесь.
 *
 * Сама вкладка — раскладка плюс три вещи, которые обязаны быть ОДНИМИ на весь
 * снимок, а не своими у каждой карточки; и все три про честность измерения, а
 * не про вёрстку:
 *
 * 1. **Свежесть и кнопка чтения.** Снимок ОДИН на всю карточку домена, снимает
 *    его кнопка отсюда, и его возраст печатается здесь же строкой слева.
 *    Карточка SSL на Overview читает тот же снимок и печатает его возраст у
 *    себя в шапке, чтобы не выдать протухшее измерение за свежее.
 * 2. **Легенда «Сервер ещё не читали»** — один раз словами вместо решётки
 *    прочерков в полях. Её же наличие гасит приписку «из provision, на сервере
 *    не проверено» под полями (`RecordedNoteInLegend`), потому что легенда
 *    несёт те же слова.
 * 3. **Разбор снимка — один** (`facts/snapshot`) и уезжает в обе карточки
 *    пропом. Второй разбор внутри карточки совпадал бы с этим ровно до
 *    ближайшей правки.
 *
 * Правил о состоянии домена вкладка не заводит: порог протухания — в
 * `lib/domainFacts`, правило расхождения нашей записи с фактом — в
 * `lib/domainDrift`, его показ — в `domains/facts/fields`. Три экрана про
 * сервер уже разъезжались, когда правило жило в компоненте.
 *
 * Про язык подписей: проза вкладки английская, но три строки — «при
 * развёртывании: X», «из provision, на сервере не проверено» и «Сервер ещё не
 * читали» — оставлены по-русски дословно, как их задаёт план и повторяют его
 * acceptance criteria. Они один смысловой блок и приезжают вместе; вкладка к
 * тому же двуязычна и без них (кнопки «Проверить на сервере», «Задать
 * пароль»). Выравнивание языка — отдельный записанный долг плана, не эта
 * работа.
 */
export default function DomainServerTab({
  domain,
  server,
  now,
}: {
  domain: Domain;
  server: Server | undefined;
  now: number;
}) {
  /**
   * Разбор снимка — общий (`facts/snapshot`), а не свой: гейт `fp_facts_at` над
   * `fp_facts` и порог свежести обязаны быть одинаковыми у этой вкладки и у
   * карточки SSL на Overview, потому что снимок у них ОДИН.
   *
   * `noSnapshot` значит «удачного снимка не было ни разу», и тогда решётка
   * прочерков — враньё: прочерк в поле читается как «сервер спросили, там
   * пусто», а спрашивать мы ещё не ходили. Поэтому поля, которым нечего
   * сказать, прячутся целиком, а вместо них вкладка говорит это ОДИН раз
   * словами.
   */
  const snapshot = snapshotOf(domain, now);
  const { noSnapshot, stale: factsStale, freshness } = snapshot;
  const desktop = isTauri();
  const read = useReadDomainFacts(domain.id);

  return (
    // Отступа сверху здесь нет намеренно: его держит панель `Tabs` — иначе
    // каждая вкладка компенсировала бы его своей копией одного и того же числа.
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 13, color: factsStale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
        {/* Только десктоп: чтение идёт по SSH, веб этого не умеет. */}
        {desktop ? (
          <Btn
            size="sm"
            variant="secondary"
            onClick={read.run}
            disabled={read.pending}
            title="Read SSL, FTP, PHP, site and databases from the server over one SSH session"
          >
            {read.pending ? "Checking…" : "Проверить на сервере"}
          </Btn>
        ) : null}
      </div>

      {/* Ошибка последней ПОПЫТКИ — под строкой свежести. Сам снимок при этом
          остаётся прежним (сервер не трогает `fp_facts` при провале), и его
          возраст напечатан строкой выше — тем и отличается «проверка упала» от
          «данные устарели». */}
      {domain.fp_check_error ? (
        // `overflowWrap` — текст ЧУЖОЙ: это ответ ssh или FastPanel, и в нём
        // сидит неразрывный токен (путь, ключ хоста, URL). Без переноса он
        // распирает модалку и даёт ей горизонтальную полосу, запрещённую
        // `design-brief.md` §11. Тот же приём и той же формулировкой одет
        // `Last error` в карточке и ошибки записи в полях ряда связей.
        <div role="alert" style={{ fontSize: 12, color: "#b91c1c", overflowWrap: "anywhere" }}>
          Last check failed: {domain.fp_check_error}
        </div>
      ) : null}

      {/* Снимка не было ни разу — говорим это словами ОДИН раз, вместо того
          чтобы повторять прочерком в каждом поле, а подписью «из provision, на
          сервере не проверено» — под каждым из них. Легенда несёт ту же подпись
          дословно и связывает её с приглушённым цветом значений; ЕЁ наличие и
          гасит приписки у полей (`RecordedNoteInLegend` ниже) — приём, который
          карточка SSL на Overview повторяет своей легендой, англоязычной и
          своей. Кнопка чтения — в строке выше (и только в десктопе: SSH в вебе
          нет). */}
      {noSnapshot ? (
        <div style={{ fontSize: 12.5, color: "#6b7280" }}>
          Сервер ещё не читали. Приглушённые значения — из provision, на сервере не проверено.
        </div>
      ) : null}

      {/* Два контекста, а не один: «снимка нет» прячет пустые поля, а гашение
          приписки «из provision, на сервере не проверено» объявляет ровно тот,
          кто печатает легенду с этими же словами — она стоит строкой выше и
          только под `noSnapshot`. Слитые в один, они гасили приписку и на
          карточке SSL (Overview), где никакой легенды нет. */}
      <HasSnapshot.Provider value={!noSnapshot}>
        <RecordedNoteInLegend.Provider value={noSnapshot}>
          {/* `minmax(0, 1fr)`, а не `1fr`: голый `1fr` — это `minmax(auto, 1fr)`,
              и минимум трека равен ширине содержимого, поэтому один неразрывный
              токен (путь, логин, имя базы) распирает колонку за ширину модалки.
              У `Modal` стоит `overflowY: auto`, из-за чего `overflow-x`
              вычисляется в `auto` — распёртая колонка даёт КАРТОЧКЕ
              горизонтальную полосу, запрещённую `design-brief.md` §11. Ряд
              связей на Overview держит ту же дисциплину (`DomainLinks`), и по
              той же причине карточкам нужен `minWidth: 0`: у grid-элемента он по
              умолчанию равен содержимому, и без него в трек упрётся не текст, а
              сам столбец. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
            <DomainFtpCard domain={domain} server={server} snapshot={snapshot} />
            <DomainSiteCard domain={domain} snapshot={snapshot} />
          </div>
        </RecordedNoteInLegend.Provider>
      </HasSnapshot.Provider>

      {/* Backups — заглушка макета, и единственная её честная форма: о резервных
          копиях продукт сегодня не знает НИЧЕГО. Ни модели на бэкенде, ни
          колонки у домена, ни поля в снимке `fp_facts`; у самого FastPanel
          команда `backup:plan` в CLI есть, но мы её ни разу не звали и формы
          вывода не снимали (`docs/FASTPANEL_CLI.md`).

          Макет рисует здесь два селекта (частота и место хранения), поле
          своего пути и кнопки «Backup now» / «Save». Селекты, которые ничего не
          сохраняют, — это обещание настройки, которой нет, а мета «Last backup:
          … · 412 MB» была бы ещё и измерением, которого никто не делал (принцип
          №6 CLAUDE.md). Поэтому пилюля `COMING SOON` и одна фраза — так же, как
          у заглушки DMCA на Overview. */}
      <SectionCard title="Backups" right={<Badge variant="gray">COMING SOON</Badge>}>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>
          Backup schedule and restore points for this site will appear here in a future update.
        </div>
      </SectionCard>
    </div>
  );
}
