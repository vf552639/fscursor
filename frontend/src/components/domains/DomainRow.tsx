import React from "react";

import { fmtDate, RowActions } from "../ui/Primitives";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { CF_HINT_TITLE } from "../../lib/cfZoneMatch";
import { SemanticTone, STATUS_PILL, tokens } from "../../lib/designTokens";
import { NO_VALUE, expiryState, expiryTextColor, expiryTextWeight, formatExpiry, formatExpiryDate } from "../../lib/domainExpiry";
import { SSL_BADGE, factsFreshness, sslState } from "../../lib/domainFacts";
import DomainStatusBadge from "./DomainStatusBadge";
import { DomainUI, RowCfHint } from "./types";

/** Отбивка ячейки — одна на строку: разъехавшись, они дают «лесенку» по вертикали. */
const CELL: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: `1px solid ${tokens.border.hairline}`,
};

/**
 * Геометрия пилюли строки — ОДНА на все пилюли строки.
 *
 * Заведена потому, что их тут две (метка происхождения и тег сертификата) и
 * обе рисовались своим набором чисел: одинаковые скругление и кегль стояли в
 * двух местах и разъехались бы на первой правке — ровно так же, как разъезжались
 * копии хексов до `designTokens`. Различия, которые ТЗ задало явно (отбивка и
 * насыщенность у тега сертификата), остаются переопределениями по месту: они
 * НАЗВАНЫ в макете, а не случились.
 *
 * `borderRadius` — `xs` (6), и это не тот же радиус, что у пилюли статуса
 * (`DomainStatusBadge`, `radius.pill` = 99). Расхождение намеренное и описано
 * там же: пилюля статуса — единственная капля в строке, и форма её отличает.
 */
const ROW_PILL: React.CSSProperties = {
  display: "inline-block",
  borderRadius: tokens.radius.xs,
  fontSize: 11,
  whiteSpace: "nowrap",
};

/**
 * Мелкая метка под именем домена: сервер и регистратор.
 *
 * Общая форма у обоих намеренно — различает их только заливка. Это не два
 * разных элемента, а один и тот же ответ на вопрос «где эта строка живёт», и
 * разная геометрия читалась бы как разная важность.
 *
 * Тип тона — `SemanticTone` из палитры, а не тройка полей, объявленная здесь
 * инлайном: обе метки этот тон и получают оттуда (`semantic.server`,
 * `semantic.registrar`), а своя копия формы молча разъехалась бы с исходной в
 * день, когда в тон добавят четвёртое поле.
 *
 * `cursor: help` вместе с `title` — потому что метка показывает ТОЛЬКО значение
 * («web-01», «hostiq»), без подписи, чем оно является. Значение без подписи
 * экономит место в строке, которой и так тесно, но требует, чтобы подпись была
 * достижима: курсор со знаком вопроса — единственное, что об этом сообщает.
 */
function RowBadge({ tone, title, children }: { tone: SemanticTone; title: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      style={{
        ...ROW_PILL,
        padding: "1px 7px",
        color: tone.text,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        cursor: "help",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </span>
  );
}

/*
 * Своей палитры у тега сертификата больше нет — и своей карты тоже.
 *
 * Здесь стояла `SSL_PILL` на два состояния («есть и живой» — зелёная пилюля,
 * «нет» — нейтральная) с одним названным расхождением: текст «No SSL» красился
 * `text.faint`, чтобы в списке на двести строк тег был тише зелёного соседа.
 * Ушло вместе с двумя состояниями: колонка называет теперь ШЕСТЬ
 * (`SSL_BADGE`), цвет каждому назначен там же, где подпись, и брать его надо
 * оттуда — иначе карта и ячейка разошлись бы ровно так же, как расходились
 * карточка и строка. Долг №1 плана редизайна («расхождение с картой у No SSL»)
 * закрылся вместе с предметом.
 *
 * Рамка при этом остаётся обязательной и по прежней причине: нейтральная
 * заливка (`surface.page`) совпадает с разлиновкой строк, и без рамки пилюля не
 * имеет краёв по построению — читается пятном, а не тегом.
 */

/**
 * Событие, дальше которого клик по строке не идёт.
 *
 * Нужно ровно двум ячейкам — чекбоксу и действиям, — и не для красоты: строка
 * целиком открывает карточку, поэтому без гашения снятие галочки и нажатие «✕»
 * открывали бы карточку заодно. У «✕» это особенно скверно: подтверждение
 * удаления вставало бы поверх только что открытой карточки того же домена.
 *
 * Объявлена на уровне модуля, а не стрелкой в JSX: строка мемоизирована
 * (`React.memo` внизу), и новая функция на каждый рендер обнуляла бы это ровно
 * так же, как обнуляли бы замыкания в колбэках (см. `DomainRowProps`).
 */
const stop = (e: React.MouseEvent) => e.stopPropagation();

/**
 * Тон подсказки живого матча: темнее прочерка («данных нет»), но светлее
 * сохранённого имени аккаунта («так записано в базе»). Между ними — потому что
 * подсказка и есть третье состояние: данные есть, но они не факт.
 */
const CF_HINT_TEXT = tokens.text.muted;

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
   * двух сроков в соседних строках.
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
 *
 * **Почему имя домена — `<button>`, хотя кликабельна вся строка.** Обещание
 * макета — «клик по строке открывает карточку», и оно выполнено (`onClick` на
 * `<tr>`). Но `<tr onClick>` недостижим с клавиатуры вовсе: у строки таблицы
 * нет ни фокуса, ни роли кнопки, и Tab по ней не идёт. Городить
 * `tabIndex`/`role`/`onKeyDown` на строку — значит вручную писать то, чем
 * кнопка является по рождению, и заодно пустить скринридер по строке как по
 * кнопке, потеряв разбор по ячейкам. Кнопка внутри решает обе задачи разом:
 * мышью работает вся строка, клавиатурой — имя домена.
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
  // Срок — через модуль и через одно «сейчас» (`now` выше): своя арифметика в
  // ячейке разъехалась бы с карточкой домена, причём молча.
  const expState = expiryState(d.expiry_date, now);
  // Подсказка — только там, где записанного аккаунта нет: сохранённый выбор
  // живой список зон перебивать не вправе. Неоднозначное совпадение сюда не
  // доходит намеренно — см. `RowCfHint`.
  const cfHintAccount = !cf && cfHint?.outcome === "matched" ? cfHint.account : null;
  // Состояние сертификата — ТА ЖЕ функция, что считает его карточка домена, и
  // тот же снимок. Своё правило здесь означало бы, что список и карточка
  // отвечают про один домен по-разному, — а это ровно тот дефект, который
  // фаза 1 и чинит.
  const ssl = sslState(d.ssl, d.facts_at, now);
  const sslBadge = SSL_BADGE[ssl];
  const sslTone = STATUS_PILL[sslBadge.variant];
  return <tr
    onClick={() => onOpenDetail(d.id)}
    style={{ cursor: "pointer", ...(focused ? { background: tokens.surface.rowFocus } : null) }}
    onMouseEnter={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!focused) e.currentTarget.style.background=tokens.surface.subtle; }}
    onMouseLeave={(e: React.MouseEvent<HTMLTableRowElement>)=>{ if (!focused) e.currentTarget.style.background=""; }}
  >
    <td style={CELL} onClick={stop}><input type="checkbox" checked={selected} onChange={()=>onToggleSelected(d.id)} style={{cursor:"pointer"}}/></td>
    <td style={CELL}>
      {/* Эллипсис на кнопке, а не на ячейке: обрезать надо ИМЯ, а колонка
          фиксированной ширины (`table-layout: fixed` у таблицы), и длинный
          домен без обрезки распёр бы соседние колонки. */}
      <button
        // Гасим всплытие, хотя строка ведёт РОВНО туда же: без этого клик по
        // имени звал бы `onOpenDetail` дважды — с кнопки и со строки. Сегодня
        // это безобидно (открытие идемпотентно), но колбэк принадлежит
        // странице, и однажды он начнёт что-нибудь считать.
        onClick={(e)=>{ e.stopPropagation(); onOpenDetail(d.id); }}
        title={d.domain}
        style={{display:"block",maxWidth:"100%",textAlign:"left",fontFamily:"inherit",fontWeight:600,fontSize:14,color:tokens.text.ink,background:"transparent",border:"none",padding:0,cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
      >
        {d.domain}
      </button>
      {/* Ряд меток под именем. Точки состояния сервера и подписи
          «checked … ago» здесь больше НЕТ, и принципу №6 (`CLAUDE.md`) это не
          противоречит: метка не утверждает здоровья вовсе — она называет
          машину, на которой домен живёт. Лестница `lib/serverStatus`
          продолжает отвечать за здоровье там, где про него и спрашивают: на
          Servers, ServerDetail и Dashboard. */}
      {(srv || reg?.provider) ? (
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:4,maxWidth:"100%"}}>
          {srv ? <RowBadge tone={tokens.semantic.server} title="Server this domain is hosted on">{srv.name}</RowBadge> : null}
          {reg?.provider ? (
            <RowBadge tone={tokens.semantic.registrar} title="Domain provider (registrar) this domain was purchased from">{reg.provider}</RowBadge>
          ) : null}
        </div>
      ) : null}
    </td>
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
    <td data-testid="cf-cell" style={{...CELL,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:cf?tokens.text.body:cfHintAccount?CF_HINT_TEXT:tokens.text.disabled}}>
      {cf ? cf.name : cfHintAccount
        ? <span title={CF_HINT_TITLE} style={{fontStyle:"italic"}}>{cfHintAccount.name}</span>
        : NO_VALUE}
    </td>
    <td style={CELL}>
      <DomainStatusBadge status={d.status} title={d.last_provision_error || undefined} />
      {/*
        Текст ошибки — строкой, а не только тултипом пилюли: тултип
        невидим, пока в него не попали мышью, а искать провалившийся
        домен глазами по списку в двести строк надо без наведения.
        Полный текст остаётся в `title` и в карточке домена.
      */}
      {d.last_provision_error ? (
        <div
          data-testid="provision-error"
          title={d.last_provision_error}
          style={{marginTop:4,fontSize:11,color:tokens.semantic.danger.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
        >
          {d.last_provision_error}
        </div>
      ) : null}
    </td>
    {/* Тег сертификата — состояние с СЕРВЕРА, всеми шестью словами лестницы, а
        не «есть/нет». Двух состояний было мало не по бедности показа: под «No
        SSL» стоял `ssl_status` — наша запись момента provision, — и у домена,
        настроенного мимо SDMP, она пуста навсегда. Список говорил «сертификата
        нет» там, где карточка того же домена показывала «Valid».

        «Не проверяли» теперь отдельное слово (`Not checked`), а не молчаливое
        «нет»: незнание нельзя рисовать ни здоровьем, ни его отсутствием
        (принцип №6 CLAUDE.md).

        Подсказка называет ВОЗРАСТ снимка — то единственное, чего в самой
        пилюле нет и без чего «Valid» недельной давности читается как сегодняшний.
        Точный `ssl_status` из неё ушёл: он про другой предмет, и место его
        разбора — карточка (`DomainOverviewTab`, строка «SSL at provision»).

        Подстрочника со сроком сертификата тут по-прежнему нет: сроков в строке
        было два, и рядом они спорили — колонка «Expires» про домен, а подпись
        под тегом про сертификат, и читались они как один. */}
    <td data-testid="ssl-cell" style={CELL}>
      <span
        title={`SSL: ${sslBadge.label} · ${factsFreshness(d.facts_at, now)}`}
        style={{
          ...ROW_PILL,
          padding:"2px 8px",
          fontWeight:600,
          color: sslTone.color,
          background: sslTone.bg,
          border: `1px solid ${sslTone.border}`,
        }}
      >
        {sslBadge.label}
      </span>
    </td>
    {/* Срок домена. Дата и подпись «сколько осталось» стоят вместе:
        одна дата требует считать в уме (а тут сотня строк), одна
        подпись — лишает возможности сверить с письмом регистратора.
        Незнание — прочерк и БЕЗ подписи: «—» под «—» ничего не
        добавляет.

        Обе строки крашены ОДНИМ вызовом `expiryTextColor`, а не подпись
        бледным по макету: тревожная фраза («expired 3 days ago») живёт именно в
        подписи, и обесцветить её значило бы оставить сигнал одной дате. */}
    <td data-testid="expiry-cell" style={CELL}>
      <div style={{fontSize:13,color:expiryTextColor(expState),fontWeight:expiryTextWeight(expState)}}>
        {/* И дата, и подпись под ней — из одного модуля: дату без
            времени он печатает в UTC, а `toLocaleDateString` по
            месту показа сдвигал её на день западнее UTC. */}
        {expState === "unknown" ? NO_VALUE : formatExpiryDate(d.expiry_date)}
      </div>
      {expState !== "unknown" ? (
        <div style={{fontSize:11,color:expiryTextColor(expState)}}>{formatExpiry(d.expiry_date, now)}</div>
      ) : null}
    </td>
    <td style={{...CELL,fontSize:12,color:tokens.text.faint}}>{fmtDate(d.created)}</td>
    {/* Действий два, и оба про саму строку: открыть карточку и удалить домен.
        Provision отсюда УЕХАЛ — иконка ⚙ и веб-ссылка `sdmp://provision` жили
        здесь и стали кнопкой на вкладке Server карточки домена
        (`DomainServerTab`). Причина не в тесноте: развёртывание отвечает на
        вопрос «что стоит на сервере», а на этот вопрос на всём продукте
        отвечает ровно одно место — карточка.

        Глиф ⚙ теперь означает «настройки домена», а не «развернуть»: ведёт он в
        ту же карточку, куда ведёт и клик по строке. Дубль намеренный —
        кликабельность строки ничем себя не показывает, а видимая кнопка
        показывает. */}
    <td style={CELL} onClick={stop}>
      <RowActions
        tone="inverted"
        actions={[
          { icon: "⚙", title: "Open domain settings", onClick: () => onOpenDetail(d.id) },
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
