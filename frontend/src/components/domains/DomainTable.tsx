import React from "react";

import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { tokens } from "../../lib/designTokens";
import DomainRow from "./DomainRow";
import { Sort, SortKey } from "./sortDomains";
import { DomainUI, RowCfHint } from "./types";

const TH_STYLE: React.CSSProperties = {padding:"10px 16px",textAlign:"left",fontSize:11,fontWeight:700,color:tokens.text.heading,textTransform:"uppercase",letterSpacing:".05em",background:tokens.surface.cardHeader,borderBottom:`1px solid ${tokens.border.card}`,whiteSpace:"nowrap"};

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
    <button type="button" onClick={()=>onSort(k)} aria-label={`Sort by ${label}`} style={{display:"inline-flex",alignItems:"center",gap:4,background:"none",border:"none",padding:0,cursor:"pointer",font:"inherit",color:active?tokens.text.ink:"inherit",letterSpacing:"inherit",textTransform:"inherit"}}>
      {label}
      <span aria-hidden="true" style={{color:active?tokens.text.ink:tokens.text.disabled}}>{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  </th>;
}

/** Колонка шапки: подпись и, если по ней есть порядок, ключ сортировки. */
interface Column {
  label: string;
  key?: SortKey;
}

/**
 * Колонка чекбокса в этот список не входит: у неё своя ширина и свой `th`.
 *
 * Server и Registrar своих колонок больше не имеют: оба уехали метками под имя
 * домена (`DomainRow`). Освободившееся место отдано самому имени — в списке на
 * двести строк ищут именно его, а домены четвёртого уровня в 14% ширины не
 * помещались вовсе.
 */
const COLUMNS: Column[] = [
  {label:"Domain",key:"domain"},
  {label:"Cloudflare"},
  {label:"Status",key:"status"},
  {label:"SSL",key:"ssl"},
  {label:"Expires",key:"expiry_date"},
  {label:"Added",key:"created"},
  {label:""},
];

/**
 * Ширины колонок — по порядку, включая чекбокс.
 *
 * Живут в `<colgroup>` вместе с `table-layout: fixed`, и только так: без
 * фиксированной раскладки браузер меряет содержимое и раздаёт ширину сам, то
 * есть длинное имя домена в одной строке двигает колонки во ВСЕХ остальных.
 * В списке, по которому ведут глазом сверху вниз, это дороже любой экономии
 * места: колонки обязаны стоять на месте.
 *
 * Проценты у двух текстовых колонок и пиксели у остальных — не небрежность:
 * дата, пилюля статуса и пара кнопок занимают ровно столько, сколько занимают,
 * и растягивать их вместе с окном незачем; тянуться должно то, что обрезается.
 */
const COL_WIDTHS = ["36px", "34%", "22%", "110px", "90px", "110px", "92px", "68px"];

/**
 * Число колонок — считается из того же массива, из которого они и рисуются.
 *
 * Написанное числом, оно уже разъезжалось: пустой результат фильтра стоял с
 * `colSpan={10}` при девяти колонках. Промах такого рода молчит — ячейка просто
 * растягивается за пределы таблицы, и увидеть это можно только глазами и только
 * когда фильтр действительно пуст.
 */
const COL_COUNT = COL_WIDTHS.length;

export default function DomainTable({
  rows,
  total,
  servers,
  registrars,
  cfAccounts,
  zoneHints,
  now,
  sort,
  onSort,
  selectedIds,
  onToggleRow,
  onToggleAll,
  focusDomainId,
  onOpenDetail,
  onDelete,
}: {
  /**
   * Уже отфильтрованные и отсортированные строки. Порядок принадлежит странице
   * (`useDomainSort`), потому что таблицу она подменяет целиком на ошибке
   * загрузки, ожидании и пустом списке, — стейт внутри таблицы этого не
   * переживает, и выбранная колонка молча возвращалась бы к умолчанию.
   */
  rows: DomainUI[];
  /**
   * Сколько доменов всего — до фильтра.
   *
   * Пропсом, а не длиной чего-нибудь под рукой: таблица видит только срез, и
   * «X of Y» без второго числа врал бы ровно в тот момент, когда он нужен, —
   * когда фильтр что-то спрятал.
   */
  total: number;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  /**
   * Подсказки живого матча по id домена (`useDomainZoneMatches`). Готовой картой,
   * а не списком зон: сопоставление — один прогон на всю таблицу, и его нельзя
   * ни повторять на строку, ни пересобирать на рендер (строки мемоизированы).
   */
  zoneHints: ReadonlyMap<number, RowCfHint>;
  now: number;
  sort: Sort;
  onSort: (k: SortKey) => void;
  selectedIds: Set<number>;
  onToggleRow: (id: number) => void;
  onToggleAll: () => void;
  focusDomainId: number | null;
  /**
   * Гейта provision здесь больше нет, и это не упрощение: сам запуск уехал на
   * карточку домена (вкладка Server), а предикат по `MutationCache` как жил на
   * странице, так и живёт — просто теперь он уезжает в `DomainDetailModal`, а
   * не через таблицу в каждую из двухсот строк.
   */
  onOpenDetail: (id: number) => void;
  onDelete: (d: DomainUI) => void;
}) {
  // Таблица осталась `<table>` и НЕ стала гридом из `div` — вопрос, который
  // будет вставать при каждом следующем взгляде на эти проценты и пиксели.
  // Ответ: `columnheader`, `aria-sort`, разбор строки по ячейкам и навигация
  // скринридера по таблице — работа уже сделанная (см. комментарий про потерю
  // фокуса выше), и грид обнуляет её целиком, требуя переписать ролями всё то,
  // чем `<table>` является по рождению. Геометрию макета `<colgroup>` даёт и
  // так.
  return <>
  <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
    {/* Ключ — индекс, а не сама ширина: «110px» стоит и у Status, и у Expires,
        и React ругался бы на дублирующийся ключ. Порядок здесь и есть
        тождество колонки, переставлять её без перестановки заголовка нельзя. */}
    <colgroup>{COL_WIDTHS.map((w,i)=><col key={i} style={{width:w}}/>)}</colgroup>
    <thead><tr><th style={TH_STYLE}><input type="checkbox" checked={selectedIds.size===rows.length&&rows.length>0} onChange={onToggleAll} style={{cursor:"pointer"}}/></th>
      {COLUMNS.map((c)=>c.key
        ? <SortableTh key={c.label} k={c.key} label={c.label} sort={sort} onSort={onSort}/>
        : <PlainTh key={c.label}>{c.label}</PlainTh>)}
    </tr></thead>
    <tbody>
      {/* Пустой результат фильтра живёт ВНУТРИ таблицы, а не подменяет её:
          шапка с выбранной колонкой и подвал со счётом — это и есть ответ «где
          я и почему пусто». Подменять их отдельным экраном значило бы отнять у
          человека и то, по чему он отфильтровал, и возможность отсортировать
          обратно. Экран `DomainsEmptyState` отвечает на ДРУГОЙ вопрос —
          «доменов нет вовсе», — и остаётся на своём месте, выше по странице. */}
      {rows.length === 0 ? (
        <tr>
          <td colSpan={COL_COUNT} style={{ padding: 36, textAlign: "center", color: tokens.text.faint, fontSize: 13 }}>
            No domains match the current filter
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
          cfHint={zoneHints.get(d.id)}
          now={now}
          selected={selectedIds.has(d.id)}
          onToggleSelected={onToggleRow}
          focused={focusDomainId === d.id}
          onOpenDetail={onOpenDetail}
          onDelete={onDelete}
        />
      ))}
    </tbody>
  </table>
  {/* Подвал отвечает на два вопроса разом, и оба задают молча.
      Слева — «всё ли я вижу»: список из двухсот доменов, показывающий
      двенадцать, обязан сказать, что остальные не пропали, а спрятаны
      фильтром. Справа — «кликабельна ли строка»: клик по строке ничем себя не
      обозначает (курсор виден, только когда мышь уже там), и подсказка тут
      дешевле, чем подчёркивание каждой строки.

      `<div>` под таблицей, а НЕ `<tfoot>` внутри неё, и это не вкусовщина:
      `<tfoot>` — такая же строка таблицы, как и любая другая, и он попадает в
      `getAllByRole("row")` вместе с доменами. Тесты, считающие строки списка и
      читающие их по порядку, начали бы считать подвал доменом; хуже того, они
      бы при этом ПРОХОДИЛИ, сдвинувшись на одну строку. Скринридеру то же
      самое: подвал звучал бы восьмиячеечной строкой таблицы.

      Живёт всё-таки здесь, а не на странице: «сколько показано» знает только
      таблица, а `total` ей и так нужен рядом с этим числом. */}
  <div style={{padding:"10px 16px",background:tokens.surface.card,borderTop:`1px solid ${tokens.border.card}`,fontSize:12,color:tokens.text.faint,display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
    <span>Showing {rows.length} of {total} domains</span>
    <span>Click a row to open domain settings</span>
  </div>
  </>;
}
