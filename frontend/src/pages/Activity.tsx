import React, { useState } from "react";
import { Card, StatCard, Badge, Btn, Sel, fmtDT } from "../components/ui/Primitives";
import { useTaskLogs } from "../api/tasks";
import { useServers } from "../api/servers";
import { useAuditLog } from "../api/audit";
import TaskProgressModal from "../components/TaskProgressModal";

export default function Activity(){
  const { data: qTasks, isLoading: l1 } = useTaskLogs();
  const { data: qServers, isLoading: l2 } = useServers();
  const { data: auditRows, isLoading: auditLoading } = useAuditLog(100);
  
  const rawTasks = qTasks ?? [];
  const taskLogs = rawTasks.map((t: any) => ({
    id: t.id,
    type: t.task_type,
    status: t.status,
    server_id: t.entity_type === "server" ? t.entity_id : null,
    log: t.log_text || "No log output",
    created: t.created_at,
    original: t
  }));

  const servers = qServers?.items || [];
  const activityLogs = auditRows ?? [];

  const [tab,setTab]=useState("tasks"); const [fType,setFT]=useState(""); const [fStat,setFS]=useState(""); const [openTaskId,setOpenTaskId]=useState<number | null>(null);
  const stMap: Record<string, string[]>={installed:["green","✓ Installed"],ok:["green","✓ OK"],success:["green","✓ Success"],failed:["red","✕ Failed"],error:["red","✕ Error"],pending:["yellow","⏳ Pending"],running:["blue","⚙ Running"]};
  const tMap: Record<string, string>={install_fastpanel:"⚡ FastPanel Install",set_nameservers:"🔗 Set Nameservers"};
  const filtTasks=taskLogs.filter(l=>(!fType||l.type===fType)&&(!fStat||l.status===fStat));
  const Th=({children}: any)=><th style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>{children}</th>;
  
  if (l1 || l2) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading activity logs...</div>;

  return <>
    <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Activity</h1><div style={{fontSize:13,color:"#6b7280"}}>Task logs & system events</div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
      {[
        ["Total Tasks",taskLogs.length,"#2563eb"],
        ["Completed",taskLogs.filter(t=>t.status==="installed"||t.status==="ok"||t.status==="success").length,"#16a34a"],
        ["Failed",taskLogs.filter(t=>t.status==="failed"||t.status==="error").length,"#dc2626"],
        ["Pending / Running",taskLogs.filter(t=>t.status==="pending"||t.status==="running").length,"#d97706"]
      ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
    </div>
    <Card>
      <div style={{display:"flex",borderBottom:"1px solid #e5e7eb"}}>
        {[["tasks","Task Logs",taskLogs.length],["activity","Activity Log",activityLogs.length]].map(([k,l,c])=>(
          <div key={k as string} onClick={()=>setTab(k as string)} style={{padding:"12px 20px",fontSize:13.5,fontWeight:500,cursor:"pointer",borderBottom:`2px solid ${tab===k?"#2563eb":"transparent"}`,marginBottom:-1,color:tab===k?"#2563eb":"#6b7280",display:"flex",alignItems:"center",gap:6}}>
            {l as string}<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:20,height:18,background:tab===k?"#eff4ff":"#f3f4f6",borderRadius:20,fontSize:11,fontWeight:600,color:tab===k?"#2563eb":"#6b7280"}}>{c as number}</span>
          </div>
        ))}
      </div>
      {tab==="tasks"&&<>
        <div style={{padding:"12px 16px",display:"flex",gap:10,borderBottom:"1px solid #e5e7eb"}}>
          <Sel value={fType} onChange={(e: any)=>setFT(e.target.value)}><option value="">All Types</option><option value="install_fastpanel">FastPanel Install</option><option value="set_nameservers">Set Nameservers</option></Sel>
          <Sel value={fStat} onChange={(e: any)=>setFS(e.target.value)}><option value="">All Statuses</option><option value="success">Success</option><option value="failed">Failed</option><option value="pending">Pending</option><option value="running">Running</option></Sel>
        </div>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{["#","Type","Server","Status","Log Preview","Date",""].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
          <tbody>
            {filtTasks.map(t=>{
              const srv=servers.find((s: any)=>s.id===t.server_id);
              const [sv,sl]=stMap[t.status]||["gray",t.status];
              return <tr key={t.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                <td style={{padding:"11px 16px",fontSize:13,color:"#9ca3af",fontFamily:"monospace"}}>#{t.id}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:"#374151"}}>{tMap[t.type]||t.type}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:srv?"#111":"#9ca3af"}}>{srv?.name||"—"}</td>
                <td style={{padding:"11px 16px"}}><Badge variant={sv}>{sl}</Badge></td>
                <td style={{padding:"11px 16px",fontSize:12.5,color:"#6b7280",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.log}</td>
                <td style={{padding:"11px 16px",fontSize:12,color:"#9ca3af",whiteSpace:"nowrap"}}>{fmtDT(t.created)}</td>
                <td style={{padding:"11px 16px"}}><Btn size="sm" variant="secondary" onClick={()=>setOpenTaskId(t.id)}>View Log</Btn></td>
              </tr>;
            })}
            {filtTasks.length===0&&<tr><td colSpan={7} style={{textAlign:"center",padding:40,color:"#6b7280"}}>No task logs found.</td></tr>}
          </tbody>
        </table>
      </>}
      {tab==="activity"&&(
        auditLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading audit log…</div>
        ) : (
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Time","Action","Target","ID","Device","IP"].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
            <tbody>
              {activityLogs.length===0&&<tr><td colSpan={6} style={{textAlign:"center",padding:40,color:"#6b7280"}}>No audit entries yet.</td></tr>}
              {activityLogs.map((r) => {
                const dev = r.device_id ? `${String(r.device_id).slice(0, 8)}…` : "—";
                return (
                  <tr key={r.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                    <td style={{padding:"11px 16px",fontSize:12,color:"#9ca3af",whiteSpace:"nowrap"}}>{fmtDT(r.ts)}</td>
                    <td style={{padding:"11px 16px"}}><Badge variant="gray">{r.action}</Badge></td>
                    <td style={{padding:"11px 16px",fontSize:13,color:"#374151"}}>{r.target_type || "—"}</td>
                    <td style={{padding:"11px 16px",fontSize:13,color:"#374151",fontFamily:"monospace"}}>{r.target_id || "—"}</td>
                    <td style={{padding:"11px 16px",fontSize:12,color:"#6b7280",fontFamily:"monospace"}}>{dev}</td>
                    <td style={{padding:"11px 16px",fontSize:12,color:"#6b7280"}}>{r.ip || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </Card>
    {openTaskId !== null && <TaskProgressModal taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
  </>;
}
