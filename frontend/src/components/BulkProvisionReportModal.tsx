import React from "react";
import { Badge, Btn, Modal } from "./ui/Primitives";
import { summarizeBulkProvision, type BulkProvisionReport } from "../api/domains";

/**
 * Итог массового прогона — отдельным экраном, а не тостом.
 *
 * Тост живёт 2200 мс и всплывает ПОД модалками с паролями, которые тот же
 * прогон и породил. Пользователь копирует пароль первого домена в менеджер
 * (это дольше двух секунд), жмёт Done, копирует второй — и никогда не узнаёт,
 * что прогон оборвался на третьем и два домена не тронуты. Другого канала об
 * этом нет: `provision:progress` показывает шаги, а не итог. Операция идёт
 * часами и заканчивается частичным результатом — её итог не имеет права быть
 * эфемерным.
 *
 * Паролей здесь нет и быть не может — и это держит компилятор, а не
 * комментарий: проп сужен до `BulkProvisionReport`, где у `results` есть только
 * `domain`. Сами результаты показывает `ProvisionResultModal`, по одному и один
 * раз.
 */
export function BulkProvisionReportModal({
  outcome,
  onClose,
}: {
  outcome: BulkProvisionReport;
  onClose: () => void;
}) {
  const title =
    outcome.status === "ok"
      ? "Bulk provision finished"
      : outcome.status === "failed"
        ? "Bulk provision stopped"
        : "Bulk provision did not start";

  const idList = (ids: string[]) => (
    <div
      style={{
        fontSize: 12.5,
        fontFamily: "ui-monospace, monospace",
        color: "#374151",
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "8px 10px",
        maxHeight: 120,
        overflowY: "auto",
        wordBreak: "break-all",
      }}
    >
      {ids.map((id) => `#${id}`).join(", ")}
    </div>
  );

  const section = (label: string, body: React.ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12.5, color: "#6b7280", fontWeight: 600 }}>{label}</div>
      {body}
    </div>
  );

  return (
    <Modal title={title} onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <Badge
            variant={
              outcome.status === "ok" ? "green" : outcome.status === "failed" ? "red" : "yellow"
            }
          >
            {outcome.status === "ok"
              ? "All done"
              : outcome.status === "failed"
                ? "Stopped"
                : "Nothing started"}
          </Badge>
        </div>
        <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
          {summarizeBulkProvision(outcome)}
        </div>

        {outcome.results.length > 0 &&
          section(
            `Provisioned (${outcome.results.length})`,
            idList(outcome.results.map((r) => r.domain.replace(/^#/, ""))),
          )}

        {outcome.failed.length > 0 &&
          section(
            `Failed (${outcome.failed.length})`,
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {outcome.failed.map((f) => (
                <div key={f.domainId} style={{ fontSize: 12.5, color: "#b91c1c", lineHeight: 1.45 }}>
                  <strong>#{f.domainId}</strong> — {f.error}
                </div>
              ))}
            </div>,
          )}

        {/* Список, а не счётчик: «96 not started» из сотни доменов, упавшей на
            четвёртом, не позволяет собрать хвост для повтора — исходного порядка
            ста id пользователь не помнит, а другого входа в bulk, кроме ссылки
            со списком, нет. Решение «останавливаться на первой ошибке» куплено
            обещанием дешёвого повтора; вот его цена. */}
        {outcome.skipped.length > 0 &&
          section(`Not started (${outcome.skipped.length})`, idList(outcome.skipped))}

        <div style={{ fontSize: 11.5, color: "#9ca3af", wordBreak: "break-all" }}>
          Run key: {outcome.idempotencyKey}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <Btn variant="primary" onClick={onClose}>
          Done
        </Btn>
      </div>
    </Modal>
  );
}
