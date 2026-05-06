import React, { useState } from "react";

import { CloudflareAccount } from "../api/cloudflare";
import { BulkFullSetupPayload } from "../api/domains";
import { RegistrarAccount } from "../api/registrars";
import { Server } from "../api/servers";
import { Btn, Modal, Sel } from "./ui/Primitives";
import { OpenInDesktop } from "./OpenInDesktop";
import { isTauri } from "../lib/runtime";

export default function BulkSetupWizard({
  selectedCount,
  selectedDomainIds = [],
  servers,
  cfAccounts,
  registrars,
  isRunning,
  onClose,
  onRun,
}: {
  selectedCount: number;
  selectedDomainIds?: number[];
  servers: Server[];
  cfAccounts: CloudflareAccount[];
  registrars: RegistrarAccount[];
  isRunning?: boolean;
  onClose: () => void;
  onRun: (payload: Omit<BulkFullSetupPayload, "domain_ids">) => void;
}) {
  const [serverId, setServerId] = useState("");
  const [cfId, setCfId] = useState("");
  const [registrarId, setRegistrarId] = useState("");

  return (
    <Modal title="Bulk Full Setup" onClose={onClose} width={480}>
      <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>
        {selectedCount} domains will be assigned to server, linked to Cloudflare, zone-created, and NS-pushed.
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>Server (required)</label>
          <Sel value={serverId} onChange={(e: any) => setServerId(e.target.value)} style={{ width: "100%" }}>
            <option value="">— Select server —</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Sel>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>Cloudflare account (required)</label>
          <Sel value={cfId} onChange={(e: any) => setCfId(e.target.value)} style={{ width: "100%" }}>
            <option value="">— Select Cloudflare account —</option>
            {cfAccounts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Sel>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>Registrar (optional)</label>
          <Sel value={registrarId} onChange={(e: any) => setRegistrarId(e.target.value)} style={{ width: "100%" }}>
            <option value="">— Keep current / skip push if missing —</option>
            {registrars.map((r) => (
              <option key={r.id} value={r.id}>{r.provider} - {r.name}</option>
            ))}
          </Sel>
        </div>
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
        {isTauri() ? (
          <Btn
            variant="primary"
            onClick={() =>
              onRun({
                server_id: Number(serverId),
                cloudflare_account_id: Number(cfId),
                registrar_id: registrarId ? Number(registrarId) : null,
              })
            }
            disabled={!serverId || !cfId || isRunning}
          >
            {isRunning ? "Running..." : "Run Full Setup"}
          </Btn>
        ) : (
          <OpenInDesktop
            variant="primary"
            action={`bulk-full-setup?ids=${selectedDomainIds.join(",")}`}
            label={isRunning ? "Running..." : "Open full setup in desktop"}
            desktopOnClick={() =>
              onRun({
                server_id: Number(serverId),
                cloudflare_account_id: Number(cfId),
                registrar_id: registrarId ? Number(registrarId) : null,
              })
            }
            disabled={!serverId || !cfId || isRunning || selectedDomainIds.length === 0}
          />
        )}
        <Btn variant="secondary" onClick={onClose} disabled={isRunning}>
          Cancel
        </Btn>
      </div>
    </Modal>
  );
}
