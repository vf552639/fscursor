import React, { useState } from "react";
import { tokens } from "../../lib/designTokens";

export const copyText = (v: string) => navigator.clipboard?.writeText(v).catch(()=>{});

/**
 * Цвет полосы по доле заполнения: 80% и выше — красный, с 60% — жёлтый.
 * Про CPU функция не знает ничего, и называлась она так зря: под именем
 * `cpuColor` ею красили полосу диска, то есть чужой величиной.
 */
export const pctColor = (v: number) => v>=80?"#dc2626":v>=60?"#d97706":"#2563eb";

/*
 * Здесь жили `genBars` и `MiniChart` — спарклайн из ПЯТНАДЦАТИ случайных
 * столбиков вокруг одного текущего значения. Мы храним последний снимок, а не
 * историю: наблюдение у нас ровно одно, и форма графика заявляла недавние
 * колебания, которых никто не измерял, — у протухшего снимка ещё и
 * «заканчивающиеся сейчас». Тот же дефект, что зелёный бейдж без проверки,
 * только в самой наглядной форме, поэтому удалено, а не приглушено. Настоящий
 * график потребует хранить историю метрик — это отдельная функция.
 */

/** Приглушённый текст: прочерки, подписи «данных нет». */
export const DIM_TEXT = "#9ca3af";

/**
 * Протухшее показание — и сама цифра, и подпись её возраста. Отдельный цвет, а
 * не `DIM_TEXT`: серым нарисованы прочерки, то есть «данных нет», а это «данные
 * есть, но старые» — разные вещи, и различать их одной лишь подписью значит
 * требовать её прочитать.
 *
 * Цвет — приглушённый тёплый серый, но темнее `DIM_TEXT` (`#8a8580` против
 * `#9ca3af`, ~3.6:1 против ~2.5:1 на белом): между ними ~1.4:1 — заметная
 * ступень по светлоте, так что «старое» и «данных нет» не сливаются в один
 * оттенок. AA для мелкого текста этот цвет всё равно не держит, поэтому цвет
 * здесь не единственный канал распознавания: подпись «· stale» рядом — не
 * украшение, а второй, дублирующий.
 */
export const STALE_TEXT = "#8a8580";

/**
 * Точка состояния сервера. Значения приезжают только из `serverUiStatus`
 * (`lib/serverStatus`), поэтому и ключей здесь ровно два.
 *
 * Их было восемь: `healthy`/`warning`/`critical`/`ok`/`pending`/`paused` не
 * производил НИКТО — кроме одной непочиненной лестницы в списке доменов,
 * которая переводила `status === "active"` в `healthy`, минуя результат
 * проверки. Именно живучесть этих ключей и позволяла зелёной точке спокойно
 * стоять у подтверждённо упавшей машины: удали их раньше — и код бы упал в
 * серый цвет, то есть заявил бы «не знаю» вместо «здоров».
 *
 * Всё незнакомое — серое: это «не знаем», и гадать в сторону здоровья нельзя.
 */
export function StatusDot({status, size=9}: {status: string, size?: number}){
  const c: Record<string, string>={active:"#16a34a",error:"#dc2626"};
  // Ореол достаётся тем же двум: он усиливает утверждение, а усиливать здесь
  // можно только то, что проверено.
  const g: Record<string, string>={active:"#bbf7d0",error:"#fecaca"};
  const bg = c[status] || "#9ca3af";
  const shadow = g[status] ? `0 0 0 3px ${g[status]}` : "none";
  return <span style={{display:"inline-block",width:size,height:size,borderRadius:"50%",background:bg,boxShadow:shadow,flexShrink:0}}/>;
}

export function Badge({children, variant="gray", style}: {children: React.ReactNode, variant?: string, style?: React.CSSProperties}){
  const m: Record<string, {bg: string, c: string}>={
    gray:{bg:"#f3f4f6",c:"#374151"},
    blue:{bg:"#eff4ff",c:"#2563eb"},
    green:{bg:"#f0fdf4",c:"#16a34a"},
    yellow:{bg:"#fffbeb",c:"#d97706"},
    red:{bg:"#fef2f2",c:"#dc2626"},
    purple:{bg:"#faf5ff",c:"#7c3aed"}
  };
  const s=m[variant]||m.gray;
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:600,letterSpacing:"0.3px",background:s.bg,color:s.c,...style}}>{children}</span>;
}

export function ErrorState({
  title = "Unable to load data",
  message,
  hint,
  style,
}: {
  title?: string;
  message: string;
  hint?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 12,
        padding: "18px 20px",
        marginBottom: 16,
        ...style,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: "#991b1b", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#b91c1c", marginBottom: hint ? 8 : 0, lineHeight: 1.45 }}>{message}</div>
      {hint ? (
        <div style={{ fontSize: 12, color: "#7f1d1d", fontFamily: "ui-monospace, monospace", wordBreak: "break-word" }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
  style,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "40px 24px",
        textAlign: "center",
        color: "#6b7280",
        ...style,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: "#111827", marginBottom: description ? 8 : 16 }}>{title}</div>
      {description ? (
        <div
          style={{
            fontSize: 13,
            color: "#6b7280",
            marginBottom: 20,
            maxWidth: 440,
            marginLeft: "auto",
            marginRight: "auto",
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Card({children, style}: {children: React.ReactNode, style?: React.CSSProperties}){
  return <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,...style}}>{children}</div>;
}
// `onClick` — не украшение: шапка раскладывает содержимое `space-between`, и
// пустое место между левым блоком и кнопками принадлежит ЕЙ. Мишенью «клик по
// пустому месту шапки» может быть только сам этот div.
export function CHd({children, style, onClick}: {children: React.ReactNode, style?: React.CSSProperties, onClick?: React.MouseEventHandler<HTMLDivElement>}){
  return <div style={{padding:"15px 20px",borderBottom:"1px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between",...style}} onClick={onClick}>{children}</div>;
}
export function CTi({children}: {children: React.ReactNode}){
  return <div style={{fontSize:14,fontWeight:600,color:"#111",display:"flex",alignItems:"center",gap:8}}>{children}</div>;
}
export function CBo({children, style}: {children: React.ReactNode, style?: React.CSSProperties}){
  return <div style={{padding:20,...style}}>{children}</div>;
}

/**
 * Карточка секции по макету карточки домена: рамка `#dbe3ee`, серая шапка-полоска
 * с uppercase-титулом и правым слотом, тело `16px 18px`.
 *
 * Стоит РЯДОМ с `Card`/`CHd`/`CTi`/`CBo`, а не вместо них, и это осознанно.
 * Геометрия у макета другая (цвет рамки, фон тела, крашеная шапка-полоска ниже
 * прежней, титул мельче, но жирнее и в верхнем регистре, тело плотнее — 16×18
 * против 20), а старый набор разобран десятками мест по всем страницам продукта —
 * переписав его, мы бы поменяли вид всех экранов ради одной модалки, и разбор
 * такого изменения стоил бы больше, чем сама функция. Когда на новый паттерн
 * переедут остальные экраны, лишним окажется старый набор, а не этот.
 *
 * Собран одним компонентом, а не тройкой «шапка/титул/тело» по образцу `Card`:
 * у макета все секции одинаковы до пикселя, и разбирать их на части значило бы
 * разрешить собрать их по-разному.
 */
export function SectionCard({title, right, children}: {
  title: React.ReactNode;
  /** Правый край шапки: пилюля состояния или мета-подпись вроде «Checked 4h ago». */
  right?: React.ReactNode;
  children: React.ReactNode;
  /*
   * Слотов `style`/`bodyStyle` здесь нет, и это то же решение, что у
   * `tabs/TabLayout` и `ui/Tabs`: проп без потребителя — приглашение развести
   * одинаковые карточки по-разному. Оба дожили до одиннадцати мест вызова, не
   * понадобившись ни одному; вернуть их стоит одной строки в тот день, когда
   * появится карточка, которой правда нужен свой отступ.
   */
}){
  /**
   * Карточка — ИМЕНОВАННАЯ группа, и это не украшение разметки.
   *
   * Глазами границу карточки задают рамка и крашеная шапка-полоска; для
   * скринридера же ряд из трёх таких карточек — сплошная лента из трёх селектов
   * и пяти подписей, по которой нельзя ни перескочить карточку целиком, ни
   * понять, к какой из них относится строка-диагноз под селектом. Ровно это
   * говорила плашка ряда связей, которую `SectionCard` здесь заменил
   * (`DomainLinks`), и терять её `role="group"` при переезде было нельзя.
   *
   * Имя берётся из собственного титула (`aria-labelledby`), а не дублируется
   * пропом: два места, где карточку называют, разошлись бы ровно тогда, когда
   * титул поправят, а про второе забудут. `useId` — потому что таких карточек на
   * экране больше десятка, а статический id связал бы их все с первым титулом.
   *
   * ОГОВОРКА, чтобы её не открывали заново как дефект: титул набран
   * `text-transform: uppercase`, а браузеры применяют его при вычислении
   * доступного имени — то есть вслух карточка называется «REGISTRAR», хотя в
   * разметке стоит «Registrar». Тесты, спрашивающие `getByRole("group", { name:
   * "Registrar" })`, проходят потому, что jsdom `text-transform` не применяет;
   * читать их как доказательство озвучки нельзя. Регистр — решение макета и
   * остаётся как есть: имя различает карточки одинаково хорошо в любом регистре.
   */
  const titleId = React.useId();
  return <div role="group" aria-labelledby={titleId} style={{
    border:`1px solid ${tokens.border.card}`,
    borderRadius:tokens.radius.lg,
    background:tokens.surface.card,
    // Шапка красится фоном до самого края, а край скруглён — без `hidden` её
    // прямые углы вылезают поверх скругления рамки.
    overflow:"hidden",
    // Карточки встанут в грид-ряды (`1fr 1fr`, `1fr 1fr 1fr`), а грид-элемент по
    // умолчанию не сжимается уже своего содержимого: одна длинная строка без
    // пробелов — путь до лога, IPv6-адрес — распирала бы колонку, а с ней и
    // модалку. Та же дисциплина ждёт и сами гриды — `minmax(0,1fr)` вместо
    // голого `1fr`.
    minWidth:0,
  }}>
    <div style={{background:tokens.surface.cardHeader,borderBottom:`1px solid ${tokens.border.card}`,padding:"10px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
      {/* Заголовок, а не просто жирный текст: секций на вкладках карточки
          набирается больше десятка, и по `h3` скринридер даёт по ним навигацию,
          которой у `div` нет. `margin:0` обязателен — браузерный отступ `h3`
          иначе распирает шапку-полоску, ломая её высоту 10px 18px. */}
      <h3 id={titleId} style={{margin:0,fontSize:13,fontWeight:700,color:tokens.text.heading,letterSpacing:"0.06em",textTransform:"uppercase"}}>{title}</h3>
      {right}
    </div>
    <div style={{padding:"16px 18px"}}>{children}</div>
  </div>;
}

// `title` — потому что подпись кнопки коротка по построению (она стоит в ряду
// таких же), а сказать иногда надо ещё и границы действия: что именно оно
// делает и чего НЕ делает. Без него такое объяснение уезжает в обёртку-`span`
// мимо общих стилей либо не появляется вовсе.
export function Btn({children, variant="secondary", size="md", onClick, style, disabled, title}: any){
  const sz: any={sm:{fontSize:12,padding:"6px 11px"},md:{fontSize:13,padding:"8px 15px"},lg:{fontSize:14,padding:"10px 20px"}};
  const va: any={
    primary:{background:"#2563eb",color:"#fff",border:"none"},
    secondary:{background:"#fff",color:"#374151",border:"1px solid #e5e7eb"},
    danger:{background:"#fef2f2",color:"#dc2626",border:"1px solid #fecaca"},
    ghost:{background:"transparent",color:"#6b7280",border:"none"}
  };
  return <button onClick={onClick} disabled={disabled} title={title}
    // Семейство шрифта не назначается — его даёт `index.css`, см. канон там.
    style={{display:"inline-flex",alignItems:"center",gap:6,borderRadius:tokens.radius.sm,fontWeight:500,cursor:disabled?"not-allowed":"pointer",transition:"all 0.15s",opacity:disabled?0.5:1,...sz[size],...va[variant],...style}}
    onMouseEnter={e=>{if(!disabled)e.currentTarget.style.filter="brightness(0.93)";}}
    onMouseLeave={e=>{e.currentTarget.style.filter="none";}}
  >{children}</button>;
}

// `...rest` — чтобы поле могло получить то, что знает только место вызова:
// `list` для `<datalist>` подсказок, `aria-label` там, где подписи рядом нет.
// Без него такие поля приходилось бы писать сырым `<input>` мимо общих стилей.
export function Inp({value, onChange, placeholder, type="text", style, ...rest}: any){
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} {...rest}
    style={{width:"100%",padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,color:"#111",background:"#f9fafb",outline:"none",boxSizing:"border-box",...style}}
    onFocus={e=>{e.currentTarget.style.borderColor="#2563eb";e.currentTarget.style.background="#fff";}}
    onBlur={e=>{e.currentTarget.style.borderColor="#e5e7eb";e.currentTarget.style.background="#f9fafb";}}/>;
}

export function Sel({value, onChange, children, style, ...rest}: any){
  return <select value={value} onChange={onChange} {...rest}
    style={{padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,color:"#111",background:"#fff",outline:"none",cursor:"pointer",...style}}>
    {children}
  </select>;
}

type ModalProps = {
  /** Штатная строка шапки. Не нужен там, где шапку целиком рисует `header`. */
  title?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  width?: number;
  closeOnBackdrop?: boolean;
  /**
   * Своя шапка вместо штатной строки «title + ✕» — целиком, вместе с закрытием.
   *
   * Заведено под карточку домена: её шапка по макету — три строки (ярлык с
   * пилюлей состояния, имя домена 24/700, мета-ряд с редактируемым сроком) и
   * своя квадратная кнопка закрытия. Передать это через `title` нельзя: текст
   * там завёрнут в 18/700, а штатный «✕» встал бы вторым крестиком рядом с
   * макетным. Поэтому слот заменяет строку ПОЛНОСТЬЮ, и вызывающий обязан сам
   * позвать `onClose` — иначе модалку нечем будет закрыть, кроме подложки.
   *
   * Дефолт не меняется: без `header` разметка ровно прежняя, и остальные три
   * десятка вызовов ничего об этом пропе не знают.
   */
  header?: React.ReactNode;
};

// `closeOnBackdrop={false}` — для модалок, чей `onClose` УНИЧТОЖАЕТ единственную
// копию показанного (пароли FTP/БД/панели). Промах мимо кнопки Done не должен
// стоить пароля к уже созданному аккаунту, а в очереди из двадцати модалок,
// которые ещё и разной высоты, такой промах — вопрос времени.
export function Modal({title, onClose, children, width=480, closeOnBackdrop=true, header}: ModalProps){
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={e=>{if(closeOnBackdrop&&e.target===e.currentTarget)onClose();}}>
    <div style={{background:"#fff",borderRadius:14,width,maxWidth:"95vw",boxShadow:"0 20px 60px rgba(0,0,0,0.18)",padding:28,position:"relative",maxHeight:"90vh",overflowY:"auto"}}>
      {/* `||`, а не `??`: `header={cond && <Header/>}` при ложном `cond` — это
          `false`, и на `??` он заменил бы штатную строку ПУСТОТОЙ, то есть
          модалка осталась бы без крестика, а с `closeOnBackdrop={false}` —
          вовсе без выхода. Ни один ложный `ReactNode` шапкой быть не может,
          так что `||` не теряет ни одного осмысленного случая. */}
      {header || (
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:700,color:"#111"}}>{title}</div>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"#9ca3af",lineHeight:1}}>✕</button>
        </div>
      )}
      {children}
    </div>
  </div>;
}

// `chartData` у карточки больше нет: рисовать ряд наблюдений, которого не
// существует, — см. комментарий на месте `MiniChart` выше. Полоса `pct`
// осталась: это ЕДИНСТВЕННОЕ измеренное значение, показанное как есть.
export function StatCard({label, value, sub, pct, color="#2563eb"}: any){
  return <Card>
    <div style={{padding:"18px 20px"}}>
      <div style={{fontSize:12,fontWeight:500,color:"#6b7280",marginBottom:6}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,color:"#111",lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:12,color:"#6b7280",marginTop:4}}>{sub}</div>}
      {pct!==undefined&&<div style={{height:4,background:"#f3f4f6",borderRadius:2,marginTop:8,overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:color,width:`${Math.min(100,pct)}%`,transition:"width 0.6s"}}/></div>}
    </div>
  </Card>;
}

/**
 * `k`/`v` остаются `any` — стиль файла, здесь их не ужесточаем нарочно.
 * `onEdit`/`editLabel` типизированы честно отдельным полем: `any & {...}` в TS
 * схлопывается обратно в `any` и защиты не даёт, поэтому сигнатура развёрнута
 * явно.
 */
type InfoRowProps = {
  k: any;
  v: any;
  /** Есть проп — есть карандаш; нет — разметка и поведение ровно прежние. */
  onEdit?: () => void;
  /**
   * Доступное имя карандаша, если само значение `k` неудачно для чтения вслух
   * — например, аббревиатура «OS» скринридер произнесёт по буквам, а не как
   * «operating system». Необязателен: по умолчанию имя строится из `k`.
   *
   * Так им и пользуется единственный сегодняшний потребитель — карточка Server
   * Information (`pages/ServerDetail.tsx`): строки «OS» и «IP» передают
   * «operating system» и «IP address», а «Name» и «Provider» обходятся своей
   * подписью.
   */
  editLabel?: string;
};

export function InfoRow({k, v, onEdit, editLabel}: InfoRowProps){
  // Источник доступного имени: явный `editLabel`, иначе подпись строки. Тип
  // `k` здесь `any` (стиль файла) — сегодняшний единственный потребитель
  // всегда передаёт строку, но раз тип это не гарантирует, подстраховка на
  // случай JSX остаётся: подставлять его в title/aria-label нельзя, поэтому
  // без строкового `k` и без `editLabel` карандаш падает на нейтральное «Edit».
  const label = editLabel ?? (typeof k === "string" ? k : undefined);
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid #f3f4f6"}}>
    <div style={{fontSize:12.5,color:"#6b7280",fontWeight:500}}>{k}</div>
    <div style={{fontSize:13,fontWeight:600,color:"#111",display:"flex",alignItems:"center",gap:6}}>
      {v}
      {onEdit && (
        // Тот же `RowActions`, что и у карандаша в шапке страницы: голый «✎»
        // без имени не читается ни скринридером, ни курсором, а `RowActions` —
        // единственный примитив, который сам проставляет `title`/`aria-label`.
        <RowActions actions={[{icon: "✎", title: label ? `Edit ${label}` : "Edit", onClick: onEdit}]}/>
      )}
    </div>
  </div>;
}

export function ActionIcons({icons=["✎","✕"]}: any){
  return <div style={{display:"flex",gap:5}} data-stub="true">
    {icons.map((ic: string,i: number)=><div key={i} style={{width:28,height:28,border:"1px solid #e5e7eb",borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,color:"#6b7280",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background="#eff4ff";e.currentTarget.style.color="#2563eb";}} onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color="#6b7280";}}>{ic}</div>)}
  </div>;
}

type RowAction = {
  icon: string;
  title: string;
  onClick?: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
};

/**
 * Тон ховера иконочных кнопок строки.
 *
 * Заведён редизайном вкладки Domains и НЕ обязателен намеренно: `RowActions`
 * рисуют Servers, ServerDetail, Cloudflare и шапки полудюжины карточек, и
 * перекрасить его всем сразу значило бы протащить редизайн одной вкладки на
 * всё приложение — правку вида в местах, которых никто не смотрел. Умолчание
 * `"blue"` — ровно сегодняшний вид, до последнего хекса.
 *
 * Различаются только цвета ХОВЕРА. Геометрия (28×28, радиус 6, рамка, шрифт) и
 * покой у обоих тонов общие: кнопка обязана оставаться той же кнопкой, иначе
 * два экрана рядом читаются как два разных продукта — а это ровно та беда, из-за
 * которой редизайн и затевался.
 */
export type RowActionsTone = "blue" | "slate";

/** Цвета ховера по тону: заливка, глиф и рамка — отдельно для обычного и опасного. */
const ROW_ACTION_HOVER: Record<RowActionsTone, { normal: {bg: string; color: string; border: string}; danger: {bg: string; color: string; border: string} }> = {
  // Как было и как останется на всех экранах, кроме списка доменов.
  blue:  { normal: {bg:"#eff4ff",color:"#2563eb",border:"#e5e7eb"}, danger: {bg:"#fef2f2",color:"#dc2626",border:"#e5e7eb"} },
  // Макет вкладки Domains: обычное действие ИНВЕРТИРУЕТСЯ (тёмная плашка,
  // белый глиф), опасное краснеет целиком — включая рамку, которой синему тону
  // трогать нечем.
  slate: { normal: {bg:"#0f172a",color:"#fff",border:"#0f172a"},   danger: {bg:"#fee2e2",color:"#b91c1c",border:"#fecaca"} },
};

const ROW_ACTION_BORDER = "#e5e7eb";

export function RowActions({ actions = [], tone = "blue" }: { actions: RowAction[]; tone?: RowActionsTone }) {
  const hover = ROW_ACTION_HOVER[tone];
  return <div style={{display:"flex",gap:5}}>
    {actions.map((a, i) => {
      const isDanger = a.variant === "danger";
      // Как в Btn: заблокированное действие не просто инертно, оно и выглядит так.
      const isDisabled = Boolean(a.disabled);
      const hov = isDanger ? hover.danger : hover.normal;
      return (
        <button
          key={`${a.title}-${i}`}
          type="button"
          title={a.title}
          aria-label={a.title}
          onClick={a.onClick}
          disabled={isDisabled}
          style={{width:28,height:28,border:`1px solid ${ROW_ACTION_BORDER}`,borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:isDisabled?"not-allowed":a.onClick?"pointer":"default",opacity:isDisabled?0.5:1,fontSize:12,color:isDanger?"#dc2626":"#6b7280",transition:"all 0.15s"}}
          // Рамку возвращаем ВСЕГДА, а не только под тем тоном, который её
          // трогает: инлайн-стиль, поставленный на `mouseenter`, живёт на узле
          // до тех пор, пока его не снимут, и «слейтовый» тон оставил бы за
          // собой красную рамку на кнопке, с которой курсор уже ушёл.
          onMouseEnter={e=>{if(a.onClick&&!isDisabled){e.currentTarget.style.background=hov.bg;e.currentTarget.style.color=hov.color;e.currentTarget.style.borderColor=hov.border;}}}
          onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color=isDanger?"#dc2626":"#6b7280";e.currentTarget.style.borderColor=ROW_ACTION_BORDER;}}
        >
          {a.icon}
        </button>
      );
    })}
  </div>;
}

/**
 * `label` — доступное имя кнопки. Глиф «⎘» скринридер не произносит никак, а
 * там, где копируемых значений в одном ряду несколько (id зоны, её NS),
 * безымянные кнопки неразличимы и глазами. Необязателен: у кнопки, стоящей
 * вплотную к единственному значению, нейтрального «Copy» хватает.
 */
export function CopyBtn({value, label = "Copy"}: { value: string; label?: string }){
  const [c,setC] = useState(false);
  return <button onClick={()=>{copyText(value);setC(true);setTimeout(()=>setC(false),1400);}} title={label} aria-label={label} style={{padding:"8px 10px",background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,cursor:"pointer",fontSize:13,color:"#6b7280",flexShrink:0,transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background="#eff4ff";e.currentTarget.style.color="#2563eb";}} onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color="#6b7280";}}>{c?"✓":"⎘"}</button>;
}

export const fmtDate = (iso: string) => iso ? new Date(iso).toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric"}) : "—";
export const fmtDT   = (iso: string) => iso ? new Date(iso).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—";
