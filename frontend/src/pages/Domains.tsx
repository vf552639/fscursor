import React, { useState, useMemo, ChangeEvent, useEffect } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card, Btn, Sel, Badge, Modal, StatusDot, fmtDate, Inp, RowActions, EmptyState, ErrorState, formatAgoStale, DIM_TEXT, STALE_TEXT } from "../components/ui/Primitives";
import { useDomains, useBulkCreateDomains, useBulkCreateStructuredDomains, useCreateDomain, useBulkAssignServer, useBulkAssignCloudflare, useDeleteDomain, useUpdateDomain, useSetNameservers, useProvisionDomain, runBulkProvisionDomains, MIN_NAMESERVERS, NS_DESKTOP_NOTE, PROVISION_DOMAIN_KEY, Domain, ProvisionDomainVars, ProvisionOutcome, BulkProvisionOutcome } from "../api/domains";
import { useServers, Server } from "../api/servers";
import { isCheckStale, serverUiStatus } from "../lib/serverStatus";
import { useRegistrarAccounts, RegistrarAccount } from "../api/registrars";
import { useCloudflareAccounts, useZoneDetails, useZoneNameservers, CloudflareAccount } from "../api/cloudflare";
import StatusBadge from "../components/StatusBadge";
import { describeQueryError } from "../lib/queryError";
import BulkActionToolbar from "../components/BulkActionToolbar";
import DomainBulkImportDialog from "../components/DomainBulkImportDialog";
import DomainDetailModal from "../components/DomainDetailModal";
import { OpenInDesktop } from "../components/OpenInDesktop";
import { isTauri } from "../lib/runtime";
import { confirmAction } from "../lib/confirmDialog";
import { useAuthStore } from "../store/auth";

/**
 * Заглушка для обязательного `desktopOnClick` у `OpenInDesktop` там, где сам
 * компонент отрендерен под `!isTauri()`: в вебе он отдаёт ссылку и до колбэка
 * не доходит. Именованная константа — чтобы читатель видел «сюда не попадают», а
 * не второй, конкурирующий вход в то же действие.
 */
const NOOP_DESKTOP_ONLY_BRANCH = () => {};

interface AddDomainModalProps {
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}

interface DomainUI {
  id: number;
  domain: string;
  server_id: number | null;
  registrar_id: number | null;
  cf_id: number | null;
  cf_zone_id: string | null;
  ns_status: string;
  ns_updated_at: string | null;
  status: string;
  ssl_status?: string | null;
  last_provision_error?: string | null;
  created: string;
}

export function AddDomainModal({onClose, servers, registrars, cfAccounts}: AddDomainModalProps){
  const [name, setName]=useState(""); 
  const [sid, setSid]=useState(""); 
  const [rid, setRid]=useState(""); 
  const [cfid, setCfid]=useState("");
  const create = useCreateDomain();
  
  const handleAdd = () => {
    create.mutate({
      domain_name: name,
      server_id: sid ? Number(sid) : null,
      registrar_id: rid ? Number(rid) : null,
      cloudflare_account_id: cfid ? Number(cfid) : null
    }, { onSuccess: () => onClose() });
  };

  return <Modal title="Add Domain" onClose={onClose} width={450}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: ChangeEvent<HTMLInputElement>)=>setName(e.target.value)} placeholder="e.g., example.com"/></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Server</label><Sel value={sid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setSid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Registrar</label><Sel value={rid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setRid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Cloudflare Account</label><Sel value={cfid} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setCfid(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel></div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      <Btn variant="primary" onClick={handleAdd} disabled={create.isPending||!name} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{create.isPending ? "Adding..." : "Add Domain"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

interface EditDomainModalProps {
  domain: DomainUI;
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}

/**
 * ВНИМАНИЕ: эта модалка НЕДОСТИЖИМА. `setEditingDomain` нигде не вызывается со
 * значением — единственные два вхождения это её же объявление и сброс в `null`
 * при закрытии, то есть открыть её нечем. Ни одна кнопка строки таблицы её не
 * поднимает (в `RowActions` только «Open detail», «Provision» и «Delete»).
 *
 * Код внутри поддерживается в рабочем виде (иначе он не компилируется вместе с
 * остальным), но проверить руками его нельзя. Живая правка NS — во вкладке NS
 * `DomainDetailModal`. Дать модалке точку входа или удалить её — отдельное
 * решение, не эта фаза.
 */
function EditDomainModal({ domain, onClose, servers, registrars, cfAccounts }: EditDomainModalProps) {
  const [name, setName] = useState(domain.domain);
  const [serverId, setServerId] = useState(domain.server_id ? String(domain.server_id) : "");
  const [registrarId, setRegistrarId] = useState(domain.registrar_id ? String(domain.registrar_id) : "");
  const [cfZoneId, setCfZoneId] = useState(domain.cf_zone_id || "");
  const setNameservers = useSetNameservers();
  const { data: nameserversData, isLoading: isNameserversLoading, isError: isNameserversError } =
    useZoneNameservers(domain.cf_id, domain.cf_zone_id);
  const { data: zoneDetails, isLoading: isZoneLoading, isError: isZoneError } =
    useZoneDetails(domain.cf_id, domain.cf_zone_id);
  const update = useUpdateDomain(domain.id);

  const handleSave = () => {
    update.mutate(
      {
        domain_name: name.trim(),
        server_id: serverId ? Number(serverId) : null,
        registrar_id: registrarId ? Number(registrarId) : null,
        cloudflare_zone_id: cfZoneId || null,
      },
      { onSuccess: () => onClose() }
    );
  };

  return <Modal title={`Edit ${domain.domain}`} onClose={onClose} width={450}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: ChangeEvent<HTMLInputElement>)=>setName(e.target.value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Server</label><Sel value={serverId} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setServerId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign Registrar</label><Sel value={registrarId} onChange={(e: ChangeEvent<HTMLSelectElement>)=>setRegistrarId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Cloudflare Zone ID</label><Inp value={cfZoneId} onChange={(e: ChangeEvent<HTMLInputElement>)=>setCfZoneId(e.target.value)} placeholder={cfAccounts.length ? "Zone ID from Cloudflare" : "No CF accounts connected"} /></div>
      <div style={{border:"1px solid #e5e7eb", borderRadius:8, padding:12, background:"#fafafa"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:8}}>Nameservers (CF zone)</div>
        <div style={{fontSize:11.5,color:"#6b7280",marginBottom:8}}>
          CF zone status - статус делегирования у Cloudflare. NS push - статус применения NS у регистратора.
        </div>
        {!domain.cf_id || !domain.cf_zone_id ? null : (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <span style={{fontSize:12,color:"#6b7280"}}>CF Zone Status:</span>
            {isZoneLoading ? (
              <Badge variant="gray">Loading...</Badge>
            ) : isZoneError ? (
              <Badge variant="red">Failed to load zone status</Badge>
            ) : (
              <Badge
                variant={
                  zoneDetails?.status === "active"
                    ? "green"
                    : zoneDetails?.status === "pending"
                    ? "yellow"
                    : "gray"
                }
              >
                {zoneDetails?.status === "active"
                  ? "Active"
                  : zoneDetails?.status === "pending"
                  ? "Pending (NS не делегированы на CF)"
                  : zoneDetails?.status || "Unknown"}
              </Badge>
            )}
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:12,color:"#6b7280"}}>NS push to registrar:</span>
          <Badge variant={(domain.ns_status==="ok"?"green":domain.ns_status==="error"?"red":"yellow") as any}>
            {domain.ns_status==="ok"?"OK":domain.ns_status==="error"?"Error":"Pending"}
          </Badge>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>
          Updated: {domain.ns_updated_at ? fmtDate(domain.ns_updated_at) : "—"}
        </div>
        {!domain.cf_id || !domain.cf_zone_id ? (
          <div style={{fontSize:12.5,color:"#6b7280"}}>Nameservers - assign Cloudflare account first.</div>
        ) : (
          <>
            {isNameserversLoading ? (
              <div style={{fontSize:12.5,color:"#6b7280"}}>Loading nameservers...</div>
            ) : isNameserversError ? (
              <div style={{fontSize:12.5,color:"#dc2626"}}>Failed to load nameservers from Cloudflare.</div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {/* `null` — зоны с таким id в аккаунте нет; это не то же самое,
                    что зона без NS, и говорить про неё «No nameservers» значит
                    отвечать не на тот вопрос. */}
                {nameserversData == null ? (
                  <div style={{fontSize:12.5,color:"#dc2626"}}>Zone not found in this Cloudflare account.</div>
                ) : nameserversData.name_servers.length > 0 ? (
                  nameserversData.name_servers.map((ns) => (
                    <div key={ns} style={{fontSize:12.5,fontFamily:"monospace",color:"#374151"}}>• {ns}</div>
                  ))
                ) : (
                  <div style={{fontSize:12.5,color:"#6b7280"}}>No nameservers returned for this zone.</div>
                )}
              </div>
            )}
            {/* Ошибка команды раньше терялась целиком: `mutate()` без onError,
                и отказ регистратора выглядел как «ничего не произошло». */}
            {setNameservers.isError ? (
              <div style={{fontSize:12.5,color:"#dc2626",marginBottom:6}}>
                {String((setNameservers.error as any)?.message || "Set NS failed")}
              </div>
            ) : null}
            {domain.registrar_id == null ? (
              <div style={{fontSize:12.5,color:"#b45309",marginBottom:6}}>
                Assign a registrar account to this domain first.
              </div>
            ) : null}
            {/* Выключенная кнопка без объяснения — это загадка, а не запрет.
                Каждое условие в `disabled` ниже имеет свою строчку. */}
            {domain.registrar_id != null && (nameserversData?.name_servers.length ?? 0) < MIN_NAMESERVERS ? (
              <div style={{fontSize:12.5,color:"#b45309",marginBottom:6}}>
                Nothing to push: this Cloudflare zone returned fewer than {MIN_NAMESERVERS} nameservers.
              </div>
            ) : null}
            {!isTauri() ? (
              <div style={{fontSize:12.5,color:"#92400e",marginBottom:6}}>
                Read-only here. {NS_DESKTOP_NOTE}
              </div>
            ) : null}
            <Btn
              size="sm"
              variant="secondary"
              onClick={() =>
                setNameservers.mutate({
                  domainId: domain.id,
                  domainName: domain.domain,
                  registrarAccountId: domain.registrar_id,
                  nameservers: nameserversData?.name_servers ?? [],
                })
              }
              disabled={
                setNameservers.isPending ||
                !isTauri() ||
                domain.registrar_id == null ||
                (nameserversData?.name_servers.length ?? 0) < MIN_NAMESERVERS
              }
            >
              {setNameservers.isPending ? "Setting NS..." : "↺ Set NS"}
            </Btn>
          </>
        )}
      </div>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      <Btn variant="primary" onClick={handleSave} disabled={update.isPending||!name.trim()} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{update.isPending ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

export default function Domains({ onNav, ctx, onProvisionResult, onBulkProvisionResult }: {
  onNav?: (pg: string, ctx?: any) => void;
  ctx?: any;
  /**
   * Куда отдать результат provision. Показывает его модалка показа-один-раз,
   * которой владеет DesktopWorkspace: пароли БД и FTP существуют только в этом
   * ответе, а сама страница размонтируется при уходе пользователя и унесла бы
   * их с собой.
   *
   * Обязательный, хотя формально мог бы быть опциональным: потерю, которую
   * нечем восстановить (сервер паролей не знает), компилятор умеет делать
   * невыразимой — комментарий умеет только объяснить её задним числом.
   */
  onProvisionResult: (outcome: ProvisionOutcome) => void;
  /**
   * То же самое для массового прогона, и обязателен по той же причине, только
   * дороже: в отчёте лежит пароль FTP КАЖДОГО отработавшего домена, то есть
   * потерять можно сразу N. Уход со страницы во время прогона — не редкость: он
   * идёт минутами на каждый домен.
   *
   * Отдаём отчёт целиком, а не по одному результату: DesktopWorkspace обязан
   * поставить в очередь и пароли, и итог прогона (`already_ran`, оборвался ли
   * он и на чём), а итог живёт только в отчёте.
   */
  onBulkProvisionResult: (outcome: BulkProvisionOutcome) => void;
}){
  const domainsQ = useDomains();
  const serversQ = useServers();
  const registrarsQ = useRegistrarAccounts();
  const cfAccountsQ = useCloudflareAccounts();

  // Одно чтение часов на рендер — тот же приём, что на трёх остальных экранах:
  // отдельный `Date.now()` внутри каждой функции дал бы разные «сейчас» для
  // статуса сервера и для подписи его возраста в соседней строке.
  const now = Date.now();

  const domainsData = domainsQ.data ?? [];
  const servers = serversQ.data?.items || [];
  const registrars = registrarsQ.data || [];
  const cfAccounts = cfAccountsQ.data || [];

  const domains = useMemo((): DomainUI[] => domainsData.map((d: Domain) => ({
    id: d.id,
    domain: d.domain_name,
    server_id: d.server_id,
    registrar_id: d.registrar_id,
    cf_id: d.cloudflare_account_id,
    cf_zone_id: d.cloudflare_zone_id,
    ns_status: d.ns_status || "pending",
    ns_updated_at: d.ns_updated_at,
    status: d.status,
    ssl_status: d.ssl_status,
    last_provision_error: d.last_provision_error,
    created: d.created_at,
  })), [domainsData]);

  const initialStatusFilter = useMemo(() => {
    return new URLSearchParams(window.location.search).get("status") ?? "";
  }, []);
  const [search,setSearch]=useState(""); const [fSrv,setFS]=useState(""); const [fReg,setFR]=useState(""); const [fCF,setFCF]=useState(""); const [fStatus, setFStatus] = useState(initialStatusFilter);
  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [editingDomain, setEditingDomain] = useState<DomainUI | null>(null);
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);

  const bulkAssignServer = useBulkAssignServer();
  const bulkAssignCF = useBulkAssignCloudflare();
  const singleProvision = useProvisionDomain(onProvisionResult);
  // Массовый прогон идёт не мутацией, а прямым `await` (см. `handleBulkProvision`),
  // поэтому «идёт ли он» приходится держать самим: `pending` кнопки читать
  // больше неоткуда. Подоменный гейт этот флаг НЕ заменяет — он в MutationCache
  // и защищает от второго прогона по тому же домену из ссылки и из ⚙.
  const [bulkProvisionRunning, setBulkProvisionRunning] = useState(false);
  // Отказ запуска обязан быть виден: «уже провижинится», «только десктоп» и
  // отказ самой команды — это ответ на вопрос «почему ничего не произошло».
  const [bulkProvisionError, setBulkProvisionError] = useState<string | null>(null);
  // Состояние provision читаем из MutationCache, а не из локального observer:
  // операция идёт минутами (SSH + certbot) и переживает уход со страницы, а
  // observer при размонтировании теряет с ней связь. Без этого после возврата
  // на страницу кнопка снова активна, и второй клик открывает вторую SSH-сессию
  // по тому же домену.
  const provisioningIds = useMutationState({
    filters: { mutationKey: PROVISION_DOMAIN_KEY, status: "pending" },
    select: (m) => (m.state.variables as ProvisionDomainVars | undefined)?.domainId,
  });
  const isProvisioning = (id: number) => provisioningIds.includes(id);
  const deleteDomain = useDeleteDomain();
  // Provision в десктопе синхронен: серверного task log'а, который можно было бы
  // поллить, у него нет — поэтому ни `TaskProgressModal`, ни его multi-версии на
  // этой странице больше нет вовсе (их единственным поставщиком был bulk full
  // setup, ушедший вместе с несуществующим роутом). Показывает результат не эта
  // страница, а DesktopWorkspace (см. `onProvisionResult`): пароли БД и FTP не
  // должны зависеть от того, ушёл ли пользователь со страницы, пока шёл provision.
  //
  // Диалог перед запуском: домен, для которого он открыт, и выбор «создавать ли
  // базу». Выбор живёт здесь, а не в аргументах строки, чтобы не залипать между
  // доменами — БД это отдельный артефакт на сервере, и умолчание у него «нет».
  const [provisionTarget, setProvisionTarget] = useState<DomainUI | null>(null);
  const [provisionWithDb, setProvisionWithDb] = useState(false);
  const openProvisionDialog = (d: DomainUI) => {
    setProvisionWithDb(false);
    setProvisionTarget(d);
  };
  const [showFileImport, setShowFileImport] = useState(false);

  useEffect(() => {
    if (ctx?.serverId) {
      setFS(String(ctx.serverId));
    }
    if (ctx?.domainId) {
      setFocusDomainId(Number(ctx.domainId));
      setSearch("");
    }
  }, [ctx]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (fStatus) params.set("status", fStatus);
    else params.delete("status");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", next);
  }, [fStatus]);

  const filtered = useMemo(() => domains.filter((d: DomainUI) => 
    (!search || d.domain.toLowerCase().includes(search.toLowerCase()) || String(d.id) === search) &&
    (!fSrv || d.server_id === Number(fSrv)) &&
    (!fReg || d.registrar_id === Number(fReg)) &&
    (!fCF || d.cf_id === Number(fCF)) &&
    (!fStatus || d.status === fStatus) &&
    (!focusDomainId || d.id === focusDomainId)
  ), [search, fSrv, fReg, fCF, fStatus, focusDomainId, domains]);
  /**
   * Домены, у которых провижининг дошёл до SSL и сертификата не получил.
   *
   * Считается по `ssl_status === "error"` — единственному признаку, который
   * такой прогон о себе действительно оставляет: провал выпуска (как и пропуск
   * из-за DNS или отсутствия почты) намеренно НЕ роняет провижининг, поэтому
   * домен остаётся `site_created`, а не `failed`, и в `last_provision_error`
   * ничего не пишется — там живут только фатальные провалы, и их текст
   * (`provision failed at {шаг}: {класс}`) слова «ssl» не содержит вовсе.
   * Прежний предикат (`status === "failed"` И текст ошибки со словом «ssl»)
   * не мог стать истинным ни при одном прогоне.
   */
  const failedAtSslCount = useMemo(
    () => domains.filter((d) => d.ssl_status === "error").length,
    [domains]
  );
  
  const toggle=(id: number)=>{setSel((p: Set<number>)=>{const s=new Set<number>(p);s.has(id)?s.delete(id):s.add(id);return s;});};
  const Th=({c,children}: {c?: string, children: React.ReactNode})=><th style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb",whiteSpace:"nowrap",...(c?{color:c}:{})}}>{children}</th>;
  
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

        setSB(false);
        setBulkText("");
        setBulkRegId("");
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

        setSB(false);
        setCsvText("");
      }
    } catch (err: any) {
      setBulkError(err.response?.data?.message || err.message || "Failed to import domains");
    }
  }

  const handleAssignServer = () => {
    if (!assignServerId) return;
    bulkAssignServer.mutate(
      { domain_ids: Array.from(sel), server_id: Number(assignServerId) },
      { onSuccess: () => { setShowAssignServer(false); setSel(new Set()); setAssignServerId(""); } }
    );
  };

  const handleAssignCF = () => {
    if (!assignCFId) return;
    bulkAssignCF.mutate(
      { domain_ids: Array.from(sel), cloudflare_account_id: Number(assignCFId) },
      { onSuccess: () => { setShowAssignCF(false); setSel(new Set()); setAssignCFId(""); } }
    );
  };

  /**
   * Массовый provision — через Tauri-команду `provision_bulk`, тем же путём,
   * что и ссылка `sdmp://bulk-provision` (см. `lib/deepLink.ts`). Прежний
   * `POST /domains/bulk-provision` на бэкенде не существует: кнопка всегда
   * давала 404, то есть обещала функцию, которой нет.
   *
   * Не прямой `invokeSynced`, а `runBulkProvisionDomains` — по тем же двум
   * причинам, что и у ссылки: только он отдаёт наружу результат КАЖДОГО домена
   * (пароль FTP существует только там) и только он занимает подоменный гейт в
   * `MutationCache`, из-за чего ⚙ строки и ссылка не откроют вторую SSH-сессию
   * по домену из набора.
   *
   * Результат не через `mutate`: возврат `mutationFn` react-query кладёт в
   * `data` `MutationCache`, откуда его не убирает даже `reset()`. Паролям там
   * не место, поэтому отчёт уезжает прямым вызовом пропа.
   */
  const handleBulkProvision = async () => {
    // Тот же источник, что у `useSetNameservers`: id пользователя нужен команде,
    // чтобы расшифровать креды сервера.
    const userId = useAuthStore.getState().userId;
    setBulkProvisionError(null);
    if (!userId) {
      setBulkProvisionError("Not signed in — sign in again to run provisioning.");
      return;
    }
    // Команда адресует домены строками.
    const ids = Array.from(sel).map(String);
    setBulkProvisionRunning(true);
    try {
      const outcome = await runBulkProvisionDomains(userId, ids);
      // Отчёт отдаём ПЕРВЫМ действием после ответа: всё остальное здесь —
      // косметика стейта, а он существует в единственном экземпляре.
      onBulkProvisionResult(outcome);
      setSel(new Set());
    } catch (e) {
      // «Provisioning of #N is already running.», «только десктоп» и отказ самой
      // команды — всё это обязано доехать до пользователя: молчащая кнопка
      // неотличима от сломанной.
      setBulkProvisionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkProvisionRunning(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!(await confirmAction(`Удалить ${sel.size} доменов?`))) return;
    Promise.all(Array.from(sel).map(id => deleteDomain.mutateAsync(id)))
      .then(() => setSel(new Set()));
  };

  if (domainsQ.isError) {
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Domains</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Domain inventory</div>
        </div>
        <ErrorState
          title={describeQueryError(domainsQ.error).title}
          message={`The domains list could not be loaded. ${describeQueryError(domainsQ.error).message}`}
          hint={describeQueryError(domainsQ.error).hint}
        />
      </div>
    );
  }

  if (domainsQ.isPending || serversQ.isPending || registrarsQ.isPending || cfAccountsQ.isPending) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading domains data...</div>;
  }

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
      <div>
        <h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Domains</h1>
        <div style={{fontSize:13,color:"#6b7280"}}>{domains.length} domains total</div>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn variant="secondary" onClick={()=>setShowFileImport(true)}>⇪ File Import</Btn>
        <Btn variant="secondary" onClick={()=>setSB(true)}>⊕ Bulk Add</Btn>
        <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Domain</Btn>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
      {[
        ["Total",domains.length,"#2563eb","#eff4ff"],
        ["NS OK",domains.filter((d: any)=>d.ns_status==="ok").length,"#16a34a","#f0fdf4"],
        ["NS Pending",domains.filter((d: any)=>d.ns_status==="pending").length,"#d97706","#fffbeb"],
        ["NS Errors",domains.filter((d: any)=>d.ns_status==="error").length,"#dc2626","#fef2f2"]
      ].map(([l,v,c,bg])=>(
        <div key={l as string} style={{background:bg as string,border:"1px solid",borderColor:bg as string,borderRadius:10,padding:"14px 18px"}}><div style={{fontSize:22,fontWeight:700,color:c as string}}>{v as number}</div><div style={{fontSize:12,color:c as string,opacity:0.8}}>{l as string}</div></div>
      ))}
    </div>
    {failedAtSslCount > 0 ? (
      <div style={{ marginBottom: 12 }}>
        <Badge variant="red">Failed at SSL: {failedAtSslCount}</Badge>
      </div>
    ) : null}
    <Card style={{marginBottom:16}}>
      <div style={{padding:"12px 16px",display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{position:"relative",flex:1,minWidth:180}}><span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#9ca3af",fontSize:13}}>⌕</span><input value={search} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setSearch(e.target.value)} placeholder="Search domains…" style={{width:"100%",padding:"7px 12px 7px 30px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,outline:"none",background:"#f9fafb",boxSizing:"border-box",fontFamily:"inherit"}}/></div>
        <Sel value={fSrv} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFS(e.target.value)}><option value="">All Servers</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel>
        <Sel value={fReg} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFR(e.target.value)}><option value="">All Registrars</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel>
        <Sel value={fCF} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFCF(e.target.value)}><option value="">All CF</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
        <Sel value={fStatus} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="new">NEW</option>
          <option value="ns_pending">NS_PENDING</option>
          <option value="provisioning">PROVISIONING</option>
          <option value="site_created">SITE_CREATED</option>
          <option value="ssl_pending">SSL_PENDING</option>
          <option value="active">ACTIVE</option>
          <option value="failed">FAILED</option>
        </Sel>
      </div>
    </Card>
    {/* Вне тулбара намеренно: тулбар исчезает при `selectedCount <= 0`, а набор
        сбрасывается удавшимся прогоном — вместе с ним исчезла бы и причина
        отказа предыдущего. */}
    {bulkProvisionError ? (
      <div role="alert" style={{marginBottom:12,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>
        {bulkProvisionError}
      </div>
    ) : null}
    <BulkActionToolbar
      selectedCount={sel.size}
      selectedDomainIds={Array.from(sel)}
      onAssignServer={() => setShowAssignServer(true)}
      onAssignCF={() => setShowAssignCF(true)}
      onProvision={() => { void handleBulkProvision(); }}
      onDelete={handleBulkDelete}
      pending={bulkProvisionRunning}
    />
    <Card>
      <div style={{overflowX:"auto"}}>
        {domainsData.length === 0 ? (
          <EmptyState
            title="No domains yet"
            description="Add a domain or import many at once. An empty list means there are no rows in the database — not a failed request."
          >
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <Btn variant="secondary" onClick={() => setShowFileImport(true)}>
                ⇪ File import
              </Btn>
              <Btn variant="secondary" onClick={() => setSB(true)}>
                ⊕ Bulk import
              </Btn>
              <Btn variant="primary" onClick={() => setSA(true)}>
                + Add Domain
              </Btn>
            </div>
          </EmptyState>
        ) : (
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr><th style={{padding:"10px 16px",width:36,background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}><input type="checkbox" checked={sel.size===filtered.length&&filtered.length>0} onChange={()=>setSel(sel.size===filtered.length?new Set():new Set(filtered.map((d: any)=>d.id)))} style={{cursor:"pointer"}}/></th>
            {["Domain","Server","Registrar","Cloudflare","Status","SSL","Added",""].map((h: string)=><Th key={h}>{h}</Th>)}
          </tr></thead>
          <tbody>
            {filtered.length === 0 && domainsData.length > 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                  No domains match the current filters.
                </td>
              </tr>
            ) : null}
            {filtered.map((d: DomainUI)=>{
              const srv=servers.find((s: Server)=>s.id===d.server_id); const reg=registrars.find((r: RegistrarAccount)=>r.id===d.registrar_id); const cf=cfAccounts.find((c: CloudflareAccount)=>c.id===d.cf_id);
              // Четвёртый экран, где рисуется состояние сервера, — и разбор
              // здесь был свой, до `last_check_*` не доходивший вовсе: колонку
              // `status` монитор не трогает, поэтому подтверждённо упавшая
              // машина стояла в списке доменов зелёной точкой. Лестница общая
              // (`lib/serverStatus`), как на трёх остальных экранах.
              const srvStatus = srv ? serverUiStatus(srv, now) : "";
              const srvCheckStale = isCheckStale(srv?.last_check_at, now);
              const isFocused = focusDomainId === d.id;
              return <tr key={d.id} style={isFocused ? { background: "#eff4ff" } : undefined} onMouseEnter={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!isFocused) e.currentTarget.style.background="#fafbfc"; }} onMouseLeave={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!isFocused) e.currentTarget.style.background=""; }}>
                <td style={{padding:"11px 16px"}}><input type="checkbox" checked={sel.has(d.id)} onChange={()=>toggle(d.id)} style={{cursor:"pointer"}}/></td>
                <td style={{padding:"11px 16px"}}>
                  <button onClick={() => setDetailDomain(domainsData.find((x) => x.id === d.id) || null)} style={{fontWeight:600,fontSize:13.5,color:"#111",background:"transparent",border:"none",padding:0,cursor:"pointer"}}>
                    {d.domain}
                  </button>
                </td>
                <td style={{padding:"11px 16px",fontSize:13}}>{srv?<>
                  {/* Ошибка — только при подтверждённом падении: на первом
                      промахе бэкенд уже пишет `last_check_error`, а
                      `last_check_ok` роняет лишь на втором (тот же гейт, что на
                      странице серверов). */}
                  <span style={{display:"flex",alignItems:"center",gap:5}} title={srv.last_check_ok === false ? srv.last_check_error || undefined : undefined}><StatusDot status={srvStatus} size={7}/>{srv.name}</span>
                  {/* Возраст проверки — под именем: точка без него утверждает
                      «сейчас», даже если проверке три месяца. */}
                  <span title={srv.last_check_at ? new Date(srv.last_check_at).toLocaleString() : undefined} style={{display:"block",fontSize:11,paddingLeft:12,color:srvCheckStale?STALE_TEXT:DIM_TEXT}}>{srv.last_check_at ? `checked ${formatAgoStale(srv.last_check_at, srvCheckStale, now)}` : "never checked"}</span>
                </>:<span style={{color:"#9ca3af"}}>—</span>}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:reg?"#111":"#9ca3af"}}>{reg?.provider||"—"}</td>
                <td style={{padding:"11px 16px",fontSize:13,color:cf?"#111":"#9ca3af"}}>{cf?.name||"—"}</td>
                <td style={{padding:"11px 16px"}}>
                  <StatusBadge status={d.status} title={d.last_provision_error || undefined} />
                  {/*
                    Текст ошибки — строкой, а не только тултипом бейджа: тултип
                    невидим, пока в него не попали мышью, а искать провалившийся
                    домен глазами по списку в двести строк надо без наведения.
                    Полный текст остаётся в `title` и в модалке домена.
                  */}
                  {d.last_provision_error ? (
                    <div
                      data-testid="provision-error"
                      title={d.last_provision_error}
                      style={{marginTop:4,fontSize:11.5,color:"#b91c1c",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                    >
                      {d.last_provision_error}
                    </div>
                  ) : null}
                </td>
                <td style={{padding:"11px 16px"}}>
                  <Badge variant={d.ssl_status === "active" ? "green" : d.ssl_status === "pending" ? "yellow" : d.ssl_status === "error" ? "red" : "gray"}>
                    {d.ssl_status === "active" ? "SSL active" : d.ssl_status === "pending" ? "SSL pending" : d.ssl_status === "error" ? "SSL error" : "— No SSL"}
                  </Badge>
                </td>
                <td style={{padding:"11px 16px",fontSize:12,color:"#9ca3af"}}>{fmtDate(d.created)}</td>
                <td style={{padding:"11px 16px"}}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <RowActions
                      actions={[
                        { icon: "↗", title: "Open detail", onClick: () => setDetailDomain(domainsData.find((x) => x.id === d.id) || null) },
                        ...(isTauri()
                          ? [
                              {
                                icon: "⚙",
                                // Второй клик стартовал бы вторую SSH-сессию с
                                // create_site/create_ftp_account/certbot по тому
                                // же домену — блокируем на время выполнения.
                                title: isProvisioning(d.id) ? "Provisioning…" : "Provision domain",
                                disabled: isProvisioning(d.id),
                                onClick: () => {
                                  if (isProvisioning(d.id)) return;
                                  openProvisionDialog(d);
                                },
                              },
                            ]
                          : []),
                        {
                          icon: "✕",
                          title: "Delete domain",
                          variant: "danger" as const,
                          onClick: async () => {
                            if (!(await confirmAction(`Delete ${d.domain}?`))) return;
                            deleteDomain.mutate(d.id);
                          },
                        },
                      ]}
                    />
                    {!isTauri() ? (
                      // В вебе — только ссылка в десктоп, и БЕЗ чекбокса «создать
                      // БД»: хост `provision` у `parseDeepLinkAction` знает один
                      // параметр `domainId`, лишний десктоп молча проглотит —
                      // то есть галочка, поставленная в вебе, соврала бы.
                      //
                      // Ветка рендерится только в вебе, а `desktopOnClick`,
                      // `disabled` и динамический `label` у `OpenInDesktop`
                      // работают только в десктопе (там компонент отдаёт кнопку
                      // вместо ссылки). Поэтому здесь они не «упрощены», а
                      // недостижимы: вход в диалог один — ⚙ строки выше.
                      <OpenInDesktop
                        action={`provision?domainId=${d.id}`}
                        label="Provision"
                        size="sm"
                        desktopOnClick={NOOP_DESKTOP_ONLY_BRANCH}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
        )}
      </div>
    </Card>

    {showAdd && <AddDomainModal onClose={()=>setSA(false)} servers={servers} registrars={registrars} cfAccounts={cfAccounts} />}
    {editingDomain && <EditDomainModal domain={editingDomain} servers={servers} registrars={registrars} cfAccounts={cfAccounts} onClose={() => setEditingDomain(null)} />}
    {/* `detailDomain` — снимок строки на момент клика, и он НЕ обновляется от
        инвалидации: модалка показывала бы «NS status: pending» ещё долго после
        удачной смены NS, то есть ровно ту ложь, ради устранения которой заведён
        write-back. Берём живую строку из свежего списка, а снимок оставляем
        резервом на случай, если домен из списка исчез (удалён, ушёл под фильтр).

        `key` — чтобы при переходе с домена на домен модалка пересоздавалась:
        иначе её собственный стейт (набранные NS) пережил бы смену props. */}
    {detailDomain && (
      <DomainDetailModal
        key={detailDomain.id}
        domain={domainsData.find((x) => x.id === detailDomain.id) ?? detailDomain}
        onClose={() => setDetailDomain(null)}
      />
    )}
    {showBulk&&<Modal title="Bulk Add Domains" onClose={()=>setSB(false)} width={520}>
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
      <div style={{marginTop:8}}><Btn variant="secondary" onClick={()=>setSB(false)} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
    </Modal>}

    {showAssignServer && (
      <Modal title="Assign Server" onClose={() => setShowAssignServer(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить сервер для {sel.size} доменов:</p>
        <Sel value={assignServerId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignServerId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select Server —</option>
          {servers.map((s: Server) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignServer} disabled={!assignServerId || bulkAssignServer.isPending}>
            {bulkAssignServer.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignServer(false)}>Cancel</Btn>
        </div>
      </Modal>
    )}

    {showAssignCF && (
      <Modal title="Assign Cloudflare" onClose={() => setShowAssignCF(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить Cloudflare аккаунт для {sel.size} доменов:</p>
        <Sel value={assignCFId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignCFId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select CF Account —</option>
          {cfAccounts.map((c: CloudflareAccount) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignCF} disabled={!assignCFId || bulkAssignCF.isPending}>
            {bulkAssignCF.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignCF(false)}>Cancel</Btn>
        </div>
      </Modal>
    )}
    {showFileImport && (
      <DomainBulkImportDialog
        onClose={() => setShowFileImport(false)}
        registrars={registrars}
        onImported={(result) => {
          if (result.errors_csv_url) {
            window.open(`/api${result.errors_csv_url}`, "_blank");
          }
        }}
      />
    )}
    {provisionTarget && (
      <Modal
        title={`Provision ${provisionTarget.domain}`}
        onClose={() => setProvisionTarget(null)}
        width={460}
      >
        <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5, marginBottom: 14 }}>
          SDMP will connect over SSH to this domain's server and create the site, its FTP
          account and its SSL certificate.
        </div>
        {/* Единственное место, где «создавать ли БД» вообще решается: команда
            `provision_domain` принимает `with_db`, но до этого чекбокса ни один
            вызывающий его не передавал — опциональная БД была недостижима.

            У массового прогона такого выбора нет, и это не недосмотр:
            Tauri-команда `provision_bulk` намеренно не принимает `with_db`.
            Молча создать сотню баз значит сделать за пользователя выбор,
            которого он не делал, а спросить про каждый домен отдельно эта
            кнопка не умеет. Пароли показать есть где — массовый прогон
            возвращает результат по каждому домену, и воркспейс ставит их в ту
            же очередь показов. */}
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 13,
            color: "#374151",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={provisionWithDb}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setProvisionWithDb(e.target.checked)}
            style={{ marginTop: 2, cursor: "pointer" }}
          />
          <span>
            Also create a database
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              A MySQL database and its user are created on the server. The password is shown
              once, right after provisioning — it is not stored anywhere.
            </div>
          </span>
        </label>
        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <Btn
            variant="primary"
            onClick={() => {
              const target = provisionTarget;
              if (isProvisioning(target.id)) return;
              // Без per-call `onSuccess`: результат доставляет замыкание
              // `mutationFn` (см. `useProvisionDomain`), потому что per-call
              // коллбэки react-query глушит при размонтировании наблюдателя —
              // а именно после ухода со страницы пароли и терялись.
              singleProvision.mutate({
                domainId: target.id,
                domainName: target.domain,
                withDb: provisionWithDb,
              });
              setProvisionTarget(null);
            }}
            disabled={isProvisioning(provisionTarget.id)}
          >
            {isProvisioning(provisionTarget.id) ? "Provisioning…" : "Provision"}
          </Btn>
          <Btn variant="secondary" onClick={() => setProvisionTarget(null)}>
            Cancel
          </Btn>
        </div>
      </Modal>
    )}
  </>;
}
