import { describe, it, expect } from "vitest";
import { serverMetrics, formatUptime, auditRowToActivity } from "./dashboardData";

describe("serverMetrics", () => {
  it("maps real server fields instead of zeros", () => {
    const m = serverMetrics({
      cpu_usage_pct: 42,
      ram_used_mb: 2048,
      ram_total_mb: 4096,
      disk_used_gb: 10,
      disk_total_gb: 40,
      uptime_seconds: 172800,
    } as any);
    expect(m.cpu).toBe(42);
    expect(m.ramUsed).toBe(2);
    expect(m.ramTotal).toBe(4);
    expect(m.ssdUsed).toBe(10);
    expect(m.uptime).toBe("2 days");
  });

  it("defaults missing metrics to zero without throwing", () => {
    const m = serverMetrics({} as any);
    expect(m.cpu).toBe(0);
    expect(m.uptime).toBe("0h");
  });

  it("maps ssdTotal from disk_total_gb", () => {
    const m = serverMetrics({ disk_total_gb: 80 } as any);
    expect(m.ssdTotal).toBe(80);
  });

  it("treats null fields the same as missing fields", () => {
    const m = serverMetrics({
      cpu_usage_pct: null,
      ram_used_mb: null,
      ram_total_mb: null,
      disk_used_gb: null,
      disk_total_gb: null,
      uptime_seconds: null,
    } as any);
    expect(m.cpu).toBe(0);
    expect(m.ramUsed).toBe(0);
    expect(m.ramTotal).toBe(0);
    expect(m.ssdUsed).toBe(0);
    expect(m.ssdTotal).toBe(0);
    expect(m.uptime).toBe("0h");
  });

  it("rounds fractional RAM to one decimal place", () => {
    const m = serverMetrics({ ram_used_mb: 1536, ram_total_mb: 3072 } as any);
    expect(m.ramUsed).toBe(1.5);
    expect(m.ramTotal).toBe(3);
  });
});

describe("formatUptime", () => {
  it("uses days when >= 1 day, hours otherwise", () => {
    expect(formatUptime(86400)).toBe("1 day");
    expect(formatUptime(3600)).toBe("1h");
  });

  it("is singular for exactly one day and plural for two", () => {
    expect(formatUptime(86400)).toBe("1 day");
    expect(formatUptime(172800)).toBe("2 days");
  });

  it("falls back to hours just below the one-day boundary", () => {
    expect(formatUptime(86399)).toBe("23h");
  });

  it("returns 0h for zero seconds", () => {
    expect(formatUptime(0)).toBe("0h");
  });
});

describe("auditRowToActivity", () => {
  it("labels a known action and picks the type icon", () => {
    const a = auditRowToActivity({
      id: 7,
      action: "cf.dns.create",
      target_type: "cloudflare_zone",
      target_id: "z1",
      metadata: null,
      ts: "2026-08-02T10:00:00Z",
    } as any);
    expect(a.label).toBe("DNS record created");
    expect(a.icon).toBe("☁");
  });

  it("falls back to the raw action for unknown actions", () => {
    const a = auditRowToActivity({
      id: 8,
      action: "weird.thing",
      target_type: null,
      target_id: null,
      metadata: null,
      ts: "x",
    } as any);
    expect(a.label).toBe("weird.thing");
    expect(a.icon).toBe("·");
  });

  it("uses metadata.domain_name for the target when present", () => {
    const a = auditRowToActivity({
      id: 9,
      action: "domain.create",
      target_type: "domain",
      target_id: "42",
      metadata: { domain_name: "example.com" },
      ts: "x",
    } as any);
    expect(a.target).toBe("example.com");
  });

  it("falls back to target_type and target_id when metadata has no domain_name", () => {
    const a = auditRowToActivity({
      id: 10,
      action: "cf.zone.create",
      target_type: "cloudflare_zone",
      target_id: "z9",
      metadata: null,
      ts: "x",
    } as any);
    expect(a.target).toBe("cloudflare_zone #z9");
  });

  it("produces an empty target when there is neither metadata nor target_id", () => {
    const a = auditRowToActivity({
      id: 11,
      action: "auth.login",
      target_type: null,
      target_id: null,
      metadata: null,
      ts: "x",
    } as any);
    expect(a.target).toBe("");
  });

  it("stringifies numeric ids and carries the timestamp through", () => {
    const a = auditRowToActivity({
      id: 12,
      action: "server.create",
      target_type: "server",
      target_id: "5",
      metadata: null,
      ts: "2026-01-01T00:00:00Z",
    } as any);
    expect(a.id).toBe("12");
    expect(a.ts).toBe("2026-01-01T00:00:00Z");
  });

  it("labels executive cf/registrar/fastpanel actions added this sprint", () => {
    expect(auditRowToActivity({ id: 1, action: "cf.zone.create", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("Zone created");
    expect(auditRowToActivity({ id: 2, action: "cf.dns.update", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("DNS record updated");
    expect(auditRowToActivity({ id: 3, action: "cf.dns.delete", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("DNS record deleted");
    expect(auditRowToActivity({ id: 4, action: "cf.cache_purge", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("Cache purged");
    expect(auditRowToActivity({ id: 5, action: "registrar.ns_set", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("Nameservers set");
    expect(auditRowToActivity({ id: 6, action: "server.fastpanel_install", target_type: null, target_id: null, metadata: null, ts: "x" } as any).label).toBe("FastPanel installed");
  });
});
