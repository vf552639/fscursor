import React, { useState, useMemo, ChangeEvent, useEffect } from "react";
import { Card, Btn, Sel, Badge, Modal, StatusDot, fmtDate, Inp, RowActions, EmptyState, ErrorState } from "../components/ui/Primitives";
import { useDomains, useBulkCreateDomains, useBulkCreateStructuredDomains, useCreateDomain, useBulkAssignServer, useBulkAssignCloudflare, useBulkSetNameservers, useDeleteDomain, useUpdateDomain, useSetNameservers, Domain } from "../api/domains";
import { useServers, Server } from "../api/servers";
import { useRegistrarAccounts, RegistrarAccount } from "../api/registrars";
import { useCloudflareAccounts, useZoneDetails, useZoneNameservers, CloudflareAccount } from "../api/cloudflare";

interface AddDomainModalProps {
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}

interface DomainUI {
  id: number;
  domain: string;
  server_id: number | null;
  registrar_id: number | null;
  cf_id: number | null;
  cf_zone_id: string | null;
  ns_status: string;
  ns_updated_at: string | null;
  created: string;
}

export function AddDomainModal({onClose, servers, registrars, cfAccounts}: AddDomainModalProps){
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
    }, { onSuccess: () => onClose() });
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

interface EditDomainModalProps {
  domain: DomainUI;
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}

function EditDomainModal({ domain, onClose, servers, registrars, cfAccounts }: EditDomainModalProps) {
  const [name, setName] = useState(domain.domain);
  const [serverId, setServerId] = useState(domain.server_id ? String(domain.server_id) : "");
  const [registrarId, setRegistrarId] = useState(domain.registrar_id ? String(domain.registrar_id) : "");
  const [cfZoneId, setCfZoneId] = useState(domain.cf_zone_id || "");
  const setNameservers = useSetNameservers(domain.id);
  const { data: nameserversData, isLoading: isNameserversLoading, isError: isNameserversError } =
    useZoneNameservers(domain.cf_id, domain.cf_zone_id);
  const { data: zoneDetails, isLoading: isZoneLoading, isError: isZoneError } =
    useZoneDetails(domain.cf_id, domain.cf_zone_id);
  const update = useUpdateDomain(domain.id);

  const handleSave = () => {
    update.mutate(
      {
        domain_name: name.trim(),
        server_id: serverId ? Number(serverId) : null,
        registrar_id: registrarId ? Number(registrarId) : null,
        cloudflare_zone_id: cfZoneId || null,
      },
      { onSuccess: () => onClose() }
    );
  };

  return <Modal title={`Edit ${domain.domain}`} onClose={onClose} width={450}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: ChangeEvent<HTMLInputElement>)=>setName(e.target.value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Server</label><Sel value={serverId} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setServerId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Registrar</label><Sel value={registrarId} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setRegistrarId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Cloudflare Zone ID</label><Inp value={cfZoneId} onChange={(e: ChangeEvent<HTMLInputElement>)=>setCfZoneId(e.target.value)} placeholder={cfAccounts.length ? "Zone ID from Cloudflare" : "No CF accounts connected"} /></div>
      <div style={{border:"1px solid #e5e7eb", borderRadius:8, padding:12, background:"#fafafa"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:8}}>Nameservers (CF zone)</div>
        <div style={{fontSize:11.5,color:"#6b7280",marginBottom:8}}>
          CF zone status - статус делегирования у Cloudflare. NS push - статус применения NS у регистратора.
        </div>
        {!domain.cf_id || !domain.cf_zone_id ? null : (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <span style={{fontSize:12,color:"#6b7280"}}>CF Zone Status:</span>
            {isZoneLoading ? (
              <Badge variant="gray">Loading...</Badge>
            ) : isZoneError ? (
              <Badge variant="red">Failed to load zone status</Badge>
            ) : (
              <Badge
                variant={
                  zoneDetails?.status === "active"
                    ? "green"
                    : zoneDetails?.status === "pending"
                    ? "yellow"
                    : "gray"
                }
              >
                {zoneDetails?.status === "active"
                  ? "Active"
                  : zoneDetails?.status === "pending"
                  ? "Pending (NS не делегированы на CF)"
                  : zoneDetails?.status || "Unknown"}
              </Badge>
            )}
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:12,color:"#6b7280"}}>NS push to registrar:</span>
          <Badge variant={(domain.ns_status==="ok"?"green":domain.ns_status==="error"?"red":"yellow") as any}>
            {domain.ns_status==="ok"?"OK":domain.ns_status==="error"?"Error":"Pending"}
          </Badge>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>
          Updated: {domain.ns_updated_at ? fmtDate(domain.ns_updated_at) : "—"}
        </div>
        {!domain.cf_id || !domain.cf_zone_id ? (
          <div style={{fontSize:12.5,color:"#6b7280"}}>Nameservers - assign Cloudflare account first.</div>
        ) : (
          <>
            {isNameserversLoading ? (
              <div style={{fontSize:12.5,color:"#6b7280"}}>Loading nameservers...</div>
            ) : isNameserversError ? (
              <div style={{fontSize:12.5,color:"#dc2626"}}>Failed to load nameservers from Cloudflare.</div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {(nameserversData?.name_servers || []).length > 0 ? (
                  (nameserversData?.name_servers || []).map((ns) => (
                    <div key={ns} style={{fontSize:12.5,fontFamily:"monospace",color:"#374151"}}>• {ns}</div>
                  ))
                ) : (
                  <div style={{fontSize:12.5,color:"#6b7280"}}>No nameservers returned for this zone.</div>
                )}
              </div>
            )}
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => setNameservers.mutate()}
              disabled={setNameservers.isPending}
            >
              {setNameservers.isPending ? "Setting NS..." : "↺ Set NS"}
            </Btn>
          </>
        )}
      </div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      <Btn variant="primary" onClick={handleSave} disabled={update.isPending||!name.trim()} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{update.isPending ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

export default function Domains({ onNav, ctx }: { onNav?: (pg: string, ctx?: any) => void; ctx?: any }){
  const domainsQ = useDomains();
  const serversQ = useServers();
  const registrarsQ = useRegistrarAccounts();
  const cfAccountsQ = useCloudflareAccounts();

  const domainsData = domainsQ.data ?? [];
  const servers = serversQ.data?.items || [];
  const registrars = registrarsQ.data || [];
  const cfAccounts = cfAccountsQ.data || [];

  const domains = useMemo((): DomainUI[] => domainsData.map((d: Domain) => ({
    id: d.id,
    domain: d.domain_name,
    server_id: d.server_id,
    registrar_id: d.registrar_id,
    cf_id: d.cloudflare_account_id,
    cf_zone_id: d.cloudflare_zone_id,
    ns_status: d.ns_status || "pending",
    ns_updated_at: d.ns_updated_at,
    created: d.created_at,
  })), [domainsData]);

  const [search,setSearch]=useState(""); const [fSrv,setFS]=useState(""); const [fReg,setFR]=useState(""); const [fCF,setFCF]=useState("");
  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [editingDomain, setEditingDomain] = useState<DomainUI | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);

  const bulkAssignServer = useBulkAssignServer();
  const bulkAssignCF = useBulkAssignCloudflare();
  const bulkSetNs = useBulkSetNameservers();
  const deleteDomain = useDeleteDomain();

  useEffect(() => {
    if (ctx?.serverId) {
      setFS(String(ctx.serverId));
    }
    if (ctx?.domainId) {
      setFocusDomainId(Number(ctx.domainId));
      setSearch("");
    }
  }, [ctx]);

  const filtered = useMemo(() => domains.filter((d: DomainUI) => 
    (!search || d.domain.toLowerCase().includes(search.toLowerCase()) || String(d.id) === search) &&
    (!fSrv || d.server_id === Number(fSrv)) &&
    (!fReg || d.registrar_id === Number(fReg)) &&
    (!fCF || d.cf_id === Number(fCF)) &&
    (!focusDomainId || d.id === focusDomainId)
  ), [search, fSrv, fReg, fCF, focusDomainId, domains]);
  
  const toggle=(id: number)=>{setSel((p: Set<number>)=>{const s=new Set<number>(p);s.has(id)?s.delete(id):s.add(id);return s;});};
  const Th=({c,children}: {c?: string, children: React.ReactNode})=><th style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb",whiteSpace:"nowrap",...(c?{color:c}:{})}}>{children}</th>;
  
  const bulkCreate = useBulkCreateDomains();
  const bulkStructured = useBulkCreateStructuredDomains();
  const [bulkTab, setBulkTab] = useState("text");
  const [bulkText, setBulkText] = useState("");
  const [bulkRegId, setBulkRegId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [bulkError, setBulkError] = useState("");

  const handleBulkAdd = async () => {
    setBulkError("");
    try {
      if (bulkTab === "text") {
        const lines: string[] = bulkText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          setBulkError("Please enter at least one domain");
          return;
        }
        const result = await bulkCreate.mutateAsync({
          domains_text: lines.join("\n"),
          registrar_id: bulkRegId ? Number(bulkRegId) : null
        });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        setSB(false);
        setBulkText("");
        setBulkRegId("");
      } else {
        const lines: string[] = csvText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          setBulkError("Please enter at least one CSV line");
          return;
        }

        if (lines.some((l: string) => l.includes(',') && !l.includes(';'))) {
          setBulkError("Похоже, вы используете запятые вместо точек с запятой. Пожалуйста, исправьте разделитель.");
          return;
        }

        const items = lines.map((line: string) => {
          const parts = line.split(';');
          return {
            domain_name: parts[0]?.trim(),
            registrar_name: parts[1]?.trim() || null
          };
        }).filter((item: { domain_name: string }) => item.domain_name);

        if (items.length === 0) {
          setBulkError("No valid domains found in CSV");
          return;
        }

        const result = await bulkStructured.mutateAsync({ items });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        setSB(false);
        setCsvText("");
      }
    } catch (err: any) {
      setBulkError(err.response?.data?.message || err.message || "Failed to import domains");
    }
  }

  const handleAssignServer = () => {
    if (!assignServerId) return;
    bulkAssignServer.mutate(
      { domain_ids: Array.from(sel), server_id: Number(assignServerId) },
      { onSuccess: () => { setShowAssignServer(false); setSel(new Set()); setAssignServerId(""); } }
    );
  };

  const handleAssignCF = () => {
    if (!assignCFId) return;
    bulkAssignCF.mutate(
      { domain_ids: Array.from(sel), cloudflare_account_id: Number(assignCFId) },
      { onSuccess: () => { setShowAssignCF(false); setSel(new Set()); setAssignCFId(""); } }
    );
  };

  const handleSetNs = () => {
    bulkSetNs.mutate(Array.from(sel), {
      onSuccess: () => setSel(new Set())
    });
  };

  const handleBulkDelete = () => {
    if (!confirm(`Удалить ${sel.size} доменов?`)) return;
    Promise.all(Array.from(sel).map(id => deleteDomain.mutateAsync(id)))
      .then(() => setSel(new Set()));
  };

  if (domainsQ.isError) {
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Domains</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Domain inventory</div>
        </div>
        <ErrorState
          title="Backend unavailable or database schema is out of date"
          message="The domains list could not be loaded. If the API returned an error, the database may be missing migrations or the backend is down."
          hint="docker compose logs backend | grep -i alembic"
        />
      </div>
    );
  }

  if (domainsQ.isPending || serversQ.isPending || registrarsQ.isPending || cfAccountsQ.isPending) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading domains data...</div>;
  }

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
      <div><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Domains</h1><div style={{fontSize:13,color:"#6b7280"}}>{domains.length} domains total</div></div>
      <div style={{display:"flex",gap:8}}>
        <Btn variant="secondary" onClick={()=>setSB(true)}>⊕ Bulk Add</Btn>
        <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Domain</Btn>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
      {[
        ["Total",domains.length,"#2563eb","#eff4ff"],
        ["NS OK",domains.filter((d: any)=>d.ns_status==="ok").length,"#16a34a","#f0fdf4"],
        ["NS Pending",domains.filter((d: any)=>d.ns_status==="pending").length,"#d97706","#fffbeb"],
        ["NS Errors",domains.filter((d: any)=>d.ns_status==="error").length,"#dc2626","#fef2f2"]
      ].map(([l,v,c,bg])=>(
        <div key={l as string} style={{background:bg as string,border:"1px solid",borderColor:bg as string,borderRadius:10,padding:"14px 18px"}}><div style={{fontSize:22,fontWeight:700,color:c as string}}>{v as number}</div><div style={{fontSize:12,color:c as string,opacity:0.8}}>{l as string}</div></div>
      ))}
    </div>
    <Card style={{marginBottom:16}}>
      <div style={{padding:"12px 16px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{position:"relative",flex:1,minWidth:180}}><span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span><input value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setSearch(e.target.value)} placeholder="Search domains…" style={{width:"100%",padding:"7px 12px 7px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",background:"#f9fafb",boxSizing:"border-box",fontFamily:"inherit"}}/></div>
        <Sel value={fSrv} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFS(e.target.value)}><option value="">All Servers</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel>
        <Sel value={fReg} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFR(e.target.value)}><option value="">All Registrars</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel>
        <Sel value={fCF} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFCF(e.target.value)}><option value="">All CF</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
      </div>
    </Card>
    {sel.size>0&&<div style={{background:"#eff4ff",border:"1px solid #bfdbfe",borderRadius:10,padding:"10px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span style={{fontSize:13,fontWeight:600,color:"#2563eb"}}>{sel.size} selected</span>
      <Btn size="sm" variant="secondary" onClick={() => setShowAssignServer(true)}>Assign Server</Btn>
      <Btn size="sm" variant="secondary" onClick={() => setShowAssignCF(true)}>Assign CF</Btn>
      <Btn size="sm" variant="secondary" onClick={handleSetNs} disabled={bulkSetNs.isPending}>
        {bulkSetNs.isPending ? "Setting NS..." : "↺ Set NS"}
      </Btn>
      <Btn size="sm" variant="danger" style={{marginLeft:"auto"}} onClick={handleBulkDelete}>✕ Delete</Btn>
    </div>}
    <Card>
      <div style={{overflowX:"auto"}}>
        {domainsData.length === 0 ? (
          <EmptyState
            title="No domains yet"
            description="Add a domain or import many at once. An empty list means there are no rows in the database — not a failed request."
          >
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <Btn variant="secondary" onClick={() => setSB(true)}>
                ⊕ Bulk import
              </Btn>
              <Btn variant="primary" onClick={() => setSA(true)}>
                + Add Domain
              </Btn>
            </div>
          </EmptyState>
        ) : (
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr><th style={{padding:"10px 16px",width:36,background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}><input type="checkbox" checked={sel.size===filtered.length&&filtered.length>0} onChange={()=>setSel(sel.size===filtered.length?new Set():new Set(filtered.map((d: any)=>d.id)))} style={{cursor:"pointer"}}/></th>
            {["Domain","Server","Registrar","Cloudflare","SSL","Added",""].map((h: string)=><Th key={h}>{h}</Th>)}
          </tr></thead>
          <tbody>
            {filtered.length === 0 && domainsData.length > 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                  No domains match the current filters.
                </td>
              </tr>
            ) : null}
            {filtered.map((d: DomainUI)=>{
              const srv=servers.find((s: Server)=>s.id===d.server_id); const reg=registrars.find((r: RegistrarAccount)=>r.id===d.registrar_id); const cf=cfAccounts.find((c: CloudflareAccount)=>c.id===d.cf_id);
              const displayStatus = srv?.status === "active" ? "healthy" : (srv?.status || "warning") as any;
              const isFocused = focusDomainId === d.id;
              return <tr key={d.id} style={isFocused ? { background: "#eff4ff" } : undefined} onMouseEnter={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!isFocused) e.currentTarget.style.background="#fafbfc"; }} onMouseLeave={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!isFocused) e.currentTarget.style.background=""; }}>
                <td style={{padding:"11px 16px"}}><input type="checkbox" checked={sel.has(d.id)} onChange={()=>toggle(d.id)} style={{cursor:"pointer"}}/></td>
                <td style={{padding:"11px 16px"}}><div style={{fontWeight:600,fontSize:13.5,color:"#111"}}>{d.domain}</div></td>
                <td style={{padding:"11px 16px",fontSize:13}}>{srv?<span style={{display:"flex",alignItems:"center",gap:5}}><StatusDot status={displayStatus} size={7}/>{srv.name}</span>:<span style={{color:"#9ca3af"}}>—</span>}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:reg?"#111":"#9ca3af"}}>{reg?.provider||"—"}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:cf?"#111":"#9ca3af"}}>{cf?.name||"—"}</td>
                <td style={{padding:"11px 16px"}}><Badge variant="gray">— No SSL</Badge></td>
                <td style={{padding:"11px 16px",fontSize:12,color:"#9ca3af"}}>{fmtDate(d.created)}</td>
                <td style={{padding:"11px 16px"}}>
                  <RowActions actions={[
                    { icon: "✎", title: "Edit domain", onClick: () => setEditingDomain(d) },
                    { icon: "✕", title: "Delete domain", variant: "danger", onClick: () => { if (!confirm(`Delete ${d.domain}?`)) return; deleteDomain.mutate(d.id); } },
                  ]} />
                </td>
              </tr>;
            })}
          </tbody>
        </table>
        )}
      </div>
    </Card>

    {showAdd && <AddDomainModal onClose={()=>setSA(false)} servers={servers} registrars={registrars} cfAccounts={cfAccounts} />}
    {editingDomain && <EditDomainModal domain={editingDomain} servers={servers} registrars={registrars} cfAccounts={cfAccounts} onClose={() => setEditingDomain(null)} />}

    {showBulk&&<Modal title="Bulk Add Domains" onClose={()=>setSB(false)} width={520}>
      <div style={{display:"flex",background:"#f3f4f6",borderRadius:8,padding:3,marginBottom:20}}>
        {[["text","Plain Text"],["csv","CSV / Semicolon"]].map(([k,l])=>(
          <button key={k} onClick={()=>setBulkTab(k as string)} style={{flex:1,padding:"8px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,fontFamily:"inherit",transition:"all 0.15s",background:bulkTab===k?"#2563eb":"transparent",color:bulkTab===k?"#fff":"#6b7280"}}>{bulkTab===k&&"✓ "}{l}</button>
        ))}
      </div>
      
      {bulkTab === "text" ? <>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Enter one domain per line. Duplicates will be skipped.</p>
        <textarea value={bulkText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>setBulkText(e.target.value)} placeholder={"example.com\nshop.example.com\nblog.example.com"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr",gap:12,margin:"14px 0"}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign to Registrar</label><Sel value={bulkRegId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setBulkRegId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
        </div>
      </> : <>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Paste values in format: <code style={{background:"#eee",padding:2}}>domain.com;provider_name</code></p>
        <textarea value={csvText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>setCsvText(e.target.value)} placeholder={"example.com;Namecheap\nshop.com;Hostiq"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
      </>}
      
      {bulkError && <div style={{background:"#fef2f2",border:"1px solid #fee2e2",color:"#dc2626",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>❌ {bulkError}</div>}
      
      <Btn variant="primary" onClick={handleBulkAdd} disabled={bulkCreate.isPending || bulkStructured.isPending} style={{width:"100%",justifyContent:"center",padding:"10px 0", marginTop: 14}}>{(bulkCreate.isPending || bulkStructured.isPending) ? "Importing..." : "Import Domains"}</Btn>
      <div style={{marginTop:8}}><Btn variant="secondary" onClick={()=>setSB(false)} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
    </Modal>}

    {showAssignServer && (
      <Modal title="Assign Server" onClose={() => setShowAssignServer(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить сервер для {sel.size} доменов:</p>
        <Sel value={assignServerId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignServerId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select Server —</option>
          {servers.map((s: Server) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignServer} disabled={!assignServerId || bulkAssignServer.isPending}>
            {bulkAssignServer.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignServer(false)}>Cancel</Btn>
        </div>
      </Modal>
    )}

    {showAssignCF && (
      <Modal title="Assign Cloudflare" onClose={() => setShowAssignCF(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить Cloudflare аккаунт для {sel.size} доменов:</p>
        <Sel value={assignCFId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignCFId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select CF Account —</option>
          {cfAccounts.map((c: CloudflareAccount) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignCF} disabled={!assignCFId || bulkAssignCF.isPending}>
            {bulkAssignCF.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignCF(false)}>Cancel</Btn>
        </div>
      </Modal>
    )}
  </>;
}
