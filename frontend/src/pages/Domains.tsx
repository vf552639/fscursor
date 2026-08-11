import React, { useState, useMemo, useRef, ChangeEvent, useEffect } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card, Btn, Sel, Badge, Modal, StatusDot, fmtDate, Inp, RowActions, EmptyState, ErrorState, formatAgoStale, DIM_TEXT, STALE_TEXT } from "../components/ui/Primitives";
import { useDomains, useBulkCreateDomains, useBulkCreateStructuredDomains, useCreateDomain, useBulkAssignServer, useBulkAssignCloudflare, useDeleteDomain, useProvisionDomain, runBulkProvisionDomains, isBulkGateClaim, PROVISION_DOMAIN_KEY, Domain, ProvisionDomainVars, ProvisionOutcome, BulkProvisionOutcome } from "../api/domains";
import { useServers, Server } from "../api/servers";
import { isCheckStale, serverUiStatus } from "../lib/serverStatus";
import { expiryState, expiryTextColor, expiryTs, formatExpiry } from "../lib/domainExpiry";
import { DOMAIN_STATUSES, domainStatusLabel, domainStatusRank } from "../lib/domainStatus";
import { useRegistrarAccounts, RegistrarAccount } from "../api/registrars";
import { useCloudflareAccounts, CloudflareAccount } from "../api/cloudflare";
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

/** Сколько имён влезает в диалог подтверждения, не превращая его в стену текста. */
const CONFIRM_NAMES_SHOWN = 20;

interface DomainUI {
  id: number;
  domain: string;
  server_id: number | null;
  registrar_id: number | null;
  cf_id: number | null;
  ns_status: string;
  status: string;
  ssl_status?: string | null;
  /** Срок домена у регистратора. `date` без времени — считаем сутками. */
  expiry_date?: string | null;
  /** Срок сертификата. Полноценный `datetime`, но вопрос к нему тот же суточный. */
  ssl_expires_at?: string | null;
  last_provision_error?: string | null;
  created: string;
}

/** По какой колонке сортируем. Только те, у чьих значений есть порядок. */
type SortKey = "domain" | "status" | "expiry_date" | "ssl_expires_at" | "created";

interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/**
 * Порядок по умолчанию — по имени домена, по возрастанию.
 *
 * Не «сначала свежие» и не «сначала просроченные»: список из сотен доменов —
 * это в первую очередь поверхность поиска («где тут shop.example.com»), а найти
 * известное имя глазами можно только в алфавите. Порядок, в котором строки
 * приезжают с бэкенда (по id, то есть по времени заведения), пользователю не
 * значит ничего: он не помнит, каким по счёту завёл домен.
 *
 * Срочное при этом не спрятано — оно в одном клике по заголовку Expires, и цвет
 * подписи виден в любом порядке.
 */
const DEFAULT_SORT: Sort = { key: "domain", dir: "asc" };

/** Значение, по которому сортируется строка для данного ключа-даты. */
function dateOf(d: DomainUI, key: SortKey): string | null | undefined {
  if (key === "expiry_date") return d.expiry_date;
  if (key === "ssl_expires_at") return d.ssl_expires_at;
  return d.created;
}

/**
 * Отсортированная копия списка.
 *
 * Вынесена из тела `useMemo` целиком: правило «строки без даты — в конец при
 * ЛЮБОМ направлении» стоит того, чтобы быть видимым, а не спрятанным в
 * замыкании между фильтром и разметкой. Проверяется оно кликами по заголовкам
 * (`Domains.expiry.test.tsx`) — то есть тем самым порядком, который видит
 * пользователь, а не возвратом функции.
 *
 * Само правило — про честность, а не про удобство: перевернув сортировку по
 * сроку, пользователь ищет либо самый горящий домен, либо самый дальний. И в
 * том и в другом случае список начинался бы с доменов, про чей срок мы НЕ
 * ЗНАЕМ, — то есть ответ на оба вопроса заслоняли бы те, про кого ответа нет
 * вовсе.
 */
function sortDomains(rows: DomainUI[], sort: Sort): DomainUI[] {
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "domain") return a.domain.localeCompare(b.domain) * mul;
    let primary: number;
    if (sort.key === "status") {
      primary = (domainStatusRank(a.status) - domainStatusRank(b.status)) * mul;
    } else {
      const ta = expiryTs(dateOf(a, sort.key));
      const tb = expiryTs(dateOf(b, sort.key));
      // Незнание не участвует в сравнении и не переворачивается вместе с ним:
      // ветки стоят ДО умножения на направление.
      if (ta === null && tb === null) primary = 0;
      else if (ta === null) primary = 1;
      else if (tb === null) primary = -1;
      else primary = (ta - tb) * mul;
    }
    // Равные ключи — по имени. Иначе полсотни доменов с одной датой покупки
    // встают в порядке заведения, в котором глазами не найти ничего, и порядок
    // этот меняется от каждой вставки строки в базу.
    return primary !== 0 ? primary : a.domain.localeCompare(b.domain);
  });
}

/**
 * Текст подтверждения массового provision.
 *
 * Отдельная чистая функция, а не шаблон внутри обработчика: её проверяет тест, а
 * этот текст — единственное, что стоит между промахом мимо соседней кнопки и
 * часами необратимой работы на чужих машинах.
 *
 * Устроен как `describeDeepLinkAction` для той же операции (`lib/deepLink.ts`):
 * называет и действие, и цели. Цели названы ИМЕНАМИ, а не id: у ссылки имён нет,
 * а у страницы есть, и выбирал пользователь именно имена. Строки «Continue only
 * if you started this yourself» здесь нет намеренно — она про ссылку, пришедшую
 * с чужой страницы, а не про кнопку, которую только что нажали.
 */
export function describeBulkProvision(domains: DomainUI[], ids: number[]): string {
  const names = ids.map((id) => domains.find((d) => d.id === id)?.domain ?? `#${id}`);
  const rest = names.length - CONFIRM_NAMES_SHOWN;
  const list = names.slice(0, CONFIRM_NAMES_SHOWN).join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
  return (
    `Provision ${ids.length} domain(s)?\n\n` +
    `${list}\n\n` +
    "SDMP will connect over SSH to each domain's server and create the site, " +
    "its FTP account and its SSL certificate. Once started, the run cannot be stopped."
  );
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

export default function Domains({ onNav, ctx, onProvisionResult, onBulkProvisionResult, onBulkProvisionError }: {
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
  /**
   * Куда отдать причину НЕзапуска, если баннера страницы больше нет.
   *
   * Отказ («уже провижинится», «только десктоп», сорвавшийся `invokeSynced`)
   * может прилететь через секунды после клика, а страница к этому моменту
   * размонтирована — она размонтируется на любой навигации (`<main key={page}>`
   * в DesktopWorkspace), и уйти смотреть тосты по шагам прогона тут нормальное
   * поведение. Стейт мёртвого компонента этот текст съедает молча, и
   * пользователь возвращается к обычной странице в уверенности, что прогон идёт.
   *
   * Зовётся, только если размонтирован ТОТ ЭКЗЕМПЛЯР страницы, который запускал
   * прогон: пока он жив, у той же ошибки есть своё место — баннер над тулбаром,
   * который не исчезнет через 2200 мс. Одно событие — одна поверхность.
   *
   * «Экземпляр», а не «экран»: уйдя со страницы и вернувшись, пользователь видит
   * НОВЫЙ `Domains`, который про тот прогон ничего не знает (его `sel` пуст, а
   * баннер принадлежит набору), — отказ прилетит тостом поверх живой страницы.
   * Так и задумано: показать его в баннере нового экземпляра значило бы
   * приписать отказ набору, который на экране уже другой.
   */
  onBulkProvisionError: (message: string) => void;
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
    ns_status: d.ns_status || "pending",
    status: d.status,
    ssl_status: d.ssl_status,
    expiry_date: d.expiry_date,
    ssl_expires_at: d.ssl_expires_at,
    last_provision_error: d.last_provision_error,
    created: d.created_at,
  })), [domainsData]);

  const initialStatusFilter = useMemo(() => {
    return new URLSearchParams(window.location.search).get("status") ?? "";
  }, []);
  const [search,setSearch]=useState(""); const [fSrv,setFS]=useState(""); const [fReg,setFR]=useState(""); const [fCF,setFCF]=useState(""); const [fStatus, setFStatus] = useState(initialStatusFilter);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);

  const bulkAssignServer = useBulkAssignServer();
  const bulkAssignCF = useBulkAssignCloudflare();
  const singleProvision = useProvisionDomain(onProvisionResult);
  // Отказ запуска обязан быть виден: «уже провижинится», «только десктоп» и
  // отказ самой команды — это ответ на вопрос «почему ничего не произошло».
  const [bulkProvisionError, setBulkProvisionError] = useState<string | null>(null);
  // Жива ли ещё страница к моменту, когда вернулся отказ. Отказ приходит через
  // секунды после клика, а страница размонтируется на любой навигации — без
  // этого признака текст уходил бы в стейт мёртвого компонента, то есть в
  // никуда (см. проп `onBulkProvisionError`).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Открыт ли диалог подтверждения массового прогона. Первое, что делает клик, —
  // это `await` (загрузка чанка плагина плюс сам диалог), поэтому до ответа
  // пользователя кнопка ничем не занята и выглядит незалипшей: второй клик по
  // «неотзывчивой» кнопке открывал второй диалог. Подтвердив оба, пользователь
  // получал запущенный прогон И красный баннер «уже провижинится» над ним —
  // выполнялся набор при этом ровно один раз (подоменный гейт), врал только UI.
  const confirmingBulkRef = useRef(false);
  // Что провижинится прямо сейчас — из MutationCache, а не из локального
  // observer'а или `useState`: операция идёт минутами (SSH + certbot) и
  // переживает уход со страницы, а страница размонтируется на любой навигации
  // (`<main key={page}>` в DesktopWorkspace). Без этого после возврата обе
  // кнопки снова активны, и клик открывает вторую SSH-сессию по домену, по
  // которому первая ещё идёт.
  //
  // Одна подписка на оба вопроса: фильтр у них общий, а разные ответы даёт
  // `select`. Две подписки с одинаковым фильтром пересчитывали бы по два снимка
  // на каждое изменение кэша.
  //
  // `bulkGateClaim` — маркер заявки гейта, которую заводит сам
  // `runBulkProvisionDomains` на каждый домен набора (см. `isBulkGateClaim`):
  // заявки висят pending ровно столько, сколько идёт прогон. Без этого признака
  // «идёт массовый прогон» после возврата на страницу превращалось бы в «нет», и
  // второй прогон по ДРУГИМ доменам подоменный гейт не остановил бы вовсе.
  //
  // Правило здесь СТРОЖЕ, чем у ссылки, и это выбор, а не расхождение. Кнопка
  // отказывает на любом идущем прогоне, `sdmp://bulk-provision` — только на
  // пересечении наборов (`alreadyProvisioning`). У кнопки пользователь стоит
  // перед списком и видит, что что-то идёт: второй параллельный прогон отсюда —
  // почти всегда «не понял, что первый ещё работает», и стоит он часов SSH.
  // Ссылка приходит извне, её набор может быть намеренно непересекающимся
  // (соседняя пачка доменов на другом сервере), и запрещать его было бы запретом
  // сценария, ради которого ссылка и заведена.
  const pendingProvisions = useMutationState({
    filters: { mutationKey: PROVISION_DOMAIN_KEY, status: "pending" },
    select: (m) => ({
      domainId: (m.state.variables as ProvisionDomainVars | undefined)?.domainId,
      bulkClaim: isBulkGateClaim(m.state.variables),
    }),
  });
  const isProvisioning = (id: number) => pendingProvisions.some((p) => p.domainId === id);
  const bulkProvisionRunning = pendingProvisions.some((p) => p.bulkClaim);
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

  // Причина отказа привязана к набору, на котором он случился: «Provisioning of
  // #1, #2 is already running» после снятия галочек с #1 и #2 говорит уже не про
  // то, что пользователь видит перед собой.
  useEffect(() => {
    setBulkProvisionError(null);
  }, [sel]);

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
   * Порядок применяется ПОСЛЕ фильтрации и живёт в `useMemo`: список бывает на
   * сотни строк, а сортировка внутри рендера строки означала бы полную
   * пересортировку на каждую из них.
   *
   * Фокус-режим (`ctx.domainId`) сюда не вмешивается — он всего лишь ещё одно
   * условие фильтра выше, поэтому сортировку не ломает: единственная оставшаяся
   * строка отсортирована сама с собой.
   */
  const sorted = useMemo(() => sortDomains(filtered, sort), [filtered, sort]);
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
  /**
   * Срез по жизненному циклу домена — второй ряд карточек рядом с NS-срезом.
   *
   * Ряд, а не переключатель NS ↔ lifecycle: оба среза отвечают на разные
   * вопросы («доехало ли делегирование» и «доехал ли сайт»), и спрятать один за
   * клик значит показать половину состояния тому, кто на страницу как раз и
   * пришёл узнать, всё ли в порядке. Числа тут маленькие и постоянные — место
   * они стоят дешевле, чем стоил бы невидимый счётчик провалов.
   *
   * «In progress» считается ОСТАТКОМ, а не перечислением промежуточных
   * статусов, и это не лень: перечисление молча теряет любой статус, которого
   * автор не вспомнил (а ровно так и потерялся `ns_ok` — см.
   * `lib/domainStatus`), и ряд переставал бы сходиться с Total. Остаток сходится
   * по построению.
   */
  const lifecycle = useMemo(() => {
    const count = (s: string) => domains.filter((d) => d.status === s).length;
    const fresh = count("new");
    const active = count("active");
    const failed = count("failed");
    return { fresh, active, failed, inProgress: domains.length - fresh - active - failed };
  }, [domains]);

  const toggle=(id: number)=>{setSel((p: Set<number>)=>{const s=new Set<number>(p);s.has(id)?s.delete(id):s.add(id);return s;});};
  /** Повторный клик по той же колонке переворачивает; новая колонка начинает с возрастания. */
  const toggleSort = (k: SortKey) => setSort((p) => ({ key: k, dir: p.key === k && p.dir === "asc" ? "desc" : "asc" }));
  const TH_STYLE: React.CSSProperties = {padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb",whiteSpace:"nowrap"};
  /**
   * Заголовок колонки. `k` есть — заголовок сортирует, нет — просто подпись: у
   * чекбокса и у колонки действий сортировать нечего, и кликабельный заголовок
   * над ними обещал бы порядок, которого у кнопок не бывает.
   *
   * Стрелка стоит и на неактивных сортируемых заголовках (бледная «↕»): иначе
   * то, что колонка вообще кликабельна, узнаётся только случайным попаданием
   * курсора. `aria-sort` — на `th`, потому что спрашивают о состоянии колонки
   * скринридеры именно у ячейки заголовка, а не у кнопки внутри.
   */
  const Th=({k,children}: {k?: SortKey, children: React.ReactNode})=>{
    if (!k) return <th style={TH_STYLE}>{children}</th>;
    const active = sort.key === k;
    return <th style={TH_STYLE} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={()=>toggleSort(k)} style={{display:"inline-flex",alignItems:"center",gap:4,background:"none",border:"none",padding:0,cursor:"pointer",font:"inherit",color:active?"#2563eb":"inherit",letterSpacing:"inherit",textTransform:"inherit"}}>
        {children}
        <span aria-hidden="true" style={{color:active?"#2563eb":"#d1d5db"}}>{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>;
  };

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
    const targets = Array.from(sel);
    // Спрашиваем, как спрашивают массовое удаление и как спрашивает
    // `sdmp://bulk-provision`: один клик запускает часы необратимой работы на
    // чужих машинах (site + FTP-аккаунт + certbot на каждом домене), остановить
    // прогон нечем, а идемпотентность после него пометит набор отработавшим —
    // то есть промах по «Assign Server» стоил бы и лишнего прогона, и
    // возможности повторить правильный.
    //
    // Домены названы ИМЕНАМИ, а не id, как в тексте ссылки: имя — это то, чем
    // пользователь их выбирал. Длинный список урезаем: диалог, который нельзя
    // прочитать, закрывают не читая.
    //
    // Второй клик, пока висит диалог, — это тот же клик, а не второй запуск:
    // спрашивать одно и то же дважды не о чем.
    if (confirmingBulkRef.current) return;
    confirmingBulkRef.current = true;
    let confirmed: boolean;
    try {
      confirmed = await confirmAction(describeBulkProvision(domains, targets));
    } finally {
      confirmingBulkRef.current = false;
    }
    if (!confirmed) return;
    // Команда адресует домены строками.
    const ids = targets.map(String);
    try {
      const outcome = await runBulkProvisionDomains(userId, ids);
      // Отчёт отдаём ПЕРВЫМ действием после ответа: всё остальное здесь —
      // косметика стейта, а он существует в единственном экземпляре.
      onBulkProvisionResult(outcome);
      // Снимаем выделение только с полностью удавшегося прогона. У оборвавшегося
      // хвост (`skipped`) назван поимённо ровно затем, чтобы повторить прогон по
      // нему, — а повторять его пользователю пришлось бы, заново разыскивая
      // домены в списке на двести строк.
      if (outcome.status === "ok") setSel(new Set());
    } catch (e) {
      // «Provisioning of #N is already running.», «только десктоп» и отказ самой
      // команды — всё это обязано доехать до пользователя: молчащая кнопка
      // неотличима от сломанной. Куда именно — зависит от того, жива ли ещё
      // страница: в стейте размонтированной текст умирает так же молча.
      const message = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setBulkProvisionError(message);
      else onBulkProvisionError(message);
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
    {([
      // Первый ряд — про делегирование, второй — про жизненный цикл домена.
      // Total стоит в первом и относится к обоим: он же и есть сумма второго.
      [
        ["Total",domains.length,"#2563eb","#eff4ff"],
        ["NS OK",domains.filter((d: DomainUI)=>d.ns_status==="ok").length,"#16a34a","#f0fdf4"],
        ["NS Pending",domains.filter((d: DomainUI)=>d.ns_status==="pending").length,"#d97706","#fffbeb"],
        ["NS Errors",domains.filter((d: DomainUI)=>d.ns_status==="error").length,"#dc2626","#fef2f2"]
      ],
      [
        ["New",lifecycle.fresh,"#6b7280","#f3f4f6"],
        ["In progress",lifecycle.inProgress,"#2563eb","#eff4ff"],
        ["Active",lifecycle.active,"#16a34a","#f0fdf4"],
        ["Failed",lifecycle.failed,"#dc2626","#fef2f2"]
      ]
    ] as [string, number, string, string][][]).map((row, i)=>(
      <div key={i} style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:i===0?12:20}}>
        {row.map(([l,v,c,bg])=>(
          <div key={l} style={{background:bg,border:"1px solid",borderColor:bg,borderRadius:10,padding:"14px 18px"}}><div style={{fontSize:22,fontWeight:700,color:c}}>{v}</div><div style={{fontSize:12,color:c,opacity:0.8}}>{l}</div></div>
        ))}
      </div>
    ))}
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
        {/* Пункты строятся из общей лестницы, а не перечислены руками: списком
            руками они и разошлись с бэкендом — в нём не было `ns_ok`, и домен в
            этом статусе нельзя было найти фильтром вовсе. */}
        <Sel value={fStatus} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setFStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {DOMAIN_STATUSES.map((s)=><option key={s.status} value={s.status}>{domainStatusLabel(s.status)}</option>)}
        </Sel>
      </div>
    </Card>
    {/* Живёт ровно столько, сколько живёт набор, на котором случился отказ:
        гасит его эффект по `sel` выше, а не время и не следующий рендер. */}
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
      provisionPending={bulkProvisionRunning}
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
          <thead><tr><th style={{padding:"10px 16px",width:36,background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}><input type="checkbox" checked={sel.size===sorted.length&&sorted.length>0} onChange={()=>setSel(sel.size===sorted.length?new Set():new Set(sorted.map((d: DomainUI)=>d.id)))} style={{cursor:"pointer"}}/></th>
            {([["Domain","domain"],["Server"],["Registrar"],["Cloudflare"],["Status","status"],["Expires","expiry_date"],["SSL","ssl_expires_at"],["Added","created"],[""]] as [string, SortKey?][]).map(([h,k])=><Th key={h} k={k}>{h}</Th>)}
          </tr></thead>
          <tbody>
            {sorted.length === 0 && domainsData.length > 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                  No domains match the current filters.
                </td>
              </tr>
            ) : null}
            {sorted.map((d: DomainUI)=>{
              const srv=servers.find((s: Server)=>s.id===d.server_id); const reg=registrars.find((r: RegistrarAccount)=>r.id===d.registrar_id); const cf=cfAccounts.find((c: CloudflareAccount)=>c.id===d.cf_id);
              // Оба срока — через один модуль и через одно «сейчас» (`now`
              // выше): своя арифметика в ячейке разъехалась бы с соседней,
              // причём молча.
              const expState = expiryState(d.expiry_date, now);
              const sslExpState = expiryState(d.ssl_expires_at, now);
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
                {/* Срок домена. Дата и подпись «сколько осталось» стоят вместе:
                    одна дата требует считать в уме (а тут сотня строк), одна
                    подпись — лишает возможности сверить с письмом регистратора.
                    Незнание — прочерк и БЕЗ подписи: «—» под «—» ничего не
                    добавляет. */}
                <td data-testid="expiry-cell" style={{padding:"11px 16px",fontSize:12.5}}>
                  <div style={{color:expiryTextColor(expState),fontWeight:expState==="ok"||expState==="unknown"?400:600}}>
                    {expState === "unknown" ? "—" : fmtDate(d.expiry_date ?? "")}
                  </div>
                  {expState !== "unknown" ? (
                    <div style={{fontSize:11,color:expiryTextColor(expState)}}>{formatExpiry(d.expiry_date, now)}</div>
                  ) : null}
                </td>
                <td data-testid="ssl-cell" style={{padding:"11px 16px"}}>
                  <Badge variant={d.ssl_status === "active" ? "green" : d.ssl_status === "pending" ? "yellow" : d.ssl_status === "error" ? "red" : "gray"}>
                    {d.ssl_status === "active" ? "SSL active" : d.ssl_status === "pending" ? "SSL pending" : d.ssl_status === "error" ? "SSL error" : "— No SSL"}
                  </Badge>
                  {/* Второй колонки под срок сертификата нет: он про тот же
                      предмет, что и бейдж, и в отрыве от него не читается. Строка
                      рисуется ВСЕГДА, в том числе прочерком под «No SSL»:
                      «активный сертификат без известного срока» и «сертификата
                      нет» — разные вещи, но обе означают, что дату перевыпуска мы
                      не знаем, и молчать об этом нельзя. */}
                  <div style={{marginTop:4,fontSize:11,color:expiryTextColor(sslExpState)}}>{formatExpiry(d.ssl_expires_at, now)}</div>
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
