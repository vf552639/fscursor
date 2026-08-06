import React, { useState } from "react";

import { bulkImportServers, ServerBulkImportResponse } from "../api/servers";
import { Btn, Modal } from "./ui/Primitives";

export default function ServerBulkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: ServerBulkImportResponse) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ServerBulkImportResponse | null>(null);

  const submit = async () => {
    if (!file) {
      setError("Select CSV or XLSX file");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const imported = await bulkImportServers({ file, hasHeader, onProgress: setProgress });
      setProgress(100);
      setResult(imported);
      onImported(imported);
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Bulk import servers" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label style={{ fontSize: 13, color: "#374151" }}>
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => setHasHeader(e.target.checked)}
            style={{ marginRight: 8 }}
          />
          File has header row
        </label>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          Format: <code>name,ip,ssh_user,ssh_password,ssh_port,provider</code> (provider optional)
        </div>
        {error ? (
          <div style={{ fontSize: 12.5, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 8 }}>
            {error}
          </div>
        ) : null}
        {loading ? (
          <div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>Uploading: {progress}%</div>
            <div style={{ height: 8, background: "#e5e7eb", borderRadius: 999 }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "#2563eb", borderRadius: 999 }} />
            </div>
          </div>
        ) : null}
        {result ? (
          <div style={{ fontSize: 12.5, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}>
            Imported: <b>{result.created}</b>, skipped: <b>{result.skipped}</b>, errors: <b>{result.errors.length}</b>
            {result.errors_csv_url ? (
              <div style={{ marginTop: 8 }}>
                <a href={`/api${result.errors_csv_url}`} target="_blank" rel="noreferrer">
                  Download errors CSV
                </a>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={submit} disabled={loading || !!result}>
          {loading ? "Importing..." : "Import"}
        </Btn>
      </div>
    </Modal>
  );
}
