import React, { useState } from "react";

import { Domain, useReadDomainFacts, useUpdateDomain } from "../../api/domains";
import { Server } from "../../api/servers";
import { SslState, isFactsStale, sslState } from "../../lib/domainFacts";
import { BLOB_KIND } from "../../lib/secretBlob";
import { isTauri } from "../../lib/runtime";
import { useSecretSave } from "../../hooks/useSecretSave";
import { RevealSecret } from "../RevealSecret";
import { Badge, Btn, Inp, formatAgoStale } from "../ui/Primitives";

/**
 * Секция «состояние на сервере»: то, что десктоп прочитал по SSH, показанное с
 * честной свежестью (принцип №6 CLAUDE.md). Соседний двухколоночный блок
 * карточки — это НАША запись (снимок момента provision из колонок домена); эта
 * секция — живое чтение с сервера и его возраст, ровно как рядом уживаются «наш
 * ns_status» и живая сверка делегирования.
 *
 * Порог протухания и лестница SSL живут в `lib/domainFacts`, а не здесь: три
 * экрана про сервер уже разъезжались, когда правило жило в компоненте.
 */

/**
 * Порт FTP у FastPanel — стандартный 21 (pure-ftpd/proftpd слушают его). Отдельным
 * полем домен/сервер его не хранит; при живом прогоне это и подтвердится.
 */
const FTP_PORT = 21;

const NONE = "—";

/** Строка «подпись: значение» в стиле карточки; пустое — прочерк, а не пустота. */
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  const empty = v === null || v === undefined || v === "";
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 13, color: "#374151" }}>
      <b style={{ color: "#6b7280", fontWeight: 600, minWidth: 84 }}>{k}</b>
      <span style={{ wordBreak: "break-all" }}>{empty ? NONE : v}</span>
    </div>
  );
}

/** Заголовок под-блока секции. */
function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: "#111", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
      {children}
    </div>
  );
}

/** Ярлык и цвет бейджа состояния SSL. `unchecked` — серый, зелёный только под `valid`. */
const SSL_BADGE: Record<SslState, { label: string; variant: string }> = {
  unchecked: { label: "Not checked", variant: "gray" },
  missing: { label: "No certificate", variant: "red" },
  expired: { label: "Expired", variant: "red" },
  expiring: { label: "Expiring soon", variant: "yellow" },
  valid: { label: "Valid", variant: "green" },
  error: { label: "Read error", variant: "red" },
};

export default function DomainServerFacts({
  domain,
  server,
  now,
}: {
  domain: Domain;
  server: Server | undefined;
  now: number;
}) {
  const facts = domain.fp_facts ?? null;
  const desktop = isTauri();
  const read = useReadDomainFacts(domain.id);

  // Свежесть считается от `fp_facts_at` (когда снят снимок), НЕ от `fp_checked_at`
  // (когда была последняя попытка): протухший снимок не должен молодеть от
  // проваленной проверки. «never checked» — отдельное слово, а не прочерк.
  const factsStale = isFactsStale(domain.fp_facts_at, now);
  const freshness = domain.fp_facts_at
    ? `Checked ${formatAgoStale(domain.fp_facts_at, factsStale, now)}`
    : "Never checked";

  const ssl = sslState(facts?.ssl, domain.fp_facts_at, now);
  const sslBadge = SSL_BADGE[ssl];

  // Основной логин FTP: наш (из provision), иначе первый прочитанный с сервера.
  const mainFtpLogin = domain.ftp_user || facts?.ftp_accounts[0]?.login || null;

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#111" }}>Server state</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: factsStale ? "#8a8580" : "#6b7280" }}>{freshness}</span>
          {/* Только десктоп: чтение идёт по SSH, веб этого не умеет. */}
          {desktop ? (
            <Btn
              size="sm"
              variant="secondary"
              onClick={read.run}
              disabled={read.pending}
              title="Read SSL, FTP, PHP, site and databases from the server over one SSH session"
            >
              {read.pending ? "Checking…" : "Проверить на сервере"}
            </Btn>
          ) : null}
        </div>
      </div>

      {/* Ошибка последней ПОПЫТКИ — под шапкой. Снимок при этом остаётся прежним
          (сервер не трогает `fp_facts` при провале), и его свежесть — выше. */}
      {domain.fp_check_error ? (
        <div role="alert" style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8 }}>
          Last check failed: {domain.fp_check_error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 8 }}>
        {/* ─── FTP ─────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
          <SubTitle>FTP access</SubTitle>
          <Row k="Host" v={server?.ip_address} />
          <Row k="Port" v={FTP_PORT} />
          <Row k="Login" v={mainFtpLogin} />
          <FtpPassword domain={domain} desktop={desktop} />
          {facts && facts.ftp_accounts.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>Accounts on server</div>
              {facts.ftp_accounts.map((a) => (
                <div key={a.login} style={{ fontSize: 12.5, color: "#374151" }}>
                  {a.login}
                  {a.home ? <span style={{ color: "#9ca3af" }}> · {a.home}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* ─── SSL ─────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
          <SubTitle>SSL</SubTitle>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <b style={{ color: "#6b7280", fontWeight: 600, minWidth: 84 }}>State</b>
            <Badge variant={sslBadge.variant}>{sslBadge.label}</Badge>
          </div>
          {/* «Сертификата нет» — отдельное слово, отличимое от «не проверяли». */}
          {ssl === "missing" ? (
            <div style={{ fontSize: 12.5, color: "#b91c1c" }}>No certificate on the server.</div>
          ) : null}
          {facts?.ssl.error ? (
            <div style={{ fontSize: 12.5, color: "#b91c1c" }}>{facts.ssl.error}</div>
          ) : null}
          <Row k="Expires" v={facts?.ssl.expires_at ? fmtUtcDate(facts.ssl.expires_at) : null} />
          <Row k="Issuer" v={facts?.ssl.issuer} />
        </div>

        {/* ─── Site ────────────────────────────────────────────────────── */}
        <div style={{ display: "grid", gap: 6, alignContent: "start", gridColumn: "1 / -1" }}>
          <SubTitle>Site</SubTitle>
          <Row k="Path" v={facts?.site?.site_path} />
          <Row k="Owner" v={facts?.site?.site_user} />
          <Row
            k="PHP"
            v={
              facts?.php_version
                ? `${facts.php_version}${facts.php_handler ? ` · ${facts.php_handler}` : ""}`
                : facts?.site?.php_version || null
            }
          />
          <Row
            k="Databases"
            v={facts && facts.databases.length > 0 ? facts.databases.join(", ") : null}
          />
          <Row
            k="Logs"
            v={
              facts && facts.logs.length > 0 ? (
                <span>
                  {facts.logs.map((l) => (
                    <span key={l.path} style={{ display: "block", color: l.exists ? "#374151" : "#9ca3af" }}>
                      {l.path}
                    </span>
                  ))}
                </span>
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}

/** `2026-09-01T…Z` → `01.09.2026` в UTC — как срок домена в остальной карточке. */
function fmtUtcDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NONE;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Пароль FTP: показ через `RevealSecret` и ручной ввод «Задать пароль».
 *
 * Плейнтекст живёт ТОЛЬКО внутри `useSecretSave` — не в нашем `useState` и не в
 * `variables` мутации (`PUT /domains/{id}` получает лишь id блоба). Ручной ввод
 * — десктоп: `putSecretBlob` шифрует Rust'ом мастер-ключом из keychain.
 */
function FtpPassword({ domain, desktop }: { domain: Domain; desktop: boolean }) {
  const [editing, setEditing] = useState(false);
  const ftpPw = useSecretSave("FTP password");
  const updateDomain = useUpdateDomain(domain.id);

  const close = () => {
    ftpPw.reset();
    setEditing(false);
  };

  const save = async () => {
    const ok = await ftpPw.save({
      blobKind: BLOB_KIND.domainFtpPassword,
      // Правка: если пароль уже задан — переписываем ТОТ ЖЕ блоб (версии ведёт
      // сервер внутри одного id). Новый id оставил бы домен со ссылкой на старый.
      existingBlobId: domain.ftp_password_blob_id ?? null,
      persist: async (blobId) => {
        await updateDomain.mutateAsync({ ftp_password_blob_id: blobId });
      },
    });
    if (ok) close();
  };

  if (editing) {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <Inp
          type="password"
          value={ftpPw.value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => ftpPw.setValue(e.target.value)}
          placeholder="Enter FTP password"
          aria-label="FTP password"
        />
        {ftpPw.error ? (
          <div role="alert" style={{ fontSize: 12, color: "#b91c1c" }}>
            {ftpPw.error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="primary" onClick={() => void save()} disabled={ftpPw.saving}>
            {ftpPw.saving ? "Saving…" : "Save"}
          </Btn>
          <Btn size="sm" variant="secondary" onClick={close} disabled={ftpPw.saving}>
            Cancel
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <b style={{ color: "#6b7280", fontWeight: 600, minWidth: 84, fontSize: 13 }}>Password</b>
      {domain.ftp_password_blob_id ? (
        <RevealSecret blobId={domain.ftp_password_blob_id} label="Show FTP password" />
      ) : (
        <span style={{ fontSize: 13, color: "#9ca3af" }}>not set</span>
      )}
      {/* Ручной ввод — только десктоп: запись секрета в вебе невозможна. */}
      {desktop ? (
        <Btn size="sm" variant="secondary" onClick={() => setEditing(true)}>
          Задать пароль
        </Btn>
      ) : null}
    </div>
  );
}
