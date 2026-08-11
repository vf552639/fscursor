import React, { useState } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { useBulkCreateDomains, useBulkCreateStructuredDomains, Domain } from "../../api/domains";
import { RegistrarAccount } from "../../api/registrars";

/**
 * Массовое добавление доменов: списком строк или CSV с разделителем `;`.
 *
 * Как и `AddDomainModal`, владеет своими мутациями и отдаёт наверх СОЗДАННЫЕ
 * СТРОКИ, а не отчёт: решение «привязывать ли их к зонам Cloudflare»
 * принадлежит странице, и оба входа (одиночный и массовый) она обслуживает
 * одинаково.
 */
export default function BulkAddDialog({
  onClose,
  registrars,
  onCreated,
}: {
  onClose: () => void;
  registrars: RegistrarAccount[];
  /**
   * Созданные строки — наверх, странице. Свои ошибки получатель показывает сам:
   * превратить их в `bulkError` значило бы объявить провалом успешный импорт.
   */
  onCreated: (domains: Domain[]) => void;
}) {
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

        onClose();
        setBulkText("");
        setBulkRegId("");
        // Отдаём наверх ПОСЛЕ закрытия модалки: домены созданы, и это главный
        // результат. Всё, что страница делает дальше (привязка к зонам), от
        // него отделено — её ошибки не должны выглядеть как провал импорта.
        onCreated(result.created);
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

        onClose();
        setCsvText("");
        // Та же отдача наверх, что и у текстовой ветки: путь создания другой
        // (`/domains/bulk-structured`), а домены — те же.
        onCreated(result.created);
      }
    } catch (err: any) {
      setBulkError(err.response?.data?.message || err.message || "Failed to import domains");
    }
  }

  return <Modal title="Bulk Add Domains" onClose={onClose} width={520}>
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
    <div style={{marginTop:8}}><Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
  </Modal>;
}
