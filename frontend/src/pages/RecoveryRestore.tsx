import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";

export default function RecoveryRestore() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isTauri()) {
    return (
      <div style={wrap}>
        <div style={card}>
          <p>Account recovery is available in the desktop app.</p>
          <Link to="/login">Login</Link>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await invokeIfTauri<string>("auth_recovery", {
        email,
        phrase: phrase.trim().replace(/\s+/g, " "),
        new_password: password,
      });
      navigate("/login", { state: { notice: "Recovery complete. Sign in with your new password." } });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <div style={{ ...card, maxWidth: 440 }}>
        <h1 style={{ marginTop: 0 }}>Recover account</h1>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={input} />
          </label>
          <label>
            24-word recovery phrase
            <textarea
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              rows={4}
              required
              style={{ ...input, fontFamily: "ui-monospace, monospace" }}
            />
          </label>
          <label>
            New master password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={input}
            />
          </label>
          {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
          <button type="submit" disabled={busy} style={btn}>
            {busy ? "Submitting…" : "Reset password"}
          </button>
        </form>
        <p style={{ marginTop: 12 }}>
          <Link to="/login">Back to login</Link>
        </p>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#f3f4f6",
  padding: 16,
};
const card: React.CSSProperties = {
  background: "#fff",
  padding: 28,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  width: "100%",
};
const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  boxSizing: "border-box",
};
const btn: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "none",
  background: "#2563eb",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
