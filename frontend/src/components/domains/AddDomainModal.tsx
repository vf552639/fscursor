import React, { useState, ChangeEvent } from "react";

import FullSetupFields from "./FullSetupFields";
import { Btn, Modal, Inp } from "../ui/Primitives";
import { useCreateDomain, Domain } from "../../api/domains";
import { Server } from "../../api/servers";
import { RegistrarAccount } from "../../api/registrars";
import { CloudflareAccount } from "../../api/cloudflare";
import { EMPTY_FULL_SETUP_FORM, FullSetupPlan, planFromForm } from "../../lib/fullSetupPlan";
import { isTauri } from "../../lib/runtime";

interface AddDomainModalProps {
  onClose: () => void;
  servers: Server[];
  registrars: RegistrarAccount[];
  cfAccounts: CloudflareAccount[];
  /** Весь список доменов: из него считается нагрузка в выпадашках. */
  domains: Domain[];
  /**
   * Созданная строка домена — наверх, странице, вместе с тем, что с ней ещё
   * просили сделать.
   *
   * Ни привязку к зоне, ни полную настройку запускает НЕ модалка, хотя создаёт
   * домен именно она: модалка закрывается тем же успехом, а прогон живёт
   * секунды и минуты и должен договорить (`api/cfAutoBind.ts`,
   * `api/fullSetup.ts`). Отдавать наверх строку и план, а не отчёт, — потому что
   * решение «что делать дальше» принадлежит странице: она одинаково поступает и
   * с одиночным созданием, и с bulk-добавлением.
   *
   * `plan` — `null`, когда исполнять нечего (аккаунт Cloudflare не выбран);
   * `plan.createZone === false` означает, что домен создан со связками, а зону
   * пользователь заводить не просил.
   */
  onCreated: (domain: Domain, plan: FullSetupPlan | null) => void;
}

export function AddDomainModal({onClose, servers, registrars, cfAccounts, domains, onCreated}: AddDomainModalProps){
  const [name, setName]=useState("");
  /**
   * Связки и шаги — одной формой, общей с массовым диалогом.
   *
   * Оба тумблера по умолчанию ВЫКЛЮЧЕНЫ, и это не осторожность ради
   * осторожности: «Add Domain» заводит домен, а не зону в чужом аккаунте и не
   * смену делегирования. Включённый по умолчанию шаг менял бы данные у
   * Cloudflare и у регистратора, о чём его никто не просил, — а массовый диалог
   * называется «Full setup» и спрашивает ровно об этом, поэтому там умолчание
   * другое.
   */
  const [form, setForm]=useState(EMPTY_FULL_SETUP_FORM);
  const create = useCreateDomain();

  const desktop = isTauri();
  const registrarProvider =
    registrars.find((r) => String(r.id) === form.registrarId)?.provider ?? null;
  const plan = planFromForm(form, { desktop, registrarProvider });

  const handleAdd = () => {
    create.mutate({
      domain_name: name,
      // Связки уезжают вместе с созданием: второй запрос за ними
      // (`POST /domains/full-setup`) добавил бы точку отказа между «домен
      // создан» и «домен настроен», а сделал бы ровно то же самое.
      server_id: form.serverId ? Number(form.serverId) : null,
      registrar_id: form.registrarId ? Number(form.registrarId) : null,
      cloudflare_account_id: form.cloudflareAccountId ? Number(form.cloudflareAccountId) : null
    }, {
      onSuccess: (created) => {
        onClose();
        // Домен уже создан — это главный результат, и он состоялся. Всё, что
        // делает страница дальше (зона, NS, привязка), от него отделено: её
        // ошибки не должны выглядеть как провал создания.
        onCreated(created, plan);
      },
    });
  };

  return <Modal title="Add Domain" onClose={onClose} width={450}>
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Domain Name</label><Inp value={name} onChange={(e: ChangeEvent<HTMLInputElement>)=>setName(e.target.value)} placeholder="e.g., example.com"/></div>
      <FullSetupFields
        servers={servers}
        registrars={registrars}
        cfAccounts={cfAccounts}
        domains={domains}
        value={form}
        onChange={setForm}
        desktop={desktop}
      />
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:22}}>
      {/* Подпись кнопки следует за тумблерами: пока их не тронули, действие ровно
          то же, что и раньше, — «Add Domain». Кнопка при этом жива в любом
          случае, даже когда шаги невозможны (нет NS-API у регистратора): домен и
          зона создаются, невозможный шаг просто пропускается и называется в
          отчёте. */}
      <Btn variant="primary" onClick={handleAdd} disabled={create.isPending||!name} style={{width:"100%",justifyContent:"center",padding:"11px 0"}}>{create.isPending ? "Adding..." : (plan?.createZone ? "Создать и настроить" : "Add Domain")}</Btn>
      <Btn variant="secondary" onClick={onClose} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn>
    </div>
  </Modal>;
}
