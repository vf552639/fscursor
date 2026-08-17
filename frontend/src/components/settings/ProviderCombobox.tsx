import React, { useMemo, useState } from "react";

import {
  buildProviderList,
  providerMeta,
  normalizeProvider,
  type ProviderMeta,
} from "../../lib/registrarProviders";

interface Props {
  value: string;
  onChange: (provider: string) => void;
  accounts: { provider: string }[];
  /** Во время записи блобов/POST переключать провайдера нельзя (см. AddRegistrarModal). */
  disabled?: boolean;
}

function Avatar({ m }: { m: ProviderMeta }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 7,
        background: m.bg,
        color: m.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {m.icon}
    </div>
  );
}

/**
 * Бейдж способности. «manual» не украшаем зелёным: у такого провайдера нет ни
 * кнопки Test, ни Set NS, и рисовать его наравне с API-провайдером значило бы
 * обещать работоспособность, которой нет (CLAUDE.md §6).
 */
function ApiTag({ api }: { api: boolean }) {
  return api ? (
    <span
      style={{
        background: "#dcfce7",
        color: "#166534",
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 4,
      }}
    >
      API
    </span>
  ) : (
    <span style={{ color: "#9ca3af", fontSize: 11 }}>manual</span>
  );
}

/**
 * Выбор провайдера регистратора: список (API-каталог ∪ ранее использованные) с
 * поиском, либо создание своего вводом имени.
 *
 * Что уходит наружу в `onChange` — самое важное решение компонента:
 *
 * - выбран пункт с API → отдаём **нормализованный ключ** (`o.key`, например
 *   `"namecheap"`). Именно эту строку десктоп передаёт в `make_service`, а он
 *   пробелы не срезает — отдать сюда исходный ярлык значило бы записать в БД
 *   провайдера, который выглядит настоящим, но получает `unknown provider`;
 * - выбран ручной пункт → отдаём `o.label`, то есть имя как его записал
 *   пользователь (`"GoDaddy"`, а не `"godaddy"`): API от него всё равно нет, а
 *   человекочитаемое написание — единственное, что у ярлыка есть ценного;
 * - создан новый → отдаём **тримленный** ввод. Trim обязателен: вставленное из
 *   буфера `" Namecheap "` иначе завело бы ручной дубль настоящего Namecheap
 *   (`hasApi` пробелы не схлопывает — см. отклонение в Фазе 1 плана). Тримленный
 *   ввод же совпадёт с каталогом по ключу, и «Создать» для него не предложат вовсе.
 */
export function ProviderCombobox({ value, onChange, accounts, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  /**
   * Текущий выбор входит в список наравне с аккаунтами. Иначе только что
   * созданный провайдер (аккаунта под него ещё нет — это ровно первый живой
   * сценарий формы) не подсвечивался бы как выбранный, а поиск по его же имени
   * предлагал бы «Создать» второй раз. Дедуп у `buildProviderList` идёт по
   * нормализованному ключу, поэтому каталожный `value` не задваивается, а
   * пустой (`""`, одни пробелы) отсеивается вместе с пустыми ключами аккаунтов.
   */
  const options = useMemo(
    () => buildProviderList([...accounts, { provider: value }]),
    [accounts, value],
  );
  const selected = providerMeta(value);

  const q = query.trim();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
    : options;
  // Предлагаем «создать», только если введённого имени нет среди опций по
  // нормализованному ключу — иначе плодили бы дубль существующего провайдера.
  const exists = options.some((o) => o.key === normalizeProvider(q));
  const canCreate = q.length > 0 && !exists;

  const pick = (provider: string) => {
    onChange(provider);
    setOpen(false);
    setQuery("");
  };

  // Список гасится вместе с полем: если `disabled` пришёл, пока выпадашка была
  // раскрыта (сохранение началось из-под открытого списка), выбирать в ней
  // нельзя. Стейт `open` при этом не сбрасываем — по возвращении из saving
  // пользователь видит ровно то, что открывал.
  const listVisible = open && !disabled;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Provider"
        aria-haspopup="listbox"
        aria-expanded={listVisible}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
          border: "2px solid #2563eb",
          borderRadius: 8,
          background: "#fff",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <Avatar m={selected} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#111" }}>
          {selected.label}
        </span>
        <ApiTag api={selected.api} />
        <span style={{ marginLeft: "auto", color: "#9ca3af" }}>▾</span>
      </button>

      {listVisible && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск провайдера…"
              style={{
                width: "100%",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: "7px 10px",
                fontSize: 13,
              }}
            />
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {/* `role="listbox"` держим на контейнере ровно с опциями: поле поиска
                и заглушка «ничего не найдено» — не `option`, и оставь они внутри
                listbox, дерево ролей было бы невалидным. */}
            <div role="listbox" aria-label="Providers">
              {filtered.map((o) => (
                <div
                  key={o.key}
                  role="option"
                  aria-selected={o.key === selected.key}
                  onClick={() => pick(o.api ? o.key : o.label)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    cursor: "pointer",
                    background: o.key === selected.key ? "#eff4ff" : "#fff",
                  }}
                >
                  <Avatar m={o} />
                  <span style={{ fontSize: 13, color: "#111" }}>{o.label}</span>
                  <span style={{ marginLeft: "auto" }}>
                    <ApiTag api={o.api} />
                  </span>
                </div>
              ))}
              {canCreate && (
                <div
                  role="option"
                  aria-selected={false}
                  onClick={() => pick(q)}
                  style={{
                    padding: "9px 12px",
                    cursor: "pointer",
                    color: "#2563eb",
                    fontSize: 13,
                    borderTop: filtered.length ? "1px solid #f1f5f9" : "none",
                  }}
                >
                  ＋ Создать «{q}»
                </div>
              )}
            </div>
            {/* Страховка от пустой выпадашки. Сегодня недостижима: `exists`
                истинен только когда какая-то опция совпала по ключу, а её
                `label.toLowerCase()` тогда совпадает с запросом и по фильтру —
                то есть пустой `filtered` всегда идёт в паре с `canCreate`.
                Держится это не на фильтре, а на свойстве `providerMeta`:
                `label.toLowerCase() === key` в обеих её ветках (у каталожной
                метка — то же имя, у ручной — тримленный ввод). Сломается оно —
                рассуждение развалится, и ветка оживёт. Оставлена намеренно:
                выпадашка объяснит пустоту, а не покажет пустую коробку. */}
            {!filtered.length && !canCreate && (
              <div style={{ padding: "10px 12px", color: "#9ca3af", fontSize: 13 }}>
                Ничего не найдено
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
