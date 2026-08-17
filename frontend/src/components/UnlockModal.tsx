import React, { useState } from "react";
import { apiGet, ApiError } from "../api/client";
import { deriveMasterKey, unwrapVaultKey } from "../lib/crypto";
import { b64ToU8 } from "../lib/b64";
import { useAuthStore, bumpVaultKeyActivity } from "../store/auth";
import { Btn, Inp, Modal } from "./ui/Primitives";

/** Ровно те поля `/auth/me`, которые нужны для разблокировки. */
interface MeCryptoFields {
  salt_b64: string;
  /** `null` — аккаунт заведён до перехода на ключ хранилища: обёртки ещё нет. */
  wrapped_vault_key_b64: string | null;
}

/**
 * Сессия кончилась, пока модалка была открыта (или её открыли на протухшей вкладке).
 * `/auth/me` отвечает 401, и без этой ветки его `detail` рисуется под полем пароля —
 * то есть ошибка сессии читается как «пароль не тот». Раньше пути не было вовсе:
 * соль брали анонимным `POST /auth/login/start`, и 401 здесь взяться было неоткуда.
 */
const SESSION_EXPIRED = "Your session has expired. Sign in again, then unlock.";

/**
 * Password → KEK → vault key. Two steps, and the second is the whole point: the password
 * only unwraps the key the blobs are encrypted with, so changing the password (or running
 * recovery) rewraps that key and leaves every stored secret readable.
 *
 * Salt and wrapper both come from `/auth/me` — one authenticated call. The old anonymous
 * `POST /auth/login/start` handed out a salt for any email, and this screen is opened by a
 * user who is already signed in; there was never a reason to ask unauthenticated.
 */
export function UnlockModal({ onClose }: { onClose: () => void }) {
  const setVaultKey = useAuthStore((s) => s.setVaultKey);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function unlock() {
    setLoading(true);
    setError(null);
    try {
      const me = await apiGet<MeCryptoFields>("/auth/me");
      const kek = await deriveMasterKey(password, b64ToU8(me.salt_b64));
      if (!me.wrapped_vault_key_b64) {
        // До перехода VK := KEK, и блобы такого аккаунта зашифрованы именно им.
        // Обёртку заведёт десктоп (`/auth/vault-key/init`) — веб ничего не мутирует.
        //
        // Сверять здесь не с чем: обёртки нет, а значит нет и проверки пароля. Неверный
        // пароль «разблокирует» успешно, модалка закроется, а провал всплывёт позже в
        // `RevealSecret` сырым «decrypt failed» — про пароль там не будет ни слова, и
        // посоветовать фразу восстановления оттуда нельзя (мы не знаем, что виноват
        // пароль). Криптографически иначе и не выйдет: пока сервер не хранит ничего,
        // что открывается ключом, отличить верный ключ от неверного не по чему.
        // Лечится это не здесь, а первым запуском десктопа: он заводит обёртку, после
        // чего аккаунт попадает в ветку ниже — с диагностикой.
        setVaultKey(kek);
      } else {
        try {
          setVaultKey(await unwrapVaultKey(b64ToU8(me.wrapped_vault_key_b64), kek));
        } finally {
          // KEK своё отработал — гасим копию, которую вернул `deriveMasterKey`. Это
          // дешёвая гигиена, а НЕ «в памяти вкладки остался только VK»: оригинал лежит
          // в линейной памяти argon2-WASM, буфер `combinePasswordContext` с байтами
          // пароля не гасится, да и сам пароль живёт JS-строкой в стейте React до
          // размонтирования. Одну копию из четырёх убрать всё же дешевле, чем не убрать.
          kek.fill(0);
        }
      }
      bumpVaultKeyActivity();
      onClose();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) setError(SESSION_EXPIRED);
      else setError(e instanceof Error ? e.message : String(e));
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
