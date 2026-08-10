import React, { useState } from "react";
import { Card, CHd, CTi, CBo, Btn, Sel, Inp, Modal, Badge, StatusDot, pctColor, mbToGb, EmptyState, ErrorState, formatUptime, formatAgoStale, DIM_TEXT, STALE_TEXT } from "../components/ui/Primitives";
import { useServers, useCreateServer, type Server } from "../api/servers";
import ServerBulkImportDialog from "../components/ServerBulkImportDialog";
import { OpenInDesktop } from "../components/OpenInDesktop";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { BLOB_KIND } from "../lib/secretBlob";
import { useSecretSave } from "../hooks/useSecretSave";
import { describeQueryError } from "../lib/queryError";
import { providerError, providerOptions, providerPayload } from "../lib/providerInput";
import { UNCHECKED, isCheckStale, isMetricsStale, serverUiStatus, statusBadgeVariant } from "../lib/serverStatus";

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
 * Только имя семейства ОС, без версии и архитектуры: десктоп по этому имени
 * выбирает пакетный менеджер для установки FastPanel (`apt` или `yum`),
 * версия ему не нужна.
 *
 * Новое имя обязано попадать под подстроки `cent|rhel|rocky|alma|fedora` из
 * `desktop/src-tauri/src/provision/fastpanel_install.rs::update_command` —
 * иначе оно молча уедет в apt-ветку (там `else`, а не whitelist).
 */
const OS_OPTIONS = ["Debian", "Ubuntu", "CentOS", "AlmaLinux", "Rocky Linux"] as const;

/**
 * `providers` — обязательный проп, а не `useServers()` внутри: список серверов
 * страница УЖЕ загрузила, и второй его источник умел бы с ним разойтись. И не
 * опциональный с дефолтом `[]`: забытая передача — это молча пустые подсказки,
 * то есть ровно тот дефект, ради которого подсказки и заводились (второй
 * «Hetzner» с другой буквы).
 */
export function AddServerModal({onClose, providers}: {onClose: ()=>void, providers: string[]}){
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [login, setLogin] = useState("root");
  const [os, setOs] = useState<(typeof OS_OPTIONS)[number]>("Ubuntu");
  const [provider, setProvider] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sshPassword = useSecretSave("SSH password");

  const create = useCreateServer();
  const saving = sshPassword.saving || create.isPending;

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Server name is required";
    // Провайдер проверяется здесь, до `save()`, потому что порядок — «блоб →
    // сервер»: 422 за провайдера прилетел бы уже ПОСЛЕ записи секретного блоба
    // и оставил бы в хранилище секрет, на который никто не ссылается.
    const provError = providerError(provider);
    if (provError) newErrors.provider = provError;

    if (!ip.trim()) newErrors.ip = "IP address is required";
    // Basic IP regex
    else if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip.trim())) newErrors.ip = "Invalid IP address format";
    if (!sshPassword.value) newErrors.password = "SSH Password is required";

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAdd = async () => {
    if (!validate()) return;
    // Порядок «блоб → сервер», запрет отката блоба и то, почему плейнтекст
    // не едет в аргументы мутации, — внутри `useSecretSave`. Провал не
    // создаёт сервер вовсе: сервер с `ssh_password_blob_id = NULL` — это
    // 200 OK и баннер «SSH не настроен», который никогда не уйдёт.
    //
    // `fastpanel_*` в теле нет ни одного поля, и это решение, а не забывчивость:
    // панель выбирают на странице сервера, а бэкенд по умолчанию заводит сервер
    // с `fastpanel_status = not_installed`. Отправленный отсюда «installed»
    // накрыл бы блок установки видом подключённой панели, к которой нечем
    // подключиться.
    const ok = await sshPassword.save({
      blobKind: BLOB_KIND.serverSshPassword,
      existingBlobId: null,
      persist: async (blobId) => {
        await create.mutateAsync({
          name: name,
          ip_address: ip,
          ssh_user: login,
          ssh_password_blob_id: blobId,
          os: os,
          provider: providerPayload(provider),
        });
      },
    });
    if (ok) onClose();
  };

  return <Modal title="Add Server" onClose={onClose} width={500}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Сказано, чего форма НЕ делает: раньше панель выбирали прямо здесь,
          двумя вкладками, и тот, кто их помнит, иначе искал бы пропавший выбор
          по всей модалке. */}
      <div style={{fontSize:12.5,color:"#6b7280",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"10px 12px"}}>
        The server is created with SSH access only. FastPanel — install a new one or connect an existing one — is set up later, on the server page.
      </div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Server Name</label>
        <Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setName((e.target as any).value); if(errors.name) setErrors(prev=>({...prev, name:""}));}} placeholder="e.g., production-web-01" style={{borderColor: errors.name ? "#dc2626" : undefined}}/>
        {errors.name && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.name}</div>}
      </div>
      
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>IP Address</label>
          <Inp value={ip} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setIp((e.target as any).value); if(errors.ip) setErrors(prev=>({...prev, ip:""}));}} placeholder="e.g., 192.168.1.100" style={{borderColor: errors.ip ? "#dc2626" : undefined}}/>
          {errors.ip && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.ip}</div>}
        </div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>SSH Login</label><Inp value={login} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setLogin((e.target as any).value)} placeholder="e.g., root"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>OS</label><Sel value={os} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setOs((e.target as any).value)} style={{width:"100%"}}>{OS_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}</Sel></div>
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
      {/* Стоит последним — после выбора OS и ввода пароля, как просил
          пользователь.

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
      {sshPassword.error && (
        <div role="alert" style={{padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{sshPassword.error}</div>
      )}
      {isTauri() ? (
        <Btn variant="primary" onClick={handleAdd} disabled={saving} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{saving ? "Adding..." : "Add Server"}</Btn>
      ) : (
        <OpenInDesktop
          variant="primary"
          action="add-server"
          label="Add server in desktop app"
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
  
  // Один источник и для подсказок формы, и для списка фильтра: второй умел бы
  // разойтись с первым — предложить в форме имя, которого нет в фильтре.
  const providers = providerOptions(data?.items || []);

  // Одно чтение часов на рендер — см. тот же приём на дашборде: три отдельных
  // `Date.now()` на сервер дают три разных «сейчас», и на границе порога бейдж
  // «active» мог бы встать рядом с подписью «· stale» про ту же отметку.
  const now = Date.now();

  const servers = (data?.items || []).map((s: Server) => ({
    id: s.id,
    name: s.name,
    ip: s.ip_address,
    // Обрезанным — тем же значением, что попадёт в список фильтра
    // (`providerOptions` тоже обрезает). Иначе строка «Hetzner » дала бы пункт
    // «Hetzner», по которому не находится ни один сервер.
    provider: s.provider?.trim() || null,
    os: s.os_pretty || s.os || null,
    status: serverUiStatus(s, now),
    fastpanel: s.fastpanel_status === "installed",
    location: "-",
    uptime: formatUptime(s.uptime_seconds),
    // Ошибка проверки — ТОЛЬКО при подтверждённом падении, и гейт стоит здесь,
    // в одном месте на оба представления. При первом промахе бэкенд пишет
    // `last_check_error`, а `last_check_ok` оставляет `true` (падение
    // подтверждают два промаха подряд) — тултип без этой оглядки давал зелёную
    // карточку с текстом ошибки в подсказке.
    check_error: s.last_check_ok === false ? s.last_check_error || null : null,
    last_check_at: s.last_check_at || null,
    // Свежесть метрик — отдельный сигнал от свежести проверки: метрики снимает
    // десктоп по кнопке, доступность — бэкенд по расписанию. Общая подпись на
    // двоих означала бы, что один из них показан чужим возрастом.
    metrics_at: s.metrics_collected_at || null,
    stale: isMetricsStale(s.metrics_collected_at, now),
    // У проверки свой порог: она идёт по расписанию раз в 6 часов, и молчание
    // дольше трёх прогонов означает не «сервер жив», а «монитор молчит».
    check_stale: isCheckStale(s.last_check_at, now),
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
        {/* `unchecked` — полноправный пункт: без него ни разу не проверенные
            серверы не находятся ни одним фильтром, кроме «All», и заодно молча
            пропадают из выборки «active», где раньше были. */}
        <Sel value={filter} onChange={(e: any)=>setFilter(e.target.value)}>{["All","active",UNCHECKED,"provisioned","new","error"].map(s=><option key={s} value={s}>Status: {s}</option>)}</Sel>
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
            // Показания — в локальные `const`, и развилки «измерено / нет»
            // проверяют именно их: сужение по вспомогательному флагу
            // (`hasRam` и соседи) TypeScript делает только для const-переменных
            // и readonly-полей, а поля этого объекта ни то, ни другое.
            const { cpu, ram_used: ramUsed, ram_total: ramTotal, ssd_used: ssdUsed, ssd_total: ssdTotal } = s;
            const hasCpu = cpu !== null;
            const hasRam = ramUsed !== null && ramTotal !== null;
            const hasDisk = ssdUsed !== null && ssdTotal !== null && ssdTotal > 0;
            // Доля занятого диска — только когда её есть из чего посчитать.
            // Прежний фолбэк `: 0` не использовался никогда: полоса рисуется
            // ровно в той же ветке, где он и не нужен.
            const diskPct = hasDisk ? (ssdUsed / ssdTotal) * 100 : null;
            // Протухшее показание не прячется и не превращается в прочерк: цифра
            // настоящая, просто старая, и позавчерашний размер диска полезнее
            // пустоты. Но и цветом «нет данных» (`DIM_TEXT`) она не рисуется —
            // это разные вещи. Вредна была не старая цифра, а молчание рядом с
            // ней, поэтому под ней всегда стоит её возраст.
            const dim = s.stale ? { color: STALE_TEXT } : null;
            return <div key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:"16px 18px",cursor:"pointer",transition:"box-shadow 0.15s"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.08)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><StatusDot status={s.status}/><span style={{fontSize:14,fontWeight:700,color:"#111"}} title={s.check_error || undefined}>{s.name}</span></div>
                <span style={{fontSize:13,color:"#9ca3af"}}>⋯</span>
              </div>
              {/* Провайдер рядом с IP, а не отдельной строкой: фильтр работает и
                  в этом виде, и по карточке должно быть понятно, почему сервер
                  на экране остался. */}
              <div style={{fontSize:12,color:"#6b7280",marginBottom:10}}>{s.provider ? `${s.ip} · ${s.provider}` : s.ip}</div>
              <div style={{display:"flex",gap:6,marginBottom:12}}>{s.os ? <Badge variant="gray">{s.os}</Badge> : null}{s.fastpanel&&<Badge variant="blue">FASTPANEL</Badge>}</div>
              {/* «Метрик нет» — это `metrics_collected_at === null`, и только
                  оно. Снимок, где не разобрался процент CPU, метриками быть не
                  перестал: остальные показания в нём настоящие.

                  На месте этой строки раньше был спарклайн из пятнадцати
                  случайных столбиков вокруг текущего CPU (см. Primitives).
                  Освободившееся место занято RAM — показанием, которое у нас
                  действительно есть и которого на карточке не было. */}
              {!hasCpu ? <div style={{fontSize:12,color:DIM_TEXT,marginBottom:2}}>{s.metrics_at ? "No CPU reading" : "No metrics yet"}</div> : null}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 0",marginTop:10,fontSize:12.5}}>
                <span style={{color:"#6b7280"}}>Uptime:</span><span style={{fontWeight:600,textAlign:"right",...dim}}>{s.uptime}</span>
                <span style={{color:"#6b7280"}}>RAM</span><span style={{fontWeight:600,textAlign:"right",...dim}}>{hasRam ? `${mbToGb(ramUsed)}/${mbToGb(ramTotal)} GB` : "—"}</span>
                <span style={{color:"#6b7280"}}>SSD Usage</span><span style={{fontWeight:600,textAlign:"right",...dim}}>{hasDisk ? `${ssdUsed} GB` : "—"}</span>
                {/* Цвет числа — от самого числа (`pctColor`), а у протухшего снимка от
                    его возраста: спарклайн, который раньше нёс этот сигнал, был
                    выдумкой, а порог загрузки — нет. Считается внутри ветки: без
                    показания цвета у него и не бывает, а `?? 0` снаружи давал
                    синий «здоровый» оттенок величине, которой нет. */}
                <span style={{color:"#6b7280"}}>CPU %</span><span style={{fontWeight:600,textAlign:"right",...(hasCpu ? {color:s.stale?STALE_TEXT:pctColor(cpu)} : dim)}}>{hasCpu ? `${cpu}%` : "—"}</span>
              </div>
              {/* Полоса заполнения диска — единственное измерение, показанное
                  как есть. Цвет считается от НЕЁ САМОЙ: раньше он брался от
                  загрузки CPU, то есть диск краснел от чужой величины. */}
              {diskPct !== null ? <div style={{marginTop:10,height:4,background:"#f3f4f6",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${diskPct}%`,background:s.stale?STALE_TEXT:pctColor(diskPct),borderRadius:2}}/></div> : null}
              {/* Возраст снимка стоит вплотную к самим показаниям, а блок
                  доступности ниже отделён чертой: это два независимых сигнала
                  (десктоп по кнопке против бэкенда раз в 6 часов), и подпись
                  обязана читаться как относящаяся к своим цифрам. */}
              {s.metrics_at ? (
                <div title={new Date(s.metrics_at).toLocaleString()} style={{fontSize:11.5,color:s.stale?STALE_TEXT:DIM_TEXT,marginTop:8}}>Metrics: {formatAgoStale(s.metrics_at, s.stale, now)}</div>
              ) : null}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10,paddingTop:10,borderTop:"1px solid #f3f4f6"}}>
                <span style={{fontSize:12,color:"#6b7280"}}>Status</span>
                <Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge>
              </div>
              {/* Относительное время, а не дата: «06.08.2026, 12:00» требует от
                  читателя вычесть одно из другого, чтобы понять, свежая ли это
                  проверка, — а вопрос ровно в этом. Точная дата осталась в
                  подсказке. «never» словом: прочерк здесь читался бы как
                  «данные не доехали». */}
              <div title={s.last_check_at ? new Date(s.last_check_at).toLocaleString() : undefined} style={{fontSize:11.5,color:s.check_stale?STALE_TEXT:DIM_TEXT,marginTop:8}}>Last check: {s.last_check_at ? formatAgoStale(s.last_check_at, s.check_stale, now) : "never"}</div>
              {/* Причина падения — строкой, а не только тултипом у имени: тултип
                  невидим, пока в него не попали мышью, а искать упавший сервер
                  глазами по сетке карточек надо без наведения. Тот же довод и то
                  же решение, что у ошибки провижининга в списке доменов; полный
                  текст остаётся в подсказке. Гейт по подтверждённому падению
                  стоит выше, в `check_error`. */}
              {s.check_error ? (
                <div data-testid="check-error" title={s.check_error} style={{marginTop:4,fontSize:11.5,color:"#b91c1c",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.check_error}</div>
              ) : null}
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
              {/* «Metrics» стоит сразу за столбцами показаний, «Checked» — рядом
                  со «Status»: колонка возраста должна читаться как относящаяся к
                  своему сигналу, а сигналов здесь два. */}
              <thead><tr>{["Name","IP","Provider","OS","CPU","RAM","SSD","Uptime","Metrics","FastPanel","Status","Checked"].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                      No servers match the current filters.
                    </td>
                  </tr>
                ) : null}
                {filtered.map(s=>{
                  // Тот же приём, что и в карточках: протухшее показание видно,
                  // но приглушено, и рядом стоит его возраст.
                  const dim = s.stale ? { color: STALE_TEXT } : null;
                  return <tr key={s.id} onClick={()=>onNav("server-detail",s.original)} style={{cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <td style={{padding:"12px 16px"}}><div style={{display:"flex",alignItems:"center",gap:8}}><StatusDot status={s.status} size={8}/><span style={{fontWeight:600,fontSize:13.5,color:"#111"}} title={s.check_error || undefined}>{s.name}</span></div><div style={{fontSize:11.5,color:"#9ca3af",paddingLeft:16}}>{s.location}</div></td>
                  <td style={{padding:"12px 16px",fontFamily:"monospace",fontSize:13}}>{s.ip}</td>
                  {/* Прочерк, а не пустая ячейка: пустая читается как «данные не
                      доехали», прочерк — как «не заполнено». Так же, как у OS. */}
                  <td style={{padding:"12px 16px",fontSize:13}}>{s.provider || <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px"}}>{s.os ? <Badge variant="gray">{s.os}</Badge> : <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px"}}>{s.cpu !== null ? <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:55,height:5,background:"#f3f4f6",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${s.cpu}%`,background:s.stale?STALE_TEXT:pctColor(s.cpu)}}/></div><span style={{fontSize:12,color:"#6b7280",...dim}}>{s.cpu}%</span></div> : <span style={{color:"#9ca3af"}}>—</span>}</td>
                  <td style={{padding:"12px 16px",fontSize:13,...dim}}>{s.ram_used !== null && s.ram_total !== null ? `${mbToGb(s.ram_used)}/${mbToGb(s.ram_total)} GB` : "—"}</td>
                  <td style={{padding:"12px 16px",fontSize:13,...dim}}>{s.ssd_used !== null && s.ssd_total !== null ? `${s.ssd_used}/${s.ssd_total} GB` : "—"}</td>
                  <td style={{padding:"12px 16px",fontSize:13,...dim}}>{s.uptime}</td>
                  <td title={s.metrics_at ? new Date(s.metrics_at).toLocaleString() : undefined} style={{padding:"12px 16px",fontSize:12.5,color:s.stale?STALE_TEXT:DIM_TEXT}}>{s.metrics_at ? formatAgoStale(s.metrics_at, s.stale, now) : "—"}</td>
                  <td style={{padding:"12px 16px"}}>{s.fastpanel?<Badge variant="blue">FASTPANEL</Badge>:<Badge variant="gray">—</Badge>}</td>
                  <td style={{padding:"12px 16px"}}><Badge variant={statusBadgeVariant(s.status)}>{s.status}</Badge></td>
                  {/* Причина падения — строкой, как и на карточке: подсказка у
                      имени невидима, пока в неё не попали мышью. Стоит в колонке
                      проверки, из которой ошибка и приехала. */}
                  <td title={s.last_check_at ? new Date(s.last_check_at).toLocaleString() : undefined} style={{padding:"12px 16px",fontSize:12.5,color:s.check_stale?STALE_TEXT:DIM_TEXT}}>
                    {s.last_check_at ? formatAgoStale(s.last_check_at, s.check_stale, now) : "never"}
                    {s.check_error ? <div data-testid="check-error" title={s.check_error} style={{marginTop:2,color:"#b91c1c",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.check_error}</div> : null}
                  </td>
                </tr>;
                })}
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
