import React from "react";

import { Btn } from "../ui/Primitives";
import { CF_SYNC_TITLE, CF_SYNC_VERB } from "../../lib/cfZoneMatch";
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
      {/* Вход, на который ссылается подсказка в строке (`CF_HINT_TITLE`): он
          обязан быть виден всегда, а не только при выделении, — иначе человек,
          прочитавший подсказку, ищет на экране то, чего там нет. Кнопка по
          выделенным (`BulkActionToolbar`) — то же действие с меньшей областью,
          и подпись у обеих собрана из одного `CF_SYNC_VERB`.

          Только десктоп: зоны в базе не лежат вовсе — их вживую читает
          Tauri-команда `cf_list_zones`, — почему в вебе действие невозможно
          даже теоретически, разобрано у самого прогона (`api/cfAutoBind.ts`,
          «ТОЛЬКО десктоп»). */}
      {isTauri() ? (
        <Btn
          variant="secondary"
          onClick={onSyncCloudflare}
          disabled={syncPending}
          title={CF_SYNC_TITLE}
        >
          {syncPending ? "Синхронизация…" : `⟳ ${CF_SYNC_VERB} с Cloudflare`}
        </Btn>
      ) : null}
      <Btn variant="secondary" onClick={onFileImport}>⇪ File Import</Btn>
      <Btn variant="secondary" onClick={onBulkAdd}>⊕ Bulk Add</Btn>
      <Btn variant="primary" onClick={onAddDomain}>+ Add Domain</Btn>
    </div>
  </div>;
}
