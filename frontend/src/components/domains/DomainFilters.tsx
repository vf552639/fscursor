import React from "react";

import { Card, Sel } from "../ui/Primitives";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { DOMAIN_STATUSES, domainStatusLabel } from "../../lib/domainStatus";

/**
 * Значения фильтров и их обработчики. Отдельный тип, потому что панель ничего
 * не помнит: и значения, и обработчики приезжают из `useDomainFilters` — по тем
 * же значениям он фильтрует список и пишет `?status=` в адрес.
 */
export interface DomainFilterControls {
  search: string;
  onSearchChange: (v: string) => void;
  serverId: string;
  onServerChange: (v: string) => void;
  registrarId: string;
  onRegistrarChange: (v: string) => void;
  cfId: string;
  onCfChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
}

/** Панель фильтров списка доменов. */
export default function DomainFilters({
  search, onSearchChange,
  serverId, onServerChange, servers,
  registrarId, onRegistrarChange, registrars,
  cfId, onCfChange, cfAccounts,
  status, onStatusChange,
}: DomainFilterControls & {
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}) {
  return <Card style={{marginBottom:16}}>
    <div style={{padding:"12px 16px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{position:"relative",flex:1,minWidth:180}}><span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span><input value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>onSearchChange(e.target.value)} placeholder="Search domains…" style={{width:"100%",padding:"7px 12px 7px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",background:"#f9fafb",boxSizing:"border-box",fontFamily:"inherit"}}/></div>
      <Sel value={serverId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onServerChange(e.target.value)}><option value="">All Servers</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel>
      <Sel value={registrarId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onRegistrarChange(e.target.value)}><option value="">All Registrars</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel>
      <Sel value={cfId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onCfChange(e.target.value)}><option value="">All CF</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
      {/* Пункты строятся из общей лестницы, а не перечислены руками: списком
          руками они и разошлись с бэкендом — в нём не было `ns_ok`, и домен в
          этом статусе нельзя было найти фильтром вовсе. */}
      <Sel value={status} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onStatusChange(e.target.value)}>
        <option value="">All Statuses</option>
        {DOMAIN_STATUSES.map((s)=><option key={s.status} value={s.status}>{domainStatusLabel(s.status)}</option>)}
      </Sel>
    </div>
  </Card>;
}
