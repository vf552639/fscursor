import React from "react";
import { StatCard, Card, CHd, CTi, CBo, Btn, StatusDot, Badge, MiniChart, fmtDT, cpuColor, genBars } from "../components/ui/Primitives";
import { useServers } from "../api/servers";
import { useDomains } from "../api/domains";
import { useCloudflareAccounts } from "../api/cloudflare";
import { useRegistrarAccounts } from "../api/registrars";
import { useTaskLogs } from "../api/tasks";
import { useAuditLog } from "../api/audit";
import { serverMetrics, auditRowToActivity, isSslExpiringSoon } from "./dashboardData";

export default function Dashboard({onNav}: {onNav: (page: string, ctx?: any)=>void}){
  const { data: qServers, isLoading: l1 } = useServers();
  const { data: qDomains, isLoading: l2 } = useDomains();
  const { data: qCF, isLoading: l3 } = useCloudflareAccounts();
  const { data: qReg, isLoading: l4 } = useRegistrarAccounts();
  const { data: qTasks, isLoading: l5 } = useTaskLogs();
  const { data: qAudit, isLoading: l6 } = useAuditLog(20);

  const servers = (qServers?.items || []).map((s: any) => {
    const m = serverMetrics(s);
    return {
      id: s.id,
      name: s.name,
      ip: s.ip_address,
      cpu: m.cpu,
      ram_used: m.ramUsed,
      ram_total: m.ramTotal,
      ssd_used: m.ssdUsed,
      ssd_total: m.ssdTotal,
      uptime: m.uptime,
      status: s.status === "active" ? "healthy" : (s.status || "warning"),
      fastpanel: s.fastpanel_status === "installed",
      original: s,
    };
  });

  const domains = qDomains ?? [];
  const cfAccounts = qCF || [];
  const registrars = qReg || [];
  const taskLogs = qTasks ?? [];
  const activityLogs = (qAudit ?? []).map(auditRowToActivity);

  const healthy = servers.filter(s=>s.status==="healthy").length;
  const warning = servers.filter(s=>s.status==="warning").length;
  const critical = servers.filter(s=>s.status==="critical").length;

  if (l1 || l2 || l3 || l4 || l5 || l6) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading dashboard data...</div>;

  return (
    <>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Dashboard</h1>
          <div style={{fontSize:13,color:"#6b7280"}}>Overview · {new Date().toLocaleDateString("ru-RU",{day:"2-digit",month:"long",year:"numeric"})}</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:20}}>
        <StatCard label="Total Servers" value={servers.length} sub={`${healthy} healthy · ${critical} critical`} color="#2563eb" chartData={[3,5,6,6,7,7,8,8]}/>
        <div onClick={() => onNav("domains")} style={{cursor:"pointer"}}>
          <StatCard label="Total Domains" value={domains.length} sub={`${domains.filter((d: any)=>d.ns_status==="ok").length} NS configured`} color="#7c3aed" chartData={[4,6,8,9,10,11,12,12]}/>
        </div>
        <StatCard label="CF Accounts" value={cfAccounts.filter((c: any)=>c.is_active).length} sub={`of ${cfAccounts.length} accounts`} color="#059669" chartData={[1,1,2,2,2,3,3,3]}/>
        <StatCard label="Registrars" value={registrars.filter((r: any)=>r.is_active).length} sub={`of ${registrars.length} accounts`} color="#d97706" chartData={[1,1,1,2,2,2,2,2]}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
        {[
          {label:"Healthy",count:healthy,c:"#16a34a",bg:"#f0fdf4",br:"#bbf7d0"},
          {label:"Warning",count:warning,c:"#d97706",bg:"#fffbeb",br:"#fde68a"},
          {label:"Critical",count:critical,c:"#dc2626",bg:"#fef2f2",br:"#fecaca"}
        ].map(s=>(
          <div key={s.label} style={{background:s.bg,border:`1px solid ${s.br}`,borderRadius:12,padding:"16px 20px",display:"flex",alignItems:"center",gap:12}}>
            <div style={{fontSize:28,fontWeight:700,color:s.c}}>{s.count}</div>
            <div><div style={{fontSize:13,fontWeight:600,color:s.c}}>{s.label}</div><div style={{fontSize:11.5,color:s.c,opacity:0.7}}>servers</div></div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:20}}>
        <Card>
          <CHd><CTi>🖥 Server Health</CTi><Btn size="sm" onClick={()=>onNav("servers")}>View All →</Btn></CHd>
          {servers.map(s=>{
            // Метрик пока не пишет никто: cpu === null означает «нет данных»,
            // и это надо показывать как «—», а не как здоровый 0%.
            const pct = s.cpu;
            const bc = pct === null ? "#e5e7eb" : cpuColor(pct);
            const ram = s.ram_used !== null && s.ram_total !== null ? `${s.ram_used}/${s.ram_total}GB` : "—";
            return (
              <div key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 20px",borderBottom:"1px solid #f3f4f6",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <StatusDot status={s.status}/>
                <div style={{minWidth:170}}><div style={{fontSize:13.5,fontWeight:600,color:"#111"}}>{s.name}</div><div style={{fontSize:11.5,color:"#9ca3af"}}>{s.ip}</div></div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11.5,color:"#6b7280",marginBottom:4}}><span>CPU {pct === null ? "—" : `${pct}%`}</span><span>RAM {ram}</span><span>SSD {s.ssd_used === null ? "—" : `${s.ssd_used}GB`}</span></div>
                  <div style={{height:5,background:"#f3f4f6",borderRadius:3,overflow:"hidden"}}>{pct === null ? null : <div style={{height:"100%",width:`${pct}%`,background:bc,borderRadius:3}}/>}</div>
                </div>
                <div style={{minWidth:70,textAlign:"right",fontSize:12,color:"#6b7280"}}>{s.uptime ?? "—"}</div>
                <Badge variant={s.status==="healthy"?"green":s.status==="warning"?"yellow":"red"}>{s.status}</Badge>
              </div>
            );
          })}
          {servers.length===0&&<div style={{padding:40,textAlign:"center",color:"#9ca3af"}}>No servers found</div>}
        </Card>
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <CHd><CTi>📊 Quick Stats</CTi></CHd>
            <CBo style={{padding:"6px 20px 12px"}}>
              {[
                ["FastPanel Installed",`${servers.filter(s=>s.fastpanel).length}/${servers.length}`,"#2563eb"],
                ["Domains w/ SSL",domains.filter((d: any)=>d.ssl_status==="active").length,"#16a34a"],
                ["SSL Expiring",domains.filter((d: any)=>isSslExpiringSoon(d.ssl_status,d.ssl_expires_at)).length,"#d97706"],
                ["NS Errors",domains.filter((d: any)=>d.ns_status==="error").length,"#dc2626"],
                ["NS Pending",domains.filter((d: any)=>d.ns_status==="pending").length,"#7c3aed"],
                ["Task Failures",taskLogs.filter((t: any)=>t.status==="failed"||t.status==="error").length,"#dc2626"]
              ].map(([l,v,c])=>(
                <div key={l as string} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #f3f4f6"}}><div style={{fontSize:13,color:"#6b7280"}}>{l as string}</div><div style={{fontSize:14,fontWeight:700,color:c as string}}>{v as React.ReactNode}</div></div>
              ))}
            </CBo>
          </Card>
          <Card style={{flex:1}}>
            <CHd><CTi>∿ Recent Activity</CTi><Btn size="sm" onClick={()=>onNav("activity")}>All →</Btn></CHd>
            <CBo style={{padding:"4px 20px 12px"}}>
              {activityLogs.slice(0,6).map(l=>(
                <div key={l.id} style={{display:"flex",gap:10,padding:"9px 0",borderBottom:"1px solid #f3f4f6",alignItems:"flex-start"}}>
                  <div style={{width:26,height:26,borderRadius:6,background:"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>{l.icon}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,color:"#111"}}><span style={{color:"#9ca3af"}}>{l.label}: </span>{l.target}</div>
                    <div style={{fontSize:11.5,color:"#9ca3af",marginTop:1}}>{fmtDT(l.ts)}</div>
                  </div>
                </div>
              ))}
              {activityLogs.length===0&&<div style={{textAlign:"center",padding:"20px 0",color:"#9ca3af",fontSize:13}}>No recent activity</div>}
            </CBo>
          </Card>
        </div>
      </div>
    </>
  );
}
