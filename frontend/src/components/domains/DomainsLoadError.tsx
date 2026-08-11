import React from "react";

import { ErrorState } from "../ui/Primitives";
import { describeQueryError } from "../../lib/queryError";

/**
 * Что стоит вместо вкладки, когда список доменов не загрузился.
 *
 * Не пустая таблица и не «доменов нет»: отличить «сеть/сервер не ответили» от
 * «в базе пусто» пользователь сам не может, а разница между ними — это разница
 * между «подожди» и «заведи первый домен». Разбор ошибки — общий
 * (`lib/queryError`), чтобы вкладка не изобретала свою формулировку для тех же
 * 401/500/таймаута.
 *
 * Шапка тут своя и без кнопок: заводить домены, пока не видно уже заведённых,
 * незачем.
 */
export default function DomainsLoadError({ error }: { error: unknown }) {
  const described = describeQueryError(error);
  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Domains</h1>
        <div style={{ fontSize: 13, color: "#6b7280" }}>Domain inventory</div>
      </div>
      <ErrorState
        title={described.title}
        message={`The domains list could not be loaded. ${described.message}`}
        hint={described.hint}
      />
    </div>
  );
}
