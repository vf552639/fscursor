import React from "react";

import { Btn } from "./ui/Primitives";

export default function BulkActionToolbar({
  selectedCount,
  onAssignServer,
  onAssignCF,
  onSetNs,
  onCheckNs,
  onMarkNsSet,
  onProvision,
  onBulkRefreshSsl,
  onFullSetup,
  onDelete,
  pending,
}: {
  selectedCount: number;
  onAssignServer: () => void;
  onAssignCF: () => void;
  onSetNs: () => void;
  onCheckNs?: () => void;
  onMarkNsSet?: () => void;
  onProvision: () => void;
  onBulkRefreshSsl?: () => void;
  onFullSetup?: () => void;
  onDelete: () => void;
  pending?: boolean;
}) {
  if (selectedCount <= 0) return null;
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
      <span style={{ fontSize: 13, fontWeight: 600, color: "#2563eb" }}>
        {selectedCount} selected
      </span>
      <Btn size="sm" variant="secondary" onClick={onAssignServer}>
        Assign Server
      </Btn>
      <Btn size="sm" variant="secondary" onClick={onAssignCF}>
        Assign CF
      </Btn>
      <Btn size="sm" variant="secondary" onClick={onSetNs} disabled={pending}>
        Set NS
      </Btn>
      {onCheckNs ? (
        <Btn size="sm" variant="secondary" onClick={onCheckNs} disabled={pending}>
          Check NS
        </Btn>
      ) : null}
      {onMarkNsSet ? (
        <Btn size="sm" variant="secondary" onClick={onMarkNsSet} disabled={pending}>
          Mark NS Set
        </Btn>
      ) : null}
      {onBulkRefreshSsl ? (
        <Btn size="sm" variant="secondary" onClick={onBulkRefreshSsl} disabled={pending}>
          Refresh SSL
        </Btn>
      ) : null}
      {onFullSetup ? (
        <Btn size="sm" variant="primary" onClick={onFullSetup} disabled={pending}>
          Full Setup
        </Btn>
      ) : null}
      <Btn size="sm" variant="secondary" onClick={onProvision} disabled={pending}>
        Provision
      </Btn>
      <Btn size="sm" variant="danger" style={{ marginLeft: "auto" }} onClick={onDelete}>
        Delete
      </Btn>
    </div>
  );
}
