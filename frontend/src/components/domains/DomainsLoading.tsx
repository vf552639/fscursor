import React from "react";

/**
 * Что стоит вместо вкладки, пока не ответил ни один из четырёх её запросов.
 *
 * Отдельный модуль по той же причине, что `DomainsLoadError` и
 * `DomainsEmptyState`: «вместо таблицы» — это три равноправных экрана, и
 * оставить один из них инлайновой версткой значит объявить его чем-то другим.
 */
export default function DomainsLoading() {
  return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading domains data...</div>;
}
