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
import { FactRow, listFact } from "./facts/fields";
import { type Snapshot } from "./facts/snapshot";

/**
 * Карточка «Site» вкладки Server — ответ на вопрос «что за сайт стоит на
 * сервере»: путь, владелец, PHP, базы.
 *
 * Снимок приходит разобранным (`Snapshot` от вкладки), а не берётся своим
 * вызовом `snapshotOf`: у карточек Server он ОДИН, вместе с подписью возраста в
 * шапке вкладки, и второй разбор рядом с первым разъезжается молча.
 *
 * **Перечня логов здесь нет намеренно.** Он читается из того же снимка
 * (`fp_facts.logs`) и по плану вкладок принадлежит вкладке Logs (фаза 5); до её
 * приезда карточка про логи просто молчит. Две строки, печатающие один и тот же
 * список путей, — это два ответа на один вопрос, и расходиться они начали бы в
 * первый же день, когда одну из них поправят.
 */
export default function DomainSiteCard({ domain, snapshot }: { domain: Domain; snapshot: Snapshot }) {
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

  return (
    <SectionCard title="Site">
      {/* `minWidth: 0` — карточка стоит в двухколоночном гриде, а печатает
          ЧУЖИЕ строки (путь сайта, имена баз): без него grid-элемент не
          сожмётся уже своего содержимого, распёртая колонка даст модалке
          горизонтальную полосу, запрещённую `design-brief.md` §11, — а под
          `overflow: hidden` самой карточки путь ещё и обрежется. */}
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
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
        <FactRow
          k="Databases"
          fact={listFact(facts && facts.databases.length > 0 ? facts.databases.join(", ") : null, noSnapshot)}
          src={src.dbName}
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
