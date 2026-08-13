import React, { useState } from "react";

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
    style={{display:"inline-flex",alignItems:"center",gap:6,borderRadius:8,fontFamily:"'Inter',sans-serif",fontWeight:500,cursor:disabled?"not-allowed":"pointer",transition:"all 0.15s",opacity:disabled?0.5:1,...sz[size],...va[variant],...style}}
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

// `closeOnBackdrop={false}` — для модалок, чей `onClose` УНИЧТОЖАЕТ единственную
// копию показанного (пароли FTP/БД/панели). Промах мимо кнопки Done не должен
// стоить пароля к уже созданному аккаунту, а в очереди из двадцати модалок,
// которые ещё и разной высоты, такой промах — вопрос времени.
export function Modal({title, onClose, children, width=480, closeOnBackdrop=true}: any){
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={e=>{if(closeOnBackdrop&&e.target===e.currentTarget)onClose();}}>
    <div style={{background:"#fff",borderRadius:14,width,maxWidth:"95vw",boxShadow:"0 20px 60px rgba(0,0,0,0.18)",padding:28,position:"relative",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div style={{fontSize:18,fontWeight:700,color:"#111"}}>{title}</div>
        <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"#9ca3af",lineHeight:1}}>✕</button>
      </div>
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

export function RowActions({ actions = [] }: { actions: RowAction[] }) {
  return <div style={{display:"flex",gap:5}}>
    {actions.map((a, i) => {
      const isDanger = a.variant === "danger";
      // Как в Btn: заблокированное действие не просто инертно, оно и выглядит так.
      const isDisabled = Boolean(a.disabled);
      return (
        <button
          key={`${a.title}-${i}`}
          type="button"
          title={a.title}
          aria-label={a.title}
          onClick={a.onClick}
          disabled={isDisabled}
          style={{width:28,height:28,border:"1px solid #e5e7eb",borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:isDisabled?"not-allowed":a.onClick?"pointer":"default",opacity:isDisabled?0.5:1,fontSize:12,color:isDanger?"#dc2626":"#6b7280",transition:"all 0.15s"}}
          onMouseEnter={e=>{if(a.onClick&&!isDisabled){e.currentTarget.style.background=isDanger?"#fef2f2":"#eff4ff";e.currentTarget.style.color=isDanger?"#dc2626":"#2563eb";}}}
          onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.color=isDanger?"#dc2626":"#6b7280";}}
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
/**
 * Аптайм словами: «3d 5h», «23h 59m», «30m». ЕДИНСТВЕННАЯ реализация на
 * продукт — у дашборда была своя («3 days», «23h»), и один и тот же сервер
 * назывался на двух экранах по-разному; читатель сверяет экраны глазами, и два
 * написания одного числа он читает как два разных числа.
 *
 * Форма плотная (две единицы подряд), потому что продукт — пульт с десятками
 * цифр в строке: «3 days» рядом с «42%» и «2/4 GB» выпадает из ряда, а вторая
 * единица отвечает на следующий же вопрос («три дня и сколько?»).
 *
 * `null`/`undefined` — прочерк, а не ноль: «0h» у сервера, которого ни разу не
 * опрашивали, это выдуманное показание. Ноль настоящий при этом показывается
 * («<1m»), потому что он означает «только что поднялся» — тоже факт.
 */
export const formatUptime = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
};

/**
 * МБ → ГБ для показа, один знак после запятой. Тоже одна на продукт: перевод
 * был написан трижды, и две копии из трёх округляли до целого — из-за чего
 * дашборд показывал «1.5/4 GB», а список тот же сервер как «2/4 GB». Округление
 * до целого дорисовывает машине треть памяти, которой никто не измерял.
 *
 * Живёт рядом с `formatUptime` и `formatAgo`: это тот же предмет — как показать
 * измеренное число, — и дом у него должен быть один, иначе копии заводятся
 * снова.
 */
export const mbToGb = (mb: number) => Math.round((mb / 1024) * 10) / 10;

/**
 * Возраст отметки времени словами: «2h ago», «3mo ago». Не украшение: показание
 * без возраста читается как текущее, каким бы старым оно ни было, — а метрики
 * снимает десктоп по кнопке, и на карточке легко живёт цифра трёхмесячной
 * давности (`metrics_collected_at`).
 *
 * Аргумент — `string`, а НЕ `string | null`. «Отметки нет» и «отметка старая» —
 * разные состояния, и слова у них на экране разные («never» / «3mo ago»);
 * развилку обязан сделать вызывающий, и, пропусти он её, тип не даст собраться.
 *
 * `now` параметром ради тестов: границы у чистой функции проверяются дешевле и
 * надёжнее, чем через рендер страницы.
 *
 * Экраны зовут не её, а `formatAgoStale` ниже: рядом с показанием возраст почти
 * всегда идёт вместе с пометкой протухания. Раздельно они живут потому, что
 * отвечают за разное — эта не знает, что именно устаревает и по какому порогу.
 */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const ts = new Date(iso).getTime();
  // Неразобранная дата — прочерк, а не «NaN ago»: строка приезжает с сервера, и
  // «NaN ago» на карточке читалось бы как поломка страницы.
  if (Number.isNaN(ts)) return "—";
  const sec = (now - ts) / 1000;
  // Первая же ветка забирает и отрицательную разность — часы клиента, отставшие
  // от серверных. Это не будущее: показание уже снято, и «через час» было бы
  // фантазией. Отдельного `Math.max(0, …)` нет намеренно — он был бы кодом,
  // который ничего не меняет (мутационная проверка это и показала).
  if (sec < 60) return "just now";
  // Везде вниз (`floor`): 90 минут — это «1h ago». Округление вверх делало бы
  // показание СТАРШЕ, чем оно есть, а ошибаться в эту сторону здесь безопаснее,
  // чем в обратную, только если это не переворачивает картину — «2h ago» у
  // часового показания сбивает с толку ровно так же.
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86400);
  if (days < 30) return `${days}d ago`;
  // Дальше месяцев не идём: «12mo ago» читается не хуже «1y ago», а лишняя
  // ступень — лишняя граница, которую надо помнить и проверять.
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Пометка «показание протухло». Одна на продукт: пока хвост собирался по месту,
 * он успел разъехаться на три редакции («· stale», «· stale, press «Refresh
 * metrics»», «(stale)»), то есть один и тот же факт назывался на трёх экранах
 * по-разному.
 */
export const STALE_SUFFIX = " · stale";

/**
 * Возраст показания с пометкой протухания — то, что показывается рядом с самим
 * показанием. Семь копий этого выражения в трёх файлах и породили три редакции
 * текста, см. `STALE_SUFFIX`.
 *
 * `stale` отдельным аргументом, а не вычисляется внутри: порогов протухания два
 * (метрики и проверка доступности), они живут в `lib/serverStatus` и знать про
 * них форматированию нечего — иначе оно выбирало бы за вызывающего, каким
 * порогом мерить.
 */
export function formatAgoStale(iso: string, stale: boolean, now: number = Date.now()): string {
  return `${formatAgo(iso, now)}${stale ? STALE_SUFFIX : ""}`;
}

/*
 * `isMetricsStale` переехала в `lib/serverStatus`: порог протухания — правило
 * продукта, а не форматирование, и рядом с ним живёт такой же порог для
 * проверки доступности. Здесь остаётся `formatAgo` — она про то, КАК показать
 * возраст, и не знает, что именно устаревает.
 */
