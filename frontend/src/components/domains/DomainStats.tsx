import React, { useMemo } from "react";

import { Badge } from "../ui/Primitives";
import { DomainUI } from "./types";

/**
 * Одна карточка среза: подпись, число и пара цветов.
 *
 * Именованные поля, а не кортеж: раньше ряды объявлялись как
 * `[string, number, string, string][][]` через `as`, то есть порядок «цвет
 * текста, потом фон» не проверял никто — перепутанная пара давала бы белые
 * цифры на белом, и компилятор молчал бы.
 */
interface StatCard {
  label: string;
  value: number;
  /** Цвет числа и подписи. */
  color: string;
  /** Фон карточки; он же её рамка. */
  background: string;
}

/**
 * Срез списка доменов карточками — два ряда над таблицей.
 *
 * Считает сам, а не получает числа пропсами: правила подсчёта (особенно
 * «остаток» ниже) стоят своих комментариев, и держать их отдельно от показа
 * значит развести объяснение и то, что оно объясняет.
 */
export default function DomainStats({ domains }: { domains: DomainUI[] }) {
  /**
   * Срез по жизненному циклу домена — второй ряд карточек рядом с NS-срезом.
   *
   * Ряд, а не переключатель NS ↔ lifecycle: оба среза отвечают на разные
   * вопросы («доехало ли делегирование» и «доехал ли сайт»), и спрятать один за
   * клик значит показать половину состояния тому, кто на страницу как раз и
   * пришёл узнать, всё ли в порядке. Числа тут маленькие и постоянные — место
   * они стоят дешевле, чем стоил бы невидимый счётчик провалов.
   *
   * «In progress» считается ОСТАТКОМ, а не перечислением промежуточных
   * статусов, и это не лень: перечисление молча теряет любой статус, которого
   * автор не вспомнил (а ровно так и потерялся `ns_ok` — см.
   * `lib/domainStatus`), и ряд переставал бы сходиться с Total. Остаток сходится
   * по построению.
   */
  const lifecycle = useMemo(() => {
    const count = (s: string) => domains.filter((d) => d.status === s).length;
    const fresh = count("new");
    const active = count("active");
    const failed = count("failed");
    return { fresh, active, failed, inProgress: domains.length - fresh - active - failed };
  }, [domains]);
  /**
   * Домены, у которых провижининг дошёл до SSL и сертификата не получил.
   *
   * Считается по `ssl_status === "error"` — единственному признаку, который
   * такой прогон о себе действительно оставляет: провал выпуска (как и пропуск
   * из-за DNS или отсутствия почты) намеренно НЕ роняет провижининг, поэтому
   * домен остаётся `site_created`, а не `failed`, и в `last_provision_error`
   * ничего не пишется — там живут только фатальные провалы, и их текст
   * (`provision failed at {шаг}: {класс}`) слова «ssl» не содержит вовсе.
   * Прежний предикат (`status === "failed"` И текст ошибки со словом «ssl»)
   * не мог стать истинным ни при одном прогоне.
   */
  const failedAtSslCount = useMemo(
    () => domains.filter((d) => d.ssl_status === "error").length,
    [domains]
  );

  // Первый ряд — про делегирование, второй — про жизненный цикл домена.
  // Total стоит в первом и относится к обоим: он же и есть сумма второго.
  const rows: StatCard[][] = [
    [
      {label:"Total",value:domains.length,color:"#2563eb",background:"#eff4ff"},
      {label:"NS OK",value:domains.filter((d)=>d.ns_status==="ok").length,color:"#16a34a",background:"#f0fdf4"},
      {label:"NS Pending",value:domains.filter((d)=>d.ns_status==="pending").length,color:"#d97706",background:"#fffbeb"},
      {label:"NS Errors",value:domains.filter((d)=>d.ns_status==="error").length,color:"#dc2626",background:"#fef2f2"}
    ],
    [
      {label:"New",value:lifecycle.fresh,color:"#6b7280",background:"#f3f4f6"},
      {label:"In progress",value:lifecycle.inProgress,color:"#2563eb",background:"#eff4ff"},
      {label:"Active",value:lifecycle.active,color:"#16a34a",background:"#f0fdf4"},
      {label:"Failed",value:lifecycle.failed,color:"#dc2626",background:"#fef2f2"}
    ]
  ];

  return <>
    {rows.map((row, i)=>(
      <div key={i} style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:i===0?12:20}}>
        {row.map((card)=>(
          <div key={card.label} style={{background:card.background,border:"1px solid",borderColor:card.background,borderRadius:10,padding:"14px 18px"}}><div style={{fontSize:22,fontWeight:700,color:card.color}}>{card.value}</div><div style={{fontSize:12,color:card.color,opacity:0.8}}>{card.label}</div></div>
        ))}
      </div>
    ))}
    {failedAtSslCount > 0 ? (
      <div style={{ marginBottom: 12 }}>
        <Badge variant="red">Failed at SSL: {failedAtSslCount}</Badge>
      </div>
    ) : null}
  </>;
}
