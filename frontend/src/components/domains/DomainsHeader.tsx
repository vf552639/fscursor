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
  /** Идёт ли прогон привязки — тот же признак, что гасит кнопку по выделенным. */
  syncPending?: boolean;
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
          то же действие с меньшей областью и называется тем же словом.

          Только десктоп, и по той же причине, что и там: зон Cloudflare в базе
          нет вовсе — их вживую читает `cf_list_zones`, — а CTA «открыть в
          десктопе» вело бы в хост, которого `parseDeepLinkAction` не знает. */}
      {isTauri() ? (
        <Btn variant="secondary" onClick={onSyncCloudflare} disabled={Boolean(syncPending)}>
          {syncPending ? "Синхронизация…" : "⟳ Синхронизировать с Cloudflare"}
        </Btn>
      ) : null}
      <Btn variant="secondary" onClick={onFileImport}>⇪ File Import</Btn>
      <Btn variant="secondary" onClick={onBulkAdd}>⊕ Bulk Add</Btn>
      <Btn variant="primary" onClick={onAddDomain}>+ Add Domain</Btn>
    </div>
  </div>;
}
