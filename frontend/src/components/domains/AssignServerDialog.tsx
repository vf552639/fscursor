import React, { useState, ChangeEvent } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { Server } from "../../api/servers";

/**
 * Назначить сервер выделенным доменам.
 *
 * Выбранный сервер живёт здесь и умирает вместе с диалогом: следующий набор
 * доменов — следующий вопрос, и подставленный ответ на прошлый ему только
 * мешает. Сам вызов мутации — у страницы: она же владеет выделением и снимает
 * его после удачи.
 */
export default function AssignServerDialog({
  selectedCount,
  servers,
  pending,
  onAssign,
  onClose,
}: {
  selectedCount: number;
  servers: Server[];
  pending: boolean;
  onAssign: (serverId: string) => void;
  onClose: () => void;
}) {
  const [serverId, setServerId] = useState("");

  return (
    <Modal title="Assign Server" onClose={onClose} width={400}>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить сервер для {selectedCount} доменов:</p>
      <Sel value={serverId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setServerId(e.target.value)} style={{width:"100%"}}>
        <option value="">— Select Server —</option>
        {servers.map((s: Server) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Sel>
      <div style={{marginTop:18, display:"flex", gap:8}}>
        <Btn variant="primary" onClick={() => onAssign(serverId)} disabled={!serverId || pending}>
          {pending ? "Assigning..." : "Assign"}
        </Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}
