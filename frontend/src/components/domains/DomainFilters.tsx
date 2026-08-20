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
 * Общая геометрия контролов ряда в палитре макета — и селектов, и поля поиска.
 *
 * Через `style`, а не правкой самого `Sel`: примитив общий, его рисуют Servers,
 * Activity, Settings, и перекрасить его значило бы поменять вид на экранах,
 * которых эта задача не касалась.
 *
 * Одна константа на поле и на селекты, а не три одинаковых объявления рядом:
 * связанность у них настоящая — рамка, скругление и кегль обязаны совпасть,
 * иначе ряд рассыпается на разнокалиберные контролы. Прописанная прозой, такая
 * связь держится ровно до первой правки одного из четырёх.
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
  return <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:16}}>
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
      style={{...CONTROL_STYLE,flexGrow:1,minWidth:220,padding:"8px 14px",outline:"none",background:tokens.surface.base,boxSizing:"border-box",fontFamily:"inherit",color:tokens.text.body}}
    />
    <Sel style={CONTROL_STYLE} value={serverId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onServerChange(e.target.value)}><option value="">All Servers</option>{servers.map((s: Server)=><option key={s.id} value={s.id}>{s.name}</option>)}</Sel>
    <Sel style={CONTROL_STYLE} value={registrarId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onRegistrarChange(e.target.value)}><option value="">All Registrars</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel>
    <Sel style={CONTROL_STYLE} value={cfId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>onCfChange(e.target.value)}><option value="">All CF</option>{cfAccounts.map((c: CloudflareAccount)=><option key={c.id} value={c.id}>{c.name}</option>)}</Sel>
  </div>;
}
