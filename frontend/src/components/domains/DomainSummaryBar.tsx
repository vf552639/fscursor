import React from "react";

import { Domain } from "../../api/domains";
import { NO_VALUE, expiryState, expiryTextColor, formatExpiry, formatExpiryDate } from "../../lib/domainExpiry";
import { SSL_BADGE, sslState } from "../../lib/domainFacts";
import { Badge } from "../ui/Primitives";
import DomainStatusBadge from "./DomainStatusBadge";

/**
 * Значение поля со сроком: дата и «сколько осталось» рядом, цветом состояния.
 * Дата без остатка требует считать в уме, остаток без даты нечем сверить с
 * письмом регистратора.
 *
 * Приехало сюда из `DomainDetailModal` вместе со сроком домена — переносом, без
 * правок: там у него читателей не осталось.
 *
 * Неизвестный срок отдаёт `null`, а не прочерк: прочерк дорисовывает место
 * показа, и он ТОТ ЖЕ (`NO_VALUE` из `lib/domainExpiry`), что у остальных
 * пустых значений карточки, а не второй, похожий. Три копии этого литерала по
 * файлам уже начинали жить своей жизнью.
 *
 * Дата — оттуда же (`formatExpiryDate`), а не из общего `fmtDate`: `expiry_date`
 * приходит датой без времени, и печатать её надо в UTC, иначе западнее UTC
 * карточка называет вчерашний день.
 */
function expiryValue(iso: string | null | undefined, now: number): React.ReactNode {
  const state = expiryState(iso, now);
  if (state === "unknown") return null;
  return (
    <span style={{ color: expiryTextColor(state) }}>
      {formatExpiryDate(iso)} · {formatExpiry(iso, now)}
    </span>
  );
}

/**
 * Строка-сводка карточки домена: статус, срок домена и состояние сертификата —
 * три ответа, ради которых карточку чаще всего и открывают.
 *
 * Собственных вычислений здесь нет ни одного, и это правило, а не совпадение:
 * статус называет `lib/domainStatus` (через `DomainStatusBadge`), срок —
 * `lib/domainExpiry`, состояние SSL — `sslState` с картой `SSL_BADGE` из
 * `lib/domainFacts`. Тот же `sslState` питает бейдж в секции «Server state»
 * ниже, поэтому разойтись эти два бейджа не могут по построению: непроверенный
 * домен получит серый «Not checked» в обоих местах, а не зелёный в одном
 * (принцип №6 CLAUDE.md).
 *
 * Срока и издателя сертификата здесь НЕТ намеренно: они живут в «Server state»,
 * и вторая их копия в двух сантиметрах выше — ровно тот дубль, ради снятия
 * которого карточка и пересобрана. Сводке хватает состояния.
 *
 * `now` приходит пропсом: карточка читает часы один раз на рендер и раздаёт это
 * «сейчас» всем своим детям — иначе два срока на одном экране отвечали бы на
 * «сейчас» по-разному.
 */
export default function DomainSummaryBar({ domain, now }: { domain: Domain; now: number }) {
  const ssl = SSL_BADGE[sslState(domain.fp_facts?.ssl, domain.fp_facts_at, now)];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        fontSize: 13,
        color: "#374151",
      }}
    >
      <DomainStatusBadge status={domain.status} />
      <span>
        <b>Expires:</b> {expiryValue(domain.expiry_date, now) ?? NO_VALUE}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <b>SSL:</b>
        <Badge variant={ssl.variant}>{ssl.label}</Badge>
      </span>
    </div>
  );
}
