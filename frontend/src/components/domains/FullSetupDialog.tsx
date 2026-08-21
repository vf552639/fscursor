import React from "react";

import FullSetupFields from "./FullSetupFields";
import { Btn, Modal } from "../ui/Primitives";
import { CloudflareAccount } from "../../api/cloudflare";
import { Domain } from "../../api/domains";
import { RegistrarAccount } from "../../api/registrars";
import { Server } from "../../api/servers";
import { domainWord } from "../../lib/format";
import { FullSetupForm } from "../../lib/fullSetupPlan";
import { isTauri } from "../../lib/runtime";

/**
 * Полная настройка выделенных доменов: связки, зона в Cloudflare и (по
 * тумблеру) NS у регистратора.
 *
 * Выбор живёт у страницы, как у `AssignServerDialog`: закрытие диалога его не
 * теряет. Промахнуться мимо Cancel легко, а выбрано тут пять вещей сразу —
 * заново их собирать было бы дороже, чем всё, ради чего диалог открывали.
 *
 * Запуск — тоже у страницы (`onRun`): прогон по сотне доменов идёт минутами и
 * обязан пережить и этот диалог, и саму вкладку.
 */
export default function FullSetupDialog({
  selectedCount,
  servers,
  registrars,
  cfAccounts,
  domains,
  value,
  onChange,
  pending,
  onRun,
  onClose,
}: {
  selectedCount: number;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  domains: Domain[];
  value: FullSetupForm;
  onChange: (next: FullSetupForm) => void;
  /** Идёт ли прогон — гейт страницы: второй запуск поверх первого не нужен. */
  pending: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  // Сервер и аккаунт Cloudflare обязательны: без них у запроса нет тела —
  // `BulkFullSetupRequest` объявляет оба полями без умолчаний. Регистратор
  // опционален, и это не послабление: NS-шаг без него просто не выполняется.
  const ready = Boolean(value.serverId && value.cloudflareAccountId);

  return (
    <Modal title="Full setup" onClose={onClose} width={460}>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
        Set up {selectedCount} {domainWord(selectedCount)}: bindings in SDMP, then whatever is checked below.
      </p>
      <FullSetupFields
        servers={servers}
        registrars={registrars}
        cfAccounts={cfAccounts}
        domains={domains}
        value={value}
        onChange={onChange}
        // Спрашиваем среду, а не выводим её из факта «диалог открыт»: кнопку
        // тулбара в вебе не рисуют, но правило «зону заводит десктоп» живёт в
        // одном месте на весь фронт, и здесь оно должно читаться так же.
        desktop={isTauri()}
      />
      <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
        <Btn variant="primary" onClick={onRun} disabled={!ready || pending}>
          {pending ? "Setting up…" : "Set up"}
        </Btn>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      </div>
    </Modal>
  );
}
