import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CHd, CTi, Btn, StatCard, Badge, Modal, Inp, Sel, RowActions, EmptyState, ErrorState, CopyBtn } from "../components/ui/Primitives";
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

/**
 * Зона в UI. `nameServers` и `status` приходят из `cf_list_zones`, то есть
 * только в десктопе; у резервного списка из доменов (`zonesOfAccount`) их нет.
 * Что из этого следует для бейджа — у `ZONE_STATUS_VARIANT`.
 */
export interface CfZoneRef {
  id: string;
  name: string;
  nameServers?: string[] | null;
  status?: string | null;
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

/**
 * Цвет бейджа по статусу зоны у Cloudflare. Зелёный достаётся ровно одному
 * значению — `active`: только оно означает «делегирование доехало». Всё
 * незнакомое (`moved`, `deactivated`, `read only`, завтрашние) — серое: гадать
 * в сторону здоровья нельзя, а называть чужое состояние «pending» — врать.
 * Отсутствие статуса вовсе разбирается на месте: бейджа тогда нет совсем.
 */
const ZONE_STATUS_VARIANT: Record<string, string> = {
  active: "green",
  pending: "yellow",
  initializing: "yellow",
};

/**
 * Порядок ступеней при сортировке зон по статусу. Сверху то, что ждёт действия
 * человека: `pending` — «пойди пропиши NS у регистратора», `initializing` —
 * Cloudflare ещё заводит зону. Дальше идёт всё незнакомое (`moved`,
 * `deactivated`): что с ним делать, мы не знаем, но и «в порядке» оно не
 * значит. `active` — ниже всех статусов: с ним делать нечего. Зона БЕЗ статуса
 * уходит в самый низ, а не наверх: её статуса мы не знаем (веб собирает список
 * из доменов), и поднять незнание в начало списка «важного» значило бы выдать
 * его за проблему — ровно тот же подлог, что и покрасить его зелёным.
 */
const ZONE_STATUS_RANK: Record<string, number | undefined> = {
  pending: 0,
  initializing: 1,
  active: 3,
};
const ZONE_RANK_UNKNOWN = 2;
const ZONE_RANK_NO_STATUS = 4;

/**
 * С какого числа зон появляется ПОИСК. Пока список читается одним взглядом,
 * поле над ним — лишняя мишень и лишняя строка в теле карточки; глазами по
 * семи именам попадают быстрее, чем набирают запрос. Порог считается по
 * ПОЛНОМУ числу зон, а не по отфильтрованному: иначе поле исчезало бы под
 * пальцами, стоит запросу сузить список.
 */
const ZONE_SEARCH_MIN = 8;

/**
 * С какого числа зон появляется СОРТИРОВКА. Порог у неё свой и низкий: селектор
 * стоит один тег в уже существующем ряду и полезен с двух строк («где тут
 * pending?»), тогда как поле поиска требует набрать запрос, чтобы окупиться.
 * Одна зона — единственный случай, когда сортировать нечего в принципе.
 */
const ZONE_SORT_MIN = 2;

export type ZoneSort = "name" | "status";

/**
 * Фильтр аккаунтов: имя и `account_id`. Именно `account_id`, а не только имя, —
 * его копируют из панели Cloudflare и им же опознают аккаунт, когда имена у
 * всех вида «Main CF». Пустой запрос — весь список, а не пустой экран.
 */
export function filterAccounts<T extends { name: string; account_id?: string | null }>(
  accounts: T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter(
    (a) => a.name.toLowerCase().includes(q) || (a.account_id || "").toLowerCase().includes(q)
  );
}

/** Фильтр зон по имени. Регистр не важен: домены пишут и как «Example.com». */
export function filterZones(zones: CfZoneRef[], query: string): CfZoneRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return zones;
  return zones.filter((z) => z.name.toLowerCase().includes(q));
}

/**
 * Сортировка зон. Ключ статуса — `ZONE_STATUS_RANK`; при равных статусах (а в
 * вебе статуса нет вообще ни у одной зоны) порядок доопределяется именем.
 * Без этого добора список зависел бы от того, откуда он приехал: живой
 * `cf_list_zones` отдаёт свой порядок, резерв из доменов — уже отсортированный.
 */
export function sortZones(zones: CfZoneRef[], mode: ZoneSort): CfZoneRef[] {
  const rank = (z: CfZoneRef) =>
    !z.status ? ZONE_RANK_NO_STATUS : ZONE_STATUS_RANK[z.status] ?? ZONE_RANK_UNKNOWN;
  return [...zones].sort((a, b) => {
    if (mode === "status" && rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.name.localeCompare(b.name);
  });
}

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
  // точечно. Состояние локальное, а не общий Set в родителе, потому что
  // «свёрнут» — свойство одной карточки. Цена известна и принята: поиск по
  // аккаунтам ВЫКИДЫВАЕТ несовпавшие карточки из дерева, и снятие запроса
  // возвращает их свёрнутыми, с пустым поиском зон и сортировкой по умолчанию.
  // Для запроса зон сброс даже уместен, для `collapsed` — нет; лечится подъёмом
  // в родителя (долг Д8 в плане), а не здесь.
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
  // Оба списка мемоизированы, и это не микрооптимизация: ввод в поиск по
  // аккаунтам перерисовывает страницу, а с ней ВСЕ карточки — включая свёрнутые,
  // которых на экране десятки. Без мемо каждая из них на каждый символ заново
  // копировала и сортировала свои сотни зон, то есть работа шла на списки,
  // которых никто не видит.
  const zones: CfZoneRef[] = useMemo(
    () =>
      liveZones.data
        ? liveZones.data.map((z: Zone) => ({ id: z.id, name: z.name, nameServers: z.name_servers, status: z.status }))
        : domainZones,
    [liveZones.data, domainZones]
  );
  const zonesLoading = canExecute && liveZones.isPending;
  const [zoneQuery, setZoneQuery] = useState("");
  const [zoneSort, setZoneSort] = useState<ZoneSort>("name");
  const showZoneSearch = zones.length >= ZONE_SEARCH_MIN;
  const showZoneSort = zones.length >= ZONE_SORT_MIN;
  // Сортировать по статусу можно, только если он есть хоть у одной зоны: в вебе
  // список собран из наших доменов и статуса не знает ни одна строка, так что
  // пункт давал бы ровно тот же порядок, что и «по имени», — мёртвый выбор,
  // размноженный на все карточки веба.
  const canSortByStatus = zones.some((z) => z.status);
  // Фильтр действует ровно тогда, когда поле видно. Иначе список, ужавшийся
  // ниже порога (зону удалили), остался бы отфильтрован невидимым запросом.
  const zoneFilter = showZoneSearch ? zoneQuery : "";
  // Сортировка применяется и к коротким спискам, у которых селектора не видно:
  // иначе один и тот же аккаунт с двумя зонами и с одной раскладывал бы их
  // по-разному. Порядок по умолчанию — по имени; живой `cf_list_zones` отдавал
  // свой, и «Sort: name» обязан что-то значить с первого кадра.
  const visibleZones = useMemo(
    () => sortZones(filterZones(zones, zoneFilter), zoneSort),
    [zones, zoneFilter, zoneSort]
  );
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
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:zones.length?10:0}}>
          {/* Число здесь — ПОЛНОЕ, то же, что в бейдже шапки: они объявлены
              одним показателем, и разъехавшись, заставили бы гадать, какому
              верить. Сколько строк осталось от запроса, говорит счётчик у
              самого поля — там это утверждение про фильтр, а не про аккаунт. */}
          <div style={{fontSize:12,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px"}}>
            Zones ({zones.length})
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {showZoneSearch && (
              <>
                {/* Подпись адресная — и с `account_id`: развёрнутых карточек
                    может быть несколько, а имена у аккаунтов сплошь «Main CF»
                    (ровно поэтому фильтр выше и ищет по id). Одним именем
                    подписи тёзок были бы неразличимы — ни скринридеру, ни
                    тесту. `aria-label`, а не `<label>`: подписи у полей этой
                    страницы с ними не связаны вовсе (долг Д5), и опираться на
                    этот образец нельзя. */}
                <Inp
                  value={zoneQuery}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setZoneQuery(e.target.value)}
                  placeholder="Filter zones"
                  aria-label={`Search zones in ${acc.name}${acc.account_id ? ` (${acc.account_id})` : ""}`}
                  style={{width:170,padding:"6px 10px",fontSize:12.5}}
                />
                {/* Справа от поля, как и у поиска по аккаунтам: число про фильтр
                    принадлежит полю, а не заголовку «Zones (N)» — встав рядом с
                    ним, оно читалось бы вторым мнением о том же. */}
                {zoneFilter.trim() ? (
                  <span role="status" style={{fontSize:12,color:"#6b7280",whiteSpace:"nowrap"}}>
                    {visibleZones.length} of {zones.length}
                  </span>
                ) : null}
              </>
            )}
            {showZoneSort && (
              <Sel
                value={zoneSort}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setZoneSort(e.target.value as ZoneSort)}
                aria-label={`Sort zones in ${acc.name}${acc.account_id ? ` (${acc.account_id})` : ""}`}
                style={{padding:"6px 10px",fontSize:12.5}}
              >
                <option value="name">Sort: name</option>
                {canSortByStatus ? <option value="status">Sort: status</option> : null}
              </Sel>
            )}
            <Btn size="sm" variant="secondary" onClick={onAddZone} disabled={!canExecute}>+ Add Zone</Btn>
          </div>
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
        ) : visibleZones.length === 0 ? (
          // «Зон нет» и «ни одна не подошла» — разные факты, и первый на месте
          // второго заставил бы решить, что зоны пропали.
          <div style={{ fontSize: 12.5, color: "#9ca3af" }}>
            No zones match “{zoneFilter.trim()}”.
          </div>
        ) : (
          visibleZones.map((z) => (
            <div
              key={z.id}
              data-testid="zone-row"
              style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderTop:"1px solid #f3f4f6"}}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: "#111", flex: 1 }}>{z.name}</span>
              {/* Статуса нет — нет и бейджа: в вебе список зон собран из наших
                  доменов, и о делегировании он не знает НИЧЕГО. Серый «pending»
                  на этом месте был бы выдуманным измерением; почему список
                  неполон, уже сказано подписью над ним. */}
              {/* Слова — сырые, из словаря Cloudflare; заглавная буква их не
                  выдумывает и держит бейдж в одном регистре с соседними
                  («Active» в шапке). `capitalize` поднимает первую букву
                  каждого слова, так что многословный `read only` станет
                  «Read Only» — непривычно, но читаемо. */}
              {z.status ? (
                <Badge variant={ZONE_STATUS_VARIANT[z.status] || "gray"} style={{textTransform:"capitalize"}}>{z.status}</Badge>
              ) : null}
              <span style={{ fontFamily: "monospace", fontSize: 11.5, color: "#9ca3af" }}>{z.id}</span>
              {/* Имя зоны в подписи — потому что кнопок на экране столько же,
                  сколько зон, и «Copy zone ID» у всех читалось бы одинаково. */}
              <CopyBtn value={z.id} label={`Copy zone ID for ${z.name}`} />
              <Btn size="sm" variant="secondary" onClick={() => onOpenZone(z)}>Open DNS</Btn>
            </div>
          ))
        )}
      </div>
      </>)}{/* ← конец `{!collapsed &&`: тело карточки (токен + зоны) */}
    </Card>
  );
}

/**
 * С какого числа аккаунтов появляется «проверить все токены». На одном аккаунте
 * кнопка была бы второй мишенью того же действия, что и Test connection в его
 * единственной карточке, только со сводкой поверх собственной полосы итога.
 * Порог считается по ПОЛНОМУ числу аккаунтов, а не по видимым: иначе кнопка
 * пропадала бы под пальцами, стоит запросу сузить список до одного, — та же
 * причина, что у порогов зон выше.
 */
const TEST_ALL_MIN = 2;

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

  const [accQuery, setAccQuery] = useState("");
  const [editingAcc, setEditingAcc] = useState<any | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<number, { state: "idle" | "loading" | "success" | "error"; message?: string }>>({});
  /** Идущий прогон «проверить все токены»: сколько закончено из скольких. */
  const [bulkTest, setBulkTest] = useState<{ done: number; total: number } | null>(null);
  /** Итог последнего ЗАВЕРШЁННОГО прогона; `failed` — имена аккаунтов. */
  const [bulkSummary, setBulkSummary] = useState<{ total: number; failed: string[] } | null>(null);
  // Жива ли ещё страница. Вкладку рисует `{page === "cloudflare" && <Cloudflare/>}`
  // (`DesktopWorkspace.tsx`), то есть уход на соседнюю вкладку РАЗМОНТИРУЕТ её —
  // и осиротевший прогон продолжал бы ходить в Cloudflare по всему снимку, а
  // вернувшийся пользователь запускал бы второй поверх ещё живого первого.
  const alive = useRef(true);
  // Таймеры «погасить зелёное через 3 секунды» — по одному на аккаунт. Общий
  // (или ничей) таймер гасил бы проверку, идущую ПРЯМО СЕЙЧАС: успел проверить
  // аккаунт руками, в те же 3 секунды запустил прогон — и старый таймер
  // возвращал бы карточку в `idle` посреди её новой проверки, снова включая
  // кнопку. С одиночными кликами это было экзотикой, с прогоном на десятки
  // аккаунтов — штатное окно.
  const resetTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  // Флаг поднимается В ТЕЛЕ эффекта, а не только гасится в его уборке. Иначе под
  // `React.StrictMode` (он обёрнут вокруг всего приложения в `main.tsx`) фича
  // мертва в dev целиком: React 18 там делает монтирование → эффект → уборку →
  // эффект НА ТОМ ЖЕ экземпляре, а рефы при этом не пересоздаются, — `alive`
  // уходил в `false` на симулированном размонтировании и не возвращался никогда.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Таймеры сброса успеха уносим с собой: своей карточки они уже не найдут.
      Object.values(resetTimers.current).forEach(clearTimeout);
    };
  }, []);
  const visibleAccounts = filterAccounts(cfAccounts, accQuery);
  // Идущий прогон держит кнопку на экране даже тогда, когда порог соблюдён, а
  // проверять сейчас нечего: запрос, сузивший список до пустого, унёс бы с
  // экрана единственный признак того, что прогон ещё идёт.
  const showTestAll = cfAccounts.length >= TEST_ALL_MIN && (bulkTest !== null || visibleAccounts.length > 0);
  // Резервные списки зон считаются один раз на набор доменов, а не на символ,
  // набранный в поиске: каждый вызов — проход по ВСЕМ доменам, и без мемо их
  // было бы столько же, сколько аккаунтов, на каждое нажатие клавиши. Заодно
  // ссылка на массив остаётся прежней, и мемо внутри карточки не сбрасывается.
  const domainZonesByAccount = useMemo(
    () => new Map(cfAccounts.map((a) => [a.id, zonesOfAccount(domains, a.id)])),
    [cfAccounts, domains]
  );

  /**
   * Одна проверка токена; `true` — токен живой. `mutateAsync`, а не `mutate` с
   * колбэками: мутация на странице ОДНА на все аккаунты, а её наблюдатель
   * держит колбэки только последнего вызова и отписывается от предыдущей
   * мутации. В прогоне по списку это значило бы, что итог доедет ровно до
   * последней карточки, а остальные останутся «Testing...» навсегда. Промис же
   * принадлежит своему вызову и приходит туда, откуда его ждали, — поэтому и
   * одиночная кнопка, и прогон ходят одним путём.
   */
  const runTest = async (accountId: number): Promise<boolean> => {
    // Таймер прошлой проверки ЭТОГО аккаунта снимаем первым делом: иначе он
    // погасит индикатор новой (см. `resetTimers`).
    clearTimeout(resetTimers.current[accountId]);
    setTestState((prev) => ({ ...prev, [accountId]: { state: "loading" } }));
    try {
      const res = await testAcc.mutateAsync(accountId);
      const nextState = res.success ? "success" : "error";
      setTestState((prev) => ({ ...prev, [accountId]: { state: nextState, message: res.message } }));
      if (res.success) {
        resetTimers.current[accountId] = setTimeout(() => {
          setTestState((prev) => ({ ...prev, [accountId]: { state: "idle" } }));
        }, 3000);
      }
      return res.success;
    } catch (err: any) {
      setTestState((prev) => ({
        ...prev,
        [accountId]: { state: "error", message: String(err?.message || "Connection test failed") },
      }));
      return false;
    }
  };

  /**
   * Обе зелёные плашки страницы — сводка прогона и «Cloudflare account created.»
   * — утверждают об итоге ПОСЛЕДНЕГО действия, поэтому и гаснут одинаково: от
   * следующего.
   *
   * Сводка иначе продолжает дословно называть провалившимся («1 of 3 tokens
   * failed: Second CF») аккаунт, у которого рядом, в его же карточке, стоит
   * зелёное «✓ OK». Именно снять, а не вычеркнуть имя из списка: подправленная
   * сводка перестала бы быть утверждением о ПОЛНОМ проходе, ради которого она и
   * ставится целиком.
   *
   * У статуса создания причина своя: он и сводка — две карточки одного зелёного,
   * стоящие впритык, и различить их на экране нечем. Путь «создал аккаунт →
   * проверил все токены» показывал обе разом, причём верхняя устарела ещё до
   * начала прогона.
   */
  const clearBanners = () => { setBulkSummary(null); setStatusMessage(null); };

  const handleTest = (accountId: number) => { clearBanners(); void runTest(accountId); };

  /**
   * Прогон по ВИДИМЫМ аккаунтам, а не по всем: поле поиска стоит на том же
   * экране, и кнопка, тихо ушедшая проверять скрытые фильтром аккаунты, делала
   * бы не то, что показывает. Ровно поэтому в подписи стоит число — она честна
   * и с запросом, и без него. Список снимается один раз, на клике: фильтр можно
   * поменять во время прогона, и тогда «12» в прогрессе перестало бы сходиться с
   * тем, что считается.
   *
   * Проверки идут ПО ОДНОЙ. Дело не только в вежливости к Cloudflare: каждая
   * `cf_verify_token` — это ещё и `sync_now` перед ней (`invokeSynced`), а
   * мутация на странице одна (см. `runTest`), и десяток одновременных вызовов
   * оставил бы её `variables`/`isPending` описывающими случайный из них.
   *
   * Кнопки «отменить» нет, но у прогона есть одна точка остановки — уход со
   * страницы. Выбор зоны ею не считается (`if (sel)` — ранний возврат ВНУТРИ
   * компонента, страница жива и итоги доедут), а вот переключение вкладки
   * размонтирует её насовсем: без сторожа цикл продолжал бы ходить в Cloudflare
   * по всему снимку, а вернувшийся пользователь получил бы кнопку в исходном
   * виде и мог бы запустить второй прогон поверх ещё живого первого.
   */
  const handleTestAll = async () => {
    const batch = visibleAccounts.map((a) => ({ id: a.id, name: a.name }));
    if (!batch.length) return;
    clearBanners();
    setBulkTest({ done: 0, total: batch.length });
    const failed: string[] = [];
    try {
      for (const acc of batch) {
        if (!alive.current) return;
        if (!(await runTest(acc.id))) failed.push(acc.name);
        setBulkTest((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
      // Сводка ставится только после ПОЛНОГО прохода: оборвись он на середине,
      // «2 из 12 не прошли» умолчало бы о том, что восемь вообще не проверяли.
      setBulkSummary({ total: batch.length, failed });
    } finally {
      setBulkTest(null);
    }
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
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {/* Кнопки «проверить все» в вебе нет вовсе, а не выключенной: токен
              расшифровывается на клиенте, и проверить его браузер не может в
              принципе — ровно то же, почему рядом нет «+ Add Account». Дохлый
              контрол в шапке пришлось бы объяснять второй заметкой поверх уже
              стоящей. Одиночный Test connection в карточке остаётся видимым и
              выключенным по своей причине: он привязан к аккаунту, и его
              отсутствие читалось бы как «у этого аккаунта проверять нечего». */}
          {showTestAll && (
            <Btn variant="secondary" onClick={() => { void handleTestAll(); }} disabled={bulkTest !== null}>
              {bulkTest
                // Пока прогон идёт, показываем ТЕКУЩИЙ номер, а не число
                // законченных: «Testing 0 of 12» выглядело бы зависшим.
                ? `Testing ${Math.min(bulkTest.done + 1, bulkTest.total)} of ${bulkTest.total}…`
                : `Test ${visibleAccounts.length} ${visibleAccounts.length === 1 ? "token" : "tokens"}`}
            </Btn>
          )}
          <Btn variant="primary" onClick={()=>setShowAcc(true)}>+ Add Account</Btn>
        </div>
      ) : (
        <DesktopOnlyNote what="Saving secrets" />
      )}
    </div>
    {/* Сводка прогона. Полосы итога в карточках её не заменяют: при десятках
        аккаунтов их не видно разом, а успех и вовсе гаснет через 3 секунды.
        Отдельной ступени «не проверено» здесь нет и не нужно — сводка ставится
        только после полного прохода по снимку списка, поэтому «ok = total −
        failed» тут утверждение, а не допущение. Гаснет она не по таймеру, а от
        следующего прогона: провалившийся токен — это задача, а не уведомление. */}
    {bulkSummary && (
      <Card style={{marginBottom:14}}>
        <div
          role="status"
          style={{
            padding:"12px 16px",
            fontSize:13,
            borderRadius:10,
            color: bulkSummary.failed.length ? "#991b1b" : "#166534",
            background: bulkSummary.failed.length ? "#fef2f2" : "#f0fdf4",
          }}
        >
          {/* Имена, а не голое число: карточку с провалившимся токеном иначе
              пришлось бы искать скроллом по всему списку. */}
          {bulkSummary.failed.length
            ? `${bulkSummary.failed.length} of ${bulkSummary.total} ${bulkSummary.total === 1 ? "token" : "tokens"} failed: ${bulkSummary.failed.join(", ")}.`
            : `${bulkSummary.total} ${bulkSummary.total === 1 ? "token" : "tokens"} verified.`}
        </div>
      </Card>
    )}
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
    {/* Искать не в чем, пока аккаунтов нет вовсе: пустое поле над пустым
        экраном — обещание списка, которого не существует. */}
    {cfAccounts.length > 0 && (
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        {/* Про `aria-label` вместо `<label>` — у поля поиска зон выше. */}
        <Inp
          value={accQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccQuery(e.target.value)}
          placeholder="Search accounts by name or account ID"
          aria-label="Search Cloudflare accounts"
          style={{maxWidth:340}}
        />
        {/* Единственное место, где показано отфильтрованное число. Счётчики
            выше («N accounts connected», StatCard) остаются ОБЩИМИ: они
            описывают, сколько аккаунтов подключено, а не сколько строк сейчас
            видно, и, поехав за фильтром, молча сменили бы смысл. */}
        {/* `role="status"` — и здесь, и у счётчика зон: список меняется молча,
            и без объявления скринридер узнаёт об этом, только уйдя проверять
            его руками. */}
        {accQuery.trim() ? (
          <span role="status" style={{fontSize:12.5,color:"#6b7280",whiteSpace:"nowrap"}}>
            {visibleAccounts.length} of {cfAccounts.length}
          </span>
        ) : null}
      </div>
    )}
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
    ) : visibleAccounts.length === 0 ? (
      // Отдельное состояние, а не «No Cloudflare accounts yet»: аккаунты есть,
      // и предлагать завести ещё один в ответ на неудачный поиск — совет мимо
      // задачи. Действие здесь ровно одно — снять запрос.
      <Card>
        <EmptyState
          title="No accounts match your search"
          description={`Nothing is named or identified as “${accQuery.trim()}”.`}
        >
          <Btn variant="secondary" onClick={() => setAccQuery("")}>Clear search</Btn>
        </EmptyState>
      </Card>
    ) : (
      visibleAccounts.map((acc)=>(
      <AccountCard
        key={acc.id}
        acc={acc}
        onEdit={() => setEditingAcc(acc)}
        onDelete={async () => {
          if (!(await confirmAction(`Delete account ${acc.name}?`))) return;
          // Плашки снимаются и здесь: иначе сводка продолжает называть поимённо
          // провалившимся аккаунт, которого больше нет.
          clearBanners();
          deleteAcc.mutate(acc);
        }}
        onTest={() => handleTest(acc.id)}
        testStatus={testState[acc.id]}
        domainZones={domainZonesByAccount.get(acc.id) || []}
        onOpenZone={(zone) => setSel({ acc: { id: acc.id, name: acc.name }, zone })}
        onAddZone={() => setAddZoneFor({ id: acc.id, name: acc.name })}
      />
    )))}

    {showAddAcc && (
      <AddCfAccountModal
        onClose={()=>setShowAcc(false)}
        // Созданный аккаунт делает сводку неверной ровно так же, как удалённый:
        // «3 tokens verified.» утверждает про полный проход по списку, в котором
        // теперь стоит четвёртая, ни разу не проверенная карточка. Статус при
        // этом ставится — он и есть итог этого действия.
        onStatus={(text) => { setBulkSummary(null); setStatusMessage(text); }}
      />
    )}
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
        {/* NS вбивают у регистратора все разом, поэтому копируется список
            целиком и через `\n` — так он и вставляется в поля формы. Кнопки нет,
            когда копировать нечего: в вебе NS не приезжают вовсе. */}
        {nameServers.length > 0 && (
          <div style={{display:"flex",justifyContent:"flex-end"}}>
            <CopyBtn value={nameServers.join("\n")} label="Copy nameservers" />
          </div>
        )}
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
  // Приоритет есть только у MX/SRV/URI — у прочих типов он null, и поля не
  // видно. Стёртое поле по-прежнему значит «не трогать» (serde видит undefined
  // как None): у MX приоритет обязателен, убирать его нечем и незачем.
  const [priority, setPriority] = useState(record.priority == null ? "" : String(record.priority));
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
          <Inp value={priority} onChange={(e: any)=>setPriority(e.target.value)} placeholder="10" />
          {/* Не «keep the current»: у записи, которой меняют тип с A на MX,
              текущего приоритета нет вовсе, и пустое поле даст патч без него
              (это долг Д3 в плане). «Не меняется» честно в обоих случаях. */}
          <div style={{fontSize:11.5,color:"#9ca3af",marginTop:4}}>Empty = priority unchanged.</div>
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
