import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { useAuthStore } from "../store/auth";

export default function Lock() {
  const navigate = useNavigate();
  const { userId, email, setUnlocked } = useAuthStore();
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isTauri() || !userId || !email) {
    navigate("/login", { replace: true });
    return null;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await invokeIfTauri<string>("auth_login", {
        email,
        password,
        totp_code: totp.trim() || null,
      });
      setUnlocked(true);
      navigate("/", { replace: true });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f3f4f6",
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: 28,
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          width: "100%",
          maxWidth: 400,
        }}
      >
        <h1 style={{ marginTop: 0 }}>Unlock vault</h1>
        <p style={{ color: "#6b7280", fontSize: 14 }}>{email}</p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Master password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
                boxSizing: "border-box",
              }}
            />
          </label>
          <label>
            TOTP (if enabled)
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
                boxSizing: "border-box",
              }}
            />
          </label>
          {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "none",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
