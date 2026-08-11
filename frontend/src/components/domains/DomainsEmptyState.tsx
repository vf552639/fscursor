import React from "react";

import { Btn, EmptyState } from "../ui/Primitives";

/**
 * Что стоит вместо таблицы, когда доменов нет ВООБЩЕ.
 *
 * Не то же самое, что «под фильтры ничего не подошло» (та строка живёт внутри
 * таблицы): пустой список — это состояние базы, а не результат запроса, и
 * сказать об этом надо прямо, иначе оно читается как молча не доехавший ответ.
 * Отсюда же три кнопки — те же три входа, что и в шапке страницы: пустому
 * экрану нечего показывать, кроме способа перестать быть пустым.
 */
export default function DomainsEmptyState({
  onFileImport,
  onBulkImport,
  onAddDomain,
}: {
  onFileImport: () => void;
  onBulkImport: () => void;
  onAddDomain: () => void;
}) {
  return (
    <EmptyState
      title="No domains yet"
      description="Add a domain or import many at once. An empty list means there are no rows in the database — not a failed request."
    >
      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        <Btn variant="secondary" onClick={onFileImport}>
          ⇪ File import
        </Btn>
        <Btn variant="secondary" onClick={onBulkImport}>
          ⊕ Bulk import
        </Btn>
        <Btn variant="primary" onClick={onAddDomain}>
          + Add Domain
        </Btn>
      </div>
    </EmptyState>
  );
}
