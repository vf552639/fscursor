import React from "react";

import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import DomainRow from "./DomainRow";
import { Sort, SortKey } from "./sortDomains";
import { DomainUI } from "./types";

const TH_STYLE: React.CSSProperties = {padding:"10px 16px",textAlign:"left",fontSize:11.5,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.4px",background:"#f9fafb",borderBottom:"1px solid #e5e7eb",whiteSpace:"nowrap"};

// Оба заголовка ниже живут на уровне модуля, а НЕ внутри `DomainTable`, и это
// не стилистика. Компонент, объявленный в теле другого компонента, — новый тип
// на каждый рендер, то есть React перемонтирует ячейки шапки при любом
// изменении стейта страницы. С кнопкой внутри это стоило фокуса: клик по
// заголовку менял `sort`, шапка перемонтировалась, и `document.activeElement`
// уезжал на `body` — а вторая сортировка, ради которой всё и затевалось, это
// ВТОРОЙ клик по тому же заголовку. Клавиатурному пользователю приходилось
// протабливаться к нему заново; мышью дефект не виден вовсе. Есть тест.

/**
 * Неподвижная подпись колонки: у чекбокса и у колонки действий сортировать
 * нечего, и кликабельный заголовок над ними обещал бы порядок, которого у
 * кнопок не бывает. Отдельный компонент, а не `Th` без `k`: иначе несортируемый
 * заголовок обязан таскать за собой `sort`/`onSort`, которые ему не нужны.
 */
function PlainTh({children}: {children?: React.ReactNode}){
  return <th style={TH_STYLE}>{children}</th>;
}

/**
 * Кликабельный заголовок сортируемой колонки.
 *
 * Стрелка стоит и на неактивных сортируемых заголовках (бледная «↕»): иначе то,
 * что колонка вообще кликабельна, узнаётся только случайным попаданием курсора.
 * `aria-sort` — на `th`, потому что о состоянии колонки скринридеры спрашивают
 * именно ячейку заголовка, а не кнопку внутри.
 *
 * `aria-label` кнопке нужен именно потому, что `aria-sort` живёт на ячейке: в
 * режиме форм (focus mode) скринридер читает только саму кнопку, и без имени
 * действия она звучала бы как «Expires, кнопка» — то есть о том, что нажатие
 * переупорядочивает список, пользователь бы не узнал. Стрелка тут не помощник:
 * она `aria-hidden`, и это правильно — вслух она читалась бы мусорным символом.
 *
 * `label` обязателен, и он же — видимая подпись: пока он был опциональным с
 * фолбэком на ключ, колонка, для которой его забыли, объявляла бы себя «Sort by
 * created».
 */
function SortableTh({k, label, sort, onSort}: {k: SortKey, label: string, sort: Sort, onSort: (k: SortKey) => void}){
  const active = sort.key === k;
  return <th style={TH_STYLE} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
    <button type="button" onClick={()=>onSort(k)} aria-label={`Sort by ${label}`} style={{display:"inline-flex",alignItems:"center",gap:4,background:"none",border:"none",padding:0,cursor:"pointer",font:"inherit",color:active?"#2563eb":"inherit",letterSpacing:"inherit",textTransform:"inherit"}}>
      {label}
      <span aria-hidden="true" style={{color:active?"#2563eb":"#d1d5db"}}>{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  </th>;
}

/** Колонка шапки: подпись и, если по ней есть порядок, ключ сортировки. */
interface Column {
  label: string;
  key?: SortKey;
}

/** Колонка чекбокса в этот список не входит: у неё своя ширина и свой `th`. */
const COLUMNS: Column[] = [
  {label:"Domain",key:"domain"},
  {label:"Server"},
  {label:"Registrar"},
  {label:"Cloudflare"},
  {label:"Status",key:"status"},
  {label:"Expires",key:"expiry_date"},
  {label:"SSL",key:"ssl"},
  {label:"Added",key:"created"},
  {label:""},
];

export default function DomainTable({
  rows,
  servers,
  registrars,
  cfAccounts,
  now,
  sort,
  onSort,
  selectedIds,
  onToggleRow,
  onToggleAll,
  focusDomainId,
  isProvisioning,
  onOpenDetail,
  onProvision,
  onDelete,
}: {
  /**
   * Уже отфильтрованные и отсортированные строки. Порядок принадлежит странице
   * (`useDomainSort`), потому что таблицу она подменяет целиком на ошибке
   * загрузки, ожидании и пустом списке, — стейт внутри таблицы этого не
   * переживает, и выбранная колонка молча возвращалась бы к умолчанию.
   */
  rows: DomainUI[];
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  now: number;
  sort: Sort;
  onSort: (k: SortKey) => void;
  selectedIds: Set<number>;
  onToggleRow: (id: number) => void;
  onToggleAll: () => void;
  focusDomainId: number | null;
  /**
   * Гейт provision — вопрос всей таблицы, а не строки: он читает `MutationCache`
   * и живёт на странице. Сюда приезжает предикатом, а строка получает уже
   * готовый ответ про себя.
   */
  isProvisioning: (id: number) => boolean;
  onOpenDetail: (id: number) => void;
  onProvision: (d: DomainUI) => void;
  onDelete: (d: DomainUI) => void;
}) {
  return <table style={{width:"100%",borderCollapse:"collapse"}}>
    <thead><tr><th style={{padding:"10px 16px",width:36,background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}><input type="checkbox" checked={selectedIds.size===rows.length&&rows.length>0} onChange={onToggleAll} style={{cursor:"pointer"}}/></th>
      {COLUMNS.map((c)=>c.key
        ? <SortableTh key={c.label} k={c.key} label={c.label} sort={sort} onSort={onSort}/>
        : <PlainTh key={c.label}>{c.label}</PlainTh>)}
    </tr></thead>
    <tbody>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={10} style={{ padding: "28px 16px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
            No domains match the current filters.
          </td>
        </tr>
      ) : null}
      {rows.map((d: DomainUI)=>(
        <DomainRow
          key={d.id}
          domain={d}
          server={servers.find((s: Server)=>s.id===d.server_id)}
          registrar={registrars.find((r: RegistrarAccount)=>r.id===d.registrar_id)}
          cfAccount={cfAccounts.find((c: CloudflareAccount)=>c.id===d.cf_id)}
          now={now}
          selected={selectedIds.has(d.id)}
          onToggleSelected={onToggleRow}
          focused={focusDomainId === d.id}
          isProvisioning={isProvisioning(d.id)}
          onOpenDetail={onOpenDetail}
          onProvision={onProvision}
          onDelete={onDelete}
        />
      ))}
    </tbody>
  </table>;
}
