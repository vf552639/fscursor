import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useMutationState } from "@tanstack/react-query";
import { tokens } from "../lib/designTokens";
import { useDomains, useBulkAssignServer, useBulkAssignCloudflare, useDeleteDomain, useProvisionDomain, isBulkGateClaim, PROVISION_DOMAIN_KEY, Domain, ProvisionDomainVars, ProvisionOutcome, BulkProvisionOutcome } from "../api/domains";
import { useServers } from "../api/servers";
import { useRegistrarAccounts } from "../api/registrars";
import { useCloudflareAccounts } from "../api/cloudflare";
import { CfBindNotice } from "../api/cfAutoBind";
import { FullSetupNotice } from "../api/fullSetup";
import { AddDomainModal } from "../components/domains/AddDomainModal";
import DomainFilters from "../components/domains/DomainFilters";
import DomainStatChips from "../components/domains/DomainStatChips";
import DomainTable from "../components/domains/DomainTable";
import BulkProvisionErrorBanner from "../components/domains/BulkProvisionErrorBanner";
import RunNoticeBanner from "../components/domains/RunNoticeBanner";
import CloudflareUnreadBanner from "../components/domains/CloudflareUnreadBanner";
import DomainsLoading from "../components/domains/DomainsLoading";
import DomainsHeader from "../components/domains/DomainsHeader";
import DomainsLoadError from "../components/domains/DomainsLoadError";
import DomainsEmptyState from "../components/domains/DomainsEmptyState";
import AssignCloudflareDialog from "../components/domains/AssignCloudflareDialog";
import AssignServerDialog from "../components/domains/AssignServerDialog";
import BulkAddDialog from "../components/domains/BulkAddDialog";
import FullSetupDialog from "../components/domains/FullSetupDialog";
import ProvisionDialog from "../components/domains/ProvisionDialog";
import { DomainUI, toDomainUI } from "../components/domains/types";
import BulkActionToolbar from "../components/BulkActionToolbar";
import DomainBulkImportDialog from "../components/DomainBulkImportDialog";
import DomainDetailModal from "../components/DomainDetailModal";
import { confirmAction } from "../lib/confirmDialog";
import { domainWord } from "../lib/format";
import { describeServerBinding } from "../lib/describeServerBinding";
import { EMPTY_FULL_SETUP_FORM, planFromForm } from "../lib/fullSetupPlan";
import { isTauri } from "../lib/runtime";
import { useBulkProvision } from "../hooks/useBulkProvision";
import { useCloudflareBind } from "../hooks/useCloudflareBind";
import { useFullSetup } from "../hooks/useFullSetup";
import { useDomainFilters } from "../hooks/useDomainFilters";
import { useDomainSort } from "../hooks/useDomainSort";
import { useDomainZoneMatches } from "../hooks/useDomainZoneMatches";
import { useNow } from "../hooks/useNow";

export default function Domains({ ctx, onProvisionResult, onBulkProvisionResult, onBulkProvisionError, onCloudflareBindNotice, onFullSetupNotice }: {
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
  /**
   * Куда отдать итог полной настройки, если баннера страницы больше нет.
   *
   * Обязательный по той же причине, что и `onCloudflareBindNotice`, только цена
   * выше: прогон по сотне доменов идёт минутами (зона в Cloudflare плюс смена
   * делегирования на каждый), уйти со страницы за это время — обычное дело, а в
   * отчёте лежит новость, которой больше нигде нет: сколько зон заведено в
   * Cloudflare, но не записано в SDMP. Забытый проп означал бы, что след
   * операции, менявшей чужие сервисы, стирается уходом на соседнюю вкладку.
   *
   * Отдельный проп, а не общий с привязкой: тексты у них разные, а получатель
   * один — воркспейс разбирает `kind` и показывает тост. Слить их значило бы
   * назвать полную настройку привязкой в первой же строке, которую увидит
   * читающий код.
   */
  onFullSetupNotice: (notice: FullSetupNotice) => void;
}){
  const domainsQ = useDomains();
  const serversQ = useServers();
  const registrarsQ = useRegistrarAccounts();
  const cfAccountsQ = useCloudflareAccounts();

  // Одно «сейчас» на все ячейки вкладки, и оно НЕ читается на каждый рендер:
  // иначе мемоизация строки невозможна по построению (см. `useNow`).
  const now = useNow();

  const domainsData = domainsQ.data ?? [];
  const servers = serversQ.data?.items || [];
  const registrars = registrarsQ.data || [];
  const cfAccounts = cfAccountsQ.data || [];

  const domains = useMemo((): DomainUI[] => domainsData.map(toDomainUI), [domainsData]);

  // Живой матч по зонам Cloudflare — подсказкой в колонке. Считается по строкам
  // ответа API, а не по `domains`: правило сопоставления смотрит на
  // `cloudflare_account_id` и `domain_name`, то есть на тот же словарь, которым
  // пользуется прогон привязки (`lib/cfZoneMatch`).
  const zoneMatches = useDomainZoneMatches(domainsData);

  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  const [showFullSetup, setShowFullSetup] = useState(false);
  /**
   * Выбор в диалоге полной настройки — здесь, а не в диалоге, по той же
   * причине, что и выбор сервера ниже: закрытие диалога его не теряет. Здесь
   * причина сильнее — выбрано пять вещей сразу.
   *
   * «Создать зону» включено по умолчанию, в отличие от мастера «Add Domain»:
   * кнопка называется «Full setup», и прогон без этого шага делает ровно то же,
   * что уже делают соседние «Assign Server» и «Assign CF». NS оставлены
   * выключенными — смена делегирования уводит живой трафик, и просить её надо
   * явно.
   */
  const [fullSetupForm, setFullSetupForm] = useState({ ...EMPTY_FULL_SETUP_FORM, createZone: true });
  // Выбор в диалогах назначения гасит только удачное назначение — закрытие
  // диалога его сохраняет, поэтому он и живёт здесь. Промахнуться мимо Cancel
  // легко, а выбор сделан в списке из сотни машин.
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);
  const filters = useDomainFilters(domains, focusDomainId);
  const order = useDomainSort(filters.filtered, now);

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
  // Домен, для которого открыт диалог запуска, — и только он: выбор «создавать
  // ли базу» принадлежит самому диалогу и умирает вместе с ним, чтобы не
  // залипать между доменами (см. `ProvisionDialog`).
  const [provisionTarget, setProvisionTarget] = useState<DomainUI | null>(null);
  const [showFileImport, setShowFileImport] = useState(false);
  const cfBind = useCloudflareBind(onCloudflareBindNotice);
  const fullSetup = useFullSetup(onFullSetupNotice);
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

  // Обработчики строки — `useCallback`, и это не ритуал: они уезжают пропсами
  // в мемоизированный `DomainRow`, и новая функция на каждый рендер страницы
  // отменяла бы мемоизацию целиком (та же беда, что с `now` выше). Все три
  // обходятся стабильными зависимостями: `setSel` и `setProvisionTarget` —
  // сеттеры, `mutate` react-query привязан навсегда.
  const toggle = useCallback((id: number) => {
    setSel((p: Set<number>) => { const s = new Set<number>(p); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }, []);

  /**
   * Назначить сервер выделенным. Спрашивает — тем же текстом, что и сверка на
   * карточке сервера (`describeServerBinding`): действие одно, а этот путь из
   * трёх самый дорогой — за кликом стоит всё выделение, то есть сотни доменов.
   */
  const handleAssignServer = async (serverId: string) => {
    if (!serverId) return;
    const target = Number(serverId);
    // Считаем ПЕРЕЕЗЖАЮЩИХ, а не всех выделенных: домен без сервера не теряет
    // ничего, домен уже на целевом не двигается вовсе — чем это важно, разобрано
    // у `describeServerBinding`.
    const moving = domainsData.filter((d) => sel.has(d.id) && d.server_id != null && d.server_id !== target);
    const serverName = servers.find((s) => s.id === target)?.name ?? `сервер #${target}`;
    if (!(await confirmAction(describeServerBinding(sel.size, moving.length, serverName)))) return;
    bulkAssignServer.mutate(
      { domain_ids: Array.from(sel), server_id: target },
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

  /**
   * Полная настройка выделенных: связки бэкендом, зона и NS — десктопом.
   *
   * Диалог закрывается сразу: прогон идёт минутами, отчитывается баннером над
   * таблицей, и открытая модалка закрывала бы собой ровно то, ради чего его
   * запускали. Выделение при этом НЕ снимается — как у синхрона с Cloudflare и
   * по той же причине: типичный исход частичный (зона не завелась, NS отбиты
   * регистратором), доработка идёт по тому же набору, а повтор безопасен —
   * связки идемпотентны, вторая зона на то же имя не заводится.
   */
  const handleFullSetup = () => {
    const registrarProvider =
      registrars.find((r) => String(r.id) === fullSetupForm.registrarId)?.provider ?? null;
    const plan = planFromForm(fullSetupForm, { desktop: isTauri(), registrarProvider });
    // Кнопка диалога без сервера и аккаунта Cloudflare не нажимается, но
    // решение «исполним ли план» принимает не разметка: `null` здесь значит,
    // что запросу нечем заполнить обязательные поля.
    if (!plan || plan.serverId == null) return;
    setShowFullSetup(false);
    void fullSetup.runBulk(Array.from(sel), { ...plan, serverId: plan.serverId });
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
  const deleteMutate = deleteDomain.mutate;
  const handleDeleteDomain = useCallback((d: DomainUI) => {
    void (async () => {
      if (!(await confirmAction(`Delete ${d.domain}?`))) return;
      deleteMutate(d.id);
    })();
  }, [deleteMutate]);

  const openDetail = useCallback((id: number) => {
    setDetailDomain(domainsData.find((x) => x.id === id) || null);
  }, [domainsData]);

  /**
   * Живая строка открытой карточки — ОДНА на карточку и на её кнопку provision.
   *
   * `detailDomain` — снимок на момент клика, и показывать по нему нельзя (см.
   * комментарий у самой модалки ниже). Резолвится строка ОДИН раз здесь, а не
   * дважды в разметке, ровно поэтому: карточка и её кнопка provision обязаны
   * говорить об одном и том же домене одними и теми же словами — имя отсюда
   * уезжает в `onProvisionResult` и подписывает пароли в модалке
   * показа-один-раз.
   */
  const detailRow = detailDomain
    ? domainsData.find((x) => x.id === detailDomain.id) ?? detailDomain
    : null;

  const handleBulkDelete = async () => {
    // Склонение общее с остальными счётчиками доменов (`lib/format`): «Удалить
    // 1 доменов?» — опечатка в вопросе, который человек читает перед необратимым
    // действием, и живёт она вечно, если её не запереть одной функцией.
    if (!(await confirmAction(`Удалить ${sel.size} ${domainWord(sel.size)}?`))) return;
    Promise.all(Array.from(sel).map(id => deleteDomain.mutateAsync(id)))
      .then(() => setSel(new Set()));
  };

  if (domainsQ.isError) {
    return <DomainsLoadError error={domainsQ.error} />;
  }

  if (domainsQ.isPending || serversQ.isPending || registrarsQ.isPending || cfAccountsQ.isPending) {
    return <DomainsLoading />;
  }

  return <>
    {/* Один контейнер на всё содержимое вкладки — и он же единственный
        источник вертикального ритма.
        `maxWidth` — потому что таблица на широком мониторе растягивается до
        полутора тысяч пикселей, и глаз, ведомый от имени домена к его статусу,
        теряет строку по дороге. `gap` вместо `marginBottom` у каждого блока —
        потому что отступ, принадлежащий блоку, живёт по своим правилам в
        каждом файле (было 20 у шапки, 16 у чипов и фильтров, 12 у баннеров), и
        ритм складывался из того, кто в этот раз отрисовался. Отступ между
        соседями принадлежит их родителю, а не им.
        Горизонтальные поля даёт `<main>` в `DesktopWorkspace` (`padding: 28`) —
        здесь их нет намеренно, чтобы не сложились дважды.
        Модалки стоят СНАРУЖИ: они рисуются `position: fixed` поверх экрана, и
        ни ритм, ни ширина колонки к ним отношения не имеют. */}
    <div style={{maxWidth:1240,display:"flex",flexDirection:"column",gap:16}}>
    <DomainsHeader
      total={domains.length}
      // Весь список — включая строки, спрятанные фильтром, и это выбор.
      // Действие приводит базу в соответствие с Cloudflare, а не «делает
      // что-то с показанным»: домен, скрытый поиском, привязан не хуже
      // видимого, и оставить его непривязанным значило бы, что результат
      // синхрона зависит от набранной строки поиска. Кому нужна область
      // поуже, у того есть кнопка по выделенным. Перезаписи это не грозит:
      // домены с уже проставленным аккаунтом прогон пропускает.
      //
      // Строки из ответа API, а не `DomainUI`, — по той же причине, что у
      // тулбара ниже.
      onSyncCloudflare={() => { void cfBind.run(domainsData, "manual"); }}
      syncPending={cfBind.pending}
      onFileImport={()=>setShowFileImport(true)}
      onBulkAdd={()=>setSB(true)}
      onAddDomain={()=>setSA(true)}
    />
    {/* Счётчики — по ПОЛНОМУ списку (`domains`), а не по `filters.filtered`:
        чип и показывает число, и фильтрует по нему, и посчитанный по срезу он
        обнулял бы соседей ровно в тот момент, когда по ним и надо вернуться. */}
    <DomainStatChips
      domains={domains}
      status={filters.controls.status}
      onStatusChange={filters.controls.onStatusChange}
    />
    <DomainFilters {...filters.controls} servers={servers} registrars={registrars} cfAccounts={cfAccounts} />
    {bulkProvision.error ? <BulkProvisionErrorBanner message={bulkProvision.error} /> : null}
    {cfBind.notice ? (
      <RunNoticeBanner
        notice={cfBind.notice}
        dismissLabel="Dismiss Cloudflare match result"
        onDismiss={cfBind.dismiss}
      />
    ) : null}
    {/* Баннеров может стоять два сразу, и это не дубль: привязка отвечает на
        «чьи это зоны», полная настройка — на «что мы с доменами сделали».
        Гасятся они порознь, поэтому и крестики названы по-разному. */}
    {fullSetup.notice ? (
      <RunNoticeBanner
        notice={fullSetup.notice}
        dismissLabel="Dismiss full setup result"
        onDismiss={fullSetup.dismiss}
      />
    ) : null}
    {zoneMatches.unreadAccounts.length > 0 ? (
      <CloudflareUnreadBanner accounts={zoneMatches.unreadAccounts} />
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
      onSyncCloudflare={() => {
        void cfBind.run(domainsData.filter((d) => sel.has(d.id)), "manual");
      }}
      syncPending={cfBind.pending}
      onFullSetup={() => setShowFullSetup(true)}
      fullSetupPending={fullSetup.pending}
      onProvision={() => { void bulkProvision.run(); }}
      onDelete={handleBulkDelete}
      provisionPending={bulkProvisionRunning}
    />
    {/* Контейнер таблицы — местный, а не общий `Card`.
        `Card` держит старую палитру приложения (`#e5e7eb`) и остаётся на ней
        намеренно: его рисуют Servers, Cloudflare, Settings и полдесятка
        карточек, и перекрасить его значило бы протащить редизайн одной вкладки
        на всё приложение. `overflow: hidden` тут несущий, а не косметический:
        шапка таблицы и полоса подвала залиты фоном до самого края, и без
        обрезки они легли бы поверх скруглений углов. */}
    <div style={{background:tokens.surface.base,border:`1px solid ${tokens.border.card}`,borderRadius:tokens.radius.lg,overflow:"hidden"}}>
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
          /* Всё, что есть в базе, — а не длина отфильтрованного среза: подвал
             говорит «показано X из Y», и Y обязан быть тем числом, к которому
             человек вернётся, сбросив фильтр. */
          total={domains.length}
          servers={servers}
          registrars={registrars}
          cfAccounts={cfAccounts}
          zoneHints={zoneMatches.hints}
          now={now}
          sort={order.sort}
          onSort={order.onSort}
          selectedIds={sel}
          onToggleRow={toggle}
          onToggleAll={()=>setSel(sel.size===filters.filtered.length?new Set():new Set(filters.filtered.map((d: DomainUI)=>d.id)))}
          focusDomainId={focusDomainId}
          onOpenDetail={openDetail}
          onDelete={handleDeleteDomain}
        />
        )}
      </div>
    </div>
    </div>

    {/* Зону просили — идёт полная настройка; не просили — прежняя автопривязка
        по имени. Одно вместо другого, а не одно за другим: домен с уже
        выбранным аккаунтом привязка всё равно пропускает, а зону в этом случае
        заводит full setup. */}
    {showAdd && <AddDomainModal onClose={()=>setSA(false)} servers={servers} registrars={registrars} cfAccounts={cfAccounts} domains={domainsData} onCreated={(d: Domain, plan)=>{
      if (plan?.createZone) void fullSetup.runForNewDomain({ id: d.id, domain_name: d.domain_name }, plan);
      else void cfBind.run([d], "auto");
    }} />}
    {/* `detailDomain` — снимок строки на момент клика, и он НЕ обновляется от
        инвалидации: модалка показывала бы «NS status: pending» ещё долго после
        удачной смены NS, то есть ровно ту ложь, ради устранения которой заведён
        write-back. Берём живую строку из свежего списка, а снимок оставляем
        резервом на случай, если домен из списка исчез (удалён, ушёл под фильтр).

        `key` — чтобы при переходе с домена на домен модалка пересоздавалась:
        иначе её собственный стейт (набранные NS) пережил бы смену props. */}
    {detailRow && (
      <DomainDetailModal
        /* Ключ с префиксом, и префикс тут несущий. Карточка и диалог provision —
           СОСЕДИ в этом фрагменте, а с фазы 4 они ещё и открыты одновременно:
           диалог зовут с карточки. Голые `detailRow.id` и `provisionTarget.id`
           — это один и тот же номер домена, то есть два ребёнка с одинаковым
           ключом на одном уровне; React на такое ругается в консоль и
           дублирует либо теряет узлы (в тестах карточка рисовалась дважды).
           Пока вход в provision жил в строке списка, столкнуться они не могли
           — карточка была закрыта. */
        key={`card-${detailRow.id}`}
        domain={detailRow}
        servers={servers}
        /* Кнопка provision живёт на вкладке Server карточки, а запуск — здесь:
           карточка только ЗОВЁТ колбэк, диалог рисует страница, результат
           уезжает ещё выше в `onProvisionResult`. Почему именно так — у
           `onProvision` в `DomainServerTab`, там канон.

           `toDomainUI` здесь, хотя рядом уже лежит мемоизированный `domains`,
           собранный им же: `domains.find(...)` не покрывает резервную ветку
           `detailRow` — строку, которой в списке БОЛЬШЕ НЕТ (домен удалён,
           список пуст после сброса кэша). Для неё поиск вернул бы `undefined`,
           то есть `null`-цель диалога вместо домена, ради которого резерв и
           заведён. Само преобразование — единственное на продукт
           (`domains/types`), второе разъехалось бы с ним к ближайшей правке. */
        onProvision={() => setProvisionTarget(toDomainUI(detailRow))}
        isProvisioning={isProvisioning(detailRow.id)}
        onClose={() => setDetailDomain(null)}
      />
    )}
    <BulkAddDialog
      open={showBulk}
      onClose={()=>setSB(false)}
      registrars={registrars}
      servers={servers}
      /* Строки API, а не `domains`: нагрузку серверов считает `optionsByLoad`, и
         тот же список тем же счётом уходит в мастер полной настройки ниже. */
      domains={domainsData}
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
    {showFullSetup && (
      <FullSetupDialog
        selectedCount={sel.size}
        servers={servers}
        registrars={registrars}
        cfAccounts={cfAccounts}
        // Строки из ответа API: нагрузку считаем по всем доменам, а не по
        // видимым — фильтр показа к тому, сколько доменов сидит на сервере,
        // отношения не имеет.
        domains={domainsData}
        value={fullSetupForm}
        onChange={setFullSetupForm}
        pending={fullSetup.pending}
        onRun={handleFullSetup}
        onClose={() => setShowFullSetup(false)}
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
    {/* Диалог provision стоит ПОСЛЕДНИМ в разметке, и это не случайность, а
        условие работоспособности. Открывают его теперь с карточки домена
        (вкладка Server), то есть на экране он оказывается поверх ещё одной
        модалки; подложка у обеих одна и та же — `Modal` с `zIndex:100`, — и
        при равном z-index перекрытие решает ПОРЯДОК В DOM. Подними этот блок
        выше `DomainDetailModal`, и диалог уедет под карточку: видно его не
        будет, а клики соберёт подложка карточки. Есть тест. */}
    {provisionTarget && (
      <ProvisionDialog
        // `key` — чтобы выбор «создавать ли БД» не залипал между доменами:
        // диалог принадлежит домену, а не странице. Префикс — чтобы не
        // столкнуться с ключом карточки: см. её `key` выше.
        key={`provision-${provisionTarget.id}`}
        domain={provisionTarget}
        isProvisioning={isProvisioning(provisionTarget.id)}
        onProvision={(withDb: boolean) => handleProvision(provisionTarget, withDb)}
        onClose={() => setProvisionTarget(null)}
      />
    )}
  </>;
}
