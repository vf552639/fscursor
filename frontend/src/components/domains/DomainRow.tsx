import React from "react";

import { Badge, StatusDot, fmtDate, RowActions, DIM_TEXT, STALE_TEXT } from "../ui/Primitives";
import { formatAgoStale } from "../../lib/format";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { isCheckStale, serverUiStatus } from "../../lib/serverStatus";
import { CF_HINT_TITLE } from "../../lib/cfZoneMatch";
import { NO_VALUE, expiryState, expiryTextColor, expiryTextWeight, formatExpiry, formatExpiryDate } from "../../lib/domainExpiry";
import DomainStatusBadge from "./DomainStatusBadge";
import { DomainUI, RowCfHint } from "./types";

/**
 * Тон подсказки живого матча: темнее прочерка (`DIM_TEXT`, «данных нет»), но
 * светлее сохранённого имени аккаунта (`#111`, «так записано в базе»). Между
 * ними — потому что подсказка и есть третье состояние: данные есть, но они не
 * факт.
 */
const CF_HINT_TEXT = "#6b7280";

export interface DomainRowProps {
  domain: DomainUI;
  /** Сервер, регистратор и аккаунт CF строки — уже найденные: искать их на каждую из сотен строк заново незачем. */
  server?: Server;
  registrar?: RegistrarAccount;
  cfAccount?: CloudflareAccount;
  /**
   * Что про домен знает живой список зон Cloudflare, если в базе привязки нет.
   *
   * Приезжает готовой подсказкой из одной мемо-карты страницы
   * (`useDomainZoneMatches`), а не считается здесь: сопоставление — это индекс по
   * зонам всех аккаунтов, и на строку его класть нельзя ни по цене, ни по
   * ссылочной стабильности (см. `memo` ниже).
   */
  cfHint?: RowCfHint;
  /**
   * Одно «сейчас» на весь рендер таблицы — тот же приём, что на трёх остальных
   * экранах: свой `Date.now()` в каждой ячейке дал бы разные «сейчас» для
   * статуса сервера и для подписи его возраста в соседней строке.
   */
  now: number;
  selected: boolean;
  /**
   * Колбэки принимают строку (или её id), а не замыкаются на неё у вызывающего.
   *
   * Не стилистика: `DomainRow` мемоизирован, а замыкание, созданное на каждый
   * рендер таблицы, — новый пропс на каждый рендер, то есть мемоизации нет
   * вовсе. Так таблица передаёт одну и ту же функцию всем двумстам строкам.
   */
  onToggleSelected: (id: number) => void;
  /** Строка, на которую пришли по ссылке `?domainId=`: подсвечена и не гаснет от курсора. */
  focused: boolean;
  onOpenDetail: (id: number) => void;
  onDelete: (domain: DomainUI) => void;
}

/**
 * Строка списка доменов.
 *
 * `memo` здесь окупается тем, чего страница делает много: ввод в поиске,
 * выделение соседней строки, приход отчёта — каждое такое событие
 * перерисовывало все строки списка, а их бывает двести. Работает это ровно
 * пока пропсы стабильны: `now` идёт по таймеру, а не читается на каждый рендер,
 * и колбэки приезжают из `useCallback` страницы. Есть тест на число рендеров —
 * без него следующая правка снимет мемоизацию молча.
 */
function DomainRow({
  domain: d,
  server: srv,
  registrar: reg,
  cfAccount: cf,
  cfHint,
  now,
  selected,
  onToggleSelected,
  focused,
  onOpenDetail,
  onDelete,
}: DomainRowProps) {
  // Оба срока — через один модуль и через одно «сейчас» (`now` выше): своя
  // арифметика в ячейке разъехалась бы с соседней, причём молча.
  const expState = expiryState(d.expiry_date, now);
  const sslExpState = expiryState(d.ssl_expires_at, now);
  // Четвёртый экран, где рисуется состояние сервера, — и разбор здесь был свой,
  // до `last_check_*` не доходивший вовсе: колонку `status` монитор не трогает,
  // поэтому подтверждённо упавшая машина стояла в списке доменов зелёной точкой.
  // Лестница общая (`lib/serverStatus`), как на трёх остальных экранах.
  const srvStatus = srv ? serverUiStatus(srv, now) : "";
  const srvCheckStale = isCheckStale(srv?.last_check_at, now);
  // Подсказка — только там, где записанного аккаунта нет: сохранённый выбор
  // живой список зон перебивать не вправе. Неоднозначное совпадение сюда не
  // доходит намеренно — см. `RowCfHint`.
  const cfHintAccount = !cf && cfHint?.outcome === "matched" ? cfHint.account : null;
  return <tr style={focused ? { background: "#eff4ff" } : undefined} onMouseEnter={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!focused) e.currentTarget.style.background="#fafbfc"; }} onMouseLeave={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!focused) e.currentTarget.style.background=""; }}>
    <td style={{padding:"11px 16px"}}><input type="checkbox" checked={selected} onChange={()=>onToggleSelected(d.id)} style={{cursor:"pointer"}}/></td>
    <td style={{padding:"11px 16px"}}>
      <button onClick={()=>onOpenDetail(d.id)} style={{fontWeight:600,fontSize:13.5,color:"#111",background:"transparent",border:"none",padding:0,cursor:"pointer"}}>
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
    {/* Три состояния, и все три различимы глазом: записанный аккаунт — обычным
        текстом; аккаунт, о котором известно только из живого списка зон, —
        курсивом и приглушённо; прочерк — когда не известно ничего. Слив
        средний случай с прочерком, колонка сообщала бы «Cloudflare нет» о
        домене, чья зона заведена и работает; слив его с первым — обещала бы
        привязку, которой в базе нет и по которой нечего пушить регистратору.

        У подсказки вдобавок `title`: курсив говорит «это другое», но не
        говорит, что именно и что с этим делать. Текст приезжает оттуда же,
        откуда подпись обеих кнопок синхрона (`lib/cfZoneMatch`), — он зовёт
        нажать кнопку по имени, и разъехаться с ней ему негде. */}
    <td data-testid="cf-cell" style={{padding:"11px 16px",fontSize:13,color:cf?"#111":cfHintAccount?CF_HINT_TEXT:DIM_TEXT}}>
      {cf ? cf.name : cfHintAccount
        ? <span title={CF_HINT_TITLE} style={{fontStyle:"italic"}}>{cfHintAccount.name}</span>
        : "—"}
    </td>
    <td style={{padding:"11px 16px"}}>
      <DomainStatusBadge status={d.status} title={d.last_provision_error || undefined} />
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
      <div style={{color:expiryTextColor(expState),fontWeight:expiryTextWeight(expState)}}>
        {/* И дата, и подпись под ней — из одного модуля: дату без
            времени он печатает в UTC, а `toLocaleDateString` по
            месту показа сдвигал её на день западнее UTC. */}
        {expState === "unknown" ? NO_VALUE : formatExpiryDate(d.expiry_date)}
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
    {/* Действий два, и оба про саму строку: открыть карточку и удалить домен.
        Provision отсюда УЕХАЛ — иконка ⚙ и веб-ссылка `sdmp://provision` жили
        здесь и стали кнопкой на вкладке Server карточки домена
        (`DomainServerTab`). Причина не в тесноте: развёртывание отвечает на
        вопрос «что стоит на сервере», а на этот вопрос на всём продукте
        отвечает ровно одно место — карточка. В строке же оно было единственным
        входом в диалог с галочкой «создать БД», из-за чего опциональная БД
        зависела от того, не прибрался ли кто-нибудь в колонке действий. */}
    <td style={{padding:"11px 16px"}}>
      <RowActions
        actions={[
          { icon: "↗", title: "Open detail", onClick: () => onOpenDetail(d.id) },
          {
            icon: "✕",
            title: "Delete domain",
            variant: "danger" as const,
            onClick: () => onDelete(d),
          },
        ]}
      />
    </td>
  </tr>;
}

export default React.memo(DomainRow);
