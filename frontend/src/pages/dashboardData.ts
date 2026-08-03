import type { Server } from "../api/servers";
import type { AuditLogRow } from "../api/audit";

/**
 * Метрики сервера. `null` — «данных нет», и это НЕ то же самое, что 0: ничего
 * в продукте эти поля пока не пишет (сборщика нет, роут refresh-metrics на
 * бэкенде отсутствует), поэтому подстановка нулей рисовала бы «здоровый
 * простаивающий сервер» там, где мы просто ничего не знаем. Рендерить `null`
 * как «—», по образцу ServerDetail.tsx.
 */
export interface ServerMetrics {
  cpu: number | null;
  ramUsed: number | null;
  ramTotal: number | null;
  ssdUsed: number | null;
  ssdTotal: number | null;
  uptime: string | null;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const mapNum = <T>(v: number | null | undefined, f: (n: number) => T): T | null =>
  v === null || v === undefined ? null : f(v);

export function serverMetrics(s: Server): ServerMetrics {
  return {
    cpu: mapNum(s.cpu_usage_pct, Math.round),
    ramUsed: mapNum(s.ram_used_mb, (n) => round1(n / 1024)),
    ramTotal: mapNum(s.ram_total_mb, (n) => round1(n / 1024)),
    ssdUsed: mapNum(s.disk_used_gb, Math.round),
    ssdTotal: mapNum(s.disk_total_gb, Math.round),
    uptime: mapNum(s.uptime_seconds, formatUptime),
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
export const ACTION_LABELS: Record<string, string> = {
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
// desktop Tauri commands: "cloudflare_zone" for cf.zone/cf.dns/cf.cache_purge —
// but "domain" is also emitted from the desktop side, by registrar.ns_set and
// device.action.complete, not just the backend domain routes).
const TYPE_ICONS: Record<string, string> = {
  domain: "◎",
  server: "🖥",
  cloudflare_zone: "☁",
  cloudflare_account: "☁",
  registrar_account: "📋",
};

// The backend never stores an "expiring" ssl_status — the column is one of
// none/pending/active/error (see backend/app/models/domain.py). "Expiring
// soon" is derived here from ssl_expires_at on an active cert.
const SSL_EXPIRING_SOON_DAYS = 30;

export function isSslExpiringSoon(
  sslStatus: string | null | undefined,
  sslExpiresAt: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (sslStatus !== "active" || !sslExpiresAt) return false;
  const expires = new Date(sslExpiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  const daysLeft = (expires.getTime() - now.getTime()) / 86400000;
  return daysLeft <= SSL_EXPIRING_SOON_DAYS;
}

export function auditRowToActivity(row: AuditLogRow): ActivityItem {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  // `||`, not `??`: an empty-string domain_name is deliberately treated as
  // absent too, since falling through to the `type #id` fallback is more
  // useful than rendering a blank target.
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
