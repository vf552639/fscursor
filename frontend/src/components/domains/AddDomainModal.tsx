import React, { useState, ChangeEvent } from "react";

import { Btn, Sel, Modal, Inp } from "../ui/Primitives";
import { useCreateDomain, Domain } from "../../api/domains";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";

interface AddDomainModalProps {
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  /**
   * Созданная строка домена — наверх, странице.
   *
   * Автопривязку к зоне Cloudflare запускает НЕ модалка, хотя создаёт домен
   * именно она: модалка закрывается тем же успехом, а прогон живёт секунды и
   * должен договорить (`api/cfAutoBind.ts`). Отдавать наверх строку, а не
   * отчёт, — потому что решение «привязывать ли» принадлежит странице: она
   * одинаково поступает и с одиночным созданием, и с bulk-добавлением.
   */
  onCreated: (domain: Domain) => void;
}

export function AddDomainModal({onClose, servers, registrars, cfAccounts, onCreated}: AddDomainModalProps){
  const [name, setName]=useState("");
  const [sid, setSid]=useState("");
  const [rid, setRid]=useState("");
  const [cfid, setCfid]=useState("");
  const create = useCreateDomain();

  const handleAdd = () => {
    create.mutate({
      domain_name: name,
      server_id: sid ? Number(sid) : null,
      registrar_id: rid ? Number(rid) : null,
      cloudflare_account_id: cfid ? Number(cfid) : null
    }, {
      onSuccess: (created) => {
        onClose();
        // Домен уже создан — это главный результат, и он состоялся. Всё, что
        // делает страница дальше (привязка к зоне), от него отделено: её
        // ошибки не должны выглядеть как провал создания.
        onCreated(created);
      },
    });
  };

  return <Modal title="Add Domain" onClose={onClose} width={450}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: ChangeEvent<HTMLInputElement>)=>setName(e.target.value)} placeholder="e.g., example.com"/></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Server</label><Sel value={sid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setSid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Registrar</label><Sel value={rid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setRid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Cloudflare Account</label><Sel value={cfid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setCfid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      <Btn variant="primary" onClick={handleAdd} disabled={create.isPending||!name} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{create.isPending ? "Adding..." : "Add Domain"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
