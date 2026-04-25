import React, { useState } from "react";
import { Card, CHd, CTi, Btn, StatCard, Badge, Modal, Inp, Sel, RowActions, EmptyState, ErrorState } from "../components/ui/Primitives";
import { 
  useCloudflareAccounts, 
  useCreateCloudflareAccount, 
  useUpdateCloudflareAccount,
  useDeleteCloudflareAccount,
  useTestCloudflareAccount,
  useDnsRecords,
  usePurgeCache,
  useCreateDnsRecord,
  useUpdateDnsRecord,
  useDeleteDnsRecord,
  useZoneNameservers,
} from "../api/cloudflare";

function AccountCard({
  acc,
  onEdit,
  onDelete,
  onTest,
  testStatus,
}: {
  acc: any;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  testStatus?: { state: "idle" | "loading" | "success" | "error"; message?: string };
}) {

  return (
    <Card style={{marginBottom:16}}>
      <CHd>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:36,height:36,background:"#fff7ed",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>☁</div>
          <div><div style={{fontSize:14,fontWeight:700,color:"#111"}}>{acc.name}</div><div style={{fontSize:12,color:"#6b7280"}}>{acc.account_id || "-"}</div></div>
          <Badge variant={acc.is_active?"green":"gray"}>{acc.is_active?"Active":"Inactive"}</Badge>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn size="sm" variant="secondary" onClick={onTest} disabled={testStatus?.state === "loading"}>
            {testStatus?.state === "loading" ? "Testing..." : "Test connection"}
          </Btn>
          <Btn size="sm" variant="secondary" onClick={onEdit}>✎ Edit</Btn>
          <Btn size="sm" variant="danger" onClick={onDelete}>✕</Btn>
        </div>
      </CHd>
      {testStatus?.state === "success" && (
        <div style={{padding:"10px 20px", borderTop:"1px solid #f3f4f6", color:"#16a34a", fontSize:12.5}}>
          ✓ {testStatus.message || "Token verified"}
        </div>
      )}
      {testStatus?.state === "error" && (
        <div style={{padding:"10px 20px", borderTop:"1px solid #f3f4f6", color:"#dc2626", fontSize:12.5}}>
          {testStatus.message || "Connection test failed"}
        </div>
      )}
    </Card>
  );
}

export default function Cloudflare({ onNav }: { onNav?: (pg: string, ctx?: any) => void }){
  const { data: cfAccountsData, isPending, isError, error } = useCloudflareAccounts();
  const createAcc = useCreateCloudflareAccount();
  const deleteAcc = useDeleteCloudflareAccount();
  const testAcc = useTestCloudflareAccount();
  const cfAccounts = cfAccountsData || [];
  
  const [showAddAcc,setShowAcc]=useState(false);
  const [showDns,setShowDns]=useState(false);
  const dnsTypes: Record<string, string>={A:"#2563eb",AAAA:"#7c3aed",CNAME:"#059669",MX:"#d97706",TXT:"#6b7280",NS:"#dc2626"};
  
  const [accName, setAccName] = useState("");
  const [accId, setAccId] = useState("");
  const [accToken, setAccToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingAcc, setEditingAcc] = useState<any | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ kind: "success" | "warning"; text: string } | null>(null);
  const [testState, setTestState] = useState<Record<number, { state: "idle" | "loading" | "success" | "error"; message?: string }>>({});

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!accName.trim()) newErrors.name = "Account Name is required";
    if (!accToken.trim()) newErrors.token = "API Token is required";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddAcc = () => {
    if (!validate()) return;
    
    createAcc.mutate({
      name: accName,
      account_id: accId,
      api_token: accToken
    }, {
      onSuccess: (created) => {
        setShowAcc(false);
        setAccName(""); setAccId(""); setAccToken("");
        setErrors({});
        if (created.sync_result) {
          setStatusMessage({
            kind: "success",
            text: `Linked Cloudflare to ${created.sync_result.updated} existing domains. ${created.sync_result.skipped} zones had no matching domain in the service.`,
          });
        } else {
          setStatusMessage({
            kind: "warning",
            text: created.sync_warning || "Account created, but zone sync did not complete.",
          });
        }
      }
    })
  };
  const handleTest = (accountId: number) => {
    setTestState((prev) => ({ ...prev, [accountId]: { state: "loading" } }));
    testAcc.mutate(accountId, {
      onSuccess: (res) => {
        const nextState = res.success ? "success" : "error";
        setTestState((prev) => ({ ...prev, [accountId]: { state: nextState, message: res.message } }));
        if (res.success) {
          setTimeout(() => {
            setTestState((prev) => ({ ...prev, [accountId]: { state: "idle" } }));
          }, 3000);
        }
      },
      onError: (err: any) => {
        setTestState((prev) => ({
          ...prev,
          [accountId]: { state: "error", message: String(err?.message || "Connection test failed") },
        }));
      },
    });
  };

  if (isError) {
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Cloudflare</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Accounts</div>
        </div>
        <ErrorState
          title="Не удалось загрузить Cloudflare-аккаунты"
          message={String((error as any)?.message ?? "Backend вернул ошибку.")}
          hint="docker compose logs backend --tail 100"
        />
      </div>
    );
  }

  if (isPending) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading Cloudflare accounts...</div>;

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
      <div><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Cloudflare</h1><div style={{fontSize:13,color:"#6b7280"}}>{cfAccounts.length} accounts connected</div></div>
      <Btn variant="primary" onClick={()=>setShowAcc(true)}>+ Add Account</Btn>
    </div>
    {statusMessage && (
      <Card style={{marginBottom:14}}>
        <div style={{padding:"12px 16px",fontSize:13,color:statusMessage.kind === "success" ? "#166534" : "#92400e",background:statusMessage.kind === "success" ? "#f0fdf4" : "#fffbeb",borderRadius:10}}>
          {statusMessage.text}
        </div>
      </Card>
    )}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
      {[
        ["Total Accounts",cfAccounts.length,"#2563eb"],
        ["Active",cfAccounts.filter((c: any)=>c.is_active).length,"#16a34a"],
      ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
    </div>
    {cfAccounts.length === 0 ? (
      <Card>
        <EmptyState
          title="No Cloudflare accounts yet"
          description="Connect an account to manage DNS and zones from this panel."
        >
          <Btn variant="primary" onClick={() => setShowAcc(true)}>+ Add Account</Btn>
        </EmptyState>
      </Card>
    ) : (
      cfAccounts.map((acc: any)=>(
      <AccountCard
        key={acc.id}
        acc={acc}
        onEdit={() => setEditingAcc(acc)}
        onDelete={() => { if (!confirm(`Delete account ${acc.name}?`)) return; deleteAcc.mutate(acc.id); }}
        onTest={() => handleTest(acc.id)}
        testStatus={testState[acc.id]}
      />
    )))}

    {showAddAcc&&<Modal title="Add Cloudflare Account" onClose={()=>setShowAcc(false)} width={460}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account Name</label>
          <Inp value={accName} onChange={e=>{setAccName((e.target as any).value); if(errors.name) setErrors(prev=>({...prev, name:""}));}} placeholder="e.g., Main CF Account" style={{borderColor: errors.name ? "#dc2626" : undefined}}/>
          {errors.name && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.name}</div>}
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account ID</label>
          <Inp value={accId} onChange={e=>setAccId((e.target as any).value)} placeholder="abc123def456..."/>
        </div>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Token</label>
          <Inp type="password" value={accToken} onChange={e=>{setAccToken((e.target as any).value); if(errors.token) setErrors(prev=>({...prev, token:""}));}} placeholder="••••••••••••••••" style={{borderColor: errors.token ? "#dc2626" : undefined}}/>
          {errors.token && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.token}</div>}
          <div style={{fontSize:11.5,color:"#9ca3af",marginTop:4}}>Requires Zone:Read, DNS:Edit permissions</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}>
        <Btn variant="primary" disabled={createAcc.isPending || !accName.trim() || !accToken.trim()} onClick={handleAddAcc} style={{flex:1,justifyContent:"center"}}>{createAcc.isPending ? "Adding..." : "Add Account"}</Btn>
        <Btn variant="secondary" onClick={()=>setShowAcc(false)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
      </div>
    </Modal>}
    {editingAcc && <EditCfAccountModal account={editingAcc} onClose={() => setEditingAcc(null)} />}
  </>;
}

function CloudflareZoneView({ sel, onBack, dnsTypes, showDns, setShowDns }: { sel: any, onBack: ()=>void, dnsTypes: any, showDns: boolean, setShowDns: any }) {
  const { acc, zone } = sel;
  const { data: recsData, isLoading } = useDnsRecords(acc.id, zone.id);
  const { data: nameserversData } = useZoneNameservers(acc.id, zone.id);
  const purge = usePurgeCache(acc.id, zone.id);
  const createRecord = useCreateDnsRecord(acc.id, zone.id);
  const updateRecord = useUpdateDnsRecord(acc.id, zone.id);
  const deleteRecord = useDeleteDnsRecord(acc.id, zone.id);
  const recs = recsData || [];
  const [showNs, setShowNs] = useState(false);
  const [editingRecord, setEditingRecord] = useState<any | null>(null);
  const [recordType, setRecordType] = useState("A");
  const [recordName, setRecordName] = useState("");
  const [recordContent, setRecordContent] = useState("");
  const [recordTtl, setRecordTtl] = useState("1");
  const [recordProxied, setRecordProxied] = useState(true);
  const handleCreateRecord = () => {
    if (!recordName.trim() || !recordContent.trim()) return;
    createRecord.mutate({
      type: recordType,
      name: recordName.trim(),
      content: recordContent.trim(),
      ttl: Number(recordTtl),
      proxied: recordProxied,
    }, {
      onSuccess: () => {
        setShowDns(false);
        setRecordType("A");
        setRecordName("");
        setRecordContent("");
        setRecordTtl("1");
        setRecordProxied(true);
      }
    });
  };

  return <>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:24}}>
      <Btn variant="ghost" size="sm" onClick={onBack}>← Back</Btn>
      <span style={{color:"#e5e7eb"}}>/</span><span style={{fontSize:13,color:"#6b7280"}}>{acc.name}</span>
      <span style={{color:"#e5e7eb"}}>/</span><span style={{fontSize:14,fontWeight:700,color:"#111"}}>{zone.name}</span>
      <Badge variant={zone.status==="active"?"green":"gray"}>{zone.status}</Badge>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
      {[
        ["DNS Records",recs.length,"#2563eb"],
        ["Plan","Free","#7c3aed"],
        ["Status",zone.status,zone.status==="active"?"#16a34a":"#9ca3af"],
        ["Zone ID",zone.id,"#374151"]
      ].map(([l,v,c])=>(
        <Card key={l as string}><div style={{padding:"14px 16px"}}><div style={{fontSize:11.5,color:"#9ca3af",marginBottom:4,fontWeight:500}}>{l as string}</div><div style={{fontSize:16,fontWeight:700,color:c as string,fontFamily:l==="Zone ID"?"monospace":"inherit"}}>{v as string}</div></div></Card>
      ))}
    </div>
    <Card>
      <CHd><CTi>DNS Records <span style={{fontSize:12,fontWeight:400,color:"#9ca3af"}}>({recs.length})</span></CTi>
        <div style={{display:"flex",gap:8}}>
          <Btn size="sm" variant="secondary" onClick={()=>purge.mutate()} disabled={purge.isPending}>🗑 Purge Cache</Btn>
          <Btn size="sm" variant="secondary" onClick={()=>setShowNs(true)}>🔗 Nameservers</Btn>
          <Btn size="sm" variant="primary" onClick={()=>setShowDns(true)}>+ Add Record</Btn>
        </div>
      </CHd>
      <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{background:"#f9fafb"}}>{["Type","Name","Content","TTL","Proxied",""].map(h=><th key={h} style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}</tr></thead>
        <tbody>
          {isLoading ? (<tr><td colSpan={6} style={{padding:"28px",textAlign:"center",color:"#9ca3af"}}>Loading DNS records...</td></tr>) : (recs.length ? recs : []).map((r: any)=>(
            <tr key={r.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
              <td style={{padding:"11px 16px"}}><span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700,background:"#f3f4f6",color:dnsTypes[r.type]||"#374151",fontFamily:"monospace"}}>{r.type}</span></td>
              <td style={{padding:"11px 16px",fontFamily:"monospace",fontSize:13,fontWeight:600,color:"#111"}}>{r.name}</td>
              <td style={{padding:"11px 16px",fontFamily:"monospace",fontSize:12.5,color:"#374151",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.content}</td>
              <td style={{padding:"11px 16px",fontSize:13,color:"#6b7280"}}>{r.ttl===1?"Auto":`${r.ttl}s`}</td>
              <td style={{padding:"11px 16px",fontSize:18}}>{r.proxied?"🟠":"⚫"}</td>
              <td style={{padding:"11px 16px"}}><RowActions actions={[
                { icon: "✎", title: "Edit DNS record", onClick: () => setEditingRecord(r) },
                { icon: "✕", title: "Delete DNS record", variant: "danger", onClick: () => { if (!confirm(`Delete DNS record ${r.name}?`)) return; deleteRecord.mutate(r.id); } },
              ]}/></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>

    {showDns&&<Modal title="Add DNS Record" onClose={()=>setShowDns(false)} width={460}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:12}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Type</label><Sel value={recordType} onChange={e=>setRecordType((e.target as any).value)} style={{width:"100%"}}>{["A","AAAA","CNAME","MX","TXT","NS"].map(t=><option key={t}>{t}</option>)}</Sel></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={recordName} onChange={e=>setRecordName((e.target as any).value)} placeholder="@ or subdomain"/></div>
        </div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Content</label><Inp value={recordContent} onChange={e=>setRecordContent((e.target as any).value)} placeholder="IP address or value"/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>TTL</label><Sel value={recordTtl} onChange={e=>setRecordTtl((e.target as any).value)} style={{width:"100%"}}><option value="1">Auto</option><option value="300">5 min</option><option value="3600">1 hour</option><option value="86400">1 day</option></Sel></div>
          <div style={{paddingTop:22}}><label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={recordProxied} onChange={e=>setRecordProxied((e.target as any).checked)}/><span>Proxied (orange cloud)</span></label></div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}><Btn variant="primary" onClick={handleCreateRecord} disabled={createRecord.isPending || !recordName.trim() || !recordContent.trim()} style={{flex:1,justifyContent:"center"}}>{createRecord.isPending ? "Adding..." : "Add Record"}</Btn><Btn variant="secondary" onClick={()=>setShowDns(false)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn></div>
    </Modal>}
    {showNs && <Modal title={`Nameservers for ${zone.name}`} onClose={()=>setShowNs(false)} width={460}>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {(nameserversData?.name_servers || []).map((ns: string) => <div key={ns} style={{padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontFamily:"monospace",fontSize:13}}>{ns}</div>)}
        {(!nameserversData?.name_servers || nameserversData.name_servers.length === 0) && <div style={{fontSize:13,color:"#6b7280"}}>No nameservers returned for this zone.</div>}
      </div>
    </Modal>}
    {editingRecord && <EditDnsRecordModal record={editingRecord} onClose={()=>setEditingRecord(null)} onSave={(payload) => updateRecord.mutate({ recordId: editingRecord.id, data: payload }, { onSuccess: () => setEditingRecord(null) })} isSaving={updateRecord.isPending} />}
  </>;
}

function EditCfAccountModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [name, setName] = useState(account.name || "");
  const [accountId, setAccountId] = useState(account.account_id || "");
  const [token, setToken] = useState("");
  const update = useUpdateCloudflareAccount(account.id);
  return <Modal title={`Edit ${account.name}`} onClose={onClose} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Label</label><Inp value={name} onChange={e=>setName((e.target as any).value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account ID</label><Inp value={accountId} onChange={e=>setAccountId((e.target as any).value)} placeholder="Cloudflare account id" /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Token (optional)</label><Inp type="password" value={token} onChange={e=>setToken((e.target as any).value)} placeholder={account.api_token_masked ?? "Leave empty to keep current"} /></div>
    </div>
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={update.isPending || !name.trim()} onClick={() => update.mutate({ name: name.trim(), account_id: accountId.trim() || null, ...(token.trim() ? { api_token: token.trim() } : {}) }, { onSuccess: onClose })} style={{flex:1,justifyContent:"center"}}>{update.isPending ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

function EditDnsRecordModal({ record, onClose, onSave, isSaving }: { record: any; onClose: () => void; onSave: (payload: any) => void; isSaving: boolean }) {
  const [type, setType] = useState(record.type || "A");
  const [name, setName] = useState(record.name || "");
  const [content, setContent] = useState(record.content || "");
  const [ttl, setTtl] = useState(String(record.ttl || 1));
  const [proxied, setProxied] = useState(Boolean(record.proxied));
  return <Modal title={`Edit record ${record.name}`} onClose={onClose} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:12}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Type</label><Sel value={type} onChange={e=>setType((e.target as any).value)} style={{width:"100%"}}>{["A","AAAA","CNAME","MX","TXT","NS"].map(t=><option key={t}>{t}</option>)}</Sel></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={name} onChange={e=>setName((e.target as any).value)} /></div>
      </div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Content</label><Inp value={content} onChange={e=>setContent((e.target as any).value)} /></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>TTL</label><Sel value={ttl} onChange={e=>setTtl((e.target as any).value)} style={{width:"100%"}}><option value="1">Auto</option><option value="300">5 min</option><option value="3600">1 hour</option><option value="86400">1 day</option></Sel></div>
        <div style={{paddingTop:22}}><label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={proxied} onChange={e=>setProxied((e.target as any).checked)} /><span>Proxied</span></label></div>
      </div>
    </div>
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={isSaving || !name.trim() || !content.trim()} onClick={() => onSave({ type, name: name.trim(), content: content.trim(), ttl: Number(ttl), proxied })} style={{flex:1,justifyContent:"center"}}>{isSaving ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
