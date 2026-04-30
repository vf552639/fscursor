import React, { useMemo, useState } from "react";

import {
  Domain,
  useCancelSsl,
  useCheckNs,
  useCreateDb,
  useCreateSite,
  useDbCredentials,
  useGetNginxOverride,
  useMarkNsSet,
  useRefreshSsl,
  useRequestSsl,
  useSetNginxOverride,
  useSetNameservers,
} from "../api/domains";
import { Btn, Modal } from "./ui/Primitives";

type Tab = "overview" | "db" | "ssl" | "nginx" | "ns";

export default function DomainDetailModal({
  domain,
  onClose,
}: {
  domain: Domain;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [snippet, setSnippet] = useState("");
  const [presets, setPresets] = useState({
    force_https: false,
    www_redirect: false,
    custom_404: false,
    basic_auth: false,
  });

  const createSite = useCreateSite();
  const createDb = useCreateDb();
  const dbCreds = useDbCredentials(domain.id);
  const requestSsl = useRequestSsl();
  const cancelSsl = useCancelSsl();
  const refreshSsl = useRefreshSsl();
  const setNs = useSetNameservers(domain.id);
  const markNs = useMarkNsSet();
  const checkNs = useCheckNs();
  const setNginx = useSetNginxOverride();
  const nginxOverride = useGetNginxOverride(domain.id);
  const [actionError, setActionError] = useState<string | null>(null);

  React.useEffect(() => {
    if (nginxOverride.data) {
      setSnippet(nginxOverride.data.snippet || "");
      const p = nginxOverride.data.presets || {};
      setPresets({
        force_https: Boolean(p.force_https),
        www_redirect: Boolean(p.www_redirect),
        custom_404: Boolean(p.custom_404),
        basic_auth: Boolean(p.basic_auth),
      });
    }
  }, [nginxOverride.data]);

  const sslLabel = useMemo(() => {
    if (domain.ssl_status === "active") return `Active${domain.ssl_expires_at ? ` (exp: ${new Date(domain.ssl_expires_at).toLocaleDateString()})` : ""}`;
    if (domain.ssl_status === "pending") return "Pending";
    if (domain.ssl_status === "error") return "Error";
    return "None";
  }, [domain.ssl_expires_at, domain.ssl_status]);

  return (
    <Modal title={`Domain: ${domain.domain_name}`} onClose={onClose} width={760}>
      {actionError ? (
        <div style={{ marginBottom: 10, fontSize: 12.5, color: "#991b1b", background: "#fee2e2", borderRadius: 8, padding: "8px 10px" }}>
          {actionError}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["overview", "db", "ssl", "nginx", "ns"] as Tab[]).map((t) => (
          <Btn key={t} variant={tab === t ? "primary" : "secondary"} size="sm" onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </Btn>
        ))}
      </div>

      {tab === "overview" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 8 }}>
          <div><b>Status:</b> {domain.status}</div>
          <div><b>Server:</b> {domain.server_id ?? "—"}</div>
          <div><b>Registrar:</b> {domain.registrar_id ?? "—"}</div>
          <div><b>Cloudflare:</b> {domain.cloudflare_account_id ?? "—"}</div>
          <div><b>NS:</b> {domain.ns_status ?? "pending"} ({domain.ns_check_mode ?? "auto"})</div>
          <div><b>Last error:</b> {domain.last_provision_error || "—"}</div>
          <div style={{ marginTop: 10 }}>
            <Btn
              variant="secondary"
              onClick={() => createSite.mutate({ domainId: domain.id, site_only: true }, { onError: (e: any) => setActionError(e?.message || "Create site failed") })}
              disabled={createSite.isPending}
            >
              {createSite.isPending ? "Starting..." : "Create Site"}
            </Btn>
          </div>
        </div>
      )}

      {tab === "db" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>DB name:</b> {dbCreds.data?.db_name ?? domain.db_name ?? "—"}</div>
          <div><b>DB user:</b> {dbCreds.data?.db_user ?? domain.db_user ?? "—"}</div>
          <div><b>DB password:</b> {dbCreds.data?.db_password ?? "—"}</div>
          <Btn variant="secondary" onClick={() => createDb.mutate(domain.id)} disabled={createDb.isPending}>
            {createDb.isPending ? "Creating..." : "Create DB"}
          </Btn>
        </div>
      )}

      {tab === "ssl" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>Status:</b> {sslLabel}</div>
          <div><b>Issuer:</b> {domain.ssl_issuer ?? "—"}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={() => requestSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Request SSL failed") })} disabled={requestSsl.isPending}>
              Request SSL
            </Btn>
            <Btn variant="secondary" onClick={() => refreshSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Refresh SSL failed") })} disabled={refreshSsl.isPending}>
              Refresh SSL
            </Btn>
            <Btn variant="danger" onClick={() => cancelSsl.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Cancel SSL failed") })} disabled={cancelSsl.isPending}>
              Cancel SSL
            </Btn>
          </div>
        </div>
      )}

      {tab === "nginx" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <label><input type="checkbox" checked={presets.force_https} onChange={(e) => setPresets((p) => ({ ...p, force_https: e.target.checked }))} /> Force HTTPS</label>
          <label><input type="checkbox" checked={presets.www_redirect} onChange={(e) => setPresets((p) => ({ ...p, www_redirect: e.target.checked }))} /> www -&gt; non-www</label>
          <label><input type="checkbox" checked={presets.custom_404} onChange={(e) => setPresets((p) => ({ ...p, custom_404: e.target.checked }))} /> custom 404</label>
          <label><input type="checkbox" checked={presets.basic_auth} onChange={(e) => setPresets((p) => ({ ...p, basic_auth: e.target.checked }))} /> basic auth</label>
          <textarea
            value={snippet}
            onChange={(e) => setSnippet(e.target.value)}
            placeholder="Custom nginx snippet"
            style={{ width: "100%", minHeight: 140, borderRadius: 8, border: "1px solid #e5e7eb", padding: 8, fontFamily: "monospace" }}
          />
          <div style={{ fontSize: 12, color: "#6b7280", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap" }}>
            Preview:
            {"\n"}
            {(presets.force_https ? "if ($scheme = http) { return 301 https://$host$request_uri; }\n" : "") +
              (presets.www_redirect ? `if ($host = "www.${domain.domain_name}") { return 301 https://${domain.domain_name}$request_uri; }\n` : "") +
              snippet}
          </div>
          <Btn
            variant="secondary"
            onClick={() =>
              setNginx.mutate(
                { domainId: domain.id, data: { snippet, presets } },
                { onError: (e: any) => setActionError(e?.message || "Save nginx override failed") }
              )
            }
            disabled={setNginx.isPending}
          >
            Save and Reload nginx
          </Btn>
        </div>
      )}

      {tab === "ns" && (
        <div style={{ fontSize: 13, color: "#374151", display: "grid", gap: 10 }}>
          <div><b>NS status:</b> {domain.ns_status ?? "pending"}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="secondary" onClick={() => checkNs.mutate(domain.id, { onError: (e: any) => setActionError(e?.message || "Check NS failed") })} disabled={checkNs.isPending}>Check NS</Btn>
            <Btn variant="secondary" onClick={() => markNs.mutate({ domainId: domain.id, set: true }, { onError: (e: any) => setActionError(e?.message || "Mark NS set failed") })} disabled={markNs.isPending}>Mark NS set</Btn>
            <Btn variant="secondary" onClick={() => markNs.mutate({ domainId: domain.id, set: false }, { onError: (e: any) => setActionError(e?.message || "Unmark NS failed") })} disabled={markNs.isPending}>Unmark NS</Btn>
            <Btn variant="secondary" onClick={() => setNs.mutate(undefined, { onError: (e: any) => setActionError(e?.message || "Set NS failed") })} disabled={setNs.isPending}>Set NS</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
