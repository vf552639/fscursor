import React from "react";

import { Badge } from "./ui/Primitives";

const map: Record<string, { variant: string; label: string }> = {
  new: { variant: "gray", label: "NEW" },
  ns_pending: { variant: "yellow", label: "NS_PENDING" },
  provisioning: { variant: "blue", label: "PROVISIONING" },
  site_created: { variant: "blue", label: "SITE_CREATED" },
  ssl_pending: { variant: "yellow", label: "SSL_PENDING" },
  active: { variant: "green", label: "ACTIVE" },
  failed: { variant: "red", label: "FAILED" },
};

export default function StatusBadge({
  status,
  title,
}: {
  status: string;
  title?: string;
}) {
  const item = map[status] ?? { variant: "gray", label: status || "UNKNOWN" };
  return (
    <span title={title}>
      <Badge variant={item.variant}>{item.label}</Badge>
    </span>
  );
}
