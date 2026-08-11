import React from "react";

import { Btn } from "../ui/Primitives";

/**
 * Шапка вкладки: сколько всего доменов и три входа для их заведения.
 *
 * Входы те же три, что предлагает `DomainsEmptyState`, и это не дублирование, а
 * одно правило: способов завести домен ровно три, и человек, увидевший их на
 * пустом экране, обязан найти их же на полном.
 */
export default function DomainsHeader({
  total,
  onFileImport,
  onBulkAdd,
  onAddDomain,
}: {
  total: number;
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
      <Btn variant="secondary" onClick={onFileImport}>⇪ File Import</Btn>
      <Btn variant="secondary" onClick={onBulkAdd}>⊕ Bulk Add</Btn>
      <Btn variant="primary" onClick={onAddDomain}>+ Add Domain</Btn>
    </div>
  </div>;
}
