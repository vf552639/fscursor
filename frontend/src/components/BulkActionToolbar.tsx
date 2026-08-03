import React from "react";

import { OpenInDesktop } from "./OpenInDesktop";
import { isTauri } from "../lib/runtime";

function idsQuery(ids: number[]): string {
  return ids.length ? `?ids=${ids.map((n) => String(n)).join(",")}` : "";
}

export default function BulkActionToolbar({
  selectedCount,
  selectedDomainIds = [],
  onAssignServer,
  onAssignCF,
  onCheckNs,
  onMarkNsSet,
  onProvision,
  onBulkRefreshSsl,
  onFullSetup,
  onDelete,
  pending,
}: {
  selectedCount: number;
  /** Selected domain IDs for `sdmp://…?ids=` deep links on web. */
  selectedDomainIds?: number[];
  onAssignServer: () => void;
  onAssignCF: () => void;
  onCheckNs?: () => void;
  onMarkNsSet?: () => void;
  onProvision: () => void;
  onBulkRefreshSsl?: () => void;
  onFullSetup?: () => void;
  onDelete: () => void;
  pending?: boolean;
}) {
  if (selectedCount <= 0) return null;

  const q = idsQuery(selectedDomainIds);
  const webBulkDisabled = !isTauri() && selectedDomainIds.length === 0;

  return (
    <div
      style={{
        background: "#eff4ff",
        border: "1px solid #bfdbfe",
        borderRadius: 10,
        padding: "10px 16px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "#2563eb" }}>{selectedCount} selected</span>
      <OpenInDesktop
        action={`assign-server${q}`}
        label="Assign Server"
        desktopOnClick={onAssignServer}
        disabled={Boolean(pending)}
      />
      <OpenInDesktop
        action={`assign-cf${q}`}
        label="Assign CF"
        desktopOnClick={onAssignCF}
        disabled={Boolean(pending)}
      />
      {/* Массового «Set NS» здесь намеренно нет: `POST /domains/bulk-set-ns` на
          бэкенде не существует, а `sdmp://set-ns` не разбирает
          parseDeepLinkAction — кнопка вела в никуда в обеих средах. Смена NS
          пачкой — это не проброс кнопки: команде `registrar_set_nameservers`
          нужен свой список NS на каждый домен (у каждого — своя зона
          Cloudflare, возможно в другом аккаунте) плюс отчёт по каждому. Это
          отдельная функция со своим планом, а не достижимость. NS одного домена
          ставятся во вкладке NS его карточки. */}
      {onCheckNs ? (
        <OpenInDesktop
          action={`check-ns${q}`}
          label="Check NS"
          desktopOnClick={onCheckNs}
          disabled={Boolean(pending)}
        />
      ) : null}
      {onMarkNsSet ? (
        <OpenInDesktop
          action={`mark-ns-set${q}`}
          label="Mark NS Set"
          desktopOnClick={onMarkNsSet}
          disabled={Boolean(pending)}
        />
      ) : null}
      {onBulkRefreshSsl ? (
        <OpenInDesktop
          action={`refresh-ssl${q}`}
          label="Refresh SSL"
          desktopOnClick={onBulkRefreshSsl}
          disabled={Boolean(pending)}
        />
      ) : null}
      {onFullSetup ? (
        <OpenInDesktop
          action={`bulk-full-setup${q}`}
          label="Full Setup"
          variant="primary"
          desktopOnClick={onFullSetup}
          disabled={Boolean(pending) || webBulkDisabled}
        />
      ) : null}
      <OpenInDesktop
        action={`bulk-provision${q}`}
        label="Provision"
        desktopOnClick={onProvision}
        disabled={Boolean(pending) || webBulkDisabled}
      />
      <div style={{ marginLeft: "auto" }}>
        <OpenInDesktop action={`bulk-delete${q}`} label="Delete" variant="danger" desktopOnClick={onDelete} />
      </div>
    </div>
  );
}
