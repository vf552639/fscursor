import React, { useState } from "react";
import { Card, CHd, CTi, Btn, StatCard, Badge, Modal, Inp, Sel, RowActions, EmptyState, ErrorState } from "../components/ui/Primitives";
import {
  useCloudflareAccounts,
  useCreateCloudflareAccount,
  useUpdateCloudflareAccount,
  useDeleteCloudflareAccount,
  useTestCloudflareAccount,
  useCloudflareZones,
  useCreateZone,
  useDnsRecords,
  usePurgeCache,
  useCreateDnsRecord,
  useUpdateDnsRecord,
  useDeleteDnsRecord,
  type CloudflareAccount,
  type DnsRecord,
  type DnsRecordUpdate,
  type Zone,
} from "../api/cloudflare";
import { useDomains, type Domain } from "../api/domains";
import { RevealSecret } from "../components/RevealSecret";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { isTauri } from "../lib/runtime";
import { confirmAction } from "../lib/confirmDialog";
import { BLOB_KIND } from "../lib/secretBlob";
import { useMultiSecretSave, useSecretSave } from "../hooks/useSecretSave";

/** Зона в UI. `nameServers` приходит вместе со списком зон из `cf_list_zones`. */
export interface CfZoneRef {
  id: string;
  name: string;
  nameServers?: string[] | null;
}

/** Аккаунт в контексте зоны: id нужен командам, name — хлебным крошкам. */
export interface CfAccountRef {
  id: number;
  name: string;
}

export interface CfZoneSelection {
  acc: CfAccountRef;
  zone: CfZoneRef;
}

const DNS_TYPE_COLORS: Record<string, string> = {
  A: "#2563eb",
  AAAA: "#7c3aed",
  CNAME: "#059669",
  MX: "#d97706",
  TXT: "#6b7280",
  NS: "#dc2626",
  SRV: "#0891b2",
};

const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"];

/** Типы, у которых Cloudflare принимает priority. Для прочих поле слать нельзя. */
const TYPES_WITH_PRIORITY = new Set(["MX", "SRV", "URI"]);

const TTL_PRESETS: { value: string; label: string }[] = [
  { value: "1", label: "Auto" },
  { value: "300", label: "5 min" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
];

/**
 * Варианты TTL для формы правки. У записи бывает TTL, которого нет в пресетах
 * (900), и бывает отсутствующий TTL — и то, и другое `<Sel>` из четырёх
 * вариантов показывал пустым, а сохранение молча переписывало значение.
 */
function ttlOptionsFor(ttl: number | null): { value: string; label: string }[] {
  if (ttl == null) return [{ value: "", label: "— (not set)" }, ...TTL_PRESETS];
  const current = String(ttl);
  if (TTL_PRESETS.some((o) => o.value === current)) return TTL_PRESETS;
  return [{ value: current, label: `${ttl}s` }, ...TTL_PRESETS];
}

/**
 * Общая подпись для всего, что веб не может: и выполнить (мутации), и прочитать
 * (список зон, записи, NS — им нужен расшифрованный токен). Формулировка
 * намеренно не про «changes»: две из трёх точек — про чтение.
 */
const DESKTOP_ONLY_NOTE = "Cloudflare works through the SDMP desktop app.";

/**
 * Резервный список зон — из доменов (`domains.cloudflare_zone_id`). Нужен
 * только вебу: настоящий список зон отдаёт `cf_list_zones`, а он требует
 * расшифрованный токен, то есть десктоп. Веб при этом остаётся способен
 * дойти до зоны и посмотреть её — ровно то, что ему и положено.
 */
export function zonesOfAccount(domains: Domain[], accountId: number): CfZoneRef[] {
  const seen = new Map<string, CfZoneRef>();
  for (const d of domains) {
    if (d.cloudflare_account_id !== accountId || !d.cloudflare_zone_id) continue;
    const prev = seen.get(d.cloudflare_zone_id);
    // Имя зоны — это апекс, а на одной зоне висят и поддомены. Первый
    // попавшийся домен дал бы «blog.example.com» и в списке, и в хлебных
    // крошках; из имён одной зоны апекс — самое короткое.
    if (!prev || d.domain_name.length < prev.name.length) {
      seen.set(d.cloudflare_zone_id, { id: d.cloudflare_zone_id, name: d.domain_name });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function AccountCard({
  acc,
  onEdit,
  onDelete,
  onTest,
  testStatus,
  domainZones,
  onOpenZone,
  onAddZone,
}: {
  acc: CloudflareAccount;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  testStatus?: { state: "idle" | "loading" | "success" | "error"; message?: string };
  domainZones: CfZoneRef[];
  onOpenZone: (zone: CfZoneRef) => void;
  onAddZone: () => void;
}) {
  const canExecute = isTauri();
  // Свёрнуто по умолчанию: аккаунтов десятки, а раскрытый список зон нужен
  // точечно. Локальный boolean, а не общий Set в родителе: карточки не
  // размонтируются на ре-рендере, а «свёрнут» — свойство одной карточки.
  const [collapsed, setCollapsed] = useState(true);
  const toggle = () => {
    // Клик по пустому месту шапки разворачивает карточку — но `account_id`
    // выделяют мышью, чтобы скопировать, а mouseup после выделения тоже даёт
    // click. Выделение важнее: без этой проверки id нельзя было бы скопировать,
    // не схлопнув карточку.
    if (window.getSelection()?.toString()) return;
    setCollapsed((v) => !v);
  };
  // Источник правды — сам Cloudflare: только он знает про зону, созданную
  // минуту назад, и только он отдаёт её name_servers. Домены остаются
  // резервом для веба, у которого токена нет и быть не должно.
  const liveZones = useCloudflareZones(acc.id);
  const zones: CfZoneRef[] = liveZones.data
    ? liveZones.data.map((z: Zone) => ({ id: z.id, name: z.name, nameServers: z.name_servers }))
    : domainZones;
  const zonesLoading = canExecute && liveZones.isPending;
  // Именно «отрисован», а не «есть testStatus»: `idle` — это состояние без
  // единого пикселя на экране, и `!testStatus` считал бы его блоком.
  const testResultShown = testStatus?.state === "success" || testStatus?.state === "error";

  return (
    <Card style={{marginBottom:16}}>
      {/* Гасим границу шапки, только когда шапка — последнее, что есть в
          карточке: там она встаёт вплотную к границе `Card` и читается двойным
          кантом. С показанным итогом Test connection она обычный разделитель. */}
      <CHd
        onClick={toggle}
        style={{
          cursor: "pointer",
          ...(collapsed && !testResultShown ? { borderBottom: "none" } : null),
        }}
      >
        <div data-testid="account-header" style={{display:"flex",alignItems:"center",gap:10}}>
          <span
            role="button"
            aria-expanded={!collapsed}
            aria-label={`Свернуть/развернуть аккаунт ${acc.name}`}
            tabIndex={0}
            // Клик по шеврону обязан всплыть НЕ дальше него: обработчик шапки
            // отработал бы вторым и вернул состояние назад — мишень выглядела бы
            // сломанной.
            onClick={(e) => { e.stopPropagation(); toggle(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            }}
            // Глиф — 8×14px, а это единственная мишень для клавиатуры и switch:
            // коробка 20×20 держит область клика (WCAG 2.2 SC 2.5.8).
            style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:20,height:20,fontSize:11,color:"#9ca3af",cursor:"pointer",userSelect:"none"}}
          >
            {collapsed ? "▸" : "▾"}
          </span>
          <div style={{width:36,height:36,background:"#fff7ed",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>☁</div>
          {/* Отдельной мишени у имени больше нет: переключатель висит на всей
              шапке, а имя — её часть. */}
          <div><div style={{fontSize:14,fontWeight:700,color:"#111"}}>{acc.name}</div><div style={{fontSize:12,color:"#6b7280"}}>{acc.account_id || "-"}</div></div>
          <Badge variant={acc.is_active?"green":"gray"}>{acc.is_active?"Active":"Inactive"}</Badge>
          {/* То же число, что в заголовке «Zones (N)» ниже, — и ради свёрнутой
              карточки: там блока зон не видно, а знать, сколько их, надо.
              «1 domain» без -s: счётчик стоит на самом видном месте карточки. */}
          <Badge variant="gray">{zones.length} {zones.length === 1 ? "domain" : "domains"}</Badge>
        </div>
        {/* Кнопки — не часть переключателя: без остановки всплытия любой клик по
            ним доехал бы до шапки и свернул карточку. */}
        <div onClick={(e) => e.stopPropagation()} style={{display:"flex",gap:8}}>
          {/* Был OpenInDesktop с action `test-cloudflare` — хостом, которого
              parseDeepLinkAction не знает: ссылка вела в {handled:false} и
              только тостила. Проверка токена идёт в cf_verify_token, а веб,
              как и с DNS, просто не выполняет. */}
          <Btn
            size="sm"
            variant="secondary"
            onClick={onTest}
            disabled={!canExecute || testStatus?.state === "loading"}
          >
            {testStatus?.state === "loading" ? "Testing..." : "Test connection"}
          </Btn>
          <Btn size="sm" variant="secondary" onClick={onEdit}>✎ Edit</Btn>
          <Btn size="sm" variant="danger" onClick={onDelete}>✕</Btn>
        </div>
      </CHd>
      {testStatus?.state === "success" && (
        <div style={{padding:"10px 20px", borderTop:"1px solid #f3f4f6", color:"#16a34a", fontSize:12.5}}>
          ✓ {testStatus.message || "Token verified"}
        </div>
      )}
      {testStatus?.state === "error" && (
        <div style={{padding:"10px 20px", borderTop:"1px solid #f3f4f6", color:"#dc2626", fontSize:12.5}}>
          {testStatus.message || "Connection test failed"}
        </div>
      )}
      {/* Свёрнутой остаётся только шапка и итог Test connection: аккаунтов
          десятки, а раскрытый список зон нужен точечно. */}
      {!collapsed && (<>
      {/* Расшифровка по блобу — единственный способ увидеть НАСТОЯЩИЙ токен, и
          нужен он только вебу: в десктопе токен проверяют кнопкой Test
          connection. Без блока целиком, а не с пустым его телом: одна рамка
          `borderTop` без содержимого — видимая полоса ни о чём. */}
      {!isTauri() && acc.api_token_blob_id ? (
        <div data-testid="account-token" style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb" }}>
          <RevealSecret blobId={acc.api_token_blob_id} label="Reveal API token" />
        </div>
      ) : null}
      <div style={{ borderTop: "1px solid #e5e7eb", padding: "12px 20px" }}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:zones.length?10:0}}>
          <div style={{fontSize:12,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px"}}>
            Zones ({zones.length})
          </div>
          <Btn size="sm" variant="secondary" onClick={onAddZone} disabled={!canExecute}>+ Add Zone</Btn>
        </div>
        {canExecute && liveZones.error ? (
          <div role="alert" style={{ fontSize: 12.5, color: "#dc2626", marginBottom: 8 }}>
            {String((liveZones.error as any)?.message || "Could not list zones")}
            {domainZones.length ? " — showing zones known from your domains." : ""}
          </div>
        ) : !canExecute ? (
          <div style={{ fontSize: 12.5, color: "#92400e", marginBottom: 8 }}>
            Zones as known from your domains — the live list needs your API token.{" "}
            {DESKTOP_ONLY_NOTE}
          </div>
        ) : null}
        {zonesLoading ? (
          <div style={{ fontSize: 12.5, color: "#9ca3af" }}>Loading zones…</div>
        ) : zones.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "#9ca3af" }}>
            No zones linked to this account yet.
          </div>
        ) : (
          zones.map((z) => (
            <div
              key={z.id}
              data-testid="zone-row"
              style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderTop:"1px solid #f3f4f6"}}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#111", flex: 1 }}>{z.name}</span>
              <span style={{ fontFamily: "monospace", fontSize: 11.5, color: "#9ca3af" }}>{z.id}</span>
              <Btn size="sm" variant="secondary" onClick={() => onOpenZone(z)}>Open DNS</Btn>
            </div>
          ))
        )}
      </div>
      </>)}{/* ← конец `{!collapsed &&`: тело карточки (токен + зоны) */}
    </Card>
  );
}

export default function Cloudflare({ onNav }: { onNav?: (pg: string, ctx?: any) => void }){
  const { data: cfAccountsData, isPending, isError, error } = useCloudflareAccounts();
  const { data: domainsData } = useDomains();
  const deleteAcc = useDeleteCloudflareAccount();
  const testAcc = useTestCloudflareAccount();
  const cfAccounts = cfAccountsData || [];
  const domains = domainsData || [];

  const [showAddAcc,setShowAcc]=useState(false);
  const [showDns,setShowDns]=useState(false);
  const [sel, setSel] = useState<CfZoneSelection | null>(null);
  const [addZoneFor, setAddZoneFor] = useState<CfAccountRef | null>(null);

  const [editingAcc, setEditingAcc] = useState<any | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<number, { state: "idle" | "loading" | "success" | "error"; message?: string }>>({});

  const handleTest = (accountId: number) => {
    setTestState((prev) => ({ ...prev, [accountId]: { state: "loading" } }));
    testAcc.mutate(accountId, {
      onSuccess: (res) => {
        const nextState = res.success ? "success" : "error";
        setTestState((prev) => ({ ...prev, [accountId]: { state: nextState, message: res.message } }));
        if (res.success) {
          setTimeout(() => {
            setTestState((prev) => ({ ...prev, [accountId]: { state: "idle" } }));
          }, 3000);
        }
      },
      onError: (err: any) => {
        setTestState((prev) => ({
          ...prev,
          [accountId]: { state: "error", message: String(err?.message || "Connection test failed") },
        }));
      },
    });
  };

  if (isError) {
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Cloudflare</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Accounts</div>
        </div>
        <ErrorState
          title="Не удалось загрузить Cloudflare-аккаунты"
          message={String((error as any)?.message ?? "Backend вернул ошибку.")}
          hint="docker compose logs backend --tail 100"
        />
      </div>
    );
  }

  if (isPending) return <div style={{padding:40, textAlign:"center", color:"#6b7280"}}>Loading Cloudflare accounts...</div>;

  // Выбранная зона занимает всю страницу: DNS-редактор — самостоятельный экран,
  // а не блок под списком аккаунтов.
  if (sel) {
    return (
      <CloudflareZoneView
        sel={sel}
        onBack={() => { setSel(null); setShowDns(false); }}
        showDns={showDns}
        setShowDns={setShowDns}
      />
    );
  }

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
      <div><h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Cloudflare</h1><div style={{fontSize:13,color:"#6b7280"}}>{cfAccounts.length} accounts connected</div></div>
      {/* В вебе объяснение стоит НА МЕСТЕ кнопки, а не за ней: аккаунт без
          токена бесполезен целиком, поэтому в браузере форма не открывается
          вовсе. Кнопка, открывающая окно, где нет ничего кроме Cancel, — это
          тупик, о котором узнаёшь после клика. Дип-линка не заводим: хоста
          `add-cloudflare` `parseDeepLinkAction` не знает, ссылка вернула бы
          {handled:false} и только тостила бы — ровно то, что уже делает
          предсуществующий `add-server` в `Servers.tsx` и что записано в долг. */}
      {isTauri() ? (
        <Btn variant="primary" onClick={()=>setShowAcc(true)}>+ Add Account</Btn>
      ) : (
        <DesktopOnlyNote what="Saving secrets" />
      )}
    </div>
    {/* Только успех: единственный источник этого баннера — создание аккаунта, а
        его провал уходит в ошибку внутри формы и до страницы не доезжает. */}
    {statusMessage && (
      <Card style={{marginBottom:14}}>
        <div style={{padding:"12px 16px",fontSize:13,color:"#166534",background:"#f0fdf4",borderRadius:10}}>
          {statusMessage}
        </div>
      </Card>
    )}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
      {[
        ["Total Accounts",cfAccounts.length,"#2563eb"],
        ["Active",cfAccounts.filter((c)=>c.is_active).length,"#16a34a"],
      ].map(([l,v,c])=><StatCard key={l as string} label={l} value={v} color={c}/>)}
    </div>
    {cfAccounts.length === 0 ? (
      <Card>
        <EmptyState
          title="No Cloudflare accounts yet"
          description="Connect an account to manage DNS and zones from this panel."
        >
          {/* Второй вход в ту же форму — и в вебе он закрыт по той же причине;
              объяснение уже стоит в шапке, повторять его тут незачем. */}
          {isTauri() ? <Btn variant="primary" onClick={() => setShowAcc(true)}>+ Add Account</Btn> : null}
        </EmptyState>
      </Card>
    ) : (
      cfAccounts.map((acc)=>(
      <AccountCard
        key={acc.id}
        acc={acc}
        onEdit={() => setEditingAcc(acc)}
        onDelete={async () => { if (!(await confirmAction(`Delete account ${acc.name}?`))) return; deleteAcc.mutate(acc); }}
        onTest={() => handleTest(acc.id)}
        testStatus={testState[acc.id]}
        domainZones={zonesOfAccount(domains, acc.id)}
        onOpenZone={(zone) => setSel({ acc: { id: acc.id, name: acc.name }, zone })}
        onAddZone={() => setAddZoneFor({ id: acc.id, name: acc.name })}
      />
    )))}

    {showAddAcc && <AddCfAccountModal onClose={()=>setShowAcc(false)} onStatus={setStatusMessage} />}
    {editingAcc && <EditCfAccountModal account={editingAcc} onClose={() => setEditingAcc(null)} />}
    {addZoneFor && <AddZoneModal acc={addZoneFor} onClose={() => setAddZoneFor(null)} />}
  </>;
}

/**
 * Добавление аккаунта. Отдельный экспортируемый компонент, а не блок внутри
 * страницы, ровно по той же причине, что и `AddServerModal`: гвард `isTauri()`
 * на поле токена и кнопке сохранения — это последний рубеж на случай второго
 * вызывающего, и проверить его можно, только отрендерив форму НАПРЯМУЮ. Пока
 * она была инлайном, веб-тест мог лишь кликнуть кнопку, которой в вебе нет, и
 * все утверждения о содержимом выполнялись вакуумно — мутация «оба гварда в
 * `true`» проходила зелёной.
 *
 * Плейнтекст стирать при закрытии больше не нужно: страница монтирует форму
 * условно, и `useSecretSave` уезжает вместе с ней.
 */
export function AddCfAccountModal({ onClose, onStatus }: {
  onClose: () => void;
  /** Успех создания: сообщить о нём может только форма, а показывает — страница. */
  onStatus: (text: string) => void;
}) {
  const [accName, setAccName] = useState("");
  const [accId, setAccId] = useState("");
  // Плейнтекст токена держит хук, а не форма: он же знает, когда его стереть
  // (порядок «блоб → сущность» и запрет отката — в `useSecretSave`).
  const accToken = useSecretSave("API token");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const createAcc = useCreateCloudflareAccount();

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!accName.trim()) newErrors.name = "Account Name is required";
    // Пустой токен своего сообщения здесь не получает: кнопка на нём выключена,
    // а если до сохранения всё же дойдёт — откажет `save` своей формулировкой.
    // Две копии одной фразы разъезжаются, а поймать это некому.
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddAcc = async () => {
    if (!validate()) return;

    // Порядок «блоб → аккаунт» и то, почему плейнтекст не едет в аргументы
    // мутации, — внутри `useSecretSave`. Провал не создаёт аккаунт вовсе:
    // аккаунт с `api_token_blob_id = NULL` — это 200 OK и Cloudflare, который
    // не ответит ни на один запрос.
    const ok = await accToken.save({
      blobKind: BLOB_KIND.cloudflareApiToken,
      existingBlobId: null,
      persist: async (blobId) => {
        await createAcc.mutateAsync({
          name: accName,
          account_id: accId,
          api_token_blob_id: blobId,
        });
        // Ответ — про сам аккаунт и только: зон сервер не видит
        // (`backend/app/schemas/cloudflare.py`), обещать по ним нечего.
        onStatus("Cloudflare account created.");
      },
    });
    if (ok) onClose();
  };

  // Пока идёт запись блоба или POST, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего создания приземлится в пустоту —
  // канала для этой ошибки у страницы нет. Окно — целый round-trip.
  const closeIfIdle = () => { if (!accToken.saving) onClose(); };

  return <Modal title="Add Cloudflare Account" onClose={closeIfIdle} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account Name</label>
        <Inp value={accName} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>{setAccName((e.target as any).value); if(errors.name) setErrors(prev=>({...prev, name:""}));}} placeholder="e.g., Main CF Account" style={{borderColor: errors.name ? "#dc2626" : undefined}}/>
        {errors.name && <div style={{color:"#dc2626",fontSize:11.5,marginTop:4}}>{errors.name}</div>}
      </div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account ID</label>
        <Inp value={accId} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setAccId((e.target as any).value)} placeholder="abc123def456..."/>
      </div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Token</label>
        {/* Почему в вебе поля нет вовсе — JSDoc `DesktopOnlyNote`. Страница в
            вебе сюда и не пускает (на месте кнопки заметка), но это ПЕРВЫЙ
            рубеж, а этот — последний: он переживёт второй вход.
            `trim` на вводе: токен копируют из панели, и `\n` в хвосте иначе
            зашифруется как часть секрета — «сохранено» и 403 на Test
            connection. Заодно кнопка ниже и сохраняемое значение перестают
            быть двумя разными понятиями «пусто». */}
        {isTauri() ? (
          <>
            <Inp type="password" value={accToken.value} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>accToken.setValue(e.target.value.trim())} placeholder="••••••••••••••••"/>
            <div style={{fontSize:11.5,color:"#9ca3af",marginTop:4}}>Requires Zone:Read, DNS:Edit permissions</div>
          </>
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
    </div>
    {accToken.error && (
      <div role="alert" style={{marginTop:14,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>{accToken.error}</div>
    )}
    <div style={{display:"flex",gap:8,marginTop:20}}>
      {/* Кнопки сохранения в вебе нет по той же причине, что и поля. Cancel
          остаётся всегда (форма обязана иметь выход), но гаснет на время
          сохранения: см. `closeIfIdle`. */}
      {isTauri() && (
        <Btn variant="primary" disabled={accToken.saving || !accName.trim() || !accToken.value} onClick={handleAddAcc} style={{flex:1,justifyContent:"center"}}>{accToken.saving ? "Adding..." : "Add Account"}</Btn>
      )}
      <Btn variant="secondary" disabled={accToken.saving} onClick={closeIfIdle} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}

/**
 * Создание зоны. Nameservers показываем прямо здесь и не закрываем модалку
 * сами: без них зона бесполезна, а второй раз Cloudflare их уже не отдаст.
 */
function AddZoneModal({ acc, onClose }: { acc: CfAccountRef; onClose: () => void }) {
  const [name, setName] = useState("");
  const createZone = useCreateZone(acc.id);
  const created: Zone | undefined = createZone.data;
  return (
    <Modal title={`Add zone to ${acc.name}`} onClose={onClose} width={460}>
      {created ? (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontSize:13,color:"#166534"}}>
            Zone <b>{created.name}</b> is ready (<span style={{fontFamily:"monospace"}}>{created.id}</span>).
            Point the domain at these nameservers at your registrar:
          </div>
          {(created.name_servers || []).map((ns) => (
            <div key={ns} style={{padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontFamily:"monospace",fontSize:13}}>{ns}</div>
          ))}
          {!created.name_servers?.length && (
            <div style={{ fontSize: 13, color: "#6b7280" }}>Cloudflare returned no nameservers.</div>
          )}
          <Btn variant="primary" onClick={onClose} style={{justifyContent:"center"}}>Done</Btn>
        </div>
      ) : (
        <>
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Zone name</label>
            <Inp value={name} onChange={(e: any)=>setName(e.target.value)} placeholder="example.com" />
          </div>
          {createZone.isError && (
            <div role="alert" style={{marginTop:10,fontSize:12.5,color:"#dc2626"}}>
              {String((createZone.error as any)?.message || "Zone creation failed")}
            </div>
          )}
          <div style={{display:"flex",gap:8,marginTop:20}}>
            <Btn
              variant="primary"
              disabled={createZone.isPending || !name.trim() || !isTauri()}
              onClick={() => createZone.mutate(name.trim())}
              style={{flex:1,justifyContent:"center"}}
            >
              {createZone.isPending ? "Creating..." : "Create Zone"}
            </Btn>
            <Btn variant="secondary" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function CloudflareZoneView({ sel, onBack, showDns, setShowDns }: {
  sel: CfZoneSelection;
  onBack: () => void;
  showDns: boolean;
  setShowDns: (v: boolean) => void;
}) {
  const { acc, zone } = sel;
  const { data: recsData, isLoading, error: recsError } = useDnsRecords(acc.id, zone.id);
  // NS уже приехали вместе со списком зон (`Zone.name_servers`): отдельный
  // запрос под них был бы тем же ответом второй раз.
  const nameServers = zone.nameServers ?? [];
  const purge = usePurgeCache(acc.id, zone.id);
  const createRecord = useCreateDnsRecord(acc.id, zone.id);
  const updateRecord = useUpdateDnsRecord(acc.id, zone.id);
  const deleteRecord = useDeleteDnsRecord(acc.id, zone.id);
  const recs: DnsRecord[] = recsData || [];
  // «Веб только смотрит»: sdmp://-ссылок для DNS нет (parseDeepLinkAction знает
  // три хоста), и выдумывать их ради кнопки нельзя — они вели бы в никуда.
  // Поэтому в вебе редактор просто read-only.
  const canExecute = isTauri();
  const [showNs, setShowNs] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DnsRecord | null>(null);
  const [recordType, setRecordType] = useState("A");
  const [recordName, setRecordName] = useState("");
  const [recordContent, setRecordContent] = useState("");
  const [recordTtl, setRecordTtl] = useState("1");
  const [recordProxied, setRecordProxied] = useState(true);
  const [recordPriority, setRecordPriority] = useState("");
  const needsPriority = TYPES_WITH_PRIORITY.has(recordType);
  // Итог ПОСЛЕДНЕГО действия, а не «первой найденной ошибки»: провалившаяся
  // мутация держит свой error до следующего вызова, и логика «покажем любую»
  // оставляла бы красное сообщение от purge поверх успешно добавленной записи.
  const lastAction = [purge, createRecord, updateRecord, deleteRecord]
    .map((m) => ({ submittedAt: m.submittedAt, error: m.error as Error | null }))
    .reduce((a, b) => (b.submittedAt > a.submittedAt ? b : a));
  // Итог действия живёт в мутации до следующего вызова, то есть вечно. Держим
  // отметку «это я уже видел»: иначе красное от неудавшегося create висит над
  // таблицей всё время, что пользователь в этой зоне.
  const [seenActionAt, setSeenActionAt] = useState(0);
  const bannerFresh = lastAction.submittedAt > seenActionAt;
  const purgeSucceeded = purge.isSuccess && purge.submittedAt === lastAction.submittedAt;
  const actionError = bannerFresh ? lastAction.error : null;
  /**
   * Есть ли ПРЯМО СЕЙЧАС что гасить. Пока мутация в полёте, `error` ещё null и
   * на экране пусто — но `bannerFresh` уже true. Двигать отметку в этот момент
   * значило бы съесть ошибку, которая случится через секунду: `T > T` даст
   * false, и провал не покажется никогда. Воспроизводится так: Purge (висит) →
   * «+ Add Record» (во время полёта не заблокирована) → Purge падает.
   */
  const bannerShown = bannerFresh && (lastAction.error != null || purgeSucceeded);
  const dismissBanner = () => {
    if (bannerShown) setSeenActionAt(lastAction.submittedAt);
  };
  const openAddRecord = () => { dismissBanner(); setShowDns(true); };
  const openEditRecord = (r: DnsRecord) => { dismissBanner(); setEditingRecord(r); };
  const handleCreateRecord = () => {
    if (!recordName.trim() || !recordContent.trim()) return;
    createRecord.mutate({
      type: recordType,
      name: recordName.trim(),
      content: recordContent.trim(),
      ttl: Number(recordTtl),
      proxied: recordProxied,
      // Для A/CNAME/TXT priority слать нельзя — Cloudflare ругается.
      priority: needsPriority && recordPriority.trim() ? Number(recordPriority) : undefined,
    }, {
      onSuccess: () => {
        setShowDns(false);
        setRecordType("A");
        setRecordName("");
        setRecordContent("");
        setRecordTtl("1");
        setRecordProxied(true);
        setRecordPriority("");
      }
    });
  };

  return <>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:24}}>
      <Btn variant="ghost" size="sm" onClick={onBack}>← Back</Btn>
      <span style={{color:"#e5e7eb"}}>/</span><span style={{fontSize:13,color:"#6b7280"}}>{acc.name}</span>
      <span style={{color:"#e5e7eb"}}>/</span><span style={{fontSize:14,fontWeight:700,color:"#111"}}>{zone.name}</span>
      <Badge variant={canExecute?"green":"gray"}>{canExecute ? "Desktop" : "Read-only"}</Badge>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:20}}>
      {[
        ["Records",recs.length,"#2563eb"],
        ["Account",acc.name,"#7c3aed"],
        ["Zone ID",zone.id,"#374151"]
      ].map(([l,v,c])=>(
        <Card key={l as string}><div style={{padding:"14px 16px"}}><div style={{fontSize:11.5,color:"#9ca3af",marginBottom:4,fontWeight:500}}>{l as string}</div><div style={{fontSize:16,fontWeight:700,color:c as string,fontFamily:l==="Zone ID"?"monospace":"inherit"}}>{v as string}</div></div></Card>
      ))}
    </div>
    <Card>
      <CHd><CTi>DNS Records <span style={{fontSize:12,fontWeight:400,color:"#9ca3af"}}>({recs.length})</span></CTi>
        <div style={{display:"flex",gap:8}}>
          <Btn size="sm" variant="secondary" onClick={()=>purge.mutate()} disabled={!canExecute || purge.isPending}>🗑 Purge Cache</Btn>
          <Btn size="sm" variant="secondary" onClick={()=>setShowNs(true)}>🔗 Nameservers</Btn>
          <Btn size="sm" variant="primary" onClick={openAddRecord} disabled={!canExecute}>+ Add Record</Btn>
        </div>
      </CHd>
      {!canExecute && (
        <div style={{padding:"10px 20px",borderTop:"1px solid #f3f4f6",fontSize:12.5,color:"#92400e",background:"#fffbeb"}}>
          Read-only here. {DESKTOP_ONLY_NOTE}
        </div>
      )}
      {actionError && (
        <div role="alert" style={{padding:"10px 20px",borderTop:"1px solid #f3f4f6",fontSize:12.5,color:"#dc2626",display:"flex",gap:10,alignItems:"baseline"}}>
          <span style={{flex:1}}>{String((actionError as any)?.message || "Cloudflare command failed")}</span>
          <Btn size="sm" variant="ghost" onClick={dismissBanner}>✕</Btn>
        </div>
      )}
      {bannerFresh && !actionError && purgeSucceeded && (
        <div style={{padding:"10px 20px",borderTop:"1px solid #f3f4f6",fontSize:12.5,color:"#16a34a",display:"flex",gap:10,alignItems:"baseline"}}>
          <span style={{flex:1}}>✓ Cache purged</span>
          <Btn size="sm" variant="ghost" onClick={dismissBanner}>✕</Btn>
        </div>
      )}
      {recsError && (
        <div style={{ padding: "14px 20px", borderTop: "1px solid #f3f4f6" }}>
          <ErrorState
            title="Не удалось загрузить DNS-записи"
            message={String((recsError as any)?.message ?? "cf_list_dns_records failed.")}
            hint={canExecute ? "Проверьте токен аккаунта: Test connection на странице Cloudflare." : undefined}
            style={{ marginBottom: 0 }}
          />
        </div>
      )}
      <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead><tr style={{background:"#f9fafb"}}>{["Type","Name","Content","TTL","Proxied",""].map(h=><th key={h} style={{padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",borderBottom:"1px solid #e5e7eb"}}>{h}</th>)}</tr></thead>
        <tbody>
          {isLoading ? (<tr><td colSpan={6} style={{padding:"28px",textAlign:"center",color:"#9ca3af"}}>Loading DNS records...</td></tr>) : recs.map((r)=>(
            <tr key={r.id} onMouseEnter={e=>e.currentTarget.style.background="#fafbfc"} onMouseLeave={e=>e.currentTarget.style.background=""}>
              <td style={{padding:"11px 16px"}}><span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700,background:"#f3f4f6",color:DNS_TYPE_COLORS[r.type]||"#374151",fontFamily:"monospace"}}>{r.type}</span></td>
              <td style={{padding:"11px 16px",fontFamily:"monospace",fontSize:13,fontWeight:600,color:"#111"}}>{r.name}</td>
              <td style={{padding:"11px 16px",fontFamily:"monospace",fontSize:12.5,color:"#374151",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.content}</td>
              <td style={{padding:"11px 16px",fontSize:13,color:"#6b7280"}}>{r.ttl==null?"—":r.ttl===1?"Auto":`${r.ttl}s`}</td>
              <td style={{padding:"11px 16px",fontSize:18}}>{r.proxied?"🟠":"⚫"}</td>
              <td style={{padding:"11px 16px"}}><RowActions actions={[
                { icon: "✎", title: "Edit DNS record", disabled: !canExecute, onClick: () => openEditRecord(r) },
                // Блокируем ТУ САМУЮ строку, а не всю таблицу: мутация одна на
                // весь список, и `isPending` без сверки с `variables` гасил бы
                // крестики у всех записей разом.
                { icon: "✕", title: "Delete DNS record", variant: "danger", disabled: !canExecute || (deleteRecord.isPending && deleteRecord.variables === r.id), onClick: async () => { dismissBanner(); if (!(await confirmAction(`Delete DNS record ${r.name}?`))) return; deleteRecord.mutate(r.id); } },
              ]}/></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>

    {showDns&&<Modal title="Add DNS Record" onClose={()=>setShowDns(false)} width={460}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:12}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Type</label><Sel value={recordType} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setRecordType((e.target as any).value)} style={{width:"100%"}}>{DNS_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></div>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={recordName} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setRecordName((e.target as any).value)} placeholder="@ or subdomain"/></div>
        </div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Content</label><Inp value={recordContent} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setRecordContent((e.target as any).value)} placeholder="IP address or value"/></div>
        {needsPriority && (
          <div>
            <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Priority</label>
            <Inp value={recordPriority} onChange={(e: any)=>setRecordPriority(e.target.value)} placeholder="10"/>
            <div style={{fontSize:11.5,color:"#9ca3af",marginTop:4}}>Required by Cloudflare for {recordType} records.</div>
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>TTL</label><Sel value={recordTtl} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setRecordTtl((e.target as any).value)} style={{width:"100%"}}><option value="1">Auto</option><option value="300">5 min</option><option value="3600">1 hour</option><option value="86400">1 day</option></Sel></div>
          <div style={{paddingTop:22}}><label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={recordProxied} onChange={e=>setRecordProxied((e.target as any).checked)}/><span>Proxied (orange cloud)</span></label></div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginTop:20}}><Btn variant="primary" onClick={handleCreateRecord} disabled={createRecord.isPending || !recordName.trim() || !recordContent.trim()} style={{flex:1,justifyContent:"center"}}>{createRecord.isPending ? "Adding..." : "Add Record"}</Btn><Btn variant="secondary" onClick={()=>setShowDns(false)} style={{flex:1,justifyContent:"center"}}>Cancel</Btn></div>
    </Modal>}
    {showNs && <Modal title={`Nameservers for ${zone.name}`} onClose={()=>setShowNs(false)} width={460}>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {nameServers.map((ns: string) => <div key={ns} style={{padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontFamily:"monospace",fontSize:13}}>{ns}</div>)}
        {nameServers.length === 0 && (
          <div style={{fontSize:13,color:"#6b7280"}}>
            {canExecute ? "No nameservers returned for this zone." : `Nameservers come from Cloudflare. ${DESKTOP_ONLY_NOTE}`}
          </div>
        )}
      </div>
    </Modal>}
    {editingRecord && <EditDnsRecordModal record={editingRecord} onClose={()=>setEditingRecord(null)} onSave={(payload) => updateRecord.mutate({ recordId: editingRecord.id, data: payload }, { onSuccess: () => setEditingRecord(null) })} isSaving={updateRecord.isPending} />}
  </>;
}

function EditCfAccountModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [name, setName] = useState(account.name || "");
  const [accountId, setAccountId] = useState(account.account_id || "");
  // Многополевой хук на одном поле, а не `useSecretSave`: секрет здесь
  // ОПЦИОНАЛЬНЫЙ, и «не меняем токен» выражается пустым `secrets` — тем же
  // `Partial`, что у регистратора. Иначе понадобился бы второй путь сохранения
  // мимо хука, со своим `saving` и своим каналом ошибки.
  const secrets = useMultiSecretSave({ apiToken: "API token" });
  const update = useUpdateCloudflareAccount(account.id);

  const handleSave = async () => {
    // Этот `trim` решает ровно один вопрос: тронуто ли поле. Без него `"   "`
    // прошёл бы и сюда, и проверку пустоты в хуке, и затёр бы живой блоб
    // пробелами. Сам плейнтекст он не чистит: в блоб уезжает стейт хука, а не
    // `typed`, — пробелы по краям с него снимает `trim` в onChange поля ниже, и
    // никакой второй страховки на плейнтекст здесь нет.
    const typed = secrets.values.apiToken.trim();
    const ok = await secrets.saveAll({
      // Пустой `secrets` — это «оставь пустым, чтобы сохранить текущий»:
      // блобов не пишем, `persist` всё равно зовётся, PUT уходит без
      // `api_token_blob_id`, и сервер оставляет прежнюю ссылку.
      secrets: typed
        ? {
            // Это ПРАВКА: переписываем именно текущий блоб. Новый id оставил бы
            // аккаунт указывать на прежний токен — «сохранено», а в Cloudflare
            // едет старый секрет. Версии блоба ведёт сервер внутри одного id.
            apiToken: {
              blobKind: BLOB_KIND.cloudflareApiToken,
              existingBlobId: account.api_token_blob_id ?? null,
            },
          }
        : {},
      persist: async (blobIds) => {
        await update.mutateAsync({
          name: name.trim(),
          account_id: accountId.trim() || null,
          ...(blobIds.apiToken ? { api_token_blob_id: blobIds.apiToken } : {}),
        });
      },
    });
    if (ok) onClose();
  };

  // Пока идёт запись блоба или PUT, уходить нельзя: размонтированная форма
  // унесёт с собой хук, и `setError` упавшего сохранения приземлится в пустоту —
  // канала для этой ошибки у страницы нет. Окно — целый round-trip.
  const closeIfIdle = () => { if (!secrets.saving) onClose(); };

  return <Modal title={`Edit ${account.name}`} onClose={closeIfIdle} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Label</label><Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setName((e.target as any).value)} /></div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Account ID</label><Inp value={accountId} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setAccountId((e.target as any).value)} placeholder="Cloudflare account id" /></div>
      <div>
        <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>API Token (optional)</label>
        {/* Почему в вебе поля нет вовсе — JSDoc `DesktopOnlyNote`. Переименовать
            аккаунт в вебе при этом можно: для этого секрет не нужен.
            Плейсхолдер — только про «оставь пустым»: показать хвост текущего
            токена нечем, плейнтекста на клиенте нет, а `api_token_masked`
            маскирует хвост blob_id, а не токена. */}
        {isTauri() ? (
          <Inp type="password" value={secrets.values.apiToken} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>secrets.setValue("apiToken", e.target.value.trim())} placeholder="Leave empty to keep current" />
        ) : (
          <DesktopOnlyNote what="Saving secrets" />
        )}
      </div>
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

function EditDnsRecordModal({ record, onClose, onSave, isSaving }: {
  record: DnsRecord;
  onClose: () => void;
  onSave: (payload: DnsRecordUpdate) => void;
  isSaving: boolean;
}) {
  const [type, setType] = useState(record.type || "A");
  const [name, setName] = useState(record.name || "");
  const [content, setContent] = useState(record.content || "");
  // «Нет TTL» — это пустая строка, а не 1: `String(record.ttl || 1)` превращал
  // отсутствующий TTL в Auto у любого, кто просто открыл и сохранил запись.
  const [ttl, setTtl] = useState(record.ttl == null ? "" : String(record.ttl));
  const ttlOptions = ttlOptionsFor(record.ttl);
  const [proxied, setProxied] = useState(Boolean(record.proxied));
  // Cloudflare не возвращает priority в DnsRecord, поэтому подставить текущее
  // значение нечем: пустое поле = «не трогать» (serde видит undefined как None).
  const [priority, setPriority] = useState("");
  const needsPriority = TYPES_WITH_PRIORITY.has(type);
  return <Modal title={`Edit record ${record.name}`} onClose={onClose} width={460}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:12}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Type</label><Sel value={type} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setType((e.target as any).value)} style={{width:"100%"}}>{DNS_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></div>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Name</label><Inp value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setName((e.target as any).value)} /></div>
      </div>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Content</label><Inp value={content} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setContent((e.target as any).value)} /></div>
      {needsPriority && (
        <div>
          <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Priority</label>
          <Inp value={priority} onChange={(e: any)=>setPriority(e.target.value)} placeholder="leave empty to keep current" />
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>TTL</label><Sel value={ttl} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setTtl((e.target as any).value)} style={{width:"100%"}}>{ttlOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</Sel></div>
        <div style={{paddingTop:22}}><label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={proxied} onChange={e=>setProxied((e.target as any).checked)} /><span>Proxied</span></label></div>
      </div>
    </div>
    <div style={{display:"flex",gap:8,marginTop:20}}>
      <Btn variant="primary" disabled={isSaving || !name.trim() || !content.trim()} onClick={() => onSave({ type, name: name.trim(), content: content.trim(), ttl: ttl === "" ? undefined : Number(ttl), proxied, priority: needsPriority && priority.trim() ? Number(priority) : undefined })} style={{flex:1,justifyContent:"center"}}>{isSaving ? "Saving..." : "Save"}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{flex:1,justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
