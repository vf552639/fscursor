import { useEffect, useMemo, useState } from "react";

import { DomainFilterControls } from "../components/domains/DomainFilters";
import { DomainUI } from "../components/domains/types";

/**
 * Фильтры вкладки Domains: их значения, синхронизация с адресом и применение к
 * списку.
 *
 * Одно место на всё три, потому что это одно правило: то, что стоит в
 * селекторах, обязано совпадать с тем, что осталось в таблице, и с тем, что
 * лежит в адресной строке. Разъехавшись, они дают самый неприятный вид
 * неправды — экран, который показывает не то, о чём его спросили.
 *
 * `?status=` в адресе живёт ради ссылок с дашборда: он ведёт сюда со срезом по
 * статусу, и после перезагрузки страницы срез обязан остаться тем же.
 */
export function useDomainFilters(
  domains: DomainUI[],
  /** Режим одной строки (`ctx.domainId`) — такое же условие фильтра, как остальные. */
  focusDomainId: number | null,
): { controls: DomainFilterControls; filtered: DomainUI[] } {
  const initialStatusFilter = useMemo(() => {
    return new URLSearchParams(window.location.search).get("status") ?? "";
  }, []);
  const [search,setSearch]=useState(""); const [fSrv,setFS]=useState(""); const [fReg,setFR]=useState(""); const [fCF,setFCF]=useState(""); const [fStatus, setFStatus] = useState(initialStatusFilter);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (fStatus) params.set("status", fStatus);
    else params.delete("status");
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", next);
  }, [fStatus]);

  const filtered = useMemo(() => domains.filter((d: DomainUI) =>
    (!search || d.domain.toLowerCase().includes(search.toLowerCase()) || String(d.id) === search) &&
    (!fSrv || d.server_id === Number(fSrv)) &&
    (!fReg || d.registrar_id === Number(fReg)) &&
    (!fCF || d.cf_id === Number(fCF)) &&
    (!fStatus || d.status === fStatus) &&
    (!focusDomainId || d.id === focusDomainId)
  ), [search, fSrv, fReg, fCF, fStatus, focusDomainId, domains]);

  return {
    controls: {
      search, onSearchChange: setSearch,
      serverId: fSrv, onServerChange: setFS,
      registrarId: fReg, onRegistrarChange: setFR,
      cfId: fCF, onCfChange: setFCF,
      status: fStatus, onStatusChange: setFStatus,
    },
    filtered,
  };
}
