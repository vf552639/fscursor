import React, { useState } from "react";
import { Card, CHd, CTi, CBo, Btn, Modal, Inp } from "../components/ui/Primitives";
import { DesktopOnlyNote } from "../components/DesktopOnlyNote";
import { invokeIfTauri } from "../lib/tauri-invoke";
import { isTauri } from "../lib/runtime";
import { describeCommandError } from "../lib/recoveryError";

const WHAT = "Changing your master password";

/**
 * Единственный UI-путь к `auth_change_password` (и через неё — к `POST /auth/password/change`).
 *
 * Смена пароля стала безопасной только с ключом хранилища: пароль больше не шифрует блобы,
 * он лишь оборачивает VK, поэтому команда перевыпускает соль, ключ аутентификации и обёртку,
 * а сами секреты не трогает вовсе. До перехода тот же экран означал бы «потерять всё», и
 * его поэтому не существовало — обещание «секреты не пострадают» здесь не вежливость, а
 * то единственное, ради чего вся фаза и делалась.
 *
 * В вебе — заглушка, как у recovery: VK живёт в связке ключей ОС, браузеру его не достать,
 * да и веб по устройству продукта ничего не мутирует (CLAUDE.md, принцип 3).
 */
export default function ChangePasswordCard() {
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setOpen(false);
    setOldPassword("");
    setNewPassword("");
    setRepeat("");
    setErr(null);
  };

  const submit = async () => {
    // Опечатка в новом пароле оставила бы обёртку VK под паролем, которого не знает
    // никто, — дорога назад была бы только через recovery-фразу. Дешевле отбить здесь.
    if (newPassword !== repeat) {
      setErr("The new passwords do not match.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      // Ключи аргументов Tauri v2 — camelCase.
      await invokeIfTauri("auth_change_password", { oldPassword, newPassword });
      reset();
      setDone(true);
    } catch (e: unknown) {
      setErr(describeCommandError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginTop: 16 }}>
      <CHd>
        <CTi>🔐 Master password</CTi>
      </CHd>
      <CBo>
        {done && (
          <div style={okBox}>
            <div style={okTitle}>Master password changed</div>
            <div style={okBody}>
              Sign in with the new password from now on. Your recovery phrase still works —
              it wraps the vault key, and that key did not change.
            </div>
          </div>
        )}
        <div style={hint}>
          Your password does not encrypt the secrets themselves: it only wraps the vault key
          that does. Changing it rewraps that key, so every stored secret stays readable and
          nothing is re-encrypted.
        </div>
        {isTauri() ? (
          <Btn
            variant="secondary"
            onClick={() => {
              // Зелёная плашка относится к прошлой смене; висеть над новой формой ей нельзя.
              setDone(false);
              setOpen(true);
            }}
          >
            Change master password
          </Btn>
        ) : (
          <DesktopOnlyNote what={WHAT} />
        )}
      </CBo>
      {open && (
        <Modal title="Change master password" onClose={reset} width={440}>
          <div style={{ fontSize: 13, color: "#374151", marginBottom: 14 }}>
            The new password takes effect immediately, on this and every other device.
          </div>
          <Field label="Current password" value={oldPassword} onChange={setOldPassword} />
          <Field label="New password" value={newPassword} onChange={setNewPassword} />
          <Field label="Repeat new password" value={repeat} onChange={setRepeat} />
          {err && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <Btn
              variant="primary"
              style={{ flex: 1, justifyContent: "center" }}
              disabled={busy || !oldPassword || !newPassword || !repeat}
              onClick={() => void submit()}
            >
              {busy ? "Working (Argon2id)…" : "Change password"}
            </Btn>
            <Btn variant="secondary" style={{ flex: 1, justifyContent: "center" }} onClick={reset}>
              Cancel
            </Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/**
 * Три одинаковых поля подряд; подпись служит и плейсхолдером, потому что все три —
 * `type=password` и по точкам друг от друга неотличимы.
 */
function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={fieldLabel}>{label}</label>
      <Inp
        type="password"
        value={value}
        placeholder={label}
        // `Inp` типизирован как `any` — параметр аннотируем здесь, см. RecoveryPhraseCard.
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    </div>
  );
}

const hint: React.CSSProperties = { fontSize: 12.5, color: "#6b7280", marginBottom: 12 };
const fieldLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "#374151",
  display: "block",
  marginBottom: 6,
};
const okBox: React.CSSProperties = {
  background: "#f0fdf4",
  border: "1px solid #bbf7d0",
  borderRadius: 9,
  padding: "14px 16px",
  marginBottom: 14,
};
const okTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: "#16a34a" };
const okBody: React.CSSProperties = { fontSize: 12.5, color: "#15803d", marginTop: 2 };
