import React, { useState } from "react";

export const copyText = (v: string) => navigator.clipboard?.writeText(v).catch(()=>{});
export const genBars  = (base: number) => Array.from({length:15},()=>Math.max(5,Math.min(100,base+(Math.random()-0.5)*28)));
export const cpuColor = (v: number) => v>=80?"#dc2626":v>=60?"#d97706":"#2563eb";

export function MiniChart({data, color="#2563eb"}: {data: number[], color?: string}){
  const max=Math.max(...data,1);
  return <div style={{display:"flex",alignItems:"flex-end",gap:2,height:36}}>
    {data.map((v,i)=><div key={i} style={{width:4,borderRadius:"2px 2px 0 0",flexShrink:0,height:Math.max(4,(v/max)*36),background:color,opacity:0.55+(i/data.length)*0.45}}/>)}
  </div>;
}

export function StatusDot({status, size=9}: {status: string, size?: number}){
  const c: Record<string, string>={healthy:"#16a34a",warning:"#d97706",critical:"#dc2626",ok:"#16a34a",error:"#dc2626",pending:"#d97706",active:"#16a34a",paused:"#9ca3af"};
  const g: Record<string, string>={healthy:"#bbf7d0",warning:"#fde68a",critical:"#fecaca"};
  const bg = c[status] || "#9ca3af";
  const shadow = g[status] ? `0 0 0 3px ${g[status]}` : "none";
  return <span style={{display:"inline-block",width:size,height:size,borderRadius:"50%",background:bg,boxShadow:shadow,flexShrink:0}}/>;
}

export function Badge({children, variant="gray", style}: {children: React.ReactNode, variant?: string, style?: React.CSSProperties}){
  const m: Record<string, {bg: string, c: string}>={
    gray:{bg:"#f3f4f6",c:"#374151"},
    blue:{bg:"#eff4ff",c:"#2563eb"},
    green:{bg:"#f0fdf4",c:"#16a34a"},
    yellow:{bg:"#fffbeb",c:"#d97706"},
    red:{bg:"#fef2f2",c:"#dc2626"},
    purple:{bg:"#faf5ff",c:"#7c3aed"}
  };
  const s=m[variant]||m.gray;
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:600,letterSpacing:"0.3px",background:s.bg,color:s.c,...style}}>{children}</span>;
}

export function ErrorState({
  title = "Unable to load data",
  message,
  hint,
  style,
}: {
  title?: string;
  message: string;
  hint?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 12,
        padding: "18px 20px",
        marginBottom: 16,
        ...style,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#b91c1c", marginBottom: hint ? 8 : 0, lineHeight: 1.45 }}>{message}</div>
      {hint ? (
        <div style={{ fontSize: 12, color: "#7f1d1d", fontFamily: "ui-monospace, monospace", wordBreak: "break-word" }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
  style,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "40px 24px",
        textAlign: "center",
        color: "#6b7280",
        ...style,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: description ? 8 : 16 }}>{title}</div>
      {description ? (
        <div
          style={{
            fontSize: 13,
            color: "#6b7280",
            marginBottom: 20,
            maxWidth: 440,
            marginLeft: "auto",
            marginRight: "auto",
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Card({children, style}: {children: React.ReactNode, style?: React.CSSProperties}){
  return <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,...style}}>{children}</div>;
}
export function CHd({children, style}: {children: React.ReactNode, style?: React.CSSProperties}){
  return <div style={{padding:"15px 20px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between",...style}}>{children}</div>;
}
export function CTi({children}: {children: React.ReactNode}){
  return <div style={{fontSize:14,fontWeight:600,color:"#111",display:"flex",alignItems:"center",gap:8}}>{children}</div>;
}
export function CBo({children, style}: {children: React.ReactNode, style?: React.CSSProperties}){
  return <div style={{padding:20,...style}}>{children}</div>;
}

export function Btn({children, variant="secondary", size="md", onClick, style, disabled}: any){
  const sz: any={sm:{fontSize:12,padding:"6px 11px"},md:{fontSize:13,padding:"8px 15px"},lg:{fontSize:14,padding:"10px 20px"}};
  const va: any={
    primary:{background:"#2563eb",color:"#fff",border:"none"},
    secondary:{background:"#fff",color:"#374151",border:"1px solid #e5e7eb"},
    danger:{background:"#fef2f2",color:"#dc2626",border:"1px solid #fecaca"},
    ghost:{background:"transparent",color:"#6b7280",border:"none"}
  };
  return <button onClick={onClick} disabled={disabled}
    style={{display:"inline-flex",alignItems:"center",gap:6,borderRadius:8,fontFamily:"'Inter',sans-serif",fontWeight:500,cursor:disabled?"not-allowed":"pointer",transition:"all 0.15s",opacity:disabled?0.5:1,...sz[size],...va[variant],...style}}
    onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter="brightness(0.93)";}}
    onMouseLeave={e=>{e.currentTarget.style.filter="none";}}
  >{children}</button>;
}

export function Inp({value, onChange, placeholder, type="text", style}: any){
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder}
    style={{width:"100%",padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,color:"#111",background:"#f9fafb",outline:"none",boxSizing:"border-box",...style}}
    onFocus={e=>{e.currentTarget.style.borderColor="#2563eb";e.currentTarget.style.background="#fff";}}
    onBlur={e=>{e.currentTarget.style.borderColor="#e5e7eb";e.currentTarget.style.background="#f9fafb";}}/>;
}

export function Sel({value, onChange, children, style}: any){
  return <select value={value} onChange={onChange}
    style={{padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,color:"#111",background:"#fff",outline:"none",cursor:"pointer",...style}}>
    {children}
  </select>;
}

export function Modal({title, onClose, children, width=480}: any){
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div style={{background:"#fff",borderRadius:14,width,maxWidth:"95vw",boxShadow:"0 20px 60px rgba(0,0,0,0.18)",padding:28,position:"relative",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div style={{fontSize:18,fontWeight:700,color:"#111"}}>{title}</div>
        <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"#9ca3af",lineHeight:1}}>✕</button>
      </div>
      {children}
    </div>
  </div>;
}

export function StatCard({label, value, sub, pct, color="#2563eb", chartData}: any){
  return <Card>
    <div style={{padding:"18px 20px"}}>
      <div style={{fontSize:12,fontWeight:500,color:"#6b7280",marginBottom:6}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,color:"#111",lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:12,color:"#6b7280",marginTop:4}}>{sub}</div>}
      {chartData&&<div style={{marginTop:10}}><MiniChart data={chartData} color={color}/></div>}
      {pct!==undefined&&<div style={{height:4,background:"#f3f4f6",borderRadius:2,marginTop:8,overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:color,width:`${Math.min(100,pct)}%`,transition:"width 0.6s"}}/></div>}
    </div>
  </Card>;
}

export function InfoRow({k, v}: any){
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #f3f4f6"}}><div style={{fontSize:12.5,color:"#6b7280",fontWeight:500}}>{k}</div><div style={{fontSize:13,fontWeight:600,color:"#111",display:"flex",alignItems:"center",gap:6}}>{v}</div></div>;
}

export function ActionIcons({icons=["✎","✕"]}: any){
  return <div style={{display:"flex",gap:5}} data-stub="true">
    {icons.map((ic: string,i: number)=><div key={i} style={{width:28,height:28,border:"1px solid #e5e7eb",borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,color:"#6b7280",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background="#eff4ff";e.currentTarget.style.color="#2563eb";}} onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color="#6b7280";}}>{ic}</div>)}
  </div>;
}

type RowAction = {
  icon: string;
  title: string;
  onClick?: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
};

export function RowActions({ actions = [] }: { actions: RowAction[] }) {
  return <div style={{display:"flex",gap:5}}>
    {actions.map((a, i) => {
      const isDanger = a.variant === "danger";
      // Как в Btn: заблокированное действие не просто инертно, оно и выглядит так.
      const isDisabled = Boolean(a.disabled);
      return (
        <button
          key={`${a.title}-${i}`}
          type="button"
          title={a.title}
          aria-label={a.title}
          onClick={a.onClick}
          disabled={isDisabled}
          style={{width:28,height:28,border:"1px solid #e5e7eb",borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:isDisabled?"not-allowed":a.onClick?"pointer":"default",opacity:isDisabled?0.5:1,fontSize:12,color:isDanger?"#dc2626":"#6b7280",transition:"all 0.15s"}}
          onMouseEnter={e=>{if(a.onClick&&!isDisabled){e.currentTarget.style.background=isDanger?"#fef2f2":"#eff4ff";e.currentTarget.style.color=isDanger?"#dc2626":"#2563eb";}}}
          onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color=isDanger?"#dc2626":"#6b7280";}}
        >
          {a.icon}
        </button>
      );
    })}
  </div>;
}

export function CopyBtn({value}: any){
  const [c,setC] = useState(false);
  return <button onClick={()=>{copyText(value);setC(true);setTimeout(()=>setC(false),1400);}} style={{padding:"8px 10px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,color:"#6b7280",flexShrink:0,transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background="#eff4ff";e.currentTarget.style.color="#2563eb";}} onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color="#6b7280";}}>{c?"✓":"⎘"}</button>;
}

export const fmtDate = (iso: string) => iso ? new Date(iso).toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric"}) : "—";
export const fmtDT   = (iso: string) => iso ? new Date(iso).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—";
export const formatUptime = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
};
