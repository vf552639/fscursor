import React, { useState } from "react";
import { Card, CHd, CTi, CBo, StatCard, Badge, Btn, Modal, Inp, EmptyState, ErrorState } from "../components/ui/Primitives";
import { useRegistrarAccounts, useCreateRegistrarAccount, useTestRegistrarConnection, useUpdateRegistrarAccount, useDeleteRegistrarAccount, RegistrarProvider } from "../api/registrars";
import { useSystemConfig, useTestNotificationDelivery, useUpdateSystemConfig } from "../api/settings";
import { useCreateSslEmail, useDeleteSslEmail, usePatchSslEmail, useSslEmails } from "../api/sslEmails";

export default function Settings(){
  const { data: registrarsData, isPending, isError } = useRegistrarAccounts();
  const createReg = useCreateRegistrarAccount();
  const testReg = useTestRegistrarConnection();
  const deleteReg = useDeleteRegistrarAccount();
  const { data: systemConfigData } = useSystemConfig();
  const updateSystemConfig = useUpdateSystemConfig();
  const testDelivery = useTestNotificationDelivery();
  
  const { data: sslEmailsData, isPending: sslPending, isError: sslError } = useSslEmails();
  const createSslEmail = useCreateSslEmail();
  const patchSslEmail = usePatchSslEmail();
  const deleteSslEmail = useDeleteSslEmail();

  const registrars = registrarsData || [];
  const sslEmails = sslEmailsData || [];
  
  const [tab,setTab]=useState("registrars"); const [showAdd,setSA]=useState(false);
  const [provider,setProvider]=useState<RegistrarProvider>("hostiq");
  
  const [accName, setAccName] = useState("");
  const [apiUser, setApiUser] = useState("");
  const [apiKey, setApiKey] = useState("");

  const [testing,setTest]=useState<any>({}); const [testRes,setRes]=useState<any>({});
  const [editingRegistrar, setEditingRegistrar] = useState<any | null>(null);
  const [editingSystem, setEditingSystem] = useState<{ key: string; value: string } | null>(null);
  const [showAddSslEmail, setShowAddSslEmail] = useState(false);
  const [newSslEmail, setNewSslEmail] = useState("");
  const [newSslCap, setNewSslCap] = useState("100");
  const [testResult, setTestResult] = useState<{ webhook: string; telegram: string } | null>(null);
  const systemConfig = systemConfigData || [
    { key: "API Base URL", value: "http://localhost:8100/api", editable: false },
    { key: "Frontend URL", value: "http://localhost:3100", editable: false },
    { key: "Backend Port", value: "8100", editable: true },
    { key: "Postgres Port", value: "5532", editable: false },
    { key: "Redis Port", value: "6479", editable: false },
    { key: "Celery Workers", value: "2", editable: true },
    { key: "Task Time Limit", value: "60 min", editable: true },
    { key: "FastPanel Poll", value: "3 seconds", editable: true },
    { key: "Webhook Enabled", value: "false", editable: true },
    { key: "Webhook URL", value: "", editable: true },
    { key: "Webhook Secret", value: "", editable: true },
    { key: "Telegram Enabled", value: "false", editable: true },
    { key: "Auto Temp Mail Enabled", value: "false", editable: true },
  ];

  const getConfigValue = (key: string, fallback = "") =>
    systemConfig.find((item) => item.key === key)?.value ?? fallback;
  const isEnabled = (key: string) => ["true", "1", "yes", "on", "enabled"].includes(getConfigValue(key).toLowerCase());
  const toggleConfig = (key: string) =>
    updateSystemConfig.mutate({ key, value: isEnabled(key) ? "false" : "true" });

  
  const handleTest=(id: number)=>{
    setTest((p: any)=>({...p,[id]:true}));
    setRes((p: any)=>({...p,[id]:null}));
    testReg.mutate(id, {
      onSuccess: (data) => {
        setTest((p: any)=>({...p,[id]:false}));
        setRes((p: any)=>({...p,[id]:data.success?"ok":"error"}));
      },
      onError: () => {
        setTest((p: any)=>({...p,[id]:false}));
        setRes((p: any)=>({...p,[id]:"error"}));
      }
    });
  };

  const handleAdd = () => {
    createReg.mutate({
      provider,
      name: accName,
      api_user: apiUser,
      api_key: apiKey
    }, {
      onSuccess: () => {
        setSA(false);
        setAccName(""); setApiUser(""); setApiKey("");
      }
    });
  };
  
  return <>
    <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Settings</h1><div style={{fontSize:13,color:"#6b7280"}}>Manage integrations and system configuration</div></div>
    <div style={{display:"flex",gap:0,borderBottom:"1px solid #e5e7eb",marginBottom:24}}>
      {[["registrars","📋 Registrars"],["ssl_pool","✉ SSL Pool"],["system","⚙ System"],["encryption","🔑 Encryption"]].map(([k,l])=>(
        <div key={k} onClick={()=>setTab(k)} style={{padding:"11px 20px",fontSize:13.5,fontWeight:500,cursor:"pointer",borderBottom:`2px solid ${tab===k?"#2563eb":"transparent"}`,marginBottom:-1,color:tab===k?"#2563eb":"#6b7280"}}>{l}</div>
      ))}
    </div>
    {tab==="registrars"&&<>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:"#111"}}>Registrar Accounts <span style={{fontSize:13,fontWeight:400,color:"#9ca3af"}}>({registrars.length})</span></div>
        <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Registrar</Btn>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
        {[
          ["Total",registrars.length,"#2563eb"],
          ["Active",registrars.filter((r: any)=>r.is_active).length,"#16a34a"]
        ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
      </div>
      {isError ? (
        <ErrorState
          title="Backend unavailable or database schema is out of date"
          message="Registrar accounts could not be loaded."
          hint="docker compose logs backend | grep -i alembic"
        />
      ) : isPending ? (
        <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading registrars...</div>
      ) : registrars.length === 0 ? (
        <Card>
          <EmptyState
            title="No registrar accounts yet"
            description="Add Hostiq or Namecheap credentials to assign domains to registrars."
          >
            <Btn variant="primary" onClick={() => setSA(true)}>+ Add Registrar</Btn>
          </EmptyState>
        </Card>
      ) : registrars.map((r: any)=>{
        const plMap: any={hostiq:{bg:"#fff7ed",c:"#ea580c",icon:"H"},namecheap:{bg:"#fef2f2",c:"#dc2626",icon:"N"}};
        const pl=plMap[r.provider]||{bg:"#f3f4f6",c:"#374151",icon:"?"};
        return <Card key={r.id} style={{marginBottom:12}}>
          <div style={{padding:"16px 20px",display:"flex",alignItems:"center",gap:14}}>
            <div style={{width:38,height:38,borderRadius:9,background:pl.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:800,color:pl.c,flexShrink:0}}>{pl.icon}</div>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}><span style={{fontSize:14.5,fontWeight:700,color:"#111"}}>{r.name}</span><Badge variant={r.is_active?"green":"gray"}>{r.is_active?"Active":"Inactive"}</Badge></div>
              <div style={{fontSize:12.5,color:"#6b7280"}}>{r.provider==="hostiq"?"Hostiq":"Namecheap"} · <span style={{fontFamily:"monospace"}}>{r.api_user}</span></div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {testRes[r.id]&&<Badge variant={testRes[r.id]==="ok"?"green":"red"}>{testRes[r.id]==="ok"?"✓ Connected":"✕ Failed"}</Badge>}
              <Btn size="sm" variant="secondary" onClick={()=>handleTest(r.id)} disabled={testing[r.id]}>{testing[r.id]?"Testing…":"🔌 Test"}</Btn>
              <Btn size="sm" variant="secondary" onClick={() => setEditingRegistrar(r)}>✎ Edit</Btn>
              <Btn size="sm" variant="danger" onClick={() => { if (!confirm(`Delete registrar ${r.name}?`)) return; deleteReg.mutate(r.id); }}>✕</Btn>
            </div>
          </div>
        </Card>;
      })}
      {showAdd&&<Modal title="Add Registrar Account" onClose={()=>setSA(false)} width={480}>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account Name</label><Inp value={accName} onChange={e=>setAccName((e.target as any).value)} placeholder="e.g., Hostiq Main"/></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:8}}>Provider</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              {[
                ["hostiq","Hostiq","H","#fff7ed","#ea580c"],
                ["namecheap","Namecheap","N","#fef2f2","#dc2626"]
              ].map(([k,l,ic,bg,c])=>(
                <div key={k} onClick={()=>setProvider(k as any)} style={{padding:"12px 16px",border:`2px solid ${provider===k?"#2563eb":"#e5e7eb"}`,borderRadius:9,cursor:"pointer",display:"flex",alignItems:"center",gap:10,transition:"all 0.15s",background:provider===k?"#eff4ff":"#fff"}}>
                  <div style={{width:32,height:32,borderRadius:7,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:c,fontSize:14}}>{ic}</div>
                  <span style={{fontSize:13.5,fontWeight:600,color:provider===k?"#2563eb":"#374151"}}>{l}</span>
                </div>
              ))}
            </div>
          </div>
          {provider==="hostiq"?<>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User (email)</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} placeholder="admin@hostiq.ua"/></div>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key</label><Inp type="password" value={apiKey} onChange={e=>setApiKey((e.target as any).value)} placeholder="••••••••••••••••"/></div>
          </>:<>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} placeholder="your_namecheap_username"/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key</label><Inp type="password" value={apiKey} onChange={e=>setApiKey((e.target as any).value)} placeholder="••••••••"/></div>
              <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Client IP</label><Inp placeholder="127.0.0.1"/></div>
            </div>
          </>}
        </div>
        <div style={{display:"flex",gap:8,marginTop:22}}>
          <Btn variant="primary" onClick={handleAdd} disabled={createReg.isPending} style={{flex:1,justifyContent:"center"}}>{createReg.isPending ? "Adding..." : "Add Account"}</Btn>
        </div>
        <div style={{marginTop:8}}><Btn variant="secondary" onClick={()=>setSA(false)} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
      </Modal>}
    </>}
    {tab==="ssl_pool"&&<>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:"#111"}}>SSL Email Pool <span style={{fontSize:13,fontWeight:400,color:"#9ca3af"}}>({sslEmails.length})</span></div>
        <Btn variant="primary" onClick={()=>setShowAddSslEmail(true)}>+ Add Email</Btn>
      </div>
      {sslError ? (
        <ErrorState
          title="SSL email pool unavailable"
          message="Could not load SSL pool data from backend."
          hint="docker compose logs backend --tail 100"
        />
      ) : sslPending ? (
        <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading SSL email pool...</div>
      ) : sslEmails.length === 0 ? (
        <Card>
          <EmptyState
            title="SSL email pool is empty"
            description="Add one or more emails to issue SSL certificates during domain provisioning."
          >
            <Btn variant="primary" onClick={() => setShowAddSslEmail(true)}>+ Add Email</Btn>
          </EmptyState>
        </Card>
      ) : (
        <Card>
          <CBo style={{padding:"6px 20px 14px"}}>
            {sslEmails.map((item) => {
              const ratio = item.usage_cap > 0 ? Math.min(100, Math.round((item.usage_count / item.usage_cap) * 100)) : 0;
              const barColor = ratio < 70 ? "#16a34a" : ratio < 90 ? "#d97706" : "#dc2626";
              return (
                <div key={item.id} style={{padding:"12px 0",borderBottom:"1px solid #f3f4f6"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:13.5,fontWeight:600,color:"#111"}}>{item.email}</div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <Badge variant={item.is_active ? "green" : "gray"}>{item.is_active ? "Active" : "Inactive"}</Badge>
                      <Btn size="sm" variant="secondary" onClick={() => patchSslEmail.mutate({ id: item.id, payload: { is_active: !item.is_active } })}>
                        {item.is_active ? "Disable" : "Enable"}
                      </Btn>
                      <Btn size="sm" variant="danger" onClick={() => { if (!confirm(`Delete ${item.email}?`)) return; deleteSslEmail.mutate(item.id); }}>✕</Btn>
                    </div>
                  </div>
                  <div style={{fontSize:12.5,color:"#6b7280",marginBottom:8}}>
                    Used {item.usage_count} / {item.usage_cap}
                  </div>
                  <div style={{height:8,background:"#e5e7eb",borderRadius:999,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${ratio}%`,background:barColor,borderRadius:999}} />
                  </div>
                </div>
              );
            })}
          </CBo>
        </Card>
      )}
      {showAddSslEmail && (
        <Modal title="Add SSL Email" onClose={() => setShowAddSslEmail(false)} width={440}>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Email</label><Inp value={newSslEmail} onChange={e=>setNewSslEmail((e.target as any).value)} placeholder="ssl@example.com" /></div>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Usage Cap</label><Inp value={newSslCap} onChange={e=>setNewSslCap((e.target as any).value)} placeholder="100" /></div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:20}}>
            <Btn
              variant="primary"
              style={{flex:1,justifyContent:"center"}}
              disabled={createSslEmail.isPending || !newSslEmail.trim()}
              onClick={() => {
                createSslEmail.mutate(
                  { email: newSslEmail.trim(), usage_cap: Math.max(1, Number(newSslCap || "100")) },
                  {
                    onSuccess: () => {
                      setShowAddSslEmail(false);
                      setNewSslEmail("");
                      setNewSslCap("100");
                    },
                  }
                );
              }}
            >
              {createSslEmail.isPending ? "Saving..." : "Save"}
            </Btn>
            <Btn variant="secondary" style={{flex:1,justifyContent:"center"}} onClick={() => setShowAddSslEmail(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </>}
    {tab==="system"&&<Card>
      <CHd><CTi>⚙ System Configuration</CTi></CHd>
      <CBo style={{padding:"6px 20px 14px"}}>
        <div style={{padding:"12px 0",borderBottom:"1px solid #f3f4f6"}}>
          <div style={{fontSize:13.5,fontWeight:600,color:"#111",marginBottom:10}}>Notification Channels</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            <Btn size="sm" variant={isEnabled("Webhook Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Webhook Enabled")}>
              {isEnabled("Webhook Enabled") ? "Webhook: ON" : "Webhook: OFF"}
            </Btn>
            <Btn size="sm" variant={isEnabled("Telegram Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Telegram Enabled")}>
              {isEnabled("Telegram Enabled") ? "Telegram: ON" : "Telegram: OFF"}
            </Btn>
            <Btn size="sm" variant={isEnabled("Auto Temp Mail Enabled") ? "primary" : "secondary"} onClick={() => toggleConfig("Auto Temp Mail Enabled")}>
              {isEnabled("Auto Temp Mail Enabled") ? "Auto Temp Mail: ON" : "Auto Temp Mail: OFF"}
            </Btn>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <Btn
              size="sm"
              variant="secondary"
              disabled={testDelivery.isPending}
              onClick={() =>
                testDelivery.mutate(
                  { title: "SDMP test notification", message: "Manual test from Settings." },
                  { onSuccess: (res) => setTestResult(res) }
                )
              }
            >
              {testDelivery.isPending ? "Testing..." : "Test delivery"}
            </Btn>
            {testResult ? (
              <span style={{fontSize:12.5,color:"#374151"}}>
                webhook: <b>{testResult.webhook}</b> · telegram: <b>{testResult.telegram}</b>
              </span>
            ) : null}
          </div>
        </div>
        {systemConfig.map((item)=>(
          <div key={item.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{item.key}</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,fontFamily:"monospace",fontWeight:600,color:"#111"}}>{item.value}</span>{item.editable&&<Btn size="sm" variant="ghost" onClick={() => setEditingSystem({ key: item.key, value: item.value })} style={{color:"#2563eb",padding:"4px 8px"}}>Edit</Btn>}</div>
          </div>
        ))}
      </CBo>
    </Card>}
    {tab==="encryption"&&<Card>
      <CHd><CTi>🔑 Encryption Settings</CTi></CHd>
      <CBo>
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:9,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:10}}>
          <span style={{fontSize:18}}>✓</span>
          <div><div style={{fontSize:13.5,fontWeight:600,color:"#16a34a"}}>AES-256-GCM Encryption Active</div><div style={{fontSize:12.5,color:"#15803d",marginTop:2}}>All passwords and API keys encrypted. Key derived via SHA-256 from ENCRYPTION_KEY env var.</div></div>
        </div>
        {[
          ["Algorithm","AES-256-GCM"],
          ["Key Derivation","SHA-256 from ENCRYPTION_KEY env var"],
          ["Stored Fields","SSH passwords, FastPanel passwords, API keys, tokens"],
          ["In-Memory Only","Keys decrypted per-request and cleared immediately"],
          ["API Exposure","Passwords never appear in API responses"]
        ].map(([k,v])=>(
          <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{k}</div>
            <div style={{fontSize:13,fontWeight:600,color:"#111",textAlign:"right",maxWidth:340}}>{v}</div>
          </div>
        ))}
      </CBo>
    </Card>}
    {editingRegistrar && <EditRegistrarModal registrar={editingRegistrar} onClose={() => setEditingRegistrar(null)} />}
    {editingSystem && <Modal title={`Edit ${editingSystem.key}`} onClose={() => setEditingSystem(null)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Value</label><Inp value={editingSystem.value} onChange={e=>setEditingSystem((p)=>p?({...p, value:(e.target as any).value}):p)} /></div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}>
        <Btn variant="primary" style={{flex:1,justifyContent:"center"}} disabled={updateSystemConfig.isPending} onClick={() => {
          if (!editingSystem) return;
          updateSystemConfig.mutate({ key: editingSystem.key, value: editingSystem.value }, { onSuccess: () => setEditingSystem(null) });
        }}>{updateSystemConfig.isPending ? "Saving..." : "Save"}</Btn>
        <Btn variant="secondary" style={{flex:1,justifyContent:"center"}} onClick={() => setEditingSystem(null)}>Cancel</Btn>
      </div>
    </Modal>}
  </>;
}

function EditRegistrarModal({ registrar, onClose }: { registrar: any; onClose: () => void }) {
  const [name, setName] = useState(registrar.name || "");
  const [apiUser, setApiUser] = useState(registrar.api_user || "");
  const [apiKey, setApiKey] = useState("");
  const update = useUpdateRegistrarAccount(registrar.id);
  return <Modal title={`Edit ${registrar.name}`} onClose={onClose} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={name} onChange={e=>setName((e.target as any).value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key (optional)</label><Inp type="password" value={apiKey} onChange={e=>setApiKey((e.target as any).value)} placeholder="Leave empty to keep current key" /></div>
    </div>
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={update.isPending || !name.trim()} onClick={() => update.mutate({ name: name.trim(), api_user: apiUser.trim() || null, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }, { onSuccess: onClose })} style={{flex:1,justifyContent:"center"}}>{update.isPending ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
