import React from "react";

import { domainStatusLabel, domainStatusVariant } from "../../lib/domainStatus";
import { Badge } from "../ui/Primitives";

/**
 * Бейдж статуса домена. Своей карты статусов у него больше нет: она была одной
 * из двух копий лестницы, и обе разошлись с бэкендом на `ns_ok` — домен в
 * штатном статусе получал серый бейдж «мы такого не знаем». Список живёт в
 * `lib/domainStatus`, здесь остаётся только показ.
 *
 * Имя и место — доменные, а не общие: карта статусов у него ровно одна, из
 * `lib/domainStatus`. `StatusBadge` в общем `components/` звал повесить его на
 * сервер или на задачу, а там любой валидный статус получил бы серый бейдж «мы
 * такого не знаем» — то есть ту самую поломку, из-за которой лестница и
 * заведена.
 */
export default function DomainStatusBadge({
  status,
  title,
}: {
  status: string;
  title?: string;
}) {
  return (
    <span title={title}>
      <Badge variant={domainStatusVariant(status)}>{domainStatusLabel(status)}</Badge>
    </span>
  );
}
