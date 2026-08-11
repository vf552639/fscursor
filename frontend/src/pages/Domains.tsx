import React, { useState, useMemo, useRef, ChangeEvent, useEffect } from "react";
import { useMutationState } from "@tanstack/react-query";
import { Card, Btn, Sel, Modal, EmptyState, ErrorState } from "../components/ui/Primitives";
import { useDomains, useBulkCreateDomains, useBulkCreateStructuredDomains, useBulkAssignServer, useBulkAssignCloudflare, useDeleteDomain, useProvisionDomain, runBulkProvisionDomains, isBulkGateClaim, PROVISION_DOMAIN_KEY, Domain, ProvisionDomainVars, ProvisionOutcome, BulkProvisionOutcome } from "../api/domains";
import { useServers, Server } from "../api/servers";
import { useRegistrarAccounts, RegistrarAccount } from "../api/registrars";
import { useCloudflareAccounts, CloudflareAccount } from "../api/cloudflare";
import { autoBindDomainsToCloudflare, summarizeCfBind, summarizeCfBindFailure, CfBindNotice } from "../api/cfAutoBind";
import { AddDomainModal } from "../components/domains/AddDomainModal";
import DomainFilters from "../components/domains/DomainFilters";
import DomainStats from "../components/domains/DomainStats";
import DomainTable from "../components/domains/DomainTable";
import { DEFAULT_SORT, Sort, SortKey, sortDomains } from "../components/domains/sortDomains";
import { DomainUI, toDomainUI } from "../components/domains/types";
import { describeQueryError } from "../lib/queryError";
import BulkActionToolbar from "../components/BulkActionToolbar";
import DomainBulkImportDialog from "../components/DomainBulkImportDialog";
import DomainDetailModal from "../components/DomainDetailModal";
import { confirmAction } from "../lib/confirmDialog";
import { useAuthStore } from "../store/auth";

/** Сколько имён влезает в диалог подтверждения, не превращая его в стену текста. */
const CONFIRM_NAMES_SHOWN = 20;

/**
 * Текст подтверждения массового provision.
 *
 * Отдельная чистая функция, а не шаблон внутри обработчика: её проверяет тест, а
 * этот текст — единственное, что стоит между промахом мимо соседней кнопки и
 * часами необратимой работы на чужих машинах.
 *
 * Устроен как `describeDeepLinkAction` для той же операции (`lib/deepLink.ts`):
 * называет и действие, и цели. Цели названы ИМЕНАМИ, а не id: у ссылки имён нет,
 * а у страницы есть, и выбирал пользователь именно имена. Строки «Continue only
 * if you started this yourself» здесь нет намеренно — она про ссылку, пришедшую
 * с чужой страницы, а не про кнопку, которую только что нажали.
 */
export function describeBulkProvision(domains: DomainUI[], ids: number[]): string {
  const names = ids.map((id) => domains.find((d) => d.id === id)?.domain ?? `#${id}`);
  const rest = names.length - CONFIRM_NAMES_SHOWN;
  const list = names.slice(0, CONFIRM_NAMES_SHOWN).join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
  return (
    `Provision ${ids.length} domain(s)?\n\n` +
    `${list}\n\n` +
    "SDMP will connect over SSH to each domain's server and create the site, " +
    "its FTP account and its SSL certificate. Once started, the run cannot be stopped."
  );
}

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

  const initialStatusFilter = useMemo(() => {
    return new URLSearchParams(window.location.search).get("status") ?? "";
  }, []);
  const [search,setSearch]=useState(""); const [fSrv,setFS]=useState(""); const [fReg,setFR]=useState(""); const [fCF,setFCF]=useState(""); const [fStatus, setFStatus] = useState(initialStatusFilter);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [sel,setSel]=useState<Set<number>>(new Set()); 
  const [showBulk,setSB]=useState(false);
  const [showAdd,setSA]=useState(false);
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null);

  const [showAssignServer, setShowAssignServer] = useState(false);
  const [showAssignCF, setShowAssignCF] = useState(false);
  const [assignServerId, setAssignServerId] = useState("");
  const [assignCFId, setAssignCFId] = useState("");
  const [focusDomainId, setFocusDomainId] = useState<number | null>(null);

  const bulkAssignServer = useBulkAssignServer();
  const bulkAssignCF = useBulkAssignCloudflare();
  const singleProvision = useProvisionDomain(onProvisionResult);
  // Отказ запуска обязан быть виден: «уже провижинится», «только десктоп» и
  // отказ самой команды — это ответ на вопрос «почему ничего не произошло».
  const [bulkProvisionError, setBulkProvisionError] = useState<string | null>(null);
  // Жива ли ещё страница к моменту, когда вернулся отказ. Отказ приходит через
  // секунды после клика, а страница размонтируется на любой навигации — без
  // этого признака текст уходил бы в стейт мёртвого компонента, то есть в
  // никуда (см. проп `onBulkProvisionError`).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Открыт ли диалог подтверждения массового прогона. Первое, что делает клик, —
  // это `await` (загрузка чанка плагина плюс сам диалог), поэтому до ответа
  // пользователя кнопка ничем не занята и выглядит незалипшей: второй клик по
  // «неотзывчивой» кнопке открывал второй диалог. Подтвердив оба, пользователь
  // получал запущенный прогон И красный баннер «уже провижинится» над ним —
  // выполнялся набор при этом ровно один раз (подоменный гейт), врал только UI.
  const confirmingBulkRef = useRef(false);
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
  // Диалог перед запуском: домен, для которого он открыт, и выбор «создавать ли
  // базу». Выбор живёт здесь, а не в аргументах строки, чтобы не залипать между
  // доменами — БД это отдельный артефакт на сервере, и умолчание у него «нет».
  const [provisionTarget, setProvisionTarget] = useState<DomainUI | null>(null);
  const [provisionWithDb, setProvisionWithDb] = useState(false);
  const openProvisionDialog = (d: DomainUI) => {
    setProvisionWithDb(false);
    setProvisionTarget(d);
  };
  const [showFileImport, setShowFileImport] = useState(false);
  /**
   * Итог привязки доменов к зонам Cloudflare — и почему его основное место
   * ЗДЕСЬ, а не наверху, как у результатов provision.
   *
   * Provision показывается воркспейсом всегда, потому что несёт пароли, которых
   * нет больше нигде: потерянный пароль невосстановим. У привязки секретов в
   * отчёте нет вовсе, а повторить прогон можно тем же кликом — правило
   * идемпотентно, уже привязанные домены оно пропускает. Поэтому основная
   * поверхность у неё здесь: итог называет домены ЭТОГО списка, и показывать его
   * поверх страницы серверов не о чем. Тост вдобавок живёт 2200 мс, а в итоге до
   * пяти чисел плюс оговорка про непрочитанные аккаунты — та часть, которую
   * пропустить нельзя. Место у баннера то же, где страница уже показывает исход
   * массового действия (`bulkProvisionError` ниже).
   *
   * «Основная», а не единственная: если страницы к возврату отчёта уже нет,
   * итог уезжает наверх тостом — см. `deliverBindNotice`.
   */
  const [bindNotice, setBindNotice] = useState<CfBindNotice | null>(null);
  /**
   * Чей отчёт сейчас в баннере. Нужен ровно для одного правила: фоновая
   * автопривязка не затирает отчёт, которого пользователь дождался, нажав
   * кнопку (см. `deliverBindNotice`). Реф, а не стейт: значение читается в
   * колбэке завершившегося прогона и само по себе ничего не рисует.
   */
  const bannerOwnerRef = useRef<"auto" | "manual" | null>(null);
  /** Идёт ли прогон ПО КНОПКЕ — то есть надо ли её гасить (см. `runCloudflareBind`). */
  const [bindPending, setBindPending] = useState(false);
  // Тот же признак рефом: `setBindPending` доезжает до следующего рендера, а два
  // клика по кнопке успевают случиться в одном — и тогда зоны читались бы
  // дважды, а `PUT`'ы уходили бы парами.
  const bindRunningRef = useRef(false);

  useEffect(() => {
    if (ctx?.serverId) {
      setFS(String(ctx.serverId));
    }
    if (ctx?.domainId) {
      setFocusDomainId(Number(ctx.domainId));
      setSearch("");
    }
  }, [ctx]);

  // Причина отказа привязана к набору, на котором он случился: «Provisioning of
  // #1, #2 is already running» после снятия галочек с #1 и #2 говорит уже не про
  // то, что пользователь видит перед собой.
  useEffect(() => {
    setBulkProvisionError(null);
  }, [sel]);

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
  /**
   * Порядок применяется ПОСЛЕ фильтрации и живёт в `useMemo`: список бывает на
   * сотни строк, а сортировка внутри рендера строки означала бы полную
   * пересортировку на каждую из них.
   *
   * Фокус-режим (`ctx.domainId`) сюда не вмешивается — он всего лишь ещё одно
   * условие фильтра выше, поэтому сортировку не ломает: единственная оставшаяся
   * строка отсортирована сама с собой.
   */
  const sorted = useMemo(() => sortDomains(filtered, sort), [filtered, sort]);

  const toggle=(id: number)=>{setSel((p: Set<number>)=>{const s=new Set<number>(p);s.has(id)?s.delete(id):s.add(id);return s;});};
  /** Повторный клик по той же колонке переворачивает; новая колонка начинает с возрастания. */
  const toggleSort = (k: SortKey) => setSort((p) => ({ key: k, dir: p.key === k && p.dir === "asc" ? "desc" : "asc" }));

  const bulkCreate = useBulkCreateDomains();
  const bulkStructured = useBulkCreateStructuredDomains();
  const [bulkTab, setBulkTab] = useState("text");
  const [bulkText, setBulkText] = useState("");
  const [bulkRegId, setBulkRegId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [bulkError, setBulkError] = useState("");

  const handleBulkAdd = async () => {
    setBulkError("");
    try {
      if (bulkTab === "text") {
        const lines: string[] = bulkText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          setBulkError("Please enter at least one domain");
          return;
        }
        const result = await bulkCreate.mutateAsync({
          domains_text: lines.join("\n"),
          registrar_id: bulkRegId ? Number(bulkRegId) : null
        });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        setSB(false);
        setBulkText("");
        setBulkRegId("");
        // Привязка — ПОСЛЕ закрытия модалки и вне её try/catch по смыслу: домены
        // созданы, и это главный результат. `void` — потому что обработчик
        // привязки свои ошибки показывает сам, а превратить их в `bulkError`
        // значило бы объявить провалом успешный импорт.
        void runCloudflareBind(result.created, "auto");
      } else {
        const lines: string[] = csvText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          setBulkError("Please enter at least one CSV line");
          return;
        }

        if (lines.some((l: string) => l.includes(',') && !l.includes(';'))) {
          setBulkError("Похоже, вы используете запятые вместо точек с запятой. Пожалуйста, исправьте разделитель.");
          return;
        }

        const items = lines.map((line: string) => {
          const parts = line.split(';');
          return {
            domain_name: parts[0]?.trim(),
            registrar_name: parts[1]?.trim() || null
          };
        }).filter((item: { domain_name: string }) => item.domain_name);

        if (items.length === 0) {
          setBulkError("No valid domains found in CSV");
          return;
        }

        const result = await bulkStructured.mutateAsync({ items });

        if (result.created.length === 0 && result.skipped.length > 0) {
          setBulkError(`❌ Все указанные домены были пропущены (неверный формат или уже существуют):\n ${result.skipped.join(", ")}`);
          return;
        }

        setSB(false);
        setCsvText("");
        // Та же привязка, что и у текстовой ветки: путь создания другой
        // (`/domains/bulk-structured`), а домены — те же.
        void runCloudflareBind(result.created, "auto");
      }
    } catch (err: any) {
      setBulkError(err.response?.data?.message || err.message || "Failed to import domains");
    }
  }

  const handleAssignServer = () => {
    if (!assignServerId) return;
    bulkAssignServer.mutate(
      { domain_ids: Array.from(sel), server_id: Number(assignServerId) },
      { onSuccess: () => { setShowAssignServer(false); setSel(new Set()); setAssignServerId(""); } }
    );
  };

  const handleAssignCF = () => {
    if (!assignCFId) return;
    bulkAssignCF.mutate(
      { domain_ids: Array.from(sel), cloudflare_account_id: Number(assignCFId) },
      { onSuccess: () => { setShowAssignCF(false); setSel(new Set()); setAssignCFId(""); } }
    );
  };

  /**
   * Куда положить итог привязки: в баннер страницы, а если он недоступен —
   * наверх, тостом воркспейса.
   *
   * Недоступен он в двух случаях, и оба реальны.
   *
   * 1. Страницы больше нет. «Прогон секундный» — это про один домен, а не про
   *    пачку: на двухстах доменах это последовательная вычитка зон каждого
   *    аккаунта (с пагинацией и ретраем) плюс двести `PUT` по четыре за раз, то
   *    есть десятки секунд. Уйти за это время со страницы — обычное дело, а
   *    размонтированный компонент съел бы отчёт молча. Молчание здесь хуже
   *    всего: привязка меняет данные НЕ спросив, и след о ней — единственное,
   *    чем это отличается от правки за спиной у пользователя.
   * 2. Место занято отчётом, который пользователь заказывал САМ. Прогонов бывает
   *    два сразу: автопривязка после bulk-add идёт десятки секунд, и клик по
   *    «Match Cloudflare zones» посреди неё финиширует раньше. Затерев отчёт
   *    кнопки отчётом фоновой привязки, страница ответила бы не на тот вопрос,
   *    который ей задали, — и человек, дождавшийся своего отчёта, увидел бы
   *    вместо него чужие числа.
   *
   * Развилка та же, что у `onBulkProvisionError`. Тост беднее баннера (2200 мс
   * на пять чисел), но несравнимо лучше тишины.
   */
  const deliverBindNotice = (notice: CfBindNotice, mode: "auto" | "manual") => {
    const bannerTaken = mode === "auto" && bannerOwnerRef.current === "manual";
    if (mountedRef.current && !bannerTaken) {
      bannerOwnerRef.current = mode;
      setBindNotice(notice);
    } else {
      onCloudflareBindNotice(notice);
    }
  };

  /** Забыть, кому принадлежит баннер, вместе с самим баннером. */
  const clearBindNotice = () => {
    bannerOwnerRef.current = null;
    setBindNotice(null);
  };

  /**
   * Прогон привязки к зонам Cloudflare: и автоматический (после создания
   * домена), и по кнопке тулбара.
   *
   * Один обработчик на оба входа намеренно — правило привязки одно, и разница
   * между входами ровно в `mode`: после создания домена молчим, когда прогона
   * не было (аккаунтов нет — это не новость тому, кто Cloudflare не
   * пользуется), а по кнопке отвечаем всегда. Всё остальное решает
   * `summarizeCfBind`.
   *
   * Ничего не бросает наружу: провал привязки — это отдельная строка сообщения,
   * а не провал создания домена. Домен к этому моменту уже создан.
   *
   * Гейт «один прогон за раз» стоит ТОЛЬКО у кнопки, и это не асимметрия ради
   * асимметрии. Он существует, чтобы второй клик по кнопке не запускал второй
   * проход; распространив его на автопривязку, мы получили бы худшее из
   * возможного — домен, заведённый во время прогона по кнопке, молча остался бы
   * непривязанным, то есть ровно тем «доменом, которому нечем прописать NS»,
   * ради которого функция и сделана. Параллельные прогоны безопасны: зоны они
   * делят одной записью кэша (`fetchQuery` схлопывает одинаковые запросы), а
   * `PUT` привязки идемпотентен.
   */
  const runCloudflareBind = async (rows: Domain[], mode: "auto" | "manual") => {
    if (mode === "manual") {
      if (bindRunningRef.current) return;
      bindRunningRef.current = true;
      setBindPending(true);
    }
    // Гасим ПРЕЖНИЙ итог сразу, а не по приходу нового: у нового его может не
    // быть вовсе. `auto` молчит, когда менять оказалось нечего, — то есть после
    // «Cloudflare: 2 of 3 linked» пользователь заводит домен с уже выбранным
    // аккаунтом, привязывать нечего, а старая строка остаётся стоять и читается
    // как отчёт об этом, последнем действии.
    //
    // Но отчёт, которого дождались по кнопке, фоновая привязка не гасит — по
    // той же причине, по которой не затирает его на финише
    // (`deliverBindNotice`): иначе «12 of 50 linked» исчезало бы от заведения
    // одного домена, и на этом пути даже без тоста — промолчавший прогон
    // наверх ничего не отдаёт. Своё же гасит любой прогон: заказал новое —
    // читаешь новое.
    if (mode === "manual" || bannerOwnerRef.current !== "manual") clearBindNotice();
    try {
      const notice = summarizeCfBind(await autoBindDomainsToCloudflare(rows), mode);
      if (notice) deliverBindNotice(notice, mode);
    } catch (e) {
      // Сюда доходит только провал чтения СПИСКА аккаунтов: непрочитанный
      // аккаунт и несостоявшийся `PUT` — это строки отчёта, а не исключение.
      // Текст собирает тот же модуль, что и текст удачного прогона: он у
      // привязки весь должен быть проверяем без DOM, а чужая ошибка — обрезана
      // (`e.to_string()` через прокси `api_request` в пределе тело ответа).
      deliverBindNotice(summarizeCfBindFailure(e), mode);
    } finally {
      if (mode === "manual") {
        bindRunningRef.current = false;
        if (mountedRef.current) setBindPending(false);
      }
    }
  };

  /**
   * Массовый provision — через Tauri-команду `provision_bulk`, тем же путём,
   * что и ссылка `sdmp://bulk-provision` (см. `lib/deepLink.ts`). Прежний
   * `POST /domains/bulk-provision` на бэкенде не существует: кнопка всегда
   * давала 404, то есть обещала функцию, которой нет.
   *
   * Не прямой `invokeSynced`, а `runBulkProvisionDomains` — по тем же двум
   * причинам, что и у ссылки: только он отдаёт наружу результат КАЖДОГО домена
   * (пароль FTP существует только там) и только он занимает подоменный гейт в
   * `MutationCache`, из-за чего ⚙ строки и ссылка не откроют вторую SSH-сессию
   * по домену из набора.
   *
   * Результат не через `mutate`: возврат `mutationFn` react-query кладёт в
   * `data` `MutationCache`, откуда его не убирает даже `reset()`. Паролям там
   * не место, поэтому отчёт уезжает прямым вызовом пропа.
   */
  const handleBulkProvision = async () => {
    // Тот же источник, что у `useSetNameservers`: id пользователя нужен команде,
    // чтобы расшифровать креды сервера.
    const userId = useAuthStore.getState().userId;
    setBulkProvisionError(null);
    if (!userId) {
      setBulkProvisionError("Not signed in — sign in again to run provisioning.");
      return;
    }
    const targets = Array.from(sel);
    // Спрашиваем, как спрашивают массовое удаление и как спрашивает
    // `sdmp://bulk-provision`: один клик запускает часы необратимой работы на
    // чужих машинах (site + FTP-аккаунт + certbot на каждом домене), остановить
    // прогон нечем, а идемпотентность после него пометит набор отработавшим —
    // то есть промах по «Assign Server» стоил бы и лишнего прогона, и
    // возможности повторить правильный.
    //
    // Домены названы ИМЕНАМИ, а не id, как в тексте ссылки: имя — это то, чем
    // пользователь их выбирал. Длинный список урезаем: диалог, который нельзя
    // прочитать, закрывают не читая.
    //
    // Второй клик, пока висит диалог, — это тот же клик, а не второй запуск:
    // спрашивать одно и то же дважды не о чем.
    if (confirmingBulkRef.current) return;
    confirmingBulkRef.current = true;
    let confirmed: boolean;
    try {
      confirmed = await confirmAction(describeBulkProvision(domains, targets));
    } finally {
      confirmingBulkRef.current = false;
    }
    if (!confirmed) return;
    // Команда адресует домены строками.
    const ids = targets.map(String);
    try {
      const outcome = await runBulkProvisionDomains(userId, ids);
      // Отчёт отдаём ПЕРВЫМ действием после ответа: всё остальное здесь —
      // косметика стейта, а он существует в единственном экземпляре.
      onBulkProvisionResult(outcome);
      // Снимаем выделение только с полностью удавшегося прогона. У оборвавшегося
      // хвост (`skipped`) назван поимённо ровно затем, чтобы повторить прогон по
      // нему, — а повторять его пользователю пришлось бы, заново разыскивая
      // домены в списке на двести строк.
      if (outcome.status === "ok") setSel(new Set());
    } catch (e) {
      // «Provisioning of #N is already running.», «только десктоп» и отказ самой
      // команды — всё это обязано доехать до пользователя: молчащая кнопка
      // неотличима от сломанной. Куда именно — зависит от того, жива ли ещё
      // страница: в стейте размонтированной текст умирает так же молча.
      const message = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) setBulkProvisionError(message);
      else onBulkProvisionError(message);
    }
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
    return (
      <div style={{ padding: "8px 0" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111", marginBottom: 2 }}>Domains</h1>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Domain inventory</div>
        </div>
        <ErrorState
          title={describeQueryError(domainsQ.error).title}
          message={`The domains list could not be loaded. ${describeQueryError(domainsQ.error).message}`}
          hint={describeQueryError(domainsQ.error).hint}
        />
      </div>
    );
  }

  if (domainsQ.isPending || serversQ.isPending || registrarsQ.isPending || cfAccountsQ.isPending) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading domains data...</div>;
  }

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
      <div>
        <h1 style={{fontSize:22,fontWeight:700,color:"#111",marginBottom:2}}>Domains</h1>
        <div style={{fontSize:13,color:"#6b7280"}}>{domains.length} domains total</div>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn variant="secondary" onClick={()=>setShowFileImport(true)}>⇪ File Import</Btn>
        <Btn variant="secondary" onClick={()=>setSB(true)}>⊕ Bulk Add</Btn>
        <Btn variant="primary" onClick={()=>setSA(true)}>+ Add Domain</Btn>
      </div>
    </div>
    <DomainStats domains={domains} />
    <DomainFilters
      search={search} onSearchChange={setSearch}
      serverId={fSrv} onServerChange={setFS} servers={servers}
      registrarId={fReg} onRegistrarChange={setFR} registrars={registrars}
      cfId={fCF} onCfChange={setFCF} cfAccounts={cfAccounts}
      status={fStatus} onStatusChange={setFStatus}
    />
    {/* Живёт ровно столько, сколько живёт набор, на котором случился отказ:
        гасит его эффект по `sel` выше, а не время и не следующий рендер. */}
    {bulkProvisionError ? (
      <div role="alert" style={{marginBottom:12,padding:"10px 12px",background:"#fee2e2",borderRadius:8,color:"#991b1b",fontSize:13}}>
        {bulkProvisionError}
      </div>
    ) : null}
    {/* Итог привязки к Cloudflare. `alert` только у полууспеха (тот же порог,
        что у тостов воркспейса): «привязано 3 из 3» перебивать чтение экрана
        незачем, а «одно совпало в двух аккаунтах» — это то, ради чего человек и
        читает эту строку.

        Гасится кнопкой, а не таймером и не сменой выделения: при создании
        домена выделение вообще ни при чём, а исчезнувшая через две секунды
        строка с пятью числами — это строка, которую не успели прочитать. */}
    {bindNotice ? (
      <div
        role={bindNotice.kind === "warn" ? "alert" : "status"}
        style={{marginBottom:12,padding:"10px 12px",borderRadius:8,fontSize:13,display:"flex",alignItems:"flex-start",gap:10,background:bindNotice.kind === "warn" ? "#fffbeb" : "#eff4ff",color:bindNotice.kind === "warn" ? "#92400e" : "#1e40af"}}
      >
        <span style={{flex:1}}>{bindNotice.kind === "warn" ? "⚠" : "✓"} {bindNotice.text}</span>
        <button
          type="button"
          onClick={clearBindNotice}
          aria-label="Dismiss Cloudflare match result"
          style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"inherit",font:"inherit",lineHeight:1}}
        >
          ✕
        </button>
      </div>
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
        void runCloudflareBind(domainsData.filter((d) => sel.has(d.id)), "manual");
      }}
      matchCFZonesPending={bindPending}
      onProvision={() => { void handleBulkProvision(); }}
      onDelete={handleBulkDelete}
      provisionPending={bulkProvisionRunning}
    />
    <Card>
      <div style={{overflowX:"auto"}}>
        {domainsData.length === 0 ? (
          <EmptyState
            title="No domains yet"
            description="Add a domain or import many at once. An empty list means there are no rows in the database — not a failed request."
          >
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <Btn variant="secondary" onClick={() => setShowFileImport(true)}>
                ⇪ File import
              </Btn>
              <Btn variant="secondary" onClick={() => setSB(true)}>
                ⊕ Bulk import
              </Btn>
              <Btn variant="primary" onClick={() => setSA(true)}>
                + Add Domain
              </Btn>
            </div>
          </EmptyState>
        ) : (
        <DomainTable
          rows={sorted}
          servers={servers}
          registrars={registrars}
          cfAccounts={cfAccounts}
          now={now}
          sort={sort}
          onSort={toggleSort}
          selectedIds={sel}
          onToggleRow={toggle}
          onToggleAll={()=>setSel(sel.size===sorted.length?new Set():new Set(sorted.map((d: DomainUI)=>d.id)))}
          focusDomainId={focusDomainId}
          isProvisioning={isProvisioning}
          onOpenDetail={(id)=>setDetailDomain(domainsData.find((x) => x.id === id) || null)}
          onProvision={openProvisionDialog}
          onDelete={(d)=>{ void handleDeleteDomain(d); }}
        />
        )}
      </div>
    </Card>

    {showAdd && <AddDomainModal onClose={()=>setSA(false)} servers={servers} registrars={registrars} cfAccounts={cfAccounts} onCreated={(d: Domain)=>{ void runCloudflareBind([d], "auto"); }} />}
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
    {showBulk&&<Modal title="Bulk Add Domains" onClose={()=>setSB(false)} width={520}>
      <div style={{display:"flex",background:"#f3f4f6",borderRadius:8,padding:3,marginBottom:20}}>
        {[["text","Plain Text"],["csv","CSV / Semicolon"]].map(([k,l])=>(
          <button key={k} onClick={()=>setBulkTab(k as string)} style={{flex:1,padding:"8px 12px",borderRadius:6,border:"none",cursor:"pointer",fontSize:13,fontWeight:500,fontFamily:"inherit",transition:"all 0.15s",background:bulkTab===k?"#2563eb":"transparent",color:bulkTab===k?"#fff":"#6b7280"}}>{bulkTab===k&&"✓ "}{l}</button>
        ))}
      </div>
      
      {bulkTab === "text" ? <>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Enter one domain per line. Duplicates will be skipped.</p>
        <textarea value={bulkText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>setBulkText(e.target.value)} placeholder={"example.com\nshop.example.com\nblog.example.com"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr",gap:12,margin:"14px 0"}}>
          <div><label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Assign to Registrar</label><Sel value={bulkRegId} onChange={(e: React.ChangeEvent<HTMLSelectElement>)=>setBulkRegId(e.target.value)} style={{width:"100%"}}><option value="">— None —</option>{registrars.map((r: RegistrarAccount)=><option key={r.id} value={r.id}>{r.provider} - {r.name}</option>)}</Sel></div>
        </div>
      </> : <>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Paste values in format: <code style={{background:"#eee",padding:2}}>domain.com;provider_name</code></p>
        <textarea value={csvText} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>)=>setCsvText(e.target.value)} placeholder={"example.com;Namecheap\nshop.com;Hostiq"} style={{width:"100%",height:160,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:8,fontSize:13,fontFamily:"monospace",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
      </>}
      
      {bulkError && <div style={{background:"#fef2f2",border:"1px solid #fee2e2",color:"#dc2626",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>❌ {bulkError}</div>}
      
      <Btn variant="primary" onClick={handleBulkAdd} disabled={bulkCreate.isPending || bulkStructured.isPending} style={{width:"100%",justifyContent:"center",padding:"10px 0", marginTop: 14}}>{(bulkCreate.isPending || bulkStructured.isPending) ? "Importing..." : "Import Domains"}</Btn>
      <div style={{marginTop:8}}><Btn variant="secondary" onClick={()=>setSB(false)} style={{width:"100%",justifyContent:"center"}}>Cancel</Btn></div>
    </Modal>}

    {showAssignServer && (
      <Modal title="Assign Server" onClose={() => setShowAssignServer(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить сервер для {sel.size} доменов:</p>
        <Sel value={assignServerId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignServerId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select Server —</option>
          {servers.map((s: Server) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignServer} disabled={!assignServerId || bulkAssignServer.isPending}>
            {bulkAssignServer.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignServer(false)}>Cancel</Btn>
        </div>
      </Modal>
    )}

    {showAssignCF && (
      <Modal title="Assign Cloudflare" onClose={() => setShowAssignCF(false)} width={400}>
        <p style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Назначить Cloudflare аккаунт для {sel.size} доменов:</p>
        <Sel value={assignCFId} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAssignCFId(e.target.value)} style={{width:"100%"}}>
          <option value="">— Select CF Account —</option>
          {cfAccounts.map((c: CloudflareAccount) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Sel>
        <div style={{marginTop:18, display:"flex", gap:8}}>
          <Btn variant="primary" onClick={handleAssignCF} disabled={!assignCFId || bulkAssignCF.isPending}>
            {bulkAssignCF.isPending ? "Assigning..." : "Assign"}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowAssignCF(false)}>Cancel</Btn>
        </div>
      </Modal>
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
      <Modal
        title={`Provision ${provisionTarget.domain}`}
        onClose={() => setProvisionTarget(null)}
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
            checked={provisionWithDb}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setProvisionWithDb(e.target.checked)}
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
            onClick={() => {
              const target = provisionTarget;
              if (isProvisioning(target.id)) return;
              // Без per-call `onSuccess`: результат доставляет замыкание
              // `mutationFn` (см. `useProvisionDomain`), потому что per-call
              // коллбэки react-query глушит при размонтировании наблюдателя —
              // а именно после ухода со страницы пароли и терялись.
              singleProvision.mutate({
                domainId: target.id,
                domainName: target.domain,
                withDb: provisionWithDb,
              });
              setProvisionTarget(null);
            }}
            disabled={isProvisioning(provisionTarget.id)}
          >
            {isProvisioning(provisionTarget.id) ? "Provisioning…" : "Provision"}
          </Btn>
          <Btn variant="secondary" onClick={() => setProvisionTarget(null)}>
            Cancel
          </Btn>
        </div>
      </Modal>
    )}
  </>;
}
