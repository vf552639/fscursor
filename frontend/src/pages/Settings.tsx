import React, { useState } from "react";
import { Card, CHd, CTi, CBo, StatCard, Badge, Btn, Modal, Inp } from "../components/ui/Primitives";
import { useRegistrarAccounts, useCreateRegistrarAccount, useTestRegistrarConnection, useUpdateRegistrarAccount, useDeleteRegistrarAccount, RegistrarProvider } from "../api/registrars";

export default function Settings(){
  const { data: registrarsData, isLoading } = useRegistrarAccounts();
  const createReg = useCreateRegistrarAccount();
  const testReg = useTestRegistrarConnection();
  const deleteReg = useDeleteRegistrarAccount();
  
  const registrars = registrarsData || [];
  
  const [tab,setTab]=useState("registrars"); const [showAdd,setSA]=useState(false);
  const [provider,setProvider]=useState<RegistrarProvider>("hostiq");
  
  const [accName, setAccName] = useState("");
  const [apiUser, setApiUser] = useState("");
  const [apiKey, setApiKey] = useState("");

  const [testing,setTest]=useState<any>({}); const [testRes,setRes]=useState<any>({});
  const [editingRegistrar, setEditingRegistrar] = useState<any | null>(null);
  const [editingSystem, setEditingSystem] = useState<{ key: string; value: string } | null>(null);
  
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
      {[["registrars","📋 Registrars"],["system","⚙ System"],["encryption","🔑 Encryption"]].map(([k,l])=>(
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
      {isLoading ? <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading registrars...</div> : registrars.map((r: any)=>{
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
    {tab==="system"&&<Card>
      <CHd><CTi>⚙ System Configuration</CTi></CHd>
      <CBo style={{padding:"6px 20px 14px"}}>
        {[
          ["API Base URL","http://localhost:8100/api",false],
          ["Frontend URL","http://localhost:3100",false],
          ["Backend Port","8100",true],
          ["Postgres Port","5532",false],
          ["Redis Port","6479",false],
          ["Celery Workers","2",true],
          ["Task Time Limit","60 min",true],
          ["FastPanel Poll","3 seconds",true]
        ].map(([k,v,ed])=>(
          <div key={k as string} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{k as string}</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,fontFamily:"monospace",fontWeight:600,color:"#111"}}>{v as string}</span>{ed&&<Btn size="sm" variant="ghost" onClick={() => setEditingSystem({ key: String(k), value: String(v) })} style={{color:"#2563eb",padding:"4px 8px"}}>Edit</Btn>}</div>
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
        <div style={{fontSize:12,color:"#6b7280"}}>Settings API route is not available yet in current backend build, so this action is staged as UI-only.</div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}>
        <Btn variant="primary" style={{flex:1,justifyContent:"center"}} onClick={() => setEditingSystem(null)}>Save</Btn>
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
