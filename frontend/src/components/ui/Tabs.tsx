import React, { useId, useRef } from "react";

export type TabItem = {
  id: string;
  label: React.ReactNode;
};

/**
 * Подчёркнутые вкладки макета — и первые в продукте, до которых можно добраться
 * с клавиатуры.
 *
 * Копий строки вкладок в продукте уже три (`pages/Activity`, `pages/Settings`,
 * `pages/ServerDetail`), и все три сделаны одинаково: `<div onClick>` без роли и
 * без tabindex. Кликом они работают, а больше никак — до такой «вкладки» не
 * доводит ни Tab, ни стрелка, и скринридер называет её просто группой, не
 * сообщая ни что это переключатель, ни какая из них выбрана. Здесь роли
 * (`tablist`/`tab`/`tabpanel`), `aria-selected` и ходьба стрелками есть с
 * рождения. Те три копии сознательно не трогаем: они принадлежат своим экранам
 * и своему скоупу — но переезжать им, когда дело дойдёт, уже есть куда.
 *
 * Примитив УПРАВЛЯЕМЫЙ (`value` + `onChange`): активная вкладка — это состояние
 * экрана, а не строки кнопок. Модалка домена решает, с какой вкладки
 * открываться, и она же однажды будет поднимать выбор в ссылку `sdmp://`;
 * заведи мы состояние внутри, у выбора стало бы два хозяина, и вечный вопрос
 * «чей ответ правильный» пришлось бы решать синхронизацией.
 *
 * Содержимое панели приходит `children`, а не полем `content` у каждой вкладки,
 * и это не стилистика. Вкладки карточки домена — поддеревья с собственными
 * запросами (зоны Cloudflare, факты сервера, логи по SSH); отдай мы примитиву
 * все пять сразу, он либо смонтировал бы их разом — то есть открытие карточки
 * стреляло бы всеми запросами всех вкладок, — либо всё равно рисовал бы только
 * активное, а остальные четыре считались бы вхолостую на каждый рендер.
 * Вызывающий рисует ровно активную вкладку, примитив отвечает за обвязку.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  children,
  style,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /**
   * Доступное имя строки вкладок. Необязательно, но осмысленно почти всегда:
   * без него скринридер объявляет безымянный «список вкладок», а на экране, где
   * такая строка не одна, их не различить на слух.
   */
  label?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  /**
   * Префикс идентификаторов из `useId`, а не константа: `aria-controls` и
   * `aria-labelledby` связывают вкладку с панелью по id, и две строки вкладок на
   * одном экране со статическими id связались бы крест-накрест — первая
   * указывала бы на панель второй.
   */
  const uid = useId();
  const tabDomId = (id: string) => `${uid}tab-${id}`;
  const panelDomId = (id: string) => `${uid}panel-${id}`;

  /**
   * Ссылки на кнопки нужны ровно для фокуса при ходьбе стрелками: выбор меняет
   * `onChange`, но если фокус останется на прежней кнопке, следующая стрелка
   * посчитается от неё, и строка «поедет» не туда.
   */
  const btns = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (delta: number) => {
    const idx = items.findIndex((t) => t.id === value);
    // Значение вне списка — переключать не от чего: любая догадка («начнём с
    // первой») увела бы экран на вкладку, которую никто не просил.
    if (idx < 0 || items.length === 0) return;
    // По кругу: строка вкладок короткая и видна целиком, упор в край здесь
    // ничего не подсказывает — только заставляет отсчитывать шаги назад.
    const next = items[(idx + delta + items.length) % items.length];
    onChange(next.id);
    btns.current[next.id]?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        // `gap:4px` и `margin-bottom:-1px` у кнопок — из макета: активная
        // вкладка кладёт свою 2px-черту ПОВЕРХ 1px-линии строки, а не под неё.
        style={{ display: "flex", gap: 4, borderBottom: "1px solid #e2e8f0", ...style }}
        onKeyDown={(e) => {
          // Только горизонтальные стрелки. Вертикальные принадлежат прокрутке
          // модалки (`Modal` держит `overflowY:auto`), и перехватывать их у
          // горизонтальной строки не за что.
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {items.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              // Модалки продукта содержат формы, и кнопка без `type` в форме —
              // это submit.
              type="button"
              role="tab"
              id={tabDomId(t.id)}
              aria-selected={active}
              aria-controls={panelDomId(t.id)}
              /**
               * Roving tabindex: в таб-порядке ровно одна вкладка — активная.
               * Иначе клавиша Tab прогоняет по всем пяти кнопкам подряд, прежде
               * чем добраться до содержимого панели, а по самой строке ходят
               * стрелками — то есть Tab делал бы чужую работу пять раз.
               */
              tabIndex={active ? 0 : -1}
              ref={(el) => {
                btns.current[t.id] = el;
              }}
              onClick={() => onChange(t.id)}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                padding: "10px 14px 12px",
                // Шрифт задаётся явно, как в `Btn`: без него кнопка берёт
                // системный шрифт формы и выпадает из строки набранного Inter.
                fontFamily: "'Inter',sans-serif",
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? "#0f172a" : "#64748b",
                borderBottom: `2px solid ${active ? "#0f172a" : "transparent"}`,
                marginBottom: -1,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = "#64748b";
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/*
        Панель одна на строку вкладок, и имя ей даёт активная вкладка. Своего
        `tabIndex` у неё нет намеренно: фокусируемой панель делают, когда внутри
        нет ни одного фокусируемого элемента, — а здесь внутри поля, селекты и
        кнопки, и лишняя остановка Tab только удлиняла бы путь до них.
      */}
      <div role="tabpanel" id={panelDomId(value)} aria-labelledby={tabDomId(value)}>
        {children}
      </div>
    </>
  );
}
