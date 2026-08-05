import React, { useState } from "react";
import { apiPost } from "../api/client";
import { deriveMasterKey } from "../lib/crypto";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore, bumpMasterKeyActivity } from "../store/auth";
import { Btn, Inp, Modal } from "./ui/Primitives";

export function UnlockModal({ onClose }: { onClose: () => void }) {
  const email = useAuthStore((s) => s.email);
  const setMasterKey = useAuthStore((s) => s.setMasterKey);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function unlock() {
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      const { salt_b64 } = await apiPost<{ salt_b64: string }>("/auth/login/start", { email });
      const salt = b64ToU8(salt_b64);
      const key = await deriveMasterKey(password, salt);
      setMasterKey(key);
      bumpMasterKeyActivity();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="Unlock" onClose={onClose} width={440}>
      <p style={{ marginTop: 0, fontSize: 13, color: "#6b7280" }}>
        Enter your master password to view secrets. It stays in this browser tab only.
      </p>
      <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>
        Master password
      </label>
      <Inp
        type="password"
        value={password}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword((e.target as HTMLInputElement).value)}
      />
      {error ? (
        <p style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{error}</p>
      ) : null}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <Btn variant="secondary" style={{ flex: 1, justifyContent: "center" }} onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => void unlock()} disabled={loading || !password}>
          {loading ? "Unlocking…" : "Unlock"}
        </Btn>
      </div>
    </Modal>
  );
}
