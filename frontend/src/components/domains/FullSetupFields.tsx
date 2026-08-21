import React, { ChangeEvent, ReactNode } from "react";

import { Sel } from "../ui/Primitives";
import { CloudflareAccount } from "../../api/cloudflare";
import { Domain } from "../../api/domains";
import { RegistrarAccount } from "../../api/registrars";
import { Server } from "../../api/servers";
import {
  FullSetupForm,
  ToggleRule,
  nsToggleRule,
  optionsByLoad,
  zoneToggleRule,
} from "../../lib/fullSetupPlan";

/**
 * Поля полной настройки: куда селим домен и что с ним делаем.
 *
 * Один компонент на обе формы (мастер «Add Domain» и массовый диалог), потому
 * что вопросы у них одни и те же, а расходятся они только тем, что настраивают:
 * один новый домен или пачку выделенных. Две копии этих селектов разъехались бы
 * на первой же правке правил — а правила тут не косметика: погасший невпопад
 * тумблер молча отменяет шаг, о котором пользователь просил.
 */
export default function FullSetupFields({
  servers,
  registrars,
  cfAccounts,
  domains,
  value,
  onChange,
  desktop,
}: {
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  /** Весь список доменов — из него считается нагрузка на сервер и аккаунт. */
  domains: Domain[];
  value: FullSetupForm;
  onChange: (next: FullSetupForm) => void;
  /** Есть ли чем выполнять шаги: зону и NS умеет только десктоп. */
  desktop: boolean;
}) {
  const set = (patch: Partial<FullSetupForm>) => onChange({ ...value, ...patch });

  const serverOptions = optionsByLoad(servers, domains, (d) => d.server_id);
  const cfOptions = optionsByLoad(cfAccounts, domains, (d) => d.cloudflare_account_id);
  const registrarProvider =
    registrars.find((r) => String(r.id) === value.registrarId)?.provider ?? null;

  const zone = zoneToggleRule(desktop, value.cloudflareAccountId);
  const ns = nsToggleRule({
    desktop,
    createZone: value.createZone && zone.enabled,
    registrarId: value.registrarId,
    registrarProvider,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Hosting (server)">
        <Sel
          aria-label="Hosting (server)"
          value={value.serverId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ serverId: e.target.value })}
          style={{ width: "100%" }}
        >
          <option value="">— None —</option>
          {serverOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </Sel>
      </Field>
      <Field label="Registrar">
        <Sel
          aria-label="Registrar"
          value={value.registrarId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ registrarId: e.target.value })}
          style={{ width: "100%" }}
        >
          <option value="">— None —</option>
          {registrars.map((r) => (
            <option key={r.id} value={r.id}>{r.provider} - {r.name}</option>
          ))}
        </Sel>
      </Field>
      <Field label="Cloudflare account">
        <Sel
          aria-label="Cloudflare account"
          value={value.cloudflareAccountId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ cloudflareAccountId: e.target.value })
          }
          style={{ width: "100%" }}
        >
          <option value="">— None —</option>
          {cfOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </Sel>
      </Field>
      <Toggle
        label="Create the zone in Cloudflare"
        rule={zone}
        checked={value.createZone && zone.enabled}
        onChange={(createZone) => set({ createZone })}
      />
      <Toggle
        label="Set NS at the registrar"
        rule={ns}
        checked={value.pushNs && ns.enabled}
        onChange={(pushNs) => set({ pushNs })}
      />
    </div>
  );
}

/**
 * Подпись над полем. `aria-label` у самого `<select>` дублирует её намеренно:
 * подпись здесь рядом, а не привязана `htmlFor`, — то есть для скринридера
 * (и для теста) поле осталось бы безымянным.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>{label}</label>
      {children}
    </div>
  );
}

/**
 * Тумблер шага вместе с причиной, по которой он погас.
 *
 * Подпись стоит и у живого, и у мёртвого: «нет API — пропишите NS вручную» и
 * есть единственный ответ на вопрос «почему у этого домена ничего не
 * произошло». Галочка гасится вместе с тумблером (`checked={… && enabled}`),
 * чтобы экран не показывал включённым шаг, которого не будет; настоящее же
 * значение всё равно пересчитывается планом (`planFromForm`) — разметке такое
 * решение не доверено.
 */
function Toggle({
  label,
  rule,
  checked,
  onChange,
}: {
  label: string;
  rule: ToggleRule;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:13,color:rule.enabled?"#374151":"#9ca3af",cursor:rule.enabled?"pointer":"default"}}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!rule.enabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
        style={{ marginTop: 2, cursor: rule.enabled ? "pointer" : "not-allowed" }}
      />
      <span>
        {label}
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{rule.hint}</div>
      </span>
    </label>
  );
}
