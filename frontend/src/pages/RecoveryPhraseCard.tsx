import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CHd, CTi, CBo, Btn, Modal, Inp } from "../components/ui/Primitives";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { describeCommandError } from "../lib/recoveryError";
import { useAuthStore } from "../store/auth";

interface RecoverySetupResult {
  user_id: string;
  recovery_phrase: string;
}

/**
 * Единственный UI-путь к `POST /auth/recovery/setup`.
 *
 * Без него текст 409 из `/auth/recovery/finish` («войдите и настройте recovery заново»)
 * вёл в никуда: команда `auth_recovery_setup` существовала, но её никто не вызывал.
 * Аккаунты, заведённые до миграции 014, держат `recovery_auth_key_hash = NULL` и
 * восстановиться не могут — узнать об этом они должны здесь, а не в момент, когда
 * пароль уже потерян.
 *
 * `status === null` — сервер не сообщил (бэкенд старше 014). Тогда карточка не
 * утверждает ничего: ложное «не настроено» подтолкнуло бы перевыпустить фразу и
 * обесценить ту, что уже лежит записанной на бумаге.
 */
export default function RecoveryPhraseCard() {
  const navigate = useNavigate();
  const email = useAuthStore((s) => s.email);
  const [status, setStatus] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    invokeIfTauri<boolean | null>("auth_recovery_status")
      .then((v) => {
        if (alive) setStatus(v ?? null);
      })
      .catch(() => {
        // Статус — подсказка, а не функциональность: перевыпуск доступен в любом случае.
        if (alive) setStatus(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await invokeIfTauri<RecoverySetupResult>("auth_recovery_setup", { password });
      setPassword("");
      setOpen(false);
      // Фраза существует только в этом ответе — сервер хранит лишь bcrypt-хеш
      // выведенного из неё ключа и показать её повторно не сможет.
      navigate("/recovery-setup", {
        state: { phrase: res.recovery_phrase, email: email ?? "", mode: "reconfigure" },
      });
    } catch (e: unknown) {
      setErr(describeCommandError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isTauri()) return null;

  return (
    <Card style={{ marginTop: 16 }}>
      <CHd>
        <CTi>🧩 Recovery phrase</CTi>
      </CHd>
      <CBo>
        {loading ? (
          <div style={{ fontSize: 13, color: "#6b7280" }}>Checking recovery status…</div>
        ) : status === false ? (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 9,
              padding: "14px 16px",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "#b91c1c" }}>
              This account cannot be recovered
            </div>
            <div style={{ fontSize: 12.5, color: "#991b1b", marginTop: 2 }}>
              No recovery key is on file (the account predates the recovery-proof update). If you
              forget your master password, your data is unrecoverable. Generate a phrase now.
            </div>
          </div>
        ) : status === true ? (
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: 9,
              padding: "14px 16px",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "#16a34a" }}>
              Recovery phrase is configured
            </div>
            <div style={{ fontSize: 12.5, color: "#15803d", marginTop: 2 }}>
              Your 24 words can restore access if you forget your master password.
            </div>
          </div>
        ) : null}
        <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 12 }}>
          Generating a new phrase replaces the old one immediately — every previously written copy
          stops working. Your master password and stored secrets are not affected.
        </div>
        <Btn variant={status === false ? "primary" : "secondary"} onClick={() => setOpen(true)}>
          {status === false ? "Set up recovery phrase" : "Generate a new recovery phrase"}
        </Btn>
      </CBo>
      {open && (
        <Modal
          title="Generate a new recovery phrase"
          onClose={() => {
            setOpen(false);
            setPassword("");
            setErr(null);
          }}
          width={440}
        >
          <div style={{ fontSize: 13, color: "#374151", marginBottom: 14 }}>
            Enter your master password to confirm. The new 24 words are shown once, on the next
            screen.
          </div>
          <label style={{ fontSize: 12, fontWeight: 500, color: "#374151", display: "block", marginBottom: 6 }}>
            Master password
          </label>
          <Inp
            type="password"
            value={password}
            // `Inp` типизирован как `any`, поэтому параметр аннотируем здесь —
            // иначе это ещё одна implicit-any строка в общем долге tsc.
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          {err && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <Btn
              variant="primary"
              style={{ flex: 1, justifyContent: "center" }}
              disabled={busy || !password}
              onClick={() => void submit()}
            >
              {busy ? "Working (Argon2id)…" : "Generate phrase"}
            </Btn>
            <Btn
              variant="secondary"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={() => {
                setOpen(false);
                setPassword("");
                setErr(null);
              }}
            >
              Cancel
            </Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}
