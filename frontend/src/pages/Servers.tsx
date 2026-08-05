import React, { useState } from "react";
import { Card, CHd, CTi, CBo, Btn, Sel, Inp, Modal, Badge, StatusDot, MiniChart, genBars, cpuColor, EmptyState, ErrorState, formatUptime } from "../components/ui/Primitives";
import { useServers, useCreateServer } from "../api/servers";
import ServerBulkImportDialog from "../components/ServerBulkImportDialog";
import { OpenInDesktop } from "../components/OpenInDesktop";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { BLOB_KIND } from "../lib/secretBlob";
import { useSecretSave } from "../hooks/useSecretSave";
import { describeQueryError } from "../lib/queryError";
import { fastpanelUrlError, fastpanelUserError } from "../lib/fastpanelInput";
import { providerError, providerOptions, providerPayload } from "../lib/providerInput";

/** id `<datalist>` с подсказками провайдеров: на него ссылается `list` у поля. */
const PROVIDER_LIST_ID = "add-server-provider-options";

/**
 * Значение «фильтр по провайдеру выключен» — пустая строка, а НЕ "All", как у
 * соседнего фильтра статусов. Статусы — закрытый список из пяти слов, и «All»
 * с ними не столкнётся; провайдер — свободный текст, и сервер с именем
 * провайдера «All» превратил бы выбор своего имени в «показать все». Пустой
 * строкой имя провайдера быть не может: схема на бэкенде приводит её к `NULL`.
 */
const ALL_PROVIDERS = "";

/**
 * `providers` — обязательный проп, а не `useServers()` внутри: список серверов
 * страница УЖЕ загрузила, и второй его источник умел бы с ним разойтись. И не
 * опциональный с дефолтом `[]`: забытая передача — это молча пустые подсказки,
 * то есть ровно тот дефект, ради которого подсказки и заводились (второй
 * «Hetzner» с другой буквы).
 */
export function AddServerModal({onClose, providers}: {onClose: ()=>void, providers: string[]}){
  const [tab,setTab]=useState("install");
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [login, setLogin] = useState("root");
  const [os, setOs] = useState("Ubuntu 22.04 LTS (x86_64)");
  const [provider, setProvider] = useState("");
  const [fastpanelUrl, setFastpanelUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // По хуку на вкладку, а не одно поле `password` на обе: поля называются
  // одинаково, а виды секретов разные, и общее состояние отправляло бы пароль
  // панели в блоб под `blobKind: server_ssh_password`.
  const sshPassword = useSecretSave("SSH password");
  const fastpanelPassword = useSecretSave("FastPanel password");

  const create = useCreateServer();
  // Вкладка на экране одна, поэтому и ошибка показывается от её хука: она про
  // поле, к которому пользователь вернётся. ТОЛЬКО ошибка: `saving` привязан не
  // к полю, а к модалке — `reset()` его не трогает, и по видимому хуку нельзя
  // ни гасить кнопку, ни решать, можно ли уйти со вкладки.
  const secret = tab === "install" ? sshPassword : fastpanelPassword;
  const saving = sshPassword.saving || fastpanelPassword.saving || create.isPending;

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Server name is required";
    // Общее для обеих вкладок: сервер заводится и той, и другой. Проверяется
    // здесь, до `save()`, потому что порядок — «блоб → сервер»: 422 за
    // провайдера прилетел бы уже ПОСЛЕ записи секретного блоба и оставил бы в
    // хранилище секрет, на который никто не ссылается.
    const provError = providerError(provider);
    if (provError) newErrors.provider = provError;

    if (tab === "install") {
      if (!ip.trim()) newErrors.ip = "IP address is required";
      // Basic IP regex
      else if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip.trim())) newErrors.ip = "Invalid IP address format";
      if (!sshPassword.value) newErrors.password = "SSH Password is required for installation";
    } else {
      // Не только «поле не пустое»: схему записи на бэкенде теперь стережёт
      // валидатор (`fastpanel_url` без userinfo, с http(s) и портом), а его
      // 422 приезжает в форму как `[object Object]` — см. `lib/fastpanelInput`.
      const urlError = fastpanelUrlError(fastpanelUrl);
      if (urlError) newErrors.fastpanelUrl = urlError;
      const loginError = fastpanelUserError(login);
      if (loginError) newErrors.login = loginError;
      if (!fastpanelPassword.value) newErrors.password = "Password is required";
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleTabChange = (newTab: string) => {
    // Пока сохранение летит — не пускаем: `setError` упавшей записи приземлился
    // бы на хук уже скрытой вкладки, а плейнтекст, который хук держит для
    // повтора, стёр бы `reset` ниже. Окно не мгновенное: `vault_put_blob` —
    // это сетевой PUT на бэкенд, то есть round-trip целиком.
    if (saving) return;
    setTab(newTab);
    setErrors({});
    // Набранный секрет не переезжает между вкладками: поля называются
    // одинаково («Password»), а виды секретов разные, и пароль панели,
    // набранный на connect, уехал бы в блоб как SSH-пароль сервера.
    sshPassword.reset();
    fastpanelPassword.reset();
    if (newTab === "install") {
      setLogin("root");
    } else {
      setLogin("fastuser");
    }
  };

  const handleIpChange = (newIp: string) => {
    setIp(newIp);
    if (tab === "connect") {
      // If URL is empty or matches the previous auto-filled IP pattern
      const oldDefault = `https://${ip}:8888`;
      if (!fastpanelUrl || fastpanelUrl === oldDefault) {
        setFastpanelUrl(`https://${newIp}:8888`);
      }
    }
  };
  
  const handleAdd = async () => {
    if (!validate()) return;
    let payload_ip = ip;
    let payload_url = "";

    if (tab === "connect") {
      // Try to extract IP from Fastpanel URL if IP field is hidden/empty
      try {
        const urlObj = new URL(fastpanelUrl.startsWith('http') ? fastpanelUrl : `https://${fastpanelUrl}`);
        payload_ip = urlObj.hostname;
      } catch (e) {
        // Fallback for simple strings like "192.168.1.1:8888"
        payload_ip = fastpanelUrl.replace(/https?:\/\//, '').split(':')[0].split('/')[0];
      }
      // Обрезанное — ровно то, что проверил `fastpanelUrlError`. Прежний
      // фолбэк на `https://${payload_ip}:8888` убран: пустое поле сюда больше
      // не доходит, а собранный из огрызка URL противоречил бы тому, что
      // человек видит в поле.
      payload_url = fastpanelUrl.trim();
    }

    if (tab === "install") {
      // Порядок «блоб → сервер», запрет отката блоба и то, почему плейнтекст
      // не едет в аргументы мутации, — внутри `useSecretSave`. Провал не
      // создаёт сервер вовсе: сервер с `ssh_password_blob_id = NULL` — это
      // 200 OK и баннер «SSH не настроен», который никогда не уйдёт.
      const ok = await sshPassword.save({
        blobKind: BLOB_KIND.serverSshPassword,
        existingBlobId: null,
        persist: async (blobId) => {
          await create.mutateAsync({
            name: name,
            ip_address: payload_ip,
            ssh_user: login,
            ssh_password_blob_id: blobId,
            os: os,
            provider: providerPayload(provider),
          });
        },
      });
      if (ok) onClose();
    } else {
      // Тот же порядок «блоб → сервер», и провал так же не создаёт сервер:
      // запись с `fastpanel_password_blob_id = NULL` — это подключение к уже
      // стоящей панели, к которой нечем подключиться.
      const ok = await fastpanelPassword.save({
        blobKind: BLOB_KIND.serverFastpanelPassword,
        existingBlobId: null,
        persist: async (blobId) => {
          await create.mutateAsync({
            name: name,
            ip_address: payload_ip,
            ssh_user: "root", // Default SSH user for backend schema
            os: os,
            provider: providerPayload(provider),
            fastpanel_user: login,
            fastpanel_password_blob_id: blobId,
            fastpanel_url: payload_url,
            fastpanel_status: "installed",
          });
        },
      });
      if (ok) onClose();
    }
  };

  return <Modal title="Add Server" onClose={onClose} width={500}>
    <div style={{display:"flex",background:"#f3f4f6",borderRadius:8,padding:3,marginBottom:20}}>
      {[["install","Install New Fastpanel"],["connect","Connect Existing Fastpanel"]].map(([k,l])=>(
        <button key={k} onClick={()=>handleTabChange(k)} style={{flex:1,padding:"8px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,fontFamily:"inherit",transition:"all 0.15s",background:tab===k?"#2563eb":"transparent",color:tab===k?"#fff":"#6b7280"}}>{tab===k&&"✓ "}{l}</button>
      ))}
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{fontSize:12.5,color:"#6b7280",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
        {tab === "install"
          ? "Install New Fastpanel: server is created, then FastPanel installation starts over SSH."
          : "Connect Existing Fastpanel: server is created with existing panel credentials and initial sync/metrics checks."}
      </div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Server Name</label>
        <Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setName((e.target as any).value); if(errors.name) setErrors(prev=>({...prev, name:""}));}} placeholder="e.g., production-web-01" style={{borderColor: errors.name ? "#dc2626" : undefined}}/>
        {errors.name && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.name}</div>}
      </div>
      
      {tab === "install" ? (
        <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div>
              <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>IP Address</label>
              <Inp value={ip} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{handleIpChange((e.target as any).value); if(errors.ip) setErrors(prev=>({...prev, ip:""}));}} placeholder="e.g., 192.168.1.100" style={{borderColor: errors.ip ? "#dc2626" : undefined}}/>
              {errors.ip && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.ip}</div>}
            </div>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Login</label><Inp value={login} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setLogin((e.target as any).value)} placeholder="e.g., root"/></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>OS</label><Sel value={os} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setOs((e.target as any).value)} style={{width:"100%"}}><option>Ubuntu 22.04 LTS (x86_64)</option><option>Ubuntu 20.04 LTS (x86_64)</option><option>Debian 12 (x86_64)</option></Sel></div>
            <div>
              <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Password</label>
              {/* Почему в вебе поля нет вовсе — JSDoc `DesktopOnlyNote`. Сервер
                  без SSH завести можно и в вебе: кнопка формы там и так ведёт
                  в десктоп (OpenInDesktop ниже). */}
              {isTauri() ? (
                <>
                  <Inp type="password" value={sshPassword.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{sshPassword.setValue((e.target as any).value); if(errors.password) setErrors(prev=>({...prev, password:""}));}} placeholder="••••••••" style={{borderColor: errors.password ? "#dc2626" : undefined}}/>
                  {errors.password && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.password}</div>}
                </>
              ) : (
                <DesktopOnlyNote what="Saving secrets" />
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel URL</label>
            <Inp value={fastpanelUrl} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setFastpanelUrl((e.target as any).value); if(errors.fastpanelUrl) setErrors(prev=>({...prev, fastpanelUrl:""}));}} placeholder="https://192.168.1.100:8888" style={{borderColor: errors.fastpanelUrl ? "#dc2626" : undefined}}/>
            {errors.fastpanelUrl && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.fastpanelUrl}</div>}
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>OS (optional)</label>
            <Sel value={os} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setOs((e.target as any).value)} style={{width:"100%"}}>
              <option value="">Auto-detect on first metrics check</option>
              <option>Ubuntu 22.04 LTS (x86_64)</option>
              <option>Ubuntu 20.04 LTS (x86_64)</option>
              <option>Debian 12 (x86_64)</option>
            </Sel>
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel Login</label>
            <Inp value={login} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setLogin((e.target as any).value); if(errors.login) setErrors(prev=>({...prev, login:""}));}} placeholder="Enter login" style={{borderColor: errors.login ? "#dc2626" : undefined}}/>
            {errors.login && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.login}</div>}
          </div>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Fastpanel Password</label>
            {/* Как на install выше. Кнопки сохранения в вебе нет ни на одной
                вкладке (ниже вместо неё OpenInDesktop), так что сервер без
                пароля панели отсюда и не завести. */}
            {isTauri() ? (
              <>
                <Inp type="password" value={fastpanelPassword.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{fastpanelPassword.setValue(e.target.value); if(errors.password) setErrors(prev=>({...prev, password:""}));}} placeholder="Enter password" style={{borderColor: errors.password ? "#dc2626" : undefined}}/>
                {errors.password && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.password}</div>}
              </>
            ) : (
              <DesktopOnlyNote what="Saving secrets" />
            )}
          </div>
        </>
      )}
      {/* Вне ветвления по вкладкам: сервер заводится обеими, и поле, забытое на
          одной из них, потеряло бы провайдера у половины серверов. Стоит
          последним — после выбора OS и ввода пароля, как просил пользователь.

          Свободный текст с подсказками, а не `<select>` с фиксированным
          списком: провайдеров у пользователя десятки, и новый не должен
          требовать правки кода. `datalist` при этом решает ровно ту задачу, ради
          которой список был бы нужен: значение служит ключом группировки для
          фильтра, и «hetzner» рядом с «Hetzner» дали бы двух разных. */}
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Hosting Provider <span style={{color:"#9ca3af",fontWeight:400}}>(optional)</span></label>
        <Inp
          value={provider}
          list={PROVIDER_LIST_ID}
          onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setProvider(e.target.value); if(errors.provider) setErrors(prev=>({...prev, provider:""}));}}
          placeholder="e.g., Hetzner"
          style={{borderColor: errors.provider ? "#dc2626" : undefined}}
        />
        <datalist id={PROVIDER_LIST_ID}>
          {providers.map(p=><option key={p} value={p}/>)}
        </datalist>
        {errors.provider && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.provider}</div>}
      </div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      {/* Ошибка сохранения — в самой форме, а не в `alert`: она про поле, к
          которому пользователь сейчас вернётся, и текст у неё тот же, что в
          модалке SSH на карточке сервера. */}
      {secret.error && (
        <div role="alert" style={{padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{secret.error}</div>
      )}
      {isTauri() ? (
        <Btn variant="primary" onClick={handleAdd} disabled={saving} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{saving ? "Adding..." : tab==="install"?"Add Server":"Save"}</Btn>
      ) : (
        <OpenInDesktop
          variant="primary"
          action="add-server"
          label={tab === "install" ? "Add server in desktop app" : "Connect server in desktop app"}
          desktopOnClick={() => {}}
        />
      )}
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

export default function Servers({onNav}: {onNav: (page: string, ctx?: any)=>void}){
  const [view,setView]=useState("grid");
  const [filter,setFilter]=useState("All");
  // Отдельным состоянием, но в ТУ ЖЕ цепочку `filtered` ниже: второй механизм
  // фильтрации показывал бы в поиске и в фильтре разные списки.
  const [providerFilter,setProviderFilter]=useState(ALL_PROVIDERS);
  const [search,setSearch]=useState("");
  const [showAdd,setShowAdd]=useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);

  const { data, isPending, isError, error, refetch } = useServers();
  
  const toUiStatus = (s: any) => {
    if (s.last_check_ok === false || s.status === "error") return "error";
    if (s.status === "active") return "active";
    if (s.status === "provisioned") return "provisioned";
    return "new";
  };

  // Один источник и для подсказок формы, и для списка фильтра: второй умел бы
  // разойтись с первым — предложить в форме имя, которого нет в фильтре.
  const providers = providerOptions(data?.items || []);

  const servers = (data?.items || []).map((s: any) => ({
    id: s.id,
    name: s.name,
    ip: s.ip_address,
    // Обрезанным — тем же значением, что попадёт в список фильтра
    // (`providerOptions` тоже обрезает). Иначе строка «Hetzner » дала бы пункт
    // «Hetzner», по которому не находится ни один сервер.
    provider: s.provider?.trim() || null,
    os: s.os_pretty || s.os || null,
    status: toUiStatus(s),
    fastpanel: s.fastpanel_status === "installed",
    location: "-",
    uptime: formatUptime(s.uptime_seconds),
    last_check_error: s.last_check_error || null,
    last_check_at: s.last_check_at || null,
    cpu: s.cpu_usage_pct ?? null,
    ram_used: s.ram_used_mb ?? null,
    ram_total: s.ram_total_mb ?? null,
    ssd_used: s.disk_used_gb ?? null,
    ssd_total: s.disk_total_gb ?? null,
    original: s
  }));

  // Фильтр по провайдеру — третье условие ТОЙ ЖЕ цепочки: фильтруем на клиенте,
  // потому что список серверов и так грузится целиком и серверный фильтр без
  // пагинации ничего не экономит.
  const filtered=servers.filter(s=>(filter==="All"||s.status===filter)&&(providerFilter===ALL_PROVIDERS||s.provider===providerFilter)&&(s.name.toLowerCase().includes(search.toLowerCase())||s.ip.includes(search)));
  const Th=({children}: any)=><th style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>{children}</th>;
  
  if (isError) {
    return (
      <div style={{ padding: "8px 0" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 16 }}>Servers</h1>
        <ErrorState
          title={describeQueryError(error).title}
          message={`The servers list could not be loaded. ${describeQueryError(error).message}`}
          hint={describeQueryError(error).hint}
        />
      </div>
    );
  }

  if (isPending) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading servers...</div>;

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
      <h1 style={{fontSize:22,fontWeight:700,color:"#111"}}>Servers</h1>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{display:"flex",border:"1px solid #e5e7eb",borderRadius:8,overflow:"hidden"}}>
          {[["grid","⊞ Grid"],["table","☰ Table"]].map(([v,l])=><button key={v} onClick={()=>setView(v)} style={{padding:"7px 14px",border:"none",cursor:"pointer",fontSize:13,fontWeight:500,fontFamily:"inherit",background:view===v?"#2563eb":"#fff",color:view===v?"#fff":"#6b7280",transition:"all 0.15s"}}>{l}</button>)}
        </div>
        <Sel value={filter} onChange={(e: any)=>setFilter(e.target.value)}>{["All","active","provisioned","new","error"].map(s=><option key={s} value={s}>Status: {s}</option>)}</Sel>
        {/* Список — только встречающиеся имена: фиксированного перечня
            провайдеров нет, и предлагать фильтр по тому, чего в списке нет,
            значит предлагать заведомо пустой экран. `aria-label` потому, что
            подписи рядом нет — её роль играет префикс в каждом пункте. */}
        <Sel aria-label="Filter by hosting provider" value={providerFilter} onChange={(e: any)=>setProviderFilter(e.target.value)}>
          <option value={ALL_PROVIDERS}>Provider: All</option>
          {providers.map(p=><option key={p} value={p}>Provider: {p}</option>)}
        </Sel>
        <div style={{position:"relative"}}><span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{padding:"8px 12px 8px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",width:170,background:"#f9fafb",fontFamily:"inherit"}}/></div>
        <Btn variant="secondary" onClick={() => setShowBulkImport(true)}>⇪ Import</Btn>
        <Btn variant="primary" onClick={()=>setShowAdd(true)}>+ Add Server</Btn>
      </div>
    </div>
    {view==="grid"
      ? <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16}}>
          {servers.length === 0 ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Card>
                <EmptyState
                  title="No servers yet"
                  description="Connect or provision a server to see it here."
                >
                  <Btn variant="primary" onClick={() => setShowAdd(true)}>+ Add Server</Btn>
                </EmptyState>
              </Card>
            </div>
          ) : null}
          {filtered.map(s=>{
            const cpuValue = s.cpu ?? 0;
            const hasCpu = s.cpu !== null;
            const hasDisk = s.ssd_used !== null && s.ssd_total !== null && s.ssd_total > 0;
            const cpuData = hasCpu ? genBars(cpuValue) : [];
            const pct = hasDisk ? (s.ssd_used / s.ssd_total) * 100 : 0;
            const cc = cpuColor(cpuValue);
            const statusBadgeVariant = s.status === "error" ? "red" : s.status === "new" ? "gray" : "green";
            return <div key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:"16px 18px",cursor:"pointer",transition:"box-shadow 0.15s"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.08)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><StatusDot status={s.status}/><span style={{fontSize:14,fontWeight:700,color:"#111"}} title={s.last_check_error || undefined}>{s.name}</span></div>
                <span style={{fontSize:13,color:"#9ca3af"}}>⋯</span>
              </div>
              {/* Провайдер рядом с IP, а не отдельной строкой: фильтр работает и
                  в этом виде, и по карточке должно быть понятно, почему сервер
                  на экране остался. */}
              <div style={{fontSize:12,color:"#6b7280",marginBottom:10}}>{s.provider ? `${s.ip} · ${s.provider}` : s.ip}</div>
              <div style={{display:"flex",gap:6,marginBottom:12}}>{s.os ? <Badge variant="gray">{s.os}</Badge> : null}{s.fastpanel&&<Badge variant="blue">FASTPANEL</Badge>}</div>
              {hasCpu ? <MiniChart data={cpuData} color={cc}/> : <div style={{height:36,fontSize:12,color:"#9ca3af",display:"flex",alignItems:"center"}}>No metrics yet</div>}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 0",marginTop:10,fontSize:12.5}}>
                <span style={{color:"#6b7280"}}>Uptime:</span><span style={{fontWeight:600,textAlign:"right"}}>{s.uptime}</span>
                <span style={{color:"#6b7280"}}>SSD Usage</span><span style={{fontWeight:600,textAlign:"right"}}>{hasDisk ? `${s.ssd_used} GB` : "—"}</span>
                <span style={{color:"#6b7280"}}>CPU %</span><span style={{fontWeight:600,textAlign:"right"}}>{hasCpu ? `${s.cpu}%` : "—"}</span>
              </div>
              {hasDisk ? <div style={{marginTop:10,height:4,background:"#f3f4f6",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:cc,borderRadius:2}}/></div> : null}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10}}>
                <span style={{fontSize:12,color:"#6b7280"}}>Status</span>
                <Badge variant={statusBadgeVariant}>{s.status}</Badge>
              </div>
              <div style={{fontSize:11.5,color:"#9ca3af",marginTop:8}}>Last check: {s.last_check_at ? new Date(s.last_check_at).toLocaleString() : "—"}</div>
            </div>;
          })}
          {servers.length > 0 && filtered.length === 0 ? (
            <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 40, color: "#9ca3af" }}>No servers match filters</div>
          ) : null}
        </div>
      : <Card>
          <div style={{overflowX:"auto"}}>
            {servers.length === 0 ? (
              <EmptyState title="No servers yet" description="Add a server to populate this table.">
                <Btn variant="primary" onClick={() => setShowAdd(true)}>+ Add Server</Btn>
              </EmptyState>
            ) : (
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Name","IP","Provider","OS","CPU","RAM","SSD","Uptime","FastPanel","Status"].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                      No servers match the current filters.
                    </td>
                  </tr>
                ) : null}
                {filtered.map(s=><tr key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <td style={{padding:"12px 16px"}}><div style={{display:"flex",alignItems:"center",gap:8}}><StatusDot status={s.status} size={8}/><span style={{fontWeight:600,fontSize:13.5,color:"#111"}} title={s.last_check_error || undefined}>{s.name}</span></div><div style={{fontSize:11.5,color:"#9ca3af",paddingLeft:16}}>{s.location}</div></td>
                  <td style={{padding:"12px 16px",fontFamily:"monospace",fontSize:13}}>{s.ip}</td>
                  {/* Прочерк, а не пустая ячейка: пустая читается как «данные не
                      доехали», прочерк — как «не заполнено». Так же, как у OS. */}
                  <td style={{padding:"12px 16px",fontSize:13}}>{s.provider || <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px"}}>{s.os ? <Badge variant="gray">{s.os}</Badge> : <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px"}}>{s.cpu !== null ? <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:55,height:5,background:"#f3f4f6",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${s.cpu}%`,background:cpuColor(s.cpu)}}/></div><span style={{fontSize:12,color:"#6b7280"}}>{s.cpu}%</span></div> : <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px",fontSize:13}}>{s.ram_used !== null && s.ram_total !== null ? `${Math.round(s.ram_used / 1024)}/${Math.round(s.ram_total / 1024)} GB` : "—"}</td>
                  <td style={{padding:"12px 16px",fontSize:13}}>{s.ssd_used !== null && s.ssd_total !== null ? `${s.ssd_used}/${s.ssd_total} GB` : "—"}</td>
                  <td style={{padding:"12px 16px",fontSize:13}}>{s.uptime}</td>
                  <td style={{padding:"12px 16px"}}>{s.fastpanel?<Badge variant="blue">FASTPANEL</Badge>:<Badge variant="gray">—</Badge>}</td>
                  <td style={{padding:"12px 16px"}}><Badge variant={s.status==="error"?"red":s.status==="new"?"gray":"green"}>{s.status}</Badge></td>
                </tr>)}
              </tbody>
            </table>
            )}
          </div>
        </Card>}
    {showAdd&&<AddServerModal onClose={()=>setShowAdd(false)} providers={providers}/>}
    {showBulkImport && (
      <ServerBulkImportDialog
        onClose={() => setShowBulkImport(false)}
        onImported={(result) => {
          if (result.errors_csv_url) {
            window.open(`/api${result.errors_csv_url}`, "_blank");
          }
          refetch();
          setShowBulkImport(false);
        }}
      />
    )}
  </>;
}
