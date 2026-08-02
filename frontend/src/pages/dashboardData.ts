import type { Server } from "../api/servers";
import type { AuditLogRow } from "../api/audit";

export interface ServerMetrics {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  ssdUsed: number;
  ssdTotal: number;
  uptime: string;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function serverMetrics(s: Server): ServerMetrics {
  return {
    cpu: Math.round(s.cpu_usage_pct ?? 0),
    ramUsed: round1((s.ram_used_mb ?? 0) / 1024),
    ramTotal: round1((s.ram_total_mb ?? 0) / 1024),
    ssdUsed: Math.round(s.disk_used_gb ?? 0),
    ssdTotal: Math.round(s.disk_total_gb ?? 0),
    uptime: formatUptime(s.uptime_seconds ?? 0),
  };
}

export interface ActivityItem {
  id: string;
  icon: string;
  label: string;
  target: string;
  ts: string;
}

// Keep in sync with backend/app/audit/service.py::SAFE_ACTIONS — the server
// rejects anything not in that allow-list, so every action that can actually
// reach us should have a human label here.
const ACTION_LABELS: Record<string, string> = {
  "domain.create": "Domain created",
  "domain.update": "Domain updated",
  "domain.delete": "Domain deleted",
  "server.create": "Server added",
  "server.update": "Server updated",
  "server.delete": "Server deleted",
  "server.fastpanel_install": "FastPanel installed",
  "cf.account.create": "Cloudflare account added",
  "cf.account.update": "Cloudflare account updated",
  "cf.account.delete": "Cloudflare account removed",
  "registrar.account.create": "Registrar account added",
  "registrar.account.update": "Registrar account updated",
  "registrar.account.delete": "Registrar account removed",
  "cf.zone.create": "Zone created",
  "cf.dns.create": "DNS record created",
  "cf.dns.update": "DNS record updated",
  "cf.dns.delete": "DNS record deleted",
  "cf.cache_purge": "Cache purged",
  "registrar.ns_set": "Nameservers set",
  "device.action.start": "Action started",
  "device.action.complete": "Provisioned",
  "device.action.fail": "Action failed",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.password_change": "Password changed",
  "auth.recovery": "Account recovered",
  "auth.totp_enable": "Two-factor enabled",
};

// Matches the target_type strings audit.log callers actually pass (backend
// routes: "server", "domain", "registrar_account", "cloudflare_account";
// desktop Tauri commands: "cloudflare_zone" for cf.zone/cf.dns/cf.cache_purge).
const TYPE_ICONS: Record<string, string> = {
  domain: "◎",
  server: "🖥",
  cloudflare_zone: "☁",
  cloudflare_account: "☁",
  registrar_account: "📋",
};

export function auditRowToActivity(row: AuditLogRow): ActivityItem {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const target =
    (meta.domain_name as string) ||
    (row.target_id ? `${row.target_type ?? ""} #${row.target_id}`.trim() : "");
  return {
    id: String(row.id),
    icon: TYPE_ICONS[row.target_type ?? ""] ?? "·",
    label: ACTION_LABELS[row.action] ?? row.action,
    target,
    ts: row.ts,
  };
}
