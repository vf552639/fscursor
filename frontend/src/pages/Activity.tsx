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
  // `partial` — пакетный прогон, дошедший до конца, но обработавший не всё
  // (`TaskLogStatus.PARTIAL`, его ставит мониторинг серверов, когда часть машин
  // проверить не удалось). Без своей строки он попадал в фолбэк `["gray", …]`,
  // то есть выглядел статусом, которого мы не знаем, — а мы его знаем, и он
  // означает «сделано не всё». Жёлтый: не провал, но и не «✓».
  const stMap: Record<string, string[]>={installed:["green","✓ Installed"],ok:["green","✓ OK"],success:["green","✓ Success"],failed:["red","✕ Failed"],error:["red","✕ Error"],partial:["yellow","◐ Partial"],pending:["yellow","⏳ Pending"],running:["blue","⚙ Running"]};
  const tMap: Record<string, string>={install_fastpanel:"⚡ FastPanel Install",set_nameservers:"🔗 Set Nameservers"};
  const filtTasks=taskLogs.filter(l=>(!fType||l.type===fType)&&(!fStat||l.status===fStat));
  const Th=({children}: any)=><th style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>{children}</th>;
  
  if (l1 || l2) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading activity logs...</div>;

  // Прогоны, сделавшие не всё. Считаются отдельно, потому что раскладка по трём
  // спискам строк их не ловила вовсе: `partial` не совпадал ни с одним из них, и
  // деградировавший прогон пропадал из сводки — Total его считал, а ни одна из
  // трёх плиток нет.
  const partial = taskLogs.filter(t=>t.status==="partial").length;
  // В «Completed» он входит: прогон действительно завершился, и отправить его в
  // «Failed» значило бы объявить проваленным то, что по большей части сделано.
  // Но и слиться с успехом молча он не может — иначе «12 Completed» читается как
  // «все двенадцать сделали свою работу целиком». Отсюда квалификатор под
  // счётом: он не меняет число, он говорит, из чего оно. Тот же приём, что у
  // «Down · N unverified» на дашборде.
  const completed = taskLogs.filter(t=>t.status==="installed"||t.status==="ok"||t.status==="success").length + partial;

  return <>
    <div style={{marginBottom:24}}><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Activity</h1><div style={{fontSize:13,color:"#6b7280"}}>Task logs & system events</div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:20}}>
      {[
        {label:"Total Tasks",value:taskLogs.length,color:"#2563eb",sub:undefined},
        {label:"Completed",value:completed,color:"#16a34a",sub:partial?`incl. ${partial} partial — some entities were skipped`:undefined},
        {label:"Failed",value:taskLogs.filter(t=>t.status==="failed"||t.status==="error").length,color:"#dc2626",sub:undefined},
        {label:"Pending / Running",value:taskLogs.filter(t=>t.status==="pending"||t.status==="running").length,color:"#d97706",sub:undefined}
      ].map(t=><StatCard key={t.label} label={t.label} value={t.value} sub={t.sub} color={t.color}/>)}
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
          {/* «Partial» — полноправный пункт фильтра: деградировавшие прогоны
              ищут именно поштучно («какие серверы не проверились»), а без пункта
              выбрать их можно было только глазами по всей таблице. */}
          <Sel value={fStat} onChange={(e: any)=>setFS(e.target.value)}><option value="">All Statuses</option><option value="success">Success</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="pending">Pending</option><option value="running">Running</option></Sel>
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
