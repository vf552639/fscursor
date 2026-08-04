import React, { useState } from "react";
import { Card, CHd, CTi, CBo, StatCard, Badge, Btn, Modal, Inp, EmptyState, ErrorState } from "../components/ui/Primitives";
import { useRegistrarAccounts, useCreateRegistrarAccount, useTestRegistrarConnection, useUpdateRegistrarAccount, useDeleteRegistrarAccount, RegistrarProvider } from "../api/registrars";
import { useSystemConfig, useTestNotificationDelivery, useUpdateSystemConfig } from "../api/settings";
import { describeQueryError } from "../lib/queryError";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { BLOB_KIND } from "../lib/secretBlob";
import { useMultiSecretSave } from "../hooks/useSecretSave";
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";
import RecoveryPhraseCard from "./RecoveryPhraseCard";

/**
 * Как поля секретов регистратора называются пользователю. Одни и те же на
 * форме создания и правки: из них хук собирает и «… is required», и текст
 * ошибки записи, а два набора формулировок разъехались бы.
 *
 * `apiSecret` — это НЕ второй ключ: десктоп отдаёт его Namecheap как
 * whitelisted client IP (`commands/registrars.rs`), поэтому и подпись про IP.
 *
 * ИЗМЕНЕНИЕ ПОВЕДЕНИЯ: на создании Namecheap-аккаунта IP теперь ОБЯЗАТЕЛЕН —
 * ключ всегда объявлен в `saveAll`, а пустое значение хук отбивает. Раньше
 * аккаунт заводился вообще без IP, и это была ловушка: поле было нарисовано,
 * но никуда не вело, а десктоп подставлял `127.0.0.1` (`make_service`), после
 * чего Namecheap отбивал вызовы по whitelist. Отказ формы честнее, чем
 * заведённый аккаунт, который не работает и не говорит почему. У Hostiq поля
 * нет, ключ не объявляется, `api_secret_blob_id` остаётся NULL — и это верно:
 * этот параметр Hostiq не получает вовсе.
 */
const REGISTRAR_SECRETS = { apiKey: "API key", apiSecret: "Client IP" } as const;

/** Client IP получает только Namecheap: Hostiq этот параметр не читает вовсе. */
function usesClientIp(provider: string): boolean {
  return provider.toLowerCase() === "namecheap";
}

export default function Settings(){
  const { data: registrarsData, isPending, isError, error } = useRegistrarAccounts();
  const testReg = useTestRegistrarConnection();
  const deleteReg = useDeleteRegistrarAccount();
  const { data: systemConfigData } = useSystemConfig();
  const updateSystemConfig = useUpdateSystemConfig();
  const testDelivery = useTestNotificationDelivery();

  const registrars = registrarsData || [];

  const [tab,setTab]=useState("registrars"); const [showAdd,setSA]=useState(false);

  const [testing,setTest]=useState<any>({}); const [testRes,setRes]=useState<any>({});
  const [editingRegistrar, setEditingRegistrar] = useState<any | null>(null);
  const [editingSystem, setEditingSystem] = useState<{ key: string; value: string } | null>(null);
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
        {/* В вебе на месте кнопки заметка, а не форма за ней: почему так и
            почему без дип-линка — тот же блок в `Cloudflare.tsx`. */}
        {isTauri() ? (
          <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Registrar</Btn>
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
        {[
          ["Total",registrars.length,"#2563eb"],
          ["Active",registrars.filter((r: any)=>r.is_active).length,"#16a34a"]
        ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
      </div>
      {isError ? (
        <ErrorState
          title={describeQueryError(error).title}
          message={`Registrar accounts could not be loaded. ${describeQueryError(error).message}`}
          hint={describeQueryError(error).hint}
        />
      ) : isPending ? (
        <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading registrars...</div>
      ) : registrars.length === 0 ? (
        <Card>
          <EmptyState
            title="No registrar accounts yet"
            description="Add Hostiq or Namecheap credentials to assign domains to registrars."
          >
            {/* Второй вход в ту же форму — и в вебе он закрыт по той же причине;
                объяснение уже стоит в шапке, повторять его тут незачем. */}
            {isTauri() ? <Btn variant="primary" onClick={() => setSA(true)}>+ Add Registrar</Btn> : null}
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
              <Btn size="sm" variant="danger" onClick={() => { if (!confirm(`Delete registrar ${r.name}?`)) return; deleteReg.mutate(r); }}>✕</Btn>
            </div>
          </div>
        </Card>;
      })}
      {showAdd && <AddRegistrarModal onClose={()=>setSA(false)} />}
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
    {tab==="encryption"&&<><Card>
      <CHd><CTi>🔑 Encryption Settings</CTi></CHd>
      <CBo>
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:9,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"flex-start",gap:10}}>
          <span style={{fontSize:18}}>✓</span>
          <div><div style={{fontSize:13.5,fontWeight:600,color:"#16a34a"}}>{ENCRYPTION_BANNER.title}</div><div style={{fontSize:12.5,color:"#15803d",marginTop:2}}>{ENCRYPTION_BANNER.body}</div></div>
        </div>
        {ENCRYPTION_INFO.map(([k,v])=>(
          <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"11px 0",borderBottom:"1px solid #f3f4f6"}}>
            <div style={{fontSize:13,color:"#6b7280",fontWeight:500}}>{k}</div>
            <div style={{fontSize:13,fontWeight:600,color:"#111",textAlign:"right",maxWidth:340}}>{v}</div>
          </div>
        ))}
      </CBo>
    </Card>
    <RecoveryPhraseCard />
    </>}
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

/**
 * Добавление аккаунта регистратора. Отдельный экспортируемый компонент, а не
 * блок внутри страницы, ровно по той же причине, что и `AddServerModal`:
 * гварды `isTauri()` на трёх полях секретов и кнопке сохранения — это
 * последний рубеж на случай второго вызывающего, и проверить его можно, только
 * отрендерив форму НАПРЯМУЮ. Пока она была инлайном, веб-тест мог лишь кликнуть
 * кнопку, которой в вебе нет, и все утверждения о содержимом выполнялись
 * вакуумно — мутация «все гварды в `true`» проходила зелёной.
 *
 * Плейнтексты стирать при закрытии больше не нужно: страница монтирует форму
 * условно, и `useMultiSecretSave` уезжает вместе с ней.
 */
export function AddRegistrarModal({ onClose }: { onClose: () => void }) {
  const [provider,setProvider]=useState<RegistrarProvider>("hostiq");
  const [accName, setAccName] = useState("");
  const [apiUser, setApiUser] = useState("");
  // Плейнтексты обоих секретов держит хук, а не форма: он же знает, когда их
  // стереть, и он же гарантирует «оба блоба → один POST» (см. useSecretSave).
  const secrets = useMultiSecretSave(REGISTRAR_SECRETS);
  const createReg = useCreateRegistrarAccount();

  const handleAdd = async () => {
    // На СОЗДАНИИ ключи объявляются всегда: пропущенный ключ значит
    // `*_blob_id = NULL` — тот самый 200 OK и «registrar account has no
    // api_key_blob_id» в каждой команде. «Не меняем» бывает только на правке.
    // Client IP объявляем ровно тогда, когда у формы есть его поле.
    const ok = await secrets.saveAll({
      secrets: {
        apiKey: { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: null },
        ...(usesClientIp(provider)
          ? { apiSecret: { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: null } }
          : {}),
      },
      persist: async (blobIds) => {
        await createReg.mutateAsync({
          provider,
          name: accName,
          api_user: apiUser,
          api_key_blob_id: blobIds.apiKey,
          // Спредом, а не `api_secret_blob_id: undefined`: у Hostiq поля быть
          // не должно вовсе, а ключ со значением undefined — это уже поле.
          ...(blobIds.apiSecret ? { api_secret_blob_id: blobIds.apiSecret } : {}),
        });
      },
    });
    if (ok) onClose();
  };

  // Провайдер меняет НАБОР полей — как вкладка в `Servers.tsx` (`handleTabChange`),
  // и по тем же причинам сбрасывает набранное: Client IP, набранный для
  // Namecheap, на Hostiq в сохранение уже не попадёт, а плейнтекст жил бы до
  // размонтирования; ошибка «Client IP is required» после переключения ссылалась
  // бы на поле, которого на экране нет. Во время записи блоба не пускаем вовсе:
  // `setError` упавшей записи приземлился бы на форму с другим набором полей.
  const switchProvider = (next: RegistrarProvider) => {
    if (secrets.saving || next === provider) return;
    setProvider(next);
    secrets.reset();
  };

  // Пока идёт запись блобов или POST, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего создания приземлится в пустоту —
  // канала для этой ошибки у страницы нет. Окно — целый round-trip.
  const closeIfIdle = () => { if (!secrets.saving) onClose(); };

  return <Modal title="Add Registrar Account" onClose={closeIfIdle} width={480}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account Name</label><Inp value={accName} onChange={e=>setAccName((e.target as any).value)} placeholder="e.g., Hostiq Main"/></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:8}}>Provider</label>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[
            ["hostiq","Hostiq","H","#fff7ed","#ea580c"],
            ["namecheap","Namecheap","N","#fef2f2","#dc2626"]
          ].map(([k,l,ic,bg,c])=>(
            <div key={k} onClick={()=>switchProvider(k as RegistrarProvider)} style={{padding:"12px 16px",border:`2px solid ${provider===k?"#2563eb":"#e5e7eb"}`,borderRadius:9,cursor:"pointer",display:"flex",alignItems:"center",gap:10,transition:"all 0.15s",background:provider===k?"#eff4ff":"#fff"}}>
              <div style={{width:32,height:32,borderRadius:7,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:c,fontSize:14}}>{ic}</div>
              <span style={{fontSize:13.5,fontWeight:600,color:provider===k?"#2563eb":"#374151"}}>{l}</span>
            </div>
          ))}
        </div>
      </div>
      {/* Почему в вебе полей нет вовсе — JSDoc `DesktopOnlyNote`.
          `trim` на вводе: ключ копируют из панели регистратора, и `\n` в
          хвосте иначе зашифруется как часть секрета — «сохранено» и отказ
          API без всякой связи с формой. Client IP с пробелом просто не
          совпадёт с whitelist. */}
      {provider==="hostiq"?<>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User (email)</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} placeholder="admin@hostiq.ua"/></div>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key</label>
          {isTauri() ? (
            <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiKey", e.target.value.trim())} placeholder="••••••••••••••••"/>
          ) : (
            <DesktopOnlyNote what="Saving secrets" />
          )}
        </div>
      </>:<>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} placeholder="your_namecheap_username"/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key</label>
            {isTauri() ? (
              <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiKey", e.target.value.trim())} placeholder="••••••••"/>
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
          <div>
            {/* Поле было нарисовано, но ни к чему не подключено: набранный
                IP никуда не уезжал, и аккаунт Namecheap нельзя было
                настроить до конца — десктоп шлёт вместо него 127.0.0.1, а
                Namecheap отвечает отказом по whitelist. */}
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Client IP</label>
            {isTauri() ? (
              <Inp value={secrets.values.apiSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiSecret", e.target.value.trim())} placeholder="127.0.0.1"/>
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
        </div>
        <div style={{fontSize:11.5,color:"#9ca3af",marginTop:-6}}>Namecheap accepts API calls only from IPs whitelisted in your account.</div>
      </>}
    </div>
    {secrets.error && (
      <div role="alert" style={{marginTop:14,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{secrets.error}</div>
    )}
    {/* Страница в вебе сюда не пускает (на месте кнопки заметка) — но это
        ПЕРВЫЙ рубеж, а этот последний: он переживёт второго вызывающего. */}
    {isTauri() && (
      <div style={{display:"flex",gap:8,marginTop:22}}>
        <Btn variant="primary" onClick={handleAdd} disabled={secrets.saving} style={{flex:1,justifyContent:"center"}}>{secrets.saving ? "Adding..." : "Add Account"}</Btn>
      </div>
    )}
    {/* Cancel есть всегда (форма обязана иметь выход), но гаснет на время
        сохранения: см. `closeIfIdle`. */}
    <div style={{marginTop:8}}><Btn variant="secondary" disabled={secrets.saving} onClick={closeIfIdle} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
  </Modal>;
}

function EditRegistrarModal({ registrar, onClose }: { registrar: any; onClose: () => void }) {
  const [name, setName] = useState(registrar.name || "");
  const [apiUser, setApiUser] = useState(registrar.api_user || "");
  const secrets = useMultiSecretSave(REGISTRAR_SECRETS);
  const update = useUpdateRegistrarAccount(registrar.id);
  const hasClientIp = usesClientIp(String(registrar.provider || ""));

  const patch = (blobIds: { apiKey?: string; apiSecret?: string }) => ({
    name: name.trim(),
    api_user: apiUser.trim() || null,
    ...(blobIds.apiKey ? { api_key_blob_id: blobIds.apiKey } : {}),
    ...(blobIds.apiSecret ? { api_secret_blob_id: blobIds.apiSecret } : {}),
  });

  const handleSave = async () => {
    // «Оставь пустым, чтобы сохранить текущий» — это и есть `Partial` у
    // `saveAll`: в `secrets` кладём ТОЛЬКО тронутые поля, у остальных сущность
    // сохраняет прежний `*_blob_id`. Иначе переименование аккаунта требовало бы
    // перенабрать и ключ, и IP. Пустой `secrets` (тронуто ничего) — это тоже
    // рабочий путь: блобов нет, `persist` всё равно зовётся, PUT уходит без
    // ссылок; отдельная ветка мимо хука дала бы второй `saving` и второй канал
    // ошибки на ту же кнопку.
    //
    // `trim` здесь решает ровно один вопрос: тронуто ли поле. Без него `"   "`
    // прошёл бы и проверку пустоты в хуке, и запись — рабочий блоб
    // перезаписался бы пробелами, а восстановить его можно только перенабором.
    // Сам плейнтекст он не чистит: в блоб уезжает стейт хука, а не эти
    // тримленные копии, — пробелы по краям с него снимает `trim` в onChange
    // полей ниже, и никакой второй страховки на плейнтекст здесь нет.
    const touched = {
      apiKey: secrets.values.apiKey.trim() !== "",
      apiSecret: hasClientIp && secrets.values.apiSecret.trim() !== "",
    };
    const ok = await secrets.saveAll({
      secrets: {
        // Это ПРАВКА: переписываем именно текущие блобы. Новый id оставил бы
        // аккаунт указывать на прежний секрет — «сохранено», а в API
        // регистратора едет старый ключ.
        apiKey: touched.apiKey
          ? { blobKind: BLOB_KIND.registrarApiKey, existingBlobId: registrar.api_key_blob_id ?? null }
          : undefined,
        apiSecret: touched.apiSecret
          ? { blobKind: BLOB_KIND.registrarApiSecret, existingBlobId: registrar.api_secret_blob_id ?? null }
          : undefined,
      },
      persist: async (blobIds) => { await update.mutateAsync(patch(blobIds)); },
    });
    if (ok) onClose();
  };

  // Пока идёт запись блобов или PUT, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего сохранения приземлится в пустоту.
  const closeIfIdle = () => { if (!secrets.saving) onClose(); };

  return <Modal title={`Edit ${registrar.name}`} onClose={closeIfIdle} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={name} onChange={e=>setName((e.target as any).value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API User</label><Inp value={apiUser} onChange={e=>setApiUser((e.target as any).value)} /></div>
      {/* Почему в вебе полей нет — JSDoc `DesktopOnlyNote`. Переименовать
          аккаунт в вебе при этом можно: для этого секреты не нужны. */}
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Key (optional)</label>
        {isTauri() ? (
          <Inp type="password" value={secrets.values.apiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiKey", e.target.value.trim())} placeholder="Leave empty to keep current key" />
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
      {hasClientIp && (
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Client IP (optional)</label>
          {isTauri() ? (
            <Inp value={secrets.values.apiSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiSecret", e.target.value.trim())} placeholder="Leave empty to keep current IP" />
          ) : (
            <DesktopOnlyNote what="Saving secrets" />
          )}
        </div>
      )}
    </div>
    {secrets.error && (
      <div role="alert" style={{marginTop:14,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{secrets.error}</div>
    )}
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={secrets.saving || !name.trim()} onClick={handleSave} style={{flex:1,justifyContent:"center"}}>{secrets.saving ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" disabled={secrets.saving} onClick={closeIfIdle} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
