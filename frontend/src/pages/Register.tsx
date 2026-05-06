import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";

interface RegisterResult {
  user_id: string;
  recovery_phrase: string;
}

export default function Register() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isTauri()) {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ marginTop: 0 }}>Register</h1>
          <p>Registration runs in the SDMP desktop app (Tauri).</p>
          <Link to="/login">Back to login</Link>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (password !== confirm) {
      setErr("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const res = await invokeIfTauri<RegisterResult>("auth_register", { email, password });
      navigate("/recovery-setup", { state: { phrase: res.recovery_phrase, email } });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ marginTop: 0 }}>Create account</h1>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={input}
            />
          </label>
          <label>
            Master password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={input}
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              style={input}
            />
          </label>
          {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
          <button type="submit" disabled={busy} style={btn}>
            {busy ? "Working (Argon2id)…" : "Register"}
          </button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13 }}>
          <Link to="/login">Already have an account?</Link>
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
};
const card: React.CSSProperties = {
  background: "#fff",
  padding: 28,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  width: "100%",
  maxWidth: 400,
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
