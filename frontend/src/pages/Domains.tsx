import React, { useState, useMemo, useEffect } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card } from "../components/ui/Primitives";
import { useDomains, useBulkAssignServer, useBulkAssignCloudflare, useDeleteDomain, useProvisionDomain, isBulkGateClaim, PROVISION_DOMAIN_KEY, Domain, ProvisionDomainVars, ProvisionOutcome, BulkProvisionOutcome } from "../api/domains";
import { useServers } from "../api/servers";
import { useRegistrarAccounts } from "../api/registrars";
import { useCloudflareAccounts } from "../api/cloudflare";
import { CfBindNotice } from "../api/cfAutoBind";
import { AddDomainModal } from "../components/domains/AddDomainModal";
import DomainFilters from "../components/domains/DomainFilters";
import DomainStats from "../components/domains/DomainStats";
import DomainTable from "../components/domains/DomainTable";
import CloudflareBindBanner from "../components/domains/CloudflareBindBanner";
import DomainsHeader from "../components/domains/DomainsHeader";
import DomainsLoadError from "../components/domains/DomainsLoadError";
import DomainsEmptyState from "../components/domains/DomainsEmptyState";
import AssignCloudflareDialog from "../components/domains/AssignCloudflareDialog";
import AssignServerDialog from "../components/domains/AssignServerDialog";
import BulkAddDialog from "../components/domains/BulkAddDialog";
import ProvisionDialog from "../components/domains/ProvisionDialog";
import { DomainUI, toDomainUI } from "../components/domains/types";
import BulkActionToolbar from "../components/BulkActionToolbar";
import DomainBulkImportDialog from "../components/DomainBulkImportDialog";
import DomainDetailModal from "../components/DomainDetailModal";
import { confirmAction } from "../lib/confirmDialog";
import { useBulkProvision } from "../hooks/useBulkProvision";
import { useCloudflareBind } from "../hooks/useCloudflareBind";
import { useDomainFilters } from "../hooks/useDomainFilters";
import { useDomainSort } from "../hooks/useDomainSort";

export default function Domains({ onNav, ctx, onProvisionResult, onBulkProvisionResult, onBulkProvisionError, onCloudflareBindNotice }: {
  onNav?: (pg: string, ctx?: any) => void;
  ctx?: any;
  /**
   * Куда отдать результат provision. Показывает его модалка показа-один-раз,
   * которой владеет DesktopWorkspace: пароли БД и FTP существуют только в этом
   * ответе, а сама страница размонтируется при уходе пользователя и унесла бы
   * их с собой.
   *
   * Обязательный, хотя формально мог бы быть опциональным: потерю, которую
   * нечем восстановить (сервер паролей не знает), компилятор умеет делать
   * невыразимой — комментарий умеет только объяснить её задним числом.
   */
  onProvisionResult: (outcome: ProvisionOutcome) => void;
  /**
   * То же самое для массового прогона, и обязателен по той же причине, только
   * дороже: в отчёте лежит пароль FTP КАЖДОГО отработавшего домена, то есть
   * потерять можно сразу N. Уход со страницы во время прогона — не редкость: он
   * идёт минутами на каждый домен.
   *
   * Отдаём отчёт целиком, а не по одному результату: DesktopWorkspace обязан
   * поставить в очередь и пароли, и итог прогона (`already_ran`, оборвался ли
   * он и на чём), а итог живёт только в отчёте.
   */
  onBulkProvisionResult: (outcome: BulkProvisionOutcome) => void;
  /**
   * Куда отдать причину НЕзапуска, если баннера страницы больше нет.
   *
   * Отказ («уже провижинится», «только десктоп», сорвавшийся `invokeSynced`)
   * может прилететь через секунды после клика, а страница к этому моменту
   * размонтирована — она размонтируется на любой навигации (`<main key={page}>`
   * в DesktopWorkspace), и уйти смотреть тосты по шагам прогона тут нормальное
   * поведение. Стейт мёртвого компонента этот текст съедает молча, и
   * пользователь возвращается к обычной странице в уверенности, что прогон идёт.
   *
   * Зовётся, только если размонтирован ТОТ ЭКЗЕМПЛЯР страницы, который запускал
   * прогон: пока он жив, у той же ошибки есть своё место — баннер над тулбаром,
   * который не исчезнет через 2200 мс. Одно событие — одна поверхность.
   *
   * «Экземпляр», а не «экран»: уйдя со страницы и вернувшись, пользователь видит
   * НОВЫЙ `Domains`, который про тот прогон ничего не знает (его `sel` пуст, а
   * баннер принадлежит набору), — отказ прилетит тостом поверх живой страницы.
   * Так и задумано: показать его в баннере нового экземпляра значило бы
   * приписать отказ набору, который на экране уже другой.
   */
  onBulkProvisionError: (message: string) => void;
  /**
   * Куда отдать итог привязки к Cloudflare, если баннера страницы больше нет.
   *
   * Обязательный по той же причине, что и `onBulkProvisionError`: привязка
   * изменила данные, НЕ спросив, и отчёт о ней — не украшение, а единственное,
   * чем это отличается от тихой правки за спиной у пользователя. Забытый проп
   * означал бы, что на пачке в двести доменов (прогон — десятки секунд) уход со
   * страницы стирает след операции начисто.
   *
   * Зовётся, только если страница уже размонтирована: пока она жива, у события
   * одна поверхность — баннер над тулбаром, который не исчезнет через 2200 мс.
   *
   * `kind` разбирает получатель: тон у привязки тот же, что у остальных тостов
   * воркспейса (`showToast` / `showWarning`), и заводить четвёртый вид ради неё
   * не нужно.
   */
  onCloudflareBindNotice: (notice: CfBindNotice) => void;
}){
  const domainsQ = useDomains();
  const serversQ = useServers();
  const registrarsQ = useRegistrarAccounts();
  const cfAccountsQ = useCloudflareAccounts();

  // Одно чтение часов на рендер — тот же приём, что на трёх остальных экранах:
  // отдельный `Date.now()` внутри каждой функции дал бы разные «сейчас» для
  // статуса сервера и для подписи его возраста в соседней строке.
  const now = Date.now();

  const domainsData = domainsQ.data ?? [];
  const servers = serversQ.data?.items || [];
  const registrars = registrarsQ.data || [];
  const cfAccounts = cfAccountsQ.data || [];

  const domains = useMemo((): DomainUI[] => domainsData.map(toDomainUI), [domainsData]);

  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  // Выбор в диалогах назначения гасит только удачное назначение — закрытие
  // диалога его сохраняет, поэтому он и живёт здесь. Промахнуться мимо Cancel
  // легко, а выбор сделан в списке из сотни машин.
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);
  const filters = useDomainFilters(domains, focusDomainId);
  const order = useDomainSort(filters.filtered);

  const bulkAssignServer = useBulkAssignServer();
  const bulkAssignCF = useBulkAssignCloudflare();
  const singleProvision = useProvisionDomain(onProvisionResult);
  // Что провижинится прямо сейчас — из MutationCache, а не из локального
  // observer'а или `useState`: операция идёт минутами (SSH + certbot) и
  // переживает уход со страницы, а страница размонтируется на любой навигации
  // (`<main key={page}>` в DesktopWorkspace). Без этого после возврата обе
  // кнопки снова активны, и клик открывает вторую SSH-сессию по домену, по
  // которому первая ещё идёт.
  //
  // Одна подписка на оба вопроса: фильтр у них общий, а разные ответы даёт
  // `select`. Две подписки с одинаковым фильтром пересчитывали бы по два снимка
  // на каждое изменение кэша.
  //
  // `bulkGateClaim` — маркер заявки гейта, которую заводит сам
  // `runBulkProvisionDomains` на каждый домен набора (см. `isBulkGateClaim`):
  // заявки висят pending ровно столько, сколько идёт прогон. Без этого признака
  // «идёт массовый прогон» после возврата на страницу превращалось бы в «нет», и
  // второй прогон по ДРУГИМ доменам подоменный гейт не остановил бы вовсе.
  //
  // Правило здесь СТРОЖЕ, чем у ссылки, и это выбор, а не расхождение. Кнопка
  // отказывает на любом идущем прогоне, `sdmp://bulk-provision` — только на
  // пересечении наборов (`alreadyProvisioning`). У кнопки пользователь стоит
  // перед списком и видит, что что-то идёт: второй параллельный прогон отсюда —
  // почти всегда «не понял, что первый ещё работает», и стоит он часов SSH.
  // Ссылка приходит извне, её набор может быть намеренно непересекающимся
  // (соседняя пачка доменов на другом сервере), и запрещать его было бы запретом
  // сценария, ради которого ссылка и заведена.
  const pendingProvisions = useMutationState({
    filters: { mutationKey: PROVISION_DOMAIN_KEY, status: "pending" },
    select: (m) => ({
      domainId: (m.state.variables as ProvisionDomainVars | undefined)?.domainId,
      bulkClaim: isBulkGateClaim(m.state.variables),
    }),
  });
  const isProvisioning = (id: number) => pendingProvisions.some((p) => p.domainId === id);
  const bulkProvisionRunning = pendingProvisions.some((p) => p.bulkClaim);
  const deleteDomain = useDeleteDomain();
  // Provision в десктопе синхронен: серверного task log'а, который можно было бы
  // поллить, у него нет — поэтому ни `TaskProgressModal`, ни его multi-версии на
  // этой странице больше нет вовсе (их единственным поставщиком был bulk full
  // setup, ушедший вместе с несуществующим роутом). Показывает результат не эта
  // страница, а DesktopWorkspace (см. `onProvisionResult`): пароли БД и FTP не
  // должны зависеть от того, ушёл ли пользователь со страницы, пока шёл provision.
  //
  // Домен, для которого открыт диалог запуска, — и только он: выбор «создавать
  // ли базу» принадлежит самому диалогу и умирает вместе с ним, чтобы не
  // залипать между доменами (см. `ProvisionDialog`).
  const [provisionTarget, setProvisionTarget] = useState<DomainUI | null>(null);
  const [showFileImport, setShowFileImport] = useState(false);
  const cfBind = useCloudflareBind(onCloudflareBindNotice);
  const bulkProvision = useBulkProvision({
    domains,
    selected: sel,
    onResult: onBulkProvisionResult,
    onErrorAway: onBulkProvisionError,
    onSetSpent: () => setSel(new Set()),
  });

  // Приход по ссылке: с карточки сервера — со срезом по нему, с уведомления о
  // домене — в режим одной строки. Поиск при этом гасится: строка, набранная
  // раньше, к домену из ссылки отношения не имеет и может его же и спрятать.
  const { onServerChange, onSearchChange } = filters.controls;
  useEffect(() => {
    if (ctx?.serverId) {
      onServerChange(String(ctx.serverId));
    }
    if (ctx?.domainId) {
      setFocusDomainId(Number(ctx.domainId));
      onSearchChange("");
    }
  }, [ctx, onServerChange, onSearchChange]);

  const toggle=(id: number)=>{setSel((p: Set<number>)=>{const s=new Set<number>(p);s.has(id)?s.delete(id):s.add(id);return s;});};

  const handleAssignServer = (serverId: string) => {
    if (!serverId) return;
    bulkAssignServer.mutate(
      { domain_ids: Array.from(sel), server_id: Number(serverId) },
      { onSuccess: () => { setShowAssignServer(false); setSel(new Set()); setAssignServerId(""); } }
    );
  };

  const handleAssignCF = (cfAccountId: string) => {
    if (!cfAccountId) return;
    bulkAssignCF.mutate(
      { domain_ids: Array.from(sel), cloudflare_account_id: Number(cfAccountId) },
      { onSuccess: () => { setShowAssignCF(false); setSel(new Set()); setAssignCFId(""); } }
    );
  };

  const handleProvision = (target: DomainUI, withDb: boolean) => {
    if (isProvisioning(target.id)) return;
    // Без per-call `onSuccess`: результат доставляет замыкание `mutationFn`
    // (см. `useProvisionDomain`), потому что per-call коллбэки react-query
    // глушит при размонтировании наблюдателя — а именно после ухода со
    // страницы пароли и терялись.
    singleProvision.mutate({
      domainId: target.id,
      domainName: target.domain,
      withDb,
    });
    setProvisionTarget(null);
  };

  /** Удаление одного домена по ✕ строки. Спрашивает страница, а не строка: строка не знает и не должна знать, чем оно кончится. */
  const handleDeleteDomain = async (d: DomainUI) => {
    if (!(await confirmAction(`Delete ${d.domain}?`))) return;
    deleteDomain.mutate(d.id);
  };

  const handleBulkDelete = async () => {
    if (!(await confirmAction(`Удалить ${sel.size} доменов?`))) return;
    Promise.all(Array.from(sel).map(id => deleteDomain.mutateAsync(id)))
      .then(() => setSel(new Set()));
  };

  if (domainsQ.isError) {
    return <DomainsLoadError error={domainsQ.error} />;
  }

  if (domainsQ.isPending || serversQ.isPending || registrarsQ.isPending || cfAccountsQ.isPending) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading domains data...</div>;
  }

  return <>
    <DomainsHeader
      total={domains.length}
      onFileImport={()=>setShowFileImport(true)}
      onBulkAdd={()=>setSB(true)}
      onAddDomain={()=>setSA(true)}
    />
    <DomainStats domains={domains} />
    <DomainFilters {...filters.controls} servers={servers} registrars={registrars} cfAccounts={cfAccounts} />
    {/* Живёт ровно столько, сколько живёт набор, на котором случился отказ:
        гасит его сам `useBulkProvision` по смене выделения, а не время и не
        следующий рендер. */}
    {bulkProvision.error ? (
      <div role="alert" style={{marginBottom:12,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>
        {bulkProvision.error}
      </div>
    ) : null}
    {cfBind.notice ? (
      <CloudflareBindBanner notice={cfBind.notice} onDismiss={cfBind.dismiss} />
    ) : null}
    <BulkActionToolbar
      selectedCount={sel.size}
      selectedDomainIds={Array.from(sel)}
      onAssignServer={() => setShowAssignServer(true)}
      onAssignCF={() => setShowAssignCF(true)}
      // Живые строки из свежего списка, а не `DomainUI`: привязке нужно
      // `cloudflare_account_id`, по которому она решает, кого не трогать.
      //
      // Выделение после прогона НЕ снимается — в отличие от четырёх соседних
      // действий, и это выбор. «Assign Server», «Assign CF» и удаление делают с
      // набором ровно то, о чём их просили, и набор после них не нужен;
      // удавшийся массовый provision снимает выделение потому, что повторять
      // его по тем же доменам нельзя (идемпотентность пометит набор
      // отработавшим). У привязки же типичный исход — частичный: часть доменов
      // осталась неоднозначной, часть не записалась, часть ждёт зоны, которую
      // пользователь сейчас создаст. Всё это — работа ПО ТОМУ ЖЕ набору, и
      // снятое выделение заставило бы разыскивать те же строки заново в списке
      // на двести строк. Повтор безопасен: уже привязанное прогон пропускает.
      onMatchCFZones={() => {
        void cfBind.run(domainsData.filter((d) => sel.has(d.id)), "manual");
      }}
      matchCFZonesPending={cfBind.pending}
      onProvision={() => { void bulkProvision.run(); }}
      onDelete={handleBulkDelete}
      provisionPending={bulkProvisionRunning}
    />
    <Card>
      <div style={{overflowX:"auto"}}>
        {domainsData.length === 0 ? (
          <DomainsEmptyState
            onFileImport={() => setShowFileImport(true)}
            onBulkImport={() => setSB(true)}
            onAddDomain={() => setSA(true)}
          />
        ) : (
        <DomainTable
          rows={order.sorted}
          servers={servers}
          registrars={registrars}
          cfAccounts={cfAccounts}
          now={now}
          sort={order.sort}
          onSort={order.onSort}
          selectedIds={sel}
          onToggleRow={toggle}
          onToggleAll={()=>setSel(sel.size===filters.filtered.length?new Set():new Set(filters.filtered.map((d: DomainUI)=>d.id)))}
          focusDomainId={focusDomainId}
          isProvisioning={isProvisioning}
          onOpenDetail={(id)=>setDetailDomain(domainsData.find((x) => x.id === id) || null)}
          onProvision={setProvisionTarget}
          onDelete={(d)=>{ void handleDeleteDomain(d); }}
        />
        )}
      </div>
    </Card>

    {showAdd && <AddDomainModal onClose={()=>setSA(false)} servers={servers} registrars={registrars} cfAccounts={cfAccounts} onCreated={(d: Domain)=>{ void cfBind.run([d], "auto"); }} />}
    {/* `detailDomain` — снимок строки на момент клика, и он НЕ обновляется от
        инвалидации: модалка показывала бы «NS status: pending» ещё долго после
        удачной смены NS, то есть ровно ту ложь, ради устранения которой заведён
        write-back. Берём живую строку из свежего списка, а снимок оставляем
        резервом на случай, если домен из списка исчез (удалён, ушёл под фильтр).

        `key` — чтобы при переходе с домена на домен модалка пересоздавалась:
        иначе её собственный стейт (набранные NS) пережил бы смену props. */}
    {detailDomain && (
      <DomainDetailModal
        key={detailDomain.id}
        domain={domainsData.find((x) => x.id === detailDomain.id) ?? detailDomain}
        onClose={() => setDetailDomain(null)}
      />
    )}
    <BulkAddDialog
      open={showBulk}
      onClose={()=>setSB(false)}
      registrars={registrars}
      onCreated={(created: Domain[])=>{ void cfBind.run(created, "auto"); }}
    />

    {showAssignServer && (
      <AssignServerDialog
        selectedCount={sel.size}
        servers={servers}
        serverId={assignServerId}
        onServerChange={setAssignServerId}
        pending={bulkAssignServer.isPending}
        onAssign={handleAssignServer}
        onClose={() => setShowAssignServer(false)}
      />
    )}

    {showAssignCF && (
      <AssignCloudflareDialog
        selectedCount={sel.size}
        cfAccounts={cfAccounts}
        cfId={assignCFId}
        onCfChange={setAssignCFId}
        pending={bulkAssignCF.isPending}
        onAssign={handleAssignCF}
        onClose={() => setShowAssignCF(false)}
      />
    )}
    {showFileImport && (
      <DomainBulkImportDialog
        onClose={() => setShowFileImport(false)}
        registrars={registrars}
        onImported={(result) => {
          if (result.errors_csv_url) {
            window.open(`/api${result.errors_csv_url}`, "_blank");
          }
        }}
      />
    )}
    {provisionTarget && (
      <ProvisionDialog
        // `key` — чтобы выбор «создавать ли БД» не залипал между доменами:
        // диалог принадлежит домену, а не странице.
        key={provisionTarget.id}
        domain={provisionTarget}
        isProvisioning={isProvisioning(provisionTarget.id)}
        onProvision={(withDb: boolean) => handleProvision(provisionTarget, withDb)}
        onClose={() => setProvisionTarget(null)}
      />
    )}
  </>;
}
