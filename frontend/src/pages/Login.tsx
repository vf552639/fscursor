import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { useAuthStore } from "../store/auth";
import { apiPost } from "../api/client";
import { deriveAuthKey } from "../lib/crypto";
import { b64ToU8, u8ToB64 } from "../lib/b64";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;
  const setUser = useAuthStore((s) => s.setUser);
  const setUnlocked = useAuthStore((s) => s.setUnlocked);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitWeb = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { salt_b64 } = await apiPost<{ salt_b64: string }>("/auth/login/start", { email });
      const salt = b64ToU8(salt_b64);
      const authKey = await deriveAuthKey(password, salt);
      const { user_id } = await apiPost<{ user_id: string }>("/auth/login/finish", {
        email,
        auth_key_b64: u8ToB64(authKey),
        totp_code: totp.trim() || null,
      });
      setUser(user_id, email);
      navigate("/");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isTauri()) {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ marginTop: 0 }}>Sign in</h1>
          <p style={{ fontSize: 13, color: "#6b7280" }}>
            Read-only web dashboard. Actions that change infrastructure open in the SDMP desktop app.
          </p>
          {notice && (
            <div style={{ background: "#eff6ff", padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
              {notice}
            </div>
          )}
          <form onSubmit={(e) => void submitWeb(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={input} />
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
              TOTP (if enabled)
              <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="optional" style={input} />
            </label>
            {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
            <button type="submit" disabled={busy} style={btn}>
              {busy ? "Signing in…" : "Login"}
            </button>
          </form>
          <p style={{ marginTop: 16, fontSize: 13 }}>
            <Link to="/register">Create account</Link>
            {" · "}
            <Link to="/recover">Forgot password?</Link>
          </p>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const userId = await invokeIfTauri<string>("auth_login", {
        email,
        password,
        totp_code: totp.trim() || null,
      });
      setUser(userId, email);
      setUnlocked(true);
      try {
        await invokeIfTauri("sync_init", { user_id: userId });
        await invokeIfTauri<number>("sync_now", { user_id: userId });
      } catch {
        /* sync optional on first login */
      }
      navigate("/");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        {notice && (
          <div style={{ background: "#eff6ff", padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
            {notice}
          </div>
        )}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={input} />
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
            TOTP (if enabled)
            <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="optional" style={input} />
          </label>
          {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
          <button type="submit" disabled={busy} style={btn}>
            {busy ? "Signing in…" : "Login"}
          </button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13 }}>
          <Link to="/register">Create account</Link>
          {" · "}
          <Link to="/recover">Forgot password?</Link>
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
