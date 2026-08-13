import React from "react";

import { Btn } from "../ui/Primitives";
import { isTauri } from "../../lib/runtime";

/**
 * Шапка вкладки: сколько всего доменов, синхрон с Cloudflare и три входа для их
 * заведения.
 *
 * Входы те же три, что предлагает `DomainsEmptyState`, и это не дублирование, а
 * одно правило: способов завести домен ровно три, и человек, увидевший их на
 * пустом экране, обязан найти их же на полном.
 */
export default function DomainsHeader({
  total,
  onSyncCloudflare,
  syncPending,
  onFileImport,
  onBulkAdd,
  onAddDomain,
}: {
  total: number;
  /**
   * Привязать к зонам Cloudflare весь список. Обязателен, хотя кнопка рисуется
   * только в десктопе (см. ниже): кнопка без обработчика молчит, а такую от
   * сломанной не отличить.
   */
  onSyncCloudflare: () => void;
  /**
   * Идёт ли прогон привязки — тот же признак, что гасит кнопку по выделенным.
   *
   * Обязателен по той же причине, что и обработчик: забытый означает бодрую
   * кнопку на все десятки секунд прогона, то есть человека, который жмёт её
   * второй раз, решив, что первый клик не сработал. Прогон гейт остановит, но
   * молча — а видит пользователь только неотвечающую кнопку.
   */
  syncPending: boolean;
  onFileImport: () => void;
  onBulkAdd: () => void;
  onAddDomain: () => void;
}) {
  return <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
    <div>
      <h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Domains</h1>
      <div style={{fontSize:13,color:"#6b7280"}}>{total} domains total</div>
    </div>
    <div style={{display:"flex",gap:8}}>
      {/* Вход, на который ссылается подсказка в строке («Нажми
          Синхронизировать»): он обязан быть виден всегда, а не только при
          выделении, — иначе человек, прочитавший подсказку, ищет на экране
          то, чего там нет. Кнопка по выделенным (`BulkActionToolbar`) —
          то же действие с меньшей областью и называется тем же словом; там же
          разобрано, почему в вебе этих кнопок нет вовсе.

          `title` называет область и границы действия: глагол «синхронизировать»
          обещает больше, чем делается (двустороннюю сверку — с созданием
          недостающих зон и снятием протухших привязок), а делается поиск зоны
          по имени и запись привязки там, где её нет. Менять глагол нельзя — он
          держит связку с подсказкой в строке, — поэтому обещание сужается
          здесь. */}
      {isTauri() ? (
        <Btn
          variant="secondary"
          onClick={onSyncCloudflare}
          disabled={syncPending}
          title="Найти зоны Cloudflare по именам доменов и проставить привязку; уже привязанное не трогает"
        >
          {syncPending ? "Синхронизация…" : "⟳ Синхронизировать с Cloudflare"}
        </Btn>
      ) : null}
      <Btn variant="secondary" onClick={onFileImport}>⇪ File Import</Btn>
      <Btn variant="secondary" onClick={onBulkAdd}>⊕ Bulk Add</Btn>
      <Btn variant="primary" onClick={onAddDomain}>+ Add Domain</Btn>
    </div>
  </div>;
}
