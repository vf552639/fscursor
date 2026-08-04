import React from "react";
import { Modal, CopyBtn, Btn } from "./ui/Primitives";
import type { InstallFastpanelResult } from "../lib/deepLink";

/**
 * Показ-один-раз кред панели после `install_fastpanel`.
 *
 * Пароль существует ТОЛЬКО в этих пропсах: сервер его не знает, кэш запросов и
 * локальный SQLCipher-кэш его не хранят. Отсюда правила компонента: он ничего
 * не пишет ни в storage, ни в лог, и не держит собственного стейта — гасит
 * пароль тот, кто им владеет, вызовом `onClose`.
 *
 * У модалки два поставщика — deep link `sdmp://install-fastpanel` и кнопка на
 * ServerDetail, — и обоим нужен один и тот же экран, поэтому он вынесен сюда.
 */
export function FastPanelCredsModal({
  creds,
  onClose,
}: {
  creds: InstallFastpanelResult;
  onClose: () => void;
}) {
  return (
    // `closeOnBackdrop={false}` по той же причине, что у `ProvisionResultModal`:
    // `onClose` гасит единственную копию пароля панели, добытую 30-минутной
    // установкой. Клик мимо Done не должен её стоить.
    <Modal title="FastPanel installed" onClose={onClose} width={520} closeOnBackdrop={false}>
      <div
        style={{
          fontSize: 12.5,
          color: "#92400e",
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 8,
          padding: "10px 12px",
          marginBottom: 16,
        }}
      >
        Shown once. These credentials are not stored anywhere — copy them now.
      </div>
      {creds.password ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(
            [
              ["Panel URL", creds.url],
              ["User", creds.user],
              ["Password", creds.password],
            ] as const
          ).map(([label, value]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 90, fontSize: 12.5, color: "#6b7280", fontWeight: 500 }}>{label}</div>
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
                {value || "—"}
              </code>
              {value ? <CopyBtn value={value} /> : null}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#b91c1c", lineHeight: 1.5 }}>
          FastPanel was installed, but its credentials could not be read from the installer output.
          Reset the panel password on the server manually (SSH in and run{" "}
          <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>
            fastpanel users change-password
          </code>
          ).
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <Btn variant="primary" onClick={onClose}>
          Done
        </Btn>
      </div>
    </Modal>
  );
}
