import React from "react";

import { Domain } from "../../api/domains";
import { SSL_BADGE, SslState } from "../../lib/domainFacts";
import { Badge } from "../ui/Primitives";
import DomainExpiryField from "./DomainExpiryField";
import DomainStatusBadge from "./DomainStatusBadge";

/** Приглушённый текст шапки: ярлык, подписи мета-ряда. */
const META_TEXT = "#64748b";

/**
 * Шапка карточки домена: ярлык с бейджем статуса, имя домена и мета-ряд
 * (состояние сертификата, срок домена) плюс своя кнопка закрытия.
 *
 * Заменила строку-сводку (`DomainSummaryBar`), переняв её содержимое целиком —
 * и вместе с ним два решения, которые от переезда не отменяются.
 *
 * **Собственных вычислений здесь нет ни одного, и это правило, а не
 * совпадение.** Статус называет `lib/domainStatus` (через `DomainStatusBadge`),
 * срок — `lib/domainExpiry` (через `DomainExpiryField`), состояние SSL считает
 * модалка одной `sslState` на всю карточку и отдаёт готовым пропсом. Пилюли из
 * макета (99px, свои зелёный и янтарь) здесь поэтому нет: своя лестница
 * состояний рядом с общей — ровно тот дефект, ради которого `lib/domainStatus`
 * и `SSL_BADGE` заведены, и разошлась бы она молча.
 *
 * **Срока и издателя сертификата в мета-ряду НЕТ намеренно** — хотя макет и
 * показывает там `SSL: Valid · until 24.04.2041`. Они живут в секции фактов
 * сервера, где рядом стоит их свежесть, и вторая их копия в двух сантиметрах
 * выше — ровно тот дубль, ради снятия которого карточка пересобрана в августе
 * 2026 (автор макета об этом знать не мог). Шапке хватает состояния.
 *
 * Имя домена — `<h2>`: заголовки карточки идут `h2` (шапка) → `h3` (заголовки
 * секций, `SectionCard`), без пропущенной ступени.
 *
 * Кнопка закрытия — своя: слот `header` у `Modal` заменяет штатную строку
 * «title + ✕» ЦЕЛИКОМ, и без неё модалку нечем было бы закрыть, кроме подложки.
 */
export default function DomainModalHeader({
  domain,
  ssl,
  now,
  onClose,
}: {
  domain: Domain;
  /**
   * Состояние сертификата, посчитанное МОДАЛКОЙ. Пропсом, а не своим вызовом
   * `sslState`: потребителей у этого ответа на карточке несколько, и вторая
   * независимая копия расчёта совпадала бы с первой только до тех пор, пока
   * совпадают аргументы, — то есть «сходилось бы само».
   */
  ssl: SslState;
  /** «Сейчас» карточки: один раз на рендер, общее для всех её сроков. */
  now: number;
  onClose: () => void;
}) {
  const sslBadge = SSL_BADGE[ssl];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 20,
      }}
    >
      {/* `minWidth: 0` — левая половина это flex-элемент, а его минимальная
          ширина по умолчанию равна ширине содержимого: длинное имя домена
          выдавливало бы кнопку закрытия за край, а не переносилось. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: META_TEXT,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Domain
          </span>
          <DomainStatusBadge status={domain.status} />
        </div>
        {/* Перенос по любому месту: доменное имя пробелов не содержит, и
            длинное (`beepbeepkasyno.com.pl` и длиннее) уехало бы за край
            карточки целиком. */}
        <h2
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 700,
            color: "#0f172a",
            letterSpacing: "-0.01em",
            overflowWrap: "anywhere",
          }}
        >
          {domain.domain_name}
        </h2>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            flexWrap: "wrap",
            fontSize: 13,
            color: META_TEXT,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>SSL:</span>
            <Badge variant={sslBadge.variant}>{sslBadge.label}</Badge>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>Expires:</span>
            <DomainExpiryField domain={domain} now={now} />
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        style={{
          border: "none",
          background: "#f1f5f9",
          color: "#475569",
          width: 34,
          height: 34,
          borderRadius: 10,
          fontSize: 16,
          lineHeight: 1,
          cursor: "pointer",
          // Кнопка фиксированного размера в flex-ряду: без этого она сжимается
          // под напором имени домена и перестаёт быть квадратом.
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
