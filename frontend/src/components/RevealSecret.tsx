import React, { useEffect, useRef, useState } from "react";
import { apiGet } from "../api/client";
import { decryptBlob } from "../lib/crypto";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore, bumpMasterKeyActivity } from "../store/auth";
import { Btn } from "./ui/Primitives";
import { UnlockModal } from "./UnlockModal";

export function RevealSecret({
  blobId,
  label,
}: {
  blobId: string | null | undefined;
  label: string;
}) {
  const masterKey = useAuthStore((s) => s.masterKey);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  if (!blobId) {
    return <span style={{ fontSize: 13, color: "#9ca3af" }}>—</span>;
  }

  async function reveal() {
    setErr(null);
    if (!masterKey) {
      setShowUnlock(true);
      return;
    }
    setBusy(true);
    try {
      bumpMasterKeyActivity();
      const blob = await apiGet<{ ciphertext_b64: string }>(`/blobs/${blobId}`);
      const framed = b64ToU8(blob.ciphertext_b64);
      const keyCopy = new Uint8Array(masterKey);
      const pt = await decryptBlob(framed, keyCopy);
      keyCopy.fill(0);
      setPlaintext(new TextDecoder().decode(pt));
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setPlaintext(null), 30_000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {plaintext ? (
        <code style={{ fontSize: 13, background: "#f3f4f6", padding: "4px 8px", borderRadius: 6 }}>{plaintext}</code>
      ) : (
        <Btn size="sm" variant="secondary" onClick={() => void reveal()} disabled={busy}>
          {busy ? "Loading…" : label}
        </Btn>
      )}
      {err ? <span style={{ marginLeft: 8, fontSize: 12, color: "#b91c1c" }}>{err}</span> : null}
      {showUnlock ? <UnlockModal onClose={() => setShowUnlock(false)} /> : null}
    </>
  );
}
