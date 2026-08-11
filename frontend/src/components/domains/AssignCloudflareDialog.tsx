import React, { useState, ChangeEvent } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { CloudflareAccount } from "../../api/cloudflare";

/**
 * Назначить аккаунт Cloudflare выделенным доменам.
 *
 * Устроен как `AssignServerDialog`: выбор живёт здесь и умирает вместе с
 * диалогом, вызов мутации — у страницы, которая владеет выделением.
 */
export default function AssignCloudflareDialog({
  selectedCount,
  cfAccounts,
  pending,
  onAssign,
  onClose,
}: {
  selectedCount: number;
  cfAccounts: CloudflareAccount[];
  pending: boolean;
  onAssign: (cfAccountId: string) => void;
  onClose: () => void;
}) {
  const [cfId, setCfId] = useState("");

  return (
    <Modal title="Assign Cloudflare" onClose={onClose} width={400}>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить Cloudflare аккаунт для {selectedCount} доменов:</p>
      <Sel value={cfId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setCfId(e.target.value)} style={{width:"100%"}}>
        <option value="">— Select CF Account —</option>
        {cfAccounts.map((c: CloudflareAccount) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Sel>
      <div style={{marginTop:18, display:"flex", gap:8}}>
        <Btn variant="primary" onClick={() => onAssign(cfId)} disabled={!cfId || pending}>
          {pending ? "Assigning..." : "Assign"}
        </Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}
