import React from "react";

import { Sel } from "../ui/Primitives";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { tokens } from "../../lib/designTokens";

/**
 * Значения фильтров и их обработчики. Отдельный тип, потому что панель ничего
 * не помнит: и значения, и обработчики приезжают из `useDomainFilters` — по тем
 * же значениям он фильтрует список и пишет `?status=` в адрес.
 *
 * `status`/`onStatusChange` остались в типе, хотя сама панель их больше не
 * рисует: срез по статусу переехал на чипы (`DomainStatChips`), а тип описывает
 * ВСЕ фильтры вкладки, а не содержимое одного ряда. Разводить его на два ради
 * этого не за чем — `useDomainFilters` отдаёт одну связку, и обе поверхности
 * берут из неё то, что рисуют.
 */
export interface DomainFilterControls {
  search: string;
  onSearchChange: (v: string) => void;
  serverId: string;
  onServerChange: (v: string) => void;
  registrarId: string;
  onRegistrarChange: (v: string) => void;
  cfId: string;
  onCfChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
}

/**
 * ПОЛНАЯ геометрия контрола ряда — одна на поле поиска и на три селекта.
 *
 * Через `style`, а не правкой самого `Sel`: примитив общий, его рисуют Servers,
 * Activity, Settings, и перекрасить его значило бы поменять вид на экранах,
 * которых эта задача не касалась.
 *
 * Полная — потому что неполная не работала. Константа задавала рамку, радиус и
 * кегль, а всё остальное селекты добирали умолчаниями `Sel`: `padding 8px 12px`
 * против `8px 14px` у поля, `box-sizing` не задан вовсе, шрифт системный,
 * `color: #111` мимо палитры. Ряд из четырёх контролов выходил разнокалиберным
 * — разной высоты и разного шрифта, — и причину было не назвать, потому что
 * ОБЩЕЙ она выглядела уже тогда. Одинаковая высота теперь получается по
 * построению: общий `padding` плюс `border-box`, а не подгонкой чисел.
 *
 * 14px, а не 13: ряд выровнен по центру (`alignItems`), так что контрол с
 * меньшим кеглем не «поехал бы» вниз — он оказался бы НИЖЕ РОСТОМ соседа, а два
 * контрола разной высоты в одной строке читаются как недоделанные, даже когда
 * причину не назвать словами.
 */
const CONTROL_STYLE: React.CSSProperties = {
  border: `1px solid ${tokens.border.control}`,
  borderRadius: tokens.radius.md,
  fontSize: 14,
  padding: "8px 14px",
  boxSizing: "border-box",
  fontFamily: "inherit",
  color: tokens.text.body,
  background: tokens.surface.base,
  outline: "none",
};

/**
 * Стрелка селекта — своя, инлайновой SVG в `data:`-URI.
 *
 * Нативная стрелка WebKit не поддаётся ни цвету, ни отбивке и выглядит гостем
 * из другой темы рядом с рамкой и шрифтом ряда; убрать её можно только
 * `appearance: none`, а это оставляет селект вовсе без указателя на то, что он
 * раскрывается. Поэтому вместе с `appearance` едет и замена.
 *
 * `data:`-URI, а не файл: CSP десктопа разрешает `img-src 'self' data:`
 * (`desktop/src-tauri/tauri.conf.json`), то есть картинка доезжает и офлайн, и
 * без отдельного запроса. Кавычки в SVG — одинарные: строка целиком уходит в
 * `url("…")`, и двойные внутри неё пришлось бы экранировать.
 *
 * Цвет прошит в разметку хексом (`text.muted`) — раскрасить SVG в `data:`-URI
 * из CSS нечем, `currentColor` внутрь него не проникает. Расходиться с палитрой
 * этот хекс не должен, и сторожит это тест.
 */
const ARROW_COLOR = tokens.text.muted;
const SELECT_ARROW =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E` +
  `%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='${encodeURIComponent(ARROW_COLOR)}' stroke-width='1.5' ` +
  `stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

/**
 * Селекты = общая геометрия + своя стрелка.
 *
 * Правый отступ больше левого ровно на место под стрелку: подпись, заезжающая
 * под неё, читается как обрезанная.
 */
const SELECT_STYLE: React.CSSProperties = {
  ...CONTROL_STYLE,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: SELECT_ARROW,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  paddingRight: 30,
};

/**
 * Панель фильтров списка доменов: поиск и три принадлежности — сервер,
 * регистратор, аккаунт Cloudflare.
 *
 * Без обёртки `<Card>`: по макету ряд стоит прямо на фоне страницы. Карточка
 * вокруг четырёх контролов заявляла бы отдельный предмет там, где его нет, —
 * это панель инструментов над таблицей, а не блок содержимого.
 *
 * Селекта «All Statuses» здесь больше нет. Статус — не принадлежность домена, а
 * его состояние, и спрашивают о нём чаще всего («покажи провалы»), поэтому срез
 * по нему уехал на чипы выше, где он виден и без раскрытия списка. Держать оба
 * способа задать один фильтр значило бы ждать, когда они разойдутся.
 *
 * Своего нижнего отступа компонент НЕ несёт, и это контракт, а не упущение:
 * расстояние до соседа держит колонка страницы (`gap` у контейнера в
 * `pages/Domains`). Вернуть сюда `marginBottom` — значит отдать блоку отступ,
 * который принадлежит промежутку: он останется висеть, когда блок окажется
 * последним или единственным на экране.
 */
export default function DomainFilters({
  search, onSearchChange,
  serverId, onServerChange, servers,
  registrarId, onRegistrarChange, registrars,
  cfId, onCfChange, cfAccounts,
}: DomainFilterControls & {
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
}) {
  return <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
    {/* Поле тянется, селекты — нет: длина имени домена непредсказуема, а
        подписи «All Servers» фиксированы. Глиф `⌕` внутри поля убран по
        макету — плейсхолдер и так говорит, что это поиск, а иконка съедала
        30px слева у самого длинного значения ряда. */}
    <input
      value={search}
      onChange={(e: React.ChangeEvent<HTMLInputElement>)=>onSearchChange(e.target.value)}
      placeholder="Search domains…"
      // `aria-label` при живом `placeholder`: плейсхолдер — подсказка, а не
      // подпись, он исчезает при первом же символе, и поле остаётся вовсе без
      // доступного имени ровно тогда, когда в нём есть что читать.
      aria-label="Search domains"
      // Своего здесь только растяжение: всё остальное — общая геометрия ряда.
      style={{...CONTROL_STYLE,flexGrow:1,minWidth:220}}
    />
    <Sel style={SELECT_STYLE} value={serverId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onServerChange(e.target.value)}><option value="">All Servers</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel>
    <Sel style={SELECT_STYLE} value={registrarId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onRegistrarChange(e.target.value)}><option value="">All Registrars</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel>
    <Sel style={SELECT_STYLE} value={cfId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onCfChange(e.target.value)}><option value="">All CF</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
  </div>;
}
