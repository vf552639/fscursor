import React, { ChangeEvent } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { Server } from "../../api/servers";

/**
 * Назначить сервер выделенным доменам.
 *
 * Выбранный сервер приезжает со страницы, а не живёт здесь: гасит его удачное
 * назначение (следующий набор доменов — следующий вопрос), а закрытие диалога —
 * нет. Закрыть его случайно легко, и выбор, сделанный в списке из сотни машин,
 * пропадать от этого не должен. Сам вызов мутации — тоже у страницы: она
 * владеет выделением и снимает его после удачи.
 */
export default function AssignServerDialog({
  selectedCount,
  servers,
  serverId,
  onServerChange,
  pending,
  onAssign,
  onClose,
}: {
  selectedCount: number;
  servers: Server[];
  serverId: string;
  onServerChange: (serverId: string) => void;
  pending: boolean;
  onAssign: (serverId: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Assign Server" onClose={onClose} width={400}>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить сервер для {selectedCount} доменов:</p>
      <Sel value={serverId} onChange={(e: ChangeEvent<HTMLSelectElement>) => onServerChange(e.target.value)} style={{width:"100%"}}>
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
