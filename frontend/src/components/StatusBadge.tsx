import React from "react";

import { domainStatusLabel, domainStatusVariant } from "../lib/domainStatus";
import { Badge } from "./ui/Primitives";

/**
 * Бейдж статуса домена. Своей карты статусов у него больше нет: она была одной
 * из двух копий лестницы, и обе разошлись с бэкендом на `ns_ok` — домен в
 * штатном статусе получал серый бейдж «мы такого не знаем». Список живёт в
 * `lib/domainStatus`, здесь остаётся только показ.
 */
export default function StatusBadge({
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
