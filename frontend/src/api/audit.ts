import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./client";

export interface AuditLogRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  device_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  ts: string;
}

export function useAuditLog(limit = 100) {
  return useQuery({
    queryKey: ["audit", "log", limit],
    queryFn: () => apiGet<AuditLogRow[]>(`/audit/log?limit=${limit}`),
  });
}
