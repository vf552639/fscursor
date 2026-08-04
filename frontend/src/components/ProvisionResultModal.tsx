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
  position = 0,
  total = 0,
}: {
  domain: string;
  result: ProvisionDesktopResult;
  onClose: () => void;
  /** Номер в очереди показов и её длина — см. `useShowOnceQueue`. */
  position?: number;
  total?: number;
}) {
  const noticeStyle = {
    fontSize: 12.5,
    color: "#92400e",
    background: "#fffbeb",
    border: "1px solid #fde68a",
    borderRadius: 8,
    padding: "10px 12px",
  } as const;

  const secretBlock = (
    title: string,
    rows: ReadonlyArray<readonly [string, string]>,
  ) => (
    <div>
      <div style={{ ...noticeStyle, marginBottom: 10 }}>
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

  /**
   * Аккаунт, который этот прогон НЕ создавал.
   *
   * Пароля здесь нет и быть не может: его выдал ровно один раз тот прогон,
   * который аккаунт создал, и больше он не хранится нигде — ни на сервере, ни
   * в кэше. Сказать это словами обязательно: пустое место на месте пароля
   * читалось бы как «провижининг что-то потерял», а «shown once» рядом с
   * пустотой — как «пароль показали, а я проморгал».
   *
   * Логин показываем и копируем: он-то как раз нужен, чтобы найти аккаунт в
   * панели и, если пароль утерян, сменить его там руками. Сами мы его не
   * меняем: старый лежит в конфиге живого сайта на сервере, и ротация посреди
   * повторного provision уронила бы работающий сайт.
   */
  const existingBlock = (title: string, label: string, value: string) => (
    <div>
      <div style={{ ...noticeStyle, marginBottom: 10 }}>
        {title} — nothing was created and no password is shown. Its password was shown once,
        when it was created; it is not stored anywhere, so it cannot be shown again. If it is
        lost, change it in FastPanel.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 100, fontSize: 12.5, color: "#6b7280", fontWeight: 500 }}>
          {label}
        </div>
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
    </div>
  );

  return (
    // `closeOnBackdrop={false}`: `onClose` здесь — это `dismiss`, то есть
    // уничтожение единственной копии паролей. Клик мимо кнопки Done не имеет
    // права стоить FTP-аккаунта, войти в который уже никто не сможет.
    <Modal
      title={`Provisioned ${domain}`}
      onClose={onClose}
      width={520}
      closeOnBackdrop={false}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {total > 1 && (
          <div style={{ fontSize: 12.5, color: "#6b7280", fontWeight: 500 }}>
            {position} of {total} — each set of credentials is shown once
          </div>
        )}
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
        {result.db?.status === "created"
          ? secretBlock("Database credentials", [
              ["DB name", result.db.db_name],
              ["DB user", result.db.db_user],
              ["DB password", result.db.db_password],
            ])
          : null}
        {result.db?.status === "exists"
          ? existingBlock(
              `Database ${result.db.db_name} and user ${result.db.db_user} already existed`,
              "DB user",
              result.db.db_user,
            )
          : null}
        {result.ftp?.status === "created"
          ? secretBlock("FTP credentials", [
              ["FTP user", result.ftp.ftp_user],
              ["FTP password", result.ftp.ftp_password],
            ])
          : null}
        {result.ftp?.status === "exists"
          ? existingBlock(
              `FTP account ${result.ftp.ftp_user} already existed`,
              "FTP user",
              result.ftp.ftp_user,
            )
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
