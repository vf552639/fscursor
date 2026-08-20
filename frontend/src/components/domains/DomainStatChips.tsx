import React, { useMemo, useState } from "react";

import { chipCount, countDomains, DomainCounts, LifecycleStatus } from "../../lib/domainCounts";
import { tokens } from "../../lib/designTokens";
import { DomainUI } from "./types";

/**
 * Один чип-фильтр: подпись и значение, которое уедет в фильтр `status`.
 *
 * Счётчика в объекте НЕТ намеренно — он выводится из `value` (`chipCount`).
 * Пара, сопоставленная руками (`{ value: "active", count: byStatus.failed }`),
 * компилировалась бы молча и дала бы чип, который показывает одно, а фильтрует
 * другое; это тот же класс ошибки, ради которого поля здесь именованные, а не
 * сложены в кортеж.
 *
 * Подпись при этом задаётся руками, и это осознанная граница: `domainStatusLabel`
 * даёт `ACTIVE`, а макету нужен `Active`, — но перепутанная ПОДПИСЬ видна с
 * первого взгляда на экран, а перепутанный счётчик неотличим от правды.
 */
interface Chip {
  label: string;
  /** Пустая строка у «All» — то есть «без среза». */
  value: LifecycleStatus | "";
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
 * Компонент несёт ДВЕ вещи, и имя файла честно называет только первую. Вместе
 * они потому, что это один ответ на вопрос «что сейчас в списке», разложенный
 * по важности: четыре числа, на которые смотрят всегда, и ещё пять, за которыми
 * приходят изредка. Развести их по двум компонентам значило бы отдать двоим
 * один и тот же посчитанный срез — и завести второй проход по списку ради
 * строки, которая большую часть времени свёрнута.
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
 * Сами правила подсчёта живут в `lib/domainCounts` — там же, где объяснения,
 * почему они такие. Здесь только показ.
 *
 * Своего нижнего отступа компонент НЕ несёт, и это контракт, а не упущение:
 * расстояние до соседа держит колонка страницы (`gap` у контейнера в
 * `pages/Domains`). Вернуть сюда `marginBottom` — значит отдать блоку отступ,
 * который принадлежит промежутку: он останется висеть, когда блок окажется
 * последним или единственным на экране.
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
   * Правка `domains={filters.filtered}` выглядит очевидным улучшением для того,
   * кто придёт следом, поэтому её сторожит тест (`pages/Domains.chips.test.tsx`).
   */
  domains: DomainUI[];
  /** Текущее значение фильтра `status` (`hooks/useDomainFilters`). */
  status: string;
  onStatusChange: (v: string) => void;
}) {
  const counts: DomainCounts = useMemo(() => countDomains(domains), [domains]);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const chips: Chip[] = [
    { label: "All", value: "" },
    { label: "Active", value: "active" },
    { label: "New", value: "new" },
    { label: "Failed", value: "failed" },
  ];

  const details: Detail[] = [
    { label: "NS OK", value: counts.ns.ok, color: tokens.semantic.success.text },
    { label: "NS Pending", value: counts.ns.pending, color: tokens.semantic.warning.text },
    { label: "NS Errors", value: counts.ns.error, color: tokens.semantic.danger.text },
    { label: "In progress", value: counts.inProgress, color: tokens.semantic.info.text },
  ];
  // Пятый пункт — только когда есть о чём говорить: «Failed at SSL: 0» это не
  // сигнал, а шум. Условие тут, а не в цвете (как у четырёх соседей выше),
  // потому что пункт новый: четыре первых держат ширину строки постоянной и
  // читаются как перечень, а пятый появляется, и появление — это и есть его
  // сообщение.
  if (counts.failedAtSsl > 0) {
    details.push({ label: "Failed at SSL", value: counts.failedAtSsl, color: tokens.semantic.danger.text });
  }

  return (
    <div>
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
         * Оговорка о смысле: `aria-pressed` не обещает взаимного исключения,
         * хотя нажатым здесь всегда ровно один чип. Это ослабление, и оно
         * осознанное — обещание, которое не выполняется клавиатурой, дороже
         * обещания, которого не дали. А вот второе ожидание от нажатой кнопки —
         * что повторное нажатие её отожмёт — выполняется честно (см. `onClick`).
         */}
        <div role="group" aria-label="Filter by status" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {chips.map((chip) => {
            const isActive = status === chip.value;
            const count = chipCount(counts, chip.value);
            // Красный счётчик достаётся только провалам, и только когда они есть:
            // на нуле красное пятно кричало бы о том, чего не случилось.
            const alarming = chip.value === "failed" && count > 0;
            return (
              <button
                key={chip.label}
                type="button"
                aria-pressed={isActive}
                // Повторный клик по нажатому чипу снимает срез, а не молчит.
                // Кнопка с `aria-pressed` обещает именно это, и обещание надо
                // либо выполнить, либо не давать; выполнить дешевле — тем более
                // что «снять срез» и «нажать All» здесь одно и то же значение.
                onClick={() => onStatusChange(isActive ? "" : chip.value)}
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
                  color: isActive ? tokens.surface.base : tokens.text.secondary,
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
                  {count}
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
                  вёрстку вместо содержания.

                  Ноль рисуется приглушённым, а не своим цветом: то же правило,
                  что у красного счётчика на чипе «Failed», — красное «NS
                  Errors: 0» и янтарное «NS Pending: 0» кричали бы о том, чего
                  не случилось, и на здоровом списке вся строка светилась бы
                  тревогой. Цвет здесь утверждение, а не украшение подписи. */}
              <span style={{ color: d.value > 0 ? d.color : tokens.text.muted, fontWeight: d.value > 0 ? 600 : 400 }}>
                {`${d.label}: ${d.value}`}
              </span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
