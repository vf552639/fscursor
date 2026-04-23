import React, { useState } from "react";
import { StatCard, Card, CHd, CTi, CBo, Btn, StatusDot, Badge, MiniChart, fmtDate, cpuColor, genBars, InfoRow, CopyBtn, Modal, Inp, RowActions } from "../components/ui/Primitives";
import { useServer, useDeleteServer, useTestSsh, useInstallFastPanel, useFastPanelStatus, useUpdateServer } from "../api/servers";
import { useDomains, useDeleteDomain, useUpdateDomain } from "../api/domains";

export default function ServerDetail({server, onBack, onNav}: {server?: any, onBack: (p: string)=>void, onNav?: (p: string, ctx?: any)=>void}){
  const [tab,setTab]=useState("overview");
  const [domSearch,setDS]=useState("");
  const [showPass,setShowPass]=useState(false);
  
  const [showSshModal, setShowSshModal] = useState(false);
  const [sshUser, setSshUser] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [editingDomain, setEditingDomain] = useState<any | null>(null);

  // Queries
  const { data: s } = useServer(server?.id);
  const { data: domainsData } = useDomains({ server_id: server?.id });
  const domains = domainsData?.items || [];
  
  // FastPanel setup
  const isFPInstalled = s?.fastpanel_status === "installed";
  const isFPPending = s?.fastpanel_status === "pending" || s?.fastpanel_status === "updating" || s?.fastpanel_status === "installing";
  const { data: fpStatus } = useFastPanelStatus(s?.id, isFPPending);
  
  // Mutations
  const delSrv = useDeleteServer();
  const testSsh = useTestSsh(server?.id || 0);
  const installFp = useInstallFastPanel(server?.id || 0);
  const updateServer = useUpdateServer(server?.id || 0);
  const deleteDomain = useDeleteDomain();
  const updateDomain = useUpdateDomain(editingDomain?.id || 0);

  const handleSaveSsh = () => {
    updateServer.mutate({
      ssh_user: sshUser,
      ssh_password: sshPassword,
      ssh_port: sshPort
    }, {
      onSuccess: () => setShowSshModal(false)
    });
  };

  const handleDelete = () => {
    if(confirm("Delete server?")) {
      delSrv.mutate(s!.id, { onSuccess: () => onBack("servers") });
    }
  };

  if (!s) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading server details...</div>;

  const fp = {
    url: s.fastpanel_url || `https://${s.ip_address}:8888`,
    login: s.fastpanel_user || "fastuser",
    password: "encrypted (hidden)", // Actual password not sent via API 
    version: "Unknown",
    port: 8888
  };
  
  const filtered = domains.filter((d: any)=>d.domain_name.toLowerCase().includes(domSearch.toLowerCase()));
  
  // Mocks for metrics since backend doesn't track live metrics yet
  const cpuD=genBars(0); const ramD=genBars(0); const ssdD=genBars(0); const netD=genBars(0);
  const displayStatus = s.status === "active" ? "healthy" : s.status;

  return <>
    <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#9ca3af",marginBottom:20}}>
      <span onClick={()=>onBack("servers")} style={{cursor:"pointer"}}>Servers</span><span>/</span>
      <span style={{color:"#111",fontWeight:500}}>{s.name}</span>
    </div>
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:24}}>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}><StatusDot status={displayStatus}/><h1 style={{fontSize:22,fontWeight:700,color:"#111"}}>{s.name}</h1><Badge variant="gray">{(s.os||"Unknown").toUpperCase()}</Badge>{isFPInstalled&&<Badge variant="blue">FASTPANEL</Badge>}</div>
        <div style={{fontSize:13,color:"#6b7280"}}>{s.ip_address} · - · Added {fmtDate(s.created_at)}</div>
        <button onClick={() => onNav?.("domains", { serverId: s.id })} style={{marginTop:8,border:"none",background:"transparent",padding:0,color:"#2563eb",fontSize:12.5,cursor:"pointer"}}>See all server domains in Domains →</button>
      </div>
      <div style={{display:"flex",gap:8}}>
        {s.has_ssh && <Btn variant="secondary" onClick={()=>testSsh.mutate()} disabled={testSsh.isPending}>{testSsh.isPending ? "Testing..." : "SSH Test"}</Btn>}
        <Btn variant="danger" onClick={handleDelete} disabled={delSrv.isPending}>✕ Delete</Btn>
      </div>
    </div>

    {!s.has_ssh && (
      <div style={{background:"#fffbeb", border:"1px solid #fde68a", borderRadius:10, padding:"14px 18px", marginBottom:20, display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <div>
          <div style={{fontWeight:600, fontSize:14, color:"#92400e", marginBottom:2}}>⚠ SSH-доступ не настроен</div>
          <div style={{fontSize:13, color:"#a16207"}}>Для мониторинга uptime, CPU и диска необходимо добавить SSH-данные.</div>
        </div>
        <Btn variant="primary" size="sm" onClick={()=>setShowSshModal(true)}>Добавить SSH</Btn>
      </div>
    )}

    {testSsh.data && <div style={{marginBottom:20, padding: 12, borderRadius: 8, background: testSsh.data.success ? "#dcfce7" : "#fee2e2", color: testSsh.data.success ? "#166534" : "#991b1b", fontSize: 13}}>SSH Test: {testSsh.data.message}</div>}

    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:20}}>
      <StatCard label="CPU Usage" value={`0%`} sub={`Normal · ? vCPU`} pct={0} color={cpuColor(0)} chartData={cpuD}/>
      <StatCard label="RAM Usage" value={`0 GB`} sub={`of 4 GB`} pct={0} color="#7c3aed" chartData={ramD}/>
      <StatCard label="SSD Usage" value={`0 GB`} sub={`of 20 GB`} pct={0} color="#0891b2" chartData={ssdD}/>
      <StatCard label="Network In" value="0 MB/s" sub="Out: 0 MB/s" pct={0} color="#059669" chartData={netD}/>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
      <div>
        {isFPInstalled && <Card style={{marginBottom:16}}>
          <CHd><CTi>⚡ FastPanel Access <Badge variant="blue">v{fp.version}</Badge></CTi><Btn variant="primary" size="sm" onClick={()=>window.open(fp.url)}>↗ Open FastPanel</Btn></CHd>
          <CBo>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><div style={{flex:1,padding:"10px 14px",background:"#eff4ff",border:"1px solid #bfdbfe",borderRadius:8,fontSize:13,color:"#2563eb",fontWeight:500}}>{fp.url}</div><CopyBtn value={fp.url}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {[
                {label:"Login",val:fp.login,pw:false},
                {label:"Password",val:fp.password,pw:true},
                {label:"Port",val:String(fp.port),pw:false},
                {label:"Protocol",val:"HTTPS",pw:false}
              ].map((f, i)=>(
                <div key={i}>
                  <label style={{fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.5px",display:"block",marginBottom:6}}>{f.label}</label>
                  <div style={{display:"flex",gap:6}}>
                    <div style={{flex:1,padding:"8px 12px",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",fontWeight:500,letterSpacing:f.pw&&!showPass?"3px":"normal"}}>{f.pw?(showPass?f.val:"•".repeat(f.val.length)):f.val}</div>
                    {f.pw&&<button onClick={()=>setShowPass(p=>!p)} style={{padding:"8px 10px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,color:"#6b7280"}}>{showPass?"🙈":"👁"}</button>}
                    <CopyBtn value={f.val}/>
                  </div>
                </div>
              ))}
            </div>
          </CBo>
        </Card>}

        {!isFPInstalled && <Card style={{marginBottom:16}}>
          <CHd><CTi>⚡ FastPanel Installation</CTi></CHd>
          <CBo>
            {isFPPending ? (
              <div style={{padding: 10, background:"#f3f4f6", borderRadius:8, fontFamily: "monospace", fontSize:12, whiteSpace:"pre-wrap"}}>
                Status: {s.fastpanel_status}
                {fpStatus?.log_tail?.join("\n")}
              </div>
            ) : (
              <Btn variant="primary" onClick={()=>installFp.mutate()} disabled={installFp.isPending}>
                {installFp.isPending ? "Starting..." : "Install FastPanel"}
              </Btn>
            )}
          </CBo>
        </Card>}

        <Card>
          <CHd><CTi>🖥 Server Information</CTi></CHd>
          <CBo style={{padding:"6px 20px 14px"}}>
            {[
              ["Name",s.name],
              ["IP",s.ip_address],
              ["OS",s.os || "Unknown"],
              ["Status",<Badge key="status" variant={displayStatus==="healthy"?"green":displayStatus==="warning"?"yellow":"red"}>{s.status}</Badge>],
              ["Added",fmtDate(s.created_at)]
            ].map(([k,v], i)=><InfoRow key={i} k={k} v={v}/>)}
          </CBo>
        </Card>
      </div>
      <Card>
        <CHd style={{padding:"0 20px",alignItems:"stretch",gap:0}}>
          <div style={{display:"flex",gap:0,flex:1}}>
            {["overview"].map((k)=>(
              <div key={k} onClick={()=>setTab(k)} style={{padding:"14px 16px",fontSize:13.5,fontWeight:500,cursor:"pointer",borderBottom:`2px solid ${tab===k?"#2563eb":"transparent"}`,color:tab===k?"#2563eb":"#6b7280",whiteSpace:"nowrap"}}>Domains ({domains.length})</div>
            ))}
          </div>
        </CHd>
        <div style={{padding:"10px 16px",borderBottom:"1px solid #e5e7eb",position:"relative"}}>
          <span style={{position:"absolute",left:26,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span>
          <input value={domSearch} onChange={e=>setDS(e.target.value)} placeholder="Filter domains…" style={{width:"100%",padding:"7px 12px 7px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",background:"#f9fafb",boxSizing:"border-box",fontFamily:"inherit"}}/>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{background:"#f9fafb"}}>
              {["Domain","Status","NS",""].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.4px",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filtered.map((d: any)=><tr key={d.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                <td style={{padding:"10px 14px",fontWeight:600,fontSize:13,color:"#111"}}>{d.domain_name}</td><td style={{padding:"10px 14px"}}><Badge variant="gray">{d.status}</Badge></td><td style={{padding:"10px 14px"}}><Badge variant={d.ns_status==="ok"?"green":d.ns_status==="error"?"red":"yellow"}>{d.ns_status==="ok"?"✓":"⏳"}</Badge></td><td style={{padding:"10px 14px"}}><RowActions actions={[
                  { icon: "✎", title: "Edit domain", onClick: () => setEditingDomain(d) },
                  { icon: "✕", title: "Delete domain", variant: "danger", onClick: () => { if (!confirm(`Delete ${d.domain_name}?`)) return; deleteDomain.mutate(d.id); } },
                ]}/></td>
              </tr>)}
              {filtered.length===0&&<tr><td colSpan={6} style={{padding:"28px",textAlign:"center",color:"#9ca3af",fontSize:13}}>No domains found</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>

    {showSshModal && (
      <Modal title="Добавить SSH-доступ" onClose={()=>setShowSshModal(false)} width={420}>
        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH User</label><Inp value={sshUser} onChange={e=>setSshUser((e.target as any).value)} placeholder="e.g., root"/></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Password</label><Inp type="password" value={sshPassword} onChange={e=>setSshPassword((e.target as any).value)} placeholder="••••••••"/></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Port</label><Inp type="number" value={sshPort} onChange={e=>setSshPort(Number((e.target as any).value))} placeholder="22"/></div>
        </div>
        <div style={{marginTop:22}}>
          <Btn variant="primary" onClick={handleSaveSsh} disabled={updateServer.isPending} style={{width:"100%",justifyContent:"center"}}>{updateServer.isPending ? "Saving..." : "Save"}</Btn>
        </div>
      </Modal>
    )}
    {editingDomain && (
      <Modal title={`Edit ${editingDomain.domain_name}`} onClose={()=>setEditingDomain(null)} width={450}>
        <DomainEditor
          domain={editingDomain}
          onCancel={() => setEditingDomain(null)}
          onSave={(payload) => updateDomain.mutate(payload, { onSuccess: () => setEditingDomain(null) })}
          isSaving={updateDomain.isPending}
        />
      </Modal>
    )}
  </>;
}

function DomainEditor({ domain, onSave, onCancel, isSaving }: { domain: any; onSave: (payload: any) => void; onCancel: () => void; isSaving: boolean }) {
  const [name, setName] = useState(domain.domain_name || "");
  const [purchaseDate, setPurchaseDate] = useState(domain.purchase_date || "");
  const [expiryDate, setExpiryDate] = useState(domain.expiry_date || "");
  const [zoneId, setZoneId] = useState(domain.cloudflare_zone_id || "");

  return (
    <>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={e=>setName((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Purchase Date</label><Inp type="date" value={purchaseDate} onChange={e=>setPurchaseDate((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Expiry Date</label><Inp type="date" value={expiryDate} onChange={e=>setExpiryDate((e.target as any).value)} /></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Cloudflare Zone ID</label><Inp value={zoneId} onChange={e=>setZoneId((e.target as any).value)} /></div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
        <Btn variant="primary" disabled={isSaving || !name.trim()} onClick={() => onSave({ domain_name: name.trim(), purchase_date: purchaseDate || null, expiry_date: expiryDate || null, cloudflare_zone_id: zoneId || null })} style={{width:"100%",justifyContent:"center"}}>{isSaving ? "Saving..." : "Save"}</Btn>
        <Btn variant="secondary" onClick={onCancel} disabled={isSaving} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
      </div>
    </>
  );
}
