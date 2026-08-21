import React, { ChangeEvent } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { Server } from "../../api/servers";
import { domainWord } from "../../lib/format";

/**
 * Назначить сервер выделенным доменам.
 *
 * Выбранный сервер приезжает со страницы, а не живёт здесь: гасит его удачное
 * назначение (следующий набор доменов — следующий вопрос), а закрытие диалога —
 * нет. Закрыть его случайно легко, и выбор, сделанный в списке из сотни машин,
 * пропадать от этого не должен. Сам вызов мутации — тоже у страницы: она
 * владеет выделением и снимает его после удачи.
 *
 * Там же и вопрос про переезд (`describeServerBinding`): чтобы назвать цену,
 * надо знать, у кого из выделенных СЕЙЧАС стоит другой сервер, — а сюда едет
 * одно число `selectedCount`, по которому это неотличимо.
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
      {/* Число и слово — общим `domainWord`, а не шаблоном «domains»: «1
          domains» — опечатка, живущая вечно. Русское склонение из функции ушло
          вместе с переводом вкладки, но сама она осталась: единственное число
          по-английски тоже отдельное слово, и мест, где его надо назвать, три. */}
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Assign a server to {selectedCount} {domainWord(selectedCount)}:</p>
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
