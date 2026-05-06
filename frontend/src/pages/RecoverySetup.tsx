import React, { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

type LocState = { phrase: string; email: string };

function pickFourIndices(): number[] {
  const xs = Array.from({ length: 24 }, (_, i) => i);
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs.slice(0, 4).sort((a, b) => a - b);
}

export default function RecoverySetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocState | null;
  const phrase = state?.phrase ?? "";
  const words = useMemo(() => phrase.split(/\s+/).filter(Boolean), [phrase]);
  const checks = useMemo(() => pickFourIndices(), [phrase]);
  const [inputs, setInputs] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);

  if (!phrase || words.length !== 24) {
    return (
      <div style={wrap}>
        <div style={card}>
          <p>Missing recovery phrase. Start from <Link to="/register">register</Link>.</p>
        </div>
      </div>
    );
  }

  const ok =
    checks.every((i) => inputs[i]?.trim().toLowerCase() === words[i].toLowerCase());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!ok) {
      setErr("Check the highlighted words match your phrase.");
      return;
    }
    navigate("/login", { state: { notice: "Confirm your email (check dev logs), then sign in." } });
  };

  return (
    <div style={wrap}>
      <div style={{ ...card, maxWidth: 560 }}>
        <h1 style={{ marginTop: 0 }}>Save your recovery phrase</h1>
        <p style={{ color: "#6b7280", fontSize: 14 }}>
          Write these 24 words down offline. Anyone with this phrase can recover your vault.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          {words.map((w, i) => (
            <div key={i} style={{ padding: "6px 8px", background: "#f9fafb", borderRadius: 6 }}>
              <span style={{ color: "#9ca3af", marginRight: 6 }}>{i + 1}</span>
              {w}
            </div>
          ))}
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontWeight: 600 }}>Type back these words:</p>
          {checks.map((i) => (
            <label key={i}>
              Word {i + 1}
              <input
                value={inputs[i] ?? ""}
                onChange={(e) => setInputs((s) => ({ ...s, [i]: e.target.value }))}
                style={input}
                autoComplete="off"
              />
            </label>
          ))}
          {err && <div style={{ color: "#b91c1c", fontSize: 13 }}>{err}</div>}
          <button type="submit" disabled={!ok} style={{ ...btn, opacity: ok ? 1 : 0.5 }}>
            I’ve saved my recovery phrase
          </button>
        </form>
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
