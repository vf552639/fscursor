import React, { useState } from "react";

import { clip, errorText } from "../../api/cfAutoBind";
import { Domain, useUpdateDomain } from "../../api/domains";
import {
  expiryState,
  expiryTextColor,
  expiryTextWeight,
  formatExpiry,
  formatExpiryDate,
} from "../../lib/domainExpiry";

/** Тот же тон отказа, что у соседнего поля шапки и ряда связей. */
const ERROR_TEXT = "#991b1b";

/**
 * Срок домена в шапке карточки — и правка его на месте.
 *
 * Считает и печатает здесь только `lib/domainExpiry`: дата — `formatExpiryDate`,
 * остаток словами — `formatExpiry`, цвет и начертание — `expiryTextColor` и
 * `expiryTextWeight`. Общий `fmtDate` из `ui/Primitives` для этого поля НЕ
 * годится, и это не вкусовщина: `expiry_date` приходит датой без времени, а
 * `fmtDate` печатает её в зоне читателя — западнее UTC карточка называла бы
 * предыдущий день и расходилась бы с колонкой списка (`DomainRow`), которая
 * печатает ту же дату этим же модулем. Подробности — над `formatExpiryDate`.
 *
 * Пустое состояние — «set date», а не общий прочерк `NO_VALUE`. Прочерк —
 * ответ «мы не знаем» там, где значение только ПОКАЗЫВАЮТ; здесь же оно ещё и
 * правится, и прочерк на кнопке читается как «тут делать нечего». Название
 * пробела вместе с лекарством — то же правило, по которому в карточке завёлся
 * селект регистратора: диагноз без лекарства отправляет человека искать, чем
 * починить то, что он видит.
 *
 * Цвет пустого состояния взят у модуля (`unknown` → `#9ca3af`), а не из макета
 * (`#94a3b8`): рядом в той же строке стоят подписи и бейджи, крашенные общей
 * лестницей, и третий почти совпадающий серый читался бы не как решение, а как
 * поломка вёрстки (см. комментарий над `expiryTextColor`).
 */
export default function DomainExpiryField({ domain, now }: { domain: Domain; now: number }) {
  const update = useUpdateDomain(domain.id);
  const [editing, setEditing] = useState(false);
  /**
   * Дата, которую человек только что выбрал; `undefined` — не выбирал ничего.
   *
   * Отдельное состояние нужно ровно потому, что своей строки домена у карточки
   * нет: `domain` приезжает пропсом и обновляется только после того, как
   * доедет рефетч по инвалидации. Без этой памяти поле на секунду возвращалось
   * бы к СТАРОЙ дате сразу после выбора — то есть выглядело бы так, будто
   * правку потеряли.
   *
   * `null` — законное значение (срок сняли), поэтому «не выбирал» обозначено
   * `undefined`, а не `null`: иначе очистку было бы нечем отличить от
   * бездействия.
   */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  /**
   * Показывать выбранное поверх сохранённого стоит ровно до двух событий:
   * запись провалилась (тогда правды в выбранном нет — на экране обязано
   * стоять то, что лежит в базе, и рядом причина) либо строка домена уже
   * догнала выбранное (тогда поверх нечего класть). Условие сформулировано
   * через сравнение со строкой домена, а не через `isPending`: между успехом
   * мутации и приездом рефетча `isPending` уже ложен, а старая дата в пропсе
   * ещё стоит — и мигание вернулось бы именно там.
   */
  const pendingEdit = picked !== undefined && !update.isError && picked !== domain.expiry_date;
  const shown = pendingEdit ? picked : domain.expiry_date;

  const state = expiryState(shown, now);
  const label =
    state === "unknown" ? "set date" : `${formatExpiryDate(shown)} · ${formatExpiry(shown, now)}`;
  /** Ошибку надо не только показать, но и связать с полем: она объясняет его состояние. */
  const errorId = `domain-expiry-error-${domain.id}`;

  function commit(value: string) {
    // Пустой инпут — это СНЯТЬ срок, и записывать его надо `null`: пустая
    // строка в `expiry_date` не «нет даты», а нечитаемая дата, и бэкенду она
    // приедет отказом валидации либо мусором в колонке.
    const next = value ? value : null;
    // Та же дата, что уже стоит, — не правка: лишний PUT инвалидировал бы
    // список доменов и перерисовал бы полэкрана ни за чем.
    //
    // Сравниваем с ПОКАЗАННЫМ, а не со строкой домена. Разойтись они успевают:
    // человек выбрал дату, а через секунду передумал и вернул прежнюю — запись
    // первой ещё в полёте либо уже прошла, но рефетч не доехал, и в пропсе
    // по-прежнему стоит та самая «прежняя». Сравнение с пропсом объявило бы
    // возврат бездействием — и на сервере молча осталась бы дата, от которой
    // человек только что отказался.
    if (next === (shown ?? null)) return;
    setPicked(next);
    update.mutate({ expiry_date: next });
  }

  return (
    <>
      {editing ? (
        <input
          type="date"
          // Подпись «Expires:» стоит соседним узлом и с полем ничем не связана
          // — без своего имени поле звучит как «поле ввода даты» вообще.
          aria-label="Expiry date"
          aria-describedby={update.isError ? errorId : undefined}
          autoFocus
          // `value`, а не `defaultValue`: после провала записи поле обязано
          // вернуться к сохранённой дате, а неуправляемый инпут остался бы
          // стоять в той, которую сервер не принял.
          value={shown ?? ""}
          onChange={(e) => commit(e.target.value)}
          // Закрытие по blur — из макета. Отдельной кнопки «готово» нет
          // намеренно: запись уходит на change, и подтверждать нечего.
          onBlur={() => setEditing(false)}
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 7,
            padding: "3px 8px",
            fontSize: 13,
            fontFamily: "inherit",
            color: "#0f172a",
          }}
        />
      ) : (
        <button
          type="button"
          // Имя составное: голое «Expiry date» на кнопке ЗАМЕНИЛО бы её текст
          // для скринридера, то есть отняло бы у него саму дату, а один текст
          // кнопки («01.09.2026 · in 10 days») не говорит, чей это срок.
          aria-label={`Expiry date: ${label}`}
          aria-describedby={update.isError ? errorId : undefined}
          title="Edit expiry date"
          onClick={() => setEditing(true)}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
            color: expiryTextColor(state),
            fontWeight: expiryTextWeight(state),
            // Пунктирное подчёркивание — единственный знак, что значение
            // правится: кнопка здесь не выглядит кнопкой ни фоном, ни рамкой.
            borderBottom: "1px dashed #94a3b8",
          }}
        >
          {label}
        </button>
      )}
      {update.isError ? (
        // `clip` и перенос по любому месту — текст ЧУЖОЙ (тело ответа бэкенда),
        // тот же приём, что у ошибок записи в полях ряда связей: без обрезки
        // одна такая строка распирает шапку, без `overflowWrap` — уезжает за
        // край.
        <span
          id={errorId}
          role="alert"
          style={{ fontSize: 12, color: ERROR_TEXT, overflowWrap: "anywhere" }}
        >
          Could not save: {clip(errorText(update.error))}
        </span>
      ) : null}
    </>
  );
}
