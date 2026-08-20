import React, { useState } from "react";

import { Btn, Sel, Modal } from "../ui/Primitives";
import { useBulkCreateDomains, useBulkCreateStructuredDomains, Domain } from "../../api/domains";
import { RegistrarAccount } from "../../api/registrars";
import { Server } from "../../api/servers";
import { BulkCsvError, bulkCsvErrorText, parseBulkCsv } from "../../lib/bulkCsv";
import { optionsByLoad } from "../../lib/fullSetupPlan";

/**
 * Массовое добавление доменов: списком строк или CSV с разделителем `;`.
 *
 * Как и `AddDomainModal`, владеет своими мутациями и отдаёт наверх СОЗДАННЫЕ
 * СТРОКИ, а не отчёт: решение «привязывать ли их к зонам Cloudflare»
 * принадлежит странице, и оба входа (одиночный и массовый) она обслуживает
 * одинаково.
 *
 * Разбор CSV живёт не здесь, а в `lib/bulkCsv`: третья колонка становится
 * `server_id`, по которому provision заливает сайт на машину, и такое правило
 * проверяется без DOM.
 */
export default function BulkAddDialog({
  open,
  onClose,
  registrars,
  servers,
  domains,
  onCreated,
}: {
  /**
   * Диалог живёт, пока живёт страница, и прячется этим флагом, а не
   * размонтированием, — набранный список это переживает.
   *
   * Не косметика: сюда вставляют сотни строк, а закрыть модалку случайно легко
   * (кнопка Cancel в сантиметре от Import, крестик, клик мимо). Отмонтированный
   * диалог терял бы весь ввод молча, и восстановить его было бы нечем. Успешный
   * импорт поля чистит сам — там ввод уже отработал.
   */
  open: boolean;
  onClose: () => void;
  registrars: RegistrarAccount[];
  /** Серверы для селекта и для резолва третьей колонки CSV. */
  servers: Server[];
  /**
   * Весь список доменов — из него считается нагрузка в подписи пункта.
   *
   * Именно строки API (`Domain`), а не `DomainUI` вкладки: тот же тип, что у
   * `FullSetupFields`, и тот же счёт. Собранный из вью-модели, список серверов
   * разъехался бы с мастером полной настройки на первой правке — а это один и
   * тот же вопрос «куда селить домен», заданный дважды.
   */
  domains: Domain[];
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
  const [bulkServerId, setBulkServerId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [bulkError, setBulkError] = useState("");
  /**
   * Непонятые серверы последней попытки — ТОЛЬКО для показа.
   *
   * Отправку держит локальный результат разбора внутри ветки CSV, а не этот
   * стейт: решение «не отправлять» обязано принадлежать той же попытке, что и
   * разбор. Иначе список, оставшийся от прошлой попытки, однажды заблокировал
   * бы вкладку, у которой третьей колонки нет вовсе.
   */
  const [csvErrors, setCsvErrors] = useState<BulkCsvError[]>([]);

  const serverOptions = optionsByLoad(servers, domains, (d) => d.server_id);

  /**
   * Закрытие гасит ошибку ПРОШЛОЙ попытки, но не набранный текст.
   *
   * Разные сроки жизни у разных вещей: список доменов пользователь набирал сам
   * и потерять его от промаха по Cancel нельзя, а красное «все домены
   * пропущены» относится к отправке, которой больше нет, — увиденное при
   * следующем открытии, оно описывало бы несуществующее событие.
   */
  const close = () => {
    setBulkError("");
    setCsvErrors([]);
    onClose();
  };

  const handleBulkAdd = async () => {
    setBulkError("");
    setCsvErrors([]);
    try {
      if (bulkTab === "text") {
        const lines: string[] = bulkText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          setBulkError("Please enter at least one domain");
          return;
        }
        const result = await bulkCreate.mutateAsync({
          domains_text: lines.join("\n"),
          registrar_id: bulkRegId ? Number(bulkRegId) : null,
          server_id: bulkServerId ? Number(bulkServerId) : null
        });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        onClose();
        setBulkText("");
        setBulkRegId("");
        setBulkServerId("");
        // Отдаём наверх ПОСЛЕ закрытия модалки: домены созданы, и это главный
        // результат. Всё, что страница делает дальше (привязка к зонам), от
        // него отделено — её ошибки не должны выглядеть как провал импорта.
        onCreated(result.created);
      } else {
        if (!csvText.trim()) {
          setBulkError("Please enter at least one CSV line");
          return;
        }

        const parsed = parseBulkCsv(csvText, {
          servers,
          defaultServerId: bulkServerId ? Number(bulkServerId) : null,
          defaultRegistrarId: bulkRegId ? Number(bulkRegId) : null,
        });

        if (parsed.commaSeparated) {
          setBulkError("Похоже, вы используете запятые вместо точек с запятой. Пожалуйста, исправьте разделитель.");
          return;
        }

        // Непонятый сервер — это отказ отправлять ВСЮ пачку, а не молчаливый
        // пропуск: домен, заведённый без сервера, ничем не отличается от
        // заведённого правильно, пока по нему не запустят provision, а
        // исходный текст к тому моменту уже негде взять.
        if (parsed.errors.length > 0) {
          setCsvErrors(parsed.errors);
          return;
        }

        if (parsed.items.length === 0) {
          setBulkError("No valid domains found in CSV");
          return;
        }

        const result = await bulkStructured.mutateAsync({ items: parsed.items });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        onClose();
        setCsvText("");
        setBulkRegId("");
        setBulkServerId("");
        // Та же отдача наверх, что и у текстовой ветки: путь создания другой
        // (`/domains/bulk-structured`), а домены — те же.
        onCreated(result.created);
      }
    } catch (err: any) {
      setBulkError(err.response?.data?.message || err.message || "Failed to import domains");
    }
  }

  if (!open) return null;

  return <Modal title="Bulk Add Domains" onClose={close} width={520}>
    <div style={{display:"flex",background:"#f3f4f6",borderRadius:8,padding:3,marginBottom:20}}>
      {[["text","Plain Text"],["csv","CSV / Semicolon"]].map(([k,l])=>(
        <button key={k} onClick={()=>setBulkTab(k as string)} style={{flex:1,padding:"8px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,fontFamily:"inherit",transition:"all 0.15s",background:bulkTab===k?"#2563eb":"transparent",color:bulkTab===k?"#fff":"#6b7280"}}>{bulkTab===k&&"✓ "}{l}</button>
      ))}
    </div>

    {bulkTab === "text" ? <>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Enter one domain per line. Duplicates will be skipped.</p>
      <textarea value={bulkText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>setBulkText(e.target.value)} placeholder={"example.com\nshop.example.com\nblog.example.com"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
    </> : <>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Paste values in format: <code style={{background:"#eee",padding:2}}>domain.com;provider_name;server_ip_or_name</code></p>
      {/* Правка текста гасит ОБЕ красные коробки, а не одну: и список строк, и
          вердикт про разделитель — приговоры ПРОШЛОМУ тексту. Строка №4,
          оставшаяся после того, как её исправили, показывает на чужую строку, а
          «вы используете запятые», переживший замену запятых, — просто неправда.
          Правила у двух одинаковых коробок на одной вкладке обязаны совпадать. */}
      <textarea value={csvText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>{setCsvText(e.target.value); if (csvErrors.length) setCsvErrors([]); if (bulkError) setBulkError("");}} placeholder={"example.com;Namecheap;45.83.194.107\nshop.com;Hostiq;web-01"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
    </>}

    {/* Селекты — снаружи веток: вопрос «куда селим пачку» одинаков на обеих
        вкладках, а стоя внутри текстовой, сервер был недоступен там, где домены
        как раз и заливают сотнями. На CSV они значат «по умолчанию»: своя
        колонка строки всегда сильнее. */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,margin:"14px 0"}}>
      <label style={{display:"block"}}><span style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign to Registrar</span><Sel value={bulkRegId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setBulkRegId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></label>
      {/* Список серверов — тот же, что у мастера полной настройки
          (`optionsByLoad`): подписи с нагрузкой и порядок «наименее загруженные
          сверху». Второй вид одного списка разъехался бы на первой правке. */}
      <label style={{display:"block"}}><span style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign to Server</span><Sel value={bulkServerId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setBulkServerId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{serverOptions.map((s)=><option key={s.id} value={s.id}>{s.label}</option>)}</Sel></label>
    </div>

    {bulkTab === "csv" && <p style={{fontSize:12,color:"#6b7280",marginTop:-6,marginBottom:14}}>Подставляются в строки, где второй (регистратор) или третьей (сервер) колонки нет.</p>}

    {/* Список рисуется только на своей вкладке: на «Plain Text» третьей колонки
        нет, и новость про её строки там была бы про чужой ввод. */}
    {bulkTab === "csv" && csvErrors.length > 0 && (
      <div style={{background:"#fef2f2",border:"1px solid #fee2e2",color:"#dc2626",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>
        <div style={{fontWeight:600,marginBottom:6}}>❌ Ничего не отправлено — эти строки не приняты:</div>
        {csvErrors.map((e) => (
          <div key={e.line}>Строка {e.line}: {bulkCsvErrorText(e)}</div>
        ))}
      </div>
    )}

    {bulkError && <div style={{background:"#fef2f2",border:"1px solid #fee2e2",color:"#dc2626",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>❌ {bulkError}</div>}

    <Btn variant="primary" onClick={handleBulkAdd} disabled={bulkCreate.isPending || bulkStructured.isPending} style={{width:"100%",justifyContent:"center",padding:"10px 0", marginTop: 14}}>{(bulkCreate.isPending || bulkStructured.isPending) ? "Importing..." : "Import Domains"}</Btn>
    <div style={{marginTop:8}}><Btn variant="secondary" onClick={close} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
  </Modal>;
}
