import React, { useState, ChangeEvent } from "react";

import { Btn, Modal } from "../ui/Primitives";
import { DomainUI } from "./types";

/**
 * Диалог перед provision одного домена: что сейчас произойдёт и создавать ли
 * базу.
 *
 * Выбор «создавать ли БД» живёт ЗДЕСЬ, а не в аргументах строки таблицы, и
 * сбрасывается тем, что диалог существует ровно пока открыт: БД — отдельный
 * артефакт на сервере, умолчание у него «нет», и залипнуть между доменами оно
 * не должно.
 *
 * Сам запуск — у страницы (`onProvision`): результат несёт пароли БД и FTP,
 * которых нет больше нигде, и показывает их не эта страница, а DesktopWorkspace
 * (см. `onProvisionResult`) — иначе уход со страницы во время прогона терял бы
 * их навсегда.
 */
export default function ProvisionDialog({
  domain,
  isProvisioning,
  onProvision,
  onClose,
}: {
  domain: DomainUI;
  /** Идёт ли provision этого домена прямо сейчас — гейт страницы по `MutationCache`. */
  isProvisioning: boolean;
  onProvision: (withDb: boolean) => void;
  onClose: () => void;
}) {
  const [withDb, setWithDb] = useState(false);

  return (
    <Modal
      title={`Provision ${domain.domain}`}
      onClose={onClose}
      width={460}
    >
      <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.5, marginBottom: 14 }}>
        SDMP will connect over SSH to this domain's server and create the site, its FTP
        account and its SSL certificate.
      </div>
      {/* Единственное место, где «создавать ли БД» вообще решается: команда
          `provision_domain` принимает `with_db`, но до этого чекбокса ни один
          вызывающий его не передавал — опциональная БД была недостижима.

          У массового прогона такого выбора нет, и это не недосмотр:
          Tauri-команда `provision_bulk` намеренно не принимает `with_db`.
          Молча создать сотню баз значит сделать за пользователя выбор,
          которого он не делал, а спросить про каждый домен отдельно эта
          кнопка не умеет. Пароли показать есть где — массовый прогон
          возвращает результат по каждому домену, и воркспейс ставит их в ту
          же очередь показов. */}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          fontSize: 13,
          color: "#374151",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={withDb}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setWithDb(e.target.checked)}
          style={{ marginTop: 2, cursor: "pointer" }}
        />
        <span>
          Also create a database
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            A MySQL database and its user are created on the server. The password is shown
            once, right after provisioning — it is not stored anywhere.
          </div>
        </span>
      </label>
      <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
        <Btn
          variant="primary"
          onClick={() => onProvision(withDb)}
          disabled={isProvisioning}
        >
          {isProvisioning ? "Provisioning…" : "Provision"}
        </Btn>
        <Btn variant="secondary" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </Modal>
  );
}
