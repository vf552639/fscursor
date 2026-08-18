import React from "react";

import { Domain } from "../../api/domains";
import {
  dbNameSource,
  dbUserSource,
  phpVersionSource,
  siteOwnerSource,
  sitePathSource,
} from "../../lib/domainDrift";
import { SectionCard } from "../ui/Primitives";
import { FactRow, MUTED } from "./facts/fields";
import { type Snapshot } from "./facts/snapshot";

/**
 * Карточка «Site» вкладки Server — ответ на вопрос «что за сайт стоит на
 * сервере»: путь, владелец, PHP, базы.
 *
 * Снимок приходит разобранным (от вкладки), а не берётся своим вызовом
 * `snapshotOf`: у карточек Server он ОДИН, вместе с подписью возраста в строке
 * над ними, и второй разбор рядом с первым разъезжается молча. Из разбора
 * карточке отданы РОВНО факты и «снимка не было» — не весь `Snapshot`: возраст
 * и протухание принадлежат той единственной строке, и карточка, начавшая
 * печатать `freshness` у себя, вернула бы на экран два ответа про один снимок.
 *
 * **Перечня логов здесь нет намеренно.** Он читается из того же снимка
 * (`fp_facts.logs`) и по плану вкладок принадлежит вкладке Logs (фаза 5); до её
 * приезда карточка про логи просто молчит. Две строки, печатающие один и тот же
 * список путей, — это два ответа на один вопрос, и расходиться они начали бы в
 * первый же день, когда одну из них поправят.
 */
export default function DomainSiteCard({
  domain,
  snapshot,
}: {
  domain: Domain;
  snapshot: Pick<Snapshot, "facts" | "noSnapshot">;
}) {
  const { facts, noSnapshot } = snapshot;

  /**
   * Наша запись против факта — все вопросы карточки в ОДНОМ месте.
   *
   * Собраны сюда намеренно: вызовы почти одинаковы (`(recorded, facts)`), и
   * подмена аргумента — `phpVersionSource(domain.site_user, facts)` — исправно
   * компилируется. Здесь рассинхрон виден одним взглядом по столбику, а
   * разбросанный по точкам JSX его пришлось бы искать.
   */
  const src = {
    sitePath: sitePathSource(domain.site_path, facts),
    siteOwner: siteOwnerSource(domain.site_user, facts),
    php: phpVersionSource(domain.php_version, facts),
    dbName: dbNameSource(domain.db_name, facts),
    // Единственная функция без снимка: пользователей баз FastPanel CLI не
    // отдаёт вовсе, сверять не с чем ни при каком чтении.
    dbUser: dbUserSource(domain.db_user),
  };

  /**
   * Карточка, которой сказать НЕЧЕГО, — и она обязана сказать об этом словом.
   *
   * Условие точное, а не приблизительное. Без снимка `facts` равны `null`,
   * поэтому каждое правило `lib/domainDrift` возвращает ровно два исхода:
   * `agree`, если нашей записи нет (`compare`/`compareInList` отвечают им на
   * пустую запись), и `recorded-only`, если она есть; `drift` без факта
   * невозможен по построению. Значит «все пять — `agree`» — это в точности
   * «ни одной записи из provision», а каждая строка карточки при этом пуста и
   * спрятана (`HasSnapshot`), включая `Databases` (без снимка `list` молчит) и
   * `DB user` (у него ещё и `hideEmpty`).
   *
   * Под снимком условие не срабатывает никогда — и не должно: `Databases`
   * печатает там хотя бы «not read», то есть пустой карточка уже не бывает.
   *
   * Почему это вообще нужно: рамка и крашеная шапка `SectionCard` рисуют
   * ПУСТУЮ коробку, растянутую соседкой по ряду на её высоту, — и читается это
   * поломкой вёрстки, а не ответом. Легенда вкладки объясняет ВКЛАДКУ («сервер
   * ещё не читали»), а не то, почему у этой карточки нет ни строки; у
   * импортированного домена, где нет ни снимка, ни записей provision, это
   * единственный экран, который он увидит.
   */
  const nothingRecorded = noSnapshot && Object.values(src).every((s) => s.kind === "agree");

  return (
    <SectionCard title="Site">
      {/* `minWidth: 0` здесь НЕ нужен, и его отсутствие — не недосмотр. Дисциплину
          ширины держат двое, и оба выше: grid-элементом ряда является корень
          `SectionCard`, и он ставит `minWidth: 0` себе сам (`ui/Primitives`), а
          сам ряд с его `minmax(0, 1fr)` объяснён в `tabs/TabLayout` (`CardRow`).
          Этот же div — обычный блок внутри тела карточки, а `min-width: auto`
          считается по содержимому ТОЛЬКО у flex- и grid-элементов; у блока он и
          так ноль. От распирания чужим путём сайта и именами баз спасают
          переносы у самих значений (`Row` рвёт по `wordBreak`), а не ширина
          этого трека. */}
      <div style={{ display: "grid", gap: 10 }}>
        {nothingRecorded ? (
          <div style={{ fontSize: 13, color: MUTED }}>No site details recorded for this domain yet.</div>
        ) : null}
        <FactRow k="Path" fact={facts?.site?.site_path} src={src.sitePath} />
        <FactRow k="Owner" fact={facts?.site?.site_user} src={src.siteOwner} />
        <FactRow
          k="PHP"
          fact={
            facts?.php_version
              ? `${facts.php_version}${facts.php_handler ? ` · ${facts.php_handler}` : ""}`
              : facts?.site?.php_version || null
          }
          src={src.php}
        />
        {/* `list` — факт этого поля СПИСОК, и пустой список под снимком значит
            «не прочитали», а не «на сервере пусто» (`FactRow`, пункт 3). */}
        <FactRow
          k="Databases"
          fact={facts && facts.databases.length > 0 ? facts.databases.join(", ") : null}
          src={src.dbName}
          list
        />
        {/* Пользователь базы — единственное поле с `hideEmpty`: пустое, оно
            прячется даже ПОД снимком, потому что факта у него не бывает ни
            при каком чтении (`docs/FASTPANEL_CLI.md`), и прочерк обещал бы
            измерение, которого не будет никогда. Нет записи — нет и строки. */}
        <FactRow k="DB user" src={src.dbUser} hideEmpty />
      </div>
    </SectionCard>
  );
}
