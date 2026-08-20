import React, { useMemo, useState } from "react";

import { tokens } from "../../lib/designTokens";
import { DomainUI } from "./types";

/**
 * Один чип-фильтр: подпись, значение фильтра `status` и счётчик.
 *
 * Именованные поля, а не кортеж, — по той же причине, по какой они появились у
 * карточек, которые этот ряд заменил: у кортежа `[string, string, number]`
 * порядок «значение фильтра, потом подпись» не проверяет никто, а перепутанная
 * пара даёт чип, который подписан «Active», а фильтрует по `"active"`… или по
 * `"Active"`, и компилятор молчит.
 */
interface Chip {
  label: string;
  /** Что уедет в фильтр `status`. У «All» — пустая строка, то есть «без среза». */
  value: string;
  count: number;
}

/** Один пункт развёрнутой строки: подпись, число и цвет числа. */
interface Detail {
  label: string;
  value: number;
  color: string;
}

/**
 * Ряд чипов-фильтров над таблицей доменов и спрятанная за ними строка деталей.
 *
 * Пришёл на место `DomainStats` — восьми карточек в два ряда. Разница не только
 * в размере: карточки ничего не делали, а чип одновременно ПОКАЗЫВАЕТ число и
 * ФИЛЬТРУЕТ по нему, поэтому селект «All Statuses» из панели фильтров уехал
 * целиком — иначе на экране стояло бы два способа задать один и тот же срез, и
 * рано или поздно они бы разошлись.
 *
 * Чипов ровно четыре, и промежуточных статусов (`ns_pending`, `ns_ok`,
 * `provisioning`, `site_created`, `ssl_pending`) среди них нет — это решение, а
 * не пропуск. Такие домены видны под `All`, а их число печатает строка деталей
 * пунктом «In progress». Отдельного фильтра им заводить не надо: спрашивать
 * «покажи мне ровно `ssl_pending`» приходит тот, кто уже знает, что ищет, — а
 * ему хватает поиска по имени.
 *
 * Считает сам, а не получает числа пропсами: правила подсчёта (особенно
 * «остаток» ниже) стоят своих комментариев, и держать их отдельно от показа
 * значит развести объяснение и то, что оно объясняет.
 */
export default function DomainStatChips({
  domains,
  status,
  onStatusChange,
}: {
  /**
   * ПОЛНЫЙ список, а не отфильтрованный.
   *
   * Иначе выбранный чип обнулит счётчики остальных — «Failed 3» после клика по
   * «Active» станет «Failed 0», — и вернуться к ним будет некуда: ряд перестанет
   * быть картой списка и станет описанием текущего среза, то есть тавтологией.
   */
  domains: DomainUI[];
  /** Текущее значение фильтра `status` (`hooks/useDomainFilters`). */
  status: string;
  onStatusChange: (v: string) => void;
}) {
  /**
   * Срез по жизненному циклу домена.
   *
   * «In progress» считается ОСТАТКОМ, а не перечислением промежуточных
   * статусов, и это не лень: перечисление молча теряет любой статус, которого
   * автор не вспомнил (а ровно так и потерялся `ns_ok` — см.
   * `lib/domainStatus`), и ряд переставал бы сходиться с общим числом. Остаток
   * сходится по построению.
   */
  const lifecycle = useMemo(() => {
    const count = (s: string) => domains.filter((d) => d.status === s).length;
    const fresh = count("new");
    const active = count("active");
    const failed = count("failed");
    return { fresh, active, failed, inProgress: domains.length - fresh - active - failed };
  }, [domains]);

  const ns = useMemo(() => {
    const count = (s: string) => domains.filter((d) => d.ns_status === s).length;
    return { ok: count("ok"), pending: count("pending"), error: count("error") };
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
   *
   * Раньше это был отдельный красный бейдж под карточками; в макете места для
   * него нет, поэтому счётчик уехал пятым пунктом в строку деталей. Сигнал тот
   * же и по тому же правилу — новой поверхности под него не заведено, но и
   * терять его нельзя: провал SSL больше нигде на этом экране не суммируется.
   */
  const failedAtSslCount = useMemo(
    () => domains.filter((d) => d.ssl_status === "error").length,
    [domains]
  );

  const [detailsOpen, setDetailsOpen] = useState(false);

  const chips: Chip[] = [
    { label: "All", value: "", count: domains.length },
    { label: "Active", value: "active", count: lifecycle.active },
    { label: "New", value: "new", count: lifecycle.fresh },
    { label: "Failed", value: "failed", count: lifecycle.failed },
  ];

  const details: Detail[] = [
    { label: "NS OK", value: ns.ok, color: tokens.semantic.success.text },
    { label: "NS Pending", value: ns.pending, color: tokens.semantic.warning.text },
    { label: "NS Errors", value: ns.error, color: tokens.semantic.danger.text },
    { label: "In progress", value: lifecycle.inProgress, color: tokens.semantic.info.text },
  ];
  // Пятый пункт — только когда есть о чём говорить: «Failed at SSL: 0» это не
  // сигнал, а шум, и красный цвет он тратит впустую.
  if (failedAtSslCount > 0) {
    details.push({ label: "Failed at SSL", value: failedAtSslCount, color: tokens.semantic.danger.text });
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {/*
         * `role="group"` + `aria-pressed`, а НЕ `role="radiogroup"`/`aria-checked`.
         *
         * Выбор такой: радиогруппа по ARIA APG обязана вести себя как один
         * элемент управления — единственная точка табуляции и переключение
         * стрелками с переносом по краям. Половинчатая радиогруппа (роли
         * проставлены, клавиатура не написана) хуже отсутствия ролей вовсе:
         * скринридер объявит «радиогруппа, 1 из 4» и пообещает стрелки, которых
         * нет, — человек останется без навигации там, где обычные кнопки её
         * дают из коробки. Кнопки же достижимы Tab'ом сами, а `aria-pressed`
         * честно сообщает «нажат/не нажат».
         *
         * Оговорка про смысл: `aria-pressed` не обещает взаимного исключения,
         * хотя нажатым здесь всегда ровно один чип. Это ослабление, и оно
         * осознанное — обещание, которое не выполняется клавиатурой, дороже
         * обещания, которого не дали.
         */}
        <div role="group" aria-label="Фильтр по статусу домена" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {chips.map((chip) => {
            const isActive = status === chip.value;
            // Красный счётчик достаётся только провалам, и только когда они есть:
            // на нуле красное пятно кричало бы о том, чего не случилось.
            const alarming = chip.value === "failed" && chip.count > 0;
            return (
              <button
                key={chip.label}
                type="button"
                aria-pressed={isActive}
                onClick={() => onStatusChange(chip.value)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 14px",
                  borderRadius: tokens.radius.pill,
                  fontSize: 13,
                  // 600 у обеих половин, хотя макет называет вес только для
                  // активной: разный вес на одном ряду менял бы ширину чипа в
                  // момент клика, и соседи дёргались бы под курсором.
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  background: isActive ? tokens.text.ink : tokens.surface.base,
                  color: isActive ? "#fff" : tokens.text.secondary,
                  // Рамка есть и у активного — прозрачная: без неё чип при
                  // выборе терял бы два пикселя ширины и ряд сдвигался бы.
                  border: `1px solid ${isActive ? "transparent" : tokens.border.light}`,
                }}
              >
                {chip.label}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "1px 7px",
                    borderRadius: tokens.radius.pill,
                    background: alarming ? tokens.semantic.danger.bg : tokens.surface.page,
                    color: alarming ? tokens.semantic.danger.text : tokens.text.secondary,
                  }}
                >
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>
        {/*
         * Детали спрятаны за клик, а не показаны рядом, и это ровно та сделка,
         * от которой отказывались карточки: NS-срез отвечает на другой вопрос
         * («доехало ли делегирование»), и второй ряд плашек ради него съедал
         * высоту у самого списка. Разворот дешёвый и запоминается глазами —
         * `aria-expanded` говорит то же самое тем, кто на глаза не полагается.
         */}
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            marginLeft: 4,
            fontSize: 12,
            fontFamily: "inherit",
            color: tokens.text.muted,
            textDecoration: "underline dotted",
            textUnderlineOffset: 3,
            cursor: "pointer",
          }}
        >
          {detailsOpen ? "Hide NS details" : "NS details"}
        </button>
      </div>
      {detailsOpen ? (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            fontSize: 12,
            color: tokens.text.muted,
          }}
        >
          {details.map((d, i) => (
            <React.Fragment key={d.label}>
              {i > 0 ? <span style={{ color: tokens.text.faint }}>·</span> : null}
              {/* Пункт — ОДИН текстовый узел, а не подпись плюс число в
                  отдельном теге. Причина не косметическая: разбитый на два узла
                  пункт нельзя найти по видимому тексту («NS OK: 3») ни глазами
                  проверяющего, ни `getByText` — тот собирает только прямых
                  текстовых потомков, и число во вложенном теге для него не
                  существует. Тест, вынужденный лезть внутрь вёрстки, проверяет
                  вёрстку вместо содержания. */}
              <span style={{ color: d.color, fontWeight: 600 }}>{`${d.label}: ${d.value}`}</span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
