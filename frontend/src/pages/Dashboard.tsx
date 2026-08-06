import React from "react";
import { StatCard, Card, CHd, CTi, CBo, Btn, StatusDot, Badge, fmtDT, cpuColor, formatAgo, DIM_TEXT, WARN_TEXT, STALE_TEXT } from "../components/ui/Primitives";
import { useServers } from "../api/servers";
import { useDomains } from "../api/domains";
import { useCloudflareAccounts } from "../api/cloudflare";
import { useRegistrarAccounts } from "../api/registrars";
import { useTaskLogs } from "../api/tasks";
import { useAuditLog } from "../api/audit";
import { serverMetrics, auditRowToActivity, isSslExpiringSoon } from "./dashboardData";
import { isCheckStale, isMetricsStale, serverUiStatus, statusBadgeVariant } from "../lib/serverStatus";

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
      // Тот же разбор, что на странице серверов и на детали (`lib/serverStatus`).
      // Здесь он был свой и до `last_check_*` не доходил вовсе: `status`
      // ставится при заведении сервера, поэтому подтверждённо упавшая машина
      // светилась на первом экране зелёной точкой и считалась в «Healthy».
      status: serverUiStatus(s),
      metrics_at: s.metrics_collected_at || null,
      stale: isMetricsStale(s.metrics_collected_at),
      check_at: s.last_check_at || null,
      check_stale: isCheckStale(s.last_check_at),
      fastpanel: s.fastpanel_status === "installed",
      original: s,
    };
  });

  const domains = qDomains ?? [];
  const cfAccounts = qCF || [];
  const registrars = qReg || [];
  const taskLogs = qTasks ?? [];
  const activityLogs = (qAudit ?? []).map(auditRowToActivity);

  // Считаем ровно то, что знаем. Прежние «healthy/warning/critical» брались из
  // колонки `status`, которая знает только `new` и `active`: «warning» и
  // «critical» не мог получить никто, а «healthy» получали все, включая
  // упавших и ни разу не проверенных.
  const online = servers.filter(s=>s.status==="active").length;
  const downList = servers.filter(s=>s.status==="error");
  const down = downList.length;
  const unknown = servers.length - online - down;
  // Сколько из упавших держатся на старой или несуществующей проверке. Само
  // число «Down» намеренно их считает (ошибка в сторону тревоги дешевле:
  // сходить и убедиться, что машина жива, стоит меньше, чем считать мёртвую
  // живой), но подать давний факт как текущее число — это ровно тот дефект,
  // который мы тут чиним. Отсюда квалификатор: он не меняет счёт, он его
  // датирует. `!check_at` — падение из колонки `status`, где проверки не было
  // вовсе.
  const downUnverified = downList.filter(s=>!s.check_at || s.check_stale).length;

  if (l1 || l2 || l3 || l4 || l5 || l6) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading dashboard data...</div>;

  return (
    <>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
        <div><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Dashboard</h1>
          <div style={{fontSize:13,color:"#6b7280"}}>Overview · {new Date().toLocaleDateString("ru-RU",{day:"2-digit",month:"long",year:"numeric"})}</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:20}}>
        {/* `chartData` у плиток был константой прямо в коде — восемь столбиков
            «роста», нарисованных руками. Ряда наблюдений у нас нет ни по одной
            из этих величин, поэтому графиков нет тоже (см. Primitives). */}
        <StatCard label="Total Servers" value={servers.length} sub={`${online} online · ${down} down · ${unknown} unknown`} color="#2563eb"/>
        <div onClick={() => onNav("domains")} style={{cursor:"pointer"}}>
          <StatCard label="Total Domains" value={domains.length} sub={`${domains.filter((d: any)=>d.ns_status==="ok").length} NS configured`} color="#7c3aed"/>
        </div>
        <StatCard label="CF Accounts" value={cfAccounts.filter((c: any)=>c.is_active).length} sub={`of ${cfAccounts.length} accounts`} color="#059669"/>
        <StatCard label="Registrars" value={registrars.filter((r: any)=>r.is_active).length} sub={`of ${registrars.length} accounts`} color="#d97706"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
        {[
          // «Unknown» — полноправная плитка, а не остаток: сервер без свежей
          // проверки не «в порядке» и не «упал», и молчать о нём значит снова
          // выдать незнание за здоровье.
          {label:"Online",count:online,c:"#16a34a",bg:"#f0fdf4",br:"#bbf7d0",note:null},
          {label:"Down",count:down,c:"#dc2626",bg:"#fef2f2",br:"#fecaca",note:downUnverified?`${downUnverified} unverified`:null},
          {label:"Unknown",count:unknown,c:"#6b7280",bg:"#f9fafb",br:"#e5e7eb",note:null}
        ].map(s=>(
          <div key={s.label} style={{background:s.bg,border:`1px solid ${s.br}`,borderRadius:12,padding:"16px 20px",display:"flex",alignItems:"center",gap:12}}>
            <div style={{fontSize:28,fontWeight:700,color:s.c}}>{s.count}</div>
            <div><div style={{fontSize:13,fontWeight:600,color:s.c}}>{s.label}</div><div style={{fontSize:11.5,color:s.c,opacity:0.7}}>{s.note ? `servers · ${s.note}` : "servers"}</div></div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:20}}>
        <Card>
          <CHd><CTi>🖥 Server Health</CTi><Btn size="sm" onClick={()=>onNav("servers")}>View All →</Btn></CHd>
          {servers.map(s=>{
            // `cpu === null` означает «нет данных», и это «—», а не здоровый 0%.
            const pct = s.cpu;
            const bc = pct === null ? "#e5e7eb" : s.stale ? STALE_TEXT : cpuColor(pct);
            const ram = s.ram_used !== null && s.ram_total !== null ? `${s.ram_used}/${s.ram_total}GB` : "—";
            // Протухший снимок виден, но не выдаёт себя за сегодняшний: цвет
            // отличается и от свежих цифр, и от прочерков, а возраст подписан.
            const dim = s.stale ? { color: STALE_TEXT } : null;
            return (
              <div key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 20px",borderBottom:"1px solid #f3f4f6",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <StatusDot status={s.status}/>
                <div style={{minWidth:170}}>
                  <div style={{fontSize:13.5,fontWeight:600,color:"#111"}}>{s.name}</div>
                  <div style={{fontSize:11.5,color:DIM_TEXT}}>{s.ip}</div>
                  {/* Возраст проверки — под именем, вплотную к точке и бейджу,
                      которые из неё и получены. */}
                  <div style={{fontSize:11,color:s.check_stale?WARN_TEXT:DIM_TEXT}}>{s.check_at ? `checked ${formatAgo(s.check_at)}${s.check_stale?" · stale":""}` : "never checked"}</div>
                </div>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11.5,color:"#6b7280",marginBottom:4}}><span style={{...dim}}>CPU {pct === null ? "—" : `${pct}%`}</span><span style={{...dim}}>RAM {ram}</span><span style={{...dim}}>SSD {s.ssd_used === null ? "—" : `${s.ssd_used}GB`}</span></div>
                  <div style={{height:5,background:"#f3f4f6",borderRadius:3,overflow:"hidden"}}>{pct === null ? null : <div style={{height:"100%",width:`${pct}%`,background:bc,borderRadius:3}}/>}</div>
                  {/* И возраст снимка — под самими показаниями. Два сигнала с
                      разными источниками и разной свежестью: доступность пишет
                      бэкенд раз в 6 часов, метрики снимает десктоп по кнопке. */}
                  <div style={{fontSize:11,color:s.stale?WARN_TEXT:DIM_TEXT,marginTop:3}}>{s.metrics_at ? `metrics ${formatAgo(s.metrics_at)}${s.stale?" · stale":""}` : "no metrics yet"}</div>
                </div>
                <div style={{minWidth:70,textAlign:"right",fontSize:12,color:"#6b7280",...dim}}>{s.uptime ?? "—"}</div>
                <Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge>
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
