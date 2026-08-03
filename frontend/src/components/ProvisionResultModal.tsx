import React from "react";
import { Badge, Btn, CopyBtn, Modal } from "./ui/Primitives";
import type { ProvisionDesktopResult } from "../api/domains";

/**
 * Показ-один-раз результата `provision_domain`.
 *
 * Пароли БД и FTP существуют ТОЛЬКО в этих пропсах: сервер их не знает, кэш
 * запросов и локальный SQLCipher-кэш их не хранят. Отсюда правила компонента:
 * он ничего не пишет ни в storage, ни в лог, и не держит собственного стейта —
 * гасит пароли тот, кто ими владеет, вызовом `onClose`.
 *
 * Живёт отдельным компонентом по той же причине, что и `FastPanelCredsModal`:
 * владелец экрана — всегда смонтированный `DesktopWorkspace`, а не страница
 * `Domains`, которая размонтируется при уходе пользователя и унесла бы с собой
 * единственную копию паролей.
 */
export function ProvisionResultModal({
  domain,
  result,
  onClose,
}: {
  domain: string;
  result: ProvisionDesktopResult;
  onClose: () => void;
}) {
  const secretBlock = (
    title: string,
    rows: ReadonlyArray<readonly [string, string]>,
  ) => (
    <div>
      <div
        style={{
          fontSize: 12.5,
          color: "#92400e",
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 8,
          padding: "10px 12px",
          marginBottom: 10,
        }}
      >
        {title} — shown once. Not stored anywhere; copy them now.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 100, fontSize: 12.5, color: "#6b7280", fontWeight: 500 }}>{label}</div>
            <code
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                background: "#f3f4f6",
                padding: "8px 10px",
                borderRadius: 6,
                wordBreak: "break-all",
              }}
            >
              {value}
            </code>
            <CopyBtn value={value} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Modal title={`Provisioned ${domain}`} onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {result.ssl_issued !== undefined && (
          <div>
            <Badge variant={result.ssl_issued ? "green" : "yellow"}>
              {result.ssl_issued ? "SSL issued" : "SSL skipped"}
            </Badge>
          </div>
        )}
        {!result.ssl_issued && result.ssl_error ? (
          <div
            style={{
              fontSize: 12.5,
              color: "#92400e",
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 8,
              padding: "10px 12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {result.ssl_error}
          </div>
        ) : null}
        {result.db
          ? secretBlock("Database credentials", [
              ["DB name", result.db.db_name],
              ["DB user", result.db.db_user],
              ["DB password", result.db.db_password],
            ])
          : null}
        {result.ftp
          ? secretBlock("FTP credentials", [
              ["FTP user", result.ftp.ftp_user],
              ["FTP password", result.ftp.ftp_password],
            ])
          : null}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <Btn variant="primary" onClick={onClose}>
          Done
        </Btn>
      </div>
    </Modal>
  );
}
